use crate::cache::ByteLruCache;
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, ImageReader};
use std::collections::HashMap;
use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

pub struct RenderedImage {
    pub bytes: Vec<u8>,
    pub source_size: (u32, u32),
    pub rendition_size: (u32, u32),
    pub timing: RenderTiming,
}

pub struct RenderTiming {
    pub decode: Duration,
    pub resize: Duration,
    pub encode: Duration,
    pub decode_cache: &'static str,
    pub resize_mode: &'static str,
}

pub struct DecodedImageCache {
    memory: Mutex<ByteLruCache<DynamicImage>>,
    flights: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    hits: AtomicU64,
    misses: AtomicU64,
}

#[derive(Clone, Copy)]
pub struct DecodedImageCacheStats {
    pub hits: u64,
    pub misses: u64,
}

struct DecodedImage {
    image: Arc<DynamicImage>,
    duration: Duration,
    cache_status: &'static str,
}

pub enum CodecError {
    Decode,
    Encode,
}

impl DecodedImageCache {
    pub fn new(max_memory_bytes: usize) -> Self {
        Self {
            memory: Mutex::new(ByteLruCache::new(max_memory_bytes)),
            flights: Mutex::new(HashMap::new()),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
        }
    }

    fn load(&self, identity: &str, path: &Path) -> Result<DecodedImage, CodecError> {
        let started = Instant::now();
        if let Ok(mut memory) = self.memory.lock() {
            if let Some(image) = memory.get(identity) {
                self.hits.fetch_add(1, Ordering::Relaxed);
                return Ok(DecodedImage {
                    image,
                    duration: started.elapsed(),
                    cache_status: "hit",
                });
            }
        }
        let gate = self.build_lock(identity);
        let _guard = gate.lock().unwrap_or_else(|error| error.into_inner());
        if let Ok(mut memory) = self.memory.lock() {
            if let Some(image) = memory.get(identity) {
                self.hits.fetch_add(1, Ordering::Relaxed);
                return Ok(DecodedImage {
                    image,
                    duration: started.elapsed(),
                    cache_status: "coalesced-hit",
                });
            }
        }
        self.misses.fetch_add(1, Ordering::Relaxed);
        let image = Arc::new(decode(path)?);
        let byte_size = image.as_bytes().len();
        if let Ok(mut memory) = self.memory.lock() {
            memory.insert(identity.to_string(), Arc::clone(&image), byte_size);
        }
        Ok(DecodedImage {
            image,
            duration: started.elapsed(),
            cache_status: "miss",
        })
    }

