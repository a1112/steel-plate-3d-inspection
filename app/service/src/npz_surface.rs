use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::json;

const SURFACE_ROWS: usize = 128;
const COLS_PER_CAMERA: usize = 32;
const MAX_NPY_BYTES: u64 = 64 * 1024 * 1024;
const INVALID_DEPTH_FLOOR: f32 = -999_999.0;
const DISPLAY_P95_RADIAL_OFFSET: f32 = 0.02;
pub const RECONSTRUCTION_REVISION: &str = "npz-cylinder-column-profile-v4-mm";

pub struct NpzSurface {
    pub binary: Vec<u8>,
    pub parameters: serde_json::Value,
}

struct DepthArray {
    rows: usize,
    columns: usize,
    values: Vec<f32>,
}

struct SampledCamera {
    column_baselines: Vec<f32>,
    samples: Vec<Option<f32>>,
}

fn header_field<'a>(header: &'a str, name: &str) -> Result<&'a str, String> {
    let marker = format!("'{name}':");
    let start = header
        .find(&marker)
        .ok_or_else(|| format!("NPY header is missing {name}"))?
        + marker.len();
    Ok(header[start..].trim_start())
}

fn parse_shape(header: &str) -> Result<(usize, usize), String> {
    let value = header_field(header, "shape")?;
    let open = value
        .find('(')
        .ok_or_else(|| "NPY shape is invalid".to_string())?;
    let close = value[open + 1..]
        .find(')')
        .map(|offset| offset + open + 1)
        .ok_or_else(|| "NPY shape is invalid".to_string())?;
    let dimensions = value[open + 1..close]
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| {
            part.parse::<usize>()
                .map_err(|_| "NPY shape contains an invalid dimension".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if dimensions.len() != 2 || dimensions.iter().any(|dimension| *dimension == 0) {
        return Err("NPY depth array must be a non-empty two-dimensional array".to_string());
    }
    Ok((dimensions[0], dimensions[1]))
}

fn parse_depth_npy(bytes: &[u8]) -> Result<DepthArray, String> {
    if bytes.len() < 10 || &bytes[..6] != b"\x93NUMPY" {
        return Err("NPZ depth member is not an NPY array".to_string());
    }
    let (header_length, header_start) = match (bytes[6], bytes[7]) {
        (1, 0) => (
            usize::from(u16::from_le_bytes([bytes[8], bytes[9]])),
            10usize,
        ),
        (2 | 3, 0) if bytes.len() >= 12 => (
            usize::try_from(u32::from_le_bytes([
                bytes[8], bytes[9], bytes[10], bytes[11],
            ]))
            .map_err(|_| "NPY header is too large".to_string())?,
            12usize,
        ),
        _ => return Err("unsupported NPY version".to_string()),
    };
    let data_start = header_start
        .checked_add(header_length)
        .filter(|offset| *offset <= bytes.len())
        .ok_or_else(|| "NPY header length is invalid".to_string())?;
    let header = std::str::from_utf8(&bytes[header_start..data_start])
        .map_err(|_| "NPY header is not ASCII/UTF-8".to_string())?;
    let descriptor = header_field(header, "descr")?;
    if !(descriptor.starts_with("'<f4'")
        || descriptor.starts_with("\"<f4\"")
        || descriptor.starts_with("'=f4'")
        || descriptor.starts_with("\"=f4\""))
    {
        return Err("NPY depth array must use little-endian float32".to_string());
    }
    if !header_field(header, "fortran_order")?.starts_with("False") {
        return Err("Fortran-order NPY depth arrays are unsupported".to_string());
    }
    let (rows, columns) = parse_shape(header)?;
    let value_count = rows
        .checked_mul(columns)
        .ok_or_else(|| "NPY depth dimensions overflow".to_string())?;
    let byte_count = value_count
        .checked_mul(4)
        .ok_or_else(|| "NPY depth byte count overflow".to_string())?;
    if data_start.checked_add(byte_count) != Some(bytes.len()) {
        return Err("NPY depth payload length does not match its shape".to_string());
    }
    let values = bytes[data_start..]
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();
    Ok(DepthArray {
        rows,
        columns,
        values,
    })
}

fn load_depth(path: &Path) -> Result<DepthArray, String> {
    let file = File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut member = archive
        .by_name("depth.npy")
        .map_err(|error| format!("{} has no depth.npy: {error}", path.display()))?;
    if member.size() > MAX_NPY_BYTES {
        return Err(format!(
            "{} depth.npy exceeds the safety limit",
            path.display()
        ));
    }
    let capacity =
        usize::try_from(member.size()).map_err(|_| "NPY member size is invalid".to_string())?;
    let mut bytes = Vec::with_capacity(capacity);
    member
        .read_to_end(&mut bytes)
        .map_err(|error| format!("{} depth.npy: {error}", path.display()))?;
    parse_depth_npy(&bytes).map_err(|error| format!("{}: {error}", path.display()))
}

fn valid_depth(value: f32) -> bool {
    value.is_finite() && value > INVALID_DEPTH_FLOOR
}

fn median(values: &mut [f32]) -> Option<f32> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f32::total_cmp);
    let middle = values.len() / 2;
    Some(if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) * 0.5
    } else {
        values[middle]
    })
}

