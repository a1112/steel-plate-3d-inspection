#include <winsock2.h>
#include <ws2tcpip.h>
#include <http.h>
#include <windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
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

std::string trim(std::string value);

enum class DriverMode {
  Lvm,
  Simulated,
};

std::string driver_mode_text(DriverMode mode) {
  return mode == DriverMode::Simulated ? "simulated" : "lvm";
}

std::string driver_id_text(DriverMode mode) {
  return mode == DriverMode::Simulated ? "simulated" : "lvm-nvt";
}

DriverMode parse_driver_mode(std::string value, DriverMode fallback = DriverMode::Lvm) {
  value = trim(value);
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  if (value == "sim" || value == "simulated" || value == "simulation" || value == "offline") {
    return DriverMode::Simulated;
  }
  if (value == "lvm" || value == "sdk" || value == "real" || value == "hardware") {
    return DriverMode::Lvm;
  }
  return fallback;
}

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

std::string json_string_value(const std::string& value) {
  return "\"" + json_escape(value) + "\"";
}

std::string json_error(int code, const std::string& message) {
  return "{\"code\":" + std::to_string(code) + "," + json_pair("error", message) + "}";
}

std::string capture_error_name(int code) {
  switch (code) {
    case CORRECT: return "CORRECT";
    case DEV_LOAD_DATA_ERROR: return "DEV_LOAD_DATA_ERROR";
    case MALLOC_FAILED: return "MALLOC_FAILED";
    case INPUT_PARAMETER_ERROR: return "INPUT_PARAMETER_ERROR";
    case DEV_NOT_LINK_ERROR: return "DEV_NOT_LINK_ERROR";
    case 40065: return "LVMS_GET_DATA_TIMEOUT";
    case 409: return "STREAM_CONFLICT";
    case 500: return "IO_ERROR";
    default: return "SDK_ERROR_" + std::to_string(code);
  }
}

