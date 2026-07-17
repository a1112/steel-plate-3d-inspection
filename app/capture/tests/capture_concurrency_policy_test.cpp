#include "capture_concurrency_policy.h"

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
  require(steel_capture::blocking_capture_allowed(false, false),
          "idle real provider must allow a blocking capture");
  require(!steel_capture::blocking_capture_allowed(false, true),
          "real blocking capture must not race production acquisition");
  require(steel_capture::blocking_capture_allowed(true, false),
          "idle simulated provider must allow a blocking capture");
  require(steel_capture::blocking_capture_allowed(true, true),
          "simulated provider may exercise blocking capture fixtures while running");
  return 0;
}
