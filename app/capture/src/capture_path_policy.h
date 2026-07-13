#pragma once

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <string>
#include <vector>

namespace steel_capture {

inline std::string comparable_path_component(const std::filesystem::path& value) {
  std::string text = value.string();
#ifdef _WIN32
  std::transform(text.begin(), text.end(), text.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
#endif
  return text;
}

inline bool canonical_path_is_within(const std::filesystem::path& candidate,
                                     const std::filesystem::path& root) {
  auto candidate_part = candidate.begin();
  auto root_part = root.begin();
  for (; root_part != root.end(); ++root_part, ++candidate_part) {
    if (candidate_part == candidate.end() ||
        comparable_path_component(*candidate_part) !=
            comparable_path_component(*root_part)) {
      return false;
    }
  }
  return true;
}

// Resolve the actual existing target before checking containment. This removes
// lexical `..`, symlink, and junction escapes and returns the resolved path so
// callers do not validate one spelling and open another.
inline bool resolve_allowed_regular_file(
    const std::filesystem::path& candidate,
    const std::vector<std::filesystem::path>& allowed_roots,
    std::filesystem::path& resolved) {
  resolved.clear();
  if (candidate.empty() || allowed_roots.empty()) {
    return false;
  }

  std::error_code error;
  std::filesystem::path canonical_candidate =
      std::filesystem::canonical(candidate, error);
  if (error) {
    return false;
  }
  error.clear();
  if (!std::filesystem::is_regular_file(canonical_candidate, error) || error) {
    return false;
  }

  for (const std::filesystem::path& root : allowed_roots) {
    if (root.empty()) {
      continue;
    }
    error.clear();
    std::filesystem::path canonical_root =
        std::filesystem::weakly_canonical(root, error);
    if (error) {
      continue;
    }
    error.clear();
    if (!std::filesystem::is_directory(canonical_root, error) || error) {
      continue;
    }
    if (canonical_path_is_within(canonical_candidate, canonical_root)) {
      resolved = canonical_candidate;
      return true;
    }
  }
  return false;
}

}  // namespace steel_capture
