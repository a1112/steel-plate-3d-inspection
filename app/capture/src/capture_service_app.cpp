#include <winsock2.h>
#include <ws2tcpip.h>
#include <http.h>
#include <windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "capture_service_app.h"
#include "lvm_sdk.h"

#pragma comment(lib, "httpapi.lib")
#pragma comment(lib, "ws2_32.lib")

namespace {

std::atomic<bool> g_running{true};

std::string now_iso() {
  SYSTEMTIME time{};
  GetLocalTime(&time);
  char buffer[64]{};
  snprintf(buffer, sizeof(buffer), "%04u-%02u-%02uT%02u:%02u:%02u.%03u",
           time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute,
           time.wSecond, time.wMilliseconds);
  return buffer;
}

std::string json_escape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (unsigned char ch : value) {
    switch (ch) {
      case '\\': out += "\\\\"; break;
      case '"': out += "\\\""; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (ch < 0x20) {
          char buffer[8]{};
          snprintf(buffer, sizeof(buffer), "\\u%04x", ch);
          out += buffer;
        } else {
          out.push_back(static_cast<char>(ch));
        }
    }
  }
  return out;
}

std::string json_pair(const std::string& key, const std::string& value) {
  return "\"" + json_escape(key) + "\":\"" + json_escape(value) + "\"";
}

std::string json_error(int code, const std::string& message) {
  return "{\"code\":" + std::to_string(code) + "," + json_pair("error", message) + "}";
}

std::string trim(std::string value) {
  value.erase(value.begin(), std::find_if(value.begin(), value.end(), [](unsigned char ch) { return !std::isspace(ch); }));
  value.erase(std::find_if(value.rbegin(), value.rend(), [](unsigned char ch) { return !std::isspace(ch); }).base(), value.end());
  return value;
}

std::string url_decode(const std::string& value) {
  std::string out;
  out.reserve(value.size());
  for (size_t i = 0; i < value.size(); ++i) {
    if (value[i] == '%' && i + 2 < value.size()) {
      char hex[3] = {value[i + 1], value[i + 2], 0};
      char* end = nullptr;
      long decoded = strtol(hex, &end, 16);
      if (end && *end == '\0') {
        out.push_back(static_cast<char>(decoded));
        i += 2;
        continue;
      }
    }
    out.push_back(value[i] == '+' ? ' ' : value[i]);
  }
  return out;
}

std::string url_encode(const std::string& value) {
  static const char* hex = "0123456789ABCDEF";
  std::string out;
  out.reserve(value.size() * 3);
  for (unsigned char ch : value) {
    if (std::isalnum(ch) || ch == '-' || ch == '_' || ch == '.' || ch == '~' || ch == '/' || ch == ':') {
      out.push_back(static_cast<char>(ch));
    } else {
      out.push_back('%');
      out.push_back(hex[(ch >> 4) & 0x0F]);
      out.push_back(hex[ch & 0x0F]);
    }
  }
  return out;
}

std::string get_query_param(const std::string& query, const std::string& key) {
  std::string needle = key + "=";
  size_t pos = query.find(needle);
  if (pos == std::string::npos) {
    return "";
  }
  pos += needle.size();
  size_t end = query.find('&', pos);
  return url_decode(query.substr(pos, end == std::string::npos ? std::string::npos : end - pos));
}

