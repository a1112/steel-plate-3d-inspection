#include "capture_health_policy.h"

#include <cstdlib>
#include <iostream>

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}

}  // namespace

int main() {
  require(steel_capture::sdk_health_ready(true, false, false),
          "healthy SDK must be ready");
  require(!steel_capture::sdk_health_ready(false, false, false),
          "uninitialized SDK must not be ready");
  require(!steel_capture::sdk_health_ready(true, true, false),
          "calibration recovery must close readiness");
  require(!steel_capture::sdk_health_ready(true, false, true),
          "hard-timeout restart requirement must close readiness");
  require(!steel_capture::sdk_health_ready(true, true, true),
          "combined recovery conditions must close readiness");
  require(steel_capture::camera_set_ready(8, 8),
          "exact expected camera set must be ready");
  require(!steel_capture::camera_set_ready(7, 8),
          "partial camera set must not be ready");
  require(!steel_capture::camera_set_ready(9, 8),
          "unexpected extra camera must not be ready");
  require(!steel_capture::camera_set_ready(0, 0),
          "zero expected cameras must not form a ready production set");
  require(steel_capture::provider_health_ready(true, 8, 8),
          "healthy SDK plus exact camera set must be provider-ready");
  require(!steel_capture::provider_health_ready(true, 7, 8),
          "healthy SDK must not hide a partial camera set");
  return 0;
}
