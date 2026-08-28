use hashlink::LinkedHashMap;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

pub struct ArtifactCatalog {
    catalog_path: PathBuf,
    result_root: PathBuf,
    cache: Mutex<SourceCache>,
    cache_hits: AtomicU64,
    database_queries: AtomicU64,
}

pub struct ArtifactQuery<'a> {
    pub record_id: &'a str,
    pub camera_id: &'a str,
    pub sequence: i64,
    pub kind: &'a str,
}

#[derive(Clone, Debug)]
pub struct ArtifactSource {
    pub blob_path: PathBuf,
    pub identity: String,
}

#[derive(Clone, Copy)]
pub struct CatalogStats {
    pub cache_hits: u64,
    pub database_queries: u64,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct ArtifactKey {
    record_id: String,
    camera_id: String,
    sequence: i64,
    kind: String,
}

struct SourceCache {
    max_entries: usize,
    entries: LinkedHashMap<ArtifactKey, ArtifactSource>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ResolveError {
    CatalogUnavailable,
    NotFound,
    InvalidReference,
}

impl ArtifactCatalog {
    pub fn new(catalog_path: PathBuf, result_root: PathBuf, max_cache_entries: usize) -> Self {
        Self {
            catalog_path,
            result_root,
            cache: Mutex::new(SourceCache {
                max_entries: max_cache_entries,
                entries: LinkedHashMap::new(),
            }),
            cache_hits: AtomicU64::new(0),
            database_queries: AtomicU64::new(0),
        }
    }

    pub fn is_ready(&self) -> bool {
        self.catalog_path.is_file()
    }

    pub fn resolve(&self, query: ArtifactQuery<'_>) -> Result<ArtifactSource, ResolveError> {
        if !self.is_ready() {
            return Err(ResolveError::CatalogUnavailable);
        }
        let key = ArtifactKey {
            record_id: query.record_id.to_string(),
            camera_id: query.camera_id.to_string(),
            sequence: query.sequence,
            kind: query.kind.to_string(),
        };
        if let Ok(mut cache) = self.cache.lock() {
            if let Some(source) = cache.entries.to_back(&key).cloned() {
                self.cache_hits.fetch_add(1, Ordering::Relaxed);
                return Ok(source);
            }
        }
        self.database_queries.fetch_add(1, Ordering::Relaxed);
        let connection = Connection::open_with_flags(
            &self.catalog_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| ResolveError::CatalogUnavailable)?;
        let path: String = connection
            .query_row(
                "SELECT path FROM capture_file WHERE inspection_id = ?1 AND camera_id = ?2 AND sequence_no = ?3 AND kind = ?4",
                rusqlite::params![
                    &key.record_id,
                    &key.camera_id,
                    key.sequence,
                    &key.kind
                ],
                |row| row.get(0),
            )
            .map_err(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => ResolveError::NotFound,
                _ => ResolveError::CatalogUnavailable,
            })?;
        let identity = validated_blob_identity(&path).ok_or(ResolveError::InvalidReference)?;
        let blob_path = self.result_root.join("blobs").join(&identity);
        if !blob_path.is_file() {
            return Err(ResolveError::NotFound);
        }
        let source = ArtifactSource {
            blob_path,
            identity,
        };
        if let Ok(mut cache) = self.cache.lock() {
            if cache.max_entries > 0 {
                while cache.entries.len() >= cache.max_entries {
                    cache.entries.pop_front();
                }
                cache.entries.insert(key, source.clone());
            }
        }
        Ok(source)
    }

    pub fn stats(&self) -> CatalogStats {
        CatalogStats {
            cache_hits: self.cache_hits.load(Ordering::Relaxed),
            database_queries: self.database_queries.load(Ordering::Relaxed),
        }
    }
}

fn validated_blob_identity(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    let identity = normalized.strip_prefix("blobs/")?;
    if identity.len() != 64
        || identity.contains('/')
        || !identity.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    Some(identity.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::validated_blob_identity;

    #[test]
    fn accepts_only_content_addressed_blob_references() {
        let hash = "a".repeat(64);
        assert_eq!(
            validated_blob_identity(&format!("blobs/{hash}")),
            Some(hash.clone())
        );
        assert_eq!(
            validated_blob_identity(&format!("blobs\\{hash}")),
            Some(hash)
        );
        assert_eq!(validated_blob_identity("../outside.jpg"), None);
        assert_eq!(validated_blob_identity("blobs/not-a-hash"), None);
    }
}
