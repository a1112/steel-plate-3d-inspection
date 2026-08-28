use hashlink::LinkedHashMap;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct RenditionCache {
    root: PathBuf,
    memory: Mutex<ByteLruCache<Vec<u8>>>,
    flights: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    memory_hits: AtomicU64,
    disk_hits: AtomicU64,
    misses: AtomicU64,
}

#[derive(Clone, Copy)]
pub struct RenditionCacheStats {
    pub memory_hits: u64,
    pub disk_hits: u64,
    pub misses: u64,
}

impl RenditionCache {
    pub fn new(root: PathBuf, max_memory_bytes: usize) -> std::io::Result<Self> {
        fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            memory: Mutex::new(ByteLruCache::new(max_memory_bytes)),
            flights: Mutex::new(HashMap::new()),
            memory_hits: AtomicU64::new(0),
            disk_hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
        })
    }

    pub fn get(&self, key: &str) -> Option<Arc<Vec<u8>>> {
        if let Ok(mut memory) = self.memory.lock() {
            if let Some(bytes) = memory.get(key) {
                self.memory_hits.fetch_add(1, Ordering::Relaxed);
                return Some(bytes);
            }
        }
        let Some(bytes) = fs::read(self.disk_path(key))
            .ok()
            .filter(|bytes| !bytes.is_empty())
        else {
            self.misses.fetch_add(1, Ordering::Relaxed);
            return None;
        };
        self.disk_hits.fetch_add(1, Ordering::Relaxed);
        let bytes = Arc::new(bytes);
        self.insert_memory(key.to_string(), Arc::clone(&bytes));
        Some(bytes)
    }

    pub fn insert_memory(&self, key: String, bytes: Arc<Vec<u8>>) {
        if let Ok(mut memory) = self.memory.lock() {
            let byte_size = bytes.len();
            memory.insert(key, bytes, byte_size);
        }
    }

    pub fn stats(&self) -> RenditionCacheStats {
        RenditionCacheStats {
            memory_hits: self.memory_hits.load(Ordering::Relaxed),
            disk_hits: self.disk_hits.load(Ordering::Relaxed),
            misses: self.misses.load(Ordering::Relaxed),
        }
    }

    pub fn store(&self, key: &str, bytes: Arc<Vec<u8>>) -> std::io::Result<()> {
        let destination = self.disk_path(key);
        let parent = destination.parent().unwrap_or(&self.root);
        fs::create_dir_all(parent)?;
        if !destination.is_file() {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let temporary = parent.join(format!(".{key}.{}.{}.tmp", std::process::id(), nonce));
            fs::write(&temporary, bytes.as_slice())?;
            if let Err(error) = fs::rename(&temporary, &destination) {
                let _ = fs::remove_file(&temporary);
                if !destination.is_file() {
                    return Err(error);
                }
            }
        }
        self.insert_memory(key.to_string(), bytes);
        Ok(())
    }

    pub fn build_lock(&self, key: &str) -> Arc<Mutex<()>> {
        let mut flights = self
            .flights
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        flights.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = flights.get(key).and_then(Weak::upgrade) {
            return gate;
        }
        let gate = Arc::new(Mutex::new(()));
        flights.insert(key.to_string(), Arc::downgrade(&gate));
        gate
    }

    fn disk_path(&self, key: &str) -> PathBuf {
        let prefix = key.get(..2).unwrap_or("00");
        self.root.join(prefix).join(format!("{key}.jpg"))
    }
}

pub(crate) struct ByteLruCache<T> {
    max_bytes: usize,
    current_bytes: usize,
    entries: LinkedHashMap<String, (Arc<T>, usize)>,
}

impl<T> ByteLruCache<T> {
    pub(crate) fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes,
            current_bytes: 0,
            entries: LinkedHashMap::new(),
        }
    }

    pub(crate) fn get(&mut self, key: &str) -> Option<Arc<T>> {
        self.entries
            .to_back(key)
            .map(|(value, _)| Arc::clone(value))
    }

    pub(crate) fn insert(&mut self, key: String, value: Arc<T>, byte_size: usize) {
        if byte_size > self.max_bytes || self.max_bytes == 0 {
            return;
        }
        if let Some((_, previous_size)) = self.entries.remove(&key) {
            self.current_bytes = self.current_bytes.saturating_sub(previous_size);
        }
        self.current_bytes = self.current_bytes.saturating_add(byte_size);
        self.entries.insert(key, (value, byte_size));
        while self.current_bytes > self.max_bytes {
            let Some((_, (_, removed_size))) = self.entries.pop_front() else {
                break;
            };
            self.current_bytes = self.current_bytes.saturating_sub(removed_size);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ByteLruCache;
    use std::sync::Arc;

    #[test]
    fn evicts_by_bytes_and_refreshes_recent_entries() {
        let mut cache = ByteLruCache::new(6);
        cache.insert("a".into(), Arc::new(vec![1; 3]), 3);
        cache.insert("b".into(), Arc::new(vec![2; 3]), 3);
        assert!(cache.get("a").is_some());
        cache.insert("c".into(), Arc::new(vec![3; 3]), 3);
        assert!(cache.get("a").is_some());
        assert!(cache.get("b").is_none());
        assert!(cache.get("c").is_some());
    }
}