fn sample_frame(depth: &DepthArray) -> Vec<Option<f32>> {
    let mut samples = Vec::with_capacity(SURFACE_ROWS * COLS_PER_CAMERA);
    for target_row in 0..SURFACE_ROWS {
        let source_row = target_row * (depth.rows - 1) / (SURFACE_ROWS - 1);
        for target_column in 0..COLS_PER_CAMERA {
            let source_column = target_column * (depth.columns - 1) / (COLS_PER_CAMERA - 1);
            let value = depth.values[source_row * depth.columns + source_column];
            samples.push(valid_depth(value).then_some(value));
        }
    }
    samples
}

fn push_f32(output: &mut Vec<u8>, values: &[f32]) {
    for value in values {
        output.extend_from_slice(&value.to_le_bytes());
    }
}

fn display_scaling(sampled_cameras: &[SampledCamera]) -> (f32, f32) {
    let mut residuals = sampled_cameras
        .iter()
        .flat_map(|camera| {
            camera
                .samples
                .iter()
                .enumerate()
                .filter_map(move |(index, sample)| {
                    sample.map(|value| {
                        (value - camera.column_baselines[index % COLS_PER_CAMERA]).abs()
                    })
                })
        })
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    residuals.sort_by(f32::total_cmp);
    let robust_residual = residuals
        .get((residuals.len().saturating_sub(1) * 95) / 100)
        .copied()
        .unwrap_or(1.0)
        .max(f32::EPSILON);
    (robust_residual, DISPLAY_P95_RADIAL_OFFSET / robust_residual)
}

