use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::DynamicImage;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_DIMENSION: u32 = 4096;
const CACHE_MAX_BYTES: usize = 64 * 1024 * 1024;
const CACHE_MAX_ENTRIES: usize = 1024;
const JPEG_QUALITY: u8 = 82;
const ENCODER_REVISION: &str = "inspection-jpeg-v1-request-bounds";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RequestedBounds {
    pub width: u32,
    pub height: u32,
}

pub struct Rendition {
    pub bytes: Arc<Vec<u8>>,
    pub content_type: &'static str,
    pub source_size: (u32, u32),
    pub output_size: (u32, u32),
    pub cache_status: &'static str,
    pub resize: Duration,
    pub encode: Duration,
}

struct CacheEntry {
    bytes: Arc<Vec<u8>>,
    source_size: (u32, u32),
    output_size: (u32, u32),
}

#[derive(Default)]
struct RenditionCache {
    entries: HashMap<String, CacheEntry>,
    order: VecDeque<String>,
    bytes: usize,
}

static CACHE: OnceLock<Mutex<RenditionCache>> = OnceLock::new();

pub fn requested_bounds(query: &str) -> Option<RequestedBounds> {
    let width = super::query_value(query, "maxWidth").and_then(|value| value.parse::<u32>().ok());
    let height = super::query_value(query, "maxHeight").and_then(|value| value.parse::<u32>().ok());
    if width.is_none() && height.is_none() {
        return None;
    }
    Some(RequestedBounds {
        width: width.unwrap_or(MAX_DIMENSION).clamp(1, MAX_DIMENSION),
        height: height.unwrap_or(MAX_DIMENSION).clamp(1, MAX_DIMENSION),
    })
}

pub fn render(source: &[u8], content_type: &str, bounds: RequestedBounds) -> Option<Rendition> {
    if !content_type.to_ascii_lowercase().starts_with("image/") {
        return None;
    }
    let source_hash = Sha256::digest(source);
    let key = format!(
        "{ENCODER_REVISION}:{}x{}:{source_hash:x}",
        bounds.width, bounds.height
    );
    if let Some(hit) = cache_get(&key) {
        return Some(Rendition {
            bytes: hit.bytes,
            content_type: "image/jpeg",
            source_size: hit.source_size,
            output_size: hit.output_size,
            cache_status: "hit",
            resize: Duration::ZERO,
            encode: Duration::ZERO,
        });
    }

    let decoded = image::load_from_memory(source).ok()?;
    let source_size = (decoded.width(), decoded.height());
    let output_size = contained_dimensions(source_size, (bounds.width, bounds.height));
    let resize_started = Instant::now();
    let resized = if output_size == source_size {
        decoded
    } else {
        resize_preview(&decoded, output_size)
    };
    let resize = resize_started.elapsed();
    let encode_started = Instant::now();
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, JPEG_QUALITY)
        .encode_image(&resized)
        .ok()?;
    let encode = encode_started.elapsed();
    let bytes = Arc::new(bytes);
    cache_insert(
        key,
        CacheEntry {
            bytes: Arc::clone(&bytes),
            source_size,
            output_size,
        },
    );
    Some(Rendition {
        bytes,
        content_type: "image/jpeg",
        source_size,
        output_size,
        cache_status: "miss",
        resize,
        encode,
    })
}

fn resize_preview(image: &DynamicImage, output_size: (u32, u32)) -> DynamicImage {
    let reduction = (image.width() as f64 / output_size.0 as f64)
        .max(image.height() as f64 / output_size.1 as f64);
    if reduction >= 4.0 {
        let intermediate = image.thumbnail_exact(
            output_size.0.saturating_mul(2).min(image.width()),
            output_size.1.saturating_mul(2).min(image.height()),
        );
        return intermediate.resize_exact(output_size.0, output_size.1, FilterType::Triangle);
    }
    image.resize_exact(output_size.0, output_size.1, FilterType::Triangle)
}

fn contained_dimensions(source: (u32, u32), bounds: (u32, u32)) -> (u32, u32) {
    let scale = (bounds.0 as f64 / source.0.max(1) as f64)
        .min(bounds.1 as f64 / source.1.max(1) as f64)
        .min(1.0);
    (
        ((source.0 as f64 * scale).floor() as u32).max(1),
        ((source.1 as f64 * scale).floor() as u32).max(1),
    )
}

fn cache_get(key: &str) -> Option<CacheEntry> {
    let cache = CACHE.get_or_init(Default::default).lock().ok()?;
    let entry = cache.entries.get(key)?;
    Some(CacheEntry {
        bytes: Arc::clone(&entry.bytes),
        source_size: entry.source_size,
        output_size: entry.output_size,
    })
}

fn cache_insert(key: String, entry: CacheEntry) {
    let Ok(mut cache) = CACHE.get_or_init(Default::default).lock() else {
        return;
    };
    let entry_bytes = entry.bytes.len();
    if entry_bytes > CACHE_MAX_BYTES {
        return;
    }
    if let Some(previous) = cache.entries.remove(&key) {
        cache.bytes = cache.bytes.saturating_sub(previous.bytes.len());
        cache.order.retain(|candidate| candidate != &key);
    }
    while cache.bytes.saturating_add(entry_bytes) > CACHE_MAX_BYTES
        || cache.entries.len() >= CACHE_MAX_ENTRIES
    {
        let Some(oldest) = cache.order.pop_front() else {
            break;
        };
        if let Some(removed) = cache.entries.remove(&oldest) {
            cache.bytes = cache.bytes.saturating_sub(removed.bytes.len());
        }
    }
    cache.bytes = cache.bytes.saturating_add(entry_bytes);
    cache.order.push_back(key.clone());
    cache.entries.insert(key, entry);
}

#[cfg(test)]
mod tests {
    use super::{render, requested_bounds};
    use image::codecs::png::PngEncoder;
    use image::{ExtendedColorType, ImageEncoder};

    fn png(width: u32, height: u32) -> Vec<u8> {
        let pixels = (0..width * height)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let mut bytes = Vec::new();
        PngEncoder::new(&mut bytes)
            .write_image(&pixels, width, height, ExtendedColorType::L8)
            .expect("encode fixture");
        bytes
    }

    #[test]
    fn parses_and_caps_requested_dimensions() {
        assert_eq!(requested_bounds("path=x"), None);
        assert_eq!(
            requested_bounds("path=x&maxWidth=320&maxHeight=120"),
            Some(super::RequestedBounds {
                width: 320,
                height: 120
            })
        );
        assert_eq!(
            requested_bounds("maxWidth=99999"),
            Some(super::RequestedBounds {
                width: 4096,
                height: 4096
            })
        );
    }

    #[test]
    fn resizes_to_request_bounds_and_reuses_encoded_bytes() {
        let source = png(2048, 1024);
        let bounds = super::RequestedBounds {
            width: 320,
            height: 180,
        };
        let first = render(&source, "image/png", bounds).expect("first rendition");
        assert_eq!(first.source_size, (2048, 1024));
        assert_eq!(first.output_size, (320, 160));
        assert_eq!(first.content_type, "image/jpeg");
        assert_eq!(first.cache_status, "miss");
        assert!(first.bytes.len() < source.len());

        let second = render(&source, "image/png", bounds).expect("cached rendition");
        assert_eq!(second.cache_status, "hit");
        assert!(Arc::ptr_eq(&first.bytes, &second.bytes));
    }

    use std::sync::Arc;
}
