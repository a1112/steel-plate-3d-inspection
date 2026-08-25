use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, ImageReader};
use std::io::Cursor;
use std::path::Path;

pub struct RenderedImage {
    pub bytes: Vec<u8>,
    pub source_size: (u32, u32),
    pub rendition_size: (u32, u32),
}

pub enum CodecError {
    Decode,
    Encode,
}

pub fn render_contained_jpeg(
    path: &Path,
    max_width: u32,
    max_height: u32,
) -> Result<RenderedImage, CodecError> {
    let image = decode(path)?;
    let source_size = (image.width(), image.height());
    let rendition_size = target_dimensions(source_size, (max_width, max_height));
    let image = if rendition_size == source_size {
        image
    } else {
        image.resize_exact(rendition_size.0, rendition_size.1, FilterType::Triangle)
    };
    Ok(RenderedImage {
        bytes: encode_jpeg(image)?,
        source_size,
        rendition_size,
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
    encode_jpeg(tile).map(Some)
}

fn decode(path: &Path) -> Result<DynamicImage, CodecError> {
    ImageReader::open(path)
        .map_err(|_| CodecError::Decode)?
        .with_guessed_format()
        .map_err(|_| CodecError::Decode)?
        .decode()
        .map_err(|_| CodecError::Decode)
}

fn encode_jpeg(image: DynamicImage) -> Result<Vec<u8>, CodecError> {
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
    use super::target_dimensions;

    #[test]
    fn contains_without_upscaling_or_aspect_distortion() {
        assert_eq!(target_dimensions((4096, 1024), (1024, 256)), (1024, 256));
        assert_eq!(target_dimensions((400, 100), (1024, 256)), (400, 100));
        assert_eq!(target_dimensions((1000, 1000), (512, 128)), (128, 128));
    }
}
