use crate::cache::RenditionCache;
use crate::catalog::ArtifactCatalog;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

pub struct AppState {
    pub catalog: ArtifactCatalog,
    pub cache: RenditionCache,
    pub result_root: PathBuf,
    pub shutdown: AtomicBool,
}

impl AppState {
    pub fn new(result_root: PathBuf, cache_bytes: usize) -> std::io::Result<Self> {
        std::fs::create_dir_all(&result_root)?;
        let catalog = ArtifactCatalog::new(result_root.join("catalog.db"), result_root.clone());
        let cache = RenditionCache::new(
            result_root.join("renditions").join("thumbnail-v1"),
            cache_bytes,
        )?;
        Ok(Self {
            catalog,
            cache,
            result_root,
            shutdown: AtomicBool::new(false),
        })
    }
}
