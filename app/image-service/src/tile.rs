use crate::catalog::{ArtifactQuery, ResolveError};
use crate::http::{binary_response, error_json, Response};
use crate::image_codec::{render_tile_jpeg, CodecError};
use crate::state::AppState;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;

const TILE_SIZE: u32 = 512;
const MAX_TILE_LEVEL: u32 = 3;

pub fn serve(state: &AppState, params: &HashMap<String, String>, if_none_match: &str) -> Response {
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
    let kind = params
        .get("kind")
        .map(String::as_str)
        .unwrap_or("intensity");
    let level = params
        .get("level")
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0)
        .min(MAX_TILE_LEVEL);
    let x = params
        .get("x")
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    let y = params
        .get("y")
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    let source = match state.catalog.resolve(ArtifactQuery {
        record_id,
        camera_id,
        sequence,
        kind,
    }) {
        Ok(source) => source,
        Err(ResolveError::CatalogUnavailable) => return error_json(503, "catalog_unavailable"),
        Err(ResolveError::NotFound) => return error_json(404, "artifact_not_found"),
        Err(ResolveError::InvalidReference) => {
            return error_json(422, "artifact_reference_invalid")
        }
    };
    let key = format!(
        "{:x}",
        Sha256::digest(
            format!("steel.legacy-tile.v1|{}|{level}|{x}|{y}", source.identity).as_bytes()
        )
    );
    if let Some(bytes) = state.cache.get(&key) {
        return tile_response(bytes, &key, if_none_match);
    }
    let bytes = match render_tile_jpeg(&source.blob_path, level, x, y, TILE_SIZE) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return error_json(404, "tile_not_found"),
        Err(CodecError::Decode) => return error_json(422, "image_decode_failed"),
        Err(CodecError::Encode) => return error_json(422, "tile_encode_failed"),
    };
    let bytes = Arc::new(bytes);
    state.cache.insert_memory(key.clone(), Arc::clone(&bytes));
    tile_response(bytes, &key, if_none_match)
}

fn tile_response(bytes: Arc<Vec<u8>>, key: &str, if_none_match: &str) -> Response {
    binary_response(
        bytes,
        &format!("\"{key}\""),
        if_none_match,
        "public, max-age=31536000, immutable",
        &[(
            "Warning",
            "299 steel-image-service \"legacy tile endpoint; use /internal/v1/preview\""
                .to_string(),
        )],
    )
}