fn encode_surface(
    sampled_cameras: &[SampledCamera],
    robust_residual: f32,
    nominal_radius_mm: f32,
    length_mm: f32,
) -> Result<Vec<u8>, String> {
    let camera_count = sampled_cameras.len();
    let angular_columns = camera_count
        .checked_mul(COLS_PER_CAMERA)
        .ok_or_else(|| "NPZ surface column count overflow".to_string())?;
    let vertex_count = SURFACE_ROWS
        .checked_mul(angular_columns)
        .ok_or_else(|| "NPZ surface vertex count overflow".to_string())?;
    let mut positions = Vec::with_capacity(vertex_count * 3);
    let mut uvs = Vec::with_capacity(vertex_count * 2);
    let mut colors = Vec::with_capacity(vertex_count * 3);
    let mut valid_mask = Vec::with_capacity(vertex_count);

    for row in 0..SURFACE_ROWS {
        let longitudinal = row as f32 / (SURFACE_ROWS - 1) as f32;
        for angular_column in 0..angular_columns {
            let camera_index = angular_column / COLS_PER_CAMERA;
            let camera_column = angular_column % COLS_PER_CAMERA;
            let camera = &sampled_cameras[camera_index];
            let sample = camera.samples[row * COLS_PER_CAMERA + camera_column];
            let residual = sample
                .map(|value| value - camera.column_baselines[camera_column])
                .unwrap_or_default();
            // The NPZ depth values are millimetres. Keep the mesh normalized by the nominal
            // radius for stable WebGL rendering while preserving the physical aspect ratio and
            // the exact millimetre residual in the normalized radius.
            let radius = ((nominal_radius_mm + residual) / nominal_radius_mm).clamp(0.1, 2.0);
            let angle = std::f32::consts::TAU * angular_column as f32 / angular_columns as f32;
            positions.extend_from_slice(&[
                (longitudinal - 0.5) * (length_mm / nominal_radius_mm),
                radius * angle.cos(),
                radius * angle.sin(),
            ]);
            uvs.extend_from_slice(&[longitudinal, angular_column as f32 / angular_columns as f32]);
            if sample.is_some() {
                let tone = (residual / robust_residual).clamp(-1.0, 1.0);
                if tone >= 0.0 {
                    colors.extend_from_slice(&[
                        0.45 + tone * 0.50,
                        0.68 - tone * 0.30,
                        0.72 - tone * 0.45,
                    ]);
                } else {
                    let magnitude = -tone;
                    colors.extend_from_slice(&[
                        0.45 - magnitude * 0.28,
                        0.68 + magnitude * 0.18,
                        0.72 + magnitude * 0.25,
                    ]);
                }
                valid_mask.push(1u8);
            } else {
                colors.extend_from_slice(&[0.03, 0.06, 0.08]);
                valid_mask.push(0u8);
            }
        }
    }

    let mut indices = Vec::new();
    for row in 0..SURFACE_ROWS - 1 {
        for column in 0..angular_columns {
            let next_column = (column + 1) % angular_columns;
            let a = row * angular_columns + column;
            let b = row * angular_columns + next_column;
            let c = (row + 1) * angular_columns + column;
            let d = (row + 1) * angular_columns + next_column;
            // Keep the normalized display cylinder topologically closed. Vertices without an
            // observed depth sample stay on the nominal radius and remain explicitly identified
            // by valid_mask=0 and their dark display color.
            for index in [a, c, b, b, c, d] {
                indices
                    .push(u32::try_from(index).map_err(|_| "NPZ mesh index overflow".to_string())?);
            }
        }
    }

    let vertex_count_u32 = u32::try_from(vertex_count)
        .map_err(|_| "NPZ surface vertex count is out of range".to_string())?;
    let index_count_u32 = u32::try_from(indices.len())
        .map_err(|_| "NPZ surface index count is out of range".to_string())?;
    let mut output = Vec::with_capacity(
        40 + positions.len() * 4
            + uvs.len() * 4
            + colors.len() * 4
            + indices.len() * 4
            + valid_mask.len() * 2,
    );
    output.extend_from_slice(b"BSMESH01");
    for value in [
        1u32,
        vertex_count_u32,
        index_count_u32,
        0x02 | 0x04,
        SURFACE_ROWS as u32,
        COLS_PER_CAMERA as u32,
        camera_count as u32,
        0,
    ] {
        output.extend_from_slice(&value.to_le_bytes());
    }
    push_f32(&mut output, &positions);
    push_f32(&mut output, &uvs);
    push_f32(&mut output, &colors);
    for index in indices {
        output.extend_from_slice(&index.to_le_bytes());
    }
    output.extend_from_slice(&valid_mask);
    output.resize(output.len() + vertex_count, 0);
    Ok(output)
}

