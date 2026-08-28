use crate::cache::RenditionCache;
use crate::catalog::ArtifactCatalog;
use crate::image_codec::DecodedImageCache;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

pub struct AppState {
    pub catalog: ArtifactCatalog,
    pub cache: RenditionCache,
    pub decoded_cache: DecodedImageCache,
    pub result_root: PathBuf,
    pub encoded_cache_bytes: usize,
    pub decoded_cache_bytes: usize,
    pub catalog_cache_entries: usize,
    pub shutdown: AtomicBool,
}

impl AppState {
    #[cfg(test)]
    pub fn new(result_root: PathBuf, cache_bytes: usize) -> std::io::Result<Self> {
        Self::with_cache_limits(result_root, cache_bytes, 256 * 1024 * 1024, 65_536)
    }

    pub fn with_cache_limits(
        result_root: PathBuf,
        encoded_cache_bytes: usize,
        decoded_cache_bytes: usize,
        catalog_cache_entries: usize,
    ) -> std::io::Result<Self> {
        std::fs::create_dir_all(&result_root)?;
        let catalog = ArtifactCatalog::new(
            result_root.join("catalog.db"),
            result_root.clone(),
            catalog_cache_entries,
        );
        let cache = RenditionCache::new(
            result_root.join("renditions").join("thumbnail-v1"),
            encoded_cache_bytes,
        )?;
        Ok(Self {
            catalog,
            cache,
            decoded_cache: DecodedImageCache::new(decoded_cache_bytes),
            result_root,
            encoded_cache_bytes,
            decoded_cache_bytes,
            catalog_cache_entries,
            shutdown: AtomicBool::new(false),
        })
    }
}
