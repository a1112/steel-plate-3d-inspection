#include "calibration_contract.h"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {

void require(bool condition, const std::string& message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

void write_file(const std::filesystem::path& path, const std::string& body) {
  std::filesystem::create_directories(path.parent_path());
  std::ofstream output(path, std::ios::binary | std::ios::trunc);
  output << body;
  if (!output) {
    throw std::runtime_error("cannot write calibration contract test file");
  }
}

void artifact_kinds_are_separated() {
  const auto unique = std::chrono::steady_clock::now().time_since_epoch().count();
  const std::filesystem::path root =
      std::filesystem::temp_directory_path() /
      ("steel-calibration-contract-" + std::to_string(unique));
  const std::filesystem::path array_named = root / "ArrayCalibration.corrected.xml";
  const std::filesystem::path array_content = root / "version.xml";
  const std::filesystem::path camera_sdk = root / "camera-01.xml";
  const std::filesystem::path empty_xml = root / "empty.xml";
  const std::filesystem::path utf16_array = root / "renamed-utf16.xml";
  const std::filesystem::path long_prefix_array = root / "renamed-long-prefix.xml";
  const std::filesystem::path not_xml = root / "camera-01.json";
  write_file(array_named, "<anything/>");
  write_file(array_content,
             "<ArrayCalib-parameter><SN_TEST><CalibParam><Matrix0>1,0,0,0</Matrix0>"
             "<BlendMethod>0</BlendMethod></CalibParam></SN_TEST></ArrayCalib-parameter>");
  write_file(camera_sdk,
             "<CameraCalibration><Dir X=\"1\"/><WorldRotation/></CameraCalibration>");
  write_file(empty_xml, "");
  std::string utf16_text;
  for (const char ch : std::string("<ArrayCalibration><SN_1/></ArrayCalibration>")) {
    utf16_text.push_back(ch);
    utf16_text.push_back('\0');
  }
  write_file(utf16_array, utf16_text);
  write_file(long_prefix_array,
             std::string(200 * 1024, ' ') +
                 "<ArrayCalib-parameter><SN_1><Matrix0>1</Matrix0>"
                 "<BlendMethod>0</BlendMethod></SN_1></ArrayCalib-parameter>");
  write_file(not_xml, "{}");

  using steel_capture::CalibrationArtifactKind;
  require(steel_capture::classify_calibration_artifact(array_named) ==
              CalibrationArtifactKind::ArrayReconstruction,
          "ArrayCalibration filename must be treated as reconstruction-only");
  require(steel_capture::classify_calibration_artifact(array_content) ==
              CalibrationArtifactKind::ArrayReconstruction,
          "array reconstruction XML root must be detected independent of filename");
  require(steel_capture::classify_calibration_artifact(camera_sdk) ==
              CalibrationArtifactKind::CameraSdkCandidate,
          "non-array XML should remain a per-camera SDK candidate");
  require(steel_capture::classify_calibration_artifact(empty_xml) ==
              CalibrationArtifactKind::NotXml,
          "empty XML must not be accepted as a camera SDK candidate");
  require(steel_capture::classify_calibration_artifact(utf16_array) ==
              CalibrationArtifactKind::ArrayReconstruction,
          "UTF-16 array XML must not bypass the reconstruction classifier");
  require(steel_capture::classify_calibration_artifact(long_prefix_array) ==
              CalibrationArtifactKind::ArrayReconstruction,
          "array XML after the old 128 KiB scan boundary must be rejected");
  require(steel_capture::classify_calibration_artifact(not_xml) ==
              CalibrationArtifactKind::NotXml,
          "non-XML calibration artifact must be rejected");
  require(steel_capture::classify_calibration_artifact(root / "missing.xml") ==
              CalibrationArtifactKind::Missing,
          "missing calibration artifact must be reported explicitly");

  std::error_code error;
  std::filesystem::remove_all(root, error);
}

}  // namespace

int main() {
  try {
    artifact_kinds_are_separated();
    std::cout << "calibration_contract_test passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "calibration_contract_test failed: " << error.what() << "\n";
    return 1;
  }
}
