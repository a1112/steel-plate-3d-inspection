use crate::catalog::{ArtifactQuery, ResolveError};
use crate::http::{binary_response, error_json, Response};
use crate::image_codec::{render_contained_jpeg, CodecError, RenderTiming};
use crate::state::AppState;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

const RENDITION_SCHEMA: &str = "steel.thumbnail.v1";
const ENCODER_REVISION: &str = "image-jpeg-v2-adaptive-staged-triangle";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Profile {
    Xs,
    Sm,
    Md,
    Lg,
    Xl,
}

impl Profile {
    fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "xs" => Some(Self::Xs),
            "sm" => Some(Self::Sm),
            "md" => Some(Self::Md),
            "lg" => Some(Self::Lg),
            "xl" => Some(Self::Xl),
            _ => None,
        }
    }

    fn select(slot_width: u32, slot_height: u32) -> Self {
        [Self::Xs, Self::Sm, Self::Md, Self::Lg, Self::Xl]
            .into_iter()
            .find(|profile| {
                let (width, height) = profile.bounds();
                slot_width <= width && slot_height <= height
            })
            .unwrap_or(Self::Xl)
    }

    fn bounds(self) -> (u32, u32) {
        match self {
            Self::Xs => (512, 128),
            Self::Sm => (768, 192),
            Self::Md => (1024, 256),
            Self::Lg => (1536, 384),
            Self::Xl => (2048, 512),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Xs => "xs",
            Self::Sm => "sm",
            Self::Md => "md",
            Self::Lg => "lg",
            Self::Xl => "xl",
        }
    }
}

#[derive(Default)]
struct RequestTiming {
    catalog: Duration,
    encoded_cache: Duration,
    build_wait: Duration,
    cache_store: Duration,
    render: Option<RenderTiming>,
}

pub fn serve(state: &AppState, params: &HashMap<String, String>, if_none_match: &str) -> Response {
    let request_started = Instant::now();
    let mut timing = RequestTiming::default();
    let Some(record_id) = params
        .get("recordId")
        .or_else(|| params.get("inspectionId"))
    else {
        return error_json(400, "recordId_required");
    };
    let camera_id = params
        .get("camera")
        .or_else(|| params.get("cameraId"))
        .map(String::as_str)
        .unwrap_or("C1");
    let sequence = params
        .get("sequenceNo")
        .or_else(|| params.get("sequence"))
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let color_mode = params
        .get("colorMode")
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| "gray".to_string());
    if color_mode != "gray" && color_mode != "jet" {
        return error_json(400, "colorMode_invalid");
    }
    let source_kind = params.get("kind").map(String::as_str).unwrap_or_else(|| {
        if color_mode == "jet" {
            "jet"
        } else {
            "intensity"
        }
    });
    if color_mode == "jet" && source_kind != "jet" {
        return error_json(400, "jet_requires_processed_jet_artifact");
    }
    let profile = match requested_profile(params) {
        Ok(profile) => profile,
        Err(error) => return error_json(400, error),
    };
    let live = params
        .get("live")
        .is_some_and(|value| matches!(value.as_str(), "1" | "true"));

    let catalog_started = Instant::now();
    let source = match state.catalog.resolve(ArtifactQuery {
        record_id,
        camera_id,
        sequence,
        kind: source_kind,
    }) {
        Ok(source) => source,
        Err(error) => return resolve_error(error),
    };
    timing.catalog = catalog_started.elapsed();
    let revision = params
        .get("revision")
        .map(String::as_str)
        .unwrap_or(&source.identity);
    let key = rendition_key(
        &source.identity,
        revision,
        record_id,
        camera_id,
        sequence,
        source_kind,
        &color_mode,
        profile,
    );
    let cache_control = if live {
        "no-store"
    } else {
        "public, max-age=31536000, immutable"
    };

    if !live {
        let cache_started = Instant::now();
        if let Some(bytes) = state.cache.get(&key) {
            timing.encoded_cache += cache_started.elapsed();
            return preview_response(
                bytes,
                &key,
                if_none_match,
                cache_control,
                profile,
                revision,
                "hit",
                None,
                &timing,
                request_started.elapsed(),
            );
        }
        timing.encoded_cache += cache_started.elapsed();
    }

    let gate = state.cache.build_lock(&key);
    let wait_started = Instant::now();
    let _guard = gate.lock().unwrap_or_else(|error| error.into_inner());
    timing.build_wait = wait_started.elapsed();
    if !live {
        let cache_started = Instant::now();
        if let Some(bytes) = state.cache.get(&key) {
            timing.encoded_cache += cache_started.elapsed();
            return preview_response(
                bytes,
                &key,
                if_none_match,
                cache_control,
                profile,
                revision,
                "coalesced-hit",
                None,
                &timing,
                request_started.elapsed(),
            );
        }
        timing.encoded_cache += cache_started.elapsed();
    }

    let (max_width, max_height) = profile.bounds();
    let rendered = match render_contained_jpeg(
        &state.decoded_cache,
        &source.identity,
        &source.blob_path,
        max_width,
        max_height,
    ) {
        Ok(rendered) => rendered,
        Err(CodecError::Decode) => return error_json(422, "image_decode_failed"),
        Err(CodecError::Encode) => return error_json(422, "preview_encode_failed"),
    };
    timing.render = Some(rendered.timing);
    let bytes = Arc::new(rendered.bytes);
    let cache_store_started = Instant::now();
    let cache_status = if live {
        "bypass"
    } else if state.cache.store(&key, Arc::clone(&bytes)).is_ok() {
        "miss"
    } else {
        state.cache.insert_memory(key.clone(), Arc::clone(&bytes));
        "miss-memory-only"
    };
    timing.cache_store = cache_store_started.elapsed();
    preview_response(
        bytes,
        &key,
        if_none_match,
        cache_control,
        profile,
        revision,
        cache_status,
        Some((rendered.source_size, rendered.rendition_size)),
        &timing,
        request_started.elapsed(),
    )
}