pub fn build_npz_surface(
    record_id: &str,
    captures: &[(u32, u32, PathBuf)],
    nominal_diameter_mm: f32,
    length_mm: f32,
) -> Result<NpzSurface, String> {
    if !nominal_diameter_mm.is_finite() || nominal_diameter_mm <= 0.0 {
        return Err(
            "NPZ reconstruction requires a positive nominal diameter in millimetres".to_string(),
        );
    }
    if !length_mm.is_finite() || length_mm <= 0.0 {
        return Err(
            "NPZ reconstruction requires a positive steel length in millimetres".to_string(),
        );
    }
    let nominal_radius_mm = nominal_diameter_mm * 0.5;
    let mut grouped = BTreeMap::<u32, Vec<(u32, &Path)>>::new();
    for (camera_id, sequence_no, path) in captures {
        grouped
            .entry(*camera_id)
            .or_default()
            .push((*sequence_no, path.as_path()));
    }
    if grouped.is_empty() {
        return Err("converted record has no NPZ depth captures".to_string());
    }
    let mut sampled_cameras = Vec::with_capacity(grouped.len());
    let mut camera_parameters = Vec::with_capacity(grouped.len());
    for (camera_id, frames) in &mut grouped {
        frames.sort_by_key(|(sequence_no, _)| *sequence_no);
        if frames.is_empty() {
            return Err(format!("camera {camera_id} has no NPZ depth frames"));
        }
        let mut frame_samples = Vec::with_capacity(frames.len());
        let mut dimensions = None;
        for (_, path) in frames.iter() {
            let depth = load_depth(path)?;
            let current = (depth.rows, depth.columns);
            if dimensions
                .replace(current)
                .is_some_and(|value| value != current)
            {
                return Err(format!(
                    "camera {camera_id} NPZ depth dimensions are inconsistent"
                ));
            }
            frame_samples.push(sample_frame(&depth));
        }
        let combined_rows = frame_samples
            .len()
            .checked_mul(SURFACE_ROWS)
            .ok_or_else(|| "NPZ combined row count overflow".to_string())?;
        let mut samples = Vec::with_capacity(SURFACE_ROWS * COLS_PER_CAMERA);
        for target_row in 0..SURFACE_ROWS {
            let combined_row = target_row * (combined_rows - 1) / (SURFACE_ROWS - 1);
            let frame_index = combined_row / SURFACE_ROWS;
            let frame_row = combined_row % SURFACE_ROWS;
            let start = frame_row * COLS_PER_CAMERA;
            samples.extend_from_slice(&frame_samples[frame_index][start..start + COLS_PER_CAMERA]);
        }
        let mut valid_values = samples.iter().flatten().copied().collect::<Vec<_>>();
        let baseline = median(&mut valid_values)
            .ok_or_else(|| format!("camera {camera_id} NPZ depth has no valid samples"))?;
        let column_baselines = (0..COLS_PER_CAMERA)
            .map(|column| {
                let mut column_values = (0..SURFACE_ROWS)
                    .filter_map(|row| samples[row * COLS_PER_CAMERA + column])
                    .collect::<Vec<_>>();
                median(&mut column_values).unwrap_or(baseline)
            })
            .collect::<Vec<_>>();
        let (source_rows, source_columns) =
            dimensions.ok_or_else(|| format!("camera {camera_id} NPZ dimensions unavailable"))?;
        camera_parameters.push(json!({
            "cameraId": camera_id,
            "frameCount": frames.len(),
            "firstSequence": frames.first().map(|(sequence, _)| sequence),
            "lastSequence": frames.last().map(|(sequence, _)| sequence),
            "sourceRows": source_rows,
            "sourceColumns": source_columns,
            "baseline": baseline,
            "columnBaselineMinimum": column_baselines.iter().copied().reduce(f32::min),
            "columnBaselineMaximum": column_baselines.iter().copied().reduce(f32::max),
            "normalization": "per-column-valid-sample-median",
        }));
        sampled_cameras.push(SampledCamera {
            column_baselines,
            samples,
        });
    }
    let (robust_residual, _) = display_scaling(&sampled_cameras);
    let radial_scale = 1.0 / nominal_radius_mm;
    let binary = encode_surface(
        &sampled_cameras,
        robust_residual,
        nominal_radius_mm,
        length_mm,
    )?;
    let vertex_count = SURFACE_ROWS * COLS_PER_CAMERA * sampled_cameras.len();
    let index_count = u32::from_le_bytes(
        binary[16..20]
            .try_into()
            .map_err(|_| "NPZ surface index header is invalid".to_string())?,
    );
    let valid_point_count = sampled_cameras
        .iter()
        .flat_map(|camera| &camera.samples)
        .filter(|sample| sample.is_some())
        .count();
    let binary_bytes = binary.len();
    Ok(NpzSurface {
        binary,
        parameters: json!({
            "schema": "steel.bkv-depth-reconstruction-parameters.v1",
            "recordId": record_id,
            "algorithmRevision": RECONSTRUCTION_REVISION,
            "input": {
                "format": "NPZ",
                "depthArray": "depth.npy",
                "depthType": "little-endian-float32",
                "sourceFrameCount": captures.len(),
                "invalidDepthFloor": INVALID_DEPTH_FLOOR,
            },
            "sampling": {
                "rows": SURFACE_ROWS,
                "colsPerCamera": COLS_PER_CAMERA,
                "cameraCount": sampled_cameras.len(),
                "frameSelection": "all-frames",
                "rowSelection": "evenly-spaced-across-ordered-frames",
                "columnSelection": "evenly-spaced",
            },
            "reconstruction": {
                "geometry": "closed-cylinder",
                "longitudinalExtent": length_mm,
                "nominalRadius": nominal_radius_mm,
                "nominalDiameter": nominal_diameter_mm,
                "maximumRadialOffset": robust_residual,
                "cameraNormalization": "per-column-valid-sample-median",
                "coordinateUnit": "millimeter",
                "calibrated": true,
            },
            "display": {
                "mode": "millimeter-residual-normalized-by-nominal-radius",
                "p95RadialOffset": DISPLAY_P95_RADIAL_OFFSET,
                "robustResidualP95": robust_residual,
                "radialScale": radial_scale,
                "unit": "millimeter",
            },
            "output": {
                "format": "BSMESH01",
                "vertexCount": vertex_count,
                "validPointCount": valid_point_count,
                "imputedPointCount": vertex_count - valid_point_count,
                "indexCount": index_count,
                "triangleCount": index_count / 3,
                "binaryBytes": binary_bytes,
                "topology": "closed-with-nominal-invalid-fill",
            },
            "cameras": camera_parameters,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn npy_depth(rows: usize, columns: usize, values: &[f32]) -> Vec<u8> {
        let mut header =
            format!("{{'descr': '<f4', 'fortran_order': False, 'shape': ({rows}, {columns}), }}");
        let padding = (16 - ((10 + header.len() + 1) % 16)) % 16;
        header.push_str(&" ".repeat(padding));
        header.push('\n');
        let mut bytes = b"\x93NUMPY\x01\x00".to_vec();
        bytes.extend_from_slice(&(header.len() as u16).to_le_bytes());
        bytes.extend_from_slice(header.as_bytes());
        for value in values {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn parses_little_endian_float32_depth() {
        let parsed =
            parse_depth_npy(&npy_depth(2, 3, &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0])).expect("valid NPY");
        assert_eq!((parsed.rows, parsed.columns), (2, 3));
        assert_eq!(parsed.values, vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
    }

    #[test]
    fn surface_binary_uses_bsmesh_contract() {
        let samples = vec![Some(1.0); SURFACE_ROWS * COLS_PER_CAMERA];
        let binary = encode_surface(
            &[SampledCamera {
                column_baselines: vec![1.0; COLS_PER_CAMERA],
                samples,
            }],
            1.0,
            350.0,
            12_000.0,
        )
        .expect("surface");
        assert_eq!(&binary[..8], b"BSMESH01");
        assert_eq!(u32::from_le_bytes(binary[12..16].try_into().unwrap()), 4096);
        assert_eq!(
            u32::from_le_bytes(binary[24..28].try_into().unwrap()),
            SURFACE_ROWS as u32
        );
    }

    #[test]
    fn per_column_baselines_remove_nominal_camera_profile() {
        let column_baselines = (0..COLS_PER_CAMERA)
            .map(|column| 100.0 + column as f32 * column as f32)
            .collect::<Vec<_>>();
        let samples = (0..SURFACE_ROWS)
            .flat_map(|_| column_baselines.iter().copied().map(Some))
            .collect::<Vec<_>>();
        let camera = SampledCamera {
            column_baselines,
            samples,
        };

        let (robust_residual, display_scale) = display_scaling(&[camera]);

        assert_eq!(robust_residual, f32::EPSILON);
        assert!(display_scale.is_finite());
    }
}
