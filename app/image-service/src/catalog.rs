use rusqlite::Connection;
use std::path::PathBuf;

pub struct ArtifactCatalog {
    catalog_path: PathBuf,
    result_root: PathBuf,
}

pub struct ArtifactQuery<'a> {
    pub record_id: &'a str,
    pub camera_id: &'a str,
    pub sequence: i64,
    pub kind: &'a str,
}

#[derive(Debug)]
pub struct ArtifactSource {
    pub blob_path: PathBuf,
    pub identity: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ResolveError {
    CatalogUnavailable,
    NotFound,
    InvalidReference,
}

impl ArtifactCatalog {
    pub fn new(catalog_path: PathBuf, result_root: PathBuf) -> Self {
        Self {
            catalog_path,
            result_root,
        }
    }

    pub fn is_ready(&self) -> bool {
        self.catalog_path.is_file()
    }

    pub fn resolve(&self, query: ArtifactQuery<'_>) -> Result<ArtifactSource, ResolveError> {
        if !self.is_ready() {
            return Err(ResolveError::CatalogUnavailable);
        }
        let connection = Connection::open_with_flags(
            &self.catalog_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| ResolveError::CatalogUnavailable)?;
        let path: String = connection
            .query_row(
                "SELECT path FROM capture_file WHERE inspection_id = ?1 AND camera_id = ?2 AND sequence_no = ?3 AND kind = ?4",
                rusqlite::params![
                    query.record_id,
                    query.camera_id,
                    query.sequence,
                    query.kind
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
        Ok(ArtifactSource {
            blob_path,
            identity,
        })
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
