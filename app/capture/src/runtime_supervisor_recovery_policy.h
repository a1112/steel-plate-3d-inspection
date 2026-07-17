#pragma once

#include <cctype>
#include <optional>
#include <string>

namespace steel_runtime {

inline std::optional<bool> json_boolean_field(const std::string& json,
                                              const std::string& field) {
  const std::string key = "\"" + field + "\"";
  const std::size_t key_offset = json.find(key);
  if (key_offset == std::string::npos) return std::nullopt;
  const std::size_t colon = json.find(':', key_offset + key.size());
  if (colon == std::string::npos) return std::nullopt;
  std::size_t value = colon + 1;
  while (value < json.size() &&
         std::isspace(static_cast<unsigned char>(json[value]))) {
    ++value;
  }
  if (json.compare(value, 4, "true") == 0) return true;
  if (json.compare(value, 5, "false") == 0) return false;
  return std::nullopt;
}

inline std::optional<int> json_integer_field(const std::string& json,
                                             const std::string& field) {
  const std::string key = "\"" + field + "\"";
  const std::size_t key_offset = json.find(key);
  if (key_offset == std::string::npos) return std::nullopt;
  const std::size_t colon = json.find(':', key_offset + key.size());
  if (colon == std::string::npos) return std::nullopt;
  std::size_t value = colon + 1;
  while (value < json.size() &&
         std::isspace(static_cast<unsigned char>(json[value]))) {
    ++value;
  }
  bool negative = false;
  if (value < json.size() && json[value] == '-') {
    negative = true;
    ++value;
  }
  if (value >= json.size() ||
      !std::isdigit(static_cast<unsigned char>(json[value]))) {
    return std::nullopt;
  }
  int result = 0;
  while (value < json.size() &&
         std::isdigit(static_cast<unsigned char>(json[value]))) {
    result = result * 10 + (json[value] - '0');
    ++value;
  }
  return negative ? -result : result;
}

inline bool capture_requires_managed_restart(int http_status,
                                             const std::string& health_body) {
  if (http_status != 200) return false;
  const bool restart_required =
      json_boolean_field(health_body, "restartRequired").value_or(false);
  const bool recovery_required =
      json_boolean_field(health_body, "recoveryRequired").value_or(true);
  const bool invalid_manifest =
      json_boolean_field(health_body, "invalidManifest").value_or(true);
  const int sdk_code = json_integer_field(health_body, "sdkCode").value_or(0);
  return restart_required && sdk_code == 49007 && !recovery_required &&
         !invalid_manifest;
}

class ManagedRestartConfirmation {
 public:
  explicit ManagedRestartConfirmation(int required_observations) noexcept
      : required_observations_(required_observations > 0
                                   ? required_observations
                                   : 1) {}

  bool observe(bool restart_required) noexcept {
    if (!restart_required) {
      observations_ = 0;
      return false;
    }
    ++observations_;
    return observations_ >= required_observations_;
  }

  int observations() const noexcept { return observations_; }

 private:
  int required_observations_ = 1;
  int observations_ = 0;
};

}  // namespace steel_runtime