fn requested_profile(params: &HashMap<String, String>) -> Result<Profile, &'static str> {
    if let Some(value) = params.get("profile") {
        return Profile::parse(value).ok_or("profile_invalid");
    }
    let width = params
        .get("slotWidth")
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(1024);
    let height = params
        .get("slotHeight")
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(256);
    Ok(Profile::select(width.max(1), height.max(1)))
}

#[allow(clippy::too_many_arguments)]
fn rendition_key(
    source_identity: &str,
    revision: &str,
    record_id: &str,
    camera_id: &str,
    sequence: i64,
    source_kind: &str,
    color_mode: &str,
    profile: Profile,
) -> String {
    let material = format!(
        "{RENDITION_SCHEMA}|{ENCODER_REVISION}|{source_identity}|{revision}|{record_id}|{camera_id}|{sequence}|{source_kind}|{color_mode}|{}",
        profile.name()
    );
    format!("{:x}", Sha256::digest(material.as_bytes()))
}

#[allow(clippy::too_many_arguments)]
fn preview_response(
    bytes: Arc<Vec<u8>>,
    key: &str,
    if_none_match: &str,
    cache_control: &str,
    profile: Profile,
    revision: &str,
    cache_status: &str,
    sizes: Option<((u32, u32), (u32, u32))>,
    timing: &RequestTiming,
    total: Duration,
) -> Response {
    let mut headers = vec![
        ("X-Steel-Rendition-Schema", RENDITION_SCHEMA.to_string()),
        ("X-Steel-Rendition-Profile", profile.name().to_string()),
        ("X-Steel-Source-Revision", revision.to_string()),
        ("X-Steel-Rendition-Cache", cache_status.to_string()),
        ("X-Steel-Encoder-Revision", ENCODER_REVISION.to_string()),
        ("Server-Timing", server_timing(timing, total)),
    ];
    if let Some(render) = timing.render.as_ref() {
        headers.push(("X-Steel-Decode-Cache", render.decode_cache.to_string()));
        headers.push(("X-Steel-Resize-Mode", render.resize_mode.to_string()));
    }
    if let Some((source, rendition)) = sizes {
        headers.push(("X-Steel-Source-Size", format!("{}x{}", source.0, source.1)));
        headers.push((
            "X-Steel-Rendition-Size",
            format!("{}x{}", rendition.0, rendition.1),
        ));
    }
    binary_response(
        bytes,
        &format!("\"{key}\""),
        if_none_match,
        cache_control,
        &headers,
    )
}

fn server_timing(timing: &RequestTiming, total: Duration) -> String {
    let millis = |duration: Duration| duration.as_secs_f64() * 1000.0;
    let mut values = vec![
        format!("total;dur={:.2}", millis(total)),
        format!("catalog;dur={:.2}", millis(timing.catalog)),
        format!("encoded-cache;dur={:.2}", millis(timing.encoded_cache)),
        format!("build-wait;dur={:.2}", millis(timing.build_wait)),
    ];
    if let Some(render) = timing.render.as_ref() {
        values.extend([
            format!("decode;dur={:.2}", millis(render.decode)),
            format!("resize;dur={:.2}", millis(render.resize)),
            format!("encode;dur={:.2}", millis(render.encode)),
            format!("cache-store;dur={:.2}", millis(timing.cache_store)),
        ]);
    }
    values.join(", ")
}

fn resolve_error(error: ResolveError) -> Response {
    match error {
        ResolveError::CatalogUnavailable => error_json(503, "catalog_unavailable"),
        ResolveError::NotFound => error_json(404, "artifact_not_found"),
        ResolveError::InvalidReference => error_json(422, "artifact_reference_invalid"),
    }
}