std::string capture_error_hint(int code) {
  switch (code) {
    case CORRECT:
      return "ok";
    case DEV_LOAD_DATA_ERROR:
    case 40065:
      return "camera accepted the configuration but no frame was returned before timeout; verify laser/array enable, trigger source is time, exposure, line count, target material, and vendor driver state";
    case MALLOC_FAILED:
      return "depth-map buffer allocation failed; reduce width/lines or restart the provider";
    case INPUT_PARAMETER_ERROR:
      return "SDK parameter structure is not available; reconnect the camera and reapply the line-continuous preset";
    case DEV_NOT_LINK_ERROR:
      return "camera is not connected; run discovery/connect before capture";
    case 409:
      return "a preview stream is running; stop preview before blocking capture";
    default:
      return "SDK returned a non-zero code; check vendor logs and the per-frame metadata file";
  }
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

std::string json_array_field(const std::string& body, const std::string& key) {
  std::string needle = "\"" + key + "\"";
  size_t key_pos = body.find(needle);
  if (key_pos == std::string::npos) {
    return "";
  }
  size_t colon = body.find(':', key_pos + needle.size());
  size_t open = body.find('[', colon == std::string::npos ? key_pos : colon);
  if (open == std::string::npos) {
    return "";
  }
  bool in_string = false;
  bool escaped = false;
  int depth = 0;
  for (size_t i = open; i < body.size(); ++i) {
    char ch = body[i];
    if (in_string) {
      if (escaped) {
        escaped = false;
      } else if (ch == '\\') {
        escaped = true;
      } else if (ch == '"') {
        in_string = false;
      }
      continue;
    }
    if (ch == '"') {
      in_string = true;
      continue;
    }
    if (ch == '[') {
      ++depth;
    } else if (ch == ']') {
      --depth;
      if (depth == 0) {
        return body.substr(open, i - open + 1);
      }
    }
  }
  return "";
}

std::vector<std::string> json_object_array_field(const std::string& body, const std::string& key) {
  std::vector<std::string> objects;
  std::string array = json_array_field(body, key);
  if (array.empty()) {
    return objects;
  }
  bool in_string = false;
  bool escaped = false;
  int depth = 0;
  size_t object_start = std::string::npos;
  for (size_t i = 0; i < array.size(); ++i) {
    char ch = array[i];
    if (in_string) {
      if (escaped) {
        escaped = false;
      } else if (ch == '\\') {
        escaped = true;
      } else if (ch == '"') {
        in_string = false;
      }
      continue;
    }
    if (ch == '"') {
      in_string = true;
      continue;
    }
    if (ch == '{') {
      if (depth == 0) {
        object_start = i;
      }
      ++depth;
    } else if (ch == '}') {
      --depth;
      if (depth == 0 && object_start != std::string::npos) {
        objects.push_back(array.substr(object_start, i - object_start + 1));
        object_start = std::string::npos;
      }
    }
  }
  return objects;
}

struct JsonFieldSpan {
  size_t field_start = std::string::npos;
  size_t value_start = std::string::npos;
  size_t value_end = std::string::npos;
};

std::string read_json_string_token(const std::string& body, size_t quote, size_t* end_quote = nullptr) {
  std::string out;
  bool escaped = false;
  for (size_t i = quote + 1; i < body.size(); ++i) {
    char ch = body[i];
    if (escaped) {
      switch (ch) {
        case '\\': out.push_back('\\'); break;
        case '"': out.push_back('"'); break;
        case '/': out.push_back('/'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        default: out.push_back(ch); break;
      }
      escaped = false;
      continue;
    }
    if (ch == '\\') {
      escaped = true;
      continue;
    }
    if (ch == '"') {
      if (end_quote) {
        *end_quote = i;
      }
      return out;
    }
    out.push_back(ch);
  }
  return out;
}

JsonFieldSpan top_level_json_field_span(const std::string& body, const std::string& key) {
  JsonFieldSpan span;
  bool in_string = false;
  bool escaped = false;
  int object_depth = 0;
  int array_depth = 0;
  for (size_t i = 0; i < body.size(); ++i) {
    char ch = body[i];
    if (in_string) {
      if (escaped) {
        escaped = false;
      } else if (ch == '\\') {
        escaped = true;
      } else if (ch == '"') {
        in_string = false;
      }
      continue;
    }
    if (ch == '"') {
      if (object_depth == 1 && array_depth == 0) {
        size_t key_end = i;
        std::string found_key = read_json_string_token(body, i, &key_end);
        size_t cursor = key_end + 1;
        while (cursor < body.size() && std::isspace(static_cast<unsigned char>(body[cursor]))) {
          ++cursor;
        }
        if (cursor < body.size() && body[cursor] == ':' && found_key == key) {
          size_t value_start = cursor + 1;
          while (value_start < body.size() && std::isspace(static_cast<unsigned char>(body[value_start]))) {
            ++value_start;
          }
          size_t value_end = value_start;
          if (value_start < body.size() && (body[value_start] == '{' || body[value_start] == '[')) {
            char open = body[value_start];
            char close = open == '{' ? '}' : ']';
            int depth = 0;
            bool value_string = false;
            bool value_escaped = false;
            for (size_t j = value_start; j < body.size(); ++j) {
              char value_ch = body[j];
              if (value_string) {
                if (value_escaped) {
                  value_escaped = false;
                } else if (value_ch == '\\') {
                  value_escaped = true;
                } else if (value_ch == '"') {
                  value_string = false;
                }
                continue;
              }
              if (value_ch == '"') {
                value_string = true;
                continue;
              }
              if (value_ch == open) {
                ++depth;
              } else if (value_ch == close) {
                --depth;
                if (depth == 0) {
                  value_end = j + 1;
                  break;
                }
              }
            }
          } else if (value_start < body.size() && body[value_start] == '"') {
            size_t quote_end = value_start;
            read_json_string_token(body, value_start, &quote_end);
            value_end = quote_end + 1;
          } else {
            value_end = body.find_first_of(",}", value_start);
            if (value_end == std::string::npos) {
              value_end = body.size();
            }
          }
          span.field_start = i;
          span.value_start = value_start;
          span.value_end = value_end;
          return span;
        }
        i = key_end;
      } else {
        in_string = true;
      }
      continue;
    }
    if (ch == '{') {
      ++object_depth;
    } else if (ch == '}') {
      --object_depth;
    } else if (ch == '[') {
      ++array_depth;
    } else if (ch == ']') {
      --array_depth;
    }
  }
  return span;
}

std::string json_raw_field(const std::string& body, const std::string& key, const std::string& fallback = "") {
  JsonFieldSpan span = top_level_json_field_span(body, key);
  if (span.value_start == std::string::npos || span.value_end == std::string::npos || span.value_end <= span.value_start) {
    return fallback;
  }
  return trim(body.substr(span.value_start, span.value_end - span.value_start));
}

std::string set_top_level_json_field(std::string body, const std::string& key, const std::string& value_fragment) {
  body = trim(body);
  if (body.empty()) {
    body = "{}";
  }
  JsonFieldSpan span = top_level_json_field_span(body, key);
  if (span.field_start != std::string::npos) {
    size_t erase_start = span.field_start;
    size_t erase_end = span.value_end;
    while (erase_end < body.size() && std::isspace(static_cast<unsigned char>(body[erase_end]))) {
      ++erase_end;
    }
    if (erase_end < body.size() && body[erase_end] == ',') {
      ++erase_end;
    } else {
      size_t leading = erase_start;
      while (leading > 0 && std::isspace(static_cast<unsigned char>(body[leading - 1]))) {
        --leading;
      }
      if (leading > 0 && body[leading - 1] == ',') {
        erase_start = leading - 1;
      }
    }
    body.erase(erase_start, erase_end - erase_start);
  }
  size_t close = body.find_last_of('}');
  if (close == std::string::npos) {
    body = "{}";
    close = body.find_last_of('}');
  }
  std::string prefix = body.substr(0, close);
  std::string suffix = body.substr(close);
  bool needs_comma = prefix.find_first_not_of(" \r\n\t{") != std::string::npos;
  std::ostringstream field;
  if (needs_comma) {
    field << ",";
  }
  field << "\n  \"" << json_escape(key) << "\":" << value_fragment;
  return prefix + field.str() + suffix;
}

std::map<std::string, std::string> json_camera_files_field(const std::string& body) {
  std::map<std::string, std::string> files;
  for (const std::string& object : json_object_array_field(body, "cameraFiles")) {
    std::string ip = json_string_field(object, "ip");
    std::string path = json_string_field(object, "path", json_string_field(object, "file"));
    if (!ip.empty() && !path.empty()) {
      files[ip] = path;
    }
  }
  return files;
}

std::map<std::string, std::string> json_profile_camera_files_field(const std::string& profile) {
  std::map<std::string, std::string> files;
  for (const std::string& object : json_object_array_field(profile, "cameras")) {
    std::string ip = json_string_field(object, "ip");
    std::string source = json_string_field(object, "paramSource", json_bool_field(object, "useDeviceParams", false) ? "device" : "");
    std::string file = json_string_field(object, "paramFile");
    if (!ip.empty() && !file.empty() && source == "file") {
      files[ip] = file;
    }
  }
  return files;
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

std::filesystem::path default_config_root_path() {
  const char* env_root = std::getenv("CAPTURE_CONFIG_ROOT");
  if (env_root && *env_root) {
    return absolute_normalized_path(env_root);
  }
  const char* local_app_data = std::getenv("LOCALAPPDATA");
  if (local_app_data && *local_app_data) {
    return (std::filesystem::path(local_app_data) / "SteelCapture" / "config").lexically_normal();
  }
  return (default_storage_root_path() / "config").lexically_normal();
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

bool file_exists(const std::string& path) {
  if (path.empty()) {
    return false;
  }
  std::error_code error;
  const std::filesystem::path candidate(path);
  return std::filesystem::exists(candidate, error) && std::filesystem::is_regular_file(candidate, error);
}

bool copy_file_replace(const std::string& source, const std::string& target) {
  if (source.empty() || target.empty()) {
    return false;
  }
  std::filesystem::path source_path(source);
  std::filesystem::path target_path(target);
  if (source_path.lexically_normal() == target_path.lexically_normal()) {
    return file_exists(target);
  }
  std::error_code error;
  std::filesystem::create_directories(target_path.parent_path(), error);
  if (error) {
    return false;
  }
  std::filesystem::copy_file(source_path, target_path, std::filesystem::copy_options::overwrite_existing, error);
  return !error && file_exists(target);
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

  void configure(DriverMode mode) {
    std::lock_guard<std::mutex> lock(mutex_);
    driver_mode_ = mode;
    load_active_profile_settings_locked(true);
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
    if (method == "POST" && path == "/api/config/profile/import") return {200, config_profile_import_json(body)};
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
    if (method == "POST" && path == "/api/capture/preset/line-continuous") return {200, capture_line_continuous_preset_json(body)};
    if (method == "POST" && (path == "/api/preview/capture" || path == "/api/capture/preview")) return {200, preview_capture_json(body)};
    if (method == "POST" && path == "/api/capture/depth-map") return {200, capture_depth_json(body)};
    if (method == "POST" && path == "/api/capture/continuous-test") return {200, continuous_capture_test_json(body)};
    if (method == "GET" && path == "/api/capture/file") return capture_file_response(query);
    if (method == "GET" && path == "/api/steel/status") return {200, steel_status_json()};
    if (method == "POST" && path == "/api/steel/event") return {200, steel_event_json(body)};
    if (method == "POST" && path == "/api/stream/start") return {200, stream_start_json(body)};
    if (method == "POST" && path == "/api/stream/stop") return {200, stream_stop_json(body)};
    if (method == "GET" && path == "/api/stream/status") return {200, stream_status_json(query)};
    if (method == "GET" && path == "/api/stream/latest") return stream_latest_response(query);
    if (method == "POST" && path == "/api/calibration/load") return {200, calibration_load_json(body)};
    if (method == "POST" && path == "/api/calibration/apply-all") return {200, calibration_apply_all_json(body)};
    if (method == "GET" && path == "/api/calibration/active") return {200, calibration_active_json(query)};
    if (method == "POST" && path == "/api/calibration/active") return {200, calibration_active_save_json(body)};
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
    std::string model;
    std::string sn;
    bool simulated = false;
    bool simulated_connected = false;
    int simulated_device_id = -1;
    int dev_type = -1;
    int exposure_time = 50;
    float gain_k = 1.0f;
    float time_trigger_freq = 300.0f;
    std::map<std::string, std::string> params;
    StreamState stream;
    CalibrationState calibration;
    std::shared_ptr<std::mutex> capture_mutex = std::make_shared<std::mutex>();
  };

  struct SteelState {
    bool present = false;
    std::string phase = "idle";
    std::string steel_id;
    std::string steel_type;
    double length = 0.0;
    double width = 0.0;
    double thickness = 0.0;
    std::string client;
    std::string hard;
    std::string session_id;
    std::string capture_dir;
    std::string summary_path;
    std::string session_started_at;
    std::string session_finished_at;
    std::string last_capture_at;
    std::string last_capture_ip;
    std::string last_capture_output;
    std::string in_time;
    std::string out_time;
    std::string info_time;
    std::string updated_at = now_iso();
    int in_count = 0;
    int out_count = 0;
    int event_count = 0;
    int capture_count = 0;
    int capture_success_count = 0;
    int capture_failure_count = 0;
  };

  CaptureRuntime() : storage_root_(default_storage_root_path()), config_root_(default_config_root_path()) {}
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
      if (item.second.device || item.second.simulated_connected) {
        return &item.second;
      }
    }
    return nullptr;
  }

  int apply_software_trigger(lvm_dev_t* device, int control_mode = 0, int trigger_lines = 0) {
    if (!device || !device->capture_param) {
      return INPUT_PARAMETER_ERROR;
    }
    device->capture_param->capture_data_type = LVM_BT_DEPTH_INTENSITY;
    device->capture_param->ctrl_type = SOFTWARE_CTRL;
    device->capture_param->ctrl_mode = static_cast<unsigned int>(std::max(0, control_mode));
    device->capture_param->trigger_input_type = LVM_TRIGGER_TIME_TRIGGER;
    device->capture_param->div_ratio = 4;
    if (trigger_lines > 0) {
      device->capture_param->trigger_number_per_ctrl = static_cast<unsigned int>(trigger_lines);
    }
    if (device->capture_param->time_trigger_freq <= 0.0f) {
      device->capture_param->time_trigger_freq = 300.0f;
    }
    return lvm_set_param(device, LVM_CAPTURE_PARAM);
  }

  int apply_line_continuous_preset(lvm_dev_t* device,
                                   int lines = 1000,
                                   float time_trigger_freq = 300.0f,
                                   int laser_power = 100,
                                   int laser_line_select = 0,
                                   int control_mode = 0) {
    if (!device) {
      return INPUT_PARAMETER_ERROR;
    }
    int first_error = CORRECT;
    auto remember = [&](int ret) {
      if (ret != CORRECT && first_error == CORRECT) {
        first_error = ret;
      }
    };
    if (device->capture_param) {
      device->capture_param->capture_data_type = LVM_BT_DEPTH_INTENSITY;
      device->capture_param->ctrl_type = SOFTWARE_CTRL;
      device->capture_param->ctrl_mode = static_cast<unsigned int>(std::max(0, control_mode));
      device->capture_param->trigger_input_type = LVM_TRIGGER_TIME_TRIGGER;
      device->capture_param->time_trigger_freq = time_trigger_freq > 0 ? time_trigger_freq : 300.0f;
      device->capture_param->div_ratio = 4;
      device->capture_param->trigger_number_per_ctrl = static_cast<unsigned int>(std::max(1, lines));
      remember(lvm_set_param(device, LVM_CAPTURE_PARAM));
    } else {
      remember(INPUT_PARAMETER_ERROR);
    }
    if (device->laser_param) {
      device->laser_param->laser_enable = 1;
      device->laser_param->array_enable = 1;
      device->laser_param->laser_power = std::max(0, std::min(100, laser_power));
      device->laser_param->laser_line_select = std::max(0, std::min(2, laser_line_select));
      remember(lvm_set_param(device, LVM_LASER_PARAM));
    }
    return first_error;
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

  std::string sibling_output_path(const std::string& output_path, const std::string& suffix, const std::string& extension) const {
    std::filesystem::path path(output_path);
    std::string stem = path.stem().string();
    path.replace_filename(stem + suffix + extension);
    return path.lexically_normal().string();
  }

  struct CaptureOutputPaths {
    std::string requested_path;
    std::string base_dir;
    std::string depth_path;
    std::string intensity_path;
    std::string metadata_path;
    std::string sdk_base_path;
    std::string sdk_depth_path;
    std::string sdk_intensity_path;
  };

  CaptureOutputPaths capture_output_paths_for(const std::string& output_path) const {
    std::filesystem::path requested(output_path);
    std::filesystem::path base_dir = requested.parent_path();
    const std::string parent_name = base_dir.filename().string();
    const bool data_name_layout = parent_name == "depth" || parent_name == "intensity" || parent_name == "metadata" || parent_name == "sdk-derived";
    if (parent_name == "depth" || parent_name == "intensity" || parent_name == "metadata" || parent_name == "sdk-derived") {
      base_dir = base_dir.parent_path();
    }

    const std::string stem = requested.stem().string().empty() ? "capture" : requested.stem().string();
    CaptureOutputPaths paths;
    paths.requested_path = requested.lexically_normal().string();
    paths.base_dir = base_dir.lexically_normal().string();
    if (data_name_layout) {
      paths.depth_path = (base_dir / "depth" / (stem + ".png")).lexically_normal().string();
      paths.intensity_path = (base_dir / "intensity" / (stem + ".png")).lexically_normal().string();
      paths.metadata_path = (base_dir / "metadata" / (stem + ".json")).lexically_normal().string();
    } else {
      paths.depth_path = (base_dir / "depth" / (stem + "_depthMap.png")).lexically_normal().string();
      paths.intensity_path = (base_dir / "intensity" / (stem + "_intensity.png")).lexically_normal().string();
      paths.metadata_path = (base_dir / "metadata" / (stem + "_metadata.json")).lexically_normal().string();
    }
    paths.sdk_base_path = (base_dir / "sdk-derived" / (stem + ".png")).lexically_normal().string();
    paths.sdk_depth_path = sibling_output_path(paths.sdk_base_path, "_depthMap", ".png");
    paths.sdk_intensity_path = sibling_output_path(paths.sdk_base_path, "_intensityMap", ".png");
    return paths;
  }

  bool create_capture_output_dirs(const CaptureOutputPaths& paths) const {
    std::error_code error;
    std::filesystem::create_directories(std::filesystem::path(paths.depth_path).parent_path(), error);
    if (error) return false;
    std::filesystem::create_directories(std::filesystem::path(paths.intensity_path).parent_path(), error);
    if (error) return false;
    std::filesystem::create_directories(std::filesystem::path(paths.metadata_path).parent_path(), error);
    if (error) return false;
    std::filesystem::create_directories(std::filesystem::path(paths.sdk_base_path).parent_path(), error);
    return !error;
  }

  int write_capture_metadata_locked(const std::string& metadata_path,
                                    const CameraSession& session,
                                    int code,
                                    int attempt_count,
                                    int requested_width,
                                    int requested_lines,
                                    int actual_width,
                                    int actual_lines,
                                    int data_mode,
                                    int timeout_ms,
                                    const std::string& depth_path,
                                    const std::string& intensity_path,
                                    int fid,
                                    int sid,
                                    int lost_lines,
                                    unsigned int trigger_min_interval,
                                    unsigned int trigger_max_interval,
                                    unsigned int timestamp,
                                    bool simulated) const {
    if (metadata_path.empty()) {
      return CORRECT;
    }
    std::string model = session.model;
    std::string sn = session.sn;
    if (session.device && session.device->dev_info) {
      if (model.empty()) {
        model = session.device->dev_info->device_name;
      }
      if (sn.empty()) {
        sn = session.device->dev_info->sn;
      }
    }
    std::ostringstream json;
    json << "{"
         << "\"schema\":\"steel.capture.frame.v1\","
         << json_pair("time", now_iso()) << ","
         << json_pair("ip", session.ip) << ","
         << json_pair("model", model) << ","
         << json_pair("sn", sn) << ","
         << "\"code\":" << code << ","
         << json_pair("errorName", capture_error_name(code)) << ","
         << json_pair("operatorHint", capture_error_hint(code)) << ","
         << "\"attempts\":" << attempt_count << ","
         << "\"simulated\":" << (simulated ? "true" : "false") << ","
         << "\"requestedWidth\":" << requested_width << ","
         << "\"requestedLines\":" << requested_lines << ","
         << "\"width\":" << actual_width << ","
         << "\"lines\":" << actual_lines << ","
         << "\"dataMode\":" << data_mode << ","
         << "\"timeoutMs\":" << timeout_ms << ","
         << "\"fid\":" << fid << ","
         << "\"sid\":" << sid << ","
         << "\"lostLines\":" << lost_lines << ","
         << "\"triggerMinInterval\":" << trigger_min_interval << ","
         << "\"triggerMaxInterval\":" << trigger_max_interval << ","
         << "\"timestamp\":" << timestamp << ","
         << json_pair("depthPath", depth_path) << ","
         << json_pair("intensityPath", intensity_path) << ","
         << "\"captureConfig\":" << capture_config_json_for_session(&session)
         << "}";
    return write_text_file(metadata_path, json.str()) ? CORRECT : 500;
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
    return config_root_.lexically_normal();
  }

  std::filesystem::path profiles_root_locked() const {
    return (config_root_locked() / "profiles").lexically_normal();
  }

  std::filesystem::path camera_params_root_locked() const {
    return (config_root_locked() / "camera-params").lexically_normal();
  }

  std::filesystem::path calibrations_root_locked() const {
    return (config_root_locked() / "calibrations").lexically_normal();
  }

  std::filesystem::path calibration_profile_root_locked(const std::string& profile_name) const {
    return (calibrations_root_locked() / normalize_profile_name(profile_name)).lexically_normal();
  }

  std::filesystem::path active_profile_path_locked() const {
    return (config_root_locked() / "active-profile.txt").lexically_normal();
  }

  void ensure_config_dirs_locked() const {
    std::error_code error;
    std::filesystem::create_directories(config_root_locked(), error);
    error.clear();
    std::filesystem::create_directories(profiles_root_locked(), error);
    error.clear();
    std::filesystem::create_directories(camera_params_root_locked(), error);
    error.clear();
    std::filesystem::create_directories(calibrations_root_locked(), error);
  }

  std::string normalize_profile_name(const std::string& name) const {
    std::string trimmed = trim(name);
    return safe_path_segment(trimmed.empty() ? "default" : trimmed);
  }

  std::filesystem::path profile_path_locked(const std::string& name) const {
    return (profile_dir_locked(name) / "profile.json").lexically_normal();
  }

  std::filesystem::path profile_dir_locked(const std::string& name) const {
    return (profiles_root_locked() / normalize_profile_name(name)).lexically_normal();
  }

  std::filesystem::path legacy_profile_path_locked(const std::string& name) const {
    return (profiles_root_locked() / (normalize_profile_name(name) + ".json")).lexically_normal();
  }

  std::filesystem::path legacy_storage_profile_path_locked(const std::string& name) const {
    return (storage_root_ / "config" / "profiles" / (normalize_profile_name(name) + ".json")).lexically_normal();
  }

  std::filesystem::path existing_profile_path_locked(const std::string& name) const {
    std::filesystem::path folder_path = profile_path_locked(name);
    std::error_code error;
    if (std::filesystem::exists(folder_path, error)) {
      return folder_path;
    }
    error.clear();
    std::filesystem::path legacy_path = legacy_profile_path_locked(name);
    if (std::filesystem::exists(legacy_path, error)) {
      return legacy_path;
    }
    error.clear();
    std::filesystem::path old_storage_path = legacy_storage_profile_path_locked(name);
    if (std::filesystem::exists(old_storage_path, error)) {
      return old_storage_path;
    }
    return folder_path;
  }

  void sync_existing_legacy_profile_locked(const std::string& name, const std::string& content) const {
    std::vector<std::filesystem::path> paths = {
        legacy_profile_path_locked(name),
        legacy_storage_profile_path_locked(name),
    };
    std::vector<std::string> seen;
    for (const auto& path : paths) {
      const std::string key = path.lexically_normal().string();
      if (std::find(seen.begin(), seen.end(), key) != seen.end()) {
        continue;
      }
      seen.push_back(key);
      std::error_code error;
      if (std::filesystem::exists(path, error)) {
        write_text_file(path, content);
      }
    }
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
      std::filesystem::path path = entry.path();
      if (entry.is_directory() && std::filesystem::exists(path / "profile.json")) {
        names.push_back(path.filename().string());
      } else if (entry.is_regular_file() && path.extension() == ".json") {
        names.push_back(path.stem().string());
      }
    }
    std::filesystem::path legacy_root = storage_root_ / "config" / "profiles";
    error.clear();
    if (std::filesystem::exists(legacy_root, error)) {
      for (const auto& entry : std::filesystem::directory_iterator(legacy_root, error)) {
        if (error) {
          break;
        }
        if (entry.is_regular_file() && entry.path().extension() == ".json") {
          names.push_back(entry.path().stem().string());
        }
      }
    }
    std::sort(names.begin(), names.end());
    names.erase(std::unique(names.begin(), names.end()), names.end());
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
      return (profile_dir_locked(profile_name) / "camera-params").lexically_normal();
    }
    std::filesystem::path dir = path_from_json_text(dir_text);
    if (!dir.is_absolute()) {
      dir = (storage_root_ / dir).lexically_normal();
    }
    return dir.lexically_normal();
  }

  std::filesystem::path provider_path_locked(const std::string& text) const {
    std::filesystem::path path = path_from_json_text(text);
    if (path.is_absolute()) {
      return path.lexically_normal();
    }
    return (storage_root_ / path).lexically_normal();
  }

  bool is_config_or_storage_path_locked(const std::filesystem::path& path) const {
    return is_path_under_base(path.string(), storage_root_) || is_path_under_base(path.string(), config_root_);
  }

  std::string profile_path_text_locked(const std::filesystem::path& path) const {
    std::error_code error;
    if (is_path_under_base(path.string(), storage_root_)) {
      std::filesystem::path relative = std::filesystem::relative(path, storage_root_, error);
      if (!error) {
        return relative.generic_string();
      }
    }
    return path.lexically_normal().string();
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
         << json_pair("driverMode", driver_mode_text(driver_mode_)) << ","
         << json_pair("storageRoot", storage_root_.string()) << ","
         << json_pair("configRoot", config_root_locked().string()) << ","
         << json_pair("profileRoot", profiles_root_locked().string()) << ","
         << json_pair("profileDir", profile_dir_locked(profile_name).string()) << ","
         << json_pair("cameraParamDir", (profile_dir_locked(profile_name) / "camera-params").lexically_normal().string()) << ","
         << json_pair("startupMode", "auto-connect") << ","
         << "\"autoConnect\":true,"
         << "\"expectedCameras\":" << expected_cameras_ << ","
         << "\"devType\":-1,"
         << "\"applySoftTrigger\":true,"
         << "\"loadCameraParams\":false,"
         << "\"saveToDevice\":false,"
         << "\"lines\":1000,"
         << "\"width\":0,"
         << "\"timeoutMs\":8000,"
         << "\"dataMode\":3,"
         << "\"fpsLimit\":5,"
         << "\"captureDataType\":" << static_cast<int>(LVM_BT_DEPTH_INTENSITY) << ","
         << "\"controlMode\":0,"
         << "\"triggerInputType\":" << static_cast<int>(LVM_TRIGGER_TIME_TRIGGER) << ","
         << "\"divRatio\":4,"
         << "\"timeTriggerFreq\":300,"
         << "\"laserEnable\":true,"
         << "\"arrayEnable\":true,"
         << "\"laserPower\":100,"
         << "\"laserLineSelect\":0,"
         << "\"exposureTime\":50,"
         << "\"gainK\":1.0,"
         << "\"cameraDefaults\":{"
         << "\"controlMode\":0,"
         << "\"triggerInputType\":" << static_cast<int>(LVM_TRIGGER_TIME_TRIGGER) << ","
         << "\"divRatio\":4,"
         << "\"timeTriggerFreq\":300,"
         << "\"laserEnable\":true,"
         << "\"arrayEnable\":true,"
         << "\"laserPower\":100,"
         << "\"exposureTime\":50,"
         << "\"gainK\":1.0"
         << "},"
         << "\"simulated\":{"
         << json_pair("imageSourceDir", simulated_image_source_dir_)
         << "},"
         << "\"cameras\":" << cameras.str()
         << "}";
    return json.str();
  }

  std::string profile_entries_array_json_locked() const {
    std::vector<std::string> names = profile_names_locked();
    std::ostringstream json;
    json << "[";
    for (size_t i = 0; i < names.size(); ++i) {
      if (i > 0) {
        json << ",";
      }
      std::string name = normalize_profile_name(names[i]);
      std::filesystem::path path = existing_profile_path_locked(name);
      std::string profile;
      std::string mode = "-";
      if (read_file(path.string(), profile)) {
        mode = json_string_field(profile, "driverMode", "-");
      }
      json << "{"
           << json_pair("name", name) << ","
           << json_pair("driverMode", mode) << ","
           << json_pair("path", path.string()) << ","
           << json_pair("folder", profile_dir_locked(name).string()) << ","
           << "\"active\":" << (active_profile_name_locked() == name ? "true" : "false") << ","
           << json_pair("format", path.filename() == "profile.json" ? "folder" : "legacy-json")
           << "}";
    }
    json << "]";
    return json.str();
  }

  std::string config_status_json() {
    std::lock_guard<std::mutex> lock(mutex_);
    ensure_config_dirs_locked();
    std::ostringstream json;
    json << "{\"code\":0,"
         << json_pair("driverMode", driver_mode_text(driver_mode_)) << ","
         << json_pair("driverId", driver_id_text(driver_mode_)) << ","
         << json_pair("storageRoot", storage_root_.string()) << ","
         << json_pair("configRoot", config_root_locked().string()) << ","
         << json_pair("profileRoot", profiles_root_locked().string()) << ","
         << json_pair("cameraParamRoot", camera_params_root_locked().string()) << ","
         << json_pair("activeProfile", active_profile_name_locked()) << ","
         << "\"profiles\":" << profile_names_array_json_locked() << ","
         << "\"profileEntries\":" << profile_entries_array_json_locked()
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
    std::filesystem::path path = existing_profile_path_locked(name);
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
    std::error_code dir_error;
    std::filesystem::create_directories(profile_dir_locked(name) / "camera-params", dir_error);
    dir_error.clear();
    std::filesystem::create_directories(profile_dir_locked(name) / "sim-images", dir_error);
    dir_error.clear();
    std::filesystem::create_directories(profile_dir_locked(name) / "captures", dir_error);
    if (!write_text_file(path, content)) {
      return json_error(500, "profile cannot be saved");
    }
    sync_existing_legacy_profile_locked(name, content);
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

  std::string config_profile_import_json(const std::string& body) {
    std::string source_text = json_string_field(body, "path", json_string_field(body, "source"));
    if (source_text.empty()) {
      return json_error(400, "missing import path");
    }
    bool overwrite = json_bool_field(body, "overwrite", false);
    bool make_active = json_bool_field(body, "makeActive", false);
    std::filesystem::path source = absolute_normalized_path(path_from_json_text(source_text));
    std::error_code error;
    if (!std::filesystem::exists(source, error)) {
      return json_error(404, "import path not found");
    }

    std::filesystem::path source_profile;
    if (std::filesystem::is_directory(source, error)) {
      source_profile = source / "profile.json";
      if (!std::filesystem::exists(source_profile, error)) {
        for (const auto& entry : std::filesystem::directory_iterator(source, error)) {
          if (entry.is_regular_file() && entry.path().extension() == ".json") {
            source_profile = entry.path();
            break;
          }
        }
      }
    } else {
      source_profile = source;
    }
    if (!std::filesystem::exists(source_profile, error)) {
      return json_error(404, "profile json not found in import path");
    }

    std::string content;
    if (!read_file(source_profile.string(), content)) {
      return json_error(500, "profile json cannot be read");
    }
    std::string name = normalize_profile_name(json_string_field(body, "name", json_string_field(content, "name", source.stem().string())));

    std::lock_guard<std::mutex> lock(mutex_);
    ensure_config_dirs_locked();
    std::filesystem::path destination = profile_dir_locked(name);
    if (std::filesystem::exists(destination, error) && !overwrite) {
      return json_error(409, "profile already exists");
    }
    if (overwrite) {
      std::filesystem::remove_all(destination, error);
      error.clear();
    }
    std::filesystem::create_directories(destination, error);
    if (error) {
      return json_error(500, "profile directory cannot be created");
    }

    if (std::filesystem::is_directory(source, error)) {
      std::filesystem::copy(source, destination,
                            std::filesystem::copy_options::recursive |
                                std::filesystem::copy_options::overwrite_existing,
                            error);
      if (error) {
        return json_error(500, "profile directory cannot be copied");
      }
    }
    if (!write_text_file(profile_path_locked(name), content)) {
      return json_error(500, "profile json cannot be imported");
    }
    sync_existing_legacy_profile_locked(name, content);
    std::filesystem::create_directories(destination / "camera-params", error);
    error.clear();
    std::filesystem::create_directories(destination / "sim-images", error);
    error.clear();
    std::filesystem::create_directories(destination / "captures", error);
    if (make_active) {
      write_active_profile_locked(name);
    }

    std::ostringstream json;
    json << "{\"code\":0,"
         << json_pair("name", name) << ","
         << json_pair("path", profile_path_locked(name).string()) << ","
         << json_pair("folder", destination.string()) << ","
         << "\"active\":" << (active_profile_name_locked() == name ? "true" : "false")
         << "}";
    return json.str();
  }

  void apply_profile_runtime_settings_locked(const std::string& profile, bool change_storage) {
    driver_mode_ = parse_driver_mode(json_string_field(profile, "driverMode", driver_mode_text(driver_mode_)), driver_mode_);
    expected_cameras_ = std::max(1, std::min(24, json_int_field(profile, "expectedCameras", expected_cameras_)));
    simulated_image_source_dir_ = json_string_field(profile, "imageSourceDir", simulated_image_source_dir_);
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
  }

  void load_active_profile_settings_locked(bool change_storage) {
    ensure_config_dirs_locked();
    std::string active = active_profile_name_locked();
    std::string profile;
    if (read_file(existing_profile_path_locked(active).string(), profile)) {
      apply_profile_runtime_settings_locked(profile, change_storage);
    }
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

    int profile_control_mode = json_int_field(profile, "controlMode", 0);
    int profile_lines = json_int_field(profile, "lines", 0);
    if (json_bool_field(profile, "applySoftTrigger", true)) {
      remember(apply_software_trigger(device, profile_control_mode, profile_lines));
    }

    if (device->capture_param) {
      bool changed = false;
      if (json_has_field(profile, "captureDataType")) {
        device->capture_param->capture_data_type =
            static_cast<lvm_buf_type_t>(json_int_field(profile, "captureDataType", LVM_BT_DEPTH_INTENSITY));
        changed = true;
      }
      if (json_has_field(profile, "controlMode")) {
        device->capture_param->ctrl_mode = static_cast<unsigned int>(profile_control_mode);
        changed = true;
      }
      if (json_has_field(profile, "lines")) {
        device->capture_param->trigger_number_per_ctrl = static_cast<unsigned int>(std::max(1, json_int_field(profile, "lines", 1000)));
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

    if (device->laser_param) {
      bool changed = false;
      if (json_has_field(profile, "laserEnable")) {
        device->laser_param->laser_enable = json_bool_field(profile, "laserEnable", true) ? 1 : 0;
        changed = true;
      }
      if (json_has_field(profile, "arrayEnable")) {
        device->laser_param->array_enable = json_bool_field(profile, "arrayEnable", true) ? 1 : 0;
        changed = true;
      }
      if (json_has_field(profile, "laserPower")) {
        device->laser_param->laser_power = std::max(0, std::min(100, json_int_field(profile, "laserPower", 100)));
        changed = true;
      }
      if (json_has_field(profile, "laserLineSelect")) {
        device->laser_param->laser_line_select = std::max(0, std::min(2, json_int_field(profile, "laserLineSelect", 0)));
        changed = true;
      }
      if (changed) {
        remember(lvm_set_param(device, LVM_LASER_PARAM));
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
    if (session.simulated) {
      if (!session.model.empty()) {
        candidates.push_back(dir / (safe_path_segment(session.model) + ".nccfg"));
        candidates.push_back(dir / (safe_path_segment(session.model) + ".xml"));
      }
      if (!session.sn.empty()) {
        candidates.push_back(dir / (safe_path_segment(session.sn) + ".nccfg"));
        candidates.push_back(dir / (safe_path_segment(session.sn) + ".xml"));
      }
    }
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
    std::lock_guard<std::mutex> lock(mutex_);
    return config_camera_params_save_all_locked(body);
  }

  std::string config_camera_params_save_all_locked(const std::string& body) {
    std::string profile_name = normalize_profile_name(json_string_field(body, "name", json_string_field(body, "profile", active_profile_name_locked())));
    bool apply_soft_trigger = json_bool_field(body, "applySoftTrigger", true);
    int control_mode = json_int_field(body, "controlMode", 0);
    int lines = json_int_field(body, "lines", 0);
    bool save_to_device = json_bool_field(body, "saveToDevice", false);
    std::vector<std::string> ips = json_string_array_field(body, "ips");

    ensure_config_dirs_locked();
    std::filesystem::path dir = camera_param_dir_locked(body, profile_name);
    if (!is_path_under_base(dir.string(), storage_root_) && !is_path_under_base(dir.string(), config_root_)) {
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
      int apply_ret = session.simulated ? CORRECT : (apply_soft_trigger ? apply_software_trigger(session.device, control_mode, lines) : CORRECT);
      std::filesystem::path file = dir / (safe_path_segment(session.ip) + ".nccfg");
      int save_file_ret = apply_ret;
      if (apply_ret == CORRECT) {
        if (session.simulated) {
          std::ostringstream body;
          body << "{"
               << json_pair("driverId", "simulated") << ","
               << json_pair("ip", session.ip) << ","
               << json_pair("savedAt", now_iso()) << ","
               << "\"exposureTime\":" << session.exposure_time << ","
               << "\"gainK\":" << session.gain_k << ","
               << "\"timeTriggerFreq\":" << session.time_trigger_freq
               << "}";
          save_file_ret = write_text_file(file, body.str()) ? CORRECT : 500;
        } else {
          save_file_ret = lvm_save_dev_param(session.device, file.string().c_str());
        }
      }
      int save_dev_ret = (save_file_ret == CORRECT && save_to_device && !session.simulated) ? lvm_save_param_to_dev(session.device) : CORRECT;
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
    int control_mode = json_int_field(body, "controlMode", 0);
    int lines = json_int_field(body, "lines", 0);
    bool save_to_device = json_bool_field(body, "saveToDevice", false);
    bool allow_external = json_bool_field(body, "allowExternal", false);
    std::vector<std::string> ips = json_string_array_field(body, "ips");
    std::map<std::string, std::string> camera_files = json_camera_files_field(body);

    ensure_config_dirs_locked();
    std::filesystem::path dir = camera_param_dir_locked(body, profile_name);
    if (!is_path_under_base(dir.string(), storage_root_) && !is_path_under_base(dir.string(), config_root_)) {
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
      int path_ret = CORRECT;
      auto file_it = camera_files.find(session.ip);
      if (file_it != camera_files.end()) {
        file = path_from_json_text(file_it->second);
        if (!file.is_absolute()) {
          file = (storage_root_ / file).lexically_normal();
        }
        const bool external_path = !is_path_under_base(file.string(), storage_root_) && !is_path_under_base(file.string(), config_root_);
        if (external_path && !allow_external) {
          path_ret = 403;
        } else {
          std::error_code exists_error;
          if (!std::filesystem::exists(file, exists_error)) {
            path_ret = 404;
          }
        }
      } else {
        for (const auto& candidate : camera_param_candidates_locked(dir, session)) {
          std::error_code exists_error;
          if (std::filesystem::exists(candidate, exists_error)) {
            file = candidate;
            break;
          }
        }
      }
      int load_ret = path_ret != CORRECT ? path_ret : (file.empty() ? 404 : (session.simulated ? CORRECT : lvm_load_dev_param(session.device, file.string().c_str())));
      int apply_ret = (load_ret == CORRECT && apply_soft_trigger && !session.simulated) ? apply_software_trigger(session.device, control_mode, lines) : CORRECT;
      int save_ret = (load_ret == CORRECT && apply_ret == CORRECT && save_to_device && !session.simulated) ? lvm_save_param_to_dev(session.device) : CORRECT;
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
              << "\"explicitFile\":" << (file_it != camera_files.end() ? "true" : "false") << ","
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
      if (profile.empty() && !read_file(existing_profile_path_locked(name).string(), profile)) {
        return json_error(404, "profile not found");
      }
    }

    bool change_storage = json_bool_field(body, "changeStorage", json_bool_field(profile, "changeStorage", false));
    bool auto_connect = json_bool_field(body, "autoConnect", json_bool_field(profile, "autoConnect", false));
    bool load_camera_params = json_bool_field(body, "loadCameraParams", json_bool_field(profile, "loadCameraParams", false));
    bool save_to_device = json_bool_field(body, "saveToDevice", json_bool_field(profile, "saveToDevice", false));
    bool allow_external = json_bool_field(body, "allowExternal", false);
    int expected_cameras = json_int_field(body, "expectedCameras", json_int_field(profile, "expectedCameras", expected_cameras_));
    int dev_type = json_int_field(body, "devType", json_int_field(profile, "devType", -1));
    std::vector<std::string> load_ips = json_string_array_field(body, "ips");
    std::map<std::string, std::string> camera_files = json_camera_files_field(body);
    if (camera_files.empty()) {
      camera_files = json_profile_camera_files_field(profile);
    }

    std::lock_guard<std::mutex> lock(mutex_);
    if (active_capture_batches_ > 0) {
      return json_error(409, "capture batch is running");
    }
    DriverMode previous_mode = driver_mode_;
    apply_profile_runtime_settings_locked(profile, change_storage);
    expected_cameras_ = std::max(1, std::min(24, expected_cameras));
    if (driver_mode_ != previous_mode) {
      clear_sessions_locked();
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
      int ret = item.second.simulated ? CORRECT : (item.second.stream.running ? 409 : apply_profile_params_locked(item.second.device, profile));
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
      if (load_ips.empty() && !camera_files.empty()) {
        for (const auto& item : camera_files) {
          load_ips.push_back(item.first);
        }
      }
      std::ostringstream load_body;
      load_body << "{"
                << json_pair("name", name) << ","
                << json_pair("cameraParamDir", json_string_field(profile, "cameraParamDir", "config/camera-params/" + name)) << ","
                << "\"applySoftTrigger\":" << (json_bool_field(profile, "applySoftTrigger", true) ? "true" : "false") << ","
                << "\"saveToDevice\":" << (save_to_device ? "true" : "false") << ","
                << "\"allowExternal\":" << (allow_external ? "true" : "false");
      if (!load_ips.empty()) {
        load_body << ",\"ips\":[";
        for (size_t i = 0; i < load_ips.size(); ++i) {
          if (i > 0) {
            load_body << ",";
          }
          load_body << "\"" << json_escape(load_ips[i]) << "\"";
        }
        load_body << "]";
      }
      if (!camera_files.empty()) {
        load_body << ",\"cameraFiles\":[";
        bool first_file = true;
        for (const auto& item : camera_files) {
          if (!first_file) {
            load_body << ",";
          }
          first_file = false;
          load_body << "{"
                    << json_pair("ip", item.first) << ","
                    << json_pair("path", item.second)
                    << "}";
        }
        load_body << "]";
      }
      load_body
                << "}";
      load_result = config_camera_params_load_all_locked(load_body.str());
      int load_code = json_int_field(load_result, "code", CORRECT);
      if (load_code != CORRECT && first_error == CORRECT) {
        first_error = load_code;
      }
    } else if (save_to_device) {
      for (auto& item : sessions_) {
        int ret = item.second.simulated ? CORRECT : lvm_save_param_to_dev(item.second.device);
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
    if (driver_mode_ == DriverMode::Simulated) {
      ret = CORRECT;
      for (int i = 0; i < expected_cameras_; ++i) {
        ips.push_back(simulated_ip_for_index(i));
        if (models) {
          models->push_back("SIM-LVM-3D");
        }
        if (sns) {
          char sn_buffer[32]{};
          snprintf(sn_buffer, sizeof(sn_buffer), "SIM-%03d", i + 1);
          sns->push_back(sn_buffer);
        }
      }
      return ips;
    }
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

  std::string simulated_ip_for_index(int index) const {
    return "192.168.200." + std::to_string(101 + index);
  }

  int simulated_index_for_ip(const std::string& ip) const {
    const std::string prefix = "192.168.200.";
    if (ip.rfind(prefix, 0) != 0) {
      return 0;
    }
    try {
      return std::max(0, std::stoi(ip.substr(prefix.size())) - 101);
    } catch (...) {
      return 0;
    }
  }

  int connect_one_locked(const std::string& ip, int dev_type, bool* already_connected = nullptr) {
    if (already_connected) {
      *already_connected = false;
    }
    if (active_capture_batches_ > 0) {
      return 409;
    }
    CameraSession* existing = session_for_ip_locked(ip);
    if (existing && existing->simulated && existing->simulated_connected) {
      if (already_connected) {
        *already_connected = true;
      }
      return CORRECT;
    }
    if (existing && existing->device && lvm_get_dev_connect_status(existing->device) == 1) {
      if (already_connected) {
        *already_connected = true;
      }
      existing->device->context = existing;
      return CORRECT;
    }
    destroy_session_locked(ip);

    if (driver_mode_ == DriverMode::Simulated) {
      int index = simulated_index_for_ip(ip);
      char sn_buffer[32]{};
      snprintf(sn_buffer, sizeof(sn_buffer), "SIM-%03d", index + 1);
      CameraSession session{};
      session.ip = ip.empty() ? simulated_ip_for_index(0) : ip;
      session.model = "SIM-LVM-3D";
      session.sn = sn_buffer;
      session.simulated = true;
      session.simulated_connected = true;
      session.simulated_device_id = index + 1;
      session.dev_type = dev_type;
      session.params["TriggerMode"] = "0";
      session.params["ControlMode"] = "0";
      session.params["TriggerInputType"] = std::to_string(static_cast<int>(LVM_TRIGGER_TIME_TRIGGER));
      session.params["CaptureDataType"] = std::to_string(static_cast<int>(LVM_BT_DEPTH_INTENSITY));
      session.params["DivRatio"] = "4";
      session.params["ExposureTime"] = "50";
      session.params["GainK"] = "1.000000";
      session.params["TimeTriggerFreq"] = "300.000000";
      sessions_[session.ip] = session;
      return CORRECT;
    }

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
    if (session.simulated) {
      session.stream.running = false;
      return;
    }
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

  void clear_sessions_locked() {
    for (auto& item : sessions_) {
      stop_stream_locked(item.second);
      if (item.second.device) {
        lvm_disconnect_dev(item.second.device);
        lvm_destroy_dev(item.second.device);
      }
    }
    sessions_.clear();
  }

  std::string capture_config_json_for_session(const CameraSession* session) const {
    std::ostringstream json;
    json << "{";
    if (!session) {
      json << "\"available\":false";
    } else if (session->simulated) {
      auto param_or = [&](const std::string& key, const std::string& fallback) {
        auto found = session->params.find(key);
        return found == session->params.end() ? fallback : found->second;
      };
      json << "\"available\":true,"
           << "\"controlMode\":" << param_or("ControlMode", "0") << ","
           << "\"triggerInputType\":" << param_or("TriggerInputType", "4") << ","
           << "\"captureDataType\":" << param_or("CaptureDataType", std::to_string(static_cast<int>(LVM_BT_DEPTH_INTENSITY))) << ","
           << "\"triggerLines\":" << param_or("TriggerLines", "1000") << ","
           << "\"timeTriggerFreq\":" << session->time_trigger_freq << ","
           << "\"exposureTime\":" << session->exposure_time << ","
           << "\"gainK\":" << session->gain_k << ","
           << "\"laserEnable\":" << param_or("LaserEnable", "1") << ","
           << "\"arrayEnable\":" << param_or("ArrayEnable", "1") << ","
           << "\"laserPower\":" << param_or("LaserPower", "100") << ","
           << "\"laserLineSelect\":" << param_or("LaserLineSelect", "0") << ","
           << json_pair("controlLabel", "continuous") << ","
           << json_pair("triggerSourceLabel", "time");
    } else if (session->device) {
      const auto* capture = session->device->capture_param;
      const auto* config = session->device->config_param;
      const auto* laser = session->device->laser_param;
      json << "\"available\":" << (capture || config || laser ? "true" : "false");
      if (capture) {
        int control_mode = static_cast<int>(capture->ctrl_mode);
        int trigger_source = static_cast<int>(capture->trigger_input_type);
        std::string control_label = control_mode == 0 ? "continuous" : (control_mode == 2 ? "count-mode" : (control_mode == 3 ? "count-priority" : "level/common"));
        std::string trigger_label = trigger_source == static_cast<int>(LVM_TRIGGER_TIME_TRIGGER) ? "time" : ("type-" + std::to_string(trigger_source));
        json << ",\"controlMode\":" << control_mode
             << ",\"ctrlType\":" << static_cast<int>(capture->ctrl_type)
             << ",\"triggerInputType\":" << trigger_source
             << ",\"captureDataType\":" << static_cast<int>(capture->capture_data_type)
             << ",\"triggerLines\":" << static_cast<int>(capture->trigger_number_per_ctrl)
             << ",\"divRatio\":" << static_cast<int>(capture->div_ratio)
             << ",\"timeTriggerFreq\":" << capture->time_trigger_freq
             << "," << json_pair("controlLabel", control_label)
             << "," << json_pair("triggerSourceLabel", trigger_label);
      }
      if (config) {
        json << ",\"exposureTime\":" << config->expsure_time
             << ",\"gainK\":" << config->gain_k;
      }
      if (laser) {
        json << ",\"laserEnable\":" << laser->laser_enable
             << ",\"arrayEnable\":" << laser->array_enable
             << ",\"laserPower\":" << laser->laser_power
             << ",\"laserLineSelect\":" << laser->laser_line_select;
      }
    } else {
      json << "\"available\":false";
    }
    json << "}";
    return json.str();
  }

  std::string status_json_for_session(const CameraSession* session, const std::string& ip) const {
    if (driver_mode_ == DriverMode::Simulated || (session && session->simulated)) {
      std::string effective_ip = session ? session->ip : (ip.empty() ? simulated_ip_for_index(0) : ip);
      int index = simulated_index_for_ip(effective_ip);
      bool connected = session ? session->simulated_connected : false;
      std::ostringstream json;
      json << "{\"connected\":" << (connected ? "true" : "false")
           << ",\"deviceId\":" << (session ? session->simulated_device_id : -1) << ","
           << json_pair("ip", effective_ip) << ","
           << json_pair("driverId", "simulated") << ","
           << json_pair("model", session && !session->model.empty() ? session->model : "SIM-LVM-3D") << ","
           << json_pair("sn", session && !session->sn.empty() ? session->sn : ("SIM-" + std::string(index + 1 < 10 ? "00" : index + 1 < 100 ? "0" : "") + std::to_string(index + 1))) << ","
           << json_pair("source", "simulated") << ","
           << json_pair("acquisitionState", connected ? (session && session->stream.running ? "realtime-preview" : "connected") : "discovered") << ","
           << json_pair("sdkStatus", "simulation") << ","
           << "\"task\":1,\"status\":0,\"linkHealth\":100,"
           << "\"temperatureJ28\":" << (35.0 + index * 0.4) << ","
           << "\"temperatureJ29\":" << (35.6 + index * 0.4) << ","
           << "\"temperatureJ30\":" << (36.1 + index * 0.4) << ","
           << "\"lostPulseCounter\":0,\"bufferOverflowCounter\":0";
      if (session) {
        json << ",\"streamRunning\":" << (session->stream.running ? "true" : "false")
             << ",\"streamFrames\":" << session->stream.frame_count;
      }
      json << ",\"captureConfig\":" << capture_config_json_for_session(session);
      json << "}";
      return json.str();
    }
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
           << ",\"streamFrames\":" << session->stream.frame_count
           << ",\"captureConfig\":" << capture_config_json_for_session(session);
    }
    json << "}";
    return json.str();
  }

  std::string health_json() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (driver_mode_ == DriverMode::Simulated) {
      int connected_count = 0;
      std::string first_ip;
      for (const auto& item : sessions_) {
        if (item.second.simulated_connected) {
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
           << "\"sdkReady\":true,"
           << "\"sdkCode\":0,"
           << "\"connected\":" << (connected_count > 0 ? "true" : "false") << ","
           << json_pair("ip", first_ip) << ","
           << json_pair("driverMode", "simulated") << ","
           << json_pair("driverId", "simulated") << ","
           << json_pair("driverName", "Simulated 3D Camera Driver") << ","
           << json_pair("storageRoot", storage_root_.string()) << ","
           << json_pair("configRoot", config_root_locked().string()) << ","
           << "\"cameraCount\":" << connected_count << ","
           << "\"expectedCameras\":" << expected_cameras_
           << "}";
      return json.str();
    }
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
         << json_pair("driverMode", driver_mode_text(driver_mode_)) << ","
         << json_pair("driverId", "lvm-nvt") << ","
         << json_pair("driverName", "LVM/NVT 3D Camera SDK") << ","
         << json_pair("storageRoot", storage_root_.string()) << ","
         << json_pair("configRoot", config_root_locked().string()) << ","
         << "\"cameraCount\":" << connected_count
         << "}";
    return json.str();
  }

  std::string cameras_json() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (driver_mode_ == DriverMode::Simulated) {
      std::ostringstream json;
      json << "{\"code\":0,\"count\":" << expected_cameras_ << ",\"driverMode\":\"simulated\",\"cameras\":[";
      for (int i = 0; i < expected_cameras_; ++i) {
        if (i > 0) json << ",";
        char sn_buffer[32]{};
        snprintf(sn_buffer, sizeof(sn_buffer), "SIM-%03d", i + 1);
        json << "{"
             << json_pair("ip", simulated_ip_for_index(i)) << ","
             << json_pair("model", "SIM-LVM-3D") << ","
             << json_pair("sn", sn_buffer) << ","
             << json_pair("driverId", "simulated") << ","
             << json_pair("source", "simulated")
             << "}";
      }
      json << "]}";
      return json.str();
    }
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
    if (driver_mode_ != DriverMode::Simulated) {
      int sdk_ret = ensure_sdk();
      if (!(sdk_ret == CORRECT || sdk_ret == SDK_REPEATED_INIT)) {
        return "{\"code\":" + std::to_string(sdk_ret) + ",\"connected\":false}";
      }
    }

    std::string ip = json_string_field(body, "ip", "192.168.10.13");
    if (driver_mode_ == DriverMode::Simulated && ip == "192.168.10.13") {
      ip = simulated_ip_for_index(0);
    }
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
    if (driver_mode_ != DriverMode::Simulated) {
      int sdk_ret = ensure_sdk();
      if (!(sdk_ret == CORRECT || sdk_ret == SDK_REPEATED_INIT)) {
        return "{\"code\":" + std::to_string(sdk_ret) + ",\"connected\":0,\"results\":[]}";
      }
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
    if (active_capture_batches_ > 0) {
      return json_error(409, "capture batch is running");
    }
    std::string ip = json_string_field(body, "ip");
    int ret = CORRECT;
    if (!ip.empty()) {
      auto found = sessions_.find(ip);
      if (found != sessions_.end()) {
        stop_stream_locked(found->second);
        if (found->second.device) {
          ret = lvm_disconnect_dev(found->second.device);
          lvm_destroy_dev(found->second.device);
        }
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
    if (driver_mode_ == DriverMode::Simulated) {
      std::vector<std::string> statuses;
      for (const auto& item : sessions_) {
        statuses.push_back(status_json_for_session(&item.second, item.first));
      }
      for (int i = 0; i < expected_cameras_; ++i) {
        std::string ip = simulated_ip_for_index(i);
        if (sessions_.find(ip) == sessions_.end()) {
          statuses.push_back(status_json_for_session(nullptr, ip));
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
    if (!session || (!session->device && !session->simulated)) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    if (session->simulated) {
      std::string value;
      if (_stricmp(key.c_str(), "ExposureTime") == 0 || _stricmp(key.c_str(), "expsure_time") == 0) {
        value = std::to_string(session->exposure_time);
      } else if (_stricmp(key.c_str(), "GainK") == 0 || _stricmp(key.c_str(), "gain_k") == 0) {
        value = std::to_string(session->gain_k);
      } else if (_stricmp(key.c_str(), "TimeTriggerFreq") == 0 || _stricmp(key.c_str(), "time_trigger_freq") == 0) {
        value = std::to_string(session->time_trigger_freq);
      } else {
        auto found = session->params.find(key);
        value = found == session->params.end() ? "0" : found->second;
      }
      if (type == "string") {
        return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + "," + json_pair("value", value) + "}";
      }
      return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" + value + "}";
    }
    if ((_stricmp(key.c_str(), "TriggerMode") == 0 || _stricmp(key.c_str(), "ctrl_type") == 0) && session->device->capture_param) {
      return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" +
             std::to_string(static_cast<int>(session->device->capture_param->ctrl_type)) + "," + json_pair("label", "software-trigger") + "}";
    }
    if ((_stricmp(key.c_str(), "ControlMode") == 0 || _stricmp(key.c_str(), "ctrl_mode") == 0) && session->device->capture_param) {
      int mode = static_cast<int>(session->device->capture_param->ctrl_mode);
      std::string label = mode == 0 ? "continuous" : (mode == 2 ? "count-mode" : (mode == 3 ? "count-priority" : "level/common"));
      return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" +
             std::to_string(mode) + "," + json_pair("label", label) + "}";
    }
    if ((_stricmp(key.c_str(), "TriggerInputType") == 0 || _stricmp(key.c_str(), "trigger_input_type") == 0) && session->device->capture_param) {
      return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" +
             std::to_string(static_cast<int>(session->device->capture_param->trigger_input_type)) + "," + json_pair("label", "time-trigger") + "}";
    }
    if ((_stricmp(key.c_str(), "DivRatio") == 0 || _stricmp(key.c_str(), "div_ratio") == 0) && session->device->capture_param) {
      return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" +
             std::to_string(static_cast<int>(session->device->capture_param->div_ratio)) + "}";
    }
    if ((_stricmp(key.c_str(), "CaptureDataType") == 0 || _stricmp(key.c_str(), "capture_data_type") == 0) && session->device->capture_param) {
      return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" +
             std::to_string(static_cast<int>(session->device->capture_param->capture_data_type)) + "}";
    }
    if ((_stricmp(key.c_str(), "TriggerLines") == 0 || _stricmp(key.c_str(), "ControlLineNum") == 0 ||
         _stricmp(key.c_str(), "trigger_number_per_ctrl") == 0) && session->device->capture_param) {
      return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" +
             std::to_string(static_cast<int>(session->device->capture_param->trigger_number_per_ctrl)) + "}";
    }
    if ((_stricmp(key.c_str(), "LaserEnable") == 0 || _stricmp(key.c_str(), "laser_enable") == 0) && session->device->laser_param) {
      return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" +
             std::to_string(session->device->laser_param->laser_enable) + "}";
    }
    if ((_stricmp(key.c_str(), "ArrayEnable") == 0 || _stricmp(key.c_str(), "array_enable") == 0) && session->device->laser_param) {
      return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" +
             std::to_string(session->device->laser_param->array_enable) + "}";
    }
    if ((_stricmp(key.c_str(), "LaserPower") == 0 || _stricmp(key.c_str(), "laser_power") == 0) && session->device->laser_param) {
      return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" +
             std::to_string(session->device->laser_param->laser_power) + "}";
    }
    if ((_stricmp(key.c_str(), "LaserLineSelect") == 0 || _stricmp(key.c_str(), "laser_line_select") == 0) && session->device->laser_param) {
      return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + ",\"value\":" +
             std::to_string(session->device->laser_param->laser_line_select) + "}";
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
    if (!session || (!session->device && !session->simulated)) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    if (session->simulated) {
      std::string value = json_string_field(body, "value");
      if (value.empty() && type != "string") {
        value = type == "float" ? std::to_string(json_float_field(body, "value", 0)) : std::to_string(json_int_field(body, "value", 0));
      }
      if (_stricmp(key.c_str(), "ExposureTime") == 0 || _stricmp(key.c_str(), "expsure_time") == 0) {
        session->exposure_time = json_int_field(body, "value", session->exposure_time);
        value = std::to_string(session->exposure_time);
      } else if (_stricmp(key.c_str(), "GainK") == 0 || _stricmp(key.c_str(), "gain_k") == 0) {
        session->gain_k = json_float_field(body, "value", session->gain_k);
        value = std::to_string(session->gain_k);
      } else if (_stricmp(key.c_str(), "TimeTriggerFreq") == 0 || _stricmp(key.c_str(), "time_trigger_freq") == 0) {
        session->time_trigger_freq = json_float_field(body, "value", session->time_trigger_freq);
        value = std::to_string(session->time_trigger_freq);
      }
      session->params[key] = value;
      return "{\"code\":0," + json_pair("ip", session->ip) + "," + json_pair("key", key) + "}";
    }
    int ret = INPUT_PARAMETER_ERROR;
    if (_stricmp(key.c_str(), "TriggerMode") == 0 || _stricmp(key.c_str(), "ctrl_type") == 0) {
      ret = apply_software_trigger(session->device, 0);
    } else if (_stricmp(key.c_str(), "ControlMode") == 0 || _stricmp(key.c_str(), "ctrl_mode") == 0) {
      if (session->device->capture_param) {
        session->device->capture_param->ctrl_mode = static_cast<unsigned int>(json_int_field(body, "value", 0));
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
    } else if (_stricmp(key.c_str(), "CaptureDataType") == 0 || _stricmp(key.c_str(), "capture_data_type") == 0) {
      if (session->device->capture_param) {
        session->device->capture_param->capture_data_type = static_cast<lvm_buf_type_t>(json_int_field(body, "value", LVM_BT_DEPTH_INTENSITY));
        ret = lvm_set_param(session->device, LVM_CAPTURE_PARAM);
      }
    } else if (_stricmp(key.c_str(), "TriggerLines") == 0 || _stricmp(key.c_str(), "ControlLineNum") == 0 ||
               _stricmp(key.c_str(), "trigger_number_per_ctrl") == 0) {
      if (session->device->capture_param) {
        session->device->capture_param->trigger_number_per_ctrl = static_cast<unsigned int>(std::max(1, json_int_field(body, "value", 1000)));
        ret = lvm_set_param(session->device, LVM_CAPTURE_PARAM);
      }
    } else if (_stricmp(key.c_str(), "LaserEnable") == 0 || _stricmp(key.c_str(), "laser_enable") == 0) {
      if (session->device->laser_param) {
        session->device->laser_param->laser_enable = json_int_field(body, "value", 1);
        ret = lvm_set_param(session->device, LVM_LASER_PARAM);
      }
    } else if (_stricmp(key.c_str(), "ArrayEnable") == 0 || _stricmp(key.c_str(), "array_enable") == 0) {
      if (session->device->laser_param) {
        session->device->laser_param->array_enable = json_int_field(body, "value", 1);
        ret = lvm_set_param(session->device, LVM_LASER_PARAM);
      }
    } else if (_stricmp(key.c_str(), "LaserPower") == 0 || _stricmp(key.c_str(), "laser_power") == 0) {
      if (session->device->laser_param) {
        session->device->laser_param->laser_power = std::max(0, std::min(100, json_int_field(body, "value", 100)));
        ret = lvm_set_param(session->device, LVM_LASER_PARAM);
      }
    } else if (_stricmp(key.c_str(), "LaserLineSelect") == 0 || _stricmp(key.c_str(), "laser_line_select") == 0) {
      if (session->device->laser_param) {
        session->device->laser_param->laser_line_select = std::max(0, std::min(2, json_int_field(body, "value", 0)));
        ret = lvm_set_param(session->device, LVM_LASER_PARAM);
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

  std::string capture_line_continuous_preset_json(const std::string& body) {
    int lines = std::max(1, json_int_field(body, "lines", 1000));
    float time_trigger_freq = json_float_field(body, "timeTriggerFreq", 300.0f);
    int laser_power = json_int_field(body, "laserPower", 100);
    int laser_line_select = json_int_field(body, "laserLineSelect", 0);
    int control_mode = json_int_field(body, "controlMode", 0);
    bool connect_first = json_bool_field(body, "connectFirst", false);
    bool save_to_device = json_bool_field(body, "saveToDevice", false);
    std::vector<std::string> ips = json_string_array_field(body, "ips");

    if (connect_first) {
      connect_all_json(body);
    }

    std::lock_guard<std::mutex> lock(mutex_);
    int applied = 0;
    int failed = 0;
    int first_error = CORRECT;
    std::ostringstream results;
    results << "[";
    bool first = true;
    for (auto& item : sessions_) {
      CameraSession& session = item.second;
      if (!ips.empty() && std::find(ips.begin(), ips.end(), session.ip) == ips.end()) {
        continue;
      }
      if (!session.device && !session.simulated) {
        continue;
      }
      if (!first) {
        results << ",";
      }
      first = false;
      int ret = session.simulated ? CORRECT : apply_line_continuous_preset(session.device, lines, time_trigger_freq, laser_power, laser_line_select, control_mode);
      int save_ret = (ret == CORRECT && save_to_device && !session.simulated) ? lvm_save_param_to_dev(session.device) : CORRECT;
      int code = ret == CORRECT ? save_ret : ret;
      if (code == CORRECT) {
        ++applied;
      } else {
        ++failed;
        if (first_error == CORRECT) {
          first_error = code;
        }
      }
      results << "{\"code\":" << code << ","
              << json_pair("ip", session.ip) << ","
              << "\"controlMode\":" << control_mode << ","
              << "\"triggerInputType\":" << static_cast<int>(LVM_TRIGGER_TIME_TRIGGER) << ","
              << "\"captureDataType\":" << static_cast<int>(LVM_BT_DEPTH_INTENSITY) << ","
              << "\"lines\":" << lines << ","
              << "\"timeTriggerFreq\":" << time_trigger_freq << ","
              << "\"laserPower\":" << std::max(0, std::min(100, laser_power)) << ","
              << "\"saveDeviceCode\":" << (save_to_device ? save_ret : CORRECT)
              << "}";
    }
    results << "]";
    int code = failed == 0 ? CORRECT : first_error;
    std::ostringstream json;
    json << "{\"code\":" << code
         << ",\"applied\":" << applied
         << ",\"failed\":" << failed
         << ",\"lines\":" << lines
         << ",\"controlMode\":" << control_mode
         << ",\"timeTriggerFreq\":" << time_trigger_freq
         << ",\"laserPower\":" << std::max(0, std::min(100, laser_power))
         << ",\"results\":" << results.str()
         << "}";
    return json.str();
  }

  std::string param_save_device_json(const std::string& body) {
    std::string ip = json_string_field(body, "ip");
    bool apply_soft_trigger = json_bool_field(body, "applySoftTrigger", false);
    int control_mode = json_int_field(body, "controlMode", 0);
    int lines = json_int_field(body, "lines", 0);

    std::lock_guard<std::mutex> lock(mutex_);
    if (active_capture_batches_ > 0) {
      return json_error(409, "capture batch is running");
    }
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || (!session->device && !session->simulated)) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    if (session->stream.running) {
      return json_error(409, "stream is running; stop stream before saving parameters");
    }

    int apply_ret = CORRECT;
    if (apply_soft_trigger) {
      apply_ret = session->simulated ? CORRECT : apply_software_trigger(session->device, control_mode, lines);
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

    int ret = session->simulated ? CORRECT : lvm_save_param_to_dev(session->device);
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
    if (!session || (!session->device && !session->simulated)) {
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
    int ret = CORRECT;
    if (session->simulated) {
      std::ostringstream body_text;
      body_text << "{"
                << json_pair("driverId", "simulated") << ","
                << json_pair("ip", session->ip) << ","
                << json_pair("savedAt", now_iso()) << ","
                << "\"exposureTime\":" << session->exposure_time << ","
                << "\"gainK\":" << session->gain_k << ","
                << "\"timeTriggerFreq\":" << session->time_trigger_freq
                << "}";
      ret = write_text_file(path, body_text.str()) ? CORRECT : 500;
    } else {
      ret = lvm_save_dev_param(session->device, sdk_path.c_str());
    }
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
    int control_mode = json_int_field(body, "controlMode", 0);
    int lines = json_int_field(body, "lines", 0);
    bool save_to_device = json_bool_field(body, "saveToDevice", false);
    bool allow_external = json_bool_field(body, "allowExternal", false);
    if (path_text.empty()) {
      return json_error(400, "missing parameter file path");
    }

    std::filesystem::path path = path_from_json_text(path_text);
    bool external_path = false;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!path.is_absolute()) {
        path = (storage_root_ / path).lexically_normal();
      }
      external_path = !is_path_under_base(path.string(), storage_root_) && !is_path_under_base(path.string(), config_root_);
      if (external_path && !allow_external) {
        return json_error(403, "external parameter files require allowExternal=true; copy the file under storage/config for normal operation");
      }
    }
    if (!std::filesystem::exists(path)) {
      return json_error(404, "parameter file not found");
    }

    std::lock_guard<std::mutex> lock(mutex_);
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || (!session->device && !session->simulated)) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    if (session->stream.running) {
      return json_error(409, "stream is running; stop stream before loading parameters");
    }

    std::string sdk_path = path.string();
    int load_ret = session->simulated ? CORRECT : lvm_load_dev_param(session->device, sdk_path.c_str());
    int apply_ret = load_ret == CORRECT && apply_soft_trigger && !session->simulated ? apply_software_trigger(session->device, control_mode, lines) : CORRECT;
    int save_ret = INPUT_PARAMETER_ERROR;
    if (load_ret == CORRECT && (!apply_soft_trigger || apply_ret == CORRECT) && save_to_device && !session->simulated) {
      save_ret = lvm_save_param_to_dev(session->device);
    } else if (session->simulated || !save_to_device) {
      save_ret = CORRECT;
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
         << "\"saveCode\":" << (save_to_device ? save_ret : CORRECT) << ","
         << "\"external\":" << (external_path ? "true" : "false")
         << "}";
    return json.str();
  }

  std::string param_recovery_json(const std::string& body) {
    std::string ip = json_string_field(body, "ip");

    std::lock_guard<std::mutex> lock(mutex_);
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || (!session->device && !session->simulated)) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    if (session->stream.running) {
      return json_error(409, "stream is running; stop stream before recovering parameters");
    }

    int ret = session->simulated ? CORRECT : lvm_recovery_param(session->device);
    std::ostringstream json;
    json << "{\"code\":" << ret << ","
         << json_pair("ip", session->ip) << ","
         << "\"recoveryCode\":" << ret
         << "}";
    return json.str();
  }

  int write_simulated_png_locked(CameraSession& session,
                                 const std::string& output_path,
                                 int width,
                                 int lines,
                                 const std::string& kind) {
    std::error_code error;
    std::filesystem::create_directories(std::filesystem::path(output_path).parent_path(), error);
    if (error) {
      return 500;
    }

    std::filesystem::path source_dir = path_from_json_text(simulated_image_source_dir_);
    if (!simulated_image_source_dir_.empty() && std::filesystem::exists(source_dir, error)) {
      std::vector<std::filesystem::path> pngs;
      for (const auto& entry : std::filesystem::directory_iterator(source_dir, error)) {
        if (entry.is_regular_file()) {
          std::string ext = entry.path().extension().string();
          std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
          if (ext == ".png") {
            pngs.push_back(entry.path());
          }
        }
      }
      std::sort(pngs.begin(), pngs.end());
      if (!pngs.empty()) {
        size_t index = static_cast<size_t>(session.stream.frame_count + simulated_index_for_ip(session.ip)) % pngs.size();
        std::filesystem::copy_file(pngs[index], output_path, std::filesystem::copy_options::overwrite_existing, error);
        if (!error) {
          return CORRECT;
        }
      }
    }

    width = width <= 0 ? 640 : width;
    lines = lines <= 0 ? 480 : lines;
    std::vector<unsigned short> pixels(static_cast<size_t>(width) * static_cast<size_t>(lines));
    int camera_offset = simulated_index_for_ip(session.ip) * 4096;
    int frame_offset = session.stream.frame_count * 257;
    int kind_offset = kind == "intensity" ? 8192 : 0;
    for (int y = 0; y < lines; ++y) {
      for (int x = 0; x < width; ++x) {
        int wave = (x * 173 + y * 97 + camera_offset + frame_offset + kind_offset) % 65535;
        int stripe = ((x / 24 + y / 18 + simulated_index_for_ip(session.ip)) % 2) ? 2400 : 0;
        pixels[static_cast<size_t>(y) * static_cast<size_t>(width) + static_cast<size_t>(x)] =
            static_cast<unsigned short>(std::min(65535, wave + stripe));
      }
    }
    return lvm_save_img(output_path.c_str(), pixels.data(), width, lines, LVM_IMAGE_FORMAT_16BIT_USHORT);
  }

  int update_simulated_stream_frame_locked(CameraSession& session) {
    if (!session.simulated || !session.stream.running) {
      return DEV_NOT_LINK_ERROR;
    }
    std::filesystem::path stream_dir = (storage_root_ / "stream").lexically_normal();
    std::string safe_ip = safe_path_segment(session.ip);
    std::string depth_path = (stream_dir / (safe_ip + "-latest-depth.png")).lexically_normal().string();
    std::string intensity_path = (stream_dir / (safe_ip + "-latest-intensity.png")).lexically_normal().string();
    int ret = write_simulated_png_locked(session, depth_path, session.stream.width, session.stream.lines, "depth");
    int intensity_ret = write_simulated_png_locked(session, intensity_path, session.stream.width, session.stream.lines, "intensity");
    if (ret == CORRECT) {
      session.stream.latest_depth_path = depth_path;
    }
    if (intensity_ret == CORRECT) {
      session.stream.latest_intensity_path = intensity_path;
    }
    session.stream.code = ret;
    session.stream.frame_count += 1;
    session.stream.fid = session.stream.frame_count;
    session.stream.sid = simulated_index_for_ip(session.ip) + 1;
    session.stream.lost_lines = 0;
    session.stream.trigger_min_interval = session.stream.fps_limit > 0 ? static_cast<unsigned int>(1000 / session.stream.fps_limit) : 0;
    session.stream.trigger_max_interval = session.stream.trigger_min_interval;
    session.stream.timestamp = static_cast<unsigned int>(GetTickCount());
    session.stream.updated_at = now_iso();
    session.stream.last_saved = std::chrono::steady_clock::now();
    return ret;
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
    int retries = std::max(0, std::min(10, json_int_field(body, "retries", 0)));
    int control_mode = json_int_field(body, "controlMode", 0);
    bool explicit_output = json_has_field(body, "output");
    std::string output = json_string_field(body, "output", "");

    std::lock_guard<std::mutex> lock(mutex_);
    if (active_capture_batches_ > 0) {
      return json_error(409, "capture batch is running");
    }
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || (!session->device && !session->simulated)) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    if (session->stream.running) {
      if (!session->simulated) {
        return json_error(409, "stream is running; stop stream before blocking capture");
      }
    }
    if (!explicit_output || output.empty()) {
      std::string production_output = production_capture_output_locked(session->ip);
      output = production_output.empty() ? "depth/capture-depth.png" : production_output;
    }
    if (session->simulated) {
      if (width <= 0) {
        width = 640;
      }
      if (lines <= 0) {
        lines = 480;
      }
      std::string output_path = resolve_output_path_locked(output, "depth/capture-depth.png");
      if (!is_output_path_allowed_locked(output_path)) {
        return json_error(403, "output path must be under storage root");
      }
      CaptureOutputPaths paths = capture_output_paths_for(output_path);
      if (!create_capture_output_dirs(paths)) {
        return json_error(500, "output directory cannot be created");
      }
      std::string intensity_path = paths.intensity_path;
      int ret = write_simulated_png_locked(*session, paths.depth_path, width, lines, "depth");
      int intensity_ret = write_simulated_png_locked(*session, intensity_path, width, lines, "intensity");
      if (ret == CORRECT && intensity_ret != CORRECT) {
        intensity_path.clear();
      }
      int metadata_ret = write_capture_metadata_locked(paths.metadata_path,
                                                       *session,
                                                       ret,
                                                       1,
                                                       width,
                                                       lines,
                                                       width,
                                                       lines,
                                                       data_mode,
                                                       timeout_ms,
                                                       paths.depth_path,
                                                       intensity_path,
                                                       session->stream.frame_count + 1,
                                                       simulated_index_for_ip(session->ip) + 1,
                                                       0,
                                                       0,
                                                       0,
                                                       static_cast<unsigned int>(GetTickCount()),
                                                       true);
      session->calibration.validation_path = paths.depth_path;
      session->calibration.validation_code = ret;
      session->calibration.validation_time = now_iso();
      const bool depth_exists = file_exists(paths.depth_path);
      const bool intensity_exists = file_exists(intensity_path);
      const bool metadata_exists = metadata_ret == CORRECT && file_exists(paths.metadata_path);
      record_steel_capture_locked(session->ip, paths.depth_path, ret);
      std::ostringstream json;
      json << "{\"code\":" << ret << ",\"lines\":" << lines << ",\"width\":" << width << ","
           << "\"attempts\":1,"
           << "\"depthExists\":" << (depth_exists ? "true" : "false") << ","
           << "\"intensityExists\":" << (intensity_exists ? "true" : "false") << ","
           << "\"metadataExists\":" << (metadata_exists ? "true" : "false") << ","
           << "\"completeFrame\":" << (depth_exists && intensity_exists && metadata_exists ? "true" : "false") << ","
           << json_pair("errorName", capture_error_name(ret)) << ","
           << json_pair("operatorHint", capture_error_hint(ret)) << ","
           << json_pair("ip", session->ip) << ","
           << json_pair("output", paths.depth_path) << ","
           << json_pair("depthOutput", paths.depth_path) << ","
           << json_pair("intensityOutput", intensity_path) << ","
           << json_pair("metadataOutput", metadata_ret == CORRECT ? paths.metadata_path : "") << ","
           << json_pair("sdkOutput", "") << ","
           << json_pair("sdkDepthOutput", "") << ","
           << json_pair("sdkIntensityOutput", "") << ","
           << json_pair("imageUrl", "/api/capture/file?path=" + url_encode(paths.depth_path)) << ","
           << json_pair("depthUrl", "/api/capture/file?path=" + url_encode(paths.depth_path)) << ","
           << json_pair("intensityUrl", intensity_path.empty() ? "" : "/api/capture/file?path=" + url_encode(intensity_path))
           << "}";
      return json.str();
    }
    int trigger_ret = apply_software_trigger(session->device, control_mode, lines);
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
    CaptureOutputPaths paths = capture_output_paths_for(output_path);
    if (!create_capture_output_dirs(paths)) {
      return json_error(500, "output directory cannot be created");
    }

    std::string intensity_path = paths.intensity_path;

    int ret = DEV_LOAD_DATA_ERROR;
    int attempts = 0;
    int actual_width = width;
    int actual_lines = lines;
    int fid = -1;
    int sid = -1;
    int lost_lines = 0;
    unsigned int trigger_min_interval = 0;
    unsigned int trigger_max_interval = 0;
    unsigned int frame_timestamp = 0;
    bool saved_intensity = false;
    std::string depth_saved_path = paths.depth_path;

    lvm_trigger_en_ctrl(session->device, false);
    lvm_grab_stop(session->device);

    for (int attempt = 0; attempt <= retries; ++attempt) {
      attempts = attempt + 1;
      lvm_buf_t* buffer = lvm_alloc_depth_map_buf(session->device, data_mode, width, lines, 2);
      if (!buffer) {
        ret = MALLOC_FAILED;
        break;
      }

      ret = lvm_bind_buf(session->device, buffer);
      void* frame = nullptr;
      if (ret == CORRECT) {
        ret = lvm_trigger_en_ctrl(session->device, true);
      }
      if (ret == CORRECT) {
        frame = lvm_grab_frame(session->device, timeout_ms);
        ret = frame ? CORRECT : DEV_LOAD_DATA_ERROR;
      }
      if (ret == CORRECT && frame) {
        auto* depth_map = static_cast<lvm_depth_map_t*>(frame);
        actual_width = static_cast<int>(depth_map->head.width);
        actual_lines = static_cast<int>(depth_map->head.height);
        fid = depth_map->head.fid;
        sid = depth_map->head.sid;
        lost_lines = static_cast<int>(depth_map->head.lost_lines);
        trigger_min_interval = depth_map->head.trigger_min_interval;
        trigger_max_interval = depth_map->head.trigger_max_interval;
        frame_timestamp = depth_map->head.time_stamp;
        ret = lvm_save_depth_map(session->device, paths.sdk_base_path.c_str(), depth_map);
        if (ret == CORRECT) {
          std::error_code exists_error;
          if (std::filesystem::exists(paths.sdk_depth_path, exists_error) && copy_file_replace(paths.sdk_depth_path, paths.depth_path)) {
            depth_saved_path = paths.depth_path;
          } else if (std::filesystem::exists(paths.sdk_base_path, exists_error) && copy_file_replace(paths.sdk_base_path, paths.depth_path)) {
            depth_saved_path = paths.depth_path;
          } else if (std::filesystem::exists(paths.sdk_depth_path, exists_error)) {
            depth_saved_path = paths.sdk_depth_path;
          } else if (std::filesystem::exists(paths.sdk_base_path, exists_error)) {
            depth_saved_path = paths.sdk_base_path;
          }
        }
        if (ret == CORRECT && depth_map->intensity_img && depth_map->intensity_img->data) {
          int img_ret = lvm_save_img(intensity_path.c_str(),
                                     depth_map->intensity_img->data,
                                     depth_map->intensity_img->head.width,
                                     depth_map->intensity_img->head.height,
                                     LVM_IMAGE_FORMAT_16BIT_USHORT);
          saved_intensity = img_ret == CORRECT;
        }
      }
      lvm_trigger_en_ctrl(session->device, false);
      lvm_grab_stop(session->device);
      lvm_free_buf(buffer);
      if (session->device) {
        session->device->buffer = nullptr;
      }
      if (ret == CORRECT) {
        break;
      }
      if (attempt < retries) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
      }
    }

    if (!saved_intensity) {
      intensity_path.clear();
    }
    int metadata_ret = write_capture_metadata_locked(paths.metadata_path,
                                                     *session,
                                                     ret,
                                                     attempts,
                                                     width,
                                                     lines,
                                                     actual_width,
                                                     actual_lines,
                                                     data_mode,
                                                     timeout_ms,
                                                     depth_saved_path,
                                                     intensity_path,
                                                     fid,
                                                     sid,
                                                     lost_lines,
                                                     trigger_min_interval,
                                                     trigger_max_interval,
                                                     frame_timestamp,
                                                     false);

    session->calibration.validation_path = depth_saved_path;
    session->calibration.validation_code = ret;
    session->calibration.validation_time = now_iso();
    const bool depth_exists = file_exists(depth_saved_path);
    const bool intensity_exists = file_exists(intensity_path);
    const bool metadata_exists = metadata_ret == CORRECT && file_exists(paths.metadata_path);
    record_steel_capture_locked(session->ip, depth_saved_path, ret);

    std::ostringstream json;
    json << "{\"code\":" << ret << ",\"lines\":" << actual_lines << ",\"width\":" << actual_width << ","
         << "\"requestedLines\":" << lines << ","
         << "\"requestedWidth\":" << width << ","
         << "\"attempts\":" << attempts << ","
         << "\"retries\":" << retries << ","
         << "\"depthExists\":" << (depth_exists ? "true" : "false") << ","
         << "\"intensityExists\":" << (intensity_exists ? "true" : "false") << ","
         << "\"metadataExists\":" << (metadata_exists ? "true" : "false") << ","
         << "\"completeFrame\":" << (depth_exists && intensity_exists && metadata_exists ? "true" : "false") << ","
         << json_pair("errorName", capture_error_name(ret)) << ","
         << json_pair("operatorHint", capture_error_hint(ret)) << ","
         << "\"fid\":" << fid << ","
         << "\"sid\":" << sid << ","
         << "\"lostLines\":" << lost_lines << ","
         << "\"triggerMinInterval\":" << trigger_min_interval << ","
         << "\"triggerMaxInterval\":" << trigger_max_interval << ","
         << json_pair("ip", session->ip) << ","
         << json_pair("output", depth_saved_path) << ","
         << json_pair("depthOutput", depth_saved_path) << ","
         << json_pair("intensityOutput", intensity_path) << ","
         << json_pair("metadataOutput", metadata_ret == CORRECT ? paths.metadata_path : "") << ","
         << json_pair("sdkOutput", file_exists(paths.sdk_base_path) ? paths.sdk_base_path : "") << ","
         << json_pair("sdkDepthOutput", file_exists(paths.sdk_depth_path) ? paths.sdk_depth_path : "") << ","
         << json_pair("sdkIntensityOutput", file_exists(paths.sdk_intensity_path) ? paths.sdk_intensity_path : "") << ","
         << json_pair("imageUrl", "/api/capture/file?path=" + url_encode(depth_saved_path)) << ","
         << json_pair("depthUrl", "/api/capture/file?path=" + url_encode(depth_saved_path)) << ","
         << json_pair("intensityUrl", intensity_path.empty() ? "" : "/api/capture/file?path=" + url_encode(intensity_path))
         << "}";
    return json.str();
  }

  struct ParallelCaptureJob {
    std::string ip;
    std::string output;
    std::string round_started_at;
    int round = 1;
    int attempt = 1;
    int parallel_index = 0;
    int lines = 1280;
    int width = 0;
    int timeout_ms = 8000;
    int data_mode = 1;
    int retries = 0;
    int control_mode = 0;
  };

  struct ParallelCaptureResult {
    std::string ip;
    std::string output;
    std::string depth_output;
    std::string intensity_output;
    std::string metadata_output;
    std::string sdk_output;
    std::string sdk_depth_output;
    std::string sdk_intensity_output;
    std::string error_message;
    std::string round_started_at;
    std::string worker_started_at;
    std::string worker_finished_at;
    int round = 1;
    int attempt = 1;
    int parallel_index = 0;
    int code = DEV_LOAD_DATA_ERROR;
    int attempts_used = 0;
    int requested_width = 0;
    int requested_lines = 0;
    int width = 0;
    int lines = 0;
    int data_mode = 1;
    int timeout_ms = 0;
    int retries = 0;
    int fid = -1;
    int sid = -1;
    int lost_lines = 0;
    unsigned int trigger_min_interval = 0;
    unsigned int trigger_max_interval = 0;
    unsigned int timestamp = 0;
    bool depth_exists = false;
    bool intensity_exists = false;
    bool metadata_exists = false;
    bool complete_frame = false;
    bool simulated = false;
  };

  ParallelCaptureResult parallel_capture_error(const ParallelCaptureJob& job, int code, const std::string& message) const {
    ParallelCaptureResult result;
    result.ip = job.ip;
    result.output = job.output;
    result.round_started_at = job.round_started_at;
    result.worker_started_at = now_iso();
    result.worker_finished_at = result.worker_started_at;
    result.round = job.round;
    result.attempt = job.attempt;
    result.parallel_index = job.parallel_index;
    result.code = code;
    result.requested_width = job.width;
    result.requested_lines = job.lines;
    result.width = job.width;
    result.lines = job.lines;
    result.data_mode = job.data_mode;
    result.timeout_ms = job.timeout_ms;
    result.retries = job.retries;
    result.error_message = message;
    return result;
  }

  std::string parallel_capture_result_json(const ParallelCaptureResult& result) const {
    std::ostringstream json;
    json << "{\"round\":" << result.round
         << ",\"attempt\":" << result.attempt
         << ",\"parallelIndex\":" << result.parallel_index
         << ",\"code\":" << result.code
         << ",\"attemptsUsed\":" << result.attempts_used
         << ",\"requestedWidth\":" << result.requested_width
         << ",\"requestedLines\":" << result.requested_lines
         << ",\"width\":" << result.width
         << ",\"lines\":" << result.lines
         << ",\"dataMode\":" << result.data_mode
         << ",\"timeoutMs\":" << result.timeout_ms
         << ",\"retries\":" << result.retries
         << ",\"fid\":" << result.fid
         << ",\"sid\":" << result.sid
         << ",\"lostLines\":" << result.lost_lines
         << ",\"triggerMinInterval\":" << result.trigger_min_interval
         << ",\"triggerMaxInterval\":" << result.trigger_max_interval
         << ",\"timestamp\":" << result.timestamp
         << ",\"depthExists\":" << (result.depth_exists ? "true" : "false")
         << ",\"intensityExists\":" << (result.intensity_exists ? "true" : "false")
         << ",\"metadataExists\":" << (result.metadata_exists ? "true" : "false")
         << ",\"completeFrame\":" << (result.complete_frame ? "true" : "false")
         << ",\"simulated\":" << (result.simulated ? "true" : "false")
         << "," << json_pair("ip", result.ip)
         << "," << json_pair("output", result.output)
         << "," << json_pair("depthOutput", result.depth_output.empty() ? result.output : result.depth_output)
         << "," << json_pair("intensityOutput", result.intensity_output)
         << "," << json_pair("metadataOutput", result.metadata_output)
         << "," << json_pair("sdkOutput", result.sdk_output)
         << "," << json_pair("sdkDepthOutput", result.sdk_depth_output)
         << "," << json_pair("sdkIntensityOutput", result.sdk_intensity_output)
         << "," << json_pair("errorName", capture_error_name(result.code))
         << "," << json_pair("operatorHint", capture_error_hint(result.code))
         << "," << json_pair("error", result.error_message)
         << "," << json_pair("roundStartedAt", result.round_started_at)
         << "," << json_pair("workerStartedAt", result.worker_started_at)
         << "," << json_pair("workerFinishedAt", result.worker_finished_at)
         << "}";
    return json.str();
  }

  ParallelCaptureResult run_parallel_capture_job(const ParallelCaptureJob& job) {
    ParallelCaptureResult result;
    result.ip = job.ip;
    result.output = job.output;
    result.depth_output = job.output;
    result.round_started_at = job.round_started_at;
    result.worker_started_at = now_iso();
    result.round = job.round;
    result.attempt = job.attempt;
    result.parallel_index = job.parallel_index;
    result.requested_width = job.width;
    result.requested_lines = job.lines;
    result.width = job.width;
    result.lines = job.lines;
    result.data_mode = job.data_mode;
    result.timeout_ms = job.timeout_ms;
    result.retries = job.retries;

    std::shared_ptr<std::mutex> camera_mutex;
    std::string output_path;
    std::string intensity_path;
    std::string metadata_path;
    CaptureOutputPaths paths;
    bool simulated = false;

    {
      std::lock_guard<std::mutex> lock(mutex_);
      CameraSession* session = session_for_ip_locked(job.ip);
      if (!session || (!session->device && !session->simulated)) {
        return parallel_capture_error(job, DEV_NOT_LINK_ERROR, "camera not connected");
      }
      if (session->stream.running) {
        return parallel_capture_error(job, 409, "stream is running; stop stream before blocking capture");
      }
      simulated = session->simulated;
      if (simulated) {
        if (result.width <= 0) {
          result.width = 640;
        }
        if (result.lines <= 0) {
          result.lines = 480;
        }
      }
      output_path = resolve_output_path_locked(job.output, "continuous-test/capture-depth.png");
      if (!is_output_path_allowed_locked(output_path)) {
        return parallel_capture_error(job, 403, "output path must be under storage root");
      }
      paths = capture_output_paths_for(output_path);
      intensity_path = paths.intensity_path;
      metadata_path = paths.metadata_path;
      camera_mutex = session->capture_mutex;
      result.output = paths.depth_path;
      result.depth_output = paths.depth_path;
      result.intensity_output = intensity_path;
      result.metadata_output = metadata_path;
      result.sdk_output = paths.sdk_base_path;
      result.sdk_depth_output = paths.sdk_depth_path;
      result.sdk_intensity_output = paths.sdk_intensity_path;
      result.simulated = simulated;
    }

    if (!create_capture_output_dirs(paths)) {
      return parallel_capture_error(job, 500, "output directory cannot be created");
    }

    std::lock_guard<std::mutex> camera_lock(*camera_mutex);
    if (simulated) {
      int ret = DEV_NOT_LINK_ERROR;
      int metadata_ret = 500;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        CameraSession* session = session_for_ip_locked(job.ip);
        if (!session || !session->simulated) {
          return parallel_capture_error(job, DEV_NOT_LINK_ERROR, "camera not connected");
        }
        ret = write_simulated_png_locked(*session, paths.depth_path, result.width, result.lines, "depth");
        int intensity_ret = write_simulated_png_locked(*session, intensity_path, result.width, result.lines, "intensity");
        if (ret == CORRECT && intensity_ret != CORRECT) {
          intensity_path.clear();
          result.intensity_output.clear();
        }
        metadata_ret = write_capture_metadata_locked(metadata_path,
                                                     *session,
                                                     ret,
                                                     1,
                                                     result.width,
                                                     result.lines,
                                                     result.width,
                                                     result.lines,
                                                     job.data_mode,
                                                     job.timeout_ms,
                                                     paths.depth_path,
                                                     intensity_path,
                                                     session->stream.frame_count + 1,
                                                     simulated_index_for_ip(session->ip) + 1,
                                                     0,
                                                     0,
                                                     0,
                                                     static_cast<unsigned int>(GetTickCount()),
                                                     true);
        session->calibration.validation_path = paths.depth_path;
        session->calibration.validation_code = ret;
        session->calibration.validation_time = now_iso();
        record_steel_capture_locked(session->ip, paths.depth_path, ret);
      }
      result.code = ret;
      result.attempts_used = 1;
      result.output = paths.depth_path;
      result.depth_output = paths.depth_path;
      result.sdk_output.clear();
      result.sdk_depth_output.clear();
      result.sdk_intensity_output.clear();
      result.depth_exists = file_exists(paths.depth_path);
      result.intensity_exists = file_exists(intensity_path);
      result.metadata_exists = metadata_ret == CORRECT && file_exists(metadata_path);
      result.complete_frame = result.depth_exists && result.intensity_exists && result.metadata_exists;
      result.worker_finished_at = now_iso();
      return result;
    }

    lvm_dev_t* device = nullptr;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      CameraSession* session = session_for_ip_locked(job.ip);
      if (!session || !session->device) {
        return parallel_capture_error(job, DEV_NOT_LINK_ERROR, "camera not connected");
      }
      device = session->device;
    }

    int trigger_ret = apply_software_trigger(device, job.control_mode, job.lines);
    if (trigger_ret != CORRECT) {
      result.code = trigger_ret;
      result.error_message = "software trigger config failed";
      result.worker_finished_at = now_iso();
      return result;
    }

    int capture_width = job.width;
    if (capture_width <= 0) {
      capture_width = lvm_get_depth_map_width(device, job.lines);
    }
    if (capture_width <= 0) {
      capture_width = 4096;
    }
    result.requested_width = capture_width;
    result.width = capture_width;
    result.requested_lines = job.lines;
    result.lines = job.lines;

    int ret = DEV_LOAD_DATA_ERROR;
    int attempts = 0;
    int actual_width = capture_width;
    int actual_lines = job.lines;
    int fid = -1;
    int sid = -1;
    int lost_lines = 0;
    unsigned int trigger_min_interval = 0;
    unsigned int trigger_max_interval = 0;
    unsigned int frame_timestamp = 0;
    bool saved_intensity = false;
    std::string depth_saved_path = paths.depth_path;

    lvm_trigger_en_ctrl(device, false);
    lvm_grab_stop(device);

    for (int attempt = 0; attempt <= job.retries; ++attempt) {
      attempts = attempt + 1;
      lvm_buf_t* buffer = lvm_alloc_depth_map_buf(device, job.data_mode, capture_width, job.lines, 2);
      if (!buffer) {
        ret = MALLOC_FAILED;
        break;
      }

      ret = lvm_bind_buf(device, buffer);
      void* frame = nullptr;
      if (ret == CORRECT) {
        ret = lvm_trigger_en_ctrl(device, true);
      }
      if (ret == CORRECT) {
        frame = lvm_grab_frame(device, job.timeout_ms);
        ret = frame ? CORRECT : DEV_LOAD_DATA_ERROR;
      }
      if (ret == CORRECT && frame) {
        auto* depth_map = static_cast<lvm_depth_map_t*>(frame);
        actual_width = static_cast<int>(depth_map->head.width);
        actual_lines = static_cast<int>(depth_map->head.height);
        fid = depth_map->head.fid;
        sid = depth_map->head.sid;
        lost_lines = static_cast<int>(depth_map->head.lost_lines);
        trigger_min_interval = depth_map->head.trigger_min_interval;
        trigger_max_interval = depth_map->head.trigger_max_interval;
        frame_timestamp = depth_map->head.time_stamp;
        ret = lvm_save_depth_map(device, paths.sdk_base_path.c_str(), depth_map);
        if (ret == CORRECT) {
          std::error_code exists_error;
          if (std::filesystem::exists(paths.sdk_depth_path, exists_error) && copy_file_replace(paths.sdk_depth_path, paths.depth_path)) {
            depth_saved_path = paths.depth_path;
          } else if (std::filesystem::exists(paths.sdk_base_path, exists_error) && copy_file_replace(paths.sdk_base_path, paths.depth_path)) {
            depth_saved_path = paths.depth_path;
          } else if (std::filesystem::exists(paths.sdk_depth_path, exists_error)) {
            depth_saved_path = paths.sdk_depth_path;
          } else if (std::filesystem::exists(paths.sdk_base_path, exists_error)) {
            depth_saved_path = paths.sdk_base_path;
          }
        }
        if (ret == CORRECT && depth_map->intensity_img && depth_map->intensity_img->data) {
          int img_ret = lvm_save_img(intensity_path.c_str(),
                                     depth_map->intensity_img->data,
                                     depth_map->intensity_img->head.width,
                                     depth_map->intensity_img->head.height,
                                     LVM_IMAGE_FORMAT_16BIT_USHORT);
          saved_intensity = img_ret == CORRECT;
        }
      }
      lvm_trigger_en_ctrl(device, false);
      lvm_grab_stop(device);
      lvm_free_buf(buffer);
      if (device) {
        device->buffer = nullptr;
      }
      if (ret == CORRECT) {
        break;
      }
      if (attempt < job.retries) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
      }
    }

    if (!saved_intensity) {
      intensity_path.clear();
      result.intensity_output.clear();
    }

    int metadata_ret = 500;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      CameraSession* session = session_for_ip_locked(job.ip);
      if (session) {
        metadata_ret = write_capture_metadata_locked(metadata_path,
                                                     *session,
                                                     ret,
                                                     attempts,
                                                     capture_width,
                                                     job.lines,
                                                     actual_width,
                                                     actual_lines,
                                                     job.data_mode,
                                                     job.timeout_ms,
                                                     depth_saved_path,
                                                     intensity_path,
                                                     fid,
                                                     sid,
                                                     lost_lines,
                                                     trigger_min_interval,
                                                     trigger_max_interval,
                                                     frame_timestamp,
                                                     false);
        session->calibration.validation_path = depth_saved_path;
        session->calibration.validation_code = ret;
        session->calibration.validation_time = now_iso();
        record_steel_capture_locked(session->ip, depth_saved_path, ret);
      }
    }

    result.code = ret;
    result.attempts_used = attempts;
    result.width = actual_width;
    result.lines = actual_lines;
    result.fid = fid;
    result.sid = sid;
    result.lost_lines = lost_lines;
    result.trigger_min_interval = trigger_min_interval;
    result.trigger_max_interval = trigger_max_interval;
    result.timestamp = frame_timestamp;
    result.output = depth_saved_path;
    result.depth_output = depth_saved_path;
    result.metadata_output = metadata_ret == CORRECT ? metadata_path : "";
    result.sdk_output = file_exists(paths.sdk_base_path) ? paths.sdk_base_path : "";
    result.sdk_depth_output = file_exists(paths.sdk_depth_path) ? paths.sdk_depth_path : "";
    result.sdk_intensity_output = file_exists(paths.sdk_intensity_path) ? paths.sdk_intensity_path : "";
    result.depth_exists = file_exists(depth_saved_path);
    result.intensity_exists = file_exists(intensity_path);
    result.metadata_exists = metadata_ret == CORRECT && file_exists(metadata_path);
    result.complete_frame = result.depth_exists && result.intensity_exists && result.metadata_exists;
    result.worker_finished_at = now_iso();
    return result;
  }

  std::string continuous_capture_test_json(const std::string& body) {
    int expected_cameras = json_int_field(body, "expectedCameras", 0);
    int rounds = std::max(1, std::min(10000, json_int_field(body, "rounds", 3)));
    int lines = json_int_field(body, "lines", 1280);
    int width = json_int_field(body, "width", 0);
    int timeout_ms = json_int_field(body, "timeoutMs", 8000);
    int data_mode = json_int_field(body, "dataMode", 1);
    int retries = std::max(0, std::min(10, json_int_field(body, "retries", 2)));
    int control_mode = json_int_field(body, "controlMode", 0);
    int interval_ms = std::max(0, std::min(600000, json_int_field(body, "intervalMs", 500)));
    bool connect_first = json_bool_field(body, "connectFirst", true);
    bool stop_streams = json_bool_field(body, "stopStreams", true);
    bool explicit_output_dir = json_has_field(body, "outputDir");
    std::string output_dir = json_string_field(body, "outputDir", "");
    std::string material_id = json_string_field(body, "materialId", json_string_field(body, "steelId", json_string_field(body, "steelNo")));
    bool production_layout = json_bool_field(body, "productionLayout", !explicit_output_dir || !material_id.empty());
    std::vector<std::string> ips = json_string_array_field(body, "ips");

    if (!explicit_output_dir || output_dir.empty()) {
      std::lock_guard<std::mutex> lock(mutex_);
      if (material_id.empty()) {
        material_id = material_storage_segment_locked();
      }
      output_dir = steel_state_.capture_dir.empty()
                       ? "continuous-test"
                       : steel_state_.capture_dir;
    }

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

    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (active_capture_batches_ > 0) {
        return json_error(409, "capture batch is running");
      }
      ++active_capture_batches_;
    }

    bool expected_met = expected_cameras <= 0 || static_cast<int>(ips.size()) >= expected_cameras;
    int attempts = 0;
    int successes = 0;
    int failures = 0;
    int complete_frames = 0;
    int metadata_frames = 0;
    int first_error = CORRECT;
    std::ostringstream results;
    results << "[";
    int result_count = 0;
    const std::string started_at = now_iso();
    const auto started_clock = std::chrono::steady_clock::now();

    for (int round = 1; round <= rounds; ++round) {
      std::vector<ParallelCaptureJob> jobs;
      jobs.reserve(ips.size());
      for (size_t index = 0; index < ips.size(); ++index) {
        const std::string& ip = ips[index];
        const int attempt_number = (round - 1) * static_cast<int>(ips.size()) + static_cast<int>(index) + 1;
        std::ostringstream filename;
        filename << "round-" << std::setw(3) << std::setfill('0') << round
                 << "-shot-" << std::setw(4) << std::setfill('0') << attempt_number
                 << ".png";
        ParallelCaptureJob job;
        job.ip = ip;
        if (production_layout) {
          std::lock_guard<std::mutex> lock(mutex_);
          job.output = raw_capture_output_locked(ip, material_id, attempt_number);
        } else {
          job.output = (std::filesystem::path(output_dir) / safe_path_segment(ip) / filename.str()).lexically_normal().string();
        }
        job.round = round;
        job.attempt = attempt_number;
        job.parallel_index = static_cast<int>(index);
        job.lines = lines;
        job.width = width;
        job.timeout_ms = timeout_ms;
        job.data_mode = data_mode;
        job.retries = retries;
        job.control_mode = control_mode;
        jobs.push_back(job);
      }

      std::vector<ParallelCaptureResult> round_results(jobs.size());
      std::vector<std::thread> workers;
      workers.reserve(jobs.size());
      std::mutex start_mutex;
      std::condition_variable start_cv;
      bool start_round = false;
      size_t ready_count = 0;

      for (size_t index = 0; index < jobs.size(); ++index) {
        workers.emplace_back([&, index]() {
          try {
            {
              std::unique_lock<std::mutex> start_lock(start_mutex);
              ++ready_count;
              start_cv.notify_one();
              start_cv.wait(start_lock, [&]() { return start_round; });
            }
            round_results[index] = run_parallel_capture_job(jobs[index]);
          } catch (const std::exception& ex) {
            round_results[index] = parallel_capture_error(jobs[index], 500, ex.what());
          } catch (...) {
            round_results[index] = parallel_capture_error(jobs[index], 500, "capture worker failed");
          }
        });
      }

      {
        std::unique_lock<std::mutex> start_lock(start_mutex);
        start_cv.wait(start_lock, [&]() { return ready_count == jobs.size(); });
        const std::string round_started_at = now_iso();
        for (auto& job : jobs) {
          job.round_started_at = round_started_at;
        }
        start_round = true;
      }
      start_cv.notify_all();

      for (std::thread& worker : workers) {
        if (worker.joinable()) {
          worker.join();
        }
      }

      for (const ParallelCaptureResult& capture : round_results) {
        ++attempts;
        int ret = capture.code;
        if (ret == CORRECT) {
          ++successes;
        } else {
          ++failures;
          if (first_error == CORRECT) {
            first_error = ret;
          }
        }
        if (capture.complete_frame) {
          ++complete_frames;
        }
        if (capture.metadata_exists) {
          ++metadata_frames;
        }

        if (result_count > 0) {
          results << ",";
        }
        results << parallel_capture_result_json(capture);
        ++result_count;
      }

      if (round < rounds && interval_ms > 0) {
        std::this_thread::sleep_for(std::chrono::milliseconds(interval_ms));
      }
    }
    results << "]";

    int code = (failures == 0 && expected_met) ? CORRECT : (first_error == CORRECT ? 206 : first_error);
    std::string summary_path;
    bool summary_allowed = false;
    std::string storage_root_string;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      summary_path = resolve_output_path_locked((std::filesystem::path(output_dir) / "summary.json").lexically_normal().string(),
                                                "continuous-test/summary.json");
      summary_allowed = is_output_path_allowed_locked(summary_path);
      storage_root_string = storage_root_.string();
      if (active_capture_batches_ > 0) {
        --active_capture_batches_;
      }
    }
    const std::string finished_at = now_iso();
    const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started_clock).count();

    std::ostringstream json;
    json << "{\"schema\":\"steel.capture.continuous-test.summary.v1\","
         << json_pair("generatedAt", finished_at) << ","
         << json_pair("startedAt", started_at) << ","
         << json_pair("finishedAt", finished_at) << ","
         << "\"code\":" << code
         << "," << json_pair("errorName", capture_error_name(code))
         << "," << json_pair("operatorHint", capture_error_hint(code))
         << ",\"attempts\":" << attempts
         << ",\"successes\":" << successes
         << ",\"failures\":" << failures
         << ",\"completeFrames\":" << complete_frames
         << ",\"metadataFrames\":" << metadata_frames
         << ",\"rounds\":" << rounds
         << ",\"retries\":" << retries
         << ",\"cameraCount\":" << ips.size()
         << ",\"expectedCameras\":" << expected_cameras
         << ",\"expectedMet\":" << (expected_met ? "true" : "false")
         << ",\"connectFirst\":" << (connect_first ? "true" : "false")
         << ",\"parallel\":true"
         << ",\"workerCount\":" << ips.size()
         << ",\"roundIntervalMs\":" << interval_ms
         << ",\"elapsedMs\":" << elapsed_ms
         << "," << json_pair("syncMode", "round-start-condition-variable")
         << "," << json_pair("storageRoot", storage_root_string)
         << "," << json_pair("outputDir", output_dir)
         << "," << json_pair("summaryOutput", summary_allowed ? summary_path : "")
         << ",\"connectResult\":" << connect_result
         << ",\"results\":" << results.str()
         << "}";
    std::string response_body = json.str();
    bool summary_written = false;
    if (summary_allowed) {
      summary_written = write_text_file(summary_path, response_body);
    }
    response_body.pop_back();
    response_body += ",\"summaryExists\":";
    response_body += (summary_written && file_exists(summary_path)) ? "true" : "false";
    response_body += "}";
    if (summary_written) {
      write_text_file(summary_path, response_body);
    }
    return response_body;
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
    int control_mode = json_int_field(body, "controlMode", 0);

    std::lock_guard<std::mutex> lock(mutex_);
    if (active_capture_batches_ > 0) {
      return json_error(409, "capture batch is running");
    }
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || (!session->device && !session->simulated)) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    stop_all_streams_locked(session->ip);
    stop_stream_locked(*session);
    if (session->simulated) {
      if (width <= 0) {
        width = 640;
      }
      if (lines <= 0) {
        lines = 480;
      }
      session->stream = StreamState{};
      session->stream.running = true;
      session->stream.lines = lines;
      session->stream.width = width;
      session->stream.data_mode = data_mode;
      session->stream.hs = hs;
      session->stream.fps_limit = fps_limit;
      session->stream.started_at = now_iso();
      session->stream.updated_at = session->stream.started_at;
      session->stream.code = update_simulated_stream_frame_locked(*session);
      return stream_status_json_locked(*session);
    }
    int trigger_ret = apply_software_trigger(session->device, control_mode, lines);
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
    if (active_capture_batches_ > 0) {
      return json_error(409, "capture batch is running");
    }
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || (!session->device && !session->simulated)) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    stop_stream_locked(*session);
    return stream_status_json_locked(*session);
  }

  std::string stream_status_json(const std::string& query) {
    std::string ip = get_query_param(query, "ip");
    std::lock_guard<std::mutex> lock(mutex_);
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || (!session->device && !session->simulated)) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    if (session->simulated && session->stream.running) {
      update_simulated_stream_frame_locked(*session);
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
    if (!session || (!session->device && !session->simulated)) {
      return {404, "", "image/png"};
    }
    if (session->simulated && session->stream.running) {
      update_simulated_stream_frame_locked(*session);
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

  std::string active_calibration_json_locked(const std::string& profile_name) {
    std::string name = normalize_profile_name(profile_name.empty() ? active_profile_name_locked() : profile_name);
    ensure_config_dirs_locked();
    std::string profile;
    std::filesystem::path profile_path = existing_profile_path_locked(name);
    if (!read_file(profile_path.string(), profile)) {
      return json_error(404, "profile not found");
    }

    std::string calibration_file = json_string_field(profile, "arrayCalibrationFile");
    std::filesystem::path calibration_path = calibration_file.empty() ? std::filesystem::path() : provider_path_locked(calibration_file);
    bool exists = !calibration_file.empty() && std::filesystem::exists(calibration_path);
    std::string active_raw = json_raw_field(profile, "activeCalibration", "{}");
    if (active_raw.empty()) {
      active_raw = "{}";
    }

    std::string fit_report = json_string_field(active_raw, "fitReport");
    std::string fit_summary = "{}";
    if (!fit_report.empty()) {
      std::filesystem::path report_path = provider_path_locked(fit_report);
      std::string report;
      if (is_config_or_storage_path_locked(report_path) && read_file(report_path.string(), report)) {
        std::string before = json_raw_field(report, "fitBefore", "{}");
        std::string after = json_raw_field(report, "fitAfter", "{}");
        fit_summary = "{";
        fit_summary += json_pair("path", profile_path_text_locked(report_path));
        fit_summary += ",\"fitBefore\":" + (before.empty() ? "{}" : before);
        fit_summary += ",\"fitAfter\":" + (after.empty() ? "{}" : after);
        fit_summary += ",\"cameraCount\":" + std::to_string(json_int_field(report, "cameraCount", 0));
        fit_summary += "}";
      }
    }

    std::ostringstream json;
    json << "{\"code\":0,"
         << json_pair("profile", name) << ","
         << json_pair("profilePath", profile_path.string()) << ","
         << json_pair("calibrationFile", calibration_file) << ","
         << json_pair("calibrationPath", calibration_path.empty() ? "" : calibration_path.string()) << ","
         << "\"exists\":" << (exists ? "true" : "false") << ","
         << json_pair("versionRoot", calibration_profile_root_locked(name).string()) << ","
         << "\"activeCalibration\":" << active_raw << ","
         << "\"fitReportSummary\":" << fit_summary
         << "}";
    return json.str();
  }

  std::string calibration_active_json(const std::string& query) {
    std::string name = get_query_param(query, "profile");
    std::lock_guard<std::mutex> lock(mutex_);
    return active_calibration_json_locked(name);
  }

  std::string calibration_active_save_locked(const std::string& body, const std::string& results_json = "[]", const std::string& save_result_json = "{\"skipped\":true}") {
    std::string name = normalize_profile_name(json_string_field(body, "name", json_string_field(body, "profile", active_profile_name_locked())));
    std::string path_text = json_string_field(body, "path", json_string_field(body, "calibrationPath", json_string_field(body, "correctedCalibration")));
    if (path_text.empty()) {
      return json_error(400, "missing calibration path");
    }
    std::filesystem::path calibration_path = provider_path_locked(path_text);
    bool allow_external = json_bool_field(body, "allowExternal", false);
    if (!allow_external && !is_config_or_storage_path_locked(calibration_path)) {
      return json_error(403, "calibration file must be under storage/config roots");
    }
    if (!std::filesystem::exists(calibration_path)) {
      return json_error(404, "calibration file not found");
    }

    std::string profile;
    std::filesystem::path profile_path = existing_profile_path_locked(name);
    if (!read_file(profile_path.string(), profile)) {
      return json_error(404, "profile not found");
    }

    std::string relative_calibration = profile_path_text_locked(calibration_path);
    std::string active_raw = json_raw_field(body, "activeCalibration");
    if (active_raw.empty()) {
      std::string fit_report = json_string_field(body, "fitReport");
      std::string before_preview = json_string_field(body, "beforePreview");
      std::string after_preview = json_string_field(body, "afterPreview");
      std::string version = json_string_field(body, "version", calibration_path.parent_path().filename().string());
      std::string source_calibration = json_string_field(body, "sourceCalibration", json_string_field(profile, "arrayCalibrationFile"));
      std::string fit_before = json_raw_field(body, "fitBefore", "{}");
      std::string fit_after = json_raw_field(body, "fitAfter", "{}");
      if ((!fit_report.empty()) && (fit_before == "{}" || fit_after == "{}")) {
        std::filesystem::path report_path = provider_path_locked(fit_report);
        std::string report;
        if (is_config_or_storage_path_locked(report_path) && read_file(report_path.string(), report)) {
          fit_before = json_raw_field(report, "fitBefore", fit_before);
          fit_after = json_raw_field(report, "fitAfter", fit_after);
        }
      }
      std::ostringstream active;
      active << "{"
             << json_pair("version", version) << ","
             << json_pair("appliedAt", now_iso()) << ","
             << json_pair("appliedBy", json_string_field(body, "appliedBy", "capture-provider")) << ","
             << json_pair("sourceCalibration", source_calibration) << ","
             << json_pair("correctedCalibration", relative_calibration) << ","
             << json_pair("fitReport", fit_report) << ","
             << json_pair("beforePreview", before_preview) << ","
             << json_pair("afterPreview", after_preview) << ","
             << "\"fitBefore\":" << (fit_before.empty() ? "{}" : fit_before) << ","
             << "\"fitAfter\":" << (fit_after.empty() ? "{}" : fit_after) << ","
             << "\"saveToDevice\":" << (json_bool_field(body, "saveToDevice", false) ? "true" : "false") << ","
             << json_pair("cameraParamDir", json_string_field(body, "cameraParamDir")) << ","
             << "\"calibrationResults\":" << results_json << ","
             << "\"saveResult\":" << save_result_json
             << "}";
      active_raw = active.str();
    } else {
      active_raw = set_top_level_json_field(active_raw, "correctedCalibration", json_string_value(relative_calibration));
    }

    std::string next_profile = set_top_level_json_field(profile, "arrayCalibrationFile", json_string_value(relative_calibration));
    next_profile = set_top_level_json_field(next_profile, "activeCalibration", active_raw);
    if (!write_text_file(profile_path, next_profile)) {
      return json_error(500, "profile cannot be updated");
    }
    sync_existing_legacy_profile_locked(name, next_profile);
    return active_calibration_json_locked(name);
  }

  std::string calibration_active_save_json(const std::string& body) {
    std::lock_guard<std::mutex> lock(mutex_);
    return calibration_active_save_locked(body);
  }

  std::string calibration_apply_all_json(const std::string& body) {
    std::string profile_name = normalize_profile_name(json_string_field(body, "name", json_string_field(body, "profile", active_profile_name_locked())));
    std::string path_text = json_string_field(body, "path", json_string_field(body, "calibrationPath", json_string_field(body, "correctedCalibration")));
    if (path_text.empty()) {
      return json_error(400, "missing calibration path");
    }
    std::vector<std::string> ips = json_string_array_field(body, "ips");
    bool allow_external = json_bool_field(body, "allowExternal", false);
    bool stop_streams = json_bool_field(body, "stopStreams", true);
    bool persist_active = json_bool_field(body, "persistActive", true);
    bool save_camera_params = json_bool_field(body, "saveCameraParams", false);
    bool save_to_device = json_bool_field(body, "saveToDevice", false);

    std::lock_guard<std::mutex> lock(mutex_);
    if (active_capture_batches_ > 0) {
      return json_error(409, "capture batch is running");
    }
    std::filesystem::path calibration_path = provider_path_locked(path_text);
    if (!allow_external && !is_config_or_storage_path_locked(calibration_path)) {
      return json_error(403, "calibration file must be under storage/config roots");
    }
    if (!std::filesystem::exists(calibration_path)) {
      return json_error(404, "calibration file not found");
    }

    if (ips.empty()) {
      for (const auto& item : sessions_) {
        if (item.second.device || item.second.simulated_connected) {
          ips.push_back(item.second.ip);
        }
      }
    }

    int applied = 0;
    int failed = 0;
    int first_error = CORRECT;
    std::ostringstream results;
    results << "[";
    bool first = true;
    for (const std::string& ip : ips) {
      if (!first) {
        results << ",";
      }
      first = false;
      CameraSession* session = session_for_ip_locked(ip);
      int ret = CORRECT;
      std::string message;
      if (!session || (!session->device && !session->simulated)) {
        ret = DEV_NOT_LINK_ERROR;
        message = "camera not connected";
      } else if (session->stream.running && !stop_streams) {
        ret = 409;
        message = "stream is running";
      } else {
        if (session->stream.running) {
          stop_stream_locked(*session);
        }
        ret = session->simulated ? CORRECT : lvm_load_calib_param(session->device, calibration_path.string().c_str());
        session->calibration.calibration_path = calibration_path.string();
        session->calibration.calibration_code = ret;
        session->calibration.calibration_time = now_iso();
        if (ret != CORRECT) {
          message = "SDK calibration load returned non-zero; ArrayCalibration XML may be a stitching/profile file rather than a per-camera SDK calibration file";
        }
      }
      if (ret == CORRECT) {
        ++applied;
      } else {
        ++failed;
        if (first_error == CORRECT) {
          first_error = ret;
        }
      }
      results << "{\"code\":" << ret << ","
              << json_pair("ip", ip) << ","
              << json_pair("calibrationPath", calibration_path.string()) << ","
              << "\"calibrationCode\":" << ret << ","
              << json_pair("errorName", capture_error_name(ret)) << ","
              << json_pair("message", message)
              << "}";
    }
    results << "]";

    std::string save_result = "{\"skipped\":true}";
    if (save_camera_params) {
      std::ostringstream save_body;
      save_body << "{"
                << json_pair("name", profile_name) << ","
                << json_pair("cameraParamDir", json_string_field(body, "cameraParamDir", "config/camera-params/" + profile_name)) << ","
                << "\"applySoftTrigger\":" << (json_bool_field(body, "applySoftTrigger", false) ? "true" : "false") << ","
                << "\"saveToDevice\":" << (save_to_device ? "true" : "false") << ","
                << "\"ips\":[";
      for (size_t i = 0; i < ips.size(); ++i) {
        if (i > 0) {
          save_body << ",";
        }
        save_body << json_string_value(ips[i]);
      }
      save_body << "]}";
      save_result = config_camera_params_save_all_locked(save_body.str());
      int save_code = json_int_field(save_result, "code", CORRECT);
      if (save_code != CORRECT && first_error == CORRECT) {
        first_error = save_code;
      }
    }

    std::string active_result = "{\"skipped\":true}";
    if (persist_active) {
      std::string active_body = set_top_level_json_field(body, "path", json_string_value(profile_path_text_locked(calibration_path)));
      active_body = set_top_level_json_field(active_body, "name", json_string_value(profile_name));
      active_result = calibration_active_save_locked(active_body, results.str(), save_result);
      int active_code = json_int_field(active_result, "code", CORRECT);
      if (active_code != CORRECT && first_error == CORRECT) {
        first_error = active_code;
      }
    }

    int code = (failed == 0 && first_error == CORRECT) ? CORRECT : (first_error == CORRECT ? 206 : first_error);
    std::ostringstream json;
    json << "{\"code\":" << code << ","
         << json_pair("profile", profile_name) << ","
         << json_pair("calibrationPath", calibration_path.string()) << ","
         << "\"applied\":" << applied << ","
         << "\"failed\":" << failed << ","
         << "\"persistActive\":" << (persist_active ? "true" : "false") << ","
         << "\"saveCameraParams\":" << (save_camera_params ? "true" : "false") << ","
         << "\"saveToDevice\":" << (save_to_device ? "true" : "false") << ","
         << "\"results\":" << results.str() << ","
         << "\"saveResult\":" << save_result << ","
         << "\"activeCalibration\":" << active_result
         << "}";
    return json.str();
  }

  std::string calibration_load_json(const std::string& body) {
    std::string ip = json_string_field(body, "ip");
    std::string path_text = json_string_field(body, "path");
    if (path_text.empty()) {
      return json_error(400, "missing calibration path");
    }
    std::lock_guard<std::mutex> lock(mutex_);
    std::filesystem::path path = provider_path_locked(path_text);
    if (!json_bool_field(body, "allowExternal", false) && !is_config_or_storage_path_locked(path)) {
      return json_error(403, "calibration file must be under storage/config roots");
    }
    if (!std::filesystem::exists(path)) {
      return json_error(404, "calibration file not found");
    }
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || (!session->device && !session->simulated)) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    int ret = session->simulated ? CORRECT : lvm_load_calib_param(session->device, path.string().c_str());
    session->calibration.calibration_path = path.string();
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
    if (!session || (!session->device && !session->simulated)) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    int ret = session->simulated ? CORRECT : lvm_set_roi_param(session->device, path.c_str());
    session->calibration.roi_path = path;
    session->calibration.roi_code = ret;
    session->calibration.roi_time = now_iso();
    return calibration_status_json_locked(*session);
  }

  std::string calibration_status_json(const std::string& query) {
    std::string ip = get_query_param(query, "ip");
    std::lock_guard<std::mutex> lock(mutex_);
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || (!session->device && !session->simulated)) {
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

  std::string steel_status_json() {
    std::lock_guard<std::mutex> lock(mutex_);
    return steel_status_json_locked();
  }

  std::string steel_status_json_locked() const {
    int connected_count = 0;
    int streaming_count = 0;
    for (const auto& item : sessions_) {
      const CameraSession& session = item.second;
      bool connected = false;
      if (session.simulated) {
        connected = session.simulated_connected;
      } else if (session.device) {
        connected = lvm_get_dev_connect_status(session.device) == 1;
      }
      if (connected) {
        ++connected_count;
      }
      if (session.stream.running) {
        ++streaming_count;
      }
    }

    std::ostringstream json;
    json << "{\"code\":0,"
         << json_pair("phase", steel_state_.phase) << ","
         << json_pair("phaseLabel", steel_phase_label(steel_state_.phase)) << ","
         << "\"present\":" << (steel_state_.present ? "true" : "false") << ","
         << json_pair("steelId", steel_state_.steel_id) << ","
         << json_pair("steelType", steel_state_.steel_type) << ","
         << "\"length\":" << steel_state_.length << ","
         << "\"width\":" << steel_state_.width << ","
         << "\"thickness\":" << steel_state_.thickness << ","
         << json_pair("client", steel_state_.client) << ","
         << json_pair("hard", steel_state_.hard) << ","
         << json_pair("sessionId", steel_state_.session_id) << ","
         << json_pair("captureDir", steel_state_.capture_dir) << ","
         << json_pair("summaryOutput", steel_state_.summary_path) << ","
         << json_pair("sessionStartedAt", steel_state_.session_started_at) << ","
         << json_pair("sessionFinishedAt", steel_state_.session_finished_at) << ","
         << json_pair("lastCaptureAt", steel_state_.last_capture_at) << ","
         << json_pair("lastCaptureIp", steel_state_.last_capture_ip) << ","
         << json_pair("lastCaptureOutput", steel_state_.last_capture_output) << ","
         << json_pair("inTime", steel_state_.in_time) << ","
         << json_pair("outTime", steel_state_.out_time) << ","
         << json_pair("infoTime", steel_state_.info_time) << ","
         << json_pair("updatedAt", steel_state_.updated_at) << ","
         << "\"inCount\":" << steel_state_.in_count << ","
         << "\"outCount\":" << steel_state_.out_count << ","
         << "\"eventCount\":" << steel_state_.event_count << ","
         << "\"captureCount\":" << steel_state_.capture_count << ","
         << "\"captureSuccessCount\":" << steel_state_.capture_success_count << ","
         << "\"captureFailureCount\":" << steel_state_.capture_failure_count << ","
         << "\"connectedCameras\":" << connected_count << ","
         << "\"streamingCameras\":" << streaming_count << ","
         << "\"expectedCameras\":" << expected_cameras_
         << "}";
    return json.str();
  }

  void ensure_steel_session_locked(const std::string& now) {
    if (!steel_state_.session_id.empty()) {
      return;
    }
    const std::string steel_segment = safe_path_segment(steel_state_.steel_id.empty() ? "unknown-steel" : steel_state_.steel_id);
    steel_state_.session_id = steel_segment + "-" + timestamp_file_segment();
    std::filesystem::path dir = (storage_root_ / "production" / steel_segment / steel_state_.session_id).lexically_normal();
    steel_state_.capture_dir = dir.string();
    steel_state_.summary_path = (dir / "summary.json").lexically_normal().string();
    steel_state_.session_started_at = now;
    steel_state_.session_finished_at.clear();
    std::error_code error;
    std::filesystem::create_directories(dir, error);
  }

  std::string production_capture_output_locked(const std::string& ip) const {
    if (steel_state_.capture_dir.empty()) {
      return "";
    }
    return raw_capture_output_locked(ip, material_storage_segment_locked(), steel_state_.capture_count + 1);
  }

  std::string raw_capture_output_locked(const std::string& ip, const std::string& material_id, int sequence_no) const {
    std::ostringstream sequence;
    sequence << std::setw(6) << std::setfill('0') << std::max(1, sequence_no);
    std::filesystem::path output = storage_root_ /
                                   camera_storage_segment_locked(ip) /
                                   safe_path_segment(material_id.empty() ? "unknown-material" : material_id) /
                                   "depth" /
                                   (sequence.str() + ".png");
    return output.lexically_normal().string();
  }

  std::string material_storage_segment_locked() const {
    if (!steel_state_.steel_id.empty()) {
      return safe_path_segment(steel_state_.steel_id);
    }
    if (!steel_state_.session_id.empty()) {
      return safe_path_segment(steel_state_.session_id);
    }
    return "unknown-material";
  }

  std::string camera_storage_segment_locked(const std::string& ip) const {
    auto item = sessions_.find(ip);
    if (item != sessions_.end()) {
      const CameraSession& session = item->second;
      if (!session.sn.empty()) {
        return safe_path_segment(session.sn);
      }
      if (!session.ip.empty()) {
        return safe_path_segment(session.ip);
      }
    }
    return safe_path_segment(ip.empty() ? "camera" : ip);
  }

  void record_steel_capture_locked(const std::string& ip, const std::string& output, int code) {
    if (steel_state_.session_id.empty()) {
      return;
    }
    steel_state_.last_capture_at = now_iso();
    steel_state_.last_capture_ip = ip;
    steel_state_.last_capture_output = output;
    steel_state_.updated_at = steel_state_.last_capture_at;
    ++steel_state_.capture_count;
    if (code == CORRECT) {
      ++steel_state_.capture_success_count;
    } else {
      ++steel_state_.capture_failure_count;
    }
    write_steel_summary_locked();
  }

  void write_steel_summary_locked() const {
    if (steel_state_.summary_path.empty()) {
      return;
    }
    std::string body = steel_status_json_locked();
    if (!body.empty() && body.back() == '}') {
      body.pop_back();
      body += ",";
      body += json_pair("schema", "steel.capture.production-session.v1");
      body += ",";
      body += json_pair("summaryWrittenAt", now_iso());
      body += "}";
    }
    write_text_file(std::filesystem::path(steel_state_.summary_path), body);
  }

  std::string steel_event_json(const std::string& body) {
    std::string cmd = json_string_field(body, "cmd", json_string_field(body, "event", json_string_field(body, "type")));
    if (cmd.empty()) {
      return json_error(400, "missing steel event cmd");
    }
    std::lock_guard<std::mutex> lock(mutex_);
    const std::string now = now_iso();

    if (cmd == "steelIn" || cmd == "steel_in" || cmd == "in") {
      const int value = json_int_field(body, "value", json_bool_field(body, "present", true) ? 1 : 0);
      update_steel_info_locked(body, now);
      if (value != 0) {
        if (!steel_state_.present || steel_state_.session_id.empty()) {
          ensure_steel_session_locked(now);
        }
        steel_state_.present = true;
        steel_state_.phase = "steel-in";
        steel_state_.in_time = now;
        steel_state_.updated_at = now;
        ++steel_state_.in_count;
      } else {
        steel_state_.present = false;
        steel_state_.phase = "steel-out";
        steel_state_.out_time = now;
        steel_state_.session_finished_at = now;
        steel_state_.updated_at = now;
        ++steel_state_.out_count;
      }
    } else if (cmd == "rcvSteelInfo" || cmd == "steelInfo" || cmd == "steel_info") {
      update_steel_info_locked(body, now);
      if (steel_state_.phase == "idle") {
        steel_state_.phase = "info-ready";
      }
    } else if (cmd == "reset" || cmd == "clear") {
      steel_state_ = SteelState{};
      steel_state_.updated_at = now;
    } else {
      return json_error(400, "unknown steel event cmd");
    }

    if (cmd != "reset" && cmd != "clear") {
      ++steel_state_.event_count;
      write_steel_summary_locked();
    }
    std::string status = steel_status_json_locked();
    status.pop_back();
    status += ",";
    status += json_pair("event", cmd);
    status += "}";
    return status;
  }

  static std::string steel_phase_label(const std::string& phase) {
    if (phase == "steel-in") return "steel-in-capturing";
    if (phase == "steel-out") return "steel-out-finishing";
    if (phase == "info-ready") return "steel-info-ready";
    return "idle";
  }

  void update_steel_info_locked(const std::string& body, const std::string& now) {
    std::string steel_id = json_string_field(body, "id", json_string_field(body, "steelId", json_string_field(body, "steelNo")));
    if (!steel_id.empty()) {
      steel_state_.steel_id = steel_id;
    }
    std::string steel_type = json_string_field(body, "steelType", json_string_field(body, "type"));
    if (!steel_type.empty()) {
      steel_state_.steel_type = steel_type;
    }
    std::string client = json_string_field(body, "client");
    if (!client.empty()) {
      steel_state_.client = client;
    }
    std::string hard = json_string_field(body, "hard");
    if (!hard.empty()) {
      steel_state_.hard = hard;
    }
    steel_state_.length = json_float_field(body, "length", json_float_field(body, "len", static_cast<float>(steel_state_.length)));
    steel_state_.width = json_float_field(body, "width", static_cast<float>(steel_state_.width));
    steel_state_.thickness = json_float_field(body, "thick", json_float_field(body, "thickness", static_cast<float>(steel_state_.thickness)));
    if (json_has_field(body, "id") || json_has_field(body, "steelId") || json_has_field(body, "steelNo") ||
        json_has_field(body, "steelType") || json_has_field(body, "type") || json_has_field(body, "length") ||
        json_has_field(body, "len") || json_has_field(body, "width") || json_has_field(body, "thick") ||
        json_has_field(body, "thickness")) {
      steel_state_.info_time = now;
      steel_state_.updated_at = now;
    }
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
    <button onclick="load('/api/steel/status')">Steel Status</button>
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
  DriverMode driver_mode_ = DriverMode::Lvm;
  bool sdk_ready_ = false;
  std::filesystem::path storage_root_;
  std::filesystem::path config_root_;
  int expected_cameras_ = 6;
  std::string simulated_image_source_dir_;
  SteelState steel_state_;
  std::map<std::string, CameraSession> sessions_;
  int active_capture_batches_ = 0;
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
  DriverMode driver_mode = parse_driver_mode(std::getenv("CAPTURE_DRIVER") ? std::getenv("CAPTURE_DRIVER") : "", DriverMode::Lvm);
  for (int i = 1; i + 1 < argc; ++i) {
    if (std::string(argv[i]) == "--port") {
      port = std::stoi(argv[i + 1]);
    } else if (std::string(argv[i]) == "--driver" || std::string(argv[i]) == "--driver-mode") {
      driver_mode = parse_driver_mode(argv[i + 1], driver_mode);
    }
  }
  CaptureRuntime::instance().configure(driver_mode);
  return run_server(port);
}