    fn build_lock(&self, key: &str) -> Arc<Mutex<()>> {
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

    pub fn stats(&self) -> DecodedImageCacheStats {
        DecodedImageCacheStats {
            hits: self.hits.load(Ordering::Relaxed),
            misses: self.misses.load(Ordering::Relaxed),
        }
    }
}

pub fn render_contained_jpeg(
    decoded_cache: &DecodedImageCache,
    source_identity: &str,
    path: &Path,
    max_width: u32,
    max_height: u32,
) -> Result<RenderedImage, CodecError> {
    let decoded = decoded_cache.load(source_identity, path)?;
    let source_size = (decoded.image.width(), decoded.image.height());
    let rendition_size = target_dimensions(source_size, (max_width, max_height));
    let resize_started = Instant::now();
    let (resized, resize_mode) = if rendition_size == source_size {
        (None, "identity")
    } else {
        let (image, mode) = resize_preview(decoded.image.as_ref(), rendition_size);
        (Some(image), mode)
    };
    let resize = resize_started.elapsed();
    let image = resized.as_ref().unwrap_or(decoded.image.as_ref());
    let encode_started = Instant::now();
    let bytes = encode_jpeg(image)?;
    let encode = encode_started.elapsed();
    Ok(RenderedImage {
        bytes,
        source_size,
        rendition_size,
        timing: RenderTiming {
            decode: decoded.duration,
            resize,
            encode,
            decode_cache: decoded.cache_status,
            resize_mode,
        },
    })
}

pub fn render_tile_jpeg(
    path: &Path,
    level: u32,
    x: u32,
    y: u32,
    tile_size: u32,
) -> Result<Option<Vec<u8>>, CodecError> {
    let image = decode(path)?;
    let resized = if level == 0 {
        image
    } else {
        let divisor = 1u32 << level;
        let width = (image.width() / divisor).max(1);
        let height = (image.height() / divisor).max(1);
        image.resize(width, height, FilterType::Triangle)
    };
    let left = x.saturating_mul(tile_size);
    let top = y.saturating_mul(tile_size);
    if left >= resized.width() || top >= resized.height() {
        return Ok(None);
    }
    let tile = resized.crop_imm(
        left,
        top,
        tile_size.min(resized.width() - left),
        tile_size.min(resized.height() - top),
    );
    encode_jpeg(&tile).map(Some)
}

fn resize_preview(
    image: &DynamicImage,
    rendition_size: (u32, u32),
) -> (DynamicImage, &'static str) {
    let reduction = (image.width() as f64 / rendition_size.0 as f64)
        .max(image.height() as f64 / rendition_size.1 as f64);
    // The integer prefilter is especially effective for color sources. For
    // single-channel Ranger3 intensity images, Triangle remains faster around
    // a 4x reduction, so stage only the larger reductions.
    let staged_threshold = if image.color().channel_count() == 1 {
        5.0
    } else {
        3.0
    };
    if reduction >= staged_threshold {
        let intermediate_size = (
            rendition_size.0.saturating_mul(2).min(image.width()),
            rendition_size.1.saturating_mul(2).min(image.height()),
        );
        let intermediate = image.thumbnail_exact(intermediate_size.0, intermediate_size.1);
        return (
            intermediate.resize_exact(rendition_size.0, rendition_size.1, FilterType::Triangle),
            "staged-triangle",
        );
    }
    (
        image.resize_exact(rendition_size.0, rendition_size.1, FilterType::Triangle),
        "triangle",
    )
}

fn decode(path: &Path) -> Result<DynamicImage, CodecError> {
    ImageReader::open(path)
        .map_err(|_| CodecError::Decode)?
        .with_guessed_format()
        .map_err(|_| CodecError::Decode)?
        .decode()
        .map_err(|_| CodecError::Decode)
}

fn encode_jpeg(image: &DynamicImage) -> Result<Vec<u8>, CodecError> {
    let mut bytes = Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, ImageFormat::Jpeg)
        .map_err(|_| CodecError::Encode)?;
    Ok(bytes.into_inner())
}

fn target_dimensions(source: (u32, u32), bounds: (u32, u32)) -> (u32, u32) {
    let (source_width, source_height) = source;
    let (max_width, max_height) = bounds;
    if source_width == 0 || source_height == 0 || max_width == 0 || max_height == 0 {
        return (1, 1);
    }
    let scale = (max_width as f64 / source_width as f64)
        .min(max_height as f64 / source_height as f64)
        .min(1.0);
    (
        ((source_width as f64 * scale).floor() as u32).max(1),
        ((source_height as f64 * scale).floor() as u32).max(1),
    )
}

#[cfg(test)]
mod tests {
    use super::{resize_preview, target_dimensions};
    use image::DynamicImage;

    #[test]
    fn contains_without_upscaling_or_aspect_distortion() {
        assert_eq!(target_dimensions((4096, 1024), (1024, 256)), (1024, 256));
        assert_eq!(target_dimensions((400, 100), (1024, 256)), (400, 100));
        assert_eq!(target_dimensions((1000, 1000), (512, 128)), (128, 128));
    }

    #[test]
    fn stages_large_reductions_but_keeps_nearby_sizes_on_triangle() {
        let image = DynamicImage::new_luma8(2400, 960);
        let (small, small_mode) = resize_preview(&image, (300, 120));
        assert_eq!((small.width(), small.height()), (300, 120));
        assert_eq!(small_mode, "staged-triangle");

        let (large, large_mode) = resize_preview(&image, (1200, 480));
        assert_eq!((large.width(), large.height()), (1200, 480));
        assert_eq!(large_mode, "triangle");

        let (_, medium_luma_mode) = resize_preview(&image, (600, 240));
        assert_eq!(medium_luma_mode, "triangle");

        let color = DynamicImage::new_rgb8(2400, 960);
        let (_, medium_color_mode) = resize_preview(&color, (600, 240));
        assert_eq!(medium_color_mode, "staged-triangle");
    }
}