#[cfg(test)]
mod tests {
    use super::{rendition_key, requested_profile, serve, Profile};
    use crate::state::AppState;
    use image::{DynamicImage, ImageFormat};
    use rusqlite::Connection;
    use std::collections::HashMap;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn maps_slot_sizes_to_bounded_profiles() {
        assert_eq!(Profile::select(420, 100), Profile::Xs);
        assert_eq!(Profile::select(1478, 118), Profile::Lg);
        assert_eq!(Profile::select(9000, 9000), Profile::Xl);
    }

    #[test]
    fn explicit_profile_is_stable_across_resize_noise() {
        let params = HashMap::from([
            ("profile".to_string(), "sm".to_string()),
            ("slotWidth".to_string(), "755".to_string()),
        ]);
        assert_eq!(requested_profile(&params), Ok(Profile::Sm));
    }

    #[test]
    fn key_separates_revision_profile_and_color_mode() {
        let base = rendition_key(
            "source",
            "r1",
            "coil",
            "C1",
            0,
            "intensity",
            "gray",
            Profile::Md,
        );
        let revision = rendition_key(
            "source",
            "r2",
            "coil",
            "C1",
            0,
            "intensity",
            "gray",
            Profile::Md,
        );
        let color = rendition_key("source", "r1", "coil", "C1", 0, "jet", "jet", Profile::Md);
        assert_ne!(base, revision);
        assert_ne!(base, color);
    }

    #[test]
    fn preview_is_independent_responsive_and_cacheable() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "steel-image-responsive-preview-{}-{nonce}",
            std::process::id()
        ));
        let blobs = root.join("blobs");
        fs::create_dir_all(&blobs).expect("create test result store");
        let identity = "1".repeat(64);
        DynamicImage::new_rgb8(2048, 512)
            .save_with_format(blobs.join(&identity), ImageFormat::Png)
            .expect("write source image");
        let connection = Connection::open(root.join("catalog.db")).expect("open test catalog");
        connection
            .execute_batch(
                "CREATE TABLE capture_file (
                    inspection_id TEXT NOT NULL,
                    camera_id TEXT NOT NULL,
                    sequence_no INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    path TEXT NOT NULL
                );",
            )
            .expect("create capture catalog");
        connection
            .execute(
                "INSERT INTO capture_file (inspection_id, camera_id, sequence_no, kind, path)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params!["coil-1", "C1", 0, "intensity", format!("blobs/{identity}")],
            )
            .expect("insert source artifact");
        drop(connection);

        let state = AppState::new(root.clone(), 1024 * 1024).expect("create app state");
        let params = HashMap::from([
            ("recordId".to_string(), "coil-1".to_string()),
            ("cameraId".to_string(), "C1".to_string()),
            ("profile".to_string(), "xs".to_string()),
            ("revision".to_string(), "revision-1".to_string()),
        ]);
        let first = serve(&state, &params, "").into_bytes();
        let separator = first
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("preview response separator");
        let headers = String::from_utf8_lossy(&first[..separator]);
        assert!(headers.starts_with("HTTP/1.1 200 OK"));
        assert!(headers.contains("X-Steel-Rendition-Profile: xs"));
        assert!(headers.contains("X-Steel-Rendition-Cache: miss"));
        assert!(headers.contains("X-Steel-Decode-Cache: miss"));
        assert!(headers.contains("X-Steel-Resize-Mode: staged-triangle"));
        assert!(headers.contains("Server-Timing: total;dur="));
        let rendered = image::load_from_memory(&first[separator + 4..]).expect("preview jpeg");
        assert_eq!((rendered.width(), rendered.height()), (512, 128));

        let second = serve(&state, &params, "").into_bytes();
        let second_headers = String::from_utf8_lossy(
            &second[..second
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .expect("cached response separator")],
        );
        assert!(second_headers.contains("X-Steel-Rendition-Cache: hit"));

        let mut resized_params = params.clone();
        resized_params.insert("profile".to_string(), "sm".to_string());
        let resized = serve(&state, &resized_params, "").into_bytes();
        let resized_separator = resized
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("second profile response separator");
        let resized_headers = String::from_utf8_lossy(&resized[..resized_separator]);
        assert!(resized_headers.contains("X-Steel-Decode-Cache: hit"));
        assert_eq!(state.catalog.stats().database_queries, 1);
        assert!(state.catalog.stats().cache_hits >= 2);
        assert_eq!(state.decoded_cache.stats().misses, 1);
        assert_eq!(state.decoded_cache.stats().hits, 1);

        let jet_params = HashMap::from([
            ("recordId".to_string(), "coil-1".to_string()),
            ("cameraId".to_string(), "C1".to_string()),
            ("colorMode".to_string(), "jet".to_string()),
        ]);
        let jet_response = serve(&state, &jet_params, "").into_bytes();
        let jet = String::from_utf8_lossy(&jet_response).into_owned();
        assert!(jet.starts_with("HTTP/1.1 404 Not Found"));
        assert!(jet.contains("artifact_not_found"));

        fs::remove_dir_all(&root).expect("remove isolated test result store");
    }
}
