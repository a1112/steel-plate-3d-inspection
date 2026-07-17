#pragma once

namespace steel_capture {

inline bool blocking_capture_allowed(bool simulated,
                                     bool production_capture_running) noexcept {
  return simulated || !production_capture_running;
}

}  // namespace steel_capture
