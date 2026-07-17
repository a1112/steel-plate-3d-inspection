#include "runtime_supervisor_recovery_policy.h"

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
  const std::string restart = R"({
    "ready": false,
    "sdkReady": false,
    "sdkCode": 49007,
    "recoveryRequired": false,
    "invalidManifest": false,
    "sdkCaptureState": { "restartRequired": true }
  })";
  require(steel_runtime::capture_requires_managed_restart(200, restart),
          "49007 restart fence must request managed recovery");
  require(!steel_runtime::capture_requires_managed_restart(503, restart),
          "non-success health response must not trigger a blind restart");
  require(!steel_runtime::capture_requires_managed_restart(
              200,
              R"({"sdkCode":49007,"restartRequired":true,"recoveryRequired":true,"invalidManifest":false})"),
          "calibration reconciliation must not be auto-restarted");
  require(!steel_runtime::capture_requires_managed_restart(
              200,
              R"({"sdkCode":49007,"restartRequired":true,"recoveryRequired":false,"invalidManifest":true})"),
          "invalid rollback manifest must not be auto-restarted");
  require(!steel_runtime::capture_requires_managed_restart(
              200,
              R"({"sdkCode":0,"restartRequired":true,"recoveryRequired":false,"invalidManifest":false})"),
          "restart flag without the 49007 SDK code must not restart the group");

  steel_runtime::ManagedRestartConfirmation confirmation(2);
  require(!confirmation.observe(true),
          "one observation must not restart the runtime group");
  require(confirmation.observe(true),
          "two consecutive observations must confirm managed recovery");
  require(!confirmation.observe(false) && confirmation.observations() == 0,
          "healthy observation must reset restart confirmation");
  require(!confirmation.observe(true),
          "confirmation must restart from zero after reset");
  return 0;
}
