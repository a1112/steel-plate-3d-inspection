use image::{imageops, DynamicImage, GenericImageView, ImageFormat, Rgb, RgbImage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};
use std::error::Error;
use std::fmt;
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_TILE_SIZE: u32 = 512;
const MAX_TILE_LEVEL: u8 = 3;
pub const MISSING_TILE_COLOR: [u8; 3] = [16, 20, 24];
pub const TILE_CACHE_SCHEMA: &str = "steel.inspection-world-cache.v3";

fn open_content_addressed_image(path: &Path) -> Result<DynamicImage, image::ImageError> {
    let reader = image::ImageReader::open(path)
        .map_err(image::ImageError::IoError)?
        .with_guessed_format()
        .map_err(image::ImageError::IoError)?;
    reader.decode()
}

#[derive(Debug)]
pub struct CachedTile {
    pub bytes: Vec<u8>,
    pub cache_hit: bool,
    pub etag: String,
}

fn cache_component(value: &str, label: &str) -> Result<String, WorldError> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.len() > 128
        || !normalized
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(WorldError::Artifact(format!(
            "{label} is not a safe cache identity"
        )));
    }
    Ok(normalized.to_string())
}

fn cache_revision_component(value: &str) -> Result<String, WorldError> {
    let normalized = value.trim();
    if normalized.is_empty() || normalized.len() > 4096 {
        return Err(WorldError::Artifact(
            "sourceRevision is not a valid cache identity".to_string(),
        ));
    }
    Ok(format!("r-{:x}", Sha256::digest(normalized.as_bytes())))
}

pub fn tile_cache_record_root(
    cache_root: &Path,
    record_id: &str,
    source_revision: &str,
) -> Result<PathBuf, WorldError> {
    Ok(record_cache_root(cache_root, record_id)?.join(cache_revision_component(source_revision)?))
}

pub fn record_cache_root(cache_root: &Path, record_id: &str) -> Result<PathBuf, WorldError> {
    Ok(cache_root
        .join("inspection-world-v3")
        .join(cache_component(record_id, "recordId")?))
}

pub fn tile_cache_path(
    cache_root: &Path,
    record_id: &str,
    source_revision: &str,
    request: TileRequest,
) -> Result<PathBuf, WorldError> {
    let extension = match request.format {
        TileFormat::Jpeg => "jpg",
        TileFormat::Png => "png",
    };
    Ok(
        tile_cache_record_root(cache_root, record_id, source_revision)?
            .join("tile")
            .join(format!("C{}", request.camera_id))
            .join(format!("L{}", request.level))
            .join(format!(
                "{}_{}.{}",
                request.tile_x, request.tile_y, extension
            )),
    )
}