std::string json_string_field(const std::string& body, const std::string& key, const std::string& fallback = "") {
  std::string needle = "\"" + key + "\"";
  size_t key_pos = body.find(needle);
  if (key_pos == std::string::npos) {
    return fallback;
  }
  size_t colon = body.find(':', key_pos + needle.size());
  size_t quote = body.find('"', colon == std::string::npos ? key_pos : colon);
  if (quote == std::string::npos) {
    return fallback;
  }
  std::string out;
  for (size_t i = quote + 1; i < body.size(); ++i) {
    char ch = body[i];
    if (ch == '"') {
      return out;
    }
    if (ch == '\\' && i + 1 < body.size()) {
      char escaped = body[++i];
      switch (escaped) {
        case '\\': out.push_back('\\'); break;
        case '"': out.push_back('"'); break;
        case '/': out.push_back('/'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        default: out.push_back(escaped); break;
      }
      continue;
    }
    out.push_back(ch);
  }
  return fallback;
}

int json_int_field(const std::string& body, const std::string& key, int fallback) {
  std::string needle = "\"" + key + "\"";
  size_t key_pos = body.find(needle);
  if (key_pos == std::string::npos) {
    return fallback;
  }
  size_t colon = body.find(':', key_pos + needle.size());
  if (colon == std::string::npos) {
    return fallback;
  }
  size_t end = body.find_first_of(",}", colon + 1);
  std::string raw = trim(body.substr(colon + 1, end == std::string::npos ? std::string::npos : end - colon - 1));
  try {
    return std::stoi(raw);
  } catch (...) {
    return fallback;
  }
}

float json_float_field(const std::string& body, const std::string& key, float fallback) {
  std::string needle = "\"" + key + "\"";
  size_t key_pos = body.find(needle);
  if (key_pos == std::string::npos) {
    return fallback;
  }
  size_t colon = body.find(':', key_pos + needle.size());
  if (colon == std::string::npos) {
    return fallback;
  }
  size_t end = body.find_first_of(",}", colon + 1);
  std::string raw = trim(body.substr(colon + 1, end == std::string::npos ? std::string::npos : end - colon - 1));
  try {
    return std::stof(raw);
  } catch (...) {
    return fallback;
  }
}

bool json_bool_field(const std::string& body, const std::string& key, bool fallback) {
  std::string needle = "\"" + key + "\"";
  size_t key_pos = body.find(needle);
  if (key_pos == std::string::npos) {
    return fallback;
  }
  size_t colon = body.find(':', key_pos + needle.size());
  if (colon == std::string::npos) {
    return fallback;
  }
  size_t end = body.find_first_of(",}", colon + 1);
  std::string raw = trim(body.substr(colon + 1, end == std::string::npos ? std::string::npos : end - colon - 1));
  std::transform(raw.begin(), raw.end(), raw.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
  if (raw == "true" || raw == "1") {
    return true;
  }
  if (raw == "false" || raw == "0") {
    return false;
  }
  return fallback;
}

bool json_has_field(const std::string& body, const std::string& key) {
  return body.find("\"" + key + "\"") != std::string::npos;
}

std::vector<std::string> json_string_array_field(const std::string& body, const std::string& key) {
  std::vector<std::string> values;
  std::string needle = "\"" + key + "\"";
  size_t key_pos = body.find(needle);
  if (key_pos == std::string::npos) {
    return values;
  }
  size_t colon = body.find(':', key_pos + needle.size());
  size_t open = body.find('[', colon == std::string::npos ? key_pos : colon);
  if (open == std::string::npos) {
    return values;
  }
  bool in_string = false;
  std::string value;
  for (size_t i = open + 1; i < body.size(); ++i) {
    char ch = body[i];
    if (!in_string && ch == ']') {
      break;
    }
    if (!in_string && ch == '"') {
      in_string = true;
      value.clear();
      continue;
    }
    if (in_string && ch == '"') {
      in_string = false;
      values.push_back(value);
      continue;
    }
    if (in_string && ch == '\\' && i + 1 < body.size()) {
      char escaped = body[++i];
      switch (escaped) {
        case '\\': value.push_back('\\'); break;
        case '"': value.push_back('"'); break;
        case '/': value.push_back('/'); break;
        case 'n': value.push_back('\n'); break;
        case 'r': value.push_back('\r'); break;
        case 't': value.push_back('\t'); break;
        default: value.push_back(escaped); break;
      }
      continue;
    }
    if (in_string) {
      value.push_back(ch);
    }
  }
  return values;
}

std::string safe_path_segment(std::string value) {
  for (char& ch : value) {
    unsigned char c = static_cast<unsigned char>(ch);
    if (!std::isalnum(c) && ch != '-' && ch != '_') {
      ch = '_';
    }
  }
  return value.empty() ? "camera" : value;
}

std::string timestamp_file_segment() {
  SYSTEMTIME time{};
  GetLocalTime(&time);
  char buffer[64]{};
  snprintf(buffer, sizeof(buffer), "%04u%02u%02u-%02u%02u%02u-%03u",
           time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute,
           time.wSecond, time.wMilliseconds);
  return buffer;
}

std::filesystem::path absolute_normalized_path(const std::filesystem::path& input) {
  std::error_code error;
  std::filesystem::path path = input.lexically_normal();
  if (path.is_absolute()) {
    return path;
  }
  return (std::filesystem::current_path(error) / path).lexically_normal();
}

std::filesystem::path path_from_json_text(const std::string& text) {
  return std::filesystem::u8path(text).lexically_normal();
}

std::filesystem::path default_storage_root_path() {
  const char* env_root = std::getenv("CAPTURE_STORAGE_ROOT");
  if (env_root && *env_root) {
    return absolute_normalized_path(env_root);
  }
  std::error_code error;
  if (std::filesystem::exists("E:\\", error)) {
    return std::filesystem::path("E:\\steel-capture-data").lexically_normal();
  }
  return absolute_normalized_path("captures");
}

std::string lower_path_text(std::filesystem::path path) {
  std::string text = path.lexically_normal().string();
  std::transform(text.begin(), text.end(), text.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return text;
}

bool is_path_under_base(const std::string& path, const std::filesystem::path& base) {
  std::error_code error;
  std::filesystem::path absolute = std::filesystem::absolute(path, error).lexically_normal();
  if (error) {
    return false;
  }
  std::filesystem::path absolute_base = std::filesystem::absolute(base, error).lexically_normal();
  if (error) {
    return false;
  }
  std::string absolute_text = lower_path_text(absolute);
  std::string base_text = lower_path_text(absolute_base);
  if (!base_text.empty() && base_text.back() != '\\' && base_text.back() != '/') {
    base_text.push_back('\\');
  }
  if (absolute_text == lower_path_text(absolute_base)) {
    return true;
  }
  return absolute_text.rfind(base_text, 0) == 0;
}

bool is_path_allowed_for_read(const std::string& path, const std::filesystem::path& storage_root) {
  std::error_code error;
  std::filesystem::path cwd = std::filesystem::current_path(error).lexically_normal();
  if (error) {
    return is_path_under_base(path, storage_root);
  }
  return is_path_under_base(path, storage_root) || is_path_under_base(path, cwd);
}

bool read_file(const std::string& path, std::string& out) {
  std::ifstream file(path, std::ios::binary);
  if (!file) {
    return false;
  }
  std::ostringstream buffer;
  buffer << file.rdbuf();
  out = buffer.str();
  return true;
}

bool write_text_file(const std::filesystem::path& path, const std::string& body) {
  std::error_code error;
  std::filesystem::create_directories(path.parent_path(), error);
  if (error) {
    return false;
  }
  std::ofstream file(path, std::ios::binary | std::ios::trunc);
  if (!file) {
    return false;
  }
  file << body;
  return static_cast<bool>(file);
}

struct RouteResult {
  USHORT status = 200;
  std::string body;
  std::string content_type = "application/json; charset=utf-8";
};

class CaptureRuntime {
 public:
  static CaptureRuntime& instance() {
    static CaptureRuntime runtime;
    return runtime;
  }

  RouteResult route(const std::string& method, const std::string& path, const std::string& query, const std::string& body) {
    if (method == "OPTIONS") {
      return {200, "{}", "application/json; charset=utf-8"};
    }
    if (method == "GET" && (path == "/" || path == "/ui")) {
      return {200, ui_html(), "text/html; charset=utf-8"};
    }
    if (method == "GET" && (path == "/health" || path == "/api/capture/health")) return {200, health_json()};
    if (method == "GET" && path == "/api/storage/status") return {200, storage_status_json()};
    if (method == "POST" && path == "/api/storage/config") return {200, storage_config_json(body)};
    if (method == "GET" && path == "/api/config/status") return {200, config_status_json()};
    if (method == "GET" && path == "/api/config/profiles") return {200, config_profiles_json()};
    if (method == "GET" && path == "/api/config/profile") return {200, config_profile_json(query)};
    if (method == "POST" && path == "/api/config/profile/save") return {200, config_profile_save_json(body)};
    if (method == "POST" && path == "/api/config/profile/apply") return {200, config_profile_apply_json(body)};
    if (method == "POST" && path == "/api/config/camera-params/save-all") return {200, config_camera_params_save_all_json(body)};
    if (method == "POST" && path == "/api/config/camera-params/load-all") return {200, config_camera_params_load_all_json(body)};
    if (method == "GET" && path == "/api/cameras") return {200, cameras_json()};
    if (method == "POST" && path == "/api/camera/connect") return {200, connect_json(body)};
    if (method == "POST" && (path == "/api/cameras/connect-all" || path == "/api/camera/connect-all")) return {200, connect_all_json(body)};
    if (method == "POST" && path == "/api/camera/disconnect") return {200, disconnect_json(body)};
    if (method == "GET" && path == "/api/camera/status") return {200, status_json(query)};
    if (method == "GET" && path == "/api/camera/statuses") return {200, statuses_json()};
    if (method == "GET" && path == "/api/param") return {200, get_param_json(query)};
    if (method == "POST" && path == "/api/param") return {200, set_param_json(body)};
    if (method == "POST" && (path == "/api/param/save-device" || path == "/api/param/save-to-device")) return {200, param_save_device_json(body)};
    if (method == "POST" && path == "/api/param/save-file") return {200, param_save_file_json(body)};
    if (method == "POST" && path == "/api/param/load-file") return {200, param_load_file_json(body)};
    if (method == "POST" && path == "/api/param/recovery") return {200, param_recovery_json(body)};
    if (method == "POST" && (path == "/api/preview/capture" || path == "/api/capture/preview")) return {200, preview_capture_json(body)};
    if (method == "POST" && path == "/api/capture/depth-map") return {200, capture_depth_json(body)};
    if (method == "POST" && path == "/api/capture/continuous-test") return {200, continuous_capture_test_json(body)};
    if (method == "GET" && path == "/api/capture/file") return capture_file_response(query);
    if (method == "POST" && path == "/api/stream/start") return {200, stream_start_json(body)};
    if (method == "POST" && path == "/api/stream/stop") return {200, stream_stop_json(body)};
    if (method == "GET" && path == "/api/stream/status") return {200, stream_status_json(query)};
    if (method == "GET" && path == "/api/stream/latest") return stream_latest_response(query);
    if (method == "POST" && path == "/api/calibration/load") return {200, calibration_load_json(body)};
    if (method == "POST" && path == "/api/roi/load") return {200, roi_load_json(body)};
    if (method == "GET" && path == "/api/calibration/status") return {200, calibration_status_json(query)};
    return {404, json_error(404, "not found")};
  }

 private:
  struct StreamState {
    bool running = false;
    int lines = 1280;
    int width = 0;
    int data_mode = 1;
    bool hs = false;
    int fps_limit = 5;
    int code = 0;
    int frame_count = 0;
    int fid = -1;
    int sid = -1;
    int lost_lines = 0;
    unsigned int trigger_min_interval = 0;
    unsigned int trigger_max_interval = 0;
    unsigned int timestamp = 0;
    std::string started_at;
    std::string updated_at;
    std::string latest_depth_path;
    std::string latest_intensity_path;
    lvm_buf_t* buffer = nullptr;
    std::chrono::steady_clock::time_point last_saved = std::chrono::steady_clock::time_point::min();
  };

  struct CalibrationState {
    std::string calibration_path;
    int calibration_code = 0;
    std::string calibration_time;
    std::string roi_path;
    int roi_code = 0;
    std::string roi_time;
    std::string validation_path;
    int validation_code = 0;
    std::string validation_time;
  };

  struct CameraSession {
    lvm_dev_t* device = nullptr;
    std::string ip;
    int dev_type = -1;
    StreamState stream;
    CalibrationState calibration;
  };

  CaptureRuntime() : storage_root_(default_storage_root_path()) {}
  CaptureRuntime(const CaptureRuntime&) = delete;
  CaptureRuntime& operator=(const CaptureRuntime&) = delete;

  static int device_change_cb(lvm_device_changes_t change, lvm_cam_info_t info) {
    std::cout << "[camera] " << (change == DEV_CHANGE_CONNECT ? "connected " : "disconnected ")
              << (info.ip ? info.ip : "") << " " << (info.model ? info.model : "") << "\n";
    return 0;
  }

  static int frame_cb(lvm_dev_t* dev, void* frame, void*, int) {
    return CaptureRuntime::instance().on_frame(dev, frame);
  }

  int on_frame(lvm_dev_t* dev, void* frame) {
    if (!dev || !frame) {
      return 0;
    }
    std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
    if (!lock.owns_lock()) {
      return 0;
    }
    auto* session = static_cast<CameraSession*>(dev->context);
    if (!session || !session->stream.running) {
      return 0;
    }
    auto* depth_map = static_cast<lvm_depth_map_t*>(frame);
    auto now = std::chrono::steady_clock::now();
    int fps_limit = std::max(1, session->stream.fps_limit);
    auto interval = std::chrono::milliseconds(1000 / fps_limit);
    if (session->stream.last_saved != std::chrono::steady_clock::time_point::min() &&
        now - session->stream.last_saved < interval) {
      return 0;
    }

    std::filesystem::path stream_dir = (storage_root_ / "stream").lexically_normal();
    std::filesystem::create_directories(stream_dir);
    std::string safe_ip = safe_path_segment(session->ip);
    std::string depth_path = (stream_dir / (safe_ip + "-latest-depth.png")).lexically_normal().string();
    int ret = lvm_save_depth_map(dev, depth_path.c_str(), depth_map);
    if (ret == CORRECT) {
      session->stream.latest_depth_path = depth_path;
    }
    if (depth_map->intensity_img && depth_map->intensity_img->data) {
      std::string intensity_path = (stream_dir / (safe_ip + "-latest-intensity.png")).lexically_normal().string();
      int img_ret = lvm_save_img(intensity_path.c_str(),
                                 depth_map->intensity_img->data,
                                 depth_map->intensity_img->head.width,
                                 depth_map->intensity_img->head.height,
                                 LVM_IMAGE_FORMAT_16BIT_USHORT);
      if (img_ret == CORRECT) {
        session->stream.latest_intensity_path = intensity_path;
      }
    }
    session->stream.code = ret;
    session->stream.frame_count += 1;
    session->stream.fid = depth_map->head.fid;
    session->stream.sid = depth_map->head.sid;
    session->stream.width = static_cast<int>(depth_map->head.width);
    session->stream.lines = static_cast<int>(depth_map->head.height);
    session->stream.lost_lines = static_cast<int>(depth_map->head.lost_lines);
    session->stream.trigger_min_interval = depth_map->head.trigger_min_interval;
    session->stream.trigger_max_interval = depth_map->head.trigger_max_interval;
    session->stream.timestamp = depth_map->head.time_stamp;
    session->stream.updated_at = now_iso();
    session->stream.last_saved = now;
    return 0;
  }

  int ensure_sdk() {
    if (sdk_ready_) {
      return CORRECT;
    }
    CreateDirectoryA("logs", nullptr);
    int ret = lvm_init_sdk(device_change_cb, "logs/");
    sdk_ready_ = (ret == CORRECT || ret == SDK_REPEATED_INIT);
    return ret;
  }

  CameraSession* session_for_ip_locked(const std::string& ip) {
    if (!ip.empty()) {
      auto found = sessions_.find(ip);
      return found == sessions_.end() ? nullptr : &found->second;
    }
    for (auto& item : sessions_) {
      if (item.second.device) {
        return &item.second;
      }
    }
    return nullptr;
  }

  int apply_software_trigger(lvm_dev_t* device) {
    if (!device || !device->capture_param) {
      return INPUT_PARAMETER_ERROR;
    }
    device->capture_param->ctrl_type = SOFTWARE_CTRL;
    device->capture_param->ctrl_mode = 2;
    device->capture_param->trigger_input_type = LVM_TRIGGER_TIME_TRIGGER;
    device->capture_param->div_ratio = 4;
    if (device->capture_param->time_trigger_freq <= 0.0f) {
      device->capture_param->time_trigger_freq = 300.0f;
    }
    return lvm_set_param(device, LVM_CAPTURE_PARAM);
  }

  std::string resolve_output_path_locked(const std::string& output, const std::string& fallback_relative) const {
    std::filesystem::path path = output.empty() ? std::filesystem::path(fallback_relative) : std::filesystem::path(output);
    path = path.lexically_normal();
    if (path.is_absolute()) {
      return path.string();
    }
    return (storage_root_ / path).lexically_normal().string();
  }

  bool is_output_path_allowed_locked(const std::string& path) const {
    return is_path_under_base(path, storage_root_);
  }

  std::string storage_status_json_locked(int code = CORRECT) const {
    std::error_code error;
    bool exists_before_create = std::filesystem::exists(storage_root_, error);
    if (!error && !exists_before_create) {
      std::filesystem::create_directories(storage_root_, error);
    }
    error.clear();
    bool exists = std::filesystem::exists(storage_root_, error);
    bool writable = false;
    if (!error && exists) {
      std::filesystem::path probe = storage_root_ / ".steel-capture-write-test.tmp";
      {
        std::ofstream file(probe, std::ios::binary);
        if (file) {
          file << "ok";
          writable = true;
        }
      }
      std::error_code remove_error;
      std::filesystem::remove(probe, remove_error);
    }
    std::ostringstream json;
    json << "{\"code\":" << code << ","
         << json_pair("root", storage_root_.string()) << ","
         << "\"exists\":" << (exists ? "true" : "false") << ","
         << "\"writable\":" << (writable ? "true" : "false")
         << "}";
    return json.str();
  }

  std::string storage_status_json() {
    std::lock_guard<std::mutex> lock(mutex_);
    return storage_status_json_locked();
  }

  std::string storage_config_json(const std::string& body) {
    std::string root = json_string_field(body, "root");
    if (root.empty()) {
      return json_error(400, "missing storage root");
    }
    std::filesystem::path next_root = absolute_normalized_path(root);
    std::error_code error;
    std::filesystem::create_directories(next_root, error);
    if (error) {
      return json_error(500, "storage root cannot be created");
    }
    std::lock_guard<std::mutex> lock(mutex_);
    storage_root_ = next_root;
    return storage_status_json_locked();
  }

  std::filesystem::path config_root_locked() const {
    return (storage_root_ / "config").lexically_normal();
  }

  std::filesystem::path profiles_root_locked() const {
    return (config_root_locked() / "profiles").lexically_normal();
  }

  std::filesystem::path camera_params_root_locked() const {
    return (config_root_locked() / "camera-params").lexically_normal();
  }

  std::filesystem::path active_profile_path_locked() const {
    return (config_root_locked() / "active-profile.txt").lexically_normal();
  }

  void ensure_config_dirs_locked() const {
    std::error_code error;
    std::filesystem::create_directories(profiles_root_locked(), error);
    error.clear();
    std::filesystem::create_directories(camera_params_root_locked(), error);
  }

  std::string normalize_profile_name(const std::string& name) const {
    std::string trimmed = trim(name);
    return safe_path_segment(trimmed.empty() ? "default" : trimmed);
  }

  std::filesystem::path profile_path_locked(const std::string& name) const {
    return (profiles_root_locked() / (normalize_profile_name(name) + ".json")).lexically_normal();
  }

  std::string active_profile_name_locked() const {
    std::string active;
    if (read_file(active_profile_path_locked().string(), active)) {
      active = normalize_profile_name(active);
      if (!active.empty()) {
        return active;
      }
    }
    return "default";
  }

  bool write_active_profile_locked(const std::string& name) const {
    return write_text_file(active_profile_path_locked(), normalize_profile_name(name) + "\n");
  }

  std::vector<std::string> profile_names_locked() const {
    std::vector<std::string> names;
    ensure_config_dirs_locked();
    std::error_code error;
    for (const auto& entry : std::filesystem::directory_iterator(profiles_root_locked(), error)) {
      if (error) {
        break;
      }
      if (!entry.is_regular_file()) {
        continue;
      }
      std::filesystem::path path = entry.path();
      if (path.extension() == ".json") {
        names.push_back(path.stem().string());
      }
    }
    std::sort(names.begin(), names.end());
    return names;
  }

  std::string profile_names_array_json_locked() const {
    std::vector<std::string> names = profile_names_locked();
    std::ostringstream json;
    json << "[";
    for (size_t i = 0; i < names.size(); ++i) {
      if (i > 0) {
        json << ",";
      }
      json << "\"" << json_escape(names[i]) << "\"";
    }
    json << "]";
    return json.str();
  }

  std::filesystem::path camera_param_dir_locked(const std::string& body, const std::string& profile_name) const {
    std::string dir_text = json_string_field(body, "cameraParamDir");
    if (dir_text.empty()) {
      dir_text = "config/camera-params/" + normalize_profile_name(profile_name);
    }
    std::filesystem::path dir = path_from_json_text(dir_text);
    if (!dir.is_absolute()) {
      dir = (storage_root_ / dir).lexically_normal();
    }
    return dir.lexically_normal();
  }

  std::string default_profile_json_locked(const std::string& name) {
    const std::string profile_name = normalize_profile_name(name);
    std::ostringstream cameras;
    cameras << "[";
    bool first = true;
    int discover_ret = CORRECT;
    std::vector<std::string> models;
    std::vector<std::string> sns;
    std::vector<std::string> ips = discovered_ips_locked(discover_ret, &models, &sns);
    if (discover_ret != CORRECT) {
      ips.clear();
    }
    for (size_t i = 0; i < ips.size(); ++i) {
      if (!first) {
        cameras << ",";
      }
      first = false;
      std::string safe_ip = safe_path_segment(ips[i]);
      cameras << "{"
              << json_pair("ip", ips[i]) << ","
              << json_pair("model", i < models.size() ? models[i] : "") << ","
              << json_pair("sn", i < sns.size() ? sns[i] : "") << ","
              << "\"enabled\":true,"
              << json_pair("paramFile", "config/camera-params/" + profile_name + "/" + safe_ip + ".nccfg")
              << "}";
    }
    cameras << "]";

    std::ostringstream json;
    json << "{"
         << json_pair("schema", "steel.capture.profile.v1") << ","
         << json_pair("name", profile_name) << ","
         << json_pair("updatedAt", now_iso()) << ","
         << json_pair("storageRoot", storage_root_.string()) << ","
         << json_pair("configRoot", config_root_locked().string()) << ","
         << json_pair("profileRoot", profiles_root_locked().string()) << ","
         << json_pair("cameraParamDir", "config/camera-params/" + profile_name) << ","
         << json_pair("startupMode", "manual") << ","
         << "\"autoConnect\":true,"
         << "\"expectedCameras\":6,"
         << "\"devType\":-1,"
         << "\"applySoftTrigger\":true,"
         << "\"loadCameraParams\":false,"
         << "\"saveToDevice\":false,"
         << "\"lines\":1000,"
         << "\"width\":0,"
         << "\"timeoutMs\":8000,"
         << "\"dataMode\":1,"
         << "\"fpsLimit\":5,"
         << "\"controlMode\":2,"
         << "\"triggerInputType\":" << static_cast<int>(LVM_TRIGGER_TIME_TRIGGER) << ","
         << "\"divRatio\":4,"
         << "\"timeTriggerFreq\":300,"
         << "\"exposureTime\":50,"
         << "\"gainK\":1.0,"
         << "\"cameraDefaults\":{"
         << "\"controlMode\":2,"
         << "\"triggerInputType\":" << static_cast<int>(LVM_TRIGGER_TIME_TRIGGER) << ","
         << "\"divRatio\":4,"
         << "\"timeTriggerFreq\":300,"
         << "\"exposureTime\":50,"
         << "\"gainK\":1.0"
         << "},"
         << "\"cameras\":" << cameras.str()
         << "}";
    return json.str();
  }

  std::string config_status_json() {
    std::lock_guard<std::mutex> lock(mutex_);
    ensure_config_dirs_locked();
    std::ostringstream json;
    json << "{\"code\":0,"
         << json_pair("storageRoot", storage_root_.string()) << ","
         << json_pair("configRoot", config_root_locked().string()) << ","
         << json_pair("profileRoot", profiles_root_locked().string()) << ","
         << json_pair("cameraParamRoot", camera_params_root_locked().string()) << ","
         << json_pair("activeProfile", active_profile_name_locked()) << ","
         << "\"profiles\":" << profile_names_array_json_locked()
         << "}";
    return json.str();
  }

  std::string config_profiles_json() {
    return config_status_json();
  }

  std::string config_profile_json(const std::string& query) {
    std::lock_guard<std::mutex> lock(mutex_);
    ensure_config_dirs_locked();
    std::string name = get_query_param(query, "name");
    if (name.empty()) {
      name = active_profile_name_locked();
    }
    std::string profile;
    std::filesystem::path path = profile_path_locked(name);
    if (!read_file(path.string(), profile)) {
      profile = default_profile_json_locked(name);
    }
    return profile;
  }

  std::string config_profile_save_json(const std::string& body) {
    std::string content = json_string_field(body, "profileJson");
    if (content.empty()) {
      content = body;
    }
    if (content.find('{') == std::string::npos) {
      return json_error(400, "profile body must be a JSON object");
    }
    std::string name = json_string_field(content, "name", json_string_field(body, "name", "default"));
    bool make_active = json_bool_field(body, "makeActive", false);

    std::lock_guard<std::mutex> lock(mutex_);
    ensure_config_dirs_locked();
    name = normalize_profile_name(name);
    std::filesystem::path path = profile_path_locked(name);
    if (!write_text_file(path, content)) {
      return json_error(500, "profile cannot be saved");
    }
    if (make_active) {
      write_active_profile_locked(name);
    }

    std::ostringstream json;
    json << "{\"code\":0,"
         << json_pair("name", name) << ","
         << json_pair("path", path.string()) << ","
         << "\"active\":" << (active_profile_name_locked() == name ? "true" : "false")
         << "}";
    return json.str();
  }

  int apply_profile_params_locked(lvm_dev_t* device, const std::string& profile) {
    if (!device) {
      return DEV_NOT_LINK_ERROR;
    }
    int first_error = CORRECT;
    auto remember = [&](int ret) {
      if (ret != CORRECT && first_error == CORRECT) {
        first_error = ret;
      }
    };

    if (json_bool_field(profile, "applySoftTrigger", true)) {
      remember(apply_software_trigger(device));
    }

    if (device->capture_param) {
      bool changed = false;
      if (json_has_field(profile, "controlMode")) {
        device->capture_param->ctrl_mode = static_cast<unsigned int>(json_int_field(profile, "controlMode", 2));
        changed = true;
      }
      if (json_has_field(profile, "triggerInputType")) {
        device->capture_param->trigger_input_type =
            static_cast<lvm_trigger_type_t>(json_int_field(profile, "triggerInputType", LVM_TRIGGER_TIME_TRIGGER));
        changed = true;
      }
      if (json_has_field(profile, "divRatio")) {
        device->capture_param->div_ratio = static_cast<unsigned int>(json_int_field(profile, "divRatio", 4));
        changed = true;
      }
      if (json_has_field(profile, "timeTriggerFreq")) {
        device->capture_param->time_trigger_freq = json_float_field(profile, "timeTriggerFreq", 300.0f);
        changed = true;
      }
      if (changed) {
        remember(lvm_set_param(device, LVM_CAPTURE_PARAM));
      }
    }

    if (device->config_param) {
      bool changed = false;
      if (json_has_field(profile, "exposureTime")) {
        device->config_param->expsure_time = json_int_field(profile, "exposureTime", 50);
        changed = true;
      }
      if (json_has_field(profile, "gainK")) {
        device->config_param->gain_k = json_float_field(profile, "gainK", 1.0f);
        changed = true;
      }
      if (changed) {
        remember(lvm_set_param(device, LVM_CONFIG_PARAM));
      }
    }
    return first_error;
  }

  std::vector<std::filesystem::path> camera_param_candidates_locked(const std::filesystem::path& dir, const CameraSession& session) const {
    std::vector<std::filesystem::path> candidates;
    candidates.push_back(dir / (safe_path_segment(session.ip) + ".nccfg"));
    candidates.push_back(dir / (safe_path_segment(session.ip) + ".xml"));
    if (session.device && session.device->dev_info) {
      std::string model = session.device->dev_info->device_name ? session.device->dev_info->device_name : "";
      std::string sn = session.device->dev_info->sn ? session.device->dev_info->sn : "";
      if (!model.empty()) {
        candidates.push_back(dir / (safe_path_segment(model) + ".nccfg"));
        candidates.push_back(dir / (safe_path_segment(model) + ".xml"));
      }
      if (!sn.empty()) {
        candidates.push_back(dir / (safe_path_segment(sn) + ".nccfg"));
        candidates.push_back(dir / (safe_path_segment(sn) + ".xml"));
      }
    }
    return candidates;
  }

  std::string config_camera_params_save_all_json(const std::string& body) {
    std::string profile_name = normalize_profile_name(json_string_field(body, "name", json_string_field(body, "profile", active_profile_name_locked())));
    bool apply_soft_trigger = json_bool_field(body, "applySoftTrigger", true);
    bool save_to_device = json_bool_field(body, "saveToDevice", false);
    std::vector<std::string> ips = json_string_array_field(body, "ips");

    std::lock_guard<std::mutex> lock(mutex_);
    ensure_config_dirs_locked();
    std::filesystem::path dir = camera_param_dir_locked(body, profile_name);
    if (!is_path_under_base(dir.string(), storage_root_)) {
      return json_error(403, "camera parameter directory must be under storage root");
    }
    std::error_code error;
    std::filesystem::create_directories(dir, error);
    if (error) {
      return json_error(500, "camera parameter directory cannot be created");
    }

    std::ostringstream results;
    results << "[";
    int saved = 0;
    int failed = 0;
    int first_error = CORRECT;
    bool first = true;
    for (auto& item : sessions_) {
      CameraSession& session = item.second;
      if (!ips.empty() && std::find(ips.begin(), ips.end(), session.ip) == ips.end()) {
        continue;
      }
      if (!first) {
        results << ",";
      }
      first = false;
      int apply_ret = apply_soft_trigger ? apply_software_trigger(session.device) : CORRECT;
      std::filesystem::path file = dir / (safe_path_segment(session.ip) + ".nccfg");
      int save_file_ret = apply_ret == CORRECT ? lvm_save_dev_param(session.device, file.string().c_str()) : apply_ret;
      int save_dev_ret = (save_file_ret == CORRECT && save_to_device) ? lvm_save_param_to_dev(session.device) : CORRECT;
      int code = save_file_ret == CORRECT ? save_dev_ret : save_file_ret;
      if (code == CORRECT) {
        ++saved;
      } else {
        ++failed;
        if (first_error == CORRECT) {
          first_error = code;
        }
      }
      results << "{\"code\":" << code << ","
              << json_pair("ip", session.ip) << ","
              << json_pair("file", file.string()) << ","
              << "\"applyCode\":" << apply_ret << ","
              << "\"saveFileCode\":" << save_file_ret << ","
              << "\"saveDeviceCode\":" << save_dev_ret
              << "}";
    }
    results << "]";
    int code = failed == 0 ? CORRECT : first_error;
    std::ostringstream json;
    json << "{\"code\":" << code << ","
         << json_pair("name", profile_name) << ","
         << json_pair("cameraParamDir", dir.string()) << ","
         << "\"saved\":" << saved << ","
         << "\"failed\":" << failed << ","
         << "\"results\":" << results.str()
         << "}";
    return json.str();
  }

  std::string config_camera_params_load_all_json(const std::string& body) {
    std::lock_guard<std::mutex> lock(mutex_);
    return config_camera_params_load_all_locked(body);
  }

  std::string config_camera_params_load_all_locked(const std::string& body) {
    std::string profile_name = normalize_profile_name(json_string_field(body, "name", json_string_field(body, "profile", active_profile_name_locked())));
    bool apply_soft_trigger = json_bool_field(body, "applySoftTrigger", true);
    bool save_to_device = json_bool_field(body, "saveToDevice", false);
    std::vector<std::string> ips = json_string_array_field(body, "ips");

    ensure_config_dirs_locked();
    std::filesystem::path dir = camera_param_dir_locked(body, profile_name);
    if (!is_path_under_base(dir.string(), storage_root_)) {
      return json_error(403, "camera parameter directory must be under storage root");
    }

    std::ostringstream results;
    results << "[";
    int loaded = 0;
    int failed = 0;
    int first_error = CORRECT;
    bool first = true;
    for (auto& item : sessions_) {
      CameraSession& session = item.second;
      if (!ips.empty() && std::find(ips.begin(), ips.end(), session.ip) == ips.end()) {
        continue;
      }
      if (!first) {
        results << ",";
      }
      first = false;
      std::filesystem::path file;
      for (const auto& candidate : camera_param_candidates_locked(dir, session)) {
        std::error_code exists_error;
        if (std::filesystem::exists(candidate, exists_error)) {
          file = candidate;
          break;
        }
      }
      int load_ret = file.empty() ? 404 : lvm_load_dev_param(session.device, file.string().c_str());
      int apply_ret = (load_ret == CORRECT && apply_soft_trigger) ? apply_software_trigger(session.device) : CORRECT;
      int save_ret = (load_ret == CORRECT && apply_ret == CORRECT && save_to_device) ? lvm_save_param_to_dev(session.device) : CORRECT;
      int code = load_ret == CORRECT ? (apply_ret == CORRECT ? save_ret : apply_ret) : load_ret;
      if (code == CORRECT) {
        ++loaded;
      } else {
        ++failed;
        if (first_error == CORRECT) {
          first_error = code;
        }
      }
      results << "{\"code\":" << code << ","
              << json_pair("ip", session.ip) << ","
              << json_pair("file", file.empty() ? "" : file.string()) << ","
              << "\"loadCode\":" << load_ret << ","
              << "\"applyCode\":" << apply_ret << ","
              << "\"saveDeviceCode\":" << save_ret
              << "}";
    }
    results << "]";
    int code = failed == 0 ? CORRECT : first_error;
    std::ostringstream json;
    json << "{\"code\":" << code << ","
         << json_pair("name", profile_name) << ","
         << json_pair("cameraParamDir", dir.string()) << ","
         << "\"loaded\":" << loaded << ","
         << "\"failed\":" << failed << ","
         << "\"results\":" << results.str()
         << "}";
    return json.str();
  }

  std::string config_profile_apply_json(const std::string& body) {
    std::string profile = json_string_field(body, "profileJson");
    std::string name = json_string_field(body, "name", json_string_field(body, "profile", active_profile_name_locked()));
    {
      std::lock_guard<std::mutex> lock(mutex_);
      ensure_config_dirs_locked();
      name = normalize_profile_name(name);
      if (profile.empty() && !read_file(profile_path_locked(name).string(), profile)) {
        return json_error(404, "profile not found");
      }
    }

    bool change_storage = json_bool_field(body, "changeStorage", json_bool_field(profile, "changeStorage", false));
    bool auto_connect = json_bool_field(body, "autoConnect", json_bool_field(profile, "autoConnect", false));
    bool load_camera_params = json_bool_field(body, "loadCameraParams", json_bool_field(profile, "loadCameraParams", false));
    bool save_to_device = json_bool_field(body, "saveToDevice", json_bool_field(profile, "saveToDevice", false));
    int expected_cameras = json_int_field(body, "expectedCameras", json_int_field(profile, "expectedCameras", 0));
    int dev_type = json_int_field(body, "devType", json_int_field(profile, "devType", -1));

    std::lock_guard<std::mutex> lock(mutex_);
    if (change_storage) {
      std::string next_root = json_string_field(profile, "storageRoot");
      if (!next_root.empty()) {
        std::error_code error;
        std::filesystem::path next = absolute_normalized_path(path_from_json_text(next_root));
        std::filesystem::create_directories(next, error);
        if (!error) {
          storage_root_ = next;
        }
      }
    }
    ensure_config_dirs_locked();

    int discover_ret = CORRECT;
    std::vector<std::string> connected_ips;
    int connected = 0;
    int failed_connect = 0;
    int first_error = CORRECT;
    if (auto_connect) {
      std::vector<std::string> ips = discovered_ips_locked(discover_ret);
      if (discover_ret == CORRECT) {
        for (const std::string& ip : ips) {
          bool already_connected = false;
          int ret = connect_one_locked(ip, dev_type, &already_connected);
          if (ret == CORRECT) {
            ++connected;
            connected_ips.push_back(ip);
          } else {
            ++failed_connect;
            if (first_error == CORRECT) {
              first_error = ret;
            }
          }
        }
      } else if (first_error == CORRECT) {
        first_error = discover_ret;
      }
    }

    int param_applied = 0;
    int param_failed = 0;
    std::ostringstream param_results;
    param_results << "[";
    bool first_param = true;
    for (auto& item : sessions_) {
      if (!first_param) {
        param_results << ",";
      }
      first_param = false;
      int ret = item.second.stream.running ? 409 : apply_profile_params_locked(item.second.device, profile);
      if (ret == CORRECT) {
        ++param_applied;
      } else {
        ++param_failed;
        if (first_error == CORRECT) {
          first_error = ret;
        }
      }
      param_results << "{\"code\":" << ret << "," << json_pair("ip", item.second.ip) << "}";
    }
    param_results << "]";

    std::string load_result = "{\"skipped\":true}";
    if (load_camera_params) {
      std::ostringstream load_body;
      load_body << "{"
                << json_pair("name", name) << ","
                << json_pair("cameraParamDir", json_string_field(profile, "cameraParamDir", "config/camera-params/" + name)) << ","
                << "\"applySoftTrigger\":" << (json_bool_field(profile, "applySoftTrigger", true) ? "true" : "false") << ","
                << "\"saveToDevice\":" << (save_to_device ? "true" : "false")
                << "}";
      load_result = config_camera_params_load_all_locked(load_body.str());
      int load_code = json_int_field(load_result, "code", CORRECT);
      if (load_code != CORRECT && first_error == CORRECT) {
        first_error = load_code;
      }
    } else if (save_to_device) {
      for (auto& item : sessions_) {
        int ret = lvm_save_param_to_dev(item.second.device);
        if (ret != CORRECT && first_error == CORRECT) {
          first_error = ret;
        }
      }
    }

    write_active_profile_locked(name);
    bool expected_met = expected_cameras <= 0 || connected >= expected_cameras || !auto_connect;
    int code = (first_error == CORRECT && expected_met) ? CORRECT : (first_error == CORRECT ? 206 : first_error);
    std::ostringstream json;
    json << "{\"code\":" << code << ","
         << json_pair("name", name) << ","
         << "\"active\":true,"
         << "\"autoConnect\":" << (auto_connect ? "true" : "false") << ","
         << "\"expectedCameras\":" << expected_cameras << ","
         << "\"expectedMet\":" << (expected_met ? "true" : "false") << ","
         << "\"connected\":" << connected << ","
         << "\"connectFailed\":" << failed_connect << ","
         << "\"paramApplied\":" << param_applied << ","
         << "\"paramFailed\":" << param_failed << ","
         << "\"paramResults\":" << param_results.str() << ","
         << "\"cameraParamResult\":" << load_result << ","
         << json_pair("storageRoot", storage_root_.string()) << ","
         << json_pair("configRoot", config_root_locked().string())
         << "}";
    return json.str();
  }

  std::vector<std::string> discovered_ips_locked(int& ret, std::vector<std::string>* models = nullptr, std::vector<std::string>* sns = nullptr) {
    std::vector<std::string> ips;
    int sdk_ret = ensure_sdk();
    lvm_cam_info_t* cam_info = nullptr;
    int cam_num = 0;
    ret = (sdk_ret == CORRECT || sdk_ret == SDK_REPEATED_INIT) ? lvm_get_cam_info(&cam_info, &cam_num) : sdk_ret;
    if (ret != CORRECT || !cam_info) {
      return ips;
    }
    for (int i = 0; i < cam_num; ++i) {
      std::string ip = cam_info[i].ip ? cam_info[i].ip : "";
      if (ip.empty()) {
        continue;
      }
      ips.push_back(ip);
      if (models) {
        models->push_back(cam_info[i].model ? cam_info[i].model : "");
      }
      if (sns) {
        sns->push_back(cam_info[i].sn ? cam_info[i].sn : "");
      }
    }
    return ips;
  }

  int connect_one_locked(const std::string& ip, int dev_type, bool* already_connected = nullptr) {
    if (already_connected) {
      *already_connected = false;
    }
    CameraSession* existing = session_for_ip_locked(ip);
    if (existing && existing->device && lvm_get_dev_connect_status(existing->device) == 1) {
      if (already_connected) {
        *already_connected = true;
      }
      existing->device->context = existing;
      return CORRECT;
    }
    destroy_session_locked(ip);

    char ip_buffer[DEVICE_NET_INFO_LEN]{};
    strncpy_s(ip_buffer, ip.c_str(), _TRUNCATE);
    lvm_dev_t* device = lvm_create_dev(ip_buffer, dev_type);
    int ret = device ? lvm_connect_dev(device) : DEV_INIT_FAILED;
    if (ret == CORRECT) {
      ret = apply_software_trigger(device);
    }
    if (ret == CORRECT) {
      CameraSession session{};
      session.device = device;
      session.ip = ip;
      session.dev_type = dev_type;
      sessions_[ip] = session;
      sessions_[ip].device->context = &sessions_[ip];
    } else if (device) {
      lvm_disconnect_dev(device);
      lvm_destroy_dev(device);
    }
    return ret;
  }

  void stop_stream_locked(CameraSession& session) {
    if (session.device) {
      if (session.stream.running) {
        lvm_trigger_en_ctrl(session.device, false);
        lvm_grab_stop(session.device);
      }
      lvm_buf_t* buffer = session.stream.buffer ? session.stream.buffer : session.device->buffer;
      if (buffer) {
        lvm_free_buf(buffer);
      }
      session.stream.buffer = nullptr;
      session.device->buffer = nullptr;
    }
    session.stream.running = false;
  }

  void stop_all_streams_locked(const std::string& except_ip = "") {
    for (auto& item : sessions_) {
      if (except_ip.empty() || item.first != except_ip) {
        stop_stream_locked(item.second);
      }
    }
  }

  void destroy_session_locked(const std::string& ip) {
    auto found = sessions_.find(ip);
    if (found == sessions_.end()) {
      return;
    }
    stop_stream_locked(found->second);
    if (found->second.device) {
      lvm_disconnect_dev(found->second.device);
      lvm_destroy_dev(found->second.device);
    }
    sessions_.erase(found);
  }

  std::string status_json_for_session(const CameraSession* session, const std::string& ip) const {
    lvm_dev_t* device = session ? session->device : nullptr;
    int connected = device ? lvm_get_dev_connect_status(device) : 0;
    int dev_id = device ? lvm_get_dev_id(device) : -1;
    std::ostringstream json;
    json << "{\"connected\":" << (connected == 1 ? "true" : "false")
         << ",\"deviceId\":" << dev_id << ","
         << json_pair("ip", session ? session->ip : ip) << ","
         << json_pair("driverId", "lvm-nvt") << ","
         << json_pair("acquisitionState", connected == 1 ? "connected" : "discovered") << ","
         << json_pair("sdkStatus", sdk_ready_ ? "ready" : "not-ready");
    if (device && device->dev_info) {
      json << "," << json_pair("model", device->dev_info->device_name)
           << "," << json_pair("sn", device->dev_info->sn);
    }
    if (device && device->status) {
      json << ",\"task\":" << device->status->task
           << ",\"status\":" << device->status->status
           << ",\"linkHealth\":" << device->status->link_health
           << ",\"temperatureJ28\":" << device->status->temperature_j28
           << ",\"temperatureJ29\":" << device->status->temperature_j29
           << ",\"temperatureJ30\":" << device->status->temperature_j30
           << ",\"lostPulseCounter\":" << device->status->lost_pulse_counter
           << ",\"bufferOverflowCounter\":" << device->status->buffer_overflow_counter;
    }
    if (session) {
      json << ",\"streamRunning\":" << (session->stream.running ? "true" : "false")
           << ",\"streamFrames\":" << session->stream.frame_count;
    }
    json << "}";
    return json.str();
  }

  std::string health_json() {
    std::lock_guard<std::mutex> lock(mutex_);
    int sdk_ret = ensure_sdk();
    int connected_count = 0;
    std::string first_ip;
    for (const auto& item : sessions_) {
      if (item.second.device && lvm_get_dev_connect_status(item.second.device) == 1) {
        ++connected_count;
        if (first_ip.empty()) {
          first_ip = item.first;
        }
      }
    }
    std::ostringstream json;
    json << "{"
         << json_pair("service", "steel_capture_service") << ","
         << json_pair("time", now_iso()) << ","
         << "\"sdkReady\":" << (sdk_ready_ ? "true" : "false") << ","
         << "\"sdkCode\":" << sdk_ret << ","
         << "\"connected\":" << (connected_count > 0 ? "true" : "false") << ","
         << json_pair("ip", first_ip) << ","
         << json_pair("driverId", "lvm-nvt") << ","
         << json_pair("driverName", "LVM/NVT 3D Camera SDK") << ","
         << json_pair("storageRoot", storage_root_.string()) << ","
         << "\"cameraCount\":" << connected_count
         << "}";
    return json.str();
  }

  std::string cameras_json() {
    std::lock_guard<std::mutex> lock(mutex_);
    int sdk_ret = ensure_sdk();
    lvm_cam_info_t* cam_info = nullptr;
    int cam_num = 0;
    int ret = sdk_ret == CORRECT || sdk_ret == SDK_REPEATED_INIT ? lvm_get_cam_info(&cam_info, &cam_num) : sdk_ret;
    std::ostringstream json;
    json << "{\"code\":" << ret << ",\"count\":" << (ret == CORRECT ? cam_num : 0) << ",\"cameras\":[";
    if (ret == CORRECT && cam_info) {
      for (int i = 0; i < cam_num; ++i) {
        if (i > 0) json << ",";
        json << "{"
             << json_pair("ip", cam_info[i].ip ? cam_info[i].ip : "") << ","
             << json_pair("model", cam_info[i].model ? cam_info[i].model : "") << ","
             << json_pair("sn", cam_info[i].sn ? cam_info[i].sn : "") << ","
             << json_pair("driverId", "lvm-nvt")
             << "}";
      }
    }
    json << "]}";
    return json.str();
  }

  std::string connect_json(const std::string& body) {
    std::lock_guard<std::mutex> lock(mutex_);
    int sdk_ret = ensure_sdk();
    if (!(sdk_ret == CORRECT || sdk_ret == SDK_REPEATED_INIT)) {
      return "{\"code\":" + std::to_string(sdk_ret) + ",\"connected\":false}";
    }

    std::string ip = json_string_field(body, "ip", "192.168.10.13");
    int dev_type = json_int_field(body, "devType", -1);
    bool already_connected = false;
    int ret = connect_one_locked(ip, dev_type, &already_connected);

    std::ostringstream json;
    json << "{\"code\":" << ret << ",\"connected\":" << (ret == CORRECT ? "true" : "false") << ","
         << json_pair("ip", ip) << ",\"alreadyConnected\":" << (already_connected ? "true" : "false") << "}";
    return json.str();
  }

  std::string connect_all_json(const std::string& body) {
    int dev_type = json_int_field(body, "devType", -1);
    int expected_cameras = json_int_field(body, "expectedCameras", 0);
    std::vector<std::string> requested_ips = json_string_array_field(body, "ips");

    std::lock_guard<std::mutex> lock(mutex_);
    int sdk_ret = ensure_sdk();
    if (!(sdk_ret == CORRECT || sdk_ret == SDK_REPEATED_INIT)) {
      return "{\"code\":" + std::to_string(sdk_ret) + ",\"connected\":0,\"results\":[]}";
    }

    int discover_ret = CORRECT;
    std::vector<std::string> ips = requested_ips.empty() ? discovered_ips_locked(discover_ret) : requested_ips;
    if (discover_ret != CORRECT) {
      return json_error(discover_ret, "camera discovery failed");
    }

    int connected = 0;
    int failed = 0;
    int first_error = CORRECT;
    std::ostringstream results;
    results << "[";
    for (size_t i = 0; i < ips.size(); ++i) {
      const std::string& ip = ips[i];
      bool already_connected = false;
      int ret = connect_one_locked(ip, dev_type, &already_connected);
      if (ret == CORRECT) {
        ++connected;
      } else {
        ++failed;
        if (first_error == CORRECT) {
          first_error = ret;
        }
      }
      if (i > 0) {
        results << ",";
      }
      results << "{\"code\":" << ret
              << ",\"connected\":" << (ret == CORRECT ? "true" : "false")
              << ",\"alreadyConnected\":" << (already_connected ? "true" : "false")
              << "," << json_pair("ip", ip) << "}";
    }
    results << "]";

    bool expected_met = expected_cameras <= 0 || static_cast<int>(ips.size()) >= expected_cameras;
    int code = (failed == 0 && expected_met) ? CORRECT : (first_error == CORRECT ? 206 : first_error);
    std::ostringstream json;
    json << "{\"code\":" << code
         << ",\"discovered\":" << ips.size()
         << ",\"connected\":" << connected
         << ",\"failed\":" << failed
         << ",\"expectedCameras\":" << expected_cameras
         << ",\"expectedMet\":" << (expected_met ? "true" : "false")
         << ",\"results\":" << results.str()
         << "}";
    return json.str();
  }

  std::string disconnect_json(const std::string& body) {
    std::lock_guard<std::mutex> lock(mutex_);
    std::string ip = json_string_field(body, "ip");
    int ret = CORRECT;
    if (!ip.empty()) {
      auto found = sessions_.find(ip);
      if (found != sessions_.end() && found->second.device) {
        stop_stream_locked(found->second);
        ret = lvm_disconnect_dev(found->second.device);
        lvm_destroy_dev(found->second.device);
        sessions_.erase(found);
      }
      return "{\"code\":" + std::to_string(ret) + ",\"connected\":false," + json_pair("ip", ip) + "}";
    }
    for (auto& item : sessions_) {
      stop_stream_locked(item.second);
      if (item.second.device) {
        ret = lvm_disconnect_dev(item.second.device);
        lvm_destroy_dev(item.second.device);
      }
    }
    sessions_.clear();
    return "{\"code\":" + std::to_string(ret) + ",\"connected\":false}";
  }

  std::string status_json(const std::string& query) {
    std::lock_guard<std::mutex> lock(mutex_);
    std::string ip = get_query_param(query, "ip");
    return status_json_for_session(session_for_ip_locked(ip), ip);
  }

  std::string statuses_json() {
    std::lock_guard<std::mutex> lock(mutex_);
    int sdk_ret = ensure_sdk();
    lvm_cam_info_t* cam_info = nullptr;
    int cam_num = 0;
    int ret = sdk_ret == CORRECT || sdk_ret == SDK_REPEATED_INIT ? lvm_get_cam_info(&cam_info, &cam_num) : sdk_ret;

    std::vector<std::string> statuses;
    std::vector<std::string> seen_ips;
    for (const auto& item : sessions_) {
      statuses.push_back(status_json_for_session(&item.second, item.first));
      seen_ips.push_back(item.first);
    }
    if (ret == CORRECT && cam_info) {
      for (int i = 0; i < cam_num; ++i) {
        std::string ip = cam_info[i].ip ? cam_info[i].ip : "";
        if (ip.empty() || std::find(seen_ips.begin(), seen_ips.end(), ip) != seen_ips.end()) {
          continue;
        }
        std::ostringstream item;
        item << "{\"connected\":false,\"deviceId\":-1,"
             << json_pair("ip", ip) << ","
             << json_pair("driverId", "lvm-nvt") << ","
             << json_pair("model", cam_info[i].model ? cam_info[i].model : "") << ","
             << json_pair("sn", cam_info[i].sn ? cam_info[i].sn : "") << ","
             << json_pair("acquisitionState", "discovered") << ","
             << json_pair("sdkStatus", sdk_ready_ ? "ready" : "not-ready") << "}";
        statuses.push_back(item.str());
      }
    }
    std::ostringstream json;
    json << "{\"statuses\":[";
    for (size_t i = 0; i < statuses.size(); ++i) {
      if (i > 0) json << ",";
      json << statuses[i];
    }
    json << "]}";
    return json.str();
  }

  std::string get_param_json(const std::string& query) {
    std::string key = get_query_param(query, "key");
    std::string type = get_query_param(query, "type");
    std::string ip = get_query_param(query, "ip");
    if (key.empty()) {
      return json_error(400, "missing key");
    }
    std::lock_guard<std::mutex> lock(mutex_);
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || !session->device) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    if ((_stricmp(key.c_str(), "TriggerMode") == 0 || _stricmp(key.c_str(), "ctrl_type") == 0) && session->device->capture_param) {
      return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" +
             std::to_string(static_cast<int>(session->device->capture_param->ctrl_type)) + "," + json_pair("label", "software-trigger") + "}";
    }
    if ((_stricmp(key.c_str(), "ControlMode") == 0 || _stricmp(key.c_str(), "ctrl_mode") == 0) && session->device->capture_param) {
      return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" +
             std::to_string(static_cast<int>(session->device->capture_param->ctrl_mode)) + "," + json_pair("label", "count-mode") + "}";
    }
    if ((_stricmp(key.c_str(), "TriggerInputType") == 0 || _stricmp(key.c_str(), "trigger_input_type") == 0) && session->device->capture_param) {
      return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" +
             std::to_string(static_cast<int>(session->device->capture_param->trigger_input_type)) + "," + json_pair("label", "time-trigger") + "}";
    }
    if ((_stricmp(key.c_str(), "DivRatio") == 0 || _stricmp(key.c_str(), "div_ratio") == 0) && session->device->capture_param) {
      return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" +
             std::to_string(static_cast<int>(session->device->capture_param->div_ratio)) + "}";
    }
    if ((_stricmp(key.c_str(), "ExposureTime") == 0 || _stricmp(key.c_str(), "expsure_time") == 0) && session->device->config_param) {
      return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" + std::to_string(session->device->config_param->expsure_time) + "}";
    }
    if ((_stricmp(key.c_str(), "GainK") == 0 || _stricmp(key.c_str(), "gain_k") == 0) && session->device->config_param) {
      return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" + std::to_string(session->device->config_param->gain_k) + "}";
    }
    if ((_stricmp(key.c_str(), "TimeTriggerFreq") == 0 || _stricmp(key.c_str(), "time_trigger_freq") == 0) && session->device->capture_param) {
      return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" + std::to_string(session->device->capture_param->time_trigger_freq) + "}";
    }
    if (type == "float") {
      float value = 0;
      int ret = lvm_get_param_float_value(session->device, key.c_str(), &value);
      return "{\"code\":" + std::to_string(ret) + "," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" + std::to_string(value) + "}";
    }
    if (type == "string") {
      char* value = nullptr;
      int ret = lvm_get_param_string_value(session->device, key.c_str(), &value);
      return "{\"code\":" + std::to_string(ret) + "," + json_pair("ip", session->ip) + "," + json_pair("key", key) + "," + json_pair("value", value ? value : "") + "}";
    }
    int value = 0;
    int ret = lvm_get_param_int_value(session->device, key.c_str(), &value);
    return "{\"code\":" + std::to_string(ret) + "," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" + std::to_string(value) + "}";
  }

  std::string set_param_json(const std::string& body) {
    std::string ip = json_string_field(body, "ip");
    std::string key = json_string_field(body, "key");
    std::string type = json_string_field(body, "type", "int");
    if (key.empty()) {
      return json_error(400, "missing key");
    }
    std::lock_guard<std::mutex> lock(mutex_);
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || !session->device) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    int ret = INPUT_PARAMETER_ERROR;
    if (_stricmp(key.c_str(), "TriggerMode") == 0 || _stricmp(key.c_str(), "ctrl_type") == 0) {
      ret = apply_software_trigger(session->device);
    } else if (_stricmp(key.c_str(), "ControlMode") == 0 || _stricmp(key.c_str(), "ctrl_mode") == 0) {
      if (session->device->capture_param) {
        session->device->capture_param->ctrl_mode = static_cast<unsigned int>(json_int_field(body, "value", 2));
        ret = lvm_set_param(session->device, LVM_CAPTURE_PARAM);
      }
    } else if (_stricmp(key.c_str(), "TriggerInputType") == 0 || _stricmp(key.c_str(), "trigger_input_type") == 0) {
      if (session->device->capture_param) {
        session->device->capture_param->trigger_input_type = static_cast<lvm_trigger_type_t>(json_int_field(body, "value", LVM_TRIGGER_TIME_TRIGGER));
        ret = lvm_set_param(session->device, LVM_CAPTURE_PARAM);
      }
    } else if (_stricmp(key.c_str(), "DivRatio") == 0 || _stricmp(key.c_str(), "div_ratio") == 0) {
      if (session->device->capture_param) {
        session->device->capture_param->div_ratio = static_cast<unsigned int>(json_int_field(body, "value", 4));
        ret = lvm_set_param(session->device, LVM_CAPTURE_PARAM);
      }
    } else if (_stricmp(key.c_str(), "ExposureTime") == 0 || _stricmp(key.c_str(), "expsure_time") == 0) {
      if (session->device->config_param) {
        session->device->config_param->expsure_time = json_int_field(body, "value", 0);
        ret = lvm_set_param(session->device, LVM_CONFIG_PARAM);
      }
    } else if (_stricmp(key.c_str(), "GainK") == 0 || _stricmp(key.c_str(), "gain_k") == 0) {
      if (session->device->config_param) {
        session->device->config_param->gain_k = json_float_field(body, "value", 0);
        ret = lvm_set_param(session->device, LVM_CONFIG_PARAM);
      }
    } else if (_stricmp(key.c_str(), "TimeTriggerFreq") == 0 || _stricmp(key.c_str(), "time_trigger_freq") == 0) {
      if (session->device->capture_param) {
        session->device->capture_param->time_trigger_freq = json_float_field(body, "value", 0);
        ret = lvm_set_param(session->device, LVM_CAPTURE_PARAM);
      }
    } else if (type == "float") {
      ret = lvm_set_param_float_value(session->device, key.c_str(), json_float_field(body, "value", 0));
    } else {
      ret = lvm_set_param_int_value(session->device, key.c_str(), json_int_field(body, "value", 0));
    }
    return "{\"code\":" + std::to_string(ret) + "," + json_pair("ip", session->ip) + "," + json_pair("key", key) + "}";
  }

  std::string param_save_device_json(const std::string& body) {
    std::string ip = json_string_field(body, "ip");
    bool apply_soft_trigger = json_bool_field(body, "applySoftTrigger", false);

    std::lock_guard<std::mutex> lock(mutex_);
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || !session->device) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    if (session->stream.running) {
      return json_error(409, "stream is running; stop stream before saving parameters");
    }

    int apply_ret = CORRECT;
    if (apply_soft_trigger) {
      apply_ret = apply_software_trigger(session->device);
      if (apply_ret != CORRECT) {
        std::ostringstream failed;
        failed << "{\"code\":" << apply_ret << ","
               << json_pair("ip", session->ip) << ","
               << "\"applySoftTrigger\":true,"
               << "\"saveCode\":" << INPUT_PARAMETER_ERROR << ","
               << json_pair("error", "software trigger config failed")
               << "}";
        return failed.str();
      }
    }

    int ret = lvm_save_param_to_dev(session->device);
    std::ostringstream json;
    json << "{\"code\":" << ret << ","
         << json_pair("ip", session->ip) << ","
         << "\"applySoftTrigger\":" << (apply_soft_trigger ? "true" : "false") << ","
         << "\"applySoftTriggerCode\":" << apply_ret << ","
         << "\"saveCode\":" << ret
         << "}";
    return json.str();
  }

  std::string param_save_file_json(const std::string& body) {
    std::string ip = json_string_field(body, "ip");
    std::string path_text = json_string_field(body, "path");

    std::lock_guard<std::mutex> lock(mutex_);
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || !session->device) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    if (session->stream.running) {
      return json_error(409, "stream is running; stop stream before saving parameters");
    }

    if (path_text.empty()) {
      path_text = "param-backup/" + safe_path_segment(session->ip) + "-" + timestamp_file_segment() + ".xml";
    }
    std::filesystem::path path = path_from_json_text(path_text);
    if (!path.is_absolute()) {
      path = (storage_root_ / path).lexically_normal();
    }
    if (!is_output_path_allowed_locked(path.string())) {
      return json_error(403, "parameter backup path must be under storage root");
    }
    std::error_code error;
    std::filesystem::create_directories(path.parent_path(), error);
    if (error) {
      return json_error(500, "parameter backup directory cannot be created");
    }

    std::string sdk_path = path.string();
    int ret = lvm_save_dev_param(session->device, sdk_path.c_str());
    std::ostringstream json;
    json << "{\"code\":" << ret << ","
         << json_pair("ip", session->ip) << ","
         << json_pair("path", sdk_path) << ","
         << "\"saveCode\":" << ret
         << "}";
    return json.str();
  }

  std::string param_load_file_json(const std::string& body) {
    std::string ip = json_string_field(body, "ip");
    std::string path_text = json_string_field(body, "path");
    bool apply_soft_trigger = json_bool_field(body, "applySoftTrigger", false);
    bool save_to_device = json_bool_field(body, "saveToDevice", false);
    if (path_text.empty()) {
      return json_error(400, "missing parameter file path");
    }

    std::filesystem::path path = path_from_json_text(path_text);
    if (!path.is_absolute()) {
      std::lock_guard<std::mutex> lock(mutex_);
      path = (storage_root_ / path).lexically_normal();
    }
    if (!std::filesystem::exists(path)) {
      return json_error(404, "parameter file not found");
    }

    std::lock_guard<std::mutex> lock(mutex_);
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || !session->device) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    if (session->stream.running) {
      return json_error(409, "stream is running; stop stream before loading parameters");
    }

    std::string sdk_path = path.string();
    int load_ret = lvm_load_dev_param(session->device, sdk_path.c_str());
    int apply_ret = load_ret == CORRECT && apply_soft_trigger ? apply_software_trigger(session->device) : INPUT_PARAMETER_ERROR;
    int save_ret = INPUT_PARAMETER_ERROR;
    if (load_ret == CORRECT && (!apply_soft_trigger || apply_ret == CORRECT) && save_to_device) {
      save_ret = lvm_save_param_to_dev(session->device);
    }

    int code = load_ret;
    if (code == CORRECT && apply_soft_trigger && apply_ret != CORRECT) {
      code = apply_ret;
    }
    if (code == CORRECT && save_to_device && save_ret != CORRECT) {
      code = save_ret;
    }

    std::ostringstream json;
    json << "{\"code\":" << code << ","
         << json_pair("ip", session->ip) << ","
         << json_pair("path", sdk_path) << ","
         << "\"loadCode\":" << load_ret << ","
         << "\"applySoftTrigger\":" << (apply_soft_trigger ? "true" : "false") << ","
         << "\"applySoftTriggerCode\":" << (apply_soft_trigger ? apply_ret : CORRECT) << ","
         << "\"saveToDevice\":" << (save_to_device ? "true" : "false") << ","
         << "\"saveCode\":" << (save_to_device ? save_ret : CORRECT)
         << "}";
    return json.str();
  }

  std::string param_recovery_json(const std::string& body) {
    std::string ip = json_string_field(body, "ip");

    std::lock_guard<std::mutex> lock(mutex_);
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || !session->device) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    if (session->stream.running) {
      return json_error(409, "stream is running; stop stream before recovering parameters");
    }

    int ret = lvm_recovery_param(session->device);
    std::ostringstream json;
    json << "{\"code\":" << ret << ","
         << json_pair("ip", session->ip) << ","
         << "\"recoveryCode\":" << ret
         << "}";
    return json.str();
  }

  std::string preview_capture_json(const std::string& body) {
    std::string ip = json_string_field(body, "ip");
    int lines = json_int_field(body, "lines", 1280);
    int width = json_int_field(body, "width", 0);
    int timeout_ms = json_int_field(body, "timeoutMs", 5000);
    int data_mode = json_int_field(body, "dataMode", 1);
    std::string output = json_string_field(body, "output");
    if (output.empty()) {
      output = "preview/" + safe_path_segment(ip.empty() ? "selected" : ip) + "-" + timestamp_file_segment() + ".png";
    }

    std::ostringstream capture_body;
    capture_body << "{" << json_pair("ip", ip)
                 << ",\"lines\":" << lines
                 << ",\"width\":" << width
                 << ",\"timeoutMs\":" << timeout_ms
                 << ",\"dataMode\":" << data_mode
                 << "," << json_pair("output", output)
                 << "}";
    return capture_depth_json(capture_body.str());
  }

  std::string capture_depth_json(const std::string& body) {
    std::string ip = json_string_field(body, "ip");
    int lines = json_int_field(body, "lines", 1280);
    int width = json_int_field(body, "width", 0);
    int timeout_ms = json_int_field(body, "timeoutMs", 5000);
    int data_mode = json_int_field(body, "dataMode", 1);
    std::string output = json_string_field(body, "output", "depth/capture-depth.png");

    std::lock_guard<std::mutex> lock(mutex_);
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || !session->device) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    if (session->stream.running) {
      return json_error(409, "stream is running; stop stream before blocking capture");
    }
    int trigger_ret = apply_software_trigger(session->device);
    if (trigger_ret != CORRECT) {
      return json_error(trigger_ret, "software trigger config failed");
    }

    if (width <= 0) {
      width = lvm_get_depth_map_width(session->device, lines);
    }
    if (width <= 0) {
      width = 4096;
    }

    std::string output_path = resolve_output_path_locked(output, "depth/capture-depth.png");
    if (!is_output_path_allowed_locked(output_path)) {
      return json_error(403, "output path must be under storage root");
    }
    std::filesystem::create_directories(std::filesystem::path(output_path).parent_path());

    lvm_buf_t* buffer = lvm_alloc_depth_map_buf(session->device, data_mode, width, lines, 2);
    if (!buffer) {
      return json_error(MALLOC_FAILED, "depth buffer allocation failed");
    }

    int ret = lvm_bind_buf(session->device, buffer);
    void* frame = nullptr;
    if (ret == CORRECT) {
      ret = lvm_trigger_en_ctrl(session->device, true);
    }
    if (ret == CORRECT) {
      frame = lvm_grab_frame(session->device, timeout_ms);
      ret = frame ? CORRECT : DEV_LOAD_DATA_ERROR;
    }
    if (ret == CORRECT && frame) {
      ret = lvm_save_depth_map(session->device, output_path.c_str(), static_cast<lvm_depth_map_t*>(frame));
    }
    lvm_trigger_en_ctrl(session->device, false);
    lvm_grab_stop(session->device);
    lvm_free_buf(buffer);
    if (session->device) {
      session->device->buffer = nullptr;
    }

    session->calibration.validation_path = output_path;
    session->calibration.validation_code = ret;
    session->calibration.validation_time = now_iso();

    std::ostringstream json;
    json << "{\"code\":" << ret << ",\"lines\":" << lines << ",\"width\":" << width << ","
         << json_pair("ip", session->ip) << ","
         << json_pair("output", output_path) << ","
         << json_pair("imageUrl", "/api/capture/file?path=" + url_encode(output_path)) << "}";
    return json.str();
  }

  std::string continuous_capture_test_json(const std::string& body) {
    int expected_cameras = json_int_field(body, "expectedCameras", 0);
    int rounds = std::max(1, std::min(10000, json_int_field(body, "rounds", 3)));
    int lines = json_int_field(body, "lines", 1280);
    int width = json_int_field(body, "width", 0);
    int timeout_ms = json_int_field(body, "timeoutMs", 8000);
    int data_mode = json_int_field(body, "dataMode", 1);
    int interval_ms = std::max(0, std::min(600000, json_int_field(body, "intervalMs", 500)));
    bool connect_first = json_bool_field(body, "connectFirst", true);
    bool stop_streams = json_bool_field(body, "stopStreams", true);
    std::string output_dir = json_string_field(body, "outputDir", "continuous-test");
    std::vector<std::string> ips = json_string_array_field(body, "ips");

    if (ips.empty()) {
      std::lock_guard<std::mutex> lock(mutex_);
      int discover_ret = CORRECT;
      ips = discovered_ips_locked(discover_ret);
      if (discover_ret != CORRECT) {
        return json_error(discover_ret, "camera discovery failed");
      }
    }
    if (ips.empty()) {
      return json_error(404, "no cameras available");
    }

    std::string connect_result = "{}";
    if (connect_first) {
      connect_result = connect_all_json(body);
    }
    if (stop_streams) {
      std::lock_guard<std::mutex> lock(mutex_);
      stop_all_streams_locked();
    }

    bool expected_met = expected_cameras <= 0 || static_cast<int>(ips.size()) >= expected_cameras;
    int attempts = 0;
    int successes = 0;
    int failures = 0;
    int first_error = CORRECT;
    std::ostringstream results;
    results << "[";

    for (int round = 1; round <= rounds; ++round) {
      for (size_t index = 0; index < ips.size(); ++index) {
        const std::string& ip = ips[index];
        ++attempts;
        std::ostringstream rel_output;
        rel_output << output_dir << "/" << safe_path_segment(ip)
                   << "/round-" << std::setw(3) << std::setfill('0') << round
                   << "-shot-" << std::setw(4) << std::setfill('0') << attempts
                   << ".png";

        std::ostringstream capture_body;
        capture_body << "{" << json_pair("ip", ip)
                     << ",\"lines\":" << lines
                     << ",\"width\":" << width
                     << ",\"timeoutMs\":" << timeout_ms
                     << ",\"dataMode\":" << data_mode
                     << "," << json_pair("output", rel_output.str())
                     << "}";

        std::string response = capture_depth_json(capture_body.str());
        int ret = json_int_field(response, "code", -1);
        std::string output = json_string_field(response, "output", rel_output.str());
        if (ret == CORRECT) {
          ++successes;
        } else {
          ++failures;
          if (first_error == CORRECT) {
            first_error = ret;
          }
        }

        if (attempts > 1) {
          results << ",";
        }
        results << "{\"round\":" << round
                << ",\"attempt\":" << attempts
                << ",\"code\":" << ret
                << "," << json_pair("ip", ip)
                << "," << json_pair("output", output)
                << "}";

        bool last_capture = round == rounds && index + 1 == ips.size();
        if (!last_capture && interval_ms > 0) {
          std::this_thread::sleep_for(std::chrono::milliseconds(interval_ms));
        }
      }
    }
    results << "]";

    int code = (failures == 0 && expected_met) ? CORRECT : (first_error == CORRECT ? 206 : first_error);
    std::ostringstream json;
    json << "{\"code\":" << code
         << ",\"attempts\":" << attempts
         << ",\"successes\":" << successes
         << ",\"failures\":" << failures
         << ",\"rounds\":" << rounds
         << ",\"cameraCount\":" << ips.size()
         << ",\"expectedCameras\":" << expected_cameras
         << ",\"expectedMet\":" << (expected_met ? "true" : "false")
         << ",\"connectFirst\":" << (connect_first ? "true" : "false")
         << "," << json_pair("storageRoot", storage_root_.string())
         << "," << json_pair("outputDir", output_dir)
         << ",\"connectResult\":" << connect_result
         << ",\"results\":" << results.str()
         << "}";
    return json.str();
  }

  RouteResult capture_file_response(const std::string& query) {
    std::string path = get_query_param(query, "path");
    std::filesystem::path storage_root;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      storage_root = storage_root_;
    }
    if (path.empty() || !is_path_allowed_for_read(path, storage_root)) {
      return {403, "", "image/png"};
    }
    std::string body;
    if (!read_file(path, body)) {
      return {404, "", "image/png"};
    }
    return {200, body, "image/png"};
  }

  std::string stream_start_json(const std::string& body) {
    std::string ip = json_string_field(body, "ip");
    int lines = json_int_field(body, "lines", 1280);
    int width = json_int_field(body, "width", 0);
    int data_mode = json_int_field(body, "dataMode", 1);
    bool hs = json_bool_field(body, "hs", false);
    int fps_limit = std::max(1, std::min(30, json_int_field(body, "fpsLimit", 5)));

    std::lock_guard<std::mutex> lock(mutex_);
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || !session->device) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    stop_all_streams_locked(session->ip);
    stop_stream_locked(*session);
    int trigger_ret = apply_software_trigger(session->device);
    if (trigger_ret != CORRECT) {
      return json_error(trigger_ret, "software trigger config failed");
    }
    if (width <= 0) {
      width = lvm_get_depth_map_width(session->device, lines);
    }
    if (width <= 0) {
      width = 4096;
    }
    lvm_buf_t* buffer = lvm_alloc_depth_map_buf(session->device, data_mode, width, lines, 2);
    if (!buffer) {
      return json_error(MALLOC_FAILED, "stream buffer allocation failed");
    }
    int ret = lvm_bind_buf(session->device, buffer);
    if (ret == CORRECT) {
      session->device->context = session;
      ret = lvm_enable_async_mode(session->device, hs ? 1 : 0, frame_cb);
    }
    if (ret == CORRECT) {
      session->stream = StreamState{};
      session->stream.running = true;
      session->stream.buffer = buffer;
      session->stream.lines = lines;
      session->stream.width = width;
      session->stream.data_mode = data_mode;
      session->stream.hs = hs;
      session->stream.fps_limit = fps_limit;
      session->stream.started_at = now_iso();
      session->stream.updated_at = session->stream.started_at;
      ret = lvm_trigger_en_ctrl(session->device, true);
      session->stream.code = ret;
    }
    if (ret != CORRECT) {
      if (session->device) {
        lvm_grab_stop(session->device);
      }
      lvm_free_buf(buffer);
      if (session->device) {
        session->device->buffer = nullptr;
      }
      session->stream.buffer = nullptr;
      session->stream.running = false;
      return json_error(ret, "stream start failed");
    }
    return stream_status_json_locked(*session);
  }

  std::string stream_stop_json(const std::string& body) {
    std::string ip = json_string_field(body, "ip");
    std::lock_guard<std::mutex> lock(mutex_);
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || !session->device) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    stop_stream_locked(*session);
    return stream_status_json_locked(*session);
  }

  std::string stream_status_json(const std::string& query) {
    std::string ip = get_query_param(query, "ip");
    std::lock_guard<std::mutex> lock(mutex_);
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || !session->device) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    return stream_status_json_locked(*session);
  }

  std::string stream_status_json_locked(const CameraSession& session) const {
    const StreamState& stream = session.stream;
    std::ostringstream json;
    json << "{\"code\":" << stream.code << ","
         << json_pair("ip", session.ip) << ","
         << "\"running\":" << (stream.running ? "true" : "false") << ","
         << "\"lines\":" << stream.lines << ","
         << "\"width\":" << stream.width << ","
         << "\"dataMode\":" << stream.data_mode << ","
         << "\"hs\":" << (stream.hs ? "true" : "false") << ","
         << "\"fpsLimit\":" << stream.fps_limit << ","
         << "\"frameCount\":" << stream.frame_count << ","
         << "\"fid\":" << stream.fid << ","
         << "\"sid\":" << stream.sid << ","
         << "\"lostLines\":" << stream.lost_lines << ","
         << "\"triggerMinInterval\":" << stream.trigger_min_interval << ","
         << "\"triggerMaxInterval\":" << stream.trigger_max_interval << ","
         << "\"timestamp\":" << stream.timestamp << ","
         << json_pair("startedAt", stream.started_at) << ","
         << json_pair("updatedAt", stream.updated_at) << ","
         << json_pair("latestDepthPath", stream.latest_depth_path) << ","
         << json_pair("latestIntensityPath", stream.latest_intensity_path) << ","
         << json_pair("latestDepthUrl", stream.latest_depth_path.empty() ? "" : "/api/stream/latest?kind=depth&ip=" + url_encode(session.ip)) << ","
         << json_pair("latestIntensityUrl", stream.latest_intensity_path.empty() ? "" : "/api/stream/latest?kind=intensity&ip=" + url_encode(session.ip))
         << "}";
    return json.str();
  }

  RouteResult stream_latest_response(const std::string& query) {
    std::string ip = get_query_param(query, "ip");
    std::string kind = get_query_param(query, "kind");
    if (kind.empty()) {
      kind = "depth";
    }
    std::lock_guard<std::mutex> lock(mutex_);
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || !session->device) {
      return {404, "", "image/png"};
    }
    std::string path = kind == "intensity" ? session->stream.latest_intensity_path : session->stream.latest_depth_path;
    if (path.empty() || !is_path_allowed_for_read(path, storage_root_)) {
      return {404, "", "image/png"};
    }
    std::string body;
    if (!read_file(path, body)) {
      return {404, "", "image/png"};
    }
    return {200, body, "image/png"};
  }

  std::string calibration_load_json(const std::string& body) {
    std::string ip = json_string_field(body, "ip");
    std::string path = json_string_field(body, "path");
    if (path.empty()) {
      return json_error(400, "missing calibration path");
    }
    if (!std::filesystem::exists(path)) {
      return json_error(404, "calibration file not found");
    }
    std::lock_guard<std::mutex> lock(mutex_);
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || !session->device) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    int ret = lvm_load_calib_param(session->device, path.c_str());
    session->calibration.calibration_path = path;
    session->calibration.calibration_code = ret;
    session->calibration.calibration_time = now_iso();
    return calibration_status_json_locked(*session);
  }

  std::string roi_load_json(const std::string& body) {
    std::string ip = json_string_field(body, "ip");
    std::string path = json_string_field(body, "path");
    if (path.empty()) {
      return json_error(400, "missing roi path");
    }
    if (!std::filesystem::exists(path)) {
      return json_error(404, "roi file not found");
    }
    std::lock_guard<std::mutex> lock(mutex_);
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || !session->device) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    int ret = lvm_set_roi_param(session->device, path.c_str());
    session->calibration.roi_path = path;
    session->calibration.roi_code = ret;
    session->calibration.roi_time = now_iso();
    return calibration_status_json_locked(*session);
  }

  std::string calibration_status_json(const std::string& query) {
    std::string ip = get_query_param(query, "ip");
    std::lock_guard<std::mutex> lock(mutex_);
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || !session->device) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    return calibration_status_json_locked(*session);
  }

  std::string calibration_status_json_locked(const CameraSession& session) const {
    const CalibrationState& calibration = session.calibration;
    std::ostringstream json;
    json << "{\"code\":0,"
         << json_pair("ip", session.ip) << ","
         << json_pair("calibrationPath", calibration.calibration_path) << ","
         << "\"calibrationCode\":" << calibration.calibration_code << ","
         << json_pair("calibrationTime", calibration.calibration_time) << ","
         << json_pair("roiPath", calibration.roi_path) << ","
         << "\"roiCode\":" << calibration.roi_code << ","
         << json_pair("roiTime", calibration.roi_time) << ","
         << json_pair("validationPath", calibration.validation_path) << ","
         << "\"validationCode\":" << calibration.validation_code << ","
         << json_pair("validationTime", calibration.validation_time)
         << "}";
    return json.str();
  }

  std::string ui_html() const {
    return R"STEEL(<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Steel Capture Provider</title>
  <style>
    :root { color-scheme: dark; font-family: "Microsoft YaHei UI", "Segoe UI", Arial, sans-serif; background: #0e1418; color: #eef5f7; }
    body { margin: 0; min-height: 100vh; background: #101820; }
    main { max-width: 1120px; margin: 0 auto; padding: 28px; }
    h1 { margin: 0 0 12px; font-size: 26px; }
    pre { min-height: 220px; overflow: auto; padding: 12px; border: 1px solid #2b4652; border-radius: 6px; background: #071015; white-space: pre-wrap; }
    button { height: 34px; margin-right: 8px; border: 1px solid #26a8c7; border-radius: 6px; background: #123644; color: #c9f5ff; font-weight: 800; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>Steel Capture Provider</h1>
    <button onclick="load('/health')">Health</button>
    <button onclick="load('/api/cameras')">Cameras</button>
    <button onclick="load('/api/camera/statuses')">Statuses</button>
    <pre id="out">Ready</pre>
  </main>
  <script>
    async function load(path) {
      const res = await fetch(path);
      document.getElementById('out').textContent = JSON.stringify(await res.json(), null, 2);
    }
  </script>
</body>
</html>)STEEL";
  }

  std::mutex mutex_;
  bool sdk_ready_ = false;
  std::filesystem::path storage_root_;
  std::map<std::string, CameraSession> sessions_;
};

std::string receive_body(HANDLE queue, PHTTP_REQUEST request) {
  if ((request->Flags & HTTP_REQUEST_FLAG_MORE_ENTITY_BODY_EXISTS) == 0) {
    return "";
  }
  std::string body;
  std::vector<char> buffer(8192);
  ULONG bytes_read = 0;
  for (;;) {
    ULONG result = HttpReceiveRequestEntityBody(queue, request->RequestId, 0, buffer.data(),
                                                static_cast<ULONG>(buffer.size()), &bytes_read, nullptr);
    if (result == NO_ERROR || result == ERROR_HANDLE_EOF) {
      if (bytes_read > 0) {
        body.append(buffer.data(), buffer.data() + bytes_read);
      }
      if (result == ERROR_HANDLE_EOF || bytes_read == 0) {
        break;
      }
      continue;
    }
    break;
  }
  return body;
}

void add_common_headers(HTTP_RESPONSE& response, HTTP_UNKNOWN_HEADER headers[3]) {
  headers[0].pName = "Access-Control-Allow-Origin";
  headers[0].NameLength = static_cast<USHORT>(strlen(headers[0].pName));
  headers[0].pRawValue = "*";
  headers[0].RawValueLength = 1;
  headers[1].pName = "Access-Control-Allow-Methods";
  headers[1].NameLength = static_cast<USHORT>(strlen(headers[1].pName));
  headers[1].pRawValue = "GET, POST, OPTIONS";
  headers[1].RawValueLength = static_cast<USHORT>(strlen(headers[1].pRawValue));
  headers[2].pName = "Access-Control-Allow-Headers";
  headers[2].NameLength = static_cast<USHORT>(strlen(headers[2].pName));
  headers[2].pRawValue = "Content-Type";
  headers[2].RawValueLength = static_cast<USHORT>(strlen(headers[2].pRawValue));
  response.Headers.UnknownHeaderCount = 3;
  response.Headers.pUnknownHeaders = headers;
}

void send_response(HANDLE queue, HTTP_REQUEST_ID request_id, const RouteResult& result) {
  HTTP_RESPONSE response{};
  response.StatusCode = result.status;
  response.pReason = result.status == 200 ? "OK" : (result.status == 404 ? "Not Found" : "Error");
  response.ReasonLength = static_cast<USHORT>(strlen(response.pReason));

  HTTP_KNOWN_HEADER& content_type = response.Headers.KnownHeaders[HttpHeaderContentType];
  content_type.pRawValue = result.content_type.c_str();
  content_type.RawValueLength = static_cast<USHORT>(result.content_type.size());

  HTTP_UNKNOWN_HEADER cors_headers[3]{};
  add_common_headers(response, cors_headers);

  HTTP_DATA_CHUNK chunk{};
  chunk.DataChunkType = HttpDataChunkFromMemory;
  chunk.FromMemory.pBuffer = const_cast<char*>(result.body.data());
  chunk.FromMemory.BufferLength = static_cast<ULONG>(result.body.size());
  response.EntityChunkCount = 1;
  response.pEntityChunks = &chunk;

  ULONG sent = 0;
  HttpSendHttpResponse(queue, request_id, 0, &response, nullptr, &sent, nullptr, 0, nullptr, nullptr);
}

const char* reason_phrase(USHORT status) {
  switch (status) {
    case 200: return "OK";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    default: return "Error";
  }
}

bool send_all(SOCKET socket, const char* data, size_t size) {
  size_t sent_total = 0;
  while (sent_total < size) {
    int sent = send(socket, data + sent_total, static_cast<int>(std::min<size_t>(size - sent_total, 16384)), 0);
    if (sent <= 0) {
      return false;
    }
    sent_total += static_cast<size_t>(sent);
  }
  return true;
}

void send_socket_response(SOCKET client, const RouteResult& result) {
  std::ostringstream headers;
  headers << "HTTP/1.1 " << result.status << " " << reason_phrase(result.status) << "\r\n"
          << "Content-Type: " << result.content_type << "\r\n"
          << "Content-Length: " << result.body.size() << "\r\n"
          << "Access-Control-Allow-Origin: *\r\n"
          << "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
          << "Access-Control-Allow-Headers: Content-Type\r\n"
          << "Connection: close\r\n\r\n";
  std::string header_text = headers.str();
  send_all(client, header_text.data(), header_text.size());
  if (!result.body.empty()) {
    send_all(client, result.body.data(), result.body.size());
  }
}

size_t content_length_from_request(const std::string& request) {
  std::istringstream stream(request);
  std::string line;
  while (std::getline(stream, line)) {
    if (!line.empty() && line.back() == '\r') {
      line.pop_back();
    }
    std::string lower = line;
    std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    if (lower.rfind("content-length:", 0) == 0) {
      try {
        return static_cast<size_t>(std::stoul(trim(line.substr(15))));
      } catch (...) {
        return 0;
      }
    }
  }
  return 0;
}

void handle_socket_client(SOCKET client) {
  std::string request;
  std::vector<char> buffer(8192);
  size_t header_end = std::string::npos;
  for (;;) {
    int received = recv(client, buffer.data(), static_cast<int>(buffer.size()), 0);
    if (received <= 0) {
      closesocket(client);
      return;
    }
    request.append(buffer.data(), buffer.data() + received);
    header_end = request.find("\r\n\r\n");
    if (header_end != std::string::npos) {
      break;
    }
    if (request.size() > 1024 * 1024) {
      closesocket(client);
      return;
    }
  }

  size_t body_start = header_end + 4;
  size_t content_length = content_length_from_request(request.substr(0, header_end));
  while (request.size() < body_start + content_length) {
    int received = recv(client, buffer.data(), static_cast<int>(buffer.size()), 0);
    if (received <= 0) {
      break;
    }
    request.append(buffer.data(), buffer.data() + received);
  }

  std::istringstream first_line(request.substr(0, request.find("\r\n")));
  std::string method;
  std::string raw_url;
  first_line >> method >> raw_url;
  if (method.empty()) {
    send_socket_response(client, {404, json_error(404, "bad request")});
    closesocket(client);
    return;
  }
  size_t query_pos = raw_url.find('?');
  std::string path = raw_url.substr(0, query_pos);
  std::string query = query_pos == std::string::npos ? "" : raw_url.substr(query_pos + 1);
  std::string body = request.size() > body_start ? request.substr(body_start, content_length) : "";
  RouteResult result = CaptureRuntime::instance().route(method, path, query, body);
  send_socket_response(client, result);
  closesocket(client);
}

std::wstring widen(const std::string& value) {
  if (value.empty()) return L"";
  int size = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
  std::wstring result(size - 1, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, &result[0], size);
  return result;
}

int run_socket_server(int port) {
  WSADATA data{};
  int wsa_ret = WSAStartup(MAKEWORD(2, 2), &data);
  if (wsa_ret != 0) {
    std::cerr << "WSAStartup failed: " << wsa_ret << "\n";
    return 1;
  }

  SOCKET server = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (server == INVALID_SOCKET) {
    std::cerr << "socket failed: " << WSAGetLastError() << "\n";
    WSACleanup();
    return 1;
  }

  BOOL reuse = TRUE;
  setsockopt(server, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuse), sizeof(reuse));

  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = htons(static_cast<u_short>(port));
  if (bind(server, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == SOCKET_ERROR) {
    std::cerr << "socket bind failed: " << WSAGetLastError() << "\n";
    closesocket(server);
    WSACleanup();
    return 1;
  }
  if (listen(server, SOMAXCONN) == SOCKET_ERROR) {
    std::cerr << "socket listen failed: " << WSAGetLastError() << "\n";
    closesocket(server);
    WSACleanup();
    return 1;
  }

  std::cout << "steel_capture_service socket fallback listening on http://127.0.0.1:" << port << "/\n";
  while (g_running.load()) {
    SOCKET client = accept(server, nullptr, nullptr);
    if (client == INVALID_SOCKET) {
      std::this_thread::sleep_for(std::chrono::milliseconds(25));
      continue;
    }
    std::thread(handle_socket_client, client).detach();
  }

  closesocket(server);
  WSACleanup();
  return 0;
}

int run_server(int port) {
  HTTPAPI_VERSION version = HTTPAPI_VERSION_2;
  ULONG result = HttpInitialize(version, HTTP_INITIALIZE_SERVER, nullptr);
  if (result != NO_ERROR) {
    std::cerr << "HttpInitialize failed: " << result << "\n";
    std::cerr << "Falling back to local socket HTTP server.\n";
    return run_socket_server(port);
  }

  HTTP_SERVER_SESSION_ID session = 0;
  HTTP_URL_GROUP_ID group = 0;
  HANDLE queue = nullptr;
  result = HttpCreateServerSession(version, &session, 0);
  if (result == NO_ERROR) result = HttpCreateUrlGroup(session, &group, 0);
  if (result == NO_ERROR) result = HttpCreateRequestQueue(version, nullptr, nullptr, 0, &queue);
  if (result != NO_ERROR) {
    std::cerr << "HTTP server setup failed: " << result << "\n";
    HttpTerminate(HTTP_INITIALIZE_SERVER, nullptr);
    return 1;
  }

  HTTP_BINDING_INFO binding{};
  binding.Flags.Present = 1;
  binding.RequestQueueHandle = queue;
  result = HttpSetUrlGroupProperty(group, HttpServerBindingProperty, &binding, sizeof(binding));
  if (result != NO_ERROR) {
    std::cerr << "HttpSetUrlGroupProperty failed: " << result << "\n";
    return 1;
  }

  std::string prefix_utf8 = "http://127.0.0.1:" + std::to_string(port) + "/";
  std::wstring prefix = widen(prefix_utf8);
  result = HttpAddUrlToUrlGroup(group, prefix.c_str(), 0, 0);
  if (result != NO_ERROR) {
    std::cerr << "HttpAddUrlToUrlGroup failed: " << result << "\n";
    std::cerr << "Try running as administrator or reserve the URL with netsh.\n";
    return 1;
  }

  std::cout << "steel_capture_service listening on " << prefix_utf8 << "\n";
  std::vector<char> request_buffer(sizeof(HTTP_REQUEST) + 16384);
  while (g_running.load()) {
    auto* request = reinterpret_cast<PHTTP_REQUEST>(request_buffer.data());
    RtlZeroMemory(request, request_buffer.size());
    ULONG bytes = 0;
    result = HttpReceiveHttpRequest(queue, HTTP_NULL_ID, 0, request,
                                    static_cast<ULONG>(request_buffer.size()), &bytes, nullptr);
    if (result != NO_ERROR) {
      if (result == ERROR_MORE_DATA) continue;
      std::this_thread::sleep_for(std::chrono::milliseconds(25));
      continue;
    }

    std::string method = "GET";
    if (request->Verb == HttpVerbPOST) {
      method = "POST";
    } else if (request->Verb == HttpVerbOPTIONS) {
      method = "OPTIONS";
    }
    std::string raw_url(request->pRawUrl ? request->pRawUrl : "/");
    size_t query_pos = raw_url.find('?');
    std::string path = raw_url.substr(0, query_pos);
    std::string query = query_pos == std::string::npos ? "" : raw_url.substr(query_pos + 1);
    std::string body = receive_body(queue, request);
    RouteResult route_result = CaptureRuntime::instance().route(method, path, query, body);
    send_response(queue, request->RequestId, route_result);
  }

  HttpRemoveUrlFromUrlGroup(group, prefix.c_str(), 0);
  HttpCloseRequestQueue(queue);
  HttpCloseUrlGroup(group);
  HttpCloseServerSession(session);
  HttpTerminate(HTTP_INITIALIZE_SERVER, nullptr);
  return 0;
}

}  // namespace

int run_capture_service_app(int argc, char** argv) {
  int port = 4317;
  for (int i = 1; i + 1 < argc; ++i) {
    if (std::string(argv[i]) == "--port") {
      port = std::stoi(argv[i + 1]);
    }
  }
  return run_server(port);
}
