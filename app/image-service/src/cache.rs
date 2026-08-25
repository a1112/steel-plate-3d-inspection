use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct RenditionCache {
    root: PathBuf,
    memory: Mutex<ByteLruCache>,
    flights: Mutex<HashMap<String, Weak<Mutex<()>>>>,
}

impl RenditionCache {
    pub fn new(root: PathBuf, max_memory_bytes: usize) -> std::io::Result<Self> {
        fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            memory: Mutex::new(ByteLruCache::new(max_memory_bytes)),
            flights: Mutex::new(HashMap::new()),
        })
    }

    pub fn get(&self, key: &str) -> Option<Arc<Vec<u8>>> {
        if let Ok(mut memory) = self.memory.lock() {
            if let Some(bytes) = memory.get(key) {
                return Some(bytes);
            }
        }
        let bytes = fs::read(self.disk_path(key))
            .ok()
            .filter(|bytes| !bytes.is_empty())?;
        let bytes = Arc::new(bytes);
        self.insert_memory(key.to_string(), Arc::clone(&bytes));
        Some(bytes)
    }

    pub fn insert_memory(&self, key: String, bytes: Arc<Vec<u8>>) {
        if let Ok(mut memory) = self.memory.lock() {
            memory.insert(key, bytes);
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

struct ByteLruCache {
    max_bytes: usize,
    current_bytes: usize,
    entries: HashMap<String, Arc<Vec<u8>>>,
    order: VecDeque<String>,
}

impl ByteLruCache {
    fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes,
            current_bytes: 0,
            entries: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn get(&mut self, key: &str) -> Option<Arc<Vec<u8>>> {
        let bytes = self.entries.get(key).cloned()?;
        self.touch(key);
        Some(bytes)
    }

    fn insert(&mut self, key: String, bytes: Arc<Vec<u8>>) {
        if bytes.len() > self.max_bytes || self.max_bytes == 0 {
            return;
        }
        if let Some(previous) = self.entries.remove(&key) {
            self.current_bytes = self.current_bytes.saturating_sub(previous.len());
            self.order.retain(|candidate| candidate != &key);
        }
        self.current_bytes = self.current_bytes.saturating_add(bytes.len());
        self.order.push_back(key.clone());
        self.entries.insert(key, bytes);
        while self.current_bytes > self.max_bytes {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(removed) = self.entries.remove(&oldest) {
                self.current_bytes = self.current_bytes.saturating_sub(removed.len());
            }
        }
    }

    fn touch(&mut self, key: &str) {
        self.order.retain(|candidate| candidate != key);
        self.order.push_back(key.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::ByteLruCache;
    use std::sync::Arc;

    #[test]
    fn evicts_by_bytes_and_refreshes_recent_entries() {
        let mut cache = ByteLruCache::new(6);
        cache.insert("a".into(), Arc::new(vec![1; 3]));
        cache.insert("b".into(), Arc::new(vec![2; 3]));
        assert!(cache.get("a").is_some());
        cache.insert("c".into(), Arc::new(vec![3; 3]));
        assert!(cache.get("a").is_some());
        assert!(cache.get("b").is_none());
        assert!(cache.get("c").is_some());
    }
}
