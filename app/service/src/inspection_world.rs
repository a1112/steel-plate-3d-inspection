use image::{imageops, DynamicImage, GenericImageView, ImageFormat, Rgb, RgbImage};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::error::Error;
use std::fmt;
use std::io::Cursor;
use std::path::PathBuf;

const DEFAULT_TILE_SIZE: u32 = 512;
pub const MISSING_TILE_COLOR: [u8; 3] = [16, 20, 24];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FrameOrder {
    Ascending,
    Descending,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraOrientation {
    pub frame_order: FrameOrder,
    pub rotation: u16,
    pub flip_x: bool,
    pub flip_y: bool,
}

impl CameraOrientation {
    pub fn identity() -> Self {
        Self {
            frame_order: FrameOrder::Ascending,
            rotation: 0,
            flip_x: false,
            flip_y: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraAlignment {
    pub aligned: bool,
    pub head_offset_y: u32,
    pub confidence_milli: u16,
}

impl CameraAlignment {
    pub fn unaligned() -> Self {
        Self {
            aligned: false,
            head_offset_y: 0,
            confidence_milli: 0,
        }
    }
}

pub fn detect_camera_head(frames: &[(u32, PathBuf)]) -> Result<CameraAlignment, WorldError> {
    const SAMPLE_STEP: usize = 4;
    const BACKGROUND_ROWS: u32 = 32;
    const MIN_LUMA: u8 = 35;
    const BACKGROUND_DELTA: u8 = 18;
    const MIN_FOREGROUND_OCCUPANCY: f32 = 0.12;
    const STABLE_ROWS: usize = 8;

    let mut stable_run = VecDeque::with_capacity(STABLE_ROWS);
    for (frame_number, path) in frames {
        let image = image::open(path)
            .map_err(|error| WorldError::Image(format!("{}: {error}", path.display())))?
            .to_luma8();
        let mut background_samples = Vec::new();
        for y in 0..BACKGROUND_ROWS.min(image.height()) {
            for x in (0..image.width()).step_by(SAMPLE_STEP) {
                background_samples.push(image.get_pixel(x, y).0[0]);
            }
        }
        background_samples.sort_unstable();
        let background = background_samples
            .get(background_samples.len().saturating_sub(1) / 4)
            .copied()
            .unwrap_or(0);
        let threshold = MIN_LUMA.max(background.saturating_add(BACKGROUND_DELTA));

        for y in 0..image.height() {
            let mut foreground = 0_usize;
            let mut samples = 0_usize;
            for x in (0..image.width()).step_by(SAMPLE_STEP) {
                foreground += usize::from(image.get_pixel(x, y).0[0] > threshold);
                samples += 1;
            }
            let occupancy = foreground as f32 / samples.max(1) as f32;
            if occupancy >= MIN_FOREGROUND_OCCUPANCY {
                if stable_run.len() == STABLE_ROWS {
                    stable_run.pop_front();
                }
                stable_run.push_back(occupancy);
                if stable_run.len() == STABLE_ROWS {
                    let local_head = y + 1 - STABLE_ROWS as u32;
                    let head_offset_y = frame_number
                        .checked_mul(image.height())
                        .and_then(|offset| offset.checked_add(local_head))
                        .ok_or(WorldError::DimensionOverflow)?;
                    let average = stable_run.iter().copied().sum::<f32>() / STABLE_ROWS as f32;
                    let confidence_milli = ((average / 0.8).clamp(0.0, 1.0) * 1000.0)
                        .round() as u16;
                    return Ok(CameraAlignment {
                        aligned: true,
                        head_offset_y,
                        confidence_milli,
                    });
                }
            } else {
                stable_run.clear();
            }
        }
    }
    Ok(CameraAlignment::unaligned())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CameraSpec {
    pub camera_id: u32,
    pub frame_width: u32,
    pub frame_height: u32,
    pub frame_numbers: Vec<u32>,
    pub orientation: CameraOrientation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraWorld {
    pub camera_id: u32,
    pub offset_x: u32,
    pub width: u32,
    pub height: u32,
    pub raw_height: u32,
    pub head_offset_y: u32,
    pub aligned: bool,
    pub alignment_confidence_milli: u16,
    pub frame_width: u32,
    pub frame_height: u32,
    pub frame_numbers: Vec<u32>,
    pub orientation: CameraOrientation,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl PixelRect {
    pub fn new(x: u32, y: u32, width: u32, height: u32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn from_edges(left: u32, right: u32, top: u32, bottom: u32) -> Result<Self, WorldError> {
        let width = right
            .checked_sub(left)
            .ok_or(WorldError::InvalidRectangle)?;
        let height = bottom
            .checked_sub(top)
            .ok_or(WorldError::InvalidRectangle)?;
        Ok(Self::new(left, top, width, height))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionWorld {
    pub width: u32,
    pub height: u32,
    pub tile_size: u32,
    pub max_level: u8,
    pub cameras: Vec<CameraWorld>,
}

impl InspectionWorld {
    pub fn new(specs: Vec<CameraSpec>) -> Result<Self, WorldError> {
        Self::with_tile_size(specs, DEFAULT_TILE_SIZE)
    }

    pub fn with_tile_size(specs: Vec<CameraSpec>, tile_size: u32) -> Result<Self, WorldError> {
        Self::with_tile_size_and_alignments(
            specs
                .into_iter()
                .map(|spec| (spec, CameraAlignment::unaligned()))
                .collect(),
            tile_size,
        )
    }

    pub fn with_alignments(
        specs: Vec<(CameraSpec, CameraAlignment)>,
    ) -> Result<Self, WorldError> {
        Self::with_tile_size_and_alignments(specs, DEFAULT_TILE_SIZE)
    }

    pub fn with_tile_size_and_alignments(
        specs: Vec<(CameraSpec, CameraAlignment)>,
        tile_size: u32,
    ) -> Result<Self, WorldError> {
        if tile_size == 0 {
            return Err(WorldError::InvalidTileSize);
        }
        let mut camera_ids = HashSet::new();
        let mut offset_x = 0_u32;
        let mut world_height = 0_u32;
        let mut cameras = Vec::with_capacity(specs.len());

        for (spec, alignment) in specs {
            if !camera_ids.insert(spec.camera_id) {
                return Err(WorldError::DuplicateCamera(spec.camera_id));
            }
            if spec.frame_width == 0 || spec.frame_height == 0 || spec.frame_numbers.is_empty() {
                return Err(WorldError::InvalidCameraDimensions(spec.camera_id));
            }
            if spec.orientation != CameraOrientation::identity() {
                return Err(WorldError::UnsupportedOrientation {
                    camera_id: spec.camera_id,
                });
            }
            let frame_extent = spec
                .frame_numbers
                .iter()
                .max()
                .copied()
                .and_then(|frame| frame.checked_add(1))
                .ok_or(WorldError::DimensionOverflow)?;
            let raw_height = spec
                .frame_height
                .checked_mul(frame_extent)
                .ok_or(WorldError::DimensionOverflow)?;
            let head_offset_y = if alignment.aligned {
                alignment.head_offset_y
            } else {
                0
            };
            let height = raw_height
                .checked_sub(head_offset_y)
                .ok_or(WorldError::InvalidHeadOffset(spec.camera_id))?;
            cameras.push(CameraWorld {
                camera_id: spec.camera_id,
                offset_x,
                width: spec.frame_width,
                height,
                raw_height,
                head_offset_y,
                aligned: alignment.aligned,
                alignment_confidence_milli: alignment.confidence_milli,
                frame_width: spec.frame_width,
                frame_height: spec.frame_height,
                frame_numbers: spec.frame_numbers,
                orientation: spec.orientation,
            });
            offset_x = offset_x
                .checked_add(spec.frame_width)
                .ok_or(WorldError::DimensionOverflow)?;
            world_height = world_height.max(height);
        }

        let mut max_level = 0_u8;
        let mut longest_side = offset_x.max(world_height);
        while longest_side > 1 {
            longest_side = longest_side.div_ceil(2);
            max_level = max_level
                .checked_add(1)
                .ok_or(WorldError::DimensionOverflow)?;
        }

        Ok(Self {
            width: offset_x,
            height: world_height,
            tile_size,
            max_level,
            cameras,
        })
    }

    pub fn map_defect(
        &self,
        camera_id: u32,
        image_index: u32,
        local: PixelRect,
    ) -> Result<PixelRect, WorldError> {
        let camera = self
            .cameras
            .iter()
            .find(|camera| camera.camera_id == camera_id)
            .ok_or(WorldError::UnknownCamera(camera_id))?;
        if !camera.frame_numbers.contains(&image_index) {
            return Err(WorldError::UnknownFrame {
                camera_id,
                image_index,
            });
        }
        let x = camera
            .offset_x
            .checked_add(local.x)
            .ok_or(WorldError::DimensionOverflow)?;
        let frame_y = image_index
            .checked_mul(camera.frame_height)
            .ok_or(WorldError::DimensionOverflow)?;
        let y = frame_y
            .checked_add(local.y)
            .ok_or(WorldError::DimensionOverflow)?;
        Ok(PixelRect::new(x, y, local.width, local.height))
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum TileFormat {
    Jpeg,
    Png,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct TileRequest {
    pub level: u8,
    pub tile_x: u32,
    pub tile_y: u32,
    pub format: TileFormat,
}

impl TileRequest {
    pub fn new(level: u8, tile_x: u32, tile_y: u32, format: TileFormat) -> Self {
        Self {
            level,
            tile_x,
            tile_y,
            format,
        }
    }
}

pub fn compose_tile<F>(
    world: &InspectionWorld,
    request: TileRequest,
    mut resolve: F,
) -> Result<Vec<u8>, WorldError>
where
    F: FnMut(u32, u32) -> Result<Option<PathBuf>, WorldError>,
{
    if request.level > world.max_level {
        return Err(WorldError::TileOutOfBounds);
    }
    let scale = 1_u32
        .checked_shl(request.level as u32)
        .ok_or(WorldError::DimensionOverflow)?;
    let tile_span = world
        .tile_size
        .checked_mul(scale)
        .ok_or(WorldError::DimensionOverflow)?;
    let start_x = request
        .tile_x
        .checked_mul(tile_span)
        .ok_or(WorldError::DimensionOverflow)?;
    let start_y = request
        .tile_y
        .checked_mul(tile_span)
        .ok_or(WorldError::DimensionOverflow)?;
    if start_x >= world.width || start_y >= world.height {
        return Err(WorldError::TileOutOfBounds);
    }
    let source_width = tile_span.min(world.width - start_x);
    let source_height = tile_span.min(world.height - start_y);
    let output_width = source_width.div_ceil(scale);
    let output_height = source_height.div_ceil(scale);
    let mut output = RgbImage::from_pixel(output_width, output_height, Rgb(MISSING_TILE_COLOR));

    for camera in &world.cameras {
        let camera_left = camera.offset_x;
        let camera_right = camera_left
            .checked_add(camera.width)
            .ok_or(WorldError::DimensionOverflow)?;
        if camera_right <= start_x || camera_left >= start_x + source_width {
            continue;
        }
        for frame_number in &camera.frame_numbers {
            let frame_top = frame_number
                .checked_mul(camera.frame_height)
                .ok_or(WorldError::DimensionOverflow)?;
            let frame_bottom = frame_top
                .checked_add(camera.frame_height)
                .ok_or(WorldError::DimensionOverflow)?;
            if frame_bottom <= start_y || frame_top >= start_y + source_height {
                continue;
            }
            let Some(path) = resolve(camera.camera_id, *frame_number)? else {
                continue;
            };
            let source = image::open(&path)
                .map_err(|error| WorldError::Image(format!("{}: {error}", path.display())))?
                .to_rgb8();
            if source.dimensions() != (camera.frame_width, camera.frame_height) {
                return Err(WorldError::Image(format!(
                    "camera {} frame {} expected {}x{}, found {}x{}",
                    camera.camera_id,
                    frame_number,
                    camera.frame_width,
                    camera.frame_height,
                    source.width(),
                    source.height(),
                )));
            }

            let intersection_left = camera_left.max(start_x);
            let intersection_top = frame_top.max(start_y);
            let intersection_right = camera_right.min(start_x + source_width);
            let intersection_bottom = frame_bottom.min(start_y + source_height);
            let crop_x = intersection_left - camera_left;
            let crop_y = intersection_top - frame_top;
            let crop_width = intersection_right - intersection_left;
            let crop_height = intersection_bottom - intersection_top;
            let resized_width = crop_width.div_ceil(scale);
            let resized_height = crop_height.div_ceil(scale);
            let cropped = source
                .view(crop_x, crop_y, crop_width, crop_height)
                .to_image();
            let resized = imageops::resize(
                &cropped,
                resized_width,
                resized_height,
                imageops::FilterType::Nearest,
            );
            let output_x = (intersection_left - start_x) / scale;
            let output_y = (intersection_top - start_y) / scale;
            imageops::replace(&mut output, &resized, output_x.into(), output_y.into());
        }
    }

    let mut encoded = Cursor::new(Vec::new());
    let format = match request.format {
        TileFormat::Jpeg => ImageFormat::Jpeg,
        TileFormat::Png => ImageFormat::Png,
    };
    DynamicImage::ImageRgb8(output)
        .write_to(&mut encoded, format)
        .map_err(|error| WorldError::Image(error.to_string()))?;
    Ok(encoded.into_inner())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorldError {
    Artifact(String),
    DimensionOverflow,
    DuplicateCamera(u32),
    InvalidCameraDimensions(u32),
    InvalidHeadOffset(u32),
    InvalidRectangle,
    InvalidTileSize,
    Image(String),
    TileOutOfBounds,
    UnknownCamera(u32),
    UnknownFrame { camera_id: u32, image_index: u32 },
    UnsupportedOrientation { camera_id: u32 },
}

impl fmt::Display for WorldError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl Error for WorldError {}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
    use std::collections::HashMap;
    use std::fs;
    use std::io::Cursor;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn camera(camera_id: u32, width: u32, frame_height: u32, frame_count: u32) -> CameraSpec {
        CameraSpec {
            camera_id,
            frame_width: width,
            frame_height,
            frame_numbers: (0..frame_count).collect(),
            orientation: CameraOrientation::identity(),
        }
    }

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("steel-world-{name}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn solid_frame(
        root: &std::path::Path,
        name: &str,
        width: u32,
        height: u32,
        color: [u8; 3],
    ) -> PathBuf {
        let path = root.join(name);
        DynamicImage::ImageRgb8(RgbImage::from_pixel(width, height, Rgb(color)))
            .save_with_format(&path, ImageFormat::Png)
            .unwrap();
        path
    }

    fn head_frame(
        root: &std::path::Path,
        name: &str,
        width: u32,
        height: u32,
        head_y: Option<u32>,
        noise_rows: &[u32],
    ) -> PathBuf {
        let mut image = RgbImage::from_pixel(width, height, Rgb([0, 0, 0]));
        for row in noise_rows {
            if *row < height {
                image.put_pixel(width / 2, *row, Rgb([240, 240, 240]));
            }
        }
        if let Some(head_y) = head_y {
            for y in head_y..height {
                for x in width / 5..width {
                    let texture = ((x + y) % 17) as u8;
                    image.put_pixel(x, y, Rgb([72 + texture, 88 + texture, 104 + texture]));
                }
            }
        }
        let path = root.join(name);
        DynamicImage::ImageRgb8(image)
            .save_with_format(&path, ImageFormat::Png)
            .unwrap();
        path
    }

    fn decode_png(bytes: &[u8]) -> RgbImage {
        image::load(Cursor::new(bytes), ImageFormat::Png)
            .unwrap()
            .to_rgb8()
    }

    #[test]
    fn joins_camera_widths_and_uses_tallest_camera_height() {
        let world = InspectionWorld::new(vec![
            camera(1, 682, 1024, 21),
            camera(2, 646, 1024, 21),
            camera(3, 632, 1024, 21),
            camera(4, 541, 1024, 21),
            camera(5, 692, 1024, 21),
            camera(6, 677, 1024, 21),
        ])
        .unwrap();

        assert_eq!(world.width, 3_870);
        assert_eq!(world.height, 21_504);
        assert_eq!(world.cameras[5].offset_x, 3_193);
    }

    #[test]
    fn aligned_world_keeps_real_widths_and_crops_each_camera_head() {
        let world = InspectionWorld::with_alignments(vec![
            (
                camera(1, 68, 100, 3),
                CameraAlignment {
                    aligned: true,
                    head_offset_y: 12,
                    confidence_milli: 900,
                },
            ),
            (
                camera(2, 54, 100, 2),
                CameraAlignment {
                    aligned: true,
                    head_offset_y: 28,
                    confidence_milli: 850,
                },
            ),
        ])
        .unwrap();

        assert_eq!(world.width, 122);
        assert_eq!(world.height, 288);
        assert_eq!(world.cameras[0].offset_x, 0);
        assert_eq!(world.cameras[0].width, 68);
        assert_eq!(world.cameras[0].raw_height, 300);
        assert_eq!(world.cameras[0].height, 288);
        assert_eq!(world.cameras[0].head_offset_y, 12);
        assert!(world.cameras[0].aligned);
        assert_eq!(world.cameras[1].offset_x, 68);
        assert_eq!(world.cameras[1].width, 54);
        assert_eq!(world.cameras[1].raw_height, 200);
        assert_eq!(world.cameras[1].height, 172);
    }

    #[test]
    fn detects_stable_camera_head_after_leading_background() {
        let root = temp_root("head-detection");
        let first = head_frame(&root, "first.png", 80, 64, None, &[4, 17, 31]);
        let second = head_frame(&root, "second.png", 80, 64, Some(19), &[2, 8]);

        let alignment = detect_camera_head(&[(0, first), (1, second)]).unwrap();

        assert!(alignment.aligned);
        assert_eq!(alignment.head_offset_y, 83);
        assert!(alignment.confidence_milli >= 700);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn leaves_all_background_camera_unaligned_despite_isolated_noise() {
        let root = temp_root("head-noise");
        let frame = head_frame(&root, "noise.png", 80, 64, None, &[3, 9, 15, 27, 45]);

        let alignment = detect_camera_head(&[(0, frame)]).unwrap();

        assert!(!alignment.aligned);
        assert_eq!(alignment.head_offset_y, 0);
        assert_eq!(alignment.confidence_milli, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn shorter_camera_keeps_offset_and_empty_tail() {
        let world =
            InspectionWorld::new(vec![camera(1, 100, 16, 3), camera(2, 80, 16, 1)]).unwrap();

        assert_eq!(world.height, 48);
        assert_eq!(world.cameras[1].offset_x, 100);
        assert_eq!(world.cameras[1].height, 16);
    }

    #[test]
    fn maps_bkv_defect_into_camera_one_frame_twelve() {
        let world = InspectionWorld::new(vec![camera(1, 682, 1024, 21)]).unwrap();
        let rect = world
            .map_defect(1, 12, PixelRect::from_edges(473, 483, 857, 867).unwrap())
            .unwrap();

        assert_eq!(rect, PixelRect::new(473, 13_145, 10, 10));
    }

    #[test]
    fn rejects_duplicate_camera_ids() {
        let error =
            InspectionWorld::new(vec![camera(1, 100, 16, 2), camera(1, 100, 16, 2)]).unwrap_err();

        assert_eq!(error, WorldError::DuplicateCamera(1));
    }

    #[test]
    fn rejects_rotation_until_transformed_copying_is_supported() {
        let mut rotated = camera(1, 100, 16, 2);
        rotated.orientation.rotation = 90;

        assert_eq!(
            InspectionWorld::new(vec![rotated]).unwrap_err(),
            WorldError::UnsupportedOrientation { camera_id: 1 }
        );
    }

    #[test]
    fn composes_tile_across_adjacent_frames_without_a_seam() {
        let root = temp_root("frames");
        let top = solid_frame(&root, "top.png", 4, 2, [255, 0, 0]);
        let bottom = solid_frame(&root, "bottom.png", 4, 2, [0, 255, 0]);
        let world = InspectionWorld::with_tile_size(vec![camera(1, 4, 2, 2)], 4).unwrap();

        let bytes = compose_tile(
            &world,
            TileRequest::new(0, 0, 0, TileFormat::Png),
            |_, frame| {
                Ok(Some(if frame == 0 {
                    top.clone()
                } else {
                    bottom.clone()
                }))
            },
        )
        .unwrap();
        let tile = decode_png(&bytes);
        assert_eq!(tile.dimensions(), (4, 4));
        assert_eq!(tile.get_pixel(1, 1).0, [255, 0, 0]);
        assert_eq!(tile.get_pixel(1, 2).0, [0, 255, 0]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn composes_tile_across_adjacent_cameras_in_configured_order() {
        let root = temp_root("cameras");
        let left = solid_frame(&root, "left.png", 2, 2, [10, 20, 30]);
        let right = solid_frame(&root, "right.png", 2, 2, [200, 210, 220]);
        let world =
            InspectionWorld::with_tile_size(vec![camera(1, 2, 2, 1), camera(2, 2, 2, 1)], 4)
                .unwrap();

        let bytes = compose_tile(
            &world,
            TileRequest::new(0, 0, 0, TileFormat::Png),
            |camera, _| {
                Ok(Some(if camera == 1 {
                    left.clone()
                } else {
                    right.clone()
                }))
            },
        )
        .unwrap();
        let tile = decode_png(&bytes);
        assert_eq!(tile.get_pixel(1, 0).0, [10, 20, 30]);
        assert_eq!(tile.get_pixel(2, 0).0, [200, 210, 220]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn composes_level_one_in_the_same_content_order() {
        let root = temp_root("level-one");
        let top = solid_frame(&root, "top.png", 4, 2, [255, 0, 0]);
        let bottom = solid_frame(&root, "bottom.png", 4, 2, [0, 255, 0]);
        let world = InspectionWorld::with_tile_size(vec![camera(1, 4, 2, 2)], 4).unwrap();

        let bytes = compose_tile(
            &world,
            TileRequest::new(1, 0, 0, TileFormat::Png),
            |_, frame| {
                Ok(Some(if frame == 0 {
                    top.clone()
                } else {
                    bottom.clone()
                }))
            },
        )
        .unwrap();
        let tile = decode_png(&bytes);
        assert_eq!(tile.dimensions(), (2, 2));
        assert_eq!(tile.get_pixel(0, 0).0, [255, 0, 0]);
        assert_eq!(tile.get_pixel(0, 1).0, [0, 255, 0]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn composes_missing_frame_as_blank_without_shifting_later_frames() {
        let root = temp_root("missing");
        let first = solid_frame(&root, "first.png", 2, 2, [255, 0, 0]);
        let third = solid_frame(&root, "third.png", 2, 2, [0, 0, 255]);
        let world = InspectionWorld::with_tile_size(vec![camera(1, 2, 2, 3)], 6).unwrap();

        let bytes = compose_tile(
            &world,
            TileRequest::new(0, 0, 0, TileFormat::Png),
            |_, frame| {
                Ok(match frame {
                    0 => Some(first.clone()),
                    2 => Some(third.clone()),
                    _ => None,
                })
            },
        )
        .unwrap();
        let tile = decode_png(&bytes);
        assert_eq!(tile.dimensions(), (2, 6));
        assert_eq!(tile.get_pixel(0, 0).0, [255, 0, 0]);
        assert_eq!(tile.get_pixel(0, 2).0, MISSING_TILE_COLOR);
        assert_eq!(tile.get_pixel(0, 4).0, [0, 0, 255]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn composes_only_sources_intersecting_requested_tile() {
        let root = temp_root("bounded");
        let allowed = solid_frame(&root, "allowed.png", 2, 2, [1, 2, 3]);
        let world =
            InspectionWorld::with_tile_size(vec![camera(1, 2, 2, 1), camera(2, 2, 2, 1)], 2)
                .unwrap();
        let mut calls = HashMap::<u32, usize>::new();

        compose_tile(
            &world,
            TileRequest::new(0, 0, 0, TileFormat::Png),
            |camera, _| {
                *calls.entry(camera).or_default() += 1;
                if camera == 1 {
                    Ok(Some(allowed.clone()))
                } else {
                    Err(WorldError::Artifact("forbidden".into()))
                }
            },
        )
        .unwrap();

        assert_eq!(calls.get(&1), Some(&1));
        assert_eq!(calls.get(&2), None);
        fs::remove_dir_all(root).unwrap();
    }
}
