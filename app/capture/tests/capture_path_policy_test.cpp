#include "capture_path_policy.h"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

void require(bool condition, const std::string& message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

void write_file(const std::filesystem::path& path, const std::string& value) {
  std::filesystem::create_directories(path.parent_path());
  std::ofstream output(path, std::ios::binary | std::ios::trunc);
  output << value;
  if (!output) {
    throw std::runtime_error("test file cannot be written");
  }
}

void file_read_boundary_uses_resolved_roots() {
  const auto unique = std::chrono::steady_clock::now().time_since_epoch().count();
  const std::filesystem::path sandbox =
      std::filesystem::temp_directory_path() /
      ("steel-capture-path-policy-" + std::to_string(unique));
  const std::filesystem::path storage = sandbox / "storage";
  const std::filesystem::path camera = sandbox / "camera-root";
  const std::filesystem::path outside = sandbox / "outside";
  const std::filesystem::path storage_file = storage / "depth" / "inside.png";
  const std::filesystem::path camera_file = camera / "depth" / "camera.png";
  const std::filesystem::path secret = outside / "secret.txt";
  write_file(storage_file, "inside");
  write_file(camera_file, "camera");
  write_file(secret, "secret");
  std::filesystem::create_directories(storage / "directory-only");

  const std::vector<std::filesystem::path> roots{storage, camera};
  std::filesystem::path resolved;
  require(steel_capture::resolve_allowed_regular_file(storage_file, roots, resolved),
          "regular file under storage root should be allowed");
  require(resolved == std::filesystem::canonical(storage_file),
          "policy should return the canonical file path");
  require(steel_capture::resolve_allowed_regular_file(camera_file, roots, resolved),
          "regular file under configured camera root should be allowed");
  require(!steel_capture::resolve_allowed_regular_file(secret, roots, resolved),
          "file outside every configured root must be denied");
  require(!steel_capture::resolve_allowed_regular_file(
              storage / ".." / "outside" / "secret.txt", roots, resolved),
          "lexical parent traversal must be denied after canonicalization");
  require(!steel_capture::resolve_allowed_regular_file(
              sandbox / "storage-sibling" / "inside.png", roots, resolved),
          "sibling path with a shared string prefix must be denied");
  require(!steel_capture::resolve_allowed_regular_file(
              storage / "directory-only", roots, resolved),
          "non-regular targets must be denied");
  require(!steel_capture::resolve_allowed_regular_file(
              storage / "missing.png", roots, resolved),
          "missing targets must be denied");

  const std::filesystem::path previous_cwd = std::filesystem::current_path();
  std::filesystem::current_path(outside);
  const bool cwd_allowed =
      steel_capture::resolve_allowed_regular_file("secret.txt", roots, resolved);
  std::filesystem::current_path(previous_cwd);
  require(!cwd_allowed,
          "current working directory must not be an implicit read root");

  std::error_code link_error;
  const std::filesystem::path escape_link = storage / "escape-link";
  std::filesystem::create_directory_symlink(outside, escape_link, link_error);
  if (!link_error) {
    require(!steel_capture::resolve_allowed_regular_file(
                escape_link / "secret.txt", roots, resolved),
            "symlink or junction target outside the storage root must be denied");
  }

  std::error_code remove_error;
  std::filesystem::remove_all(sandbox, remove_error);
}

}  // namespace

int main() {
  try {
    file_read_boundary_uses_resolved_roots();
    std::cout << "capture_path_policy_test passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "capture_path_policy_test failed: " << error.what() << "\n";
    return 1;
  }
}
