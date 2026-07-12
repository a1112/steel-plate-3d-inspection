#pragma once

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <sstream>
#include <string>

namespace steel_capture {

enum class CalibrationArtifactKind {
  Missing,
  NotRegularFile,
  NotXml,
  ArrayReconstruction,
  CameraSdkCandidate,
};

inline std::string calibration_artifact_kind_text(CalibrationArtifactKind kind) {
  switch (kind) {
    case CalibrationArtifactKind::Missing:
      return "missing";
    case CalibrationArtifactKind::NotRegularFile:
      return "not-regular-file";
    case CalibrationArtifactKind::NotXml:
      return "not-xml";
    case CalibrationArtifactKind::ArrayReconstruction:
      return "array-reconstruction";
    case CalibrationArtifactKind::CameraSdkCandidate:
      return "camera-sdk-candidate";
  }
  return "unknown";
}

inline CalibrationArtifactKind classify_calibration_artifact(
    const std::filesystem::path& path) {
  std::error_code error;
  if (!std::filesystem::exists(path, error) || error) {
    return CalibrationArtifactKind::Missing;
  }
  error.clear();
  if (!std::filesystem::is_regular_file(path, error) || error) {
    return CalibrationArtifactKind::NotRegularFile;
  }
  std::string extension = path.extension().string();
  std::transform(extension.begin(), extension.end(), extension.begin(),
                 [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
  if (extension != ".xml") {
    return CalibrationArtifactKind::NotXml;
  }

  std::string filename = path.filename().string();
  std::transform(filename.begin(), filename.end(), filename.begin(),
                 [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
  if (filename.find("arraycalibration") != std::string::npos ||
      filename.find("array_calibration") != std::string::npos ||
      filename.find("array-calibration") != std::string::npos) {
    return CalibrationArtifactKind::ArrayReconstruction;
  }

  std::ifstream input(path, std::ios::binary);
  if (!input) {
    return CalibrationArtifactKind::NotXml;
  }
  std::string prefix(4 * 1024 * 1024, '\0');
  input.read(&prefix[0], static_cast<std::streamsize>(prefix.size()));
  prefix.resize(static_cast<std::size_t>(input.gcount()));
  if (prefix.empty()) {
    return CalibrationArtifactKind::NotXml;
  }
  std::transform(prefix.begin(), prefix.end(), prefix.begin(),
                 [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
  std::string normalized;
  normalized.reserve(prefix.size());
  std::copy_if(prefix.begin(), prefix.end(), std::back_inserter(normalized),
               [](char ch) { return ch != '\0'; });
  if (normalized.find('<') == std::string::npos ||
      normalized.find('>') == std::string::npos) {
    return CalibrationArtifactKind::NotXml;
  }
  if (normalized.find("<arraycalib-parameter") != std::string::npos ||
      normalized.find("<arraycalibration") != std::string::npos ||
      (normalized.find("<sn_") != std::string::npos &&
       normalized.find("<matrix0>") != std::string::npos &&
       normalized.find("<blendmethod>") != std::string::npos)) {
    return CalibrationArtifactKind::ArrayReconstruction;
  }
  return CalibrationArtifactKind::CameraSdkCandidate;
}

inline bool is_array_reconstruction_artifact(CalibrationArtifactKind kind) {
  return kind == CalibrationArtifactKind::ArrayReconstruction;
}

inline bool is_camera_sdk_candidate(CalibrationArtifactKind kind) {
  return kind == CalibrationArtifactKind::CameraSdkCandidate;
}

}  // namespace steel_capture
