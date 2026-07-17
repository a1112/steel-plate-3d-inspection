#pragma once

namespace steel_capture {

inline bool sdk_health_ready(bool sdk_ready,
                             bool recovery_required,
                             bool restart_required) noexcept {
  return sdk_ready && !recovery_required && !restart_required;
}

inline bool camera_set_ready(int connected_cameras,
                             int expected_cameras) noexcept {
  return expected_cameras > 0 && connected_cameras == expected_cameras;
}

inline bool provider_health_ready(bool effective_sdk_ready,
                                  int connected_cameras,
                                  int expected_cameras) noexcept {
  return effective_sdk_ready &&
         camera_set_ready(connected_cameras, expected_cameras);
}

}  // namespace steel_capture
