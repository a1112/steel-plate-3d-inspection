use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::error::Error;
use std::fmt;

const DEFAULT_TILE_SIZE: u32 = 512;

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
        Self { x, y, width, height }
    }

    pub fn from_edges(left: u32, right: u32, top: u32, bottom: u32) -> Result<Self, WorldError> {
        let width = right.checked_sub(left).ok_or(WorldError::InvalidRectangle)?;
        let height = bottom.checked_sub(top).ok_or(WorldError::InvalidRectangle)?;
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
        let mut camera_ids = HashSet::new();
        let mut offset_x = 0_u32;
        let mut world_height = 0_u32;
        let mut cameras = Vec::with_capacity(specs.len());

        for spec in specs {
            if !camera_ids.insert(spec.camera_id) {
                return Err(WorldError::DuplicateCamera(spec.camera_id));
            }
            if spec.frame_width == 0 || spec.frame_height == 0 || spec.frame_numbers.is_empty() {
                return Err(WorldError::InvalidCameraDimensions(spec.camera_id));
            }
            if spec.orientation != CameraOrientation::identity() {
                return Err(WorldError::UnsupportedOrientation { camera_id: spec.camera_id });
            }
            let height = spec
                .frame_height
                .checked_mul(spec.frame_numbers.len() as u32)
                .ok_or(WorldError::DimensionOverflow)?;
            cameras.push(CameraWorld {
                camera_id: spec.camera_id,
                offset_x,
                width: spec.frame_width,
                height,
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
        while longest_side > DEFAULT_TILE_SIZE {
            longest_side = longest_side.div_ceil(2);
            max_level = max_level.checked_add(1).ok_or(WorldError::DimensionOverflow)?;
        }

        Ok(Self {
            width: offset_x,
            height: world_height,
            tile_size: DEFAULT_TILE_SIZE,
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
            return Err(WorldError::UnknownFrame { camera_id, image_index });
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorldError {
    DimensionOverflow,
    DuplicateCamera(u32),
    InvalidCameraDimensions(u32),
    InvalidRectangle,
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

    fn camera(camera_id: u32, width: u32, frame_height: u32, frame_count: u32) -> CameraSpec {
        CameraSpec {
            camera_id,
            frame_width: width,
            frame_height,
            frame_numbers: (0..frame_count).collect(),
            orientation: CameraOrientation::identity(),
        }
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
        ]).unwrap();

        assert_eq!(world.width, 3_870);
        assert_eq!(world.height, 21_504);
        assert_eq!(world.cameras[5].offset_x, 3_193);
    }

    #[test]
    fn shorter_camera_keeps_offset_and_empty_tail() {
        let world = InspectionWorld::new(vec![
            camera(1, 100, 16, 3),
            camera(2, 80, 16, 1),
        ]).unwrap();

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
        let error = InspectionWorld::new(vec![
            camera(1, 100, 16, 2),
            camera(1, 100, 16, 2),
        ]).unwrap_err();

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
}