fn cache_etag(source_revision: &str, request: TileRequest) -> String {
    let mut digest = Sha256::new();
    digest.update(TILE_CACHE_SCHEMA.as_bytes());
    digest.update(source_revision.as_bytes());
    digest.update(request.camera_id.to_le_bytes());
    digest.update([request.level]);
    digest.update(request.tile_x.to_le_bytes());
    digest.update(request.tile_y.to_le_bytes());
    digest.update([match request.format {
        TileFormat::Jpeg => 1,
        TileFormat::Png => 2,
    }]);
    format!("\"{}\"", format!("{:x}", digest.finalize()))
}

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), WorldError> {
    let parent = path.parent().ok_or_else(|| {
        WorldError::Artifact("tile cache path has no parent directory".to_string())
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        WorldError::Artifact(format!("tile cache directory unavailable: {error}"))
    })?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = path.with_extension(format!(
        "{}.{}.tmp",
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("tile"),
        nonce
    ));
    let result = (|| {
        let mut file = fs::File::create(&temporary).map_err(|error| {
            WorldError::Artifact(format!("tile cache temporary file failed: {error}"))
        })?;
        file.write_all(bytes)
            .map_err(|error| WorldError::Artifact(format!("tile cache write failed: {error}")))?;
        file.sync_all()
            .map_err(|error| WorldError::Artifact(format!("tile cache sync failed: {error}")))?;
        fs::rename(&temporary, path)
            .map_err(|error| WorldError::Artifact(format!("tile cache publish failed: {error}")))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn build_gate() -> &'static (Mutex<HashSet<PathBuf>>, Condvar) {
    static GATE: OnceLock<(Mutex<HashSet<PathBuf>>, Condvar)> = OnceLock::new();
    GATE.get_or_init(|| (Mutex::new(HashSet::new()), Condvar::new()))
}

pub fn serve_cached_tile<F>(
    cache_root: &Path,
    record_id: &str,
    source_revision: &str,
    request: TileRequest,
    generate: F,
) -> Result<CachedTile, WorldError>
where
    F: FnOnce() -> Result<Vec<u8>, WorldError>,
{
    let path = tile_cache_path(cache_root, record_id, source_revision, request)?;
    let etag = cache_etag(source_revision, request);
    if let Ok(bytes) = fs::read(&path) {
        return Ok(CachedTile {
            bytes,
            cache_hit: true,
            etag,
        });
    }
    let (active, wake) = build_gate();
    let mut guard = active
        .lock()
        .map_err(|_| WorldError::Artifact("tile build gate poisoned".to_string()))?;
    loop {
        if let Ok(bytes) = fs::read(&path) {
            return Ok(CachedTile {
                bytes,
                cache_hit: true,
                etag,
            });
        }
        if guard.insert(path.clone()) {
            break;
        }
        guard = wake
            .wait(guard)
            .map_err(|_| WorldError::Artifact("tile build gate poisoned".to_string()))?;
    }
    drop(guard);
    let generated = generate().and_then(|bytes| {
        write_bytes_atomic(&path, &bytes)?;
        Ok(bytes)
    });
    if let Ok(mut guard) = active.lock() {
        guard.remove(&path);
        wake.notify_all();
    }
    generated.map(|bytes| CachedTile {
        bytes,
        cache_hit: false,
        etag,
    })
}

pub fn read_cache_status(
    cache_root: &Path,
    record_id: &str,
    source_revision: &str,
    world: &InspectionWorld,
) -> Value {
    let root = match tile_cache_record_root(cache_root, record_id, source_revision) {
        Ok(root) => root,
        Err(_) => {
            return json!({
                "state": "unavailable",
                "tileSize": world.tile_size,
                "maxLevel": world.max_level,
            })
        }
    };
    let first_screen_requests = world
        .cameras
        .iter()
        .flat_map(|camera| {
            let span = u64::from(world.tile_size) << world.max_level;
            let columns = u64::from(camera.width).div_ceil(span);
            (0..columns).map(move |tile_x| {
                TileRequest::for_camera(
                    camera.camera_id,
                    world.max_level,
                    tile_x as u32,
                    0,
                    TileFormat::Jpeg,
                )
            })
        })
        .collect::<Vec<_>>();
    let cached_first_screen_tiles = first_screen_requests
        .iter()
        .filter(|request| {
            tile_cache_path(cache_root, record_id, source_revision, **request)
                .is_ok_and(|path| path.is_file())
        })
        .count() as u64;
    let first_screen_tiles = first_screen_requests.len() as u64;
    let first_screen_ready =
        first_screen_tiles > 0 && cached_first_screen_tiles == first_screen_tiles;

    let metadata = fs::read(root.join("cache.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .map(|metadata| {
            json!({
                "state": metadata.get("state").and_then(Value::as_str).unwrap_or("building"),
                "tileSize": metadata.pointer("/tile/tileSize").and_then(Value::as_u64).unwrap_or(u64::from(world.tile_size)),
                "maxLevel": metadata.pointer("/tile/maxLevel").and_then(Value::as_u64).unwrap_or(u64::from(world.max_level)),
                "firstScreenTiles": first_screen_tiles,
                "cachedFirstScreenTiles": cached_first_screen_tiles,
                "firstScreenReady": first_screen_ready,
            })
        })
        .unwrap_or_else(|| {
            json!({
                "state": "on-demand",
                "tileSize": world.tile_size,
                "maxLevel": world.max_level,
                "firstScreenTiles": first_screen_tiles,
                "cachedFirstScreenTiles": cached_first_screen_tiles,
                "firstScreenReady": first_screen_ready,
            })
        });
    metadata
}

fn pyramid_gate() -> &'static Mutex<HashSet<PathBuf>> {
    static ACTIVE: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashSet::new()))
}

