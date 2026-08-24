//! Versioned standard-surface contracts shared by plate and cylinder pipelines.
//!
//! These descriptors deliberately keep raw payloads in binary artifacts.  JSON
//! carries dimensions, units, hashes and validity semantics only, preventing
//! control-plane APIs from copying full-material float arrays.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const CALIBRATION_SCHEMA: &str = "steel.calibration.v2";
pub const FRAME_CHUNK_SCHEMA: &str = "steel.frame-chunk.v1";
pub const SURFACE_TILE_SCHEMA: &str = "steel.surface-tile.v1";
pub const SURFACE_MANIFEST_SCHEMA: &str = "steel.surface.tiles.v1";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GeometryProfile {
    Plate,
    Cylinder,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationRef {
    pub revision: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryPlaneRef {
    pub path: String,
    pub scalar_type: String,
    pub byte_order: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameChunkDescriptor {
    pub schema: String,
    pub camera_id: String,
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub depth_c16: BinaryPlaneRef,
    pub intensity_u8: Option<BinaryPlaneRef>,
    pub valid_bits: BinaryPlaneRef,
    pub device_timestamp_ns: Option<u64>,
    pub host_monotonic_ns: u64,
    pub encoder_position: Option<i64>,
    pub calibration: CalibrationRef,
    pub complete: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceTileDescriptor {
    pub schema: String,
    pub tile_id: String,
    pub lod: u8,
    pub u0_mm: f32,
    pub v0_mm: f32,
    pub du_mm: f32,
    pub dv_mm: f32,
    pub rows: u32,
    pub cols: u32,
    pub residual_mm: BinaryPlaneRef,
    pub intensity_u8: Option<BinaryPlaneRef>,
    pub valid_bits: BinaryPlaneRef,
    pub geometric_error_mm: f32,
    pub bounds_mm: [f32; 6],
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceTileManifest {
    pub schema: String,
    pub material_id: String,
    pub geometry: GeometryProfile,
    pub coordinate_unit: String,
    pub calibration: CalibrationRef,
    pub artifact_sha256: String,
    pub bounds_mm: [f32; 6],
    pub tiles: Vec<SurfaceTileDescriptor>,
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_binary_plane(
    plane: &BinaryPlaneRef,
    expected_elements: u64,
    expected_scalar_type: &str,
) -> Result<(), String> {
    if plane.path.trim().is_empty() || !is_sha256(&plane.sha256) {
        return Err("binary plane path/hash is invalid".into());
    }
    if plane.byte_order != "little" || plane.scalar_type != expected_scalar_type {
        return Err("binary plane scalar type/byte order is invalid".into());
    }
    let expected_bytes = match expected_scalar_type {
        "bit" => expected_elements.div_ceil(8),
        "u8" => expected_elements,
        "u16" => expected_elements
            .checked_mul(2)
            .ok_or_else(|| "binary plane size overflow".to_string())?,
        "f32" => expected_elements
            .checked_mul(4)
            .ok_or_else(|| "binary plane size overflow".to_string())?,
        _ => return Err("unsupported binary plane scalar type".into()),
    };
    if plane.size != expected_bytes {
        return Err(format!(
            "binary plane size mismatch: expected {expected_bytes}, found {}",
            plane.size
        ));
    }
    Ok(())
}

fn valid_bounds(bounds: &[f32; 6]) -> bool {
    bounds.iter().all(|value| value.is_finite())
        && bounds[0] <= bounds[3]
        && bounds[1] <= bounds[4]
        && bounds[2] <= bounds[5]
}

impl CalibrationRef {
    pub fn validate(&self) -> Result<(), String> {
        if self.revision.trim().is_empty() || !is_sha256(&self.sha256) {
            return Err("calibration revision/hash is invalid".into());
        }
        Ok(())
    }
}

impl FrameChunkDescriptor {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != FRAME_CHUNK_SCHEMA
            || self.camera_id.trim().is_empty()
            || self.width == 0
            || self.height == 0
            || self.host_monotonic_ns == 0
        {
            return Err("frame chunk schema/dimensions are invalid".into());
        }
        self.calibration.validate()?;
        let elements = u64::from(self.width) * u64::from(self.height);
        validate_binary_plane(&self.depth_c16, elements, "u16")?;
        if let Some(intensity) = &self.intensity_u8 {
            validate_binary_plane(intensity, elements, "u8")?;
        }
        validate_binary_plane(&self.valid_bits, elements, "bit")?;
        if !self.complete {
            return Err("incomplete frame chunks cannot enter reconstruction".into());
        }
        Ok(())
    }
}

impl SurfaceTileDescriptor {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != SURFACE_TILE_SCHEMA
            || self.tile_id.trim().is_empty()
            || self.rows == 0
            || self.cols == 0
            || self.du_mm <= 0.0
            || self.dv_mm <= 0.0
            || !self.u0_mm.is_finite()
            || !self.v0_mm.is_finite()
            || !self.du_mm.is_finite()
            || !self.dv_mm.is_finite()
            || !self.geometric_error_mm.is_finite()
            || self.geometric_error_mm < 0.0
            || !valid_bounds(&self.bounds_mm)
        {
            return Err("surface tile identity/dimensions are invalid".into());
        }
        let elements = u64::from(self.rows) * u64::from(self.cols);
        validate_binary_plane(&self.residual_mm, elements, "f32")?;
        if let Some(intensity) = &self.intensity_u8 {
            validate_binary_plane(intensity, elements, "u8")?;
        }
        validate_binary_plane(&self.valid_bits, elements, "bit")
    }
}

impl SurfaceTileManifest {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != SURFACE_MANIFEST_SCHEMA
            || self.material_id.trim().is_empty()
            || self.coordinate_unit != "mm"
            || !is_sha256(&self.artifact_sha256)
            || !valid_bounds(&self.bounds_mm)
        {
            return Err("surface manifest identity/unit/hash is invalid".into());
        }
        self.calibration.validate()?;
        if self.tiles.is_empty() {
            return Err("surface manifest has no tiles".into());
        }
        let mut tile_ids = HashSet::with_capacity(self.tiles.len());
        for tile in &self.tiles {
            if !tile_ids.insert(tile.tile_id.as_str()) {
                return Err("surface manifest contains duplicate tile ids".into());
            }
            tile.validate()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plane(path: &str, scalar_type: &str, size: u64) -> BinaryPlaneRef {
        BinaryPlaneRef {
            path: path.into(),
            scalar_type: scalar_type.into(),
            byte_order: "little".into(),
            size,
            sha256: "a".repeat(64),
        }
    }

    #[test]
    fn geometry_profile_serializes_as_stable_contract_value() {
        assert_eq!(
            serde_json::to_string(&GeometryProfile::Plate).unwrap(),
            "\"plate\""
        );
        assert_eq!(
            serde_json::from_str::<GeometryProfile>("\"cylinder\"").unwrap(),
            GeometryProfile::Cylinder
        );
    }

    #[test]
    fn validity_mask_is_mandatory_and_bit_packed() {
        let frame = FrameChunkDescriptor {
            schema: FRAME_CHUNK_SCHEMA.into(),
            camera_id: "C1".into(),
            sequence: 1,
            width: 10,
            height: 10,
            depth_c16: plane("depth.raw", "u16", 200),
            intensity_u8: None,
            valid_bits: plane("valid.bin", "bit", 12),
            device_timestamp_ns: None,
            host_monotonic_ns: 1,
            encoder_position: None,
            calibration: CalibrationRef {
                revision: "CAL-1".into(),
                sha256: "b".repeat(64),
            },
            complete: true,
        };
        assert!(frame.validate().is_err());
        assert!(FrameChunkDescriptor {
            valid_bits: plane("valid.bin", "bit", 13),
            ..frame
        }
        .validate()
        .is_ok());
    }
}