fn pyramid_metadata(
    record_id: &str,
    source_revision: &str,
    world: &InspectionWorld,
    state: &str,
    expected: u64,
    actual: u64,
) -> Value {
    json!({
        "schema": TILE_CACHE_SCHEMA,
        "recordId": record_id,
        "sourceHash": source_revision,
        "state": state,
        "tile": {
            "format": "jpeg",
            "tileSize": world.tile_size,
            "maxLevel": world.max_level,
            "expectedCount": expected,
            "actualCount": actual,
        },
        "world": world,
    })
}

pub fn schedule_full_tile_cache<F>(
    cache_root: PathBuf,
    record_id: String,
    source_revision: String,
    world: InspectionWorld,
    generate: F,
) where
    F: Fn(TileRequest) -> Result<Vec<u8>, WorldError> + Send + Sync + 'static,
{
    let Ok(root) = tile_cache_record_root(&cache_root, &record_id, &source_revision) else {
        return;
    };
    if fs::read(root.join("cache.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| {
            value
                .get("state")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .as_deref()
        == Some("complete")
    {
        return;
    }
    let Ok(mut active) = pyramid_gate().lock() else {
        return;
    };
    if !active.insert(root.clone()) {
        return;
    }
    drop(active);

    let expected = world
        .cameras
        .iter()
        .map(|camera| {
            (0..=world.max_level)
                .map(|level| {
                    let span = u64::from(world.tile_size) << level;
                    let columns = u64::from(camera.width).div_ceil(span);
                    let rows = u64::from(camera.height).div_ceil(span);
                    columns.saturating_mul(rows)
                })
                .sum::<u64>()
        })
        .sum::<u64>();
    if let Ok(bytes) = serde_json::to_vec_pretty(&pyramid_metadata(
        &record_id,
        &source_revision,
        &world,
        "building",
        expected,
        0,
    )) {
        let _ = write_bytes_atomic(&root.join("cache.json"), &bytes);
    }

    let generator = Arc::new(generate);
    thread::spawn(move || {
        let mut actual = 0_u64;
        for camera in &world.cameras {
            for level in 0..=world.max_level {
                let span = u64::from(world.tile_size) << level;
                let columns = u64::from(camera.width).div_ceil(span);
                let rows = u64::from(camera.height).div_ceil(span);
                for tile_y in 0..rows {
                    for tile_x in 0..columns {
                        let request = TileRequest::for_camera(
                            camera.camera_id,
                            level,
                            tile_x as u32,
                            tile_y as u32,
                            TileFormat::Jpeg,
                        );
                        if serve_cached_tile(
                            &cache_root,
                            &record_id,
                            &source_revision,
                            request,
                            || generator(request),
                        )
                        .is_ok()
                        {
                            actual = actual.saturating_add(1);
                        }
                    }
                }
            }
        }
        let state = if actual == expected {
            "complete"
        } else {
            "building"
        };
        if let Ok(bytes) = serde_json::to_vec_pretty(&pyramid_metadata(
            &record_id,
            &source_revision,
            &world,
            state,
            expected,
            actual,
        )) {
            let _ = write_bytes_atomic(&root.join("cache.json"), &bytes);
        }
        if let Ok(mut active) = pyramid_gate().lock() {
            active.remove(&root);
        }
    });
}

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
        let image = open_content_addressed_image(path)
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
            .get(background_samples.len().saturating_sub(1) / 20)
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
                    let global_row = frame_number
                        .checked_mul(image.height())
                        .and_then(|offset| offset.checked_add(y))
                        .ok_or(WorldError::DimensionOverflow)?;
                    let head_offset_y = global_row
                        .checked_add(1)
                        .and_then(|row| row.checked_sub(STABLE_ROWS as u32))
                        .ok_or(WorldError::DimensionOverflow)?;
                    let average = stable_run.iter().copied().sum::<f32>() / STABLE_ROWS as f32;
                    let confidence_milli =
                        ((average / 0.8).clamp(0.0, 1.0) * 1000.0).round() as u16;
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

    pub fn with_alignments(specs: Vec<(CameraSpec, CameraAlignment)>) -> Result<Self, WorldError> {
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
        let mut longest_side = cameras.iter().fold(0_u32, |longest, camera| {
            longest.max(camera.width).max(camera.height)
        });
        while longest_side > tile_size && max_level < MAX_TILE_LEVEL {
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
        let raw_y = frame_y
            .checked_add(local.y)
            .ok_or(WorldError::DimensionOverflow)?;
        let y = raw_y
            .checked_sub(camera.head_offset_y)
            .ok_or(WorldError::InvalidRectangle)?;
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
    pub camera_id: u32,
    pub level: u8,
    pub tile_x: u32,
    pub tile_y: u32,
    pub format: TileFormat,
}

impl TileRequest {
    pub fn new(level: u8, tile_x: u32, tile_y: u32, format: TileFormat) -> Self {
        Self {
            camera_id: 0,
            level,
            tile_x,
            tile_y,
            format,
        }
    }

    pub fn for_camera(
        camera_id: u32,
        level: u8,
        tile_x: u32,
        tile_y: u32,
        format: TileFormat,
    ) -> Self {
        Self {
            camera_id,
            level,
            tile_x,
            tile_y,
            format,
        }
    }
}

pub fn compose_camera_tile<F>(
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
    let camera = world
        .cameras
        .iter()
        .find(|camera| camera.camera_id == request.camera_id)
        .ok_or(WorldError::UnknownCamera(request.camera_id))?;
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
    let display_start_y = request
        .tile_y
        .checked_mul(tile_span)
        .ok_or(WorldError::DimensionOverflow)?;
    if start_x >= camera.width || display_start_y >= camera.height {
        return Err(WorldError::TileOutOfBounds);
    }
    let source_width = tile_span.min(camera.width - start_x);
    let source_height = tile_span.min(camera.height - display_start_y);
    let raw_start_y = display_start_y
        .checked_add(camera.head_offset_y)
        .ok_or(WorldError::DimensionOverflow)?;
    let output_width = source_width.div_ceil(scale);
    let output_height = source_height.div_ceil(scale);
    let mut output = RgbImage::from_pixel(output_width, output_height, Rgb(MISSING_TILE_COLOR));

    for frame_number in &camera.frame_numbers {
        let frame_top = frame_number
            .checked_mul(camera.frame_height)
            .ok_or(WorldError::DimensionOverflow)?;
        let frame_bottom = frame_top
            .checked_add(camera.frame_height)
            .ok_or(WorldError::DimensionOverflow)?;
        if frame_bottom <= raw_start_y || frame_top >= raw_start_y + source_height {
            continue;
        }
        let Some(path) = resolve(camera.camera_id, *frame_number)? else {
            continue;
        };
        let source = open_content_addressed_image(&path)
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

        let intersection_top = frame_top.max(raw_start_y);
        let intersection_bottom = frame_bottom.min(raw_start_y + source_height);
        let crop_y = intersection_top - frame_top;
        let crop_height = intersection_bottom - intersection_top;
        let resized_width = source_width.div_ceil(scale);
        let resized_height = crop_height.div_ceil(scale);
        let cropped = source
            .view(start_x, crop_y, source_width, crop_height)
            .to_image();
        let resized = imageops::resize(
            &cropped,
            resized_width,
            resized_height,
            imageops::FilterType::Nearest,
        );
        let output_y = (intersection_top - raw_start_y) / scale;
        imageops::replace(&mut output, &resized, 0, output_y.into());
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
            let source = open_content_addressed_image(&path)
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
    use std::sync::atomic::{AtomicUsize, Ordering};
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
        assert_eq!(world.tile_size, 512);
        assert_eq!(world.max_level, 3);
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
    fn opens_extensionless_content_addressed_jpeg() {
        let root = temp_root("extensionless-jpeg");
        let path = root.join("sha256-blob");
        DynamicImage::ImageRgb8(RgbImage::from_pixel(19, 23, Rgb([80, 90, 100])))
            .save_with_format(&path, ImageFormat::Jpeg)
            .unwrap();

        let image = open_content_addressed_image(&path).unwrap();

        assert_eq!(image.dimensions(), (19, 23));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detects_camera_head_when_stable_rows_cross_a_frame_boundary() {
        let root = temp_root("head-cross-frame");
        let first = head_frame(&root, "first.png", 80, 64, Some(57), &[]);
        let second = head_frame(&root, "second.png", 80, 64, Some(0), &[]);

        let alignment = detect_camera_head(&[(0, first), (1, second)]).unwrap();

        assert!(alignment.aligned);
        assert_eq!(alignment.head_offset_y, 57);
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
    fn camera_local_tile_never_resolves_an_adjacent_camera() {
        let root = temp_root("camera-local-isolation");
        let left = solid_frame(&root, "left.png", 5, 4, [10, 20, 30]);
        let world =
            InspectionWorld::with_tile_size(vec![camera(1, 5, 4, 1), camera(2, 7, 4, 1)], 8)
                .unwrap();
        let mut calls = HashMap::<u32, usize>::new();

        let bytes = compose_camera_tile(
            &world,
            TileRequest::for_camera(1, 0, 0, 0, TileFormat::Png),
            |camera, _| {
                *calls.entry(camera).or_default() += 1;
                if camera == 1 {
                    Ok(Some(left.clone()))
                } else {
                    Err(WorldError::Artifact("adjacent camera read".into()))
                }
            },
        )
        .unwrap();
        let tile = decode_png(&bytes);

        assert_eq!(tile.dimensions(), (5, 4));
        assert_eq!(calls.get(&1), Some(&1));
        assert_eq!(calls.get(&2), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn default_edge_tile_uses_only_the_remaining_pixels() {
        let root = temp_root("default-edge-tile");
        let source = solid_frame(&root, "edge.png", 520, 530, [40, 80, 120]);
        let world = InspectionWorld::new(vec![camera(1, 520, 530, 1)]).unwrap();

        let bytes = compose_camera_tile(
            &world,
            TileRequest::for_camera(1, 0, 1, 1, TileFormat::Png),
            |_, _| Ok(Some(source.clone())),
        )
        .unwrap();
        let tile = decode_png(&bytes);

        assert_eq!(world.tile_size, 512);
        assert_eq!(tile.dimensions(), (8, 18));
        assert_eq!(tile.get_pixel(7, 17).0, [40, 80, 120]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn camera_local_tile_zero_starts_at_detected_raw_head_row() {
        let root = temp_root("camera-local-head");
        let mut source = RgbImage::from_pixel(4, 8, Rgb([255, 0, 0]));
        for y in 2..8 {
            for x in 0..4 {
                source.put_pixel(x, y, Rgb([0, 255, 0]));
            }
        }
        let source_path = root.join("aligned.png");
        DynamicImage::ImageRgb8(source)
            .save_with_format(&source_path, ImageFormat::Png)
            .unwrap();
        let world = InspectionWorld::with_tile_size_and_alignments(
            vec![(
                camera(1, 4, 8, 1),
                CameraAlignment {
                    aligned: true,
                    head_offset_y: 2,
                    confidence_milli: 900,
                },
            )],
            8,
        )
        .unwrap();

        let bytes = compose_camera_tile(
            &world,
            TileRequest::for_camera(1, 0, 0, 0, TileFormat::Png),
            |_, _| Ok(Some(source_path.clone())),
        )
        .unwrap();
        let tile = decode_png(&bytes);

        assert_eq!(tile.dimensions(), (4, 6));
        assert_eq!(tile.get_pixel(1, 0).0, [0, 255, 0]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn composes_level_one_in_the_same_content_order() {
        let root = temp_root("level-one");
        let top = solid_frame(&root, "top.png", 4, 2, [255, 0, 0]);
        let bottom = solid_frame(&root, "bottom.png", 4, 2, [0, 255, 0]);
        let world = InspectionWorld::with_tile_size(vec![camera(1, 4, 2, 2)], 2).unwrap();

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

    #[test]
    fn disk_tile_cache_reports_miss_then_hit_without_regeneration() {
        let root = temp_root("disk-cache");
        let request = TileRequest::for_camera(1, 0, 0, 0, TileFormat::Jpeg);
        let generations = AtomicUsize::new(0);

        let first = serve_cached_tile(&root, "record-1", "revision-1", request, || {
            generations.fetch_add(1, Ordering::Relaxed);
            Ok(vec![1, 2, 3])
        })
        .unwrap();
        let second = serve_cached_tile(&root, "record-1", "revision-1", request, || {
            generations.fetch_add(1, Ordering::Relaxed);
            Ok(vec![4, 5, 6])
        })
        .unwrap();

        assert!(!first.cache_hit);
        assert!(second.cache_hit);
        assert_eq!(first.bytes, second.bytes);
        assert_eq!(first.etag, second.etag);
        assert_eq!(generations.load(Ordering::Relaxed), 1);
        assert!(tile_cache_path(&root, "record-1", "revision-1", request)
            .unwrap()
            .is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn disk_tile_cache_hashes_opaque_source_revisions() {
        let root = temp_root("opaque-revision-cache");
        let request = TileRequest::for_camera(2, 3, 4, 5, TileFormat::Jpeg);
        let revision = "bkv:91b834580950c12a79cb0ea1ff092fde24f7af77b7c3025aa13b7e8b4fd1ca8e";

        let path = tile_cache_path(&root, "1924610", revision, request).unwrap();
        let relative = path.strip_prefix(&root).unwrap().to_string_lossy();

        assert!(relative.contains("inspection-world-v3"));
        assert!(relative.contains("1924610"));
        assert!(relative.contains("C2"));
        assert!(relative.contains("L3"));
        assert!(!relative.contains(revision));
        assert!(!relative.contains(':'));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cache_status_reports_first_screen_coverage_for_on_demand_records() {
        let root = temp_root("first-screen-cache-status");
        let world =
            InspectionWorld::with_tile_size(vec![camera(1, 6, 2, 1), camera(2, 2, 2, 1)], 4)
                .unwrap();
        let revision = "revision-1";

        let cold = read_cache_status(&root, "record-1", revision, &world);
        assert_eq!(cold["state"], json!("on-demand"));
        assert_eq!(cold["firstScreenTiles"], json!(2));
        assert_eq!(cold["cachedFirstScreenTiles"], json!(0));
        assert_eq!(cold["firstScreenReady"], json!(false));

        for request in [
            TileRequest::for_camera(1, 1, 0, 0, TileFormat::Jpeg),
            TileRequest::for_camera(2, 1, 0, 0, TileFormat::Jpeg),
        ] {
            serve_cached_tile(&root, "record-1", revision, request, || Ok(vec![1, 2, 3])).unwrap();
        }

        let warm = read_cache_status(&root, "record-1", revision, &world);
        assert_eq!(warm["cachedFirstScreenTiles"], json!(2));
        assert_eq!(warm["firstScreenReady"], json!(true));
        fs::remove_dir_all(root).unwrap();
    }
}
