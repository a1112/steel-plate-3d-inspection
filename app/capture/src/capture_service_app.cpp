#include <winsock2.h>
#include <ws2tcpip.h>
#include <http.h>
#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <exception>
#include <filesystem>
#include <fstream>
#include <functional>
#include <future>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <queue>
#include <sstream>
#include <string>
#include <system_error>
#include <thread>
#include <vector>

#include "capture_service_app.h"
#include "calibration_contract.h"
#include "capture_concurrency_policy.h"
#include "capture_health_policy.h"
#include "capture_path_policy.h"
#include "owned_worker_registry.h"
#include "storage_thread_pool.h"
#include "lvm_sdk.h"

#pragma comment(lib, "httpapi.lib")
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "bcrypt.lib")

namespace {

std::atomic<bool> g_running{true};
std::atomic<bool> g_process_exit_required{false};
std::atomic<unsigned int> g_inflight_routes{0};
std::atomic<unsigned int> g_socket_clients{0};
std::atomic<unsigned long long> g_temp_file_counter{0};
constexpr int CAPTURE_DISCARDED_NOT_ARMED = 49000;
constexpr int BLACK_FRAME_DISCARDED = 49001;
constexpr int STORAGE_QUEUE_BACKPRESSURE = 49002;
constexpr int STORAGE_QUEUE_STOPPED = 49003;
constexpr int STORAGE_TASK_TOO_LARGE = 49004;
constexpr int CAPTURE_INTENSITY_MISSING = 49005;
constexpr int CAPTURE_DEPTH_FORMAT_UNSUPPORTED = 49006;
constexpr int SDK_CAPTURE_RESTART_REQUIRED = 49007;
constexpr int CALIBRATION_ARTIFACT_KIND_MISMATCH = 49008;
constexpr int CALIBRATION_PREFLIGHT_FAILED = 49009;
constexpr int CALIBRATION_ROLLBACK_UNAVAILABLE = 49010;
constexpr int CALIBRATION_ROLLBACK_FAILED = 49011;
constexpr int CALIBRATION_CONFIRMATION_REQUIRED = 49012;
constexpr int CALIBRATION_RECOVERY_REQUIRED = 423;

#ifdef _WIN32
constexpr wchar_t CAPTURE_SDK_OWNER_MUTEX_NAME[] =
    L"Global\\SteelPlate3DInspection.CaptureSdkOwner.v1";
std::atomic<HANDLE> g_console_stop_event{nullptr};
std::atomic<HANDLE> g_console_shutdown_complete_event{nullptr};
std::atomic<DWORD> g_console_stop_reason{0};

std::string win32_error_text(DWORD code) {
  return std::error_code(static_cast<int>(code), std::system_category()).message();
}

BOOL WINAPI capture_console_control_handler(DWORD control_type) {
  switch (control_type) {
    case CTRL_C_EVENT:
    case CTRL_BREAK_EVENT:
    case CTRL_CLOSE_EVENT:
    case CTRL_LOGOFF_EVENT:
    case CTRL_SHUTDOWN_EVENT: {
      g_console_stop_reason.store(control_type, std::memory_order_relaxed);
      g_running.store(false, std::memory_order_release);
      HANDLE stop_event = g_console_stop_event.load(std::memory_order_acquire);
      if (stop_event) {
        SetEvent(stop_event);
      }
      if (control_type == CTRL_CLOSE_EVENT ||
          control_type == CTRL_LOGOFF_EVENT ||
          control_type == CTRL_SHUTDOWN_EVENT) {
        HANDLE shutdown_complete =
            g_console_shutdown_complete_event.load(std::memory_order_acquire);
        if (shutdown_complete) {
          // Windows terminates the process after these handlers return. Give the
          // main thread a bounded opportunity to drain routes and release the SDK.
          WaitForSingleObject(shutdown_complete, 4500);
        }
      }
      return TRUE;
    }
    default:
      return FALSE;
  }
}
#endif

class CaptureSdkOwnerMutex {
 public:
  CaptureSdkOwnerMutex() = default;

  bool try_acquire() {
#ifdef _WIN32
    handle_ = CreateMutexW(nullptr, FALSE, CAPTURE_SDK_OWNER_MUTEX_NAME);
    if (!handle_) {
      const DWORD error = GetLastError();
      error_ = "cannot create/open SDK owner mutex (Win32 " + std::to_string(error) +
               ": " + win32_error_text(error) + ")";
      return false;
    }

    const DWORD wait_result = WaitForSingleObject(handle_, 0);
    if (wait_result == WAIT_OBJECT_0 || wait_result == WAIT_ABANDONED) {
      owns_ = true;
      if (wait_result == WAIT_ABANDONED) {
        std::cerr << "Warning: recovered abandoned capture SDK owner mutex.\n";
      }
      return true;
    }
    if (wait_result == WAIT_TIMEOUT) {
      error_ = "another steel_capture_service process already owns the camera SDK";
    } else {
      const DWORD error = GetLastError();
      error_ = "cannot acquire SDK owner mutex (Win32 " + std::to_string(error) +
               ": " + win32_error_text(error) + ")";
    }
    CloseHandle(handle_);
    handle_ = nullptr;
    return false;
#else
    return true;
#endif
  }

  const std::string& error() const {
    return error_;
  }

  ~CaptureSdkOwnerMutex() {
#ifdef _WIN32
    if (owns_ && handle_) {
      ReleaseMutex(handle_);
    }
    if (handle_) {
      CloseHandle(handle_);
    }
#endif
  }

  CaptureSdkOwnerMutex(const CaptureSdkOwnerMutex&) = delete;
  CaptureSdkOwnerMutex& operator=(const CaptureSdkOwnerMutex&) = delete;

 private:
  std::string error_;
#ifdef _WIN32
  HANDLE handle_ = nullptr;
  bool owns_ = false;
#endif
};

class CaptureConsoleStopHandler {
 public:
  CaptureConsoleStopHandler() = default;

  bool install() {
    g_running.store(true, std::memory_order_release);
    g_process_exit_required.store(false, std::memory_order_release);
#ifdef _WIN32
    g_console_stop_reason.store(0, std::memory_order_relaxed);
    stop_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!stop_event_) {
      const DWORD error = GetLastError();
      error_ = "cannot create console stop event (Win32 " + std::to_string(error) +
               ": " + win32_error_text(error) + ")";
      return false;
    }
    shutdown_complete_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!shutdown_complete_event_) {
      const DWORD error = GetLastError();
      CloseHandle(stop_event_);
      stop_event_ = nullptr;
      error_ = "cannot create console shutdown-complete event (Win32 " +
               std::to_string(error) + ": " + win32_error_text(error) + ")";
      return false;
    }
    g_console_stop_event.store(stop_event_, std::memory_order_release);
    g_console_shutdown_complete_event.store(shutdown_complete_event_,
                                             std::memory_order_release);
    if (!SetConsoleCtrlHandler(capture_console_control_handler, TRUE)) {
      const DWORD error = GetLastError();
      g_console_stop_event.store(nullptr, std::memory_order_release);
      g_console_shutdown_complete_event.store(nullptr, std::memory_order_release);
      CloseHandle(stop_event_);
      CloseHandle(shutdown_complete_event_);
      stop_event_ = nullptr;
      shutdown_complete_event_ = nullptr;
      error_ = "cannot install console control handler (Win32 " + std::to_string(error) +
               ": " + win32_error_text(error) + ")";
      return false;
    }
    installed_ = true;
#endif
    return true;
  }

  const std::string& error() const {
    return error_;
  }

#ifdef _WIN32
  HANDLE stop_event() const {
    return stop_event_;
  }

  void signal_shutdown_complete() const {
    if (shutdown_complete_event_) {
      SetEvent(shutdown_complete_event_);
    }
  }
#endif

  ~CaptureConsoleStopHandler() {
#ifdef _WIN32
    if (installed_) {
      SetConsoleCtrlHandler(capture_console_control_handler, FALSE);
    }
    g_console_stop_event.store(nullptr, std::memory_order_release);
    g_console_shutdown_complete_event.store(nullptr, std::memory_order_release);
    if (stop_event_) {
      CloseHandle(stop_event_);
    }
    if (shutdown_complete_event_) {
      CloseHandle(shutdown_complete_event_);
    }
#endif
  }

  CaptureConsoleStopHandler(const CaptureConsoleStopHandler&) = delete;
  CaptureConsoleStopHandler& operator=(const CaptureConsoleStopHandler&) = delete;

 private:
  std::string error_;
#ifdef _WIN32
  HANDLE stop_event_ = nullptr;
  HANDLE shutdown_complete_event_ = nullptr;
  bool installed_ = false;
#endif
};

class InflightRouteGuard {
 public:
  InflightRouteGuard() {
    g_inflight_routes.fetch_add(1, std::memory_order_acq_rel);
  }
  ~InflightRouteGuard() {
    g_inflight_routes.fetch_sub(1, std::memory_order_acq_rel);
  }
  InflightRouteGuard(const InflightRouteGuard&) = delete;
  InflightRouteGuard& operator=(const InflightRouteGuard&) = delete;
};

class SocketClientCountGuard {
 public:
  ~SocketClientCountGuard() {
    g_socket_clients.fetch_sub(1, std::memory_order_acq_rel);
  }
  SocketClientCountGuard() = default;
  SocketClientCountGuard(const SocketClientCountGuard&) = delete;
  SocketClientCountGuard& operator=(const SocketClientCountGuard&) = delete;
};

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
    case CAPTURE_DISCARDED_NOT_ARMED: return "CAPTURE_DISCARDED_NOT_ARMED";
    case BLACK_FRAME_DISCARDED: return "BLACK_FRAME_DISCARDED";
    case STORAGE_QUEUE_BACKPRESSURE: return "STORAGE_QUEUE_BACKPRESSURE";
    case STORAGE_QUEUE_STOPPED: return "STORAGE_QUEUE_STOPPED";
    case STORAGE_TASK_TOO_LARGE: return "STORAGE_TASK_TOO_LARGE";
    case CAPTURE_INTENSITY_MISSING: return "CAPTURE_INTENSITY_MISSING";
    case CAPTURE_DEPTH_FORMAT_UNSUPPORTED: return "CAPTURE_DEPTH_FORMAT_UNSUPPORTED";
    case SDK_CAPTURE_RESTART_REQUIRED: return "SDK_CAPTURE_RESTART_REQUIRED";
    case CALIBRATION_ARTIFACT_KIND_MISMATCH: return "CALIBRATION_ARTIFACT_KIND_MISMATCH";
    case CALIBRATION_PREFLIGHT_FAILED: return "CALIBRATION_PREFLIGHT_FAILED";
    case CALIBRATION_ROLLBACK_UNAVAILABLE: return "CALIBRATION_ROLLBACK_UNAVAILABLE";
    case CALIBRATION_ROLLBACK_FAILED: return "CALIBRATION_ROLLBACK_FAILED";
    case CALIBRATION_CONFIRMATION_REQUIRED: return "CALIBRATION_CONFIRMATION_REQUIRED";
    case CALIBRATION_RECOVERY_REQUIRED: return "CALIBRATION_RECOVERY_REQUIRED";
    case DEV_LOAD_DATA_ERROR: return "DEV_LOAD_DATA_ERROR";
    case MALLOC_FAILED: return "MALLOC_FAILED";
    case INPUT_PARAMETER_ERROR: return "INPUT_PARAMETER_ERROR";
    case DEV_NOT_LINK_ERROR: return "DEV_NOT_LINK_ERROR";
    case 40065: return "LVMS_GET_DATA_TIMEOUT";
    case 409: return "STREAM_CONFLICT";
    case 500: return "IO_ERROR";
    case 504: return "CAPTURE_WORKER_TIMEOUT";
    default: return "SDK_ERROR_" + std::to_string(code);
  }
}

std::string capture_error_hint(int code) {
  switch (code) {
    case CORRECT:
      return "ok";
    case CAPTURE_DISCARDED_NOT_ARMED:
      return "production capture is in discard state; send steel-in before saving frames";
    case BLACK_FRAME_DISCARDED:
      return "frame was discarded because the intensity image is below the black-frame threshold";
    case STORAGE_QUEUE_BACKPRESSURE:
      return "storage queue stayed full until the enqueue deadline; verify disk throughput and queue health before retrying";
    case STORAGE_QUEUE_STOPPED:
      return "storage queue is stopping and no longer accepts capture artifacts";
    case STORAGE_TASK_TOO_LARGE:
      return "one capture artifact exceeds the configured storage queue byte budget";
    case CAPTURE_INTENSITY_MISSING:
      return "SDK returned a depth frame without a valid intensity image; verify capture data type and reconnect the camera";
    case CAPTURE_DEPTH_FORMAT_UNSUPPORTED:
      return "SDK returned a depth representation that cannot be safely persisted after buffer release; use unsigned-short depth format or the supported float fallback";
    case SDK_CAPTURE_RESTART_REQUIRED:
      return "a previous SDK capture exceeded its hard timeout; restart the capture provider before issuing more SDK capture commands";
    case CALIBRATION_ARTIFACT_KIND_MISMATCH:
      return "array reconstruction XML and per-camera SDK calibration XML are different artifacts; provide one SDK file mapping per camera";
    case CALIBRATION_PREFLIGHT_FAILED:
      return "calibration preflight failed and no camera calibration was changed";
    case CALIBRATION_ROLLBACK_UNAVAILABLE:
      return "the SDK cannot export the previous calibration; provide a per-camera rollbackPath or use runtime-only best-effort rollback";
    case CALIBRATION_ROLLBACK_FAILED:
      return "one or more camera or profile states could not be restored; restart and reapply known per-camera calibration files";
    case CALIBRATION_CONFIRMATION_REQUIRED:
      return "repeat the request with the exact calibration confirmation phrase shown by preflight";
    case CALIBRATION_RECOVERY_REQUIRED:
      return "finish the pending calibration rollback before issuing new capture, configuration, or production writes";
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
    case 504:
      return "capture worker exceeded the hard timeout; the SDK grab call may still be unwinding in the background";
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

enum class UniqueQueryParamState {
  Missing,
  Present,
  Invalid,
};

UniqueQueryParamState get_unique_query_param(const std::string& query,
                                             const std::string& key,
                                             std::string& value) {
  bool found = false;
  size_t begin = 0;
  while (begin <= query.size()) {
    const size_t end = query.find('&', begin);
    const std::string segment = query.substr(
        begin, end == std::string::npos ? std::string::npos : end - begin);
    const size_t equals = segment.find('=');
    const std::string segment_key =
        equals == std::string::npos ? segment : segment.substr(0, equals);
    if (segment_key == key) {
      if (found || equals == std::string::npos) {
        return UniqueQueryParamState::Invalid;
      }
      found = true;
      value = url_decode(segment.substr(equals + 1));
    }
    if (end == std::string::npos) {
      break;
    }
    begin = end + 1;
  }
  return found ? UniqueQueryParamState::Present
               : UniqueQueryParamState::Missing;
}

bool parse_unique_unsigned_query_param(const std::string& query,
                                       const std::string& key,
                                       std::uint64_t& value) {
  std::string text;
  if (get_unique_query_param(query, key, text) !=
          UniqueQueryParamState::Present ||
      text.empty()) {
    return false;
  }
  std::uint64_t parsed = 0;
  for (const unsigned char ch : text) {
    if (!std::isdigit(ch)) {
      return false;
    }
    const std::uint64_t digit = static_cast<std::uint64_t>(ch - '0');
    if (parsed > (std::numeric_limits<std::uint64_t>::max() - digit) / 10) {
      return false;
    }
    parsed = parsed * 10 + digit;
  }
  value = parsed;
  return true;
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

std::map<std::string, std::string> merge_string_maps(std::map<std::string, std::string> base,
                                                     const std::map<std::string, std::string>& overlay) {
  for (const auto& item : overlay) {
    if (!item.first.empty() && !item.second.empty()) {
      base[item.first] = item.second;
    }
  }
  return base;
}

std::map<std::string, std::string> json_camera_roots_array_field(const std::string& body, const std::string& key) {
  std::map<std::string, std::string> roots;
  for (const std::string& object : json_object_array_field(body, key)) {
    std::string ip = json_string_field(object, "ip");
    std::string root = json_string_field(object, "root",
                       json_string_field(object, "storageRoot",
                       json_string_field(object, "storageDir",
                       json_string_field(object, "captureRoot",
                       json_string_field(object, "path")))));
    if (!ip.empty() && !root.empty()) {
      roots[ip] = root;
    }
  }
  return roots;
}

std::map<std::string, std::string> json_profile_camera_roots_field(const std::string& profile) {
  std::map<std::string, std::string> roots = json_camera_roots_array_field(profile, "cameraRoots");
  roots = merge_string_maps(roots, json_camera_roots_array_field(profile, "cameraStorageRoots"));
  roots = merge_string_maps(roots, json_camera_roots_array_field(profile, "cameraStorageDirs"));
  for (const std::string& object : json_object_array_field(profile, "cameras")) {
    std::string ip = json_string_field(object, "ip");
    std::string root = json_string_field(object, "storageRoot",
                       json_string_field(object, "storageDir",
                       json_string_field(object, "captureRoot",
                       json_string_field(object, "outputRoot"))));
    if (!ip.empty() && !root.empty()) {
      roots[ip] = root;
    }
  }
  return roots;
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

std::filesystem::path default_camera_storage_base_path() {
  const char* env_root = std::getenv("CAPTURE_CAMERA_STORAGE_ROOT");
  if (env_root && *env_root) {
    return absolute_normalized_path(env_root);
  }
  std::error_code error;
  if (std::filesystem::exists("H:\\", error)) {
    return std::filesystem::path("H:\\").lexically_normal();
  }
  return default_storage_root_path();
}

std::vector<std::string> default_clockwise_camera_ips() {
  return {
      "192.168.101.100",
      "192.168.102.100",
      "192.168.103.100",
      "192.168.104.100",
      "192.168.105.100",
      "192.168.106.100",
      "192.168.107.100",
      "192.168.108.100",
  };
}

std::map<std::string, std::string> default_camera_storage_roots() {
  std::map<std::string, std::string> roots;
  const std::filesystem::path base = default_camera_storage_base_path();
  const std::vector<std::string> ips = default_clockwise_camera_ips();
  for (size_t i = 0; i < ips.size(); ++i) {
    roots[ips[i]] = (base / ("camera" + std::to_string(i + 1))).lexically_normal().string();
  }
  return roots;
}

std::string camera_storage_roots_array_json(const std::map<std::string, std::filesystem::path>& roots) {
  std::ostringstream json;
  json << "[";
  bool first = true;
  for (const auto& item : roots) {
    if (!first) {
      json << ",";
    }
    first = false;
    json << "{"
         << json_pair("ip", item.first) << ","
         << json_pair("root", item.second.string())
         << "}";
  }
  json << "]";
  return json.str();
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

std::uintmax_t json_uintmax_field(
    const std::string& body,
    const std::string& key,
    std::uintmax_t fallback = 0) {
  const std::string needle = "\"" + key + "\"";
  const size_t key_pos = body.find(needle);
  if (key_pos == std::string::npos) {
    return fallback;
  }
  const size_t colon = body.find(':', key_pos + needle.size());
  if (colon == std::string::npos) {
    return fallback;
  }
  const size_t end = body.find_first_of(",}", colon + 1);
  const std::string raw = trim(body.substr(
      colon + 1,
      end == std::string::npos ? std::string::npos : end - colon - 1));
  try {
    return static_cast<std::uintmax_t>(std::stoull(raw));
  } catch (...) {
    return fallback;
  }
}

bool is_valid_operation_id(const std::string& value) {
  if (value.empty() || value.size() > 128) {
    return false;
  }
  return std::all_of(value.begin(), value.end(), [](unsigned char ch) {
    return std::isalnum(ch) || ch == '-' || ch == '_' || ch == '.' ||
           ch == ':';
  });
}

std::size_t storage_size_setting(const char* name,
                                 std::size_t fallback,
                                 std::size_t minimum,
                                 std::size_t maximum) {
  const char* text = std::getenv(name);
  if (!text || !*text) {
    return fallback;
  }
  if (*text == '-') {
    std::cerr << "Ignoring invalid " << name << "='" << text << "'.\n";
    return fallback;
  }
  char* end = nullptr;
  const unsigned long long value = std::strtoull(text, &end, 10);
  if (!end || *end != '\0') {
    std::cerr << "Ignoring invalid " << name << "='" << text << "'.\n";
    return fallback;
  }
  const unsigned long long bounded = std::max<unsigned long long>(
      minimum, std::min<unsigned long long>(maximum, value));
  return static_cast<std::size_t>(bounded);
}

std::size_t storage_worker_count_setting() {
  return storage_size_setting("CAPTURE_STORAGE_WORKERS", 0, 0, 64);
}

std::size_t storage_queue_items_setting() {
  return storage_size_setting(
      "CAPTURE_STORAGE_QUEUE_ITEMS",
      steel_capture::StorageThreadPool::kDefaultMaxPendingItems,
      1,
      4096);
}

std::size_t storage_queue_bytes_setting() {
  constexpr std::size_t minimum = 1024ULL * 1024ULL;
  constexpr std::size_t maximum =
      sizeof(std::size_t) >= 8 ? (64ULL * 1024ULL * 1024ULL * 1024ULL)
                               : std::numeric_limits<std::size_t>::max();
  return storage_size_setting(
      "CAPTURE_STORAGE_QUEUE_BYTES",
      steel_capture::StorageThreadPool::kDefaultMaxPendingBytes,
      minimum,
      maximum);
}

int storage_enqueue_timeout_ms_setting() {
  return static_cast<int>(storage_size_setting(
      "CAPTURE_STORAGE_ENQUEUE_TIMEOUT_MS", 2000, 0, 600000));
}

std::size_t storage_pending_tickets_setting() {
  return storage_size_setting(
      "CAPTURE_STORAGE_PENDING_TICKETS",
      steel_capture::StorageThreadPool::kDefaultMaxPendingItems,
      1,
      4096);
}

int simulated_storage_delay_ms_setting() {
  return static_cast<int>(storage_size_setting(
      "CAPTURE_SIMULATED_STORAGE_DELAY_MS", 0, 0, 5000));
}

std::string simulated_calibration_fail_ip_setting() {
  const char* value = std::getenv("CAPTURE_SIMULATED_CALIBRATION_FAIL_IP");
  return value ? trim(value) : "";
}

constexpr const char* kCalibrationCrashTestConfirmation =
    "ALLOW CONTROLLED CAMERA CALIBRATION PROCESS CRASH";

std::string environment_text(const char* name) {
  const char* value = std::getenv(name);
  return value ? trim(value) : "";
}

int calibration_crash_camera_index_setting() {
  const std::string text =
      environment_text("CAPTURE_CALIBRATION_CRASH_CAMERA_INDEX");
  if (text.empty()) {
    return 0;
  }
  try {
    const int value = std::stoi(text);
    return value >= 1 && value <= 64 ? value : 0;
  } catch (...) {
    return 0;
  }
}

bool calibration_crash_failpoint_armed() {
  const std::string confirmation =
      environment_text("CAPTURE_CALIBRATION_CRASH_CONFIRMATION");
  const std::string operation_id =
      environment_text("CAPTURE_CALIBRATION_CRASH_OPERATION_ID");
  const std::string phase =
      environment_text("CAPTURE_CALIBRATION_CRASH_PHASE");
  return confirmation == kCalibrationCrashTestConfirmation &&
         is_valid_operation_id(operation_id) && !phase.empty() &&
         calibration_crash_camera_index_setting() > 0;
}

void maybe_crash_calibration_failpoint(const std::string& operation_id,
                                       const std::string& phase,
                                       int camera_index) {
  if (!calibration_crash_failpoint_armed() ||
      environment_text("CAPTURE_CALIBRATION_CRASH_OPERATION_ID") !=
          operation_id ||
      environment_text("CAPTURE_CALIBRATION_CRASH_PHASE") != phase ||
      calibration_crash_camera_index_setting() != camera_index) {
    return;
  }
  std::cerr << "Controlled calibration crash failpoint triggered: operationId="
            << operation_id << ", phase=" << phase
            << ", cameraIndex=" << camera_index << "\n";
  std::cerr.flush();
#ifdef _WIN32
  ::TerminateProcess(::GetCurrentProcess(), 197);
#endif
  std::abort();
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

bool read_png_dimensions(const std::filesystem::path& path,
                         std::uint32_t& width,
                         std::uint32_t& height) {
  std::ifstream file(path, std::ios::binary);
  if (!file) {
    return false;
  }
  unsigned char header[24]{};
  file.read(reinterpret_cast<char*>(header), sizeof(header));
  if (file.gcount() != static_cast<std::streamsize>(sizeof(header))) {
    return false;
  }
  static const unsigned char signature[8] = {
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a};
  if (!std::equal(signature, signature + sizeof(signature), header) ||
      header[8] != 0 || header[9] != 0 || header[10] != 0 ||
      header[11] != 13 || header[12] != 'I' || header[13] != 'H' ||
      header[14] != 'D' || header[15] != 'R') {
    return false;
  }
  const auto big_endian_u32 = [&header](size_t offset) {
    return (static_cast<std::uint32_t>(header[offset]) << 24) |
           (static_cast<std::uint32_t>(header[offset + 1]) << 16) |
           (static_cast<std::uint32_t>(header[offset + 2]) << 8) |
           static_cast<std::uint32_t>(header[offset + 3]);
  };
  width = big_endian_u32(16);
  height = big_endian_u32(20);
  return width > 0 && height > 0;
}

std::filesystem::path temp_output_path_for(const std::filesystem::path& target) {
  std::ostringstream suffix;
  suffix << ".tmp-" << GetCurrentProcessId()
         << "-" << std::this_thread::get_id()
         << "-" << g_temp_file_counter.fetch_add(1);
  return target.parent_path() / (target.stem().string() + suffix.str() + target.extension().string());
}

bool replace_with_completed_file(const std::filesystem::path& temp_path, const std::filesystem::path& target_path) {
  std::error_code error;
  std::filesystem::create_directories(target_path.parent_path(), error);
  if (error) {
    std::filesystem::remove(temp_path, error);
    return false;
  }
  error.clear();
  std::filesystem::remove(target_path, error);
  error.clear();
  std::filesystem::rename(temp_path, target_path, error);
  std::error_code exists_error;
  if (!error && std::filesystem::exists(target_path, exists_error) && std::filesystem::is_regular_file(target_path, exists_error)) {
    return true;
  }
  error.clear();
  std::filesystem::copy_file(temp_path, target_path, std::filesystem::copy_options::overwrite_existing, error);
  std::error_code remove_error;
  std::filesystem::remove(temp_path, remove_error);
  exists_error.clear();
  return !error && std::filesystem::exists(target_path, exists_error) && std::filesystem::is_regular_file(target_path, exists_error);
}

bool write_text_file(const std::filesystem::path& path, const std::string& body) {
  std::error_code error;
  std::filesystem::create_directories(path.parent_path(), error);
  if (error) {
    return false;
  }
  const std::filesystem::path temp_path = temp_output_path_for(path);
  std::ofstream file(temp_path, std::ios::binary | std::ios::trunc);
  if (!file) {
    return false;
  }
  file << body;
  file.close();
  return static_cast<bool>(file) && replace_with_completed_file(temp_path, path);
}

// Rollback manifests are a write-ahead safety boundary. Keep their publication
// atomic and ask Windows to flush both the temporary contents and the rename so
// a successful return is stronger than the best-effort writer used by ordinary
// diagnostics and profile files.
bool write_durable_text_file(const std::filesystem::path& path,
                             const std::string& body) {
  std::error_code error;
  std::filesystem::create_directories(path.parent_path(), error);
  if (error) {
    return false;
  }
  const std::filesystem::path temp_path = temp_output_path_for(path);
  HANDLE file = CreateFileW(
      temp_path.wstring().c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    return false;
  }

  bool ok = true;
  std::size_t offset = 0;
  while (offset < body.size()) {
    const std::size_t remaining = body.size() - offset;
    const DWORD chunk = static_cast<DWORD>(std::min<std::size_t>(
        remaining, static_cast<std::size_t>(std::numeric_limits<DWORD>::max())));
    DWORD written = 0;
    if (!WriteFile(file, body.data() + offset, chunk, &written, nullptr) ||
        written != chunk) {
      ok = false;
      break;
    }
    offset += written;
  }
  if (ok && !FlushFileBuffers(file)) {
    ok = false;
  }
  CloseHandle(file);
  if (!ok || !MoveFileExW(
                 temp_path.wstring().c_str(), path.wstring().c_str(),
                 MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    DeleteFileW(temp_path.wstring().c_str());
    return false;
  }
  error.clear();
  return std::filesystem::exists(path, error) &&
         std::filesystem::is_regular_file(path, error);
}

bool mark_file_read_only(const std::filesystem::path& path) {
  const std::wstring native = path.wstring();
  const DWORD attributes = GetFileAttributesW(native.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES &&
         SetFileAttributesW(native.c_str(), attributes | FILE_ATTRIBUTE_READONLY);
}

bool sha256_file(const std::filesystem::path& path,
                 std::string& digest,
                 std::uintmax_t& size) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_length = 0;
  DWORD hash_length = 0;
  DWORD result_length = 0;
  if (BCryptOpenAlgorithmProvider(
          &algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0 ||
      BCryptGetProperty(
          algorithm, BCRYPT_OBJECT_LENGTH,
          reinterpret_cast<PUCHAR>(&object_length), sizeof(object_length),
          &result_length, 0) != 0 ||
      BCryptGetProperty(
          algorithm, BCRYPT_HASH_LENGTH,
          reinterpret_cast<PUCHAR>(&hash_length), sizeof(hash_length),
          &result_length, 0) != 0) {
    if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
    return false;
  }
  std::vector<unsigned char> object(object_length);
  std::vector<unsigned char> bytes(hash_length);
  if (BCryptCreateHash(
          algorithm, &hash, object.data(), object_length, nullptr, 0, 0) != 0) {
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return false;
  }

  std::ifstream input(path, std::ios::binary);
  bool ok = static_cast<bool>(input);
  std::uintmax_t total = 0;
  char buffer[8192];
  while (ok && input) {
    input.read(buffer, static_cast<std::streamsize>(sizeof(buffer)));
    const std::streamsize count = input.gcount();
    if (count > 0 && BCryptHashData(
                         hash, reinterpret_cast<PUCHAR>(buffer),
                         static_cast<ULONG>(count), 0) != 0) {
      ok = false;
      break;
    }
    total += static_cast<std::uintmax_t>(count);
  }
  if (!input.eof()) {
    ok = false;
  }
  if (ok && BCryptFinishHash(hash, bytes.data(), hash_length, 0) != 0) {
    ok = false;
  }
  BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (!ok || total == 0 || hash_length != 32) {
    return false;
  }

  std::ostringstream hex;
  hex << std::hex << std::setfill('0');
  for (unsigned char byte : bytes) {
    hex << std::setw(2) << static_cast<unsigned int>(byte);
  }
  digest = hex.str();
  size = total;
  return true;
}

bool is_sha256_hex(const std::string& value) {
  return value.size() == 64 &&
         std::all_of(value.begin(), value.end(), [](unsigned char ch) {
           return std::isxdigit(ch) != 0;
         });
}

bool file_exists(const std::string& path) {
  if (path.empty()) {
    return false;
  }
  std::error_code error;
  const std::filesystem::path candidate(path);
  return std::filesystem::exists(candidate, error) && std::filesystem::is_regular_file(candidate, error);
}

bool wait_for_file_exists(const std::string& path, int timeout_ms = 750) {
  if (path.empty()) {
    return false;
  }
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  do {
    if (file_exists(path)) {
      return true;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(15));
  } while (std::chrono::steady_clock::now() < deadline);
  return file_exists(path);
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
  const std::filesystem::path temp_path = temp_output_path_for(target_path);
  std::filesystem::copy_file(source_path, temp_path, std::filesystem::copy_options::overwrite_existing, error);
  if (error) {
    std::filesystem::remove(temp_path, error);
    return false;
  }
  return replace_with_completed_file(temp_path, target_path);
}

std::size_t estimated_frame_bytes(int width, int height, std::size_t bytes_per_pixel) {
  if (width <= 0 || height <= 0 || bytes_per_pixel == 0) {
    return 0;
  }
  const std::size_t width_value = static_cast<std::size_t>(width);
  const std::size_t height_value = static_cast<std::size_t>(height);
  if (width_value > std::numeric_limits<std::size_t>::max() / height_value) {
    return std::numeric_limits<std::size_t>::max();
  }
  const std::size_t pixels = width_value * height_value;
  if (pixels > std::numeric_limits<std::size_t>::max() / bytes_per_pixel) {
    return std::numeric_limits<std::size_t>::max();
  }
  return pixels * bytes_per_pixel;
}

std::size_t saturating_size_add(std::size_t left, std::size_t right) {
  if (left > std::numeric_limits<std::size_t>::max() - right) {
    return std::numeric_limits<std::size_t>::max();
  }
  return left + right;
}

int storage_submit_error_code(steel_capture::StorageSubmitStatus status) {
  switch (status) {
    case steel_capture::StorageSubmitStatus::TimedOut:
      return STORAGE_QUEUE_BACKPRESSURE;
    case steel_capture::StorageSubmitStatus::Stopped:
      return STORAGE_QUEUE_STOPPED;
    case steel_capture::StorageSubmitStatus::TooLarge:
      return STORAGE_TASK_TOO_LARGE;
    case steel_capture::StorageSubmitStatus::InvalidTask:
      return INPUT_PARAMETER_ERROR;
    case steel_capture::StorageSubmitStatus::Accepted:
      return CORRECT;
  }
  return 500;
}

std::future<int> ready_int_future(int value) {
  std::promise<int> promise;
  std::future<int> future = promise.get_future();
  promise.set_value(value);
  return future;
}

int wait_storage_future(std::future<int>& future) noexcept {
  try {
    return future.get();
  } catch (const std::exception& error) {
    std::cerr << "Storage task failed with an exception: " << error.what() << "\n";
  } catch (...) {
    std::cerr << "Storage task failed with an unknown exception.\n";
  }
  return 500;
}

struct RouteResult {
  USHORT status = 200;
  std::string body;
  std::string content_type = "application/json; charset=utf-8";
};

bool route_allowed_when_sdk_capture_poisoned(const std::string& method,
                                             const std::string& path) {
  if (method == "GET") {
    return path == "/" || path == "/ui" || path == "/health" ||
           path == "/api/capture/health" || path == "/api/capture/logs" ||
           path == "/api/storage/status" ||
           path == "/api/config/status" || path == "/api/config/profiles" ||
           path == "/api/config/profile" || path == "/api/capture/file" ||
           path == "/api/capture/latest" || path == "/api/steel/status" ||
           path == "/api/capture/continuous-settings" ||
           path == "/api/stream/status" || path == "/api/stream/latest" ||
           path == "/api/calibration/active" || path == "/api/calibration/status";
  }
  if (method == "POST") {
    return path == "/api/storage/config" ||
           path == "/api/storage/camera-roots" ||
           path == "/api/config/profile/save" ||
           path == "/api/config/profile/import" ||
           path == "/api/calibration/active" ||
           path == "/api/steel/capture-mode" ||
           path == "/api/steel/event";
  }
  return method == "OPTIONS";
}

bool route_allowed_when_calibration_recovery_required(
    const std::string& method,
    const std::string& path) {
  if (method == "GET" || method == "OPTIONS") {
    return true;
  }
  if (method != "POST") {
    return false;
  }
  return path == "/api/camera/connect" ||
         path == "/api/cameras/connect-all" ||
         path == "/api/camera/connect-all" ||
         path == "/api/camera/disconnect" ||
         path == "/api/cameras/disconnect-all" ||
         path == "/api/camera/disconnect-all" ||
         path == "/api/stream/stop" ||
         path == "/api/calibration/rollback";
}

class CaptureRuntime {
 public:
  static CaptureRuntime& instance() {
    static CaptureRuntime runtime;
    return runtime;
  }

  void configure(DriverMode mode, bool force_driver_mode) {
    std::lock_guard<std::mutex> lock(mutex_);
    shutting_down_.store(false, std::memory_order_release);
    driver_mode_ = mode;
    capture_logs_.push_front({now_iso(), "info", "", "Capture provider configured"});
    load_active_profile_settings_locked(true);
    // run_capture_service_app acquires the global SDK owner mutex before
    // configure(), so persisted generation state cannot be raced by another
    // formal capture provider while it is reconstructed.
    load_calibration_rollback_manifests_locked();
    if (force_driver_mode) {
      driver_mode_ = mode;
    }
    auto_connect_active_profile_locked();
  }

  RouteResult route(const std::string& method, const std::string& path, const std::string& query, const std::string& body) {
    InflightRouteGuard inflight_route;
    owned_capture_workers_.reap_completed();
    if (shutting_down_.load(std::memory_order_acquire)) {
      return {503, json_error(503, "capture service is shutting down")};
    }
    if (method == "OPTIONS") {
      return {200, "{}", "application/json; charset=utf-8"};
    }
    if (method == "GET" && (path == "/" || path == "/ui")) {
      return {200, ui_html(), "text/html; charset=utf-8"};
    }
    if (method == "GET" && path == "/api/capture/logs") {
      return {200, capture_logs_json()};
    }
    if (method == "POST") {
      record_capture_log("info", json_string_field(body, "ip"),
                         "Provider received " + method + " " + path);
    }
    bool recovery_required = false;
    bool invalid_manifest = false;
    int pending_recovery_count = 0;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      invalid_manifest = !calibration_rollback_manifest_set_valid_;
      pending_recovery_count = pending_calibration_recovery_count_locked();
      recovery_required = invalid_manifest || pending_recovery_count > 0;
    }
    if (recovery_required &&
        !route_allowed_when_calibration_recovery_required(method, path)) {
      std::ostringstream error;
      error << "{\"code\":" << CALIBRATION_RECOVERY_REQUIRED << ","
            << json_pair("errorName", capture_error_name(CALIBRATION_RECOVERY_REQUIRED)) << ","
            << json_pair("error", "calibration recovery is required before new provider writes") << ","
            << json_pair("operatorHint", capture_error_hint(CALIBRATION_RECOVERY_REQUIRED)) << ","
            << "\"recoveryRequired\":true,"
            << "\"invalidManifest\":" << (invalid_manifest ? "true" : "false") << ","
            << "\"pendingRecoveryCount\":" << pending_recovery_count
            << "}";
      return {static_cast<USHORT>(CALIBRATION_RECOVERY_REQUIRED), error.str()};
    }
    bool reject_for_poison = false;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      reject_for_poison = driver_mode_ != DriverMode::Simulated &&
                          sdk_capture_restart_required() &&
                          !route_allowed_when_sdk_capture_poisoned(method, path);
    }
    if (reject_for_poison) {
      return {503, sdk_capture_restart_error_json()};
    }
    if (method == "GET" && (path == "/health" || path == "/api/capture/health")) return {200, health_json()};
    if (method == "GET" && path == "/api/storage/status") return {200, storage_status_json()};
    if (method == "POST" && path == "/api/storage/config") return {200, storage_config_json(body)};
    if (method == "POST" && path == "/api/storage/camera-roots") return {200, storage_camera_roots_config_json(body)};
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
    if (method == "POST" && (path == "/api/cameras/disconnect-all" || path == "/api/camera/disconnect-all")) return {200, disconnect_json("{}")};
    if (method == "GET" && path == "/api/camera/status") return {200, status_json(query)};
    if (method == "GET" && path == "/api/camera/statuses") return {200, statuses_json()};
    if (method == "GET" && path == "/api/param") return {200, get_param_json(query)};
    if (method == "POST" && path == "/api/param") return {200, set_param_json(body)};
    if (method == "POST" && (path == "/api/param/save-device" || path == "/api/param/save-to-device")) return {200, param_save_device_json(body)};
    if (method == "POST" && path == "/api/param/save-file") return {200, param_save_file_json(body)};
    if (method == "POST" && path == "/api/param/load-file") return {200, param_load_file_json(body)};
    if (method == "POST" && path == "/api/param/recovery") return {200, param_recovery_json(body)};
    if (method == "POST" && path == "/api/capture/preset/line-continuous") return {200, capture_line_continuous_preset_json(body)};
    if (method == "GET" && path == "/api/capture/continuous-settings") return {200, continuous_settings_json()};
    if (method == "POST" && path == "/api/capture/continuous-settings") return {200, continuous_settings_json(body)};
    if (method == "POST" && (path == "/api/preview/capture" || path == "/api/capture/preview")) return {200, preview_capture_json(body)};
    if (method == "POST" && path == "/api/capture/depth-map") return {200, capture_depth_json(body)};
    if (method == "POST" && path == "/api/capture/continuous-test") return {200, continuous_capture_test_json(body)};
    if (method == "GET" && path == "/api/capture/file") return capture_file_response(query);
    if (method == "GET" && path == "/api/capture/latest") return capture_latest_response(query);
    if (method == "GET" && path == "/api/steel/status") return {200, steel_status_json()};
    if (method == "POST" && path == "/api/steel/capture-mode") return {200, steel_capture_mode_json(body)};
    if (method == "POST" && path == "/api/steel/event") return {200, steel_event_json(body)};
    if (method == "POST" && path == "/api/stream/start") return {200, stream_start_json(body)};
    if (method == "POST" && path == "/api/stream/stop") return {200, stream_stop_json(body)};
    if (method == "GET" && path == "/api/stream/status") return {200, stream_status_json(query)};
    if (method == "GET" && path == "/api/stream/latest") return stream_latest_response(query);
    if (method == "POST" && path == "/api/calibration/load") return {200, calibration_load_json(body)};
    if (method == "POST" && path == "/api/calibration/apply-all") return {200, calibration_apply_all_json(body)};
    if (method == "POST" && path == "/api/calibration/rollback") return {200, calibration_rollback_json(body)};
    if (method == "GET" && path == "/api/calibration/active") return {200, calibration_active_json(query)};
    if (method == "POST" && path == "/api/calibration/active") return {200, calibration_active_save_json(body)};
    if (method == "POST" && path == "/api/roi/load") return {200, roi_load_json(body)};
    if (method == "GET" && path == "/api/calibration/status") return {200, calibration_status_json(query)};
    return {404, json_error(404, "not found")};
  }

  bool shutdown() {
    shutting_down_.store(true, std::memory_order_release);
    production_capture_stop_.store(true, std::memory_order_release);
    production_capture_generation_.fetch_add(1, std::memory_order_acq_rel);

    if (g_process_exit_required.load(std::memory_order_acquire)) {
      std::cerr << "Capture shutdown requires immediate process exit; skipping device/SDK teardown.\n";
      return false;
    }

    const auto drain_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
    int active_batches = 0;
    for (;;) {
      {
        std::lock_guard<std::mutex> lock(mutex_);
        active_batches = active_capture_batches_;
      }
      bool production_running = false;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        production_running = production_capture_running_;
      }
      if (active_batches == 0 && !production_running &&
          g_inflight_routes.load(std::memory_order_acquire) == 0 &&
          g_socket_clients.load(std::memory_order_acquire) == 0) {
        break;
      }
      if (std::chrono::steady_clock::now() >= drain_deadline) {
        std::cerr << "Capture shutdown timed out with " << active_batches
                  << " capture batch(es), production running=" << production_running << ", "
                  << g_inflight_routes.load(std::memory_order_acquire)
                  << " route(s), and "
                  << g_socket_clients.load(std::memory_order_acquire)
                  << " socket client(s) still active; skipping device/SDK teardown.\n";
        return false;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(25));
    }

    if (!owned_capture_workers_.wait_until(drain_deadline)) {
      const steel_capture::OwnedWorkerStats workers = owned_capture_workers_.stats();
      std::cerr << "Capture shutdown timed out with " << workers.running
                << " owned capture worker(s), including " << workers.sdk_running
                << " SDK worker(s), still running; skipping device/SDK teardown.\n";
      return false;
    }

    storage_pool_.stop_accepting();
    if (!storage_pool_.drain_until(drain_deadline)) {
      const steel_capture::StorageQueueStats stats = storage_pool_.stats();
      std::cerr << "Capture shutdown timed out with " << stats.pending_items
                << " storage task(s) and " << stats.pending_bytes
                << " pending byte(s); skipping device/SDK teardown.\n";
      return false;
    }

    std::vector<std::shared_ptr<std::timed_mutex>> capture_barriers;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      capture_barriers.reserve(sessions_.size());
      for (const auto& item : sessions_) {
        if (item.second.capture_mutex) {
          capture_barriers.push_back(item.second.capture_mutex);
        }
      }
    }

    std::vector<std::unique_lock<std::timed_mutex>> held_barriers;
    held_barriers.reserve(capture_barriers.size());
    const auto worker_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    for (const auto& barrier : capture_barriers) {
      std::unique_lock<std::timed_mutex> lock(*barrier, std::defer_lock);
      if (!lock.try_lock_until(worker_deadline)) {
        std::cerr << "Capture SDK teardown skipped because an SDK camera worker did not drain.\n";
        return false;
      }
      held_barriers.push_back(std::move(lock));
    }

    std::lock_guard<std::mutex> lock(mutex_);
    clear_sessions_locked();
    bool sdk_deinitialized = true;
    if (sdk_ready_ && sdk_initialized_here_) {
      const int ret = lvm_deinit_sdk();
      if (ret != CORRECT) {
        std::cerr << "lvm_deinit_sdk failed with code " << ret << ".\n";
        sdk_deinitialized = false;
      } else {
        std::cout << "Capture SDK deinitialized.\n";
      }
    } else if (sdk_ready_) {
      std::cerr << "Capture SDK deinit skipped because this runtime received SDK_REPEATED_INIT.\n";
    }
    sdk_ready_ = false;
    sdk_initialized_here_ = false;
    return sdk_deinitialized;
  }

 private:
  struct ProductionCaptureSettings {
    int lines = 1280;
    int width = 0;
    int timeout_ms = 8000;
    int data_mode = 3;
    int retries = 0;
    int control_mode = 0;
    int interval_ms = 0;
    bool discard_black_frames = true;
    bool save_sdk_derived = false;
    double black_frame_threshold = 8.0;
  };

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
    unsigned long long last_frame_tick_ms = 0;
    std::deque<unsigned long long> frame_ticks;
    lvm_buf_t* buffer = nullptr;
    std::chrono::steady_clock::time_point last_saved = std::chrono::steady_clock::time_point::min();
  };

  struct CalibrationState {
    std::string calibration_path;
    std::string calibration_artifact_kind;
    int calibration_code = 0;
    std::string calibration_time;
    std::string operation_id;
    std::string rollback_token;
    std::string rollback_mode;
    int rollback_code = 0;
    std::string rollback_time;
    std::string roi_path;
    int roi_code = 0;
    std::string roi_time;
    std::string validation_path;
    int validation_code = 0;
    std::string validation_time;
  };

  struct CalibrationApplyTarget {
    std::string operation_id;
    std::string ip;
    std::filesystem::path calibration_path;
    std::filesystem::path rollback_path;
    std::string expected_sn;
    std::string artifact_kind;
    int preflight_code = CORRECT;
    int apply_code = CORRECT;
    int persist_code = CORRECT;
    int rollback_record_code = CORRECT;
    int rollback_code = CORRECT;
    std::string rollback_mode = "none";
    std::string message;
    bool simulated = false;
    bool runtime_snapshot_available = false;
    bool file_rollback_available = false;
    bool rollback_fingerprint_available = false;
    std::string rollback_file_hash;
    std::uintmax_t rollback_file_size = 0;
    bool attempted = false;
    bool applied = false;
    bool rolled_back = false;
    bool skipped = false;
  };

  struct CalibrationCameraSnapshot {
    std::string ip;
    std::string expected_sn;
    CalibrationState previous_state;
    std::filesystem::path source_rollback_path;
    std::filesystem::path rollback_path;
    std::filesystem::path applied_path;
    std::string rollback_file_hash;
    std::uintmax_t rollback_file_size = 0;
    bool has_rollback_fingerprint = false;
    lvm_calib_param_t runtime_param{};
    bool has_runtime_param = false;
    bool simulated = false;
    bool attempted = false;
    bool save_to_device = false;
  };

  struct CalibrationRollbackRecord {
    std::string token;
    std::string operation_id;
    std::string created_at;
    std::string phase = "prepared";
    std::string profile_name;
    std::filesystem::path profile_path;
    std::filesystem::path record_dir;
    std::filesystem::path manifest_path;
    std::string profile_before;
    std::vector<CalibrationCameraSnapshot> cameras;
    bool profile_changed = false;
    bool consumed = false;
    bool save_to_device = false;
    bool durable = false;
  };

  struct CalibrationArtifactResolution {
    std::filesystem::path path;
    steel_capture::CalibrationArtifactKind kind =
        steel_capture::CalibrationArtifactKind::Missing;
    int code = CORRECT;
    std::string message;
  };

  // Production acquisition has a different lifetime from the asynchronous
  // preview stream.  Keep its telemetry on the camera session so a stopped
  // preview cannot erase the cadence observed by the continuous worker.
  struct ContinuousCaptureState {
    unsigned long long finalized_count = 0;
    unsigned long long frame_count = 0;
    unsigned long long successful_frame_count = 0;
    int last_result_code = 0;
    unsigned long long last_frame_tick_ms = 0;
    std::string last_frame_at;
    std::deque<unsigned long long> frame_ticks;
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
    int simulated_capture_sequence = 0;
    std::map<std::string, std::string> params;
    StreamState stream;
    ContinuousCaptureState continuous;
    CalibrationState calibration;
    std::shared_ptr<std::timed_mutex> capture_mutex = std::make_shared<std::timed_mutex>();
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
    std::string inspection_id;
    std::string acquisition_mode = "software-trigger-continuous";
    // This is deliberately independent of acquisition_mode. The latter
    // describes where the steel-in/out signal came from, while capture_mode
    // controls whether the provider keeps requesting camera frames.
    std::string capture_mode = "continuous";
    std::string capture_save_state = "discard";
    std::string algorithm_phase = "pending";
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
    int discard_frame_count = 0;
    int black_frame_count = 0;
    int next_capture_sequence = 1;
    bool save_enabled = false;
    bool discard_black_frames = true;
    double black_frame_threshold = 8.0;
  };

  CaptureRuntime()
      : storage_root_(default_storage_root_path()),
        config_root_(default_config_root_path()),
        storage_enqueue_timeout_ms_(storage_enqueue_timeout_ms_setting()),
        storage_pending_ticket_limit_(storage_pending_tickets_setting()),
        simulated_storage_delay_ms_(simulated_storage_delay_ms_setting()),
        simulated_calibration_fail_ip_(simulated_calibration_fail_ip_setting()),
        storage_pool_(storage_worker_count_setting(),
                      storage_queue_items_setting(),
                      storage_queue_bytes_setting()) {
    for (const auto& item : default_camera_storage_roots()) {
      camera_storage_roots_[item.first] = path_from_json_text(item.second).lexically_normal();
    }
  }
  ~CaptureRuntime() {
    if (!shutting_down_.load(std::memory_order_acquire)) {
      std::cerr << "Capture runtime reached process teardown while its API thread was still active; "
                   "terminating without static destruction.\n";
      std::cout.flush();
      std::cerr.flush();
      std::_Exit(4);
    }
  }
  CaptureRuntime(const CaptureRuntime&) = delete;
  CaptureRuntime& operator=(const CaptureRuntime&) = delete;

  bool sdk_capture_restart_required() const noexcept {
    return sdk_capture_poisoned_.load(std::memory_order_acquire);
  }

  void poison_sdk_capture(const std::string& reason) noexcept {
    const bool was_poisoned = sdk_capture_poisoned_.exchange(
        true, std::memory_order_acq_rel);
    production_capture_stop_.store(true, std::memory_order_release);
    production_capture_generation_.fetch_add(1, std::memory_order_acq_rel);
    if (was_poisoned) {
      return;
    }
    try {
      std::lock_guard<std::mutex> lock(sdk_capture_state_mutex_);
      sdk_capture_poisoned_at_ = now_iso();
      sdk_capture_poison_reason_ = reason;
    } catch (...) {
      // Poisoning must remain noexcept: a timeout path may still own other
      // joinable worker handles that must be transferred or joined.
    }
  }

  std::string sdk_capture_state_json() const {
    const steel_capture::OwnedWorkerStats workers = owned_capture_workers_.stats();
    std::string poisoned_at;
    std::string poison_reason;
    {
      std::lock_guard<std::mutex> lock(sdk_capture_state_mutex_);
      poisoned_at = sdk_capture_poisoned_at_;
      poison_reason = sdk_capture_poison_reason_;
    }
    const bool poisoned = sdk_capture_restart_required();
    std::ostringstream json;
    json << "{"
         << "\"poisoned\":" << (poisoned ? "true" : "false") << ","
         << "\"restartRequired\":" << (poisoned ? "true" : "false") << ","
         << "\"code\":" << (poisoned ? SDK_CAPTURE_RESTART_REQUIRED : CORRECT) << ","
         << json_pair("poisonedAt", poisoned_at) << ","
         << json_pair("reason", poison_reason) << ","
         << "\"ownedWorkers\":{"
         << "\"capacity\":" << workers.capacity << ","
         << "\"owned\":" << workers.owned << ","
         << "\"running\":" << workers.running << ","
         << "\"sdkRunning\":" << workers.sdk_running << ","
         << "\"completedNotJoined\":" << workers.completed_not_joined << ","
         << "\"adopted\":" << workers.adopted << ","
         << "\"reaped\":" << workers.reaped
         << "}}";
    return json.str();
  }

  std::string sdk_capture_restart_error_json() const {
    std::ostringstream json;
    json << "{\"code\":" << SDK_CAPTURE_RESTART_REQUIRED << ","
         << json_pair("errorName", capture_error_name(SDK_CAPTURE_RESTART_REQUIRED)) << ","
         << json_pair("operatorHint", capture_error_hint(SDK_CAPTURE_RESTART_REQUIRED)) << ","
         << json_pair("error", "capture provider restart required after SDK worker timeout") << ","
         << "\"sdkCaptureState\":" << sdk_capture_state_json()
         << "}";
    return json.str();
  }

  [[noreturn]] void worker_ownership_exhausted() const noexcept {
    g_process_exit_required.store(true, std::memory_order_release);
    std::cerr << "Capture worker ownership registry is exhausted; terminating immediately without SDK teardown.\n";
    std::cout.flush();
    std::cerr.flush();
    std::_Exit(4);
  }

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
    // The LVM online saver appends `_depthMap` to the supplied PNG stem.
    // Publish that real output path; keeping `depth_path` here causes the
    // stream endpoint to return 404 even though frames are being acquired.
    std::string sdk_depth_path = sibling_output_path(depth_path, "_depthMap", ".png");
    int ret = lvm_save_depth_map(dev, depth_path.c_str(), depth_map);
    if (ret == CORRECT) {
      session->stream.latest_depth_path = sdk_depth_path;
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
    record_stream_frame_tick_locked(session->stream);
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
    if (ret == CORRECT) {
      sdk_initialized_here_ = true;
    }
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
    if (is_path_under_base(path, storage_root_)) {
      return true;
    }
    for (const auto& item : camera_storage_roots_) {
      if (is_path_under_base(path, item.second)) {
        return true;
      }
    }
    return false;
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
    bool save_sdk_derived = false;
  };

  CaptureOutputPaths capture_output_paths_for(const std::string& output_path, bool save_sdk_derived = false) const {
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
    paths.save_sdk_derived = save_sdk_derived;
    const std::filesystem::path sdk_dir = save_sdk_derived ? (base_dir / "sdk-derived") : (base_dir / ".sdk-scratch");
    std::filesystem::path sdk_base = sdk_dir / (stem + ".png");
    if (!save_sdk_derived) {
      sdk_base = temp_output_path_for(sdk_base);
    }
    paths.sdk_base_path = sdk_base.lexically_normal().string();
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
    error.clear();
    std::filesystem::remove(paths.metadata_path, error);
    error.clear();
    std::filesystem::create_directories(std::filesystem::path(paths.sdk_base_path).parent_path(), error);
    return !error;
  }

  void cleanup_sdk_outputs(const CaptureOutputPaths& paths) const {
    if (paths.save_sdk_derived) {
      return;
    }
    std::error_code error;
    std::filesystem::remove(paths.sdk_base_path, error);
    error.clear();
    std::filesystem::remove(paths.sdk_depth_path, error);
    error.clear();
    std::filesystem::remove(paths.sdk_intensity_path, error);
    error.clear();
    std::filesystem::remove(std::filesystem::path(paths.sdk_base_path).parent_path(), error);
  }

  struct OwnedImageSource {
    enum class Kind {
      None,
      ExistingFile,
      Pixels16,
      DepthMap16,
    };

    Kind kind = Kind::None;
    std::string primary_file;
    std::string fallback_file;
    std::shared_ptr<std::vector<std::uint16_t>> pixels;
    lvm_frame_head_t depth_head{};
    int depth_x_offset = 0;
    unsigned long long depth_y_offset = 0;
    lvm_depth_map_param_t depth_param{};
    int width = 0;
    int height = 0;
    std::size_t accounted_bytes = 0;

    bool available() const {
      if (kind == Kind::ExistingFile) {
        return !primary_file.empty() || !fallback_file.empty();
      }
      if (kind == Kind::Pixels16) {
        return pixels && !pixels->empty() && width > 0 && height > 0;
      }
      if (kind == Kind::DepthMap16) {
        return pixels && !pixels->empty() && width > 0 && height > 0 &&
               depth_param.data_format == 0;
      }
      return false;
    }
  };

  struct FrameMetadataSnapshot {
    std::string captured_at;
    std::string ip;
    std::string model;
    std::string sn;
    std::string capture_config_json = "{}";
    int capture_code = CORRECT;
    int attempt_count = 0;
    int requested_width = 0;
    int requested_lines = 0;
    int actual_width = 0;
    int actual_lines = 0;
    int data_mode = 1;
    int timeout_ms = 0;
    int depth_data_format = -1;
    std::string depth_persistence_mode;
    int fid = -1;
    int sid = -1;
    int lost_lines = 0;
    unsigned int trigger_min_interval = 0;
    unsigned int trigger_max_interval = 0;
    unsigned int timestamp = 0;
    bool simulated = false;
    bool discarded = false;
    std::string discard_reason;
  };

  struct FrameWriteResult {
    unsigned long long ticket_id = 0;
    int code = DEV_LOAD_DATA_ERROR;
    int capture_code = DEV_LOAD_DATA_ERROR;
    int depth_code = DEV_LOAD_DATA_ERROR;
    int intensity_code = DEV_LOAD_DATA_ERROR;
    int metadata_code = DEV_LOAD_DATA_ERROR;
    std::string depth_path;
    std::string intensity_path;
    std::string metadata_path;
    std::string queued_at;
    std::string storage_started_at;
    std::string storage_finished_at;
    std::string depth_persistence_mode;
    int depth_data_format = -1;
    unsigned long long queued_tick_ms = 0;
    unsigned long long storage_started_tick_ms = 0;
    unsigned long long storage_finished_tick_ms = 0;
    bool depth_exists = false;
    bool intensity_exists = false;
    bool metadata_exists = false;
    bool complete_frame = false;
  };

  struct FrameWriteRequest {
    CaptureOutputPaths paths;
    OwnedImageSource depth;
    OwnedImageSource intensity;
    FrameMetadataSnapshot metadata;
    std::size_t pending_bytes = 0;
  };

  struct StorageTicket {
    unsigned long long id = 0;
    std::shared_ptr<FrameWriteResult> result;
    std::future<int> completion;

    bool valid() const {
      return result && completion.valid();
    }

    bool ready() const {
      return !completion.valid() ||
             completion.wait_for(std::chrono::milliseconds::zero()) == std::future_status::ready;
    }
  };

  FrameMetadataSnapshot capture_metadata_snapshot_locked(
      const CameraSession& session,
      int capture_code,
      int attempt_count,
      int requested_width,
      int requested_lines,
      int actual_width,
      int actual_lines,
      int data_mode,
      int timeout_ms,
      int fid,
      int sid,
      int lost_lines,
      unsigned int trigger_min_interval,
      unsigned int trigger_max_interval,
      unsigned int timestamp,
      bool simulated,
      bool discarded = false,
      const std::string& discard_reason = "") const {
    FrameMetadataSnapshot snapshot;
    snapshot.captured_at = now_iso();
    snapshot.ip = session.ip;
    snapshot.model = session.model;
    snapshot.sn = session.sn;
    if (session.device && session.device->dev_info) {
      if (snapshot.model.empty()) {
        snapshot.model = session.device->dev_info->device_name;
      }
      if (snapshot.sn.empty()) {
        snapshot.sn = session.device->dev_info->sn;
      }
    }
    snapshot.capture_config_json = capture_config_json_for_session(&session);
    snapshot.capture_code = capture_code;
    snapshot.attempt_count = attempt_count;
    snapshot.requested_width = requested_width;
    snapshot.requested_lines = requested_lines;
    snapshot.actual_width = actual_width;
    snapshot.actual_lines = actual_lines;
    snapshot.data_mode = data_mode;
    snapshot.timeout_ms = timeout_ms;
    snapshot.fid = fid;
    snapshot.sid = sid;
    snapshot.lost_lines = lost_lines;
    snapshot.trigger_min_interval = trigger_min_interval;
    snapshot.trigger_max_interval = trigger_max_interval;
    snapshot.timestamp = timestamp;
    snapshot.simulated = simulated;
    snapshot.discarded = discarded;
    snapshot.discard_reason = discard_reason;
    return snapshot;
  }

  bool clone_owned_depth_map16(const lvm_depth_map_t* depth_map,
                               OwnedImageSource& destination) const {
    destination = OwnedImageSource{};
    if (!depth_map || !depth_map->param || !depth_map->data ||
        depth_map->param->data_format != 0 || depth_map->head.width == 0 ||
        depth_map->head.height == 0 ||
        depth_map->head.width > static_cast<unsigned int>(std::numeric_limits<int>::max()) ||
        depth_map->head.height > static_cast<unsigned int>(std::numeric_limits<int>::max())) {
      return false;
    }
    const int width = static_cast<int>(depth_map->head.width);
    const int height = static_cast<int>(depth_map->head.height);
    const std::size_t bytes = estimated_frame_bytes(width, height, sizeof(std::uint16_t));
    if (bytes == 0 || bytes == std::numeric_limits<std::size_t>::max()) {
      return false;
    }
    try {
      auto pixels = std::make_shared<std::vector<std::uint16_t>>(bytes / sizeof(std::uint16_t));
      std::memcpy(pixels->data(), depth_map->data, bytes);
      destination.kind = OwnedImageSource::Kind::DepthMap16;
      destination.pixels = std::move(pixels);
      destination.depth_head = depth_map->head;
      destination.depth_x_offset = depth_map->x_offset;
      destination.depth_y_offset = depth_map->y_offset;
      destination.depth_param = *depth_map->param;
      destination.width = width;
      destination.height = height;
      destination.accounted_bytes = bytes;
      return true;
    } catch (...) {
      destination = OwnedImageSource{};
      return false;
    }
  }

  bool clone_owned_image16(const lvm_image_t* image,
                           OwnedImageSource& destination) const {
    destination = OwnedImageSource{};
    if (!image || !image->data || image->head.width == 0 ||
        image->head.height == 0 ||
        image->head.width > static_cast<unsigned int>(std::numeric_limits<int>::max()) ||
        image->head.height > static_cast<unsigned int>(std::numeric_limits<int>::max())) {
      return false;
    }
    const int width = static_cast<int>(image->head.width);
    const int height = static_cast<int>(image->head.height);
    const std::size_t bytes = estimated_frame_bytes(width, height, sizeof(std::uint16_t));
    if (bytes == 0 || bytes == std::numeric_limits<std::size_t>::max()) {
      return false;
    }
    try {
      auto pixels = std::make_shared<std::vector<std::uint16_t>>(bytes / sizeof(std::uint16_t));
      std::memcpy(pixels->data(), image->data, bytes);
      destination.kind = OwnedImageSource::Kind::Pixels16;
      destination.pixels = std::move(pixels);
      destination.width = width;
      destination.height = height;
      destination.accounted_bytes = bytes;
      return true;
    } catch (...) {
      destination = OwnedImageSource{};
      return false;
    }
  }

  int write_owned_depth_map16(const OwnedImageSource& source,
                              const std::string& target) {
    if (!source.available() || source.kind != OwnedImageSource::Kind::DepthMap16 ||
        source.depth_param.data_format != 0 || target.empty()) {
      return CAPTURE_DEPTH_FORMAT_UNSUPPORTED;
    }
    const std::filesystem::path target_path(target);
    std::error_code error;
    std::filesystem::create_directories(target_path.parent_path(), error);
    if (error) {
      return 500;
    }

    // The vendor offline API appends `_depthMap` to the supplied PNG stem.
    // Give every transaction its own base path, then atomically publish the
    // generated file to the stable frame path.
    const std::filesystem::path offline_base = temp_output_path_for(target_path);
    const std::filesystem::path offline_output = sibling_output_path(
        offline_base.string(), "_depthMap", ".png");
    std::filesystem::remove(offline_base, error);
    error.clear();
    std::filesystem::remove(offline_output, error);

    lvm_depth_map_param_t param = source.depth_param;
    lvm_depth_map_t view{};
    view.head = source.depth_head;
    view.x_offset = source.depth_x_offset;
    view.y_offset = source.depth_y_offset;
    view.param = &param;
    view.data = source.pixels->data();
    view.intensity_img = nullptr;

    int ret = DEV_LOAD_DATA_ERROR;
    {
      // The SDK does not document concurrent safety for its offline encoder.
      // Serialize only this call; the rest of each frame transaction remains
      // parallel across storage workers.
      std::lock_guard<std::mutex> encode_lock(offline_depth_save_mutex_);
      ret = lvm_offline_save_depthMap(offline_base.string().c_str(), &view);
    }
    if (ret != CORRECT) {
      std::filesystem::remove(offline_base, error);
      error.clear();
      std::filesystem::remove(offline_output, error);
      return ret;
    }

    std::filesystem::path completed;
    if (wait_for_file_exists(offline_output.string())) {
      completed = offline_output;
    } else if (wait_for_file_exists(offline_base.string())) {
      // Keep compatibility with SDK builds that honor the requested filename.
      completed = offline_base;
    } else {
      return 500;
    }
    const bool published = replace_with_completed_file(completed, target_path);
    error.clear();
    std::filesystem::remove(offline_base, error);
    error.clear();
    std::filesystem::remove(offline_output, error);
    return published ? CORRECT : 500;
  }

  int write_owned_image(const OwnedImageSource& source, const std::string& target) {
    if (!source.available() || target.empty()) {
      return CAPTURE_INTENSITY_MISSING;
    }
    if (source.kind == OwnedImageSource::Kind::DepthMap16) {
      return write_owned_depth_map16(source, target);
    }
    if (source.kind == OwnedImageSource::Kind::ExistingFile) {
      if (!source.primary_file.empty() &&
          wait_for_file_exists(source.primary_file) &&
          copy_file_replace(source.primary_file, target)) {
        return CORRECT;
      }
      if (!source.fallback_file.empty() &&
          wait_for_file_exists(source.fallback_file) &&
          copy_file_replace(source.fallback_file, target)) {
        return CORRECT;
      }
      return 500;
    }

    const std::filesystem::path target_path(target);
    std::error_code error;
    std::filesystem::create_directories(target_path.parent_path(), error);
    if (error) {
      return 500;
    }
    const std::filesystem::path temp_path = temp_output_path_for(target_path);
    const int ret = lvm_save_img(temp_path.string().c_str(),
                                 source.pixels->data(),
                                 source.width,
                                 source.height,
                                 LVM_IMAGE_FORMAT_16BIT_USHORT);
    if (ret != CORRECT) {
      std::filesystem::remove(temp_path, error);
      return ret;
    }
    return replace_with_completed_file(temp_path, target_path) ? CORRECT : 500;
  }

  std::string frame_metadata_json(const FrameWriteRequest& request,
                                  const FrameWriteResult& result) const {
    const FrameMetadataSnapshot& frame = request.metadata;
    std::ostringstream json;
    json << "{"
         << "\"schema\":\"steel.capture.frame.v2\","
         << json_pair("capturedAt", frame.captured_at) << ","
         << json_pair("storageQueuedAt", result.queued_at) << ","
         << json_pair("storageStartedAt", result.storage_started_at) << ","
         << json_pair("storageFinishedAt", now_iso()) << ","
         << "\"ticketId\":" << result.ticket_id << ","
         << "\"captureCode\":" << frame.capture_code << ","
         << "\"code\":" << CORRECT << ","
         << json_pair("errorName", capture_error_name(CORRECT)) << ","
         << json_pair("operatorHint", capture_error_hint(CORRECT)) << ","
         << json_pair("ip", frame.ip) << ","
         << json_pair("model", frame.model) << ","
         << json_pair("sn", frame.sn) << ","
         << "\"attempts\":" << frame.attempt_count << ","
         << "\"simulated\":" << (frame.simulated ? "true" : "false") << ","
         << "\"requestedWidth\":" << frame.requested_width << ","
         << "\"requestedLines\":" << frame.requested_lines << ","
         << "\"width\":" << frame.actual_width << ","
         << "\"lines\":" << frame.actual_lines << ","
         << "\"dataMode\":" << frame.data_mode << ","
         << "\"depthDataFormat\":" << frame.depth_data_format << ","
         << json_pair("depthPersistenceMode", frame.depth_persistence_mode) << ","
         << "\"timeoutMs\":" << frame.timeout_ms << ","
         << "\"fid\":" << frame.fid << ","
         << "\"sid\":" << frame.sid << ","
         << "\"lostLines\":" << frame.lost_lines << ","
         << "\"triggerMinInterval\":" << frame.trigger_min_interval << ","
         << "\"triggerMaxInterval\":" << frame.trigger_max_interval << ","
         << "\"timestamp\":" << frame.timestamp << ","
         << "\"discarded\":" << (frame.discarded ? "true" : "false") << ","
         << json_pair("discardReason", frame.discard_reason) << ","
         << json_pair("depthPath", request.paths.depth_path) << ","
         << json_pair("intensityPath", request.paths.intensity_path) << ","
         << "\"depthCode\":" << result.depth_code << ","
         << "\"intensityCode\":" << result.intensity_code << ","
         << "\"completeFrame\":true,"
         << "\"metadataCommit\":\"last\","
         << "\"captureConfig\":" << frame.capture_config_json
         << "}";
    return json.str();
  }

  StorageTicket enqueue_frame_write(FrameWriteRequest request) {
    const CaptureOutputPaths cleanup_paths = request.paths;
    StorageTicket ticket;
    ticket.id = frame_write_ticket_counter_.fetch_add(1, std::memory_order_acq_rel) + 1;
    ticket.result = std::make_shared<FrameWriteResult>();
    ticket.result->ticket_id = ticket.id;
    ticket.result->capture_code = request.metadata.capture_code;
    ticket.result->code = request.metadata.capture_code;
    ticket.result->depth_path = request.paths.depth_path;
    ticket.result->intensity_path = request.paths.intensity_path;
    ticket.result->metadata_path = request.paths.metadata_path;
    ticket.result->depth_data_format = request.metadata.depth_data_format;
    ticket.result->depth_persistence_mode = request.metadata.depth_persistence_mode;
    ticket.result->queued_at = now_iso();
    ticket.result->queued_tick_ms = GetTickCount64();

    std::error_code remove_error;
    std::filesystem::remove(request.paths.metadata_path, remove_error);
    const std::size_t pending_bytes = std::max<std::size_t>(1, saturating_size_add(
        request.pending_bytes,
        saturating_size_add(request.metadata.capture_config_json.size(), 2048)));
    auto result = ticket.result;
    auto submitted = storage_pool_.submit(
        [this, request = std::move(request), result]() mutable {
          result->storage_started_at = now_iso();
          result->storage_started_tick_ms = GetTickCount64();
          if (request.metadata.simulated && simulated_storage_delay_ms_ > 0) {
            std::this_thread::sleep_for(
                std::chrono::milliseconds(simulated_storage_delay_ms_));
          }
          result->depth_code = write_owned_image(request.depth, request.paths.depth_path);
          result->intensity_code = write_owned_image(request.intensity, request.paths.intensity_path);

          if (!request.metadata.simulated && request.paths.save_sdk_derived &&
              result->depth_code == CORRECT &&
              request.depth.kind == OwnedImageSource::Kind::DepthMap16) {
            if (!copy_file_replace(request.paths.depth_path, request.paths.sdk_depth_path)) {
              result->depth_code = 500;
            }
          }
          if (!request.metadata.simulated && request.paths.save_sdk_derived &&
              result->intensity_code == CORRECT &&
              request.intensity.kind == OwnedImageSource::Kind::Pixels16) {
            if (!copy_file_replace(request.paths.intensity_path,
                                   request.paths.sdk_intensity_path)) {
              result->intensity_code = 500;
            }
          }

          int code = request.metadata.capture_code;
          if (code == CORRECT && result->depth_code != CORRECT) {
            code = result->depth_code;
          }
          if (code == CORRECT && result->intensity_code != CORRECT) {
            code = result->intensity_code;
          }
          result->metadata_code = code == CORRECT ? CORRECT : code;
          if (code == CORRECT) {
            const std::string metadata = frame_metadata_json(request, *result);
            result->metadata_code = write_text_file(request.paths.metadata_path, metadata)
                                        ? CORRECT
                                        : 500;
            if (result->metadata_code != CORRECT) {
              code = result->metadata_code;
            }
          }

          result->code = code;
          result->depth_exists = result->depth_code == CORRECT && file_exists(request.paths.depth_path);
          result->intensity_exists = result->intensity_code == CORRECT && file_exists(request.paths.intensity_path);
          result->metadata_exists = result->metadata_code == CORRECT && file_exists(request.paths.metadata_path);
          result->complete_frame = result->code == CORRECT &&
                                   result->depth_exists &&
                                   result->intensity_exists &&
                                   result->metadata_exists;
          result->storage_finished_at = now_iso();
          result->storage_finished_tick_ms = GetTickCount64();
          cleanup_sdk_outputs(request.paths);
          return result->code;
        },
        pending_bytes,
        std::chrono::milliseconds(storage_enqueue_timeout_ms_));
    if (!submitted.accepted()) {
      const int code = storage_submit_error_code(submitted.status);
      ticket.result->code = code;
      ticket.result->depth_code = code;
      ticket.result->intensity_code = code;
      ticket.result->metadata_code = code;
      ticket.result->storage_finished_at = now_iso();
      ticket.result->storage_finished_tick_ms = GetTickCount64();
      cleanup_sdk_outputs(cleanup_paths);
      ticket.completion = ready_int_future(code);
      return ticket;
    }
    ticket.completion = std::move(submitted.future);
    return ticket;
  }

  FrameWriteResult finish_frame_write(StorageTicket& ticket) const {
    if (!ticket.result) {
      FrameWriteResult missing;
      missing.code = 500;
      return missing;
    }
    if (ticket.completion.valid()) {
      const int completion_code = wait_storage_future(ticket.completion);
      if (completion_code != ticket.result->code) {
        ticket.result->code = completion_code;
        ticket.result->complete_frame = false;
      }
    }
    return *ticket.result;
  }

  bool depth_map_is_black_frame(const lvm_depth_map_t* depth_map, double threshold) const {
    if (!depth_map || !depth_map->intensity_img || !depth_map->intensity_img->data) {
      return false;
    }
    const size_t width = static_cast<size_t>(std::max(0, static_cast<int>(depth_map->intensity_img->head.width)));
    const size_t height = static_cast<size_t>(std::max(0, static_cast<int>(depth_map->intensity_img->head.height)));
    const size_t pixels = width * height;
    if (pixels == 0) {
      return false;
    }
    const auto* data = reinterpret_cast<const std::uint16_t*>(depth_map->intensity_img->data);
    const size_t step = std::max<size_t>(1, pixels / 4096);
    double sum = 0.0;
    std::uint16_t max_value = 0;
    size_t samples = 0;
    for (size_t index = 0; index < pixels; index += step) {
      const std::uint16_t value = data[index];
      sum += static_cast<double>(value);
      max_value = std::max(max_value, value);
      ++samples;
    }
    if (samples == 0) {
      return false;
    }
    const double average = sum / static_cast<double>(samples);
    return average <= threshold && static_cast<double>(max_value) <= threshold;
  }

  std::string camera_storage_roots_status_json_locked() const {
    std::ostringstream roots_json;
    roots_json << "[";
    bool first = true;
    for (const auto& item : camera_storage_roots_) {
      std::error_code error;
      bool existed_before = std::filesystem::exists(item.second, error);
      if (!error && !existed_before) {
        std::filesystem::create_directories(item.second, error);
      }
      error.clear();
      bool exists = std::filesystem::exists(item.second, error);
      bool writable = false;
      if (!error && exists) {
        std::filesystem::path probe = item.second / ".steel-capture-write-test.tmp";
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
      error.clear();
      const std::filesystem::space_info capacity = std::filesystem::space(item.second, error);
      const bool capacity_available = !error && capacity.capacity > 0;
      const std::uintmax_t capacity_bytes = capacity_available ? capacity.capacity : 0;
      const std::uintmax_t free_bytes = capacity_available ? capacity.available : 0;
      const double free_percent = capacity_available
          ? (static_cast<double>(free_bytes) * 100.0 / static_cast<double>(capacity_bytes))
          : 0.0;
      if (!first) {
        roots_json << ",";
      }
      first = false;
      roots_json << "{"
                 << json_pair("ip", item.first) << ","
                 << json_pair("root", item.second.string()) << ","
                 << "\"exists\":" << (exists ? "true" : "false") << ","
                 << "\"writable\":" << (writable ? "true" : "false") << ","
                 << "\"capacityAvailable\":" << (capacity_available ? "true" : "false") << ","
                 << "\"capacityBytes\":" << capacity_bytes << ","
                 << "\"freeBytes\":" << free_bytes << ","
                 << "\"freePercent\":" << std::fixed << std::setprecision(3) << free_percent
                 << "}";
    }
    roots_json << "]";
    return roots_json.str();
  }

  std::string storage_queue_status_json() const {
    const steel_capture::StorageQueueStats stats = storage_pool_.stats();
    std::ostringstream json;
    json << "{"
         << "\"workerCount\":" << stats.worker_count << ","
         << "\"capacityItems\":" << stats.capacity_items << ","
         << "\"capacityBytes\":" << stats.capacity_bytes << ","
         << "\"pendingItems\":" << stats.pending_items << ","
         << "\"pendingBytes\":" << stats.pending_bytes << ","
         << "\"queued\":" << stats.queued << ","
         << "\"queuedBytes\":" << stats.queued_bytes << ","
         << "\"active\":" << stats.active << ","
         << "\"activeBytes\":" << stats.active_bytes << ","
         << "\"highWaterItems\":" << stats.high_water_items << ","
         << "\"highWaterBytes\":" << stats.high_water_bytes << ","
         << "\"completed\":" << stats.completed << ","
         << "\"completedBytes\":" << stats.completed_bytes << ","
         << "\"recentCompletedBytes\":" << stats.recent_completed_bytes << ","
         << "\"recentWindowSeconds\":" << stats.recent_window_seconds << ","
         << "\"recentWriteBytesPerSecond\":" << std::fixed << std::setprecision(3)
         << stats.recent_write_bytes_per_second << ","
         << "\"failed\":" << stats.failed << ","
         << "\"rejected\":" << stats.rejected << ","
         << "\"enqueueTimeoutMs\":" << storage_enqueue_timeout_ms_ << ","
         << "\"pendingTicketLimit\":" << storage_pending_ticket_limit_ << ","
         << "\"simulatedStorageDelayMs\":" << simulated_storage_delay_ms_ << ","
         << "\"accepting\":" << (stats.accepting ? "true" : "false")
         << "}";
    return json.str();
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
    error.clear();
    const std::filesystem::space_info capacity = std::filesystem::space(storage_root_, error);
    const bool capacity_available = !error && capacity.capacity > 0;
    const std::uintmax_t capacity_bytes = capacity_available ? capacity.capacity : 0;
    const std::uintmax_t free_bytes = capacity_available ? capacity.available : 0;
    const double free_percent = capacity_available
        ? (static_cast<double>(free_bytes) * 100.0 / static_cast<double>(capacity_bytes))
        : 0.0;
    std::ostringstream json;
    json << "{\"code\":" << code << ","
         << json_pair("root", storage_root_.string()) << ","
         << "\"exists\":" << (exists ? "true" : "false") << ","
         << "\"writable\":" << (writable ? "true" : "false") << ","
         << "\"capacityAvailable\":" << (capacity_available ? "true" : "false") << ","
         << "\"capacityBytes\":" << capacity_bytes << ","
         << "\"freeBytes\":" << free_bytes << ","
         << "\"freePercent\":" << std::fixed << std::setprecision(3) << free_percent << ","
         << "\"cameraRoots\":" << camera_storage_roots_status_json_locked() << ","
         << "\"queue\":" << storage_queue_status_json()
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

  std::filesystem::path camera_storage_root_from_text_locked(const std::string& text) const {
    std::filesystem::path path = path_from_json_text(text).lexically_normal();
    if (path.is_absolute()) {
      return path;
    }
    return (storage_root_ / path).lexically_normal();
  }

  void apply_camera_storage_roots_locked(const std::map<std::string, std::string>& roots, bool replace) {
    if (replace) {
      camera_storage_roots_.clear();
    }
    for (const auto& item : roots) {
      if (!item.first.empty() && !item.second.empty()) {
        camera_storage_roots_[item.first] = camera_storage_root_from_text_locked(item.second);
      }
    }
  }

  std::string storage_camera_roots_config_json(const std::string& body) {
    std::map<std::string, std::string> roots = json_camera_roots_array_field(body, "cameraRoots");
    roots = merge_string_maps(roots, json_camera_roots_array_field(body, "cameraStorageRoots"));
    roots = merge_string_maps(roots, json_camera_roots_array_field(body, "cameraStorageDirs"));
    roots = merge_string_maps(roots, json_profile_camera_roots_field(body));
    const bool reset_defaults = json_bool_field(body, "resetDefault", false) ||
                                json_bool_field(body, "resetClockwiseH", false);
    if (roots.empty() && !reset_defaults) {
      return json_error(400, "missing camera roots");
    }
    const bool replace = json_bool_field(body, "replace", false) || reset_defaults;
    std::lock_guard<std::mutex> lock(mutex_);
    if (reset_defaults) {
      camera_storage_roots_.clear();
      for (const auto& item : default_camera_storage_roots()) {
        camera_storage_roots_[item.first] = camera_storage_root_from_text_locked(item.second);
      }
    }
    if (!roots.empty()) {
      apply_camera_storage_roots_locked(roots, replace && !reset_defaults);
    }
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
    return config_or_storage_path_locked(dir_text);
  }

  std::filesystem::path strip_config_prefix_path(std::filesystem::path path) const {
    auto it = path.begin();
    if (it == path.end()) {
      return path;
    }
    std::string first = it->string();
    std::transform(first.begin(), first.end(), first.begin(), [](unsigned char ch) {
      return static_cast<char>(std::tolower(ch));
    });
    if (first != "config") {
      return path;
    }
    std::filesystem::path stripped;
    ++it;
    for (; it != path.end(); ++it) {
      stripped /= *it;
    }
    return stripped;
  }

  std::filesystem::path config_or_storage_path_locked(const std::string& text) const {
    std::filesystem::path path = path_from_json_text(text);
    if (path.is_absolute()) {
      return path.lexically_normal();
    }

    std::filesystem::path config_path = (config_root_ / path).lexically_normal();
    std::filesystem::path config_stripped_path = (config_root_ / strip_config_prefix_path(path)).lexically_normal();
    std::filesystem::path storage_path = (storage_root_ / path).lexically_normal();

    std::error_code exists_error;
    if (std::filesystem::exists(config_path, exists_error)) {
      return config_path;
    }
    exists_error.clear();
    if (std::filesystem::exists(config_stripped_path, exists_error)) {
      return config_stripped_path;
    }
    exists_error.clear();
    if (std::filesystem::exists(storage_path, exists_error)) {
      return storage_path;
    }
    return config_stripped_path;
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
    std::map<std::string, std::filesystem::path> default_roots;
    for (const auto& item : default_camera_storage_roots()) {
      default_roots[item.first] = camera_storage_root_from_text_locked(item.second);
    }
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
      auto root_it = default_roots.find(ips[i]);
      cameras << "{"
              << json_pair("ip", ips[i]) << ","
              << json_pair("model", i < models.size() ? models[i] : "") << ","
              << json_pair("sn", i < sns.size() ? sns[i] : "") << ","
              << "\"enabled\":true,"
              << json_pair("paramFile", "config/camera-params/" + profile_name + "/" + safe_ip + ".nccfg") << ","
              << "\"cameraIndex\":" << (i + 1) << ","
              << json_pair("storageRoot", root_it == default_roots.end() ? "" : root_it->second.string())
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
         << "\"cameraStorageRoots\":" << camera_storage_roots_array_json(default_roots) << ","
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
         << "\"cameraRoots\":" << camera_storage_roots_array_json(camera_storage_roots_) << ","
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
    std::map<std::string, std::string> camera_roots = json_profile_camera_roots_field(profile);
    if (!camera_roots.empty()) {
      apply_camera_storage_roots_locked(camera_roots, false);
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

  void auto_connect_active_profile_locked() {
    const std::string active = active_profile_name_locked();
    std::string profile;
    if (!read_file(existing_profile_path_locked(active).string(), profile) ||
        !json_bool_field(profile, "autoConnect", false)) {
      return;
    }

    const int dev_type = json_int_field(profile, "devType", -1);
    int discover_ret = CORRECT;
    const std::vector<std::string> ips = discovered_ips_locked(discover_ret);
    int connected = 0;
    int failed = 0;
    int first_error = discover_ret;
    if (discover_ret == CORRECT) {
      for (const std::string& ip : ips) {
        bool already_connected = false;
        const int ret = connect_one_locked(ip, dev_type, &already_connected);
        if (ret == CORRECT) {
          ++connected;
        } else {
          ++failed;
          if (first_error == CORRECT) {
            first_error = ret;
          }
        }
      }
    }

    const bool expected_met = connected == expected_cameras_ &&
                              static_cast<int>(ips.size()) == expected_cameras_ &&
                              failed == 0;
    if (expected_met && continuous_capture_enabled_locked() &&
        calibration_rollback_manifest_set_valid_ &&
        pending_calibration_recovery_count_locked() == 0 &&
        (driver_mode_ == DriverMode::Simulated ||
         !sdk_capture_restart_required())) {
      start_production_capture_worker_locked("{}");
    }
    capture_logs_.push_front(
        {now_iso(),
         expected_met ? "info" : "error",
         "",
         "Active profile startup auto-connect " +
             std::string(expected_met ? "completed" : "failed") +
             ": profile=" + active +
             ", discovered=" + std::to_string(ips.size()) +
             ", connected=" + std::to_string(connected) +
             ", failed=" + std::to_string(failed) +
             ", expected=" + std::to_string(expected_cameras_) +
             ", code=" + std::to_string(first_error)});
    constexpr std::size_t kCaptureLogLimit = 200;
    while (capture_logs_.size() > kCaptureLogLimit) {
      capture_logs_.pop_back();
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
              << json_pair("errorName", capture_error_name(code)) << ","
              << json_pair("operatorHint", capture_error_hint(code)) << ","
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
         << json_pair("errorName", capture_error_name(code)) << ","
         << json_pair("operatorHint", capture_error_hint(code)) << ","
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
        file = config_or_storage_path_locked(file_it->second);
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
              << json_pair("errorName", capture_error_name(code)) << ","
              << json_pair("operatorHint", capture_error_hint(code)) << ","
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
         << json_pair("errorName", capture_error_name(code)) << ","
         << json_pair("operatorHint", capture_error_hint(code)) << ","
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
    bool apply_camera_params = json_bool_field(body, "applyCameraParams", json_bool_field(profile, "applyCameraParams", false));
    int expected_cameras = json_int_field(body, "expectedCameras", json_int_field(profile, "expectedCameras", expected_cameras_));
    int dev_type = json_int_field(body, "devType", json_int_field(profile, "devType", -1));
    std::vector<std::string> load_ips = json_string_array_field(body, "ips");
    std::map<std::string, std::string> camera_files = json_camera_files_field(body);
    if (camera_files.empty()) {
      camera_files = json_profile_camera_files_field(profile);
    }

    std::unique_lock<std::mutex> lock(mutex_);
    if (active_capture_batches_ > 0) {
      return json_error(409, "capture batch is running");
    }
    if (production_capture_running_) {
      request_stop_production_capture_worker_locked();
      if (!production_capture_cv_.wait_for(
              lock,
              std::chrono::seconds(15),
              [this]() { return !production_capture_running_; })) {
        return json_error(409, "continuous acquisition did not stop before profile apply");
      }
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
    if (apply_camera_params) {
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
    if (auto_connect && connected > 0 && code == CORRECT &&
        continuous_capture_enabled_locked()) {
      start_production_capture_worker_locked("{}");
    }
    std::ostringstream json;
    json << "{\"code\":" << code << ","
         << json_pair("name", name) << ","
         << "\"active\":true,"
         << "\"autoConnect\":" << (auto_connect ? "true" : "false") << ","
         << "\"applyCameraParams\":" << (apply_camera_params ? "true" : "false") << ","
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
    const bool restart_required = sdk_capture_restart_required();
    int sdk_ret = restart_required ? SDK_CAPTURE_RESTART_REQUIRED : ensure_sdk();
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
      bind_persisted_calibration_generation_locked(sessions_[session.ip]);
      return CORRECT;
    }

    char ip_buffer[DEVICE_NET_INFO_LEN]{};
    strncpy_s(ip_buffer, ip.c_str(), _TRUNCATE);
    lvm_dev_t* device = lvm_create_dev(ip_buffer, dev_type);
    int ret = device ? lvm_connect_dev(device) : DEV_INIT_FAILED;
    if (ret == CORRECT) {
      CameraSession session{};
      session.device = device;
      session.ip = ip;
      session.dev_type = dev_type;
      sessions_[ip] = session;
      sessions_[ip].device->context = &sessions_[ip];
      bind_persisted_calibration_generation_locked(sessions_[ip]);
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
        float max_frame_rate = lvm_get_dev_max_frame_rate(session->device, capture->capture_data_type);
        std::string control_label = control_mode == 0 ? "continuous" : (control_mode == 2 ? "count-mode" : (control_mode == 3 ? "count-priority" : "level/common"));
        std::string trigger_label = trigger_source == static_cast<int>(LVM_TRIGGER_TIME_TRIGGER) ? "time" : ("type-" + std::to_string(trigger_source));
        json << ",\"controlMode\":" << control_mode
             << ",\"ctrlType\":" << static_cast<int>(capture->ctrl_type)
             << ",\"triggerInputType\":" << trigger_source
             << ",\"captureDataType\":" << static_cast<int>(capture->capture_data_type)
             << ",\"triggerLines\":" << static_cast<int>(capture->trigger_number_per_ctrl)
             << ",\"divRatio\":" << static_cast<int>(capture->div_ratio)
             << ",\"timeTriggerFreq\":" << capture->time_trigger_freq
             << ",\"maxFrameRate\":" << max_frame_rate
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

  bool continuous_acquiring_for_session_locked(const CameraSession* session,
                                               bool connected) const {
    return session && connected && production_capture_running_ &&
           continuous_capture_enabled_locked();
  }

  double continuous_fps_for_session_locked(const CameraSession* session) const {
    // A depth-map is the unit of work for the production worker.  The line
    // trigger rate remains a configuration value; it is not this FPS.
    constexpr unsigned long long kFpsStaleAfterMs = 10000;
    if (!session || session->continuous.frame_ticks.size() < 2 ||
        session->continuous.last_frame_tick_ms == 0) {
      return 0.0;
    }
    const unsigned long long now = GetTickCount64();
    if (now < session->continuous.last_frame_tick_ms ||
        now - session->continuous.last_frame_tick_ms > kFpsStaleAfterMs) {
      return 0.0;
    }
    const unsigned long long first_tick = session->continuous.frame_ticks.front();
    const unsigned long long last_tick = session->continuous.frame_ticks.back();
    if (last_tick <= first_tick) {
      return 0.0;
    }
    const double intervals =
        static_cast<double>(session->continuous.frame_ticks.size() - 1);
    return intervals * 1000.0 / static_cast<double>(last_tick - first_tick);
  }

  void record_stream_frame_tick_locked(StreamState& stream) {
    constexpr std::size_t kStreamFpsWindow = 16;
    const unsigned long long tick = GetTickCount64();
    stream.frame_ticks.push_back(
        stream.frame_ticks.empty() || tick >= stream.frame_ticks.back()
            ? tick
            : stream.frame_ticks.back());
    while (stream.frame_ticks.size() > kStreamFpsWindow) {
      stream.frame_ticks.pop_front();
    }
    stream.last_frame_tick_ms = stream.frame_ticks.back();
  }

  double stream_fps_for_session_locked(const CameraSession* session) const {
    constexpr unsigned long long kFpsStaleAfterMs = 10000;
    if (!session || !session->stream.running ||
        session->stream.frame_ticks.size() < 2 ||
        session->stream.last_frame_tick_ms == 0) {
      return 0.0;
    }
    const unsigned long long now = GetTickCount64();
    if (now < session->stream.last_frame_tick_ms ||
        now - session->stream.last_frame_tick_ms > kFpsStaleAfterMs) {
      return 0.0;
    }
    const unsigned long long first_tick = session->stream.frame_ticks.front();
    const unsigned long long last_tick = session->stream.frame_ticks.back();
    if (last_tick <= first_tick) {
      return 0.0;
    }
    return static_cast<double>(session->stream.frame_ticks.size() - 1) * 1000.0 /
           static_cast<double>(last_tick - first_tick);
  }

  float time_trigger_frequency_for_session_locked(
      const CameraSession& session) const {
    if (session.simulated) {
      return session.time_trigger_freq;
    }
    if (session.device && session.device->capture_param) {
      return session.device->capture_param->time_trigger_freq;
    }
    return 0.0f;
  }

  float sdk_max_acquisition_frame_rate_for_session_locked(
      const CameraSession& session) const {
    // The SDK describes this as the maximum *acquisition frame rate*.  It is
    // not documented as a time-trigger line-frequency limit, so it is
    // returned as diagnostics only and must never be used to certify a line
    // rate as safe.
    if (session.simulated) {
      return 100000.0f;
    }
    if (session.device && session.device->capture_param) {
      const float maximum = lvm_get_dev_max_frame_rate(
          session.device, session.device->capture_param->capture_data_type);
      return std::isfinite(maximum) && maximum > 0.0f ? maximum : 0.0f;
    }
    return 0.0f;
  }

  std::string continuous_settings_status_json_locked() const {
    int connected = 0;
    int configured = 0;
    float first_rate = 0.0f;
    float lowest_max_rate = 0.0f;
    bool mixed_rates = false;
    for (const auto& item : sessions_) {
      const CameraSession& session = item.second;
      const bool session_connected = session.simulated
          ? session.simulated_connected
          : (session.device && lvm_get_dev_connect_status(session.device) == 1);
      if (!session_connected) {
        continue;
      }
      ++connected;
      const float rate = time_trigger_frequency_for_session_locked(session);
      const float max_rate =
          sdk_max_acquisition_frame_rate_for_session_locked(session);
      if (max_rate > 0.0f &&
          (lowest_max_rate <= 0.0f || max_rate < lowest_max_rate)) {
        lowest_max_rate = max_rate;
      }
      if (rate <= 0.0f) {
        continue;
      }
      if (configured == 0) {
        first_rate = rate;
      } else if (std::fabs(rate - first_rate) > 0.001f) {
        mixed_rates = true;
      }
      ++configured;
    }
    std::ostringstream json;
    json << "{\"supported\":true,"
         << json_pair("route", "/api/capture/continuous-settings") << ","
         << "\"connectedCameras\":" << connected << ","
         << "\"configuredCameras\":" << configured << ","
         << "\"timeTriggerFreq\":" << (mixed_rates ? 0.0f : first_rate) << ","
         << "\"lineTriggerFrequency\":" << (mixed_rates ? 0.0f : first_rate) << ","
         << "\"sdkMaxAcquisitionFrameRate\":" << lowest_max_rate << ","
         << "\"lineTriggerRateMaximumKnown\":false,"
         << "\"mixedLineTriggerFrequency\":" << (mixed_rates ? "true" : "false") << ","
         << "\"requiresApplyToDevice\":true,"
         << "\"runtimeOnly\":true,"
         << "\"devicePersistent\":false,"
         << json_pair("readbackSource", "sdk-memory")
         << "}";
    return json.str();
  }

  std::string status_json_for_session(const CameraSession* session, const std::string& ip) const {
    if (driver_mode_ == DriverMode::Simulated || (session && session->simulated)) {
      std::string effective_ip = session ? session->ip : (ip.empty() ? simulated_ip_for_index(0) : ip);
      int index = simulated_index_for_ip(effective_ip);
      bool connected = session ? session->simulated_connected : false;
      const bool continuous_acquiring =
          continuous_acquiring_for_session_locked(session, connected);
      const ContinuousCaptureState* continuous = session ? &session->continuous : nullptr;
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
           << "\"lostPulseCounter\":0,\"bufferOverflowCounter\":0,"
           << "\"continuousAcquiring\":"
           << (continuous_acquiring ? "true" : "false") << ","
           << json_pair("continuousTelemetryStage", "sdk-capture-complete-before-storage") << ","
           << json_pair("continuousFpsUnit", "completed-depth-maps-per-second") << ","
           << "\"continuousFps\":" << continuous_fps_for_session_locked(session) << ","
           << "\"continuousFrameCount\":"
           << (continuous ? continuous->frame_count : 0) << ","
           << "\"continuousFinalizedCount\":"
           << (continuous ? continuous->finalized_count : 0) << ","
           << "\"continuousSuccessfulFrameCount\":"
           << (continuous ? continuous->successful_frame_count : 0) << ","
           << "\"continuousLastResultCode\":"
           << (continuous ? continuous->last_result_code : 0) << ","
           << json_pair("lastContinuousFrameAt",
                        continuous ? continuous->last_frame_at : "");
      if (session) {
        json << ",\"streamRunning\":" << (session->stream.running ? "true" : "false")
             << ",\"streamFrames\":" << session->stream.frame_count
             << ",\"streamFps\":" << stream_fps_for_session_locked(session)
             << "," << json_pair("streamLastFrameAt", session->stream.updated_at);
      }
      json << ",\"captureConfig\":" << capture_config_json_for_session(session);
      json << "}";
      return json.str();
    }
    lvm_dev_t* device = session ? session->device : nullptr;
    int connected = device ? lvm_get_dev_connect_status(device) : 0;
    const bool continuous_acquiring =
        continuous_acquiring_for_session_locked(session, connected == 1);
    const ContinuousCaptureState* continuous = session ? &session->continuous : nullptr;
    int dev_id = device ? lvm_get_dev_id(device) : -1;
    std::ostringstream json;
    json << "{\"connected\":" << (connected == 1 ? "true" : "false")
         << ",\"deviceId\":" << dev_id << ","
         << json_pair("ip", session ? session->ip : ip) << ","
         << json_pair("driverId", "lvm-nvt") << ","
         << json_pair("acquisitionState", connected == 1 ? "connected" : "discovered") << ","
         << json_pair("sdkStatus", sdk_ready_ ? "ready" : "not-ready") << ","
         << "\"continuousAcquiring\":"
         << (continuous_acquiring ? "true" : "false") << ","
         << json_pair("continuousTelemetryStage", "sdk-capture-complete-before-storage") << ","
         << json_pair("continuousFpsUnit", "completed-depth-maps-per-second") << ","
         << "\"continuousFps\":" << continuous_fps_for_session_locked(session) << ","
         << "\"continuousFrameCount\":"
         << (continuous ? continuous->frame_count : 0) << ","
         << "\"continuousFinalizedCount\":"
         << (continuous ? continuous->finalized_count : 0) << ","
         << "\"continuousSuccessfulFrameCount\":"
         << (continuous ? continuous->successful_frame_count : 0) << ","
         << "\"continuousLastResultCode\":"
         << (continuous ? continuous->last_result_code : 0) << ","
         << json_pair("lastContinuousFrameAt",
                      continuous ? continuous->last_frame_at : "");
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
           << ",\"streamFps\":" << stream_fps_for_session_locked(session)
           << "," << json_pair("streamLastFrameAt", session->stream.updated_at)
           << ",\"captureConfig\":" << capture_config_json_for_session(session);
    }
    json << "}";
    return json.str();
  }

  std::string health_json() {
    std::lock_guard<std::mutex> lock(mutex_);
    const bool invalid_manifest = !calibration_rollback_manifest_set_valid_;
    const int pending_recovery_count =
        pending_calibration_recovery_count_locked();
    const bool recovery_required =
        invalid_manifest || pending_recovery_count > 0;
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
           << "\"ready\":" << (recovery_required ? "false" : "true") << ","
           << "\"sdkReady\":" << (recovery_required ? "false" : "true") << ","
           << "\"sdkCode\":"
           << (recovery_required ? CALIBRATION_RECOVERY_REQUIRED : CORRECT) << ","
           << "\"recoveryRequired\":" << (recovery_required ? "true" : "false") << ","
           << "\"invalidManifest\":" << (invalid_manifest ? "true" : "false") << ","
           << "\"pendingRecoveryCount\":" << pending_recovery_count << ","
           << "\"calibrationCrashFailpointArmed\":"
           << (calibration_crash_failpoint_armed() ? "true" : "false") << ","
           << json_pair("calibrationCrashOperationId",
                        environment_text("CAPTURE_CALIBRATION_CRASH_OPERATION_ID")) << ","
           << json_pair("calibrationCrashPhase",
                        environment_text("CAPTURE_CALIBRATION_CRASH_PHASE")) << ","
           << "\"calibrationCrashCameraIndex\":"
           << calibration_crash_camera_index_setting() << ","
           << "\"connected\":" << (connected_count > 0 ? "true" : "false") << ","
           << json_pair("ip", first_ip) << ","
           << json_pair("driverMode", "simulated") << ","
           << json_pair("driverId", "simulated") << ","
           << json_pair("driverName", "Simulated 3D Camera Driver") << ","
           << json_pair("storageRoot", storage_root_.string()) << ","
           << json_pair("configRoot", config_root_locked().string()) << ","
           << "\"cameraCount\":" << connected_count << ","
           << "\"expectedCameras\":" << expected_cameras_ << ","
           << "\"sdkCaptureState\":" << sdk_capture_state_json() << ","
           << "\"storageQueue\":" << storage_queue_status_json()
           << "}";
      return json.str();
    }
    const bool restart_required = sdk_capture_restart_required();
    int sdk_ret = restart_required ? SDK_CAPTURE_RESTART_REQUIRED : ensure_sdk();
    const bool effective_sdk_ready = steel_capture::sdk_health_ready(
        sdk_ready_, recovery_required, restart_required);
    int connected_count = 0;
    std::string first_ip;
    for (const auto& item : sessions_) {
      if (item.second.device &&
          (restart_required || lvm_get_dev_connect_status(item.second.device) == 1)) {
        ++connected_count;
        if (first_ip.empty()) {
          first_ip = item.first;
        }
      }
    }
    const bool camera_set_ready = steel_capture::camera_set_ready(
        connected_count, expected_cameras_);
    const bool effective_ready = steel_capture::provider_health_ready(
        effective_sdk_ready, connected_count, expected_cameras_);
    std::ostringstream json;
    json << "{"
         << json_pair("service", "steel_capture_service") << ","
         << json_pair("time", now_iso()) << ","
         << "\"ready\":" << (effective_ready ? "true" : "false") << ","
         << "\"sdkReady\":" << (effective_sdk_ready ? "true" : "false") << ","
         << "\"sdkCode\":"
         << (recovery_required ? CALIBRATION_RECOVERY_REQUIRED : sdk_ret) << ","
         << "\"sdkUnderlyingCode\":" << sdk_ret << ","
         << "\"recoveryRequired\":" << (recovery_required ? "true" : "false") << ","
         << "\"invalidManifest\":" << (invalid_manifest ? "true" : "false") << ","
         << "\"pendingRecoveryCount\":" << pending_recovery_count << ","
         << "\"calibrationCrashFailpointArmed\":"
         << (calibration_crash_failpoint_armed() ? "true" : "false") << ","
         << json_pair("calibrationCrashOperationId",
                      environment_text("CAPTURE_CALIBRATION_CRASH_OPERATION_ID")) << ","
         << json_pair("calibrationCrashPhase",
                      environment_text("CAPTURE_CALIBRATION_CRASH_PHASE")) << ","
         << "\"calibrationCrashCameraIndex\":"
         << calibration_crash_camera_index_setting() << ","
         << "\"connected\":" << (connected_count > 0 ? "true" : "false") << ","
         << json_pair("ip", first_ip) << ","
         << json_pair("driverMode", driver_mode_text(driver_mode_)) << ","
         << json_pair("driverId", "lvm-nvt") << ","
         << json_pair("driverName", "LVM/NVT 3D Camera SDK") << ","
         << json_pair("storageRoot", storage_root_.string()) << ","
         << json_pair("configRoot", config_root_locked().string()) << ","
         << "\"cameraCount\":" << connected_count << ","
         << "\"expectedCameras\":" << expected_cameras_ << ","
         << "\"cameraSetReady\":" << (camera_set_ready ? "true" : "false") << ","
         << "\"sdkCaptureState\":" << sdk_capture_state_json() << ","
         << "\"storageQueue\":" << storage_queue_status_json()
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
    if (ret == CORRECT && !production_capture_running_ &&
        continuous_capture_enabled_locked() &&
        static_cast<int>(connected_capture_ips_locked().size()) == expected_cameras_) {
      start_production_capture_worker_locked("{}");
    }

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

    const int effective_expected = expected_cameras > 0 ? expected_cameras : expected_cameras_;
    bool expected_met = static_cast<int>(ips.size()) == effective_expected &&
                        connected == effective_expected && failed == 0;
    int code = (failed == 0 && expected_met) ? CORRECT : (first_error == CORRECT ? 206 : first_error);
    if (code == CORRECT && connected == expected_cameras_ &&
        static_cast<int>(ips.size()) == expected_cameras_ &&
        !production_capture_running_ && continuous_capture_enabled_locked()) {
      start_production_capture_worker_locked("{}");
    }
    std::ostringstream json;
    json << "{\"code\":" << code
         << ",\"discovered\":" << ips.size()
         << ",\"connected\":" << connected
         << ",\"failed\":" << failed
         << ",\"expectedCameras\":" << effective_expected
         << ",\"expectedMet\":" << (expected_met ? "true" : "false")
         << ",\"results\":" << results.str()
         << "}";
    return json.str();
  }

  std::string disconnect_json(const std::string& body) {
    std::unique_lock<std::mutex> lock(mutex_);
    if (active_capture_batches_ > 0) {
      return json_error(409, "capture batch is running");
    }
    if (production_capture_running_) {
      request_stop_production_capture_worker_locked();
      if (!production_capture_cv_.wait_for(
              lock,
              std::chrono::seconds(15),
              [this]() { return !production_capture_running_; })) {
        return json_error(409, "continuous acquisition did not stop before disconnect");
      }
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
      std::ostringstream result;
      result << "{\"code\":" << ret << ","
             << json_pair("errorName", capture_error_name(ret)) << ","
             << json_pair("operatorHint", capture_error_hint(ret)) << ","
             << "\"connected\":false,"
             << json_pair("ip", ip)
             << "}";
      return result.str();
    }
    int disconnected = 0;
    int failed = 0;
    int first_error = CORRECT;
    std::ostringstream results;
    results << "[";
    bool first = true;
    for (auto& item : sessions_) {
      int camera_code = CORRECT;
      stop_stream_locked(item.second);
      if (item.second.device) {
        camera_code = lvm_disconnect_dev(item.second.device);
        lvm_destroy_dev(item.second.device);
      }
      if (camera_code == CORRECT) {
        ++disconnected;
      } else {
        ++failed;
        if (first_error == CORRECT) {
          first_error = camera_code;
        }
      }
      if (!first) results << ",";
      first = false;
      results << "{\"code\":" << camera_code << ","
              << json_pair("ip", item.first) << ","
              << json_pair("errorName", capture_error_name(camera_code)) << ","
              << json_pair("operatorHint", capture_error_hint(camera_code)) << ","
              << "\"connected\":false,"
              << "\"disconnected\":"
              << (camera_code == CORRECT ? "true" : "false")
              << "}";
    }
    results << "]";
    const int requested = static_cast<int>(sessions_.size());
    sessions_.clear();
    const int code = failed == 0 ? CORRECT : first_error;
    std::ostringstream response;
    response << "{\"code\":" << code << ","
             << json_pair("errorName", capture_error_name(code)) << ","
             << json_pair("operatorHint", capture_error_hint(code)) << ","
             << "\"connected\":false,"
             << "\"requested\":" << requested << ","
             << "\"disconnected\":" << disconnected << ","
             << "\"failed\":" << failed << ","
             << "\"results\":" << results.str()
             << "}";
    return response.str();
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
    const bool capture_timing_parameter =
        _stricmp(key.c_str(), "TimeTriggerFreq") == 0 ||
        _stricmp(key.c_str(), "time_trigger_freq") == 0 ||
        _stricmp(key.c_str(), "TriggerMode") == 0 ||
        _stricmp(key.c_str(), "ctrl_type") == 0 ||
        _stricmp(key.c_str(), "ControlMode") == 0 ||
        _stricmp(key.c_str(), "ctrl_mode") == 0 ||
        _stricmp(key.c_str(), "TriggerInputType") == 0 ||
        _stricmp(key.c_str(), "trigger_input_type") == 0 ||
        _stricmp(key.c_str(), "DivRatio") == 0 ||
        _stricmp(key.c_str(), "div_ratio") == 0 ||
        _stricmp(key.c_str(), "CaptureDataType") == 0 ||
        _stricmp(key.c_str(), "capture_data_type") == 0 ||
        _stricmp(key.c_str(), "TriggerLines") == 0 ||
        _stricmp(key.c_str(), "ControlLineNum") == 0 ||
        _stricmp(key.c_str(), "trigger_number_per_ctrl") == 0;
    std::lock_guard<std::mutex> lock(mutex_);
    if (capture_timing_parameter && production_capture_running_) {
      return json_error(
          409,
          "continuous acquisition is active; use /api/capture/continuous-settings for a safe line-rate change");
    }
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

  std::string continuous_settings_json() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::ostringstream json;
    json << "{\"code\":0,\"settings\":"
         << continuous_settings_status_json_locked() << "}";
    return json.str();
  }

  std::string continuous_settings_json(const std::string& body) {
    const bool has_time_trigger_frequency =
        json_has_field(body, "timeTriggerFreq") ||
        json_has_field(body, "lineTriggerFrequency");
    if (!has_time_trigger_frequency) {
      return json_error(
          400,
          "timeTriggerFreq or lineTriggerFrequency is required for continuous settings");
    }
    const float requested_rate = json_has_field(body, "timeTriggerFreq")
        ? json_float_field(body, "timeTriggerFreq", 0.0f)
        : json_float_field(body, "lineTriggerFrequency", 0.0f);
    if (!std::isfinite(requested_rate) || requested_rate < 0.1f ||
        requested_rate > 100000.0f) {
      return json_error(
          400,
          "timeTriggerFreq must be a finite value between 0.1 and 100000 Hz");
    }
    if (json_bool_field(body, "saveToDevice", false) ||
        json_bool_field(body, "persistToDevice", false)) {
      return json_error(
          400,
          "continuous settings are runtime-only; use the guarded maintenance preset to persist device parameters");
    }

    const bool apply_to_device = json_bool_field(
        body, "applyToDevice", json_bool_field(body, "apply", false));
    const bool restart_continuous =
        json_bool_field(body, "restartContinuous", true);
    std::vector<std::string> requested_ips = json_string_array_field(body, "ips");
    const std::string requested_ip = json_string_field(body, "ip");
    if (!requested_ip.empty() &&
        std::find(requested_ips.begin(), requested_ips.end(), requested_ip) ==
            requested_ips.end()) {
      requested_ips.push_back(requested_ip);
    }

    std::unique_lock<std::mutex> lock(mutex_);
    if (active_capture_batches_ > 0) {
      return json_error(409, "capture batch is running");
    }
    if (driver_mode_ != DriverMode::Simulated &&
        sdk_capture_restart_required()) {
      return sdk_capture_restart_error_json();
    }
    if (requested_ips.empty()) {
      requested_ips = connected_capture_ips_locked();
    }
    if (requested_ips.empty()) {
      return json_error(DEV_NOT_LINK_ERROR, "no connected cameras for continuous settings");
    }
    std::sort(requested_ips.begin(), requested_ips.end());
    requested_ips.erase(
        std::unique(requested_ips.begin(), requested_ips.end()), requested_ips.end());

    auto validate_targets = [&]() -> std::string {
      for (const auto& ip : requested_ips) {
        CameraSession* session = session_for_ip_locked(ip);
        if (!session || (!session->device && !session->simulated_connected)) {
          return json_error(DEV_NOT_LINK_ERROR, "requested camera is not connected: " + ip);
        }
        if (session->stream.running) {
          return json_error(
              409,
              "realtime preview is running; stop preview before changing continuous settings: " + ip);
        }
        if (!session->simulated && !session->device->capture_param) {
          return json_error(
              INPUT_PARAMETER_ERROR,
              "camera has no capture parameters: " + ip);
        }
      }
      return "";
    };

    if (const std::string validation_error = validate_targets();
        !validation_error.empty()) {
      return validation_error;
    }

    const bool production_was_running = production_capture_running_;
    bool production_restarted = false;
    auto restart_production_if_requested = [&]() {
      if (!apply_to_device || !production_was_running ||
          !restart_continuous || !continuous_capture_enabled_locked() ||
          production_capture_running_ || connected_capture_ips_locked().empty() ||
          (driver_mode_ != DriverMode::Simulated &&
           sdk_capture_restart_required())) {
        return;
      }
      start_production_capture_worker_locked("{}");
      production_restarted = production_capture_running_;
    };
    if (apply_to_device && production_was_running) {
      request_stop_production_capture_worker_locked();
      if (!production_capture_cv_.wait_for(
              lock,
              std::chrono::seconds(15),
              [this]() { return !production_capture_running_; })) {
        return json_error(
            409,
            "continuous acquisition did not stop before line-rate setting change");
      }
      if (const std::string validation_error = validate_targets();
          !validation_error.empty()) {
        restart_production_if_requested();
        return validation_error;
      }
    }

    struct ContinuousSettingsTarget {
      CameraSession* session = nullptr;
      std::string ip;
      float previous_rate = 0.0f;
      float max_rate = 0.0f;
      int apply_code = CORRECT;
      int rollback_code = CORRECT;
      bool attempted = false;
      bool applied = false;
      bool rollback_attempted = false;
      bool rolled_back = false;
    };
    std::vector<ContinuousSettingsTarget> targets;
    targets.reserve(requested_ips.size());
    for (const auto& ip : requested_ips) {
      CameraSession* session = session_for_ip_locked(ip);
      targets.push_back({
          session,
          ip,
          session ? time_trigger_frequency_for_session_locked(*session) : 0.0f,
          session ? sdk_max_acquisition_frame_rate_for_session_locked(*session) : 0.0f});
    }

    auto write_runtime_rate = [](CameraSession& session, float rate) {
      if (session.simulated) {
        session.time_trigger_freq = rate;
        session.params["TimeTriggerFreq"] = std::to_string(rate);
        return CORRECT;
      }
      if (!session.device || !session.device->capture_param) {
        return INPUT_PARAMETER_ERROR;
      }
      session.device->capture_param->time_trigger_freq = rate;
      return lvm_set_param(session.device, LVM_CAPTURE_PARAM);
    };

    int attempted = 0;
    int applied_before_rollback = 0;
    int failed = 0;
    int first_error = CORRECT;
    bool transaction_failed = false;
    if (apply_to_device) {
      for (auto& target : targets) {
        target.attempted = true;
        ++attempted;
        target.apply_code = target.session
            ? write_runtime_rate(*target.session, requested_rate)
            : DEV_NOT_LINK_ERROR;
        target.applied = target.apply_code == CORRECT;
        if (target.applied) {
          ++applied_before_rollback;
          continue;
        }
        transaction_failed = true;
        ++failed;
        first_error = target.apply_code;
        break;
      }
      if (transaction_failed) {
        // Roll every target we touched, including the target whose SDK call
        // returned an error: a device may have accepted a partial update even
        // when the SDK reports failure.  Do not restart acquisition after an
        // incomplete transaction; an operator must inspect the result first.
        for (auto& target : targets) {
          if (!target.attempted || !target.session) {
            continue;
          }
          target.rollback_attempted = true;
          target.rollback_code =
              write_runtime_rate(*target.session, target.previous_rate);
          target.rolled_back = target.rollback_code == CORRECT;
        }
      }
    }
    int rolled_back = 0;
    int rollback_failed = 0;
    for (const auto& target : targets) {
      if (!target.rollback_attempted) {
        continue;
      }
      if (target.rolled_back) {
        ++rolled_back;
      } else {
        ++rollback_failed;
      }
    }

    std::ostringstream results;
    results << "[";
    for (size_t index = 0; index < targets.size(); ++index) {
      if (index > 0) {
        results << ",";
      }
      const ContinuousSettingsTarget& target = targets[index];
      const float current_rate = target.session
          ? time_trigger_frequency_for_session_locked(*target.session)
          : target.previous_rate;
      const bool committed = apply_to_device && !transaction_failed &&
          target.applied;
      results << "{\"code\":" << target.apply_code << ","
              << "\"runtimeApplyCode\":" << target.apply_code << ","
              << json_pair("ip", target.ip) << ","
              << "\"attempted\":" << (target.attempted ? "true" : "false") << ","
              << "\"applied\":" << (committed ? "true" : "false") << ","
              << "\"appliedBeforeRollback\":"
              << (target.applied ? "true" : "false") << ","
              << "\"previousTimeTriggerFreq\":" << target.previous_rate << ","
              << "\"timeTriggerFreq\":" << current_rate << ","
              << "\"lineTriggerFrequency\":" << current_rate << ","
              << "\"sdkMaxAcquisitionFrameRate\":" << target.max_rate << ","
              << "\"lineTriggerRateMaximumKnown\":false,"
              << "\"rollbackAttempted\":"
              << (target.rollback_attempted ? "true" : "false") << ","
              << "\"rollbackCode\":" << target.rollback_code << ","
              << "\"rolledBack\":" << (target.rolled_back ? "true" : "false") << ","
              << "\"deviceReadbackVerified\":false"
              << "}";
    }
    results << "]";

    if (apply_to_device) {
      steel_state_.updated_at = now_iso();
      write_steel_summary_locked();
    }
    if (!transaction_failed) {
      restart_production_if_requested();
    }

    const int code = failed == 0 ? CORRECT : first_error;
    std::ostringstream json;
    json << "{\"code\":" << code << ","
         << "\"applyToDevice\":" << (apply_to_device ? "true" : "false") << ","
         << "\"dryRun\":" << (apply_to_device ? "false" : "true") << ","
         << "\"runtimeOnly\":true,"
         << "\"devicePersistent\":false,"
         << "\"deviceReadbackVerified\":false,"
         << json_pair("readbackSource", "sdk-memory") << ","
         << "\"restartContinuous\":" << (restart_continuous ? "true" : "false") << ","
         << "\"productionCaptureWasRunning\":"
         << (production_was_running ? "true" : "false") << ","
         << "\"productionCaptureRestarted\":"
         << (production_restarted ? "true" : "false") << ","
         << "\"timeTriggerFreq\":" << requested_rate << ","
         << "\"lineTriggerFrequency\":" << requested_rate << ","
         << "\"atomic\":true,"
         << "\"transactionCommitted\":"
         << (apply_to_device && !transaction_failed ? "true" : "false") << ","
         << "\"validatedOnly\":" << (!apply_to_device ? "true" : "false") << ","
         << "\"attempted\":" << attempted << ","
         << "\"appliedBeforeRollback\":" << applied_before_rollback << ","
         << "\"applied\":"
         << (transaction_failed ? 0 : applied_before_rollback) << ","
         << "\"failed\":" << failed << ","
         << "\"rolledBack\":" << rolled_back << ","
         << "\"rollbackFailed\":" << rollback_failed << ","
         << "\"requiresOperatorRestart\":"
         << (transaction_failed && production_was_running ? "true" : "false") << ","
         << "\"results\":" << results.str() << ","
         << "\"settings\":" << continuous_settings_status_json_locked()
         << "}";
    return json.str();
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

    if (!std::isfinite(time_trigger_freq) || time_trigger_freq < 0.1f ||
        time_trigger_freq > 100000.0f) {
      return json_error(400, "timeTriggerFreq must be a finite value between 0.1 and 100000 Hz");
    }

    std::unique_lock<std::mutex> lock(mutex_);
    if (active_capture_batches_ > 0) {
      return json_error(409, "capture batch is running");
    }
    if (driver_mode_ != DriverMode::Simulated &&
        sdk_capture_restart_required()) {
      return sdk_capture_restart_error_json();
    }
    const bool production_was_running = production_capture_running_;
    bool production_restarted = false;
    auto restart_production_if_needed = [&]() {
      if (!production_was_running || !continuous_capture_enabled_locked() ||
          production_capture_running_ || connected_capture_ips_locked().empty() ||
          (driver_mode_ != DriverMode::Simulated && sdk_capture_restart_required())) {
        return;
      }
      start_production_capture_worker_locked("{}");
      production_restarted = production_capture_running_;
    };
    if (production_was_running) {
      request_stop_production_capture_worker_locked();
      if (!production_capture_cv_.wait_for(
              lock,
              std::chrono::seconds(15),
              [this]() { return !production_capture_running_; })) {
        return json_error(409, "continuous acquisition did not stop before line preset apply");
      }
    }
    for (const auto& item : sessions_) {
      const CameraSession& session = item.second;
      if (!ips.empty() && std::find(ips.begin(), ips.end(), session.ip) == ips.end()) {
        continue;
      }
      if ((session.device || session.simulated) && session.stream.running) {
        restart_production_if_needed();
        return json_error(409, "stream is running; stop stream before applying line preset");
      }
    }
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
      int ret = CORRECT;
      if (session.simulated) {
        session.time_trigger_freq = time_trigger_freq;
        session.params["TimeTriggerFreq"] = std::to_string(time_trigger_freq);
        session.params["TriggerLines"] = std::to_string(lines);
        session.params["ControlMode"] = std::to_string(control_mode);
        session.params["TriggerInputType"] =
            std::to_string(static_cast<int>(LVM_TRIGGER_TIME_TRIGGER));
      } else {
        ret = apply_line_continuous_preset(
            session.device,
            lines,
            time_trigger_freq,
            laser_power,
            laser_line_select,
            control_mode);
      }
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
    restart_production_if_needed();
    int code = failed == 0 ? CORRECT : first_error;
    std::ostringstream json;
    json << "{\"code\":" << code
         << ",\"applied\":" << applied
         << ",\"failed\":" << failed
         << ",\"lines\":" << lines
         << ",\"controlMode\":" << control_mode
         << ",\"timeTriggerFreq\":" << time_trigger_freq
         << ",\"laserPower\":" << std::max(0, std::min(100, laser_power))
         << ",\"productionCaptureWasRunning\":"
         << (production_was_running ? "true" : "false")
         << ",\"productionCaptureRestarted\":"
         << (production_restarted ? "true" : "false")
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

  OwnedImageSource simulated_image_source_locked(CameraSession& session,
                                                 int width,
                                                 int lines,
                                                 const std::string& kind,
                                                 int sequence) const {
    OwnedImageSource source;
    std::error_code error;
    std::filesystem::path source_dir = path_from_json_text(simulated_image_source_dir_);
    if (!simulated_image_source_dir_.empty() && std::filesystem::exists(source_dir, error)) {
      std::vector<std::filesystem::path> pngs;
      for (const auto& entry : std::filesystem::directory_iterator(source_dir, error)) {
        if (entry.is_regular_file()) {
          std::string extension = entry.path().extension().string();
          std::transform(extension.begin(), extension.end(), extension.begin(), [](unsigned char ch) {
            return static_cast<char>(std::tolower(ch));
          });
          if (extension == ".png") {
            pngs.push_back(entry.path());
          }
        }
      }
      std::sort(pngs.begin(), pngs.end());
      if (!pngs.empty()) {
        const size_t index = static_cast<size_t>(
            std::max(0, sequence) + simulated_index_for_ip(session.ip)) % pngs.size();
        source.kind = OwnedImageSource::Kind::ExistingFile;
        source.primary_file = pngs[index].lexically_normal().string();
        const std::uintmax_t file_bytes = std::filesystem::file_size(pngs[index], error);
        source.accounted_bytes = error
                                     ? estimated_frame_bytes(width, lines, sizeof(std::uint16_t))
                                     : static_cast<std::size_t>(std::min<std::uintmax_t>(
                                           file_bytes,
                                           std::numeric_limits<std::size_t>::max()));
        source.width = width;
        source.height = lines;
        return source;
      }
    }

    width = width <= 0 ? 640 : width;
    lines = lines <= 0 ? 480 : lines;
    auto pixels = std::make_shared<std::vector<std::uint16_t>>(
        static_cast<size_t>(width) * static_cast<size_t>(lines));
    const int camera_offset = simulated_index_for_ip(session.ip) * 4096;
    const int frame_offset = std::max(0, sequence) * 257;
    const int kind_offset = kind == "intensity" ? 8192 : 0;
    for (int y = 0; y < lines; ++y) {
      for (int x = 0; x < width; ++x) {
        const int wave = (x * 173 + y * 97 + camera_offset + frame_offset + kind_offset) % 65535;
        const int stripe = ((x / 24 + y / 18 + simulated_index_for_ip(session.ip)) % 2) ? 2400 : 0;
        (*pixels)[static_cast<size_t>(y) * static_cast<size_t>(width) + static_cast<size_t>(x)] =
            static_cast<std::uint16_t>(std::min(65535, wave + stripe));
      }
    }
    source.kind = OwnedImageSource::Kind::Pixels16;
    source.pixels = std::move(pixels);
    source.width = width;
    source.height = lines;
    source.accounted_bytes = source.pixels->size() * sizeof(std::uint16_t);
    return source;
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
    record_stream_frame_tick_locked(session.stream);
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
    bool save_sdk_derived = json_bool_field(body, "saveSdkDerived", json_bool_field(body, "save_sdk_derived", false));
    bool production_aware = json_bool_field(body, "productionLayout", false) ||
                            json_bool_field(body, "steelStateAware", false) ||
                            json_bool_field(body, "requireSteelPresent", false);
    bool require_steel_present = json_bool_field(body, "requireSteelPresent", false);
    bool calibration_maintenance_record =
        json_bool_field(body, "calibrationMaintenanceRecord", false);
    bool discard_black_frames = json_bool_field(body, "discardBlackFrames", true);
    double black_frame_threshold = json_float_field(body, "blackFrameThreshold", 8.0f);
    std::string output = json_string_field(body, "output", "");

    std::lock_guard<std::mutex> lock(mutex_);
    if (active_capture_batches_ > 0) {
      return json_error(409, "capture batch is running");
    }
    if (!steel_capture::blocking_capture_allowed(
            driver_mode_ == DriverMode::Simulated,
            production_capture_running_)) {
      return json_error(
          409,
          "continuous production acquisition is running; switch capture mode to on-demand before blocking capture");
    }
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || (!session->device && !session->simulated)) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    if (production_aware) {
      discard_black_frames = json_bool_field(body, "discardBlackFrames", steel_state_.discard_black_frames);
      black_frame_threshold = json_float_field(body, "blackFrameThreshold", static_cast<float>(steel_state_.black_frame_threshold));
      if ((require_steel_present && !steel_state_.present) || !steel_state_.save_enabled) {
        ++steel_state_.discard_frame_count;
        steel_state_.updated_at = now_iso();
        write_steel_summary_locked();
        return json_error(CAPTURE_DISCARDED_NOT_ARMED, "production capture is not armed for saving");
      }
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
      CaptureOutputPaths paths = capture_output_paths_for(output_path, save_sdk_derived);
      if (!create_capture_output_dirs(paths)) {
        return json_error(500, "output directory cannot be created");
      }
      const int sequence = ++session->simulated_capture_sequence;
      FrameWriteRequest request;
      request.paths = paths;
      request.depth = simulated_image_source_locked(*session, width, lines, "depth", sequence);
      request.intensity = simulated_image_source_locked(*session, width, lines, "intensity", sequence);
      request.pending_bytes = saturating_size_add(
          request.depth.accounted_bytes, request.intensity.accounted_bytes);
      request.metadata = capture_metadata_snapshot_locked(
          *session,
          CORRECT,
          1,
          width,
          lines,
          width,
          lines,
          data_mode,
          timeout_ms,
          sequence,
          simulated_index_for_ip(session->ip) + 1,
          0,
          0,
          0,
          static_cast<unsigned int>(GetTickCount()),
          true);
      request.metadata.depth_data_format = 0;
      request.metadata.depth_persistence_mode = "simulated-owned-pixels16";
      StorageTicket ticket = enqueue_frame_write(std::move(request));
      FrameWriteResult write_result = finish_frame_write(ticket);
      const int ret = write_result.code;
      const std::string intensity_path = write_result.intensity_code == CORRECT
                                             ? paths.intensity_path
                                             : "";
      session->calibration.validation_path = paths.depth_path;
      session->calibration.validation_code = ret;
      session->calibration.validation_time = now_iso();
      if (calibration_maintenance_record) {
        append_calibration_maintenance_record_locked(
            "validation-frame", *session, paths.depth_path, ret);
      }
      record_steel_capture_locked(session->ip, paths.depth_path, ret);
      std::ostringstream json;
      json << "{\"code\":" << ret << ",\"lines\":" << lines << ",\"width\":" << width << ","
           << "\"attempts\":1,"
           << "\"discarded\":false,"
           << json_pair("discardReason", "") << ","
           << "\"depthExists\":" << (write_result.depth_exists ? "true" : "false") << ","
           << "\"intensityExists\":" << (write_result.intensity_exists ? "true" : "false") << ","
           << "\"metadataExists\":" << (write_result.metadata_exists ? "true" : "false") << ","
           << "\"completeFrame\":" << (write_result.complete_frame ? "true" : "false") << ","
           << "\"storageTicketId\":" << write_result.ticket_id << ","
           << "\"depthDataFormat\":" << write_result.depth_data_format << ","
           << json_pair("depthPersistenceMode", write_result.depth_persistence_mode) << ","
           << json_pair("storageQueuedAt", write_result.queued_at) << ","
           << json_pair("storageStartedAt", write_result.storage_started_at) << ","
           << json_pair("storageFinishedAt", write_result.storage_finished_at) << ","
           << json_pair("errorName", capture_error_name(ret)) << ","
           << json_pair("operatorHint", capture_error_hint(ret)) << ","
           << json_pair("ip", session->ip) << ","
           << json_pair("output", paths.depth_path) << ","
           << json_pair("depthOutput", paths.depth_path) << ","
           << json_pair("intensityOutput", intensity_path) << ","
           << json_pair("metadataOutput", write_result.metadata_exists ? paths.metadata_path : "") << ","
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
    CaptureOutputPaths paths = capture_output_paths_for(output_path, save_sdk_derived);
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
    int depth_data_format = -1;
    std::string depth_persistence_mode;
    bool saved_intensity = false;
    bool discarded = false;
    std::string discard_reason;
    std::string depth_saved_path = paths.depth_path;
    FrameWriteResult final_write_result;
    final_write_result.depth_path = paths.depth_path;
    final_write_result.intensity_path = paths.intensity_path;
    final_write_result.metadata_path = paths.metadata_path;

    lvm_trigger_en_ctrl(session->device, false);
    lvm_grab_stop(session->device);

    for (int attempt = 0; attempt <= retries; ++attempt) {
      attempts = attempt + 1;
      final_write_result = FrameWriteResult{};
      final_write_result.depth_path = paths.depth_path;
      final_write_result.intensity_path = paths.intensity_path;
      final_write_result.metadata_path = paths.metadata_path;
      saved_intensity = false;
      discarded = false;
      discard_reason.clear();
      depth_data_format = -1;
      depth_persistence_mode.clear();
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
      OwnedImageSource depth_source;
      OwnedImageSource intensity_source;
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
        depth_data_format = depth_map->param ? depth_map->param->data_format : -1;
        if (discard_black_frames && depth_map_is_black_frame(depth_map, black_frame_threshold)) {
          ret = BLACK_FRAME_DISCARDED;
          discarded = true;
          discard_reason = "black-frame";
        } else {
          if (depth_data_format == 0) {
            ret = clone_owned_depth_map16(depth_map, depth_source)
                      ? CORRECT
                      : MALLOC_FAILED;
            if (ret == CORRECT) {
              depth_persistence_mode = "owned-offline-format0";
            }
          } else if (depth_data_format == 2) {
            // Capture 6.7's offline saver reads float depth buffers as ushort.
            // Keep the online SDK save inside the capture lifetime for format2.
            ret = lvm_save_depth_map(
                session->device, paths.sdk_base_path.c_str(), depth_map);
            if (ret == CORRECT) {
              depth_persistence_mode = "sdk-online-format2-fallback";
            }
          } else {
            ret = CAPTURE_DEPTH_FORMAT_UNSUPPORTED;
          }
          if (ret == CORRECT && depth_data_format == 2) {
            depth_source.kind = OwnedImageSource::Kind::ExistingFile;
            depth_source.primary_file = paths.sdk_depth_path;
            depth_source.fallback_file = paths.sdk_base_path;
            depth_source.width = actual_width;
            depth_source.height = actual_lines;
            depth_source.accounted_bytes = estimated_frame_bytes(
                actual_width, actual_lines, sizeof(float));
          }
          if (ret == CORRECT &&
              !clone_owned_image16(depth_map->intensity_img, intensity_source)) {
            ret = CAPTURE_INTENSITY_MISSING;
          }
        }
      }
      lvm_trigger_en_ctrl(session->device, false);
      lvm_grab_stop(session->device);
      lvm_free_buf(buffer);
      if (session->device) {
        session->device->buffer = nullptr;
      }
      if (ret == CORRECT && !intensity_source.available()) {
        ret = CAPTURE_INTENSITY_MISSING;
      }
      if (ret == CORRECT && depth_source.available() && intensity_source.available()) {
        FrameWriteRequest request;
        request.paths = paths;
        request.depth = std::move(depth_source);
        request.intensity = std::move(intensity_source);
        request.pending_bytes = saturating_size_add(
            request.depth.accounted_bytes, request.intensity.accounted_bytes);
        request.metadata = capture_metadata_snapshot_locked(
            *session,
            CORRECT,
            attempts,
            width,
            lines,
            actual_width,
            actual_lines,
            data_mode,
            timeout_ms,
            fid,
            sid,
            lost_lines,
            trigger_min_interval,
            trigger_max_interval,
            frame_timestamp,
            false);
        request.metadata.depth_data_format = depth_data_format;
        request.metadata.depth_persistence_mode = depth_persistence_mode;
        StorageTicket ticket = enqueue_frame_write(std::move(request));
        final_write_result = finish_frame_write(ticket);
        ret = final_write_result.code;
        saved_intensity = final_write_result.intensity_code == CORRECT;
      }
      if (ret == CORRECT) {
        break;
      }
      if (attempt < retries) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
      }
    }

    if (final_write_result.ticket_id == 0) {
      cleanup_sdk_outputs(paths);
      final_write_result.code = ret;
      final_write_result.capture_code = ret;
      final_write_result.depth_code = ret;
      final_write_result.intensity_code = ret;
      final_write_result.metadata_code = ret;
    }
    if (discarded) {
      std::error_code remove_error;
      std::filesystem::remove(paths.depth_path, remove_error);
      remove_error.clear();
      std::filesystem::remove(paths.intensity_path, remove_error);
      remove_error.clear();
      std::filesystem::remove(paths.sdk_base_path, remove_error);
      remove_error.clear();
      std::filesystem::remove(paths.sdk_depth_path, remove_error);
      remove_error.clear();
      std::filesystem::remove(paths.sdk_intensity_path, remove_error);
      depth_saved_path = paths.depth_path;
      saved_intensity = false;
      final_write_result.depth_exists = false;
      final_write_result.intensity_exists = false;
      final_write_result.metadata_exists = false;
      final_write_result.complete_frame = false;
    }
    if (!saved_intensity) {
      intensity_path.clear();
    }

    session->calibration.validation_path = depth_saved_path;
    session->calibration.validation_code = ret;
    session->calibration.validation_time = now_iso();
    if (calibration_maintenance_record) {
      append_calibration_maintenance_record_locked(
          "validation-frame", *session, depth_saved_path, ret);
    }
    record_steel_capture_locked(session->ip, depth_saved_path, ret);

    std::ostringstream json;
    json << "{\"code\":" << ret << ",\"lines\":" << actual_lines << ",\"width\":" << actual_width << ","
         << "\"requestedLines\":" << lines << ","
         << "\"requestedWidth\":" << width << ","
         << "\"attempts\":" << attempts << ","
         << "\"retries\":" << retries << ","
         << "\"discarded\":" << (discarded ? "true" : "false") << ","
         << json_pair("discardReason", discard_reason) << ","
         << "\"depthExists\":" << (final_write_result.depth_exists ? "true" : "false") << ","
         << "\"intensityExists\":" << (final_write_result.intensity_exists ? "true" : "false") << ","
         << "\"metadataExists\":" << (final_write_result.metadata_exists ? "true" : "false") << ","
         << "\"completeFrame\":" << (final_write_result.complete_frame ? "true" : "false") << ","
         << "\"storageTicketId\":" << final_write_result.ticket_id << ","
         << "\"depthDataFormat\":" << depth_data_format << ","
         << json_pair("depthPersistenceMode", depth_persistence_mode) << ","
         << json_pair("storageQueuedAt", final_write_result.queued_at) << ","
         << json_pair("storageStartedAt", final_write_result.storage_started_at) << ","
         << json_pair("storageFinishedAt", final_write_result.storage_finished_at) << ","
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
         << json_pair("metadataOutput", final_write_result.metadata_exists ? paths.metadata_path : "") << ","
         << json_pair("sdkOutput", paths.save_sdk_derived && file_exists(paths.sdk_base_path) ? paths.sdk_base_path : "") << ","
         << json_pair("sdkDepthOutput", paths.save_sdk_derived && file_exists(paths.sdk_depth_path) ? paths.sdk_depth_path : "") << ","
         << json_pair("sdkIntensityOutput", paths.save_sdk_derived && file_exists(paths.sdk_intensity_path) ? paths.sdk_intensity_path : "") << ","
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
    bool discard_black_frames = true;
    bool save_sdk_derived = false;
    bool persist_frame = true;
    bool production_continuous = false;
    unsigned long long production_save_generation = 0;
    double black_frame_threshold = 8.0;
  };

  struct ParallelCaptureStartGate {
    std::mutex mutex;
    std::condition_variable ready;
    bool start = false;
    size_t ready_count = 0;
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
    std::string capture_finished_at;
    std::string storage_queued_at;
    std::string storage_started_at;
    std::string storage_finished_at;
    std::string worker_finished_at;
    std::string depth_persistence_mode;
    unsigned long long storage_ticket_id = 0;
    unsigned long long capture_finished_tick_ms = 0;
    unsigned long long storage_queued_tick_ms = 0;
    unsigned long long storage_started_tick_ms = 0;
    unsigned long long storage_finished_tick_ms = 0;
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
    int depth_data_format = -1;
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
    bool storage_async = false;
    bool simulated = false;
    bool discarded = false;
    std::string discard_reason;
  };

  struct PendingParallelCapture {
    ParallelCaptureResult result;
    StorageTicket storage;
    bool has_storage = false;
    bool record_capture = false;
    bool track_continuous_acquisition = false;
    unsigned long long production_save_generation = 0;

    PendingParallelCapture() = default;
    PendingParallelCapture(ParallelCaptureResult value) : result(std::move(value)) {}
    PendingParallelCapture(PendingParallelCapture&&) noexcept = default;
    PendingParallelCapture& operator=(PendingParallelCapture&&) noexcept = default;
    PendingParallelCapture(const PendingParallelCapture&) = delete;
    PendingParallelCapture& operator=(const PendingParallelCapture&) = delete;
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
    result.discarded = false;
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
         << ",\"depthDataFormat\":" << result.depth_data_format
         << "," << json_pair("depthPersistenceMode", result.depth_persistence_mode)
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
         << ",\"storageAsync\":" << (result.storage_async ? "true" : "false")
         << ",\"storageTicketId\":" << result.storage_ticket_id
         << ",\"captureFinishedTickMs\":" << result.capture_finished_tick_ms
         << ",\"storageQueuedTickMs\":" << result.storage_queued_tick_ms
         << ",\"storageStartedTickMs\":" << result.storage_started_tick_ms
         << ",\"storageFinishedTickMs\":" << result.storage_finished_tick_ms
         << ",\"simulated\":" << (result.simulated ? "true" : "false")
         << ",\"discarded\":" << (result.discarded ? "true" : "false")
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
         << "," << json_pair("discardReason", result.discard_reason)
         << "," << json_pair("roundStartedAt", result.round_started_at)
         << "," << json_pair("workerStartedAt", result.worker_started_at)
         << "," << json_pair("captureFinishedAt", result.capture_finished_at)
         << "," << json_pair("storageQueuedAt", result.storage_queued_at)
         << "," << json_pair("storageStartedAt", result.storage_started_at)
         << "," << json_pair("storageFinishedAt", result.storage_finished_at)
         << "," << json_pair("workerFinishedAt", result.worker_finished_at)
         << "}";
    return json.str();
  }

  PendingParallelCapture run_parallel_capture_job(const ParallelCaptureJob& job) {
    PendingParallelCapture pending;
    ParallelCaptureResult& result = pending.result;
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

    std::shared_ptr<std::timed_mutex> camera_mutex;
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
      if (!simulated && sdk_capture_restart_required()) {
        return parallel_capture_error(
            job,
            SDK_CAPTURE_RESTART_REQUIRED,
            "capture provider restart required after SDK worker timeout");
      }
      if (simulated) {
        if (result.width <= 0) {
          result.width = 640;
        }
        if (result.lines <= 0) {
          result.lines = 480;
        }
      }
      if (job.persist_frame) {
        output_path = resolve_output_path_locked(job.output, "continuous-test/capture-depth.png");
        if (!is_output_path_allowed_locked(output_path)) {
          return parallel_capture_error(job, 403, "output path must be under storage root");
        }
        paths = capture_output_paths_for(output_path, job.save_sdk_derived);
        intensity_path = paths.intensity_path;
        metadata_path = paths.metadata_path;
        result.output = paths.depth_path;
        result.depth_output = paths.depth_path;
        result.intensity_output = intensity_path;
        result.sdk_output = paths.save_sdk_derived ? paths.sdk_base_path : "";
        result.sdk_depth_output = paths.save_sdk_derived ? paths.sdk_depth_path : "";
        result.sdk_intensity_output = paths.save_sdk_derived ? paths.sdk_intensity_path : "";
      } else {
        result.output.clear();
        result.depth_output.clear();
        result.intensity_output.clear();
      }
      camera_mutex = session->capture_mutex;
      result.metadata_output.clear();
      result.simulated = simulated;
      pending.record_capture = job.persist_frame;
      pending.track_continuous_acquisition = job.production_continuous;
      pending.production_save_generation = job.production_save_generation;
    }

    if (job.persist_frame && !create_capture_output_dirs(paths)) {
      return parallel_capture_error(job, 500, "output directory cannot be created");
    }

    const int camera_lock_timeout_ms = std::max(1000, std::min(60000, job.timeout_ms + 1000));
    std::unique_lock<std::timed_mutex> camera_lock(*camera_mutex, std::defer_lock);
    if (!camera_lock.try_lock_for(std::chrono::milliseconds(camera_lock_timeout_ms))) {
      return parallel_capture_error(job, 409, "camera capture is busy; a previous SDK grab may still be running");
    }
    if (simulated) {
      if (!job.persist_frame) {
        std::lock_guard<std::mutex> lock(mutex_);
        CameraSession* session = session_for_ip_locked(job.ip);
        if (!session || !session->simulated) {
          return parallel_capture_error(job, DEV_NOT_LINK_ERROR, "camera not connected");
        }
        ++session->simulated_capture_sequence;
        result.code = CORRECT;
        result.attempts_used = 1;
        result.depth_data_format = 0;
        result.depth_persistence_mode = "discarded-live-frame";
        result.discarded = true;
        result.discard_reason = "save-disabled";
        result.capture_finished_at = now_iso();
        result.capture_finished_tick_ms = GetTickCount64();
        result.worker_finished_at = result.capture_finished_at;
        return pending;
      }
      FrameWriteRequest request;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        CameraSession* session = session_for_ip_locked(job.ip);
        if (!session || !session->simulated) {
          return parallel_capture_error(job, DEV_NOT_LINK_ERROR, "camera not connected");
        }
        const int sequence = ++session->simulated_capture_sequence;
        request.paths = paths;
        request.depth = simulated_image_source_locked(
            *session, result.width, result.lines, "depth", sequence);
        request.intensity = simulated_image_source_locked(
            *session, result.width, result.lines, "intensity", sequence);
        request.pending_bytes = saturating_size_add(
            request.depth.accounted_bytes, request.intensity.accounted_bytes);
        request.metadata = capture_metadata_snapshot_locked(
            *session,
            CORRECT,
            1,
            result.width,
            result.lines,
            result.width,
            result.lines,
            job.data_mode,
            job.timeout_ms,
            sequence,
            simulated_index_for_ip(session->ip) + 1,
            0,
            0,
            0,
            static_cast<unsigned int>(GetTickCount()),
            true);
        request.metadata.depth_data_format = 0;
        request.metadata.depth_persistence_mode = "simulated-owned-pixels16";
      }
      result.code = CORRECT;
      result.attempts_used = 1;
      result.depth_data_format = 0;
      result.depth_persistence_mode = "simulated-owned-pixels16";
      result.output = paths.depth_path;
      result.depth_output = paths.depth_path;
      result.sdk_output.clear();
      result.sdk_depth_output.clear();
      result.sdk_intensity_output.clear();
      result.metadata_output.clear();
      result.capture_finished_at = now_iso();
      result.capture_finished_tick_ms = GetTickCount64();
      pending.storage = enqueue_frame_write(std::move(request));
      pending.has_storage = true;
      result.storage_async = true;
      result.storage_ticket_id = pending.storage.id;
      result.storage_queued_at = pending.storage.result->queued_at;
      result.storage_queued_tick_ms = pending.storage.result->queued_tick_ms;
      return pending;
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
    int depth_data_format = -1;
    std::string depth_persistence_mode;
    bool saved_intensity = false;
    std::string depth_saved_path = paths.depth_path;
    OwnedImageSource depth_source;
    OwnedImageSource intensity_source;

    lvm_trigger_en_ctrl(device, false);
    lvm_grab_stop(device);

    for (int attempt = 0; attempt <= job.retries; ++attempt) {
      attempts = attempt + 1;
      saved_intensity = false;
      depth_source = OwnedImageSource{};
      intensity_source = OwnedImageSource{};
      result.discarded = false;
      result.discard_reason.clear();
      depth_data_format = -1;
      depth_persistence_mode.clear();
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
        depth_data_format = depth_map->param ? depth_map->param->data_format : -1;
        if (!job.persist_frame) {
          ret = CORRECT;
          result.discarded = true;
          result.discard_reason = "save-disabled";
          depth_persistence_mode = "discarded-live-frame";
        } else if (job.discard_black_frames && depth_map_is_black_frame(depth_map, job.black_frame_threshold)) {
          ret = BLACK_FRAME_DISCARDED;
          result.discarded = true;
          result.discard_reason = "black-frame";
        } else {
          if (depth_data_format == 0) {
            ret = clone_owned_depth_map16(depth_map, depth_source)
                      ? CORRECT
                      : MALLOC_FAILED;
            if (ret == CORRECT) {
              depth_persistence_mode = "owned-offline-format0";
            }
          } else if (depth_data_format == 2) {
            // Capture 6.7's offline saver corrupts float depth maps, so the
            // online save remains a deliberate capture-thread fallback.
            ret = lvm_save_depth_map(device, paths.sdk_base_path.c_str(), depth_map);
            if (ret == CORRECT) {
              depth_persistence_mode = "sdk-online-format2-fallback";
            }
          } else {
            ret = CAPTURE_DEPTH_FORMAT_UNSUPPORTED;
          }
          if (ret == CORRECT && depth_data_format == 2) {
            depth_source.kind = OwnedImageSource::Kind::ExistingFile;
            depth_source.primary_file = paths.sdk_depth_path;
            depth_source.fallback_file = paths.sdk_base_path;
            depth_source.width = actual_width;
            depth_source.height = actual_lines;
            depth_source.accounted_bytes = estimated_frame_bytes(
                actual_width, actual_lines, sizeof(float));
          }
          if (ret == CORRECT &&
              !clone_owned_image16(depth_map->intensity_img, intensity_source)) {
            ret = CAPTURE_INTENSITY_MISSING;
          }
        }
      }
      lvm_trigger_en_ctrl(device, false);
      lvm_grab_stop(device);
      lvm_free_buf(buffer);
      if (device) {
        device->buffer = nullptr;
      }
      if (job.persist_frame && ret == CORRECT && !intensity_source.available()) {
        ret = CAPTURE_INTENSITY_MISSING;
      }
      saved_intensity = job.persist_frame && ret == CORRECT && intensity_source.available();
      if (ret == CORRECT) {
        break;
      }
      if (attempt < job.retries) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
      }
    }

    if (result.discarded) {
      std::error_code remove_error;
      std::filesystem::remove(paths.depth_path, remove_error);
      remove_error.clear();
      std::filesystem::remove(paths.intensity_path, remove_error);
      remove_error.clear();
      std::filesystem::remove(paths.sdk_base_path, remove_error);
      remove_error.clear();
      std::filesystem::remove(paths.sdk_depth_path, remove_error);
      remove_error.clear();
      std::filesystem::remove(paths.sdk_intensity_path, remove_error);
      depth_saved_path = paths.depth_path;
      saved_intensity = false;
    }
    if (!saved_intensity) {
      intensity_path.clear();
      result.intensity_output.clear();
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
    result.depth_data_format = depth_data_format;
    result.depth_persistence_mode = depth_persistence_mode;
    result.output = depth_saved_path;
    result.depth_output = depth_saved_path;
    result.metadata_output.clear();
    result.capture_finished_at = now_iso();
    result.capture_finished_tick_ms = GetTickCount64();

    if (job.production_continuous && job.persist_frame && ret == CORRECT) {
      bool still_armed_for_save = false;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        still_armed_for_save =
            steel_state_.save_enabled &&
            steel_state_.present &&
            job.production_save_generation == production_save_generation_;
      }
      if (!still_armed_for_save) {
        pending.record_capture = false;
        result.discarded = true;
        result.discard_reason = "save-disabled-before-storage";
        result.depth_persistence_mode = "discarded-live-frame";
        result.output.clear();
        result.depth_output.clear();
        result.intensity_output.clear();
        depth_source = OwnedImageSource{};
        intensity_source = OwnedImageSource{};
      }
    }

    if (job.persist_frame && ret == CORRECT && depth_source.available() && intensity_source.available()) {
      FrameWriteRequest request;
      request.paths = paths;
      request.depth = std::move(depth_source);
      request.intensity = std::move(intensity_source);
      request.pending_bytes = saturating_size_add(
          request.depth.accounted_bytes, request.intensity.accounted_bytes);
      {
        std::lock_guard<std::mutex> lock(mutex_);
        CameraSession* session = session_for_ip_locked(job.ip);
        if (!session) {
          ret = DEV_NOT_LINK_ERROR;
        } else {
          request.metadata = capture_metadata_snapshot_locked(
              *session,
              CORRECT,
              attempts,
              capture_width,
              job.lines,
              actual_width,
              actual_lines,
              job.data_mode,
              job.timeout_ms,
              fid,
              sid,
              lost_lines,
              trigger_min_interval,
              trigger_max_interval,
              frame_timestamp,
              false);
          request.metadata.depth_data_format = depth_data_format;
          request.metadata.depth_persistence_mode = depth_persistence_mode;
        }
      }
      if (ret == CORRECT) {
        pending.storage = enqueue_frame_write(std::move(request));
        pending.has_storage = true;
        result.storage_async = true;
        result.storage_ticket_id = pending.storage.id;
        result.storage_queued_at = pending.storage.result->queued_at;
        result.storage_queued_tick_ms = pending.storage.result->queued_tick_ms;
      }
    }

    if (!pending.has_storage && job.persist_frame) {
      cleanup_sdk_outputs(paths);
    }
    result.code = ret;
    if (!pending.has_storage) {
      result.worker_finished_at = now_iso();
    }
    return pending;
  }

  bool pending_capture_ready(const PendingParallelCapture& pending) const {
    return !pending.has_storage || pending.storage.ready();
  }

  void record_continuous_capture_completion_locked(
      CameraSession& session, const ParallelCaptureResult& result) {
    constexpr size_t kContinuousFpsWindow = 20;
    ContinuousCaptureState& state = session.continuous;
    ++state.finalized_count;
    state.last_result_code = result.code;

    // A frame must have reached the SDK result path before it contributes to
    // the per-camera depth-map cadence.  This runs before the storage ticket
    // is finalized, so a slow disk cannot make the live acquisition FPS look
    // stalled.  Storage outcomes remain visible through the regular capture
    // result and production counters.
    const bool received_frame = result.capture_finished_tick_ms != 0 &&
        (result.simulated || result.discarded || result.depth_data_format >= 0);
    if (!received_frame) {
      return;
    }

    ++state.frame_count;
    if (result.code == CORRECT) {
      ++state.successful_frame_count;
    }
    const unsigned long long tick = result.capture_finished_tick_ms;
    if (state.frame_ticks.empty() || tick >= state.frame_ticks.back()) {
      state.frame_ticks.push_back(tick);
    } else {
      // A storage completion can be delayed.  Preserve a monotonic window so
      // the reported rolling FPS never becomes negative or nonsensical.
      state.frame_ticks.push_back(state.frame_ticks.back());
    }
    while (state.frame_ticks.size() > kContinuousFpsWindow) {
      state.frame_ticks.pop_front();
    }
    state.last_frame_tick_ms = state.frame_ticks.back();
    state.last_frame_at = result.capture_finished_at.empty()
        ? result.worker_finished_at
        : result.capture_finished_at;
  }

  ParallelCaptureResult finalize_pending_capture(PendingParallelCapture&& pending) {
    ParallelCaptureResult result = std::move(pending.result);
    if (pending.has_storage) {
      const FrameWriteResult write_result = finish_frame_write(pending.storage);
      result.code = write_result.code;
      result.storage_ticket_id = write_result.ticket_id;
      result.storage_queued_at = write_result.queued_at;
      result.storage_started_at = write_result.storage_started_at;
      result.storage_finished_at = write_result.storage_finished_at;
      result.storage_queued_tick_ms = write_result.queued_tick_ms;
      result.storage_started_tick_ms = write_result.storage_started_tick_ms;
      result.storage_finished_tick_ms = write_result.storage_finished_tick_ms;
      result.depth_data_format = write_result.depth_data_format;
      result.depth_persistence_mode = write_result.depth_persistence_mode;
      result.depth_exists = write_result.depth_exists;
      result.intensity_exists = write_result.intensity_exists;
      result.metadata_exists = write_result.metadata_exists;
      result.complete_frame = write_result.complete_frame;
      result.depth_output = write_result.depth_exists ? write_result.depth_path : result.depth_output;
      result.output = result.depth_output;
      result.intensity_output = write_result.intensity_exists ? write_result.intensity_path : "";
      result.metadata_output = write_result.metadata_exists ? write_result.metadata_path : "";
      if (result.code != CORRECT && result.error_message.empty()) {
        result.error_message = "frame storage transaction failed";
      }
    }

    if (pending.record_capture && pending.track_continuous_acquisition) {
      bool still_armed_for_save = false;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        still_armed_for_save =
            steel_state_.save_enabled &&
            steel_state_.present &&
            pending.production_save_generation == production_save_generation_;
        if (!still_armed_for_save) {
          ++continuous_discarded_frame_count_;
        }
      }
      if (!still_armed_for_save) {
        for (const std::string* path : {
                 &result.depth_output,
                 &result.intensity_output,
                 &result.metadata_output,
                 &result.sdk_output,
                 &result.sdk_depth_output,
                 &result.sdk_intensity_output}) {
          if (!path->empty()) {
            std::error_code remove_error;
            std::filesystem::remove(*path, remove_error);
          }
        }
        pending.record_capture = false;
        result.discarded = true;
        result.discard_reason = "save-disabled-before-finalize";
        result.depth_persistence_mode = "discarded-live-frame";
        result.output.clear();
        result.depth_output.clear();
        result.intensity_output.clear();
        result.metadata_output.clear();
        result.sdk_output.clear();
        result.sdk_depth_output.clear();
        result.sdk_intensity_output.clear();
        result.depth_exists = false;
        result.intensity_exists = false;
        result.metadata_exists = false;
        result.complete_frame = false;
      }
    }

    if (!result.sdk_output.empty() && !file_exists(result.sdk_output)) {
      result.sdk_output.clear();
    }
    if (!result.sdk_depth_output.empty() && !file_exists(result.sdk_depth_output)) {
      result.sdk_depth_output.clear();
    }
    if (!result.sdk_intensity_output.empty() && !file_exists(result.sdk_intensity_output)) {
      result.sdk_intensity_output.clear();
    }
    result.worker_finished_at = now_iso();

    if (pending.record_capture) {
      std::lock_guard<std::mutex> lock(mutex_);
      CameraSession* session = session_for_ip_locked(result.ip);
      if (session) {
        session->calibration.validation_path = result.depth_output;
        session->calibration.validation_code = result.code;
        session->calibration.validation_time = result.worker_finished_at;
      }
      record_steel_capture_locked(result.ip, result.depth_output, result.code);
    }
    return result;
  }

  std::vector<PendingParallelCapture> run_parallel_capture_round(
      std::vector<ParallelCaptureJob> jobs,
      int worker_timeout_ms,
      const std::string& timeout_message) {
    auto round_jobs = std::make_shared<std::vector<ParallelCaptureJob>>(std::move(jobs));
    auto round_results = std::make_shared<std::vector<PendingParallelCapture>>(round_jobs->size());
    auto done_flags = std::make_shared<std::vector<std::shared_ptr<std::atomic_bool>>>();
    auto abandon_flags = std::make_shared<std::vector<std::shared_ptr<std::atomic_bool>>>();
    auto result_mutexes = std::make_shared<std::vector<std::shared_ptr<std::mutex>>>();
    auto sdk_worker_flags = std::make_shared<std::vector<bool>>(
        round_jobs->size(), false);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      for (size_t index = 0; index < round_jobs->size(); ++index) {
        CameraSession* session = session_for_ip_locked((*round_jobs)[index].ip);
        (*sdk_worker_flags)[index] = session && session->device && !session->simulated;
      }
    }
    done_flags->reserve(round_jobs->size());
    abandon_flags->reserve(round_jobs->size());
    result_mutexes->reserve(round_jobs->size());
    for (size_t index = 0; index < round_jobs->size(); ++index) {
      done_flags->push_back(std::make_shared<std::atomic_bool>(false));
      abandon_flags->push_back(std::make_shared<std::atomic_bool>(false));
      result_mutexes->push_back(std::make_shared<std::mutex>());
    }

    std::vector<std::thread> workers;
    workers.reserve(round_jobs->size());
    auto start_gate = std::make_shared<ParallelCaptureStartGate>();
    for (size_t index = 0; index < round_jobs->size(); ++index) {
      workers.emplace_back([this,
                            round_jobs,
                            round_results,
                            done_flags,
                            abandon_flags,
                            result_mutexes,
                            start_gate,
                            index]() {
        PendingParallelCapture worker_result;
        try {
          {
            std::unique_lock<std::mutex> start_lock(start_gate->mutex);
            ++start_gate->ready_count;
            // The same condition variable also releases workers once every
            // worker is ready. Wake all waiters here: notify_one can select a
            // worker that is waiting for `start` instead of the coordinator,
            // leaving the coordinator asleep even after ready_count reaches
            // the target.
            start_gate->ready.notify_all();
            start_gate->ready.wait(start_lock, [start_gate]() { return start_gate->start; });
          }
          worker_result = run_parallel_capture_job((*round_jobs)[index]);
        } catch (const std::exception& error) {
          worker_result = PendingParallelCapture(
              parallel_capture_error((*round_jobs)[index], 500, error.what()));
        } catch (...) {
          worker_result = PendingParallelCapture(
              parallel_capture_error((*round_jobs)[index], 500, "capture worker failed"));
        }
        if (worker_result.track_continuous_acquisition) {
          std::lock_guard<std::mutex> lock(mutex_);
          ++continuous_acquisition_frame_count_;
          if (worker_result.result.discarded) {
            ++continuous_discarded_frame_count_;
          }
          last_continuous_acquisition_at_ =
              worker_result.result.capture_finished_at.empty()
                  ? worker_result.result.worker_finished_at
                  : worker_result.result.capture_finished_at;
          CameraSession* session =
              session_for_ip_locked(worker_result.result.ip);
          if (session) {
            record_continuous_capture_completion_locked(
                *session, worker_result.result);
          }
        }
        {
          std::lock_guard<std::mutex> result_lock(*(*result_mutexes)[index]);
          if (!(*abandon_flags)[index]->load()) {
            (*round_results)[index] = std::move(worker_result);
          }
        }
        (*done_flags)[index]->store(true);
      });
    }

    {
      std::unique_lock<std::mutex> start_lock(start_gate->mutex);
      start_gate->ready.wait(start_lock, [&]() {
        return start_gate->ready_count == round_jobs->size();
      });
      const std::string round_started_at = now_iso();
      for (auto& job : *round_jobs) {
        job.round_started_at = round_started_at;
      }
      start_gate->start = true;
    }
    start_gate->ready.notify_all();

    const auto worker_deadline =
        std::chrono::steady_clock::now() + std::chrono::milliseconds(worker_timeout_ms);
    for (;;) {
      bool all_done = true;
      for (const auto& done : *done_flags) {
        if (!done->load()) {
          all_done = false;
          break;
        }
      }
      if (all_done || std::chrono::steady_clock::now() >= worker_deadline) {
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(25));
    }

    for (size_t index = 0; index < workers.size(); ++index) {
      if ((*done_flags)[index]->load()) {
        if (workers[index].joinable()) {
          workers[index].join();
        }
        continue;
      }
      (*abandon_flags)[index]->store(true);
      {
        std::lock_guard<std::mutex> result_lock(*(*result_mutexes)[index]);
        (*round_results)[index] = PendingParallelCapture(
            parallel_capture_error((*round_jobs)[index], 504, timeout_message));
      }
      if (workers[index].joinable()) {
        if ((*done_flags)[index]->load(std::memory_order_acquire)) {
          workers[index].join();
          continue;
        }
        const bool sdk_worker = (*sdk_worker_flags)[index];
        if (!owned_capture_workers_.adopt(
                workers[index], (*done_flags)[index], sdk_worker)) {
          worker_ownership_exhausted();
        }
        if (sdk_worker) {
          poison_sdk_capture(timeout_message);
        }
      }
    }

    std::vector<PendingParallelCapture> results;
    results.reserve(round_results->size());
    for (auto& result : *round_results) {
      results.push_back(std::move(result));
    }
    return results;
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
    bool steel_state_aware = json_bool_field(body, "steelStateAware", false) ||
                             json_bool_field(body, "requireSteelPresent", false);
    bool require_steel_present = json_bool_field(body, "requireSteelPresent", false);
    bool discard_black_frames = json_bool_field(body, "discardBlackFrames", true);
    bool save_sdk_derived = json_bool_field(body, "saveSdkDerived", json_bool_field(body, "save_sdk_derived", false));
    double black_frame_threshold = json_float_field(body, "blackFrameThreshold", 8.0f);
    int worker_timeout_ms = json_int_field(body, "workerTimeoutMs", json_int_field(body, "worker_timeout_ms", 0));
    if (worker_timeout_ms <= 0) {
      worker_timeout_ms = timeout_ms * (retries + 1) + 5000;
    }
    worker_timeout_ms = std::max(1000, std::min(600000, worker_timeout_ms));
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
    if (steel_state_aware) {
      std::lock_guard<std::mutex> lock(mutex_);
      discard_black_frames = json_bool_field(body, "discardBlackFrames", steel_state_.discard_black_frames);
      black_frame_threshold = json_float_field(body, "blackFrameThreshold", static_cast<float>(steel_state_.black_frame_threshold));
      if ((require_steel_present && !steel_state_.present) || !steel_state_.save_enabled) {
        ++steel_state_.discard_frame_count;
        steel_state_.updated_at = now_iso();
        write_steel_summary_locked();
        return json_error(CAPTURE_DISCARDED_NOT_ARMED, "production capture is not armed for saving");
      }
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
    int discarded_frames = 0;
    int black_frames = 0;
    int storage_async_frames = 0;
    int overlapped_rounds = 0;
    int first_error = CORRECT;
    std::ostringstream results;
    results << "[";
    int result_count = 0;
    const std::string started_at = now_iso();
    const auto started_clock = std::chrono::steady_clock::now();
    std::deque<PendingParallelCapture> pending_tickets;
    std::vector<ParallelCaptureResult> completed_results;
    completed_results.reserve(static_cast<size_t>(rounds) * ips.size());

    auto finalize_front = [&]() {
      completed_results.push_back(finalize_pending_capture(std::move(pending_tickets.front())));
      pending_tickets.pop_front();
    };
    auto reap_ready = [&]() {
      while (!pending_tickets.empty() && pending_capture_ready(pending_tickets.front())) {
        finalize_front();
      }
    };

    for (int round = 1; round <= rounds; ++round) {
      if (sdk_capture_restart_required()) {
        break;
      }
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
        const int sequence_number = production_layout ? round : attempt_number;
        if (production_layout) {
          std::lock_guard<std::mutex> lock(mutex_);
          job.output = raw_capture_output_locked(ip, material_id, sequence_number);
        } else {
          job.output = (std::filesystem::path(output_dir) / safe_path_segment(ip) / filename.str()).lexically_normal().string();
        }
        job.round = round;
        job.attempt = sequence_number;
        job.parallel_index = static_cast<int>(index);
        job.lines = lines;
        job.width = width;
        job.timeout_ms = timeout_ms;
        job.data_mode = data_mode;
        job.retries = retries;
        job.control_mode = control_mode;
        job.discard_black_frames = discard_black_frames;
        job.save_sdk_derived = save_sdk_derived;
        job.black_frame_threshold = black_frame_threshold;
        jobs.push_back(job);
      }

      std::vector<PendingParallelCapture> round_pending = run_parallel_capture_round(
          std::move(jobs), worker_timeout_ms, "capture worker exceeded hard timeout");
      reap_ready();
      for (auto& pending : round_pending) {
        while (pending_tickets.size() >= storage_pending_ticket_limit_) {
          finalize_front();
        }
        pending_tickets.push_back(std::move(pending));
        reap_ready();
      }

      if (round < rounds && interval_ms > 0) {
        std::this_thread::sleep_for(std::chrono::milliseconds(interval_ms));
      }
    }

    while (!pending_tickets.empty()) {
      finalize_front();
    }
    std::map<int, unsigned long long> round_capture_min_tick;
    std::map<int, unsigned long long> round_storage_max_tick;
    for (const ParallelCaptureResult& capture : completed_results) {
      ++attempts;
      const int ret = capture.code;
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
      if (capture.discarded) {
        ++discarded_frames;
      }
      if (capture.discard_reason == "black-frame") {
        ++black_frames;
      }
      if (capture.storage_async) {
        ++storage_async_frames;
      }
      if (capture.capture_finished_tick_ms > 0) {
        auto found = round_capture_min_tick.find(capture.round);
        if (found == round_capture_min_tick.end()) {
          round_capture_min_tick[capture.round] = capture.capture_finished_tick_ms;
        } else {
          found->second = std::min(found->second, capture.capture_finished_tick_ms);
        }
      }
      if (capture.storage_finished_tick_ms > 0) {
        round_storage_max_tick[capture.round] = std::max(
            round_storage_max_tick[capture.round], capture.storage_finished_tick_ms);
      }
      if (result_count > 0) {
        results << ",";
      }
      results << parallel_capture_result_json(capture);
      ++result_count;
    }
    for (int round = 2; round <= rounds; ++round) {
      auto current_capture = round_capture_min_tick.find(round);
      auto previous_storage = round_storage_max_tick.find(round - 1);
      if (current_capture != round_capture_min_tick.end() &&
          previous_storage != round_storage_max_tick.end() &&
          current_capture->second < previous_storage->second) {
        ++overlapped_rounds;
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
         << ",\"discardedFrames\":" << discarded_frames
         << ",\"blackFrames\":" << black_frames
         << ",\"rounds\":" << rounds
         << ",\"retries\":" << retries
         << ",\"cameraCount\":" << ips.size()
         << ",\"expectedCameras\":" << expected_cameras
         << ",\"expectedMet\":" << (expected_met ? "true" : "false")
         << ",\"connectFirst\":" << (connect_first ? "true" : "false")
         << ",\"parallel\":true"
         << ",\"saveSdkDerived\":" << (save_sdk_derived ? "true" : "false")
         << ",\"workerCount\":" << ips.size()
         << ",\"roundIntervalMs\":" << interval_ms
         << ",\"workerTimeoutMs\":" << worker_timeout_ms
         << ",\"storageAsyncFrames\":" << storage_async_frames
         << ",\"storagePendingTicketLimit\":" << storage_pending_ticket_limit_
         << ",\"captureStorageOverlappedRounds\":" << overlapped_rounds
         << ",\"frameTransaction\":true"
         << ",\"metadataCommitLast\":true"
         << ",\"elapsedMs\":" << elapsed_ms
         << "," << json_pair("syncMode", "round-start-condition-variable+storage-ticket-pipeline")
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
    std::vector<std::filesystem::path> allowed_roots;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      allowed_roots.push_back(storage_root_);
      for (const auto& item : camera_storage_roots_) {
        allowed_roots.push_back(item.second);
      }
    }
    std::filesystem::path resolved;
    if (!steel_capture::resolve_allowed_regular_file(
            std::filesystem::path(path), allowed_roots, resolved)) {
      return {403, "", "image/png"};
    }

    std::string region;
    const UniqueQueryParamState region_state =
        get_unique_query_param(query, "region", region);
    if (region_state == UniqueQueryParamState::Invalid ||
        (region_state == UniqueQueryParamState::Present &&
         region != "raw" && region != "valid")) {
      return {422, json_error(422, "capture_valid_region_not_ready")};
    }
    if (region_state == UniqueQueryParamState::Present && region == "valid") {
      std::uint64_t crop_x = 0;
      std::uint64_t crop_y = 0;
      std::uint64_t crop_width = 0;
      std::uint64_t crop_height = 0;
      std::uint32_t image_width = 0;
      std::uint32_t image_height = 0;
      const bool crop_syntax_valid =
          parse_unique_unsigned_query_param(query, "cropX", crop_x) &&
          parse_unique_unsigned_query_param(query, "cropY", crop_y) &&
          parse_unique_unsigned_query_param(query, "cropWidth", crop_width) &&
          parse_unique_unsigned_query_param(query, "cropHeight", crop_height) &&
          crop_width > 0 && crop_height > 0;
      const bool image_header_valid =
          crop_syntax_valid &&
          read_png_dimensions(resolved, image_width, image_height);
      const bool crop_bounds_valid =
          image_header_valid && crop_x < image_width && crop_y < image_height &&
          crop_width <= static_cast<std::uint64_t>(image_width) - crop_x &&
          crop_height <= static_cast<std::uint64_t>(image_height) - crop_y;
      // This provider currently has no safe decoder/encoder. Keep valid-region
      // requests fail-closed even after validating PNG bounds; returning source
      // bytes here would silently expose the uncropped acquisition frame.
      (void)crop_bounds_valid;
      return {422, json_error(422, "capture_valid_region_not_ready")};
    }
    std::string body;
    if (!read_file(resolved.string(), body)) {
      return {404, "", "image/png"};
    }
    std::string extension = resolved.extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(),
                   [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    return {200,
            body,
            extension == ".json" ? "application/json; charset=utf-8" : "image/png"};
  }

  struct LatestCaptureFile {
    std::filesystem::path path;
    std::filesystem::file_time_type write_time{};
    bool found = false;
  };

  std::string normalize_capture_kind(std::string kind) const {
    std::transform(kind.begin(), kind.end(), kind.begin(), [](unsigned char ch) {
      return static_cast<char>(std::tolower(ch));
    });
    if (kind == "brightness" || kind == "gray" || kind == "grey") {
      return "intensity";
    }
    if (kind == "meta") {
      return "metadata";
    }
    if (kind == "sdk" || kind == "sdk_depth" || kind == "sdk-depth") {
      return "sdk-derived";
    }
    if (kind == "intensity" || kind == "metadata" || kind == "sdk-derived") {
      return kind;
    }
    return "depth";
  }

  LatestCaptureFile find_latest_capture_file_locked(const std::string& ip, const std::string& kind) const {
    LatestCaptureFile latest;
    std::filesystem::path root = ip.empty() ? storage_root_ : camera_capture_root_locked(ip);
    std::error_code error;
    if (!std::filesystem::exists(root, error)) {
      return latest;
    }
    const std::string data_dir = normalize_capture_kind(kind);
    const std::string expected_extension = data_dir == "metadata" ? ".json" : ".png";
    for (const auto& entry : std::filesystem::recursive_directory_iterator(root, std::filesystem::directory_options::skip_permission_denied, error)) {
      if (error) {
        error.clear();
        continue;
      }
      if (!entry.is_regular_file(error)) {
        error.clear();
        continue;
      }
      const std::filesystem::path path = entry.path();
      if (path.parent_path().filename().string() != data_dir) {
        continue;
      }
      std::string extension = path.extension().string();
      std::transform(extension.begin(), extension.end(), extension.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
      });
      if (extension != expected_extension) {
        continue;
      }
      std::filesystem::file_time_type write_time = entry.last_write_time(error);
      if (error) {
        error.clear();
        continue;
      }
      if (!latest.found || write_time > latest.write_time) {
        latest.path = path.lexically_normal();
        latest.write_time = write_time;
        latest.found = true;
      }
    }
    return latest;
  }

  RouteResult capture_latest_response(const std::string& query) {
    std::string ip = get_query_param(query, "ip");
    std::string kind = normalize_capture_kind(get_query_param(query, "kind"));
    const std::string meta = get_query_param(query, "meta");
    const bool metadata_response = meta == "1" || meta == "true" || meta == "yes";
    std::filesystem::path path;
    std::vector<std::filesystem::path> allowed_roots;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      LatestCaptureFile latest = find_latest_capture_file_locked(ip, kind);
      if (!latest.found) {
        return {404, json_error(404, "latest capture file not found")};
      }
      path = latest.path;
      allowed_roots.push_back(storage_root_);
      for (const auto& item : camera_storage_roots_) {
        allowed_roots.push_back(item.second);
      }
    }
    std::filesystem::path resolved;
    if (!steel_capture::resolve_allowed_regular_file(path, allowed_roots, resolved)) {
      return {403, json_error(403, "latest capture file is outside allowed storage roots")};
    }
    path = resolved;
    if (metadata_response) {
      std::ostringstream json;
      json << "{\"code\":0,"
           << json_pair("ip", ip) << ","
           << json_pair("kind", kind) << ","
           << json_pair("path", path.string()) << ","
           << json_pair("url", "/api/capture/file?path=" + url_encode(path.string()))
           << "}";
      return {200, json.str()};
    }
    std::string body;
    if (!read_file(path.string(), body)) {
      return {404, "", kind == "metadata" ? "application/json; charset=utf-8" : "image/png"};
    }
    return {200, body, kind == "metadata" ? "application/json; charset=utf-8" : "image/png"};
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
         << "\"fps\":" << stream_fps_for_session_locked(&session) << ","
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
         << json_pair("latestDepthUrl", stream.latest_depth_path.empty() ? "" : "/api/stream/latest?kind=depth&ip=" + url_encode(session.ip) + "&region=valid") << ","
         << json_pair("latestIntensityUrl", stream.latest_intensity_path.empty() ? "" : "/api/stream/latest?kind=intensity&ip=" + url_encode(session.ip) + "&region=valid")
         << "}";
    return json.str();
  }

  RouteResult stream_latest_response(const std::string& query) {
    std::string region;
    const UniqueQueryParamState region_state =
        get_unique_query_param(query, "region", region);
    if (region_state == UniqueQueryParamState::Invalid ||
        (region_state == UniqueQueryParamState::Present &&
         region != "raw" && region != "valid")) {
      return {422, json_error(422, "capture_valid_region_not_ready")};
    }
    if (region_state == UniqueQueryParamState::Present && region == "valid") {
      // The stream cache contains only the source PNG. Never ignore the region
      // contract and fall back to that uncropped frame.
      return {422, json_error(422, "capture_valid_region_not_ready")};
    }
    std::string ip = get_query_param(query, "ip");
    std::string kind = get_query_param(query, "kind");
    if (kind.empty()) {
      kind = "depth";
    }
    std::string path;
    std::vector<std::filesystem::path> allowed_roots;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      CameraSession* session = session_for_ip_locked(ip);
      if (!session || (!session->device && !session->simulated)) {
        return {404, "", "image/png"};
      }
      if (session->simulated && session->stream.running) {
        update_simulated_stream_frame_locked(*session);
      }
      path = kind == "intensity" ? session->stream.latest_intensity_path
                                  : session->stream.latest_depth_path;
      allowed_roots.push_back(storage_root_);
      for (const auto& item : camera_storage_roots_) {
        allowed_roots.push_back(item.second);
      }
    }
    std::filesystem::path resolved;
    if (!steel_capture::resolve_allowed_regular_file(
            std::filesystem::path(path), allowed_roots, resolved)) {
      return {404, "", "image/png"};
    }
    std::string body;
    if (!read_file(resolved.string(), body)) {
      return {404, "", "image/png"};
    }
    return {200, body, "image/png"};
  }

  CalibrationArtifactResolution resolve_calibration_artifact_locked(
      const std::string& path_text,
      bool allow_external,
      bool expect_array) const {
    CalibrationArtifactResolution result;
    if (path_text.empty()) {
      result.code = 400;
      result.message = "missing calibration path";
      return result;
    }
    const std::filesystem::path candidate = config_or_storage_path_locked(path_text);
    std::filesystem::path resolved;
    if (allow_external) {
      std::error_code error;
      resolved = std::filesystem::canonical(candidate, error);
      if (error || !std::filesystem::is_regular_file(resolved, error) || error) {
        result.code = 404;
        result.message = "calibration file not found or not a regular file";
        return result;
      }
    } else {
      const std::vector<std::filesystem::path> roots{storage_root_, config_root_};
      if (!steel_capture::resolve_allowed_regular_file(candidate, roots, resolved)) {
        result.code = 403;
        result.message = "calibration file must resolve under storage/config roots";
        return result;
      }
    }
    result.path = resolved;
    result.kind = steel_capture::classify_calibration_artifact(resolved);
    const bool kind_matches = expect_array
                                  ? steel_capture::is_array_reconstruction_artifact(result.kind)
                                  : steel_capture::is_camera_sdk_candidate(result.kind);
    if (!kind_matches) {
      result.code = CALIBRATION_ARTIFACT_KIND_MISMATCH;
      result.message = expect_array
                           ? "active calibration must be an array reconstruction XML"
                           : "per-camera SDK calibration mapping cannot use array reconstruction XML";
    }
    return result;
  }

  bool calibration_file_fingerprint(
      const std::filesystem::path& path,
      std::string& hash,
      std::uintmax_t& size) const {
    return sha256_file(path, hash, size);
  }

  std::filesystem::path calibration_maintenance_record_path_locked() const {
    return (storage_root_ / "maintenance" / "calibration-records.jsonl")
        .lexically_normal();
  }

  void append_calibration_maintenance_record_locked(
      const std::string& action,
      const CameraSession& session,
      const std::string& artifact_path,
      int code,
      const std::string& rollback_token = "",
      const std::string& operation_id = "") const {
    const std::filesystem::path record_path =
        calibration_maintenance_record_path_locked();
    std::error_code error;
    std::filesystem::create_directories(record_path.parent_path(), error);
    if (error) {
      return;
    }
    std::ofstream output(record_path, std::ios::binary | std::ios::app);
    if (!output) {
      return;
    }
    output << "{\"schema\":\"steel.capture.calibration-maintenance.v1\","
           << json_pair("recordedAt", now_iso()) << ","
           << json_pair("action", action) << ","
           << json_pair("ip", session.ip) << ","
           << json_pair("sn", session.sn) << ","
           << json_pair("path", artifact_path) << ","
           << json_pair("rollbackToken", rollback_token) << ","
           << json_pair("operationId", operation_id) << ","
           << "\"code\":" << code << "}\n";
  }

  std::filesystem::path calibration_rollback_root_locked() const {
    return (config_root_locked() / "calibration-rollbacks").lexically_normal();
  }

  std::string calibration_rollback_manifest_json_locked(
      const CalibrationRollbackRecord& record) const {
    std::ostringstream cameras;
    cameras << "[";
    for (size_t index = 0; index < record.cameras.size(); ++index) {
      if (index > 0) cameras << ",";
      const CalibrationCameraSnapshot& snapshot = record.cameras[index];
      cameras
          << "{" << json_pair("ip", snapshot.ip) << ","
          << json_pair("sn", snapshot.expected_sn) << ","
          << json_pair("sourceRollbackPath", snapshot.source_rollback_path.string()) << ","
          << json_pair("stagedPreviousPath", snapshot.rollback_path.string()) << ","
          << json_pair("sha256", snapshot.rollback_file_hash) << ","
          << "\"size\":" << snapshot.rollback_file_size << ","
          << json_pair("appliedPath", snapshot.applied_path.string()) << ","
          << "\"attempted\":" << (snapshot.attempted ? "true" : "false") << ","
          << "\"saveToDevice\":" << (snapshot.save_to_device ? "true" : "false") << ","
          << "\"simulated\":" << (snapshot.simulated ? "true" : "false") << ","
          << json_pair("previousCalibrationPath", snapshot.previous_state.calibration_path) << ","
          << json_pair("previousArtifactKind", snapshot.previous_state.calibration_artifact_kind) << ","
          << "\"previousCalibrationCode\":" << snapshot.previous_state.calibration_code << ","
          << json_pair("previousCalibrationTime", snapshot.previous_state.calibration_time) << ","
          << json_pair("previousOperationId", snapshot.previous_state.operation_id) << ","
          << json_pair("previousRollbackToken", snapshot.previous_state.rollback_token) << ","
          << json_pair("previousRollbackMode", snapshot.previous_state.rollback_mode) << ","
          << "\"previousRollbackCode\":" << snapshot.previous_state.rollback_code << ","
          << json_pair("previousRollbackTime", snapshot.previous_state.rollback_time)
          << "}";
    }
    cameras << "]";

    std::ostringstream manifest;
    manifest
        << "{\"schema\":\"steel.capture.calibration-rollback-manifest.v1\","
        << json_pair("token", record.token) << ","
        << json_pair("operationId", record.operation_id) << ","
        << json_pair("createdAt", record.created_at) << ","
        << json_pair("phase", record.phase) << ","
        << "\"durable\":" << (record.durable ? "true" : "false") << ","
        << "\"consumed\":" << (record.consumed ? "true" : "false") << ","
        << "\"saveToDevice\":" << (record.save_to_device ? "true" : "false") << ","
        << json_pair("profileName", record.profile_name) << ","
        << json_pair("profilePath", record.profile_path.string()) << ","
        << json_pair("profileBefore", record.profile_before) << ","
        << "\"profileChanged\":" << (record.profile_changed ? "true" : "false") << ","
        << "\"cameras\":" << cameras.str()
        << "}";
    return manifest.str();
  }

  bool persist_calibration_rollback_manifest_locked(
      CalibrationRollbackRecord& record) const {
    if (record.manifest_path.empty()) {
      return false;
    }
    return write_durable_text_file(
        record.manifest_path,
        calibration_rollback_manifest_json_locked(record));
  }

  void cleanup_calibration_rollback_record_dir_locked(
      const std::filesystem::path& directory) const {
    if (directory.empty() ||
        !is_path_under_base(directory.string(),
                            calibration_rollback_root_locked())) {
      return;
    }
    std::error_code error;
    for (std::filesystem::recursive_directory_iterator iterator(directory, error), end;
         !error && iterator != end; iterator.increment(error)) {
      if (iterator->is_regular_file(error)) {
        const std::wstring native = iterator->path().wstring();
        const DWORD attributes = GetFileAttributesW(native.c_str());
        if (attributes != INVALID_FILE_ATTRIBUTES) {
          SetFileAttributesW(native.c_str(), attributes & ~FILE_ATTRIBUTE_READONLY);
        }
      }
    }
    error.clear();
    std::filesystem::remove_all(directory, error);
  }

  bool stage_calibration_rollback_record_locked(
      CalibrationRollbackRecord& record,
      std::string& error_message) const {
    const std::string operation_segment = safe_path_segment(
        record.operation_id.empty() ? "provider-direct" : record.operation_id);
    record.record_dir = (calibration_rollback_root_locked() / record.token /
                         operation_segment).lexically_normal();
    record.manifest_path = (record.record_dir / "manifest.json").lexically_normal();
    std::error_code error;
    if (std::filesystem::exists(record.record_dir, error) || error) {
      error_message = "rollback staging directory already exists";
      return false;
    }
    std::filesystem::create_directories(record.record_dir / "previous", error);
    if (error) {
      error_message = "cannot create rollback staging directory";
      return false;
    }

    bool all_attempted_cameras_recoverable = true;
    for (size_t index = 0; index < record.cameras.size(); ++index) {
      CalibrationCameraSnapshot& snapshot = record.cameras[index];
      snapshot.source_rollback_path = snapshot.rollback_path;
      if (snapshot.source_rollback_path.empty()) {
        all_attempted_cameras_recoverable = false;
        continue;
      }

      std::string contents;
      if (!read_file(snapshot.source_rollback_path.string(), contents)) {
        error_message = "cannot read rollbackPath while staging previous calibration";
        cleanup_calibration_rollback_record_dir_locked(record.record_dir);
        return false;
      }
      std::ostringstream filename;
      filename << std::setw(2) << std::setfill('0') << (index + 1)
               << "-" << safe_path_segment(snapshot.ip) << ".xml";
      const std::filesystem::path staged =
          (record.record_dir / "previous" / filename.str()).lexically_normal();
      if (!write_durable_text_file(staged, contents)) {
        error_message = "cannot atomically stage previous calibration file";
        cleanup_calibration_rollback_record_dir_locked(record.record_dir);
        return false;
      }
      std::string staged_hash;
      std::uintmax_t staged_size = 0;
      if (!calibration_file_fingerprint(staged, staged_hash, staged_size) ||
          staged_hash != snapshot.rollback_file_hash ||
          staged_size != snapshot.rollback_file_size) {
        error_message = "staged previous calibration fingerprint mismatch";
        cleanup_calibration_rollback_record_dir_locked(record.record_dir);
        return false;
      }
      if (!mark_file_read_only(staged)) {
        error_message = "cannot mark staged previous calibration immutable";
        cleanup_calibration_rollback_record_dir_locked(record.record_dir);
        return false;
      }
      snapshot.rollback_path = staged;
      snapshot.rollback_file_hash = staged_hash;
      snapshot.rollback_file_size = staged_size;
      snapshot.has_rollback_fingerprint = true;
    }

    record.phase = "prepared";
    record.durable = all_attempted_cameras_recoverable;
    if (!persist_calibration_rollback_manifest_locked(record)) {
      error_message = "cannot atomically persist rollback manifest";
      cleanup_calibration_rollback_record_dir_locked(record.record_dir);
      return false;
    }
    return true;
  }

  bool parse_calibration_rollback_manifest_locked(
      const std::filesystem::path& manifest_path,
      CalibrationRollbackRecord& record) const {
    std::string manifest;
    if (!read_file(manifest_path.string(), manifest) ||
        json_string_field(manifest, "schema") !=
            "steel.capture.calibration-rollback-manifest.v1") {
      return false;
    }
    record.token = json_string_field(manifest, "token");
    record.operation_id = json_string_field(manifest, "operationId");
    record.created_at = json_string_field(manifest, "createdAt");
    record.phase = json_string_field(manifest, "phase");
    record.durable = json_bool_field(manifest, "durable", false);
    record.consumed = json_bool_field(manifest, "consumed", false);
    record.save_to_device = json_bool_field(manifest, "saveToDevice", false);
    record.profile_name = json_string_field(manifest, "profileName");
    record.profile_path = path_from_json_text(json_string_field(manifest, "profilePath"));
    record.profile_before = json_string_field(manifest, "profileBefore");
    record.profile_changed = json_bool_field(manifest, "profileChanged", false);
    record.record_dir = manifest_path.parent_path().lexically_normal();
    record.manifest_path = manifest_path.lexically_normal();
    const std::vector<std::string> valid_phases{
        "prepared", "applying", "applied", "rolling-back",
        "rolled-back", "rollback-failed"};
    const std::string expected_operation_segment = safe_path_segment(
        record.operation_id.empty() ? "provider-direct" : record.operation_id);
    if (!is_valid_operation_id(record.token) || record.created_at.empty() ||
        std::find(valid_phases.begin(), valid_phases.end(), record.phase) ==
            valid_phases.end() ||
        (!record.operation_id.empty() && !is_valid_operation_id(record.operation_id)) ||
        !is_path_under_base(record.record_dir.string(),
                            calibration_rollback_root_locked()) ||
        record.record_dir.filename().string() != expected_operation_segment ||
        record.record_dir.parent_path().filename().string() != record.token ||
        (record.phase == "rolled-back" && !record.consumed) ||
        (record.consumed && record.phase != "rolled-back") ||
        (record.profile_changed &&
         (record.profile_path.empty() ||
          !is_path_under_base(record.profile_path.string(), config_root_locked())))) {
      return false;
    }

    std::map<std::string, bool> camera_ips;
    for (const std::string& camera :
         json_object_array_field(manifest, "cameras")) {
      CalibrationCameraSnapshot snapshot;
      snapshot.ip = json_string_field(camera, "ip");
      snapshot.expected_sn = json_string_field(camera, "sn");
      snapshot.source_rollback_path = path_from_json_text(
          json_string_field(camera, "sourceRollbackPath"));
      snapshot.rollback_path = path_from_json_text(
          json_string_field(camera, "stagedPreviousPath"));
      snapshot.rollback_file_hash = json_string_field(camera, "sha256");
      snapshot.rollback_file_size = json_uintmax_field(camera, "size", 0);
      snapshot.applied_path = path_from_json_text(
          json_string_field(camera, "appliedPath"));
      snapshot.attempted = json_bool_field(camera, "attempted", false);
      snapshot.save_to_device = json_bool_field(camera, "saveToDevice", false);
      snapshot.simulated = json_bool_field(camera, "simulated", false);
      snapshot.previous_state.calibration_path =
          json_string_field(camera, "previousCalibrationPath");
      snapshot.previous_state.calibration_artifact_kind =
          json_string_field(camera, "previousArtifactKind");
      snapshot.previous_state.calibration_code =
          json_int_field(camera, "previousCalibrationCode", CORRECT);
      snapshot.previous_state.calibration_time =
          json_string_field(camera, "previousCalibrationTime");
      snapshot.previous_state.operation_id =
          json_string_field(camera, "previousOperationId");
      snapshot.previous_state.rollback_token =
          json_string_field(camera, "previousRollbackToken");
      snapshot.previous_state.rollback_mode =
          json_string_field(camera, "previousRollbackMode");
      snapshot.previous_state.rollback_code =
          json_int_field(camera, "previousRollbackCode", CORRECT);
      snapshot.previous_state.rollback_time =
          json_string_field(camera, "previousRollbackTime");
      if (snapshot.ip.empty() || snapshot.expected_sn.empty() ||
          camera_ips.find(snapshot.ip) != camera_ips.end()) {
        return false;
      }
      camera_ips[snapshot.ip] = true;
      if (!snapshot.rollback_path.empty()) {
        std::string actual_hash;
        std::uintmax_t actual_size = 0;
        if (!is_path_under_base(snapshot.rollback_path.string(), record.record_dir) ||
            !is_sha256_hex(snapshot.rollback_file_hash) ||
            !calibration_file_fingerprint(
                snapshot.rollback_path, actual_hash, actual_size) ||
            actual_hash != snapshot.rollback_file_hash ||
            actual_size != snapshot.rollback_file_size) {
          return false;
        }
        snapshot.has_rollback_fingerprint = true;
      } else if (record.durable) {
        return false;
      }
      record.cameras.push_back(std::move(snapshot));
    }
    return !record.cameras.empty();
  }

  bool calibration_record_requires_recovery_locked(
      const CalibrationRollbackRecord& record) const {
    if (record.consumed) {
      return false;
    }
    return record.phase == "prepared" || record.phase == "applying" ||
           record.phase == "rolling-back" ||
           record.phase == "rollback-failed";
  }

  int pending_calibration_recovery_count_locked() const {
    return static_cast<int>(std::count_if(
        calibration_rollbacks_.begin(), calibration_rollbacks_.end(),
        [&](const auto& item) {
          return calibration_record_requires_recovery_locked(item.second);
        }));
  }

  bool calibration_recovery_required_locked() const {
    return !calibration_rollback_manifest_set_valid_ ||
           pending_calibration_recovery_count_locked() > 0;
  }

  void load_calibration_rollback_manifests_locked() {
    calibration_rollbacks_.clear();
    calibration_rollback_manifest_set_valid_ = true;
    const std::filesystem::path root = calibration_rollback_root_locked();
    std::error_code error;
    if (!std::filesystem::exists(root, error)) {
      return;
    }
    if (error || !std::filesystem::is_directory(root, error) || error) {
      calibration_rollback_manifest_set_valid_ = false;
      std::cerr << "Calibration rollback manifest root is not a readable directory: "
                << root.string() << "\n";
      return;
    }
    error.clear();
    for (std::filesystem::recursive_directory_iterator iterator(root, error), end;
         !error && iterator != end; iterator.increment(error)) {
      if (!iterator->is_regular_file(error) ||
          iterator->path().filename() != "manifest.json") {
        continue;
      }
      CalibrationRollbackRecord record;
      if (parse_calibration_rollback_manifest_locked(iterator->path(), record)) {
        calibration_rollbacks_[record.token] = std::move(record);
      } else {
        calibration_rollback_manifest_set_valid_ = false;
        std::cerr << "Ignoring incomplete or invalid calibration rollback manifest: "
                  << iterator->path().string() << "\n";
      }
    }
    if (error) {
      calibration_rollback_manifest_set_valid_ = false;
      std::cerr << "Calibration rollback manifest scan failed: "
                << error.message() << "\n";
    }
  }

  void bind_persisted_calibration_generation_locked(CameraSession& session) {
    if (!calibration_rollback_manifest_set_valid_) {
      // A corrupt or incomplete newer manifest could otherwise make an older
      // token look current. Fail closed until an operator reconciles the set.
      return;
    }
    const std::string actual_sn = !session.sn.empty()
                                      ? session.sn
                                      : (session.device && session.device->dev_info
                                             ? session.device->dev_info->sn
                                             : "");
    const CalibrationRollbackRecord* newest_record = nullptr;
    const CalibrationCameraSnapshot* newest_snapshot = nullptr;
    for (const auto& item : calibration_rollbacks_) {
      const CalibrationRollbackRecord& record = item.second;
      for (const CalibrationCameraSnapshot& snapshot : record.cameras) {
        if (!snapshot.attempted || snapshot.ip != session.ip) {
          continue;
        }
        if (!newest_record || record.created_at > newest_record->created_at ||
            (record.created_at == newest_record->created_at &&
             record.token > newest_record->token)) {
          newest_record = &record;
          newest_snapshot = &snapshot;
        }
      }
    }
    if (!newest_record ||
        (newest_record->phase != "applied" &&
         !calibration_record_requires_recovery_locked(*newest_record)) ||
        newest_record->consumed || !newest_record->durable ||
        !newest_snapshot || newest_snapshot->expected_sn != actual_sn) {
      return;
    }
    session.calibration.calibration_path = newest_snapshot->applied_path.string();
    session.calibration.calibration_artifact_kind = "sdk-camera-calibration";
    session.calibration.calibration_code = CORRECT;
    session.calibration.calibration_time = newest_record->created_at;
    session.calibration.operation_id = newest_record->operation_id;
    session.calibration.rollback_token = newest_record->token;
  }

  std::string calibration_contract_capabilities_json() const {
    return "{\"arrayArtifact\":\"reconstruction-only\","
           "\"cameraArtifact\":\"per-camera-sdk-xml\","
           "\"sdkCanExportCurrentCalibration\":false,"
           "\"runtimeStructSnapshot\":true,"
           "\"runtimeRollback\":\"lvm_calib_param_t+lvm_set_param\","
           "\"persistentRollbackRequiresPreviousFile\":true,"
           "\"rollbackFileFingerprint\":\"sha256+size\","
           "\"rollbackPreviousFileStaging\":\"immutable-config-root-copy\","
           "\"rollbackManifest\":\"atomic-write-ahead-v1\","
           "\"rollbackCameraIdentityBinding\":\"serial-number\","
           "\"rollbackGenerationBinding\":true,"
           "\"rollbackTokenDurability\":\"cross-restart-file-only\","
           "\"rollbackRestartRecovery\":true,"
           "\"rollbackInvalidManifestPolicy\":\"fail-closed\","
           "\"rollbackRecoveryFence\":true,"
           "\"calibrationCrashFailpoint\":\"explicit-env-operation-phase-camera-bound-v1\","
           "\"rollbackRecoveryStatus\":423,"
           "\"rollbackRecoverablePhases\":[\"prepared\",\"applying\",\"rolling-back\",\"rollback-failed\"],"
           "\"operationCorrelationId\":true,"
           "\"saveToDeviceDefault\":false,"
           "\"dryRunSupported\":true}";
  }

  std::string next_calibration_rollback_token_locked() {
    const unsigned long long sequence =
        calibration_rollback_counter_.fetch_add(1, std::memory_order_acq_rel) + 1;
    std::ostringstream token;
    token << "calrb-" << timestamp_file_segment() << "-" << sequence;
    return token.str();
  }

  void trim_calibration_rollbacks_locked() {
    // Durable, unconsumed records are operator recovery assets and must never
    // become unreachable merely because an in-memory cache reached 64 entries.
    // Retention is intentionally deferred until a separate manifest-aware
    // policy can prove a consumed record is no longer a generation head.
  }

  int rollback_calibration_camera_locked(
      CalibrationCameraSnapshot& snapshot,
      const std::string& token,
      const std::string& operation_id,
      std::string& mode) {
    mode = "unavailable";
    CameraSession* session = session_for_ip_locked(snapshot.ip);
    if (!session || (!session->device && !session->simulated)) {
      return DEV_NOT_LINK_ERROR;
    }
    int ret = CALIBRATION_ROLLBACK_UNAVAILABLE;
    const std::string actual_sn = !session->sn.empty()
                                      ? session->sn
                                      : (session->device && session->device->dev_info
                                             ? session->device->dev_info->sn
                                             : "");
    const bool identity_matches = snapshot.expected_sn.empty() ||
                                  snapshot.expected_sn == actual_sn;
    const bool generation_matches =
        session->calibration.rollback_token == token;

    auto rollback_file_matches_snapshot = [&]() {
      if (snapshot.rollback_path.empty() ||
          !snapshot.has_rollback_fingerprint) {
        return false;
      }
      std::string current_hash;
      std::uintmax_t current_size = 0;
      return calibration_file_fingerprint(
                 snapshot.rollback_path, current_hash, current_size) &&
             current_hash == snapshot.rollback_file_hash &&
             current_size == snapshot.rollback_file_size;
    };

    auto restore_runtime_snapshot = [&](bool persist_to_device,
                                        const std::string& success_mode) {
      if (!snapshot.has_runtime_param || !session->device ||
          !session->device->calib_param) {
        return CALIBRATION_ROLLBACK_UNAVAILABLE;
      }
      *session->device->calib_param = snapshot.runtime_param;
      int runtime_ret = lvm_set_param(session->device, LVM_CALIB_PARAM);
      mode = success_mode;
      if (runtime_ret == CORRECT && persist_to_device) {
        runtime_ret = lvm_save_param_to_dev(session->device);
        mode += "+device-save-best-effort";
      }
      return runtime_ret;
    };

    if (!identity_matches) {
      mode = "camera-identity-mismatch";
    } else if (!generation_matches) {
      mode = "calibration-generation-mismatch";
    } else if (session->simulated || snapshot.simulated) {
      ret = CORRECT;
      mode = snapshot.rollback_path.empty()
                 ? "simulated-process-state"
                 : "simulated-previous-sdk-file";
    } else if (!snapshot.save_to_device && snapshot.has_runtime_param) {
      ret = restore_runtime_snapshot(false, "runtime-struct");
      if (ret != CORRECT && !snapshot.rollback_path.empty()) {
        if (!rollback_file_matches_snapshot()) {
          ret = CALIBRATION_ROLLBACK_UNAVAILABLE;
          mode = "runtime-struct-failed+rollback-file-changed";
        } else {
          ret = lvm_load_calib_param(
              session->device, snapshot.rollback_path.string().c_str());
          mode = "runtime-struct-failed+previous-sdk-file-fallback";
        }
      }
    } else if (!snapshot.rollback_path.empty()) {
      if (!rollback_file_matches_snapshot()) {
        ret = CALIBRATION_ROLLBACK_UNAVAILABLE;
        mode = "rollback-file-changed";
      } else {
        ret = lvm_load_calib_param(
            session->device, snapshot.rollback_path.string().c_str());
        mode = "previous-sdk-file";
        if (ret == CORRECT && snapshot.save_to_device) {
          ret = lvm_save_param_to_dev(session->device);
          mode = "previous-sdk-file+device-save";
        }
      }
    }
    if (ret != CORRECT && identity_matches && generation_matches &&
        snapshot.save_to_device && snapshot.has_runtime_param) {
      ret = restore_runtime_snapshot(
          true,
          snapshot.rollback_path.empty()
              ? "runtime-struct-best-effort"
              : "previous-file-failed+runtime-struct-best-effort");
    }

    if (ret == CORRECT) {
      session->calibration = snapshot.previous_state;
    }
    session->calibration.operation_id = operation_id;
    session->calibration.rollback_token = token;
    session->calibration.rollback_mode = mode;
    session->calibration.rollback_code = ret;
    session->calibration.rollback_time = now_iso();
    append_calibration_maintenance_record_locked(
        "calibration-rollback",
        *session,
        snapshot.rollback_path.string(),
        ret,
        token,
        operation_id);
    return ret;
  }

  std::string calibration_apply_target_json(const CalibrationApplyTarget& target) const {
    const int final_code = target.preflight_code != CORRECT
                               ? target.preflight_code
                               : (target.apply_code != CORRECT
                                       ? target.apply_code
                                       : (target.persist_code != CORRECT
                                              ? target.persist_code
                                              : (target.rollback_record_code != CORRECT
                                                     ? target.rollback_record_code
                                                     : target.rollback_code)));
    std::ostringstream json;
    json << "{\"code\":" << final_code << ","
         << json_pair("operationId", target.operation_id) << ","
         << json_pair("ip", target.ip) << ","
         << json_pair("calibrationPath", target.calibration_path.string()) << ","
         << json_pair("artifactKind", target.artifact_kind) << ","
         << json_pair("rollbackPath", target.rollback_path.string()) << ","
         << "\"preflightCode\":" << target.preflight_code << ","
         << "\"applyCode\":" << target.apply_code << ","
         << "\"persistCode\":" << target.persist_code << ","
         << "\"rollbackRecordCode\":" << target.rollback_record_code << ","
         << "\"rollbackCode\":" << target.rollback_code << ","
         << json_pair("rollbackMode", target.rollback_mode) << ","
         << "\"runtimeSnapshotAvailable\":"
         << (target.runtime_snapshot_available ? "true" : "false") << ","
         << "\"fileRollbackAvailable\":"
         << (target.file_rollback_available ? "true" : "false") << ","
         << "\"attempted\":" << (target.attempted ? "true" : "false") << ","
         << "\"applied\":" << (target.applied ? "true" : "false") << ","
         << "\"rolledBack\":" << (target.rolled_back ? "true" : "false") << ","
         << "\"skipped\":" << (target.skipped ? "true" : "false") << ","
         << json_pair("message", target.message)
         << "}";
    return json.str();
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
    std::filesystem::path calibration_path = calibration_file.empty()
                                                ? std::filesystem::path()
                                                : config_or_storage_path_locked(calibration_file);
    bool exists = !calibration_file.empty() && std::filesystem::exists(calibration_path);
    const auto artifact_kind = calibration_path.empty()
                                   ? steel_capture::CalibrationArtifactKind::Missing
                                   : steel_capture::classify_calibration_artifact(calibration_path);
    std::string active_raw = json_raw_field(profile, "activeCalibration", "{}");
    if (active_raw.empty()) {
      active_raw = "{}";
    }

    std::string fit_report = json_string_field(active_raw, "fitReport");
    std::string fit_summary = "{}";
    if (!fit_report.empty()) {
      std::filesystem::path report_path = config_or_storage_path_locked(fit_report);
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
         << json_pair("artifactKind", steel_capture::calibration_artifact_kind_text(artifact_kind)) << ","
         << "\"exists\":" << (exists ? "true" : "false") << ","
         << json_pair("versionRoot", calibration_profile_root_locked(name).string()) << ","
         << "\"activeCalibration\":" << active_raw << ","
         << "\"fitReportSummary\":" << fit_summary << ","
         << "\"contractCapabilities\":" << calibration_contract_capabilities_json()
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
    bool allow_external = json_bool_field(body, "allowExternal", false);
    const CalibrationArtifactResolution artifact =
        resolve_calibration_artifact_locked(path_text, allow_external, true);
    if (artifact.code != CORRECT) {
      return json_error(artifact.code, artifact.message);
    }
    const std::filesystem::path calibration_path = artifact.path;

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
        std::filesystem::path report_path = config_or_storage_path_locked(fit_report);
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
             << json_pair("artifactKind", "array-reconstruction") << ","
             << json_pair("operationId", json_string_field(body, "operationId")) << ","
             << json_pair("rollbackToken", json_string_field(body, "rollbackToken")) << ","
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
      active_raw = set_top_level_json_field(active_raw, "artifactKind", json_string_value("array-reconstruction"));
      active_raw = set_top_level_json_field(active_raw, "operationId", json_string_value(json_string_field(body, "operationId")));
      active_raw = set_top_level_json_field(active_raw, "rollbackToken", json_string_value(json_string_field(body, "rollbackToken")));
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
    const std::string operation_id = json_string_field(body, "operationId");
    if (!operation_id.empty() && !is_valid_operation_id(operation_id)) {
      return json_error(400, "operationId must contain 1-128 stable identifier characters");
    }
    const std::string requested_profile_name =
        json_string_field(body, "name", json_string_field(body, "profile"));
    const std::string array_path_text = json_string_field(
        body, "path", json_string_field(body, "calibrationPath", json_string_field(body, "correctedCalibration")));
    const bool allow_external = json_bool_field(body, "allowExternal", false);
    const bool stop_streams = json_bool_field(body, "stopStreams", true);
    const bool dry_run = json_bool_field(body, "dryRun", false);
    const bool atomic_apply = json_bool_field(body, "atomic", true);
    const bool rollback_on_failure = atomic_apply || json_bool_field(body, "rollbackOnFailure", false);
    const bool save_camera_params = json_bool_field(body, "saveCameraParams", false);
    const bool save_to_device = json_bool_field(body, "saveToDevice", false);
    const bool allow_best_effort_device_rollback =
        json_bool_field(body, "allowBestEffortDeviceRollback", false);
    const bool require_all_mapped = json_bool_field(body, "requireAllMapped", true);
    const bool persist_active = json_bool_field(body, "persistActive", !array_path_text.empty());
    const int requested_expected_cameras = json_int_field(body, "expectedCameras", 0);
    std::vector<std::string> requested_ips = json_string_array_field(body, "ips");
    std::vector<std::string> mapping_objects =
        json_object_array_field(body, "cameraCalibrations");
    if (mapping_objects.empty()) {
      mapping_objects = json_object_array_field(body, "cameraFiles");
    }

    if (!dry_run && json_string_field(body, "confirmation") !=
                        "APPLY CAMERA CALIBRATION SET") {
      return json_error(CALIBRATION_CONFIRMATION_REQUIRED,
                        "confirmation must equal 'APPLY CAMERA CALIBRATION SET'");
    }
    if (save_to_device && json_string_field(body, "deviceConfirmation") !=
                              "PERSIST CAMERA PARAMETERS") {
      return json_error(CALIBRATION_CONFIRMATION_REQUIRED,
                        "deviceConfirmation must equal 'PERSIST CAMERA PARAMETERS'");
    }

    std::lock_guard<std::mutex> lock(mutex_);
    if (active_capture_batches_ > 0) {
      return json_error(409, "capture batch is running");
    }
    const int expected_cameras = requested_expected_cameras > 0
                                     ? requested_expected_cameras
                                     : expected_cameras_;
    const std::string profile_name = normalize_profile_name(
        requested_profile_name.empty() ? active_profile_name_locked()
                                       : requested_profile_name);

    CalibrationArtifactResolution array_artifact;
    if (!array_path_text.empty()) {
      array_artifact = resolve_calibration_artifact_locked(
          array_path_text, allow_external, true);
      if (array_artifact.code != CORRECT) {
        return json_error(array_artifact.code, array_artifact.message);
      }
    } else if (persist_active) {
      return json_error(CALIBRATION_PREFLIGHT_FAILED,
                        "persistActive requires an array reconstruction XML path");
    }

    std::map<std::string, std::string> mappings;
    std::vector<std::string> duplicate_ips;
    for (const std::string& object : mapping_objects) {
      const std::string ip = json_string_field(object, "ip");
      if (ip.empty()) {
        continue;
      }
      if (mappings.find(ip) != mappings.end()) {
        duplicate_ips.push_back(ip);
      } else {
        mappings[ip] = object;
      }
    }

    if (requested_ips.empty()) {
      if (require_all_mapped) {
        for (const auto& item : sessions_) {
          if (item.second.device || item.second.simulated_connected) {
            requested_ips.push_back(item.second.ip);
          }
        }
        std::sort(requested_ips.begin(), requested_ips.end());
      } else {
        for (const auto& item : mappings) {
          requested_ips.push_back(item.first);
        }
      }
    }

    std::map<std::string, int> requested_ip_counts;
    std::vector<std::string> unique_requested_ips;
    unique_requested_ips.reserve(requested_ips.size());
    for (const std::string& ip : requested_ips) {
      int& count = requested_ip_counts[ip];
      ++count;
      if (count == 1) {
        unique_requested_ips.push_back(ip);
      }
    }
    requested_ips = std::move(unique_requested_ips);

    std::vector<CalibrationApplyTarget> targets;
    targets.reserve(requested_ips.size());
    int preflight_failures = 0;
    int first_error = CORRECT;
    auto fail_preflight = [&](CalibrationApplyTarget& target, int code, const std::string& message) {
      if (target.preflight_code == CORRECT) {
        target.preflight_code = code;
        target.message = message;
        ++preflight_failures;
        if (first_error == CORRECT) {
          first_error = code;
        }
      }
    };

    for (const std::string& ip : requested_ips) {
      CalibrationApplyTarget target;
      target.ip = ip;
      const auto requested_count = requested_ip_counts.find(ip);
      if (requested_count != requested_ip_counts.end() &&
          requested_count->second > 1) {
        fail_preflight(target, CALIBRATION_PREFLIGHT_FAILED,
                       "duplicate target camera ip");
      }
      auto mapping = mappings.find(ip);
      if (mapping == mappings.end()) {
        fail_preflight(target, CALIBRATION_PREFLIGHT_FAILED,
                       "missing per-camera SDK calibration mapping");
        targets.push_back(std::move(target));
        continue;
      }

      const std::string& object = mapping->second;
      const std::string artifact_type = json_string_field(
          object, "artifactType", json_string_field(object, "kind", "camera-sdk"));
      if (artifact_type != "camera-sdk" && artifact_type != "per-camera-sdk" &&
          artifact_type != "sdk-camera-calibration") {
        fail_preflight(target, CALIBRATION_ARTIFACT_KIND_MISMATCH,
                       "camera mapping artifactType must be camera-sdk");
      }
      const CalibrationArtifactResolution artifact = resolve_calibration_artifact_locked(
          json_string_field(object, "path", json_string_field(object, "calibrationPath")),
          allow_external,
          false);
      target.calibration_path = artifact.path;
      target.artifact_kind = steel_capture::calibration_artifact_kind_text(artifact.kind);
      if (artifact.code != CORRECT) {
        fail_preflight(target, artifact.code, artifact.message);
      }

      CameraSession* session = session_for_ip_locked(ip);
      if (!session || (!session->device && !session->simulated)) {
        fail_preflight(target, DEV_NOT_LINK_ERROR, "camera not connected");
      } else {
        target.simulated = session->simulated;
        target.expected_sn = json_string_field(object, "expectedSn", json_string_field(object, "sn"));
        const std::string actual_sn = !session->sn.empty()
                                          ? session->sn
                                          : (session->device && session->device->dev_info
                                                 ? session->device->dev_info->sn
                                                 : "");
        if (!target.expected_sn.empty() && target.expected_sn != actual_sn) {
          fail_preflight(target, CALIBRATION_PREFLIGHT_FAILED,
                         "camera serial number does not match mapping expectedSn");
        }
        if (session->stream.running && !stop_streams) {
          fail_preflight(target, 409, "stream is running and stopStreams=false");
        }
        target.runtime_snapshot_available = session->simulated ||
                                            (session->device && session->device->calib_param);

        std::string rollback_text = json_string_field(object, "rollbackPath");
        if (rollback_text.empty()) {
          rollback_text = session->calibration.calibration_path;
        }
        if (!rollback_text.empty()) {
          const CalibrationArtifactResolution rollback_artifact =
              resolve_calibration_artifact_locked(rollback_text, allow_external, false);
          if (rollback_artifact.code == CORRECT) {
            target.rollback_path = rollback_artifact.path;
            target.file_rollback_available = true;
            target.rollback_fingerprint_available = calibration_file_fingerprint(
                target.rollback_path,
                target.rollback_file_hash,
                target.rollback_file_size);
            if (!target.rollback_fingerprint_available) {
              fail_preflight(target, CALIBRATION_ROLLBACK_UNAVAILABLE,
                             "rollbackPath cannot be read and fingerprinted");
            }
          } else if (json_has_field(object, "rollbackPath")) {
            fail_preflight(target, rollback_artifact.code,
                           "rollbackPath is invalid: " + rollback_artifact.message);
          }
        }
        if (atomic_apply && !target.runtime_snapshot_available &&
            !target.file_rollback_available) {
          fail_preflight(target, CALIBRATION_ROLLBACK_UNAVAILABLE,
                         "atomic apply requires a runtime snapshot or rollbackPath");
        }
        if (save_to_device && !target.file_rollback_available &&
            !allow_best_effort_device_rollback) {
          fail_preflight(target, CALIBRATION_ROLLBACK_UNAVAILABLE,
                         "saveToDevice requires a previous per-camera rollbackPath unless best-effort rollback is explicitly allowed");
        }
      }
      targets.push_back(std::move(target));
    }

    for (const std::string& duplicate_ip : duplicate_ips) {
      auto found = std::find_if(targets.begin(), targets.end(), [&](const CalibrationApplyTarget& target) {
        return target.ip == duplicate_ip;
      });
      if (found != targets.end()) {
        fail_preflight(*found, CALIBRATION_PREFLIGHT_FAILED,
                       "duplicate per-camera mapping");
      } else {
        CalibrationApplyTarget duplicate;
        duplicate.ip = duplicate_ip;
        fail_preflight(duplicate, CALIBRATION_PREFLIGHT_FAILED,
                       "duplicate per-camera mapping");
        targets.push_back(std::move(duplicate));
      }
    }
    std::map<std::string, int> calibration_path_counts;
    for (const CalibrationApplyTarget& target : targets) {
      if (!target.calibration_path.empty()) {
        ++calibration_path_counts[lower_path_text(target.calibration_path)];
      }
    }
    for (CalibrationApplyTarget& target : targets) {
      if (!target.calibration_path.empty() &&
          calibration_path_counts[lower_path_text(target.calibration_path)] > 1) {
        fail_preflight(target, CALIBRATION_PREFLIGHT_FAILED,
                       "each camera must use a distinct SDK calibration artifact");
      }
    }
    if (expected_cameras > 0 && static_cast<int>(requested_ips.size()) != expected_cameras) {
      CalibrationApplyTarget count_failure;
      count_failure.ip = "*";
      fail_preflight(count_failure, CALIBRATION_PREFLIGHT_FAILED,
                     "target camera count does not match expectedCameras");
      targets.push_back(std::move(count_failure));
    }

    for (CalibrationApplyTarget& target : targets) {
      target.operation_id = operation_id;
    }

    auto results_json = [&]() {
      std::ostringstream results;
      results << "[";
      for (size_t index = 0; index < targets.size(); ++index) {
        if (index > 0) {
          results << ",";
        }
        results << calibration_apply_target_json(targets[index]);
      }
      results << "]";
      return results.str();
    };

    auto response_json = [&](int code,
                             const std::string& rollback_token,
                             bool rollback_performed,
                             bool rollback_complete,
                             const std::string& save_result,
                             const std::string& active_result) {
      int applied = 0;
      int failed = 0;
      int skipped = 0;
      int rolled_back = 0;
      for (const CalibrationApplyTarget& target : targets) {
        if (target.applied && !target.rolled_back) ++applied;
        if (target.preflight_code != CORRECT || target.apply_code != CORRECT ||
            target.persist_code != CORRECT || target.rollback_record_code != CORRECT ||
            target.rollback_code != CORRECT) ++failed;
        if (target.skipped) ++skipped;
        if (target.rolled_back) ++rolled_back;
      }
      std::ostringstream json;
      json << "{\"schema\":\"steel.capture.calibration-apply.v2\","
           << "\"code\":" << code << ","
           << json_pair("operationId", operation_id) << ","
           << json_pair("errorName", capture_error_name(code)) << ","
           << json_pair("operatorHint", capture_error_hint(code)) << ","
           << json_pair("profile", profile_name) << ","
           << json_pair("arrayCalibrationPath", array_artifact.path.string()) << ","
           << json_pair("arrayArtifactKind", steel_capture::calibration_artifact_kind_text(array_artifact.kind)) << ","
           << "\"dryRun\":" << (dry_run ? "true" : "false") << ","
           << "\"atomic\":" << (atomic_apply ? "true" : "false") << ","
           << "\"rollbackOnFailure\":" << (rollback_on_failure ? "true" : "false") << ","
           << json_pair("rollbackToken", rollback_token) << ","
           << "\"rollbackPerformed\":" << (rollback_performed ? "true" : "false") << ","
           << "\"rollbackComplete\":" << (rollback_complete ? "true" : "false") << ","
           << "\"applied\":" << applied << ","
           << "\"failed\":" << failed << ","
           << "\"skipped\":" << skipped << ","
           << "\"rolledBack\":" << rolled_back << ","
           << "\"persistActive\":" << (persist_active ? "true" : "false") << ","
           << "\"saveCameraParams\":" << (save_camera_params ? "true" : "false") << ","
           << "\"saveToDevice\":" << (save_to_device ? "true" : "false") << ","
           << "\"contractCapabilities\":" << calibration_contract_capabilities_json() << ","
           << "\"results\":" << results_json() << ","
           << "\"saveResult\":" << save_result << ","
           << "\"activeCalibration\":" << active_result
           << "}";
      return json.str();
    };

    if (preflight_failures > 0) {
      return response_json(CALIBRATION_PREFLIGHT_FAILED, "", false, false,
                           "{\"skipped\":true}", "{\"skipped\":true}");
    }
    for (CalibrationApplyTarget& target : targets) {
      target.message = dry_run ? "preflight passed; no SDK call made"
                               : "preflight passed";
    }
    if (dry_run) {
      return response_json(CORRECT, "", false, true,
                           "{\"skipped\":true}", "{\"skipped\":true}");
    }

    std::string profile_before;
    const std::filesystem::path profile_path = existing_profile_path_locked(profile_name);
    if (persist_active && !read_file(profile_path.string(), profile_before)) {
      return json_error(404, "profile not found before calibration apply");
    }

    trim_calibration_rollbacks_locked();
    CalibrationRollbackRecord rollback_record;
    rollback_record.token = next_calibration_rollback_token_locked();
    rollback_record.operation_id = operation_id;
    rollback_record.created_at = now_iso();
    rollback_record.profile_name = profile_name;
    rollback_record.profile_path = profile_path;
    rollback_record.profile_before = profile_before;
    rollback_record.save_to_device = save_to_device;
    rollback_record.cameras.reserve(targets.size());
    for (const CalibrationApplyTarget& target : targets) {
      CameraSession* session = session_for_ip_locked(target.ip);
      CalibrationCameraSnapshot snapshot;
      snapshot.ip = target.ip;
      snapshot.expected_sn = !session->sn.empty()
                                 ? session->sn
                                 : (session->device && session->device->dev_info
                                        ? session->device->dev_info->sn
                                        : "");
      snapshot.previous_state = session->calibration;
      snapshot.rollback_path = target.rollback_path;
      snapshot.applied_path = target.calibration_path;
      snapshot.has_rollback_fingerprint = target.rollback_fingerprint_available;
      snapshot.rollback_file_hash = target.rollback_file_hash;
      snapshot.rollback_file_size = target.rollback_file_size;
      snapshot.simulated = session->simulated;
      snapshot.save_to_device = save_to_device;
      if (session->device && session->device->calib_param) {
        snapshot.runtime_param = *session->device->calib_param;
        snapshot.has_runtime_param = true;
      }
      rollback_record.cameras.push_back(std::move(snapshot));
    }
    const std::string rollback_token = rollback_record.token;
    std::string staging_error;
    if (!stage_calibration_rollback_record_locked(
            rollback_record, staging_error)) {
      for (CalibrationApplyTarget& target : targets) {
        target.rollback_record_code = CALIBRATION_ROLLBACK_UNAVAILABLE;
        target.message = staging_error + "; no camera SDK write was attempted";
      }
      return response_json(
          CALIBRATION_ROLLBACK_UNAVAILABLE, "", false, false,
          "{\"skipped\":true}", "{\"skipped\":true}");
    }
    calibration_rollbacks_[rollback_token] = std::move(rollback_record);
    CalibrationRollbackRecord& stored_rollback = calibration_rollbacks_[rollback_token];

    bool apply_failed = false;
    first_error = CORRECT;
    for (size_t index = 0; index < targets.size(); ++index) {
      CalibrationApplyTarget& target = targets[index];
      CalibrationCameraSnapshot& snapshot = stored_rollback.cameras[index];
      if (apply_failed && atomic_apply) {
        target.skipped = true;
        target.apply_code = CALIBRATION_PREFLIGHT_FAILED;
        target.message = "skipped after an earlier atomic apply failure";
        continue;
      }
      CameraSession* session = session_for_ip_locked(target.ip);
      if (session->stream.running) {
        stop_stream_locked(*session);
      }
      target.attempted = true;
      snapshot.attempted = true;
      stored_rollback.phase = "applying";
      if (!persist_calibration_rollback_manifest_locked(stored_rollback)) {
        target.attempted = false;
        snapshot.attempted = false;
        target.rollback_record_code = CALIBRATION_ROLLBACK_UNAVAILABLE;
        target.message = "rollback manifest update failed before SDK write";
        apply_failed = true;
        if (first_error == CORRECT) {
          first_error = CALIBRATION_ROLLBACK_UNAVAILABLE;
        }
        continue;
      }
      maybe_crash_calibration_failpoint(
          operation_id, "apply-before-sdk", static_cast<int>(index + 1));
      target.apply_code = session->simulated
                              ? (session->ip == simulated_calibration_fail_ip_
                                     ? INPUT_PARAMETER_ERROR
                                     : CORRECT)
                              : lvm_load_calib_param(
                                    session->device, target.calibration_path.string().c_str());
      if (target.apply_code == CORRECT && save_to_device && !session->simulated) {
        target.persist_code = lvm_save_param_to_dev(session->device);
      }
      maybe_crash_calibration_failpoint(
          operation_id, "apply-after-sdk", static_cast<int>(index + 1));
      const int target_code = target.apply_code != CORRECT
                                  ? target.apply_code
                                  : target.persist_code;
      session->calibration.calibration_path = target.calibration_path.string();
      session->calibration.calibration_artifact_kind = target.artifact_kind;
      session->calibration.calibration_code = target_code;
      session->calibration.calibration_time = now_iso();
      session->calibration.operation_id = operation_id;
      session->calibration.rollback_token = rollback_token;
      append_calibration_maintenance_record_locked(
          "calibration-apply",
          *session,
          target.calibration_path.string(),
          target_code,
          rollback_token,
          operation_id);
      target.applied = target_code == CORRECT;
      target.message = target.applied
                           ? "per-camera SDK calibration applied"
                           : "per-camera SDK calibration or device persistence returned non-zero";
      if (!target.applied) {
        apply_failed = true;
        if (first_error == CORRECT) {
          first_error = target_code;
        }
      }
    }

    if (!apply_failed) {
      stored_rollback.phase = "applied";
      if (!persist_calibration_rollback_manifest_locked(stored_rollback)) {
        apply_failed = true;
        first_error = CALIBRATION_ROLLBACK_UNAVAILABLE;
        for (CalibrationApplyTarget& target : targets) {
          if (target.attempted && target.apply_code == CORRECT &&
              target.persist_code == CORRECT) {
            target.rollback_record_code = CALIBRATION_ROLLBACK_UNAVAILABLE;
            target.message =
                "calibration applied but durable manifest finalization failed";
          }
        }
      }
    }

    bool rollback_performed = false;
    bool rollback_complete = true;
    auto rollback_attempted = [&]() {
      rollback_performed = true;
      stored_rollback.phase = "rolling-back";
      persist_calibration_rollback_manifest_locked(stored_rollback);
      for (size_t reverse = targets.size(); reverse > 0; --reverse) {
        const size_t index = reverse - 1;
        CalibrationCameraSnapshot& snapshot = stored_rollback.cameras[index];
        CalibrationApplyTarget& target = targets[index];
        if (!snapshot.attempted) {
          continue;
        }
        target.rollback_code = rollback_calibration_camera_locked(
            snapshot, rollback_token, operation_id, target.rollback_mode);
        maybe_crash_calibration_failpoint(
            operation_id,
            "automatic-rollback-after-camera",
            static_cast<int>(index + 1));
        target.rolled_back = target.rollback_code == CORRECT;
        if (!target.rolled_back) {
          rollback_complete = false;
          first_error = CALIBRATION_ROLLBACK_FAILED;
        }
      }
      stored_rollback.consumed = rollback_complete;
      stored_rollback.phase = rollback_complete ? "rolled-back" : "rollback-failed";
      if (!persist_calibration_rollback_manifest_locked(stored_rollback)) {
        rollback_complete = false;
        stored_rollback.consumed = false;
        stored_rollback.phase = "rollback-failed";
        first_error = CALIBRATION_ROLLBACK_FAILED;
      }
    };

    if (apply_failed && rollback_on_failure) {
      rollback_attempted();
    }

    std::string save_result = "{\"skipped\":true}";
    if (!apply_failed && save_camera_params) {
      std::ostringstream save_body;
      save_body << "{" << json_pair("name", profile_name) << ","
                << json_pair("cameraParamDir", json_string_field(
                       body, "cameraParamDir", "config/camera-params/" + profile_name)) << ","
                << "\"applySoftTrigger\":"
                << (json_bool_field(body, "applySoftTrigger", false) ? "true" : "false") << ","
                << "\"saveToDevice\":false,\"ips\":[";
      for (size_t index = 0; index < requested_ips.size(); ++index) {
        if (index > 0) save_body << ",";
        save_body << json_string_value(requested_ips[index]);
      }
      save_body << "]}";
      save_result = config_camera_params_save_all_locked(save_body.str());
      const int save_code = json_int_field(save_result, "code", CORRECT);
      if (save_code != CORRECT) {
        apply_failed = true;
        first_error = save_code;
        if (rollback_on_failure && !rollback_performed) {
          rollback_attempted();
        }
      }
    }

    std::string active_result = "{\"skipped\":true}";
    if (!apply_failed && persist_active) {
      std::ostringstream active_body_builder;
      active_body_builder
          << "{"
          << json_pair("path", profile_path_text_locked(array_artifact.path)) << ","
          << json_pair("name", profile_name) << ","
          << json_pair("operationId", operation_id) << ","
          << json_pair("rollbackToken", rollback_token) << ","
          << json_pair("version", json_string_field(body, "version")) << ","
          << json_pair("fitReport", json_string_field(body, "fitReport")) << ","
          << json_pair("beforePreview", json_string_field(body, "beforePreview")) << ","
          << json_pair("afterPreview", json_string_field(body, "afterPreview")) << ","
          << json_pair("sourceCalibration", json_string_field(body, "sourceCalibration")) << ","
          << json_pair("cameraParamDir", json_string_field(body, "cameraParamDir")) << ","
          << json_pair("appliedBy", json_string_field(body, "appliedBy", "capture-provider")) << ","
          << "\"allowExternal\":" << (allow_external ? "true" : "false") << ","
          << "\"saveToDevice\":" << (save_to_device ? "true" : "false") << ","
          << "\"fitBefore\":" << json_raw_field(body, "fitBefore", "{}") << ","
          << "\"fitAfter\":" << json_raw_field(body, "fitAfter", "{}");
      const std::string requested_active = json_raw_field(body, "activeCalibration");
      if (!requested_active.empty()) {
        active_body_builder << ",\"activeCalibration\":" << requested_active;
      }
      active_body_builder << "}";
      const std::string active_body = active_body_builder.str();
      // Publish profile-change intent before the profile writer runs. A crash
      // after this point can therefore restore profile_before even if it is
      // unclear whether the profile rename completed.
      stored_rollback.profile_changed = true;
      stored_rollback.phase = "applied";
      if (!persist_calibration_rollback_manifest_locked(stored_rollback)) {
        apply_failed = true;
        first_error = CALIBRATION_ROLLBACK_UNAVAILABLE;
        active_result = json_error(
            CALIBRATION_ROLLBACK_UNAVAILABLE,
            "rollback manifest update failed before active profile write");
        for (CalibrationApplyTarget& target : targets) {
          if (target.attempted) {
            target.rollback_record_code = CALIBRATION_ROLLBACK_UNAVAILABLE;
          }
        }
        if (rollback_on_failure && !rollback_performed) {
          rollback_attempted();
        }
        stored_rollback.profile_changed = false;
        persist_calibration_rollback_manifest_locked(stored_rollback);
      } else {
        active_result = calibration_active_save_locked(
            active_body, results_json(), save_result);
        const int active_code = json_int_field(active_result, "code", CORRECT);
        if (active_code != CORRECT) {
          apply_failed = true;
          first_error = active_code;
          if (rollback_on_failure && !rollback_performed) {
            rollback_attempted();
          }
          const bool profile_restored = !profile_before.empty() &&
              write_text_file(stored_rollback.profile_path, profile_before);
          if (profile_restored) {
            sync_existing_legacy_profile_locked(profile_name, profile_before);
            stored_rollback.profile_changed = false;
          } else {
            rollback_complete = false;
            stored_rollback.consumed = false;
            stored_rollback.phase = "rollback-failed";
            if (first_error == CORRECT) {
              first_error = CALIBRATION_ROLLBACK_FAILED;
            }
          }
          persist_calibration_rollback_manifest_locked(stored_rollback);
        }
      }
    }

    const int code = apply_failed
                         ? (first_error == CORRECT ? CALIBRATION_PREFLIGHT_FAILED : first_error)
                         : CORRECT;
    return response_json(code, rollback_token, rollback_performed,
                         rollback_complete, save_result, active_result);
  }

  std::string calibration_rollback_json(const std::string& body) {
    const std::string operation_id = json_string_field(body, "operationId");
    if (!operation_id.empty() && !is_valid_operation_id(operation_id)) {
      return json_error(400, "operationId must contain 1-128 stable identifier characters");
    }
    const std::string token = json_string_field(body, "rollbackToken", json_string_field(body, "token"));
    if (token.empty()) {
      return json_error(400, "missing rollbackToken");
    }
    if (json_string_field(body, "confirmation") !=
        "ROLLBACK CAMERA CALIBRATION") {
      return json_error(CALIBRATION_CONFIRMATION_REQUIRED,
                        "confirmation must equal 'ROLLBACK CAMERA CALIBRATION'");
    }
    const bool stop_streams = json_bool_field(body, "stopStreams", true);
    std::lock_guard<std::mutex> lock(mutex_);
    if (active_capture_batches_ > 0) {
      return json_error(409, "capture batch is running");
    }
    auto found = calibration_rollbacks_.find(token);
    if (found == calibration_rollbacks_.end()) {
      return json_error(CALIBRATION_ROLLBACK_UNAVAILABLE,
                        "rollback token is unknown or expired after provider restart");
    }
    CalibrationRollbackRecord& record = found->second;
    auto preflight_error = [&](int code, const std::string& message) {
      std::ostringstream json;
      json << "{\"schema\":\"steel.capture.calibration-rollback.v1\","
           << "\"code\":" << code << ","
           << json_pair("operationId", operation_id) << ","
           << json_pair("applyOperationId", record.operation_id) << ","
           << json_pair("rollbackToken", token) << ","
           << "\"complete\":false,\"attempted\":false,"
           << "\"sideEffects\":false,\"failed\":0,\"rolledBack\":0,"
           << json_pair("errorName", capture_error_name(code)) << ","
           << json_pair("operatorHint", capture_error_hint(code)) << ","
           << json_pair("message", message) << "}";
      return json.str();
    };
    if (record.consumed) {
      return preflight_error(409, "rollback token has already been consumed");
    }
    if (record.phase != "applied" &&
        !calibration_record_requires_recovery_locked(record)) {
      return preflight_error(
          CALIBRATION_ROLLBACK_UNAVAILABLE,
          "rollback manifest is not an applied or recoverable phase");
    }

    for (const CalibrationCameraSnapshot& snapshot : record.cameras) {
      if (!snapshot.attempted) {
        continue;
      }
      CameraSession* session = session_for_ip_locked(snapshot.ip);
      if (!session || (!session->device && !session->simulated)) {
        return preflight_error(
            DEV_NOT_LINK_ERROR,
            "rollback preflight failed because a target camera is disconnected");
      }
      const std::string actual_sn = !session->sn.empty()
                                        ? session->sn
                                        : (session->device && session->device->dev_info
                                               ? session->device->dev_info->sn
                                               : "");
      if (!snapshot.expected_sn.empty() && snapshot.expected_sn != actual_sn) {
        return preflight_error(
            CALIBRATION_ROLLBACK_UNAVAILABLE,
            "rollback preflight failed because camera identity changed");
      }
      if (session->calibration.rollback_token != token) {
        return preflight_error(
            CALIBRATION_ROLLBACK_UNAVAILABLE,
            "rollback preflight failed because calibration generation changed");
      }
      if (!snapshot.rollback_path.empty()) {
        std::string current_hash;
        std::uintmax_t current_size = 0;
        if (!snapshot.has_rollback_fingerprint ||
            !calibration_file_fingerprint(
                snapshot.rollback_path, current_hash, current_size) ||
            current_hash != snapshot.rollback_file_hash ||
            current_size != snapshot.rollback_file_size) {
          return preflight_error(
              CALIBRATION_ROLLBACK_UNAVAILABLE,
              "rollback preflight failed because rollback file changed");
        }
      } else if (!snapshot.has_runtime_param && !snapshot.simulated) {
        return preflight_error(
            CALIBRATION_ROLLBACK_UNAVAILABLE,
            "rollback preflight failed because no durable previous file exists");
      }
      if (session->stream.running && !stop_streams) {
        return preflight_error(
            409,
            "rollback preflight failed because a target stream is running");
      }
    }
    const std::string phase_before_rollback = record.phase;
    record.phase = "rolling-back";
    if (!persist_calibration_rollback_manifest_locked(record)) {
      record.phase = phase_before_rollback;
      return preflight_error(
          CALIBRATION_ROLLBACK_UNAVAILABLE,
          "rollback manifest update failed before SDK writes");
    }
    if (stop_streams) {
      for (const CalibrationCameraSnapshot& snapshot : record.cameras) {
        CameraSession* session = session_for_ip_locked(snapshot.ip);
        if (snapshot.attempted && session && session->stream.running) {
          stop_stream_locked(*session);
        }
      }
    }

    bool complete = true;
    int first_error = CORRECT;
    int restored_cameras = 0;
    int failed_cameras = 0;
    int skipped_cameras = 0;
    std::vector<std::string> outcomes(record.cameras.size());
    for (size_t reverse = record.cameras.size(); reverse > 0; --reverse) {
      const size_t index = reverse - 1;
      CalibrationCameraSnapshot& snapshot = record.cameras[index];
      if (!snapshot.attempted) {
        ++skipped_cameras;
        outcomes[index] = "{\"code\":0," + json_pair("ip", snapshot.ip) +
                          "," + json_pair("operationId", operation_id) +
                          ",\"rollbackCode\":0,\"attempted\":false,"
                          "\"rolledBack\":false,\"skipped\":true,"
                          "\"message\":\"camera was not changed by the apply operation\"}";
        continue;
      }
      std::string mode;
      maybe_crash_calibration_failpoint(
          record.operation_id,
          "rollback-before-camera",
          static_cast<int>(index + 1));
      const int ret = rollback_calibration_camera_locked(
          snapshot, token, operation_id, mode);
      maybe_crash_calibration_failpoint(
          record.operation_id,
          "rollback-after-camera",
          static_cast<int>(index + 1));
      if (ret != CORRECT) {
        ++failed_cameras;
        complete = false;
        if (first_error == CORRECT) {
          first_error = ret;
        }
      } else {
        ++restored_cameras;
      }
      std::ostringstream outcome;
      outcome << "{\"code\":" << ret << ","
              << json_pair("operationId", operation_id) << ","
              << json_pair("ip", snapshot.ip) << ","
              << "\"rollbackCode\":" << ret << ","
              << json_pair("rollbackMode", mode) << ","
              << json_pair("rollbackPath", snapshot.rollback_path.string()) << ","
              << "\"runtimeSnapshotAvailable\":"
              << (snapshot.has_runtime_param || snapshot.simulated ? "true" : "false") << ","
              << "\"persistentDeviceRestoreRequested\":"
              << (snapshot.save_to_device ? "true" : "false") << ","
              << "\"attempted\":true,"
              << "\"rolledBack\":" << (ret == CORRECT ? "true" : "false") << ","
              << "\"skipped\":false,"
              << json_pair(
                     "message",
                     ret == CORRECT
                         ? "camera calibration state restored"
                         : "camera calibration rollback returned non-zero")
              << "}";
      outcomes[index] = outcome.str();
    }

    bool profile_restored = !record.profile_changed;
    int profile_code = CORRECT;
    if (record.profile_changed) {
      if (record.profile_before.empty() ||
          !write_text_file(record.profile_path, record.profile_before)) {
        profile_code = CALIBRATION_ROLLBACK_FAILED;
        complete = false;
        if (first_error == CORRECT) {
          first_error = profile_code;
        }
      } else {
        sync_existing_legacy_profile_locked(record.profile_name, record.profile_before);
        profile_restored = true;
      }
    }
    record.consumed = complete;
    record.phase = complete ? "rolled-back" : "rollback-failed";
    if (!persist_calibration_rollback_manifest_locked(record)) {
      complete = false;
      record.consumed = false;
      record.phase = "rolling-back";
      if (first_error == CORRECT) {
        first_error = CALIBRATION_ROLLBACK_FAILED;
      }
    }

    std::ostringstream results;
    results << "[";
    for (size_t index = 0; index < outcomes.size(); ++index) {
      if (index > 0) results << ",";
      results << outcomes[index];
    }
    results << "]";
    const int code = complete
                         ? CORRECT
                         : (first_error == CORRECT ? CALIBRATION_ROLLBACK_FAILED
                                                   : first_error);
    std::ostringstream json;
    json << "{\"schema\":\"steel.capture.calibration-rollback.v1\","
         << "\"code\":" << code << ","
         << json_pair("operationId", operation_id) << ","
         << json_pair("applyOperationId", record.operation_id) << ","
         << json_pair("errorName", capture_error_name(code)) << ","
         << json_pair("operatorHint", capture_error_hint(code)) << ","
         << json_pair("rollbackToken", token) << ","
         << json_pair("createdAt", record.created_at) << ","
         << "\"complete\":" << (complete ? "true" : "false") << ","
         << "\"consumed\":" << (record.consumed ? "true" : "false") << ","
         << "\"applied\":0,"
         << "\"failed\":" << (failed_cameras + (profile_code == CORRECT ? 0 : 1)) << ","
         << "\"skipped\":" << skipped_cameras << ","
         << "\"rolledBack\":" << restored_cameras << ","
         << "\"profileChanged\":" << (record.profile_changed ? "true" : "false") << ","
         << "\"profileRestored\":" << (profile_restored ? "true" : "false") << ","
         << "\"profileCode\":" << profile_code << ","
         << "\"contractCapabilities\":" << calibration_contract_capabilities_json() << ","
         << "\"results\":" << results.str()
         << "}";
    return json.str();
  }

  std::string calibration_load_json(const std::string& body) {
    const std::string ip = json_string_field(body, "ip");
    const std::string path_text = json_string_field(body, "path");
    if (path_text.empty()) {
      return json_error(400, "missing calibration path");
    }
    if (ip.empty()) {
      return json_error(400, "missing camera ip");
    }
    const bool dry_run = json_bool_field(body, "dryRun", false);
    if (!dry_run && json_string_field(body, "confirmation") !=
                        "APPLY CAMERA CALIBRATION") {
      return json_error(CALIBRATION_CONFIRMATION_REQUIRED,
                        "confirmation must equal 'APPLY CAMERA CALIBRATION'");
    }
    std::ostringstream apply;
    apply << "{"
          << json_pair("operationId", json_string_field(body, "operationId")) << ","
          << json_pair("name", json_string_field(body, "name", json_string_field(body, "profile", "default"))) << ","
          << json_pair("path", "") << ","
          << "\"ips\":[" << json_string_value(ip) << "],"
          << "\"expectedCameras\":1,"
          << "\"requireAllMapped\":false,"
          << "\"persistActive\":false,"
          << "\"dryRun\":" << (dry_run ? "true" : "false") << ","
          << "\"atomic\":" << (json_bool_field(body, "atomic", true) ? "true" : "false") << ","
          << "\"stopStreams\":" << (json_bool_field(body, "stopStreams", true) ? "true" : "false") << ","
          << "\"allowExternal\":" << (json_bool_field(body, "allowExternal", false) ? "true" : "false") << ","
          << "\"saveToDevice\":" << (json_bool_field(body, "saveToDevice", false) ? "true" : "false") << ","
          << "\"allowBestEffortDeviceRollback\":"
          << (json_bool_field(body, "allowBestEffortDeviceRollback", false) ? "true" : "false") << ","
          << json_pair("confirmation", dry_run ? "" : "APPLY CAMERA CALIBRATION SET") << ","
          << json_pair("deviceConfirmation", json_string_field(body, "deviceConfirmation")) << ","
          << "\"cameraCalibrations\":[{"
          << json_pair("ip", ip) << ","
          << json_pair("path", path_text) << ","
          << json_pair("artifactType", "camera-sdk") << ","
          << json_pair("expectedSn", json_string_field(body, "expectedSn", json_string_field(body, "sn"))) << ","
          << json_pair("rollbackPath", json_string_field(body, "rollbackPath"))
          << "}]}";
    return calibration_apply_all_json(apply.str());
  }

  std::string roi_load_json(const std::string& body) {
    const std::string ip = json_string_field(body, "ip");
    const std::string path_text = json_string_field(body, "path");
    if (path_text.empty()) {
      return json_error(400, "missing roi path");
    }
    if (json_string_field(body, "confirmation") != "APPLY CAMERA ROI") {
      return json_error(CALIBRATION_CONFIRMATION_REQUIRED,
                        "confirmation must equal 'APPLY CAMERA ROI'");
    }
    std::lock_guard<std::mutex> lock(mutex_);
    const bool allow_external = json_bool_field(body, "allowExternal", false);
    const std::filesystem::path candidate = provider_path_locked(path_text);
    std::filesystem::path resolved;
    if (allow_external) {
      std::error_code error;
      resolved = std::filesystem::canonical(candidate, error);
      if (error || !std::filesystem::is_regular_file(resolved, error) || error) {
        return json_error(404, "roi file not found or not a regular file");
      }
    } else {
      const std::vector<std::filesystem::path> roots{storage_root_, config_root_};
      if (!steel_capture::resolve_allowed_regular_file(candidate, roots, resolved)) {
        return json_error(403, "roi file must resolve under storage/config roots");
      }
    }
    CameraSession* session = session_for_ip_locked(ip);
    if (!session || (!session->device && !session->simulated)) {
      return json_error(DEV_NOT_LINK_ERROR, "camera not connected");
    }
    const std::string sdk_path = resolved.string();
    int ret = session->simulated
                  ? CORRECT
                  : lvm_set_roi_param(session->device, sdk_path.c_str());
    session->calibration.roi_path = sdk_path;
    session->calibration.roi_code = ret;
    session->calibration.roi_time = now_iso();
    append_calibration_maintenance_record_locked(
        "roi-apply", *session, sdk_path, ret);
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
         << json_pair("calibrationArtifactKind", calibration.calibration_artifact_kind) << ","
         << "\"calibrationCode\":" << calibration.calibration_code << ","
         << json_pair("calibrationTime", calibration.calibration_time) << ","
         << json_pair("operationId", calibration.operation_id) << ","
         << json_pair("rollbackToken", calibration.rollback_token) << ","
         << json_pair("rollbackMode", calibration.rollback_mode) << ","
         << "\"rollbackCode\":" << calibration.rollback_code << ","
         << json_pair("rollbackTime", calibration.rollback_time) << ","
         << json_pair("roiPath", calibration.roi_path) << ","
         << "\"roiCode\":" << calibration.roi_code << ","
         << json_pair("roiTime", calibration.roi_time) << ","
         << json_pair("validationPath", calibration.validation_path) << ","
         << "\"validationCode\":" << calibration.validation_code << ","
         << json_pair("validationTime", calibration.validation_time) << ","
         << json_pair(
                "maintenanceRecordPath",
                calibration_maintenance_record_path_locked().string()) << ","
         << "\"contractCapabilities\":" << calibration_contract_capabilities_json()
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
    const bool restart_required = sdk_capture_restart_required();
    for (const auto& item : sessions_) {
      const CameraSession& session = item.second;
      bool connected = false;
      if (session.simulated) {
        connected = session.simulated_connected;
      } else if (session.device) {
        connected = restart_required || lvm_get_dev_connect_status(session.device) == 1;
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
         << json_pair("inspectionId", steel_state_.inspection_id) << ","
         << json_pair("acquisitionMode", steel_state_.acquisition_mode) << ","
         << json_pair("captureMode", steel_state_.capture_mode) << ","
         << "\"automaticCaptureEnabled\":"
         << (continuous_capture_enabled_locked() ? "true" : "false") << ","
         << json_pair("captureSaveState", steel_state_.capture_save_state) << ","
         << json_pair("algorithmPhase", steel_state_.algorithm_phase) << ","
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
         << "\"discardFrameCount\":" << steel_state_.discard_frame_count << ","
         << "\"blackFrameCount\":" << steel_state_.black_frame_count << ","
         << "\"nextCaptureSequence\":" << steel_state_.next_capture_sequence << ","
         << "\"saveEnabled\":" << (steel_state_.save_enabled ? "true" : "false") << ","
         << "\"saveSdkDerivedDefault\":false,"
         << "\"discardBlackFrames\":" << (steel_state_.discard_black_frames ? "true" : "false") << ","
         << "\"blackFrameThreshold\":" << steel_state_.black_frame_threshold << ","
         << "\"connectedCameras\":" << connected_count << ","
         << "\"streamingCameras\":" << streaming_count << ","
         << "\"productionCaptureRunning\":" << (production_capture_running_ ? "true" : "false") << ","
         << json_pair("productionCaptureStartedAt", production_capture_started_at_) << ","
         << json_pair("productionCaptureFinishedAt", production_capture_finished_at_) << ","
         << "\"continuousAcquisitionFrameCount\":" << continuous_acquisition_frame_count_ << ","
         << "\"continuousDiscardedFrameCount\":" << continuous_discarded_frame_count_ << ","
         << json_pair("lastContinuousAcquisitionAt", last_continuous_acquisition_at_) << ","
         << "\"continuousSettings\":" << continuous_settings_status_json_locked() << ","
         << "\"expectedCameras\":" << expected_cameras_ << ","
         << "\"sdkCaptureState\":" << sdk_capture_state_json()
         << "}";
    return json.str();
  }

  void ensure_steel_session_locked(const std::string& now) {
    if (!steel_state_.session_id.empty() && !steel_state_.capture_dir.empty()) {
      return;
    }
    const std::string steel_segment = safe_path_segment(steel_state_.steel_id.empty() ? "unknown-steel" : steel_state_.steel_id);
    if (steel_state_.session_id.empty()) {
      steel_state_.session_id = steel_segment + "-" + timestamp_file_segment();
    }
    std::filesystem::path dir = (storage_root_ / "production" / steel_segment / steel_state_.session_id).lexically_normal();
    steel_state_.capture_dir = dir.string();
    steel_state_.summary_path = (dir / "summary.json").lexically_normal().string();
    steel_state_.session_started_at = now;
    steel_state_.session_finished_at.clear();
    std::error_code error;
    std::filesystem::create_directories(dir, error);
  }

  int reserve_production_sequence_locked() {
    const int sequence = std::max(1, steel_state_.next_capture_sequence);
    steel_state_.next_capture_sequence = sequence + 1;
    return sequence;
  }

  std::string production_capture_output_locked(const std::string& ip) {
    if (steel_state_.capture_dir.empty()) {
      return "";
    }
    return raw_capture_output_locked(
        ip, material_storage_segment_locked(), reserve_production_sequence_locked());
  }

  std::string raw_capture_output_locked(const std::string& ip, const std::string& material_id, int sequence_no) const {
    std::ostringstream sequence;
    sequence << std::setw(6) << std::setfill('0') << std::max(1, sequence_no);
    std::filesystem::path output = camera_capture_root_locked(ip) /
                                   safe_path_segment(material_id.empty() ? "unknown-material" : material_id) /
                                   "depth" /
                                   (sequence.str() + ".png");
    return output.lexically_normal().string();
  }

  std::filesystem::path camera_capture_root_locked(const std::string& ip) const {
    auto root = camera_storage_roots_.find(ip);
    if (root != camera_storage_roots_.end()) {
      return root->second.lexically_normal();
    }
    return (storage_root_ / camera_storage_segment_locked(ip)).lexically_normal();
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
    } else if (code == BLACK_FRAME_DISCARDED) {
      ++steel_state_.discard_frame_count;
      ++steel_state_.black_frame_count;
    } else if (code == CAPTURE_DISCARDED_NOT_ARMED) {
      ++steel_state_.discard_frame_count;
    } else {
      ++steel_state_.capture_failure_count;
    }
    write_steel_summary_locked();
  }

  ProductionCaptureSettings production_capture_settings_from_body(const std::string& body) const {
    ProductionCaptureSettings settings;
    settings.lines = json_int_field(body, "lines", settings.lines);
    settings.width = json_int_field(body, "width", settings.width);
    settings.timeout_ms = json_int_field(body, "timeoutMs", json_int_field(body, "timeout_ms", settings.timeout_ms));
    settings.data_mode = json_int_field(body, "dataMode", json_int_field(body, "data_mode", settings.data_mode));
    settings.retries = std::max(0, std::min(10, json_int_field(body, "retries", settings.retries)));
    settings.control_mode = json_int_field(body, "controlMode", json_int_field(body, "control_mode", settings.control_mode));
    settings.interval_ms = std::max(0, std::min(600000, json_int_field(body, "intervalMs", json_int_field(body, "interval_ms", settings.interval_ms))));
    settings.discard_black_frames = json_bool_field(body, "discardBlackFrames", settings.discard_black_frames);
    settings.save_sdk_derived = json_bool_field(body, "saveSdkDerived", json_bool_field(body, "save_sdk_derived", settings.save_sdk_derived));
    settings.black_frame_threshold = json_float_field(body, "blackFrameThreshold", static_cast<float>(settings.black_frame_threshold));
    return settings;
  }

  static std::string normalize_capture_mode(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
      return static_cast<char>(std::tolower(ch));
    });
    if (value == "continuous" || value == "auto" || value == "automatic") {
      return "continuous";
    }
    if (value == "on-demand" || value == "on_demand" || value == "ondemand" ||
        value == "manual") {
      return "on-demand";
    }
    if (value == "disabled" || value == "off" || value == "stop") {
      return "disabled";
    }
    return "";
  }

  static std::string capture_mode_from_body(const std::string& body) {
    return json_string_field(body, "captureMode", json_string_field(body, "capture_mode"));
  }

  bool continuous_capture_enabled_locked() const {
    return steel_state_.capture_mode == "continuous";
  }

  bool apply_capture_mode_from_body_locked(const std::string& body) {
    const std::string requested = capture_mode_from_body(body);
    if (requested.empty()) {
      return true;
    }
    const std::string capture_mode = normalize_capture_mode(requested);
    if (capture_mode.empty()) {
      return false;
    }
    if (steel_state_.capture_mode != capture_mode) {
      steel_state_.capture_mode = capture_mode;
      if (!continuous_capture_enabled_locked() && production_capture_running_) {
        request_stop_production_capture_worker_locked();
      }
    }
    return true;
  }

  std::string steel_capture_mode_json(const std::string& body) {
    const std::string requested = capture_mode_from_body(body);
    const std::string capture_mode = normalize_capture_mode(requested);
    if (requested.empty() || capture_mode.empty()) {
      return json_error(400, "captureMode must be continuous, on-demand, or disabled");
    }

    std::unique_lock<std::mutex> lock(mutex_);
    const bool changed = steel_state_.capture_mode != capture_mode;
    steel_state_.capture_mode = capture_mode;
    if (!continuous_capture_enabled_locked()) {
      if (production_capture_running_) {
        request_stop_production_capture_worker_locked();
        if (!production_capture_cv_.wait_for(
                lock,
                std::chrono::seconds(15),
                [this]() { return !production_capture_running_; })) {
          return json_error(409, "continuous acquisition did not stop before capture mode change");
        }
      }
      if (steel_state_.present &&
          !(driver_mode_ != DriverMode::Simulated && sdk_capture_restart_required())) {
        steel_state_.phase = "steel-in-waiting-images";
      }
    } else if (!production_capture_running_ && !connected_capture_ips_locked().empty() &&
               (driver_mode_ == DriverMode::Simulated || !sdk_capture_restart_required())) {
      start_production_capture_worker_locked("{}");
      if (steel_state_.present && steel_state_.save_enabled) {
        steel_state_.phase = "steel-in-saving";
      }
    }
    steel_state_.updated_at = now_iso();
    write_steel_summary_locked();

    std::string status = steel_status_json_locked();
    status.pop_back();
    status += ",";
    status += "\"captureModeChanged\":";
    status += changed ? "true" : "false";
    status += "}";
    return status;
  }

  bool should_auto_start_production_capture_locked(const std::string& body) const {
    if (!continuous_capture_enabled_locked()) {
      return false;
    }
    std::string mode = steel_state_.acquisition_mode;
    std::transform(mode.begin(), mode.end(), mode.begin(), [](unsigned char ch) {
      return static_cast<char>(std::tolower(ch));
    });
    const bool external_mode = mode.find("external") != std::string::npos ||
                               mode.find("hardware") != std::string::npos ||
                               mode.find("plc") != std::string::npos;
    return json_bool_field(body, "autoCapture", !external_mode);
  }

  std::vector<std::string> connected_capture_ips_locked() const {
    std::vector<std::string> ips;
    ips.reserve(sessions_.size());
    for (const auto& item : sessions_) {
      const CameraSession& session = item.second;
      if (session.device || session.simulated_connected) {
        ips.push_back(session.ip.empty() ? item.first : session.ip);
      }
    }
    std::sort(ips.begin(), ips.end());
    return ips;
  }

  void start_production_capture_worker_locked(const std::string& body) {
    if (production_capture_running_) {
      return;
    }
    if (driver_mode_ != DriverMode::Simulated &&
        sdk_capture_restart_required()) {
      return;
    }
    stop_all_streams_locked();
    ProductionCaptureSettings settings = production_capture_settings_from_body(body);
    production_capture_stop_.store(false);
    const unsigned long long generation = production_capture_generation_.fetch_add(1) + 1;
    production_capture_running_ = true;
    production_capture_started_at_ = now_iso();
    production_capture_finished_at_.clear();
    std::thread([this, generation, settings]() {
      production_capture_loop(generation, settings);
    }).detach();
  }

  void request_stop_production_capture_worker_locked() {
    production_capture_stop_.store(true);
    production_capture_generation_.fetch_add(1);
  }

  void production_capture_loop(unsigned long long generation, ProductionCaptureSettings settings) {
    const int worker_timeout_ms = std::max(1000, std::min(600000, settings.timeout_ms * (settings.retries + 1) + 5000));
    std::deque<PendingParallelCapture> pending_tickets;
    auto finalize_front = [&]() {
      static_cast<void>(finalize_pending_capture(std::move(pending_tickets.front())));
      pending_tickets.pop_front();
    };
    auto reap_ready = [&]() {
      while (!pending_tickets.empty() && pending_capture_ready(pending_tickets.front())) {
        finalize_front();
      }
    };
    while (true) {
      reap_ready();
      std::vector<std::string> ips;
      std::string material_id;
      int round = 0;
      bool persist_frame = false;
      unsigned long long production_save_generation = 0;
      bool paused_for_maintenance = false;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (production_capture_stop_.load() ||
            generation != production_capture_generation_.load() ||
            (driver_mode_ != DriverMode::Simulated &&
             sdk_capture_restart_required())) {
          break;
        }
        paused_for_maintenance = active_capture_batches_ > 0;
        if (!paused_for_maintenance) {
          ips = connected_capture_ips_locked();
          persist_frame = steel_state_.save_enabled && steel_state_.present;
          if (persist_frame) {
            material_id = material_storage_segment_locked();
            round = reserve_production_sequence_locked();
            production_save_generation = production_save_generation_;
          } else {
            round = ++continuous_acquisition_round_;
          }
        }
      }

      if (paused_for_maintenance) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        continue;
      }
      if (ips.empty()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(250));
        continue;
      }

      std::vector<ParallelCaptureJob> jobs;
      jobs.reserve(ips.size());
      const std::string round_started_at = now_iso();
      for (size_t index = 0; index < ips.size(); ++index) {
        ParallelCaptureJob job;
        job.ip = ips[index];
        if (persist_frame) {
          std::lock_guard<std::mutex> lock(mutex_);
          job.output = raw_capture_output_locked(job.ip, material_id, round);
        }
        job.round = round;
        job.attempt = round;
        job.parallel_index = static_cast<int>(index);
        job.round_started_at = round_started_at;
        job.lines = settings.lines;
        job.width = settings.width;
        job.timeout_ms = settings.timeout_ms;
        job.data_mode = settings.data_mode;
        job.retries = settings.retries;
        job.control_mode = settings.control_mode;
        job.discard_black_frames = settings.discard_black_frames;
        job.save_sdk_derived = settings.save_sdk_derived;
        job.persist_frame = persist_frame;
        job.production_continuous = true;
        job.production_save_generation = production_save_generation;
        job.black_frame_threshold = settings.black_frame_threshold;
        jobs.push_back(job);
      }

      std::vector<PendingParallelCapture> round_pending = run_parallel_capture_round(
          std::move(jobs),
          worker_timeout_ms,
          "production capture worker exceeded hard timeout");
      reap_ready();
      for (auto& pending : round_pending) {
        while (pending_tickets.size() >= storage_pending_ticket_limit_) {
          finalize_front();
        }
        pending_tickets.push_back(std::move(pending));
        reap_ready();
      }

      if (settings.interval_ms > 0) {
        const auto interval_deadline =
            std::chrono::steady_clock::now() + std::chrono::milliseconds(settings.interval_ms);
        while (std::chrono::steady_clock::now() < interval_deadline &&
               !production_capture_stop_.load() &&
               generation == production_capture_generation_.load()) {
          reap_ready();
          std::this_thread::sleep_for(std::chrono::milliseconds(25));
        }
      }
    }

    while (!pending_tickets.empty()) {
      finalize_front();
    }

    {
      std::lock_guard<std::mutex> lock(mutex_);
      production_capture_running_ = false;
      production_capture_finished_at_ = now_iso();
      if (driver_mode_ != DriverMode::Simulated &&
          sdk_capture_restart_required()) {
        steel_state_.phase = "sdk-restart-required";
      }
      steel_state_.updated_at = production_capture_finished_at_;
      write_steel_summary_locked();
    }
    production_capture_cv_.notify_all();
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
    if (!apply_capture_mode_from_body_locked(body)) {
      return json_error(400, "captureMode must be continuous, on-demand, or disabled");
    }

    if (cmd == "steelIn" || cmd == "steel_in" || cmd == "in") {
      const int value = json_int_field(body, "value", json_bool_field(body, "present", true) ? 1 : 0);
      update_steel_info_locked(body, now);
      if (value != 0) {
        if (!steel_state_.present || steel_state_.session_id.empty()) {
          ++production_save_generation_;
          ensure_steel_session_locked(now);
        }
        steel_state_.inspection_id = json_string_field(body, "inspectionId", json_string_field(body, "inspection_id", steel_state_.inspection_id));
        steel_state_.acquisition_mode = json_string_field(body, "acquisitionMode",
                                      json_string_field(body, "acquisition_mode",
                                      json_string_field(body, "triggerMode", steel_state_.acquisition_mode)));
        steel_state_.capture_save_state = json_string_field(body, "captureSaveState", "save");
        steel_state_.save_enabled = json_bool_field(body, "saveEnabled", true);
        steel_state_.discard_black_frames = json_bool_field(body, "discardBlackFrames", steel_state_.discard_black_frames);
        steel_state_.black_frame_threshold = json_float_field(body, "blackFrameThreshold", static_cast<float>(steel_state_.black_frame_threshold));
        steel_state_.algorithm_phase = json_string_field(body, "algorithmPhase", "pending");
        steel_state_.present = true;
        const bool sdk_blocked = driver_mode_ != DriverMode::Simulated &&
                                 sdk_capture_restart_required();
        const bool auto_capture = should_auto_start_production_capture_locked(body) &&
                                  !sdk_blocked;
        steel_state_.phase = sdk_blocked
                                 ? "sdk-restart-required"
                                 : (auto_capture ? "steel-in-saving"
                                                 : "steel-in-waiting-images");
        steel_state_.in_time = now;
        steel_state_.updated_at = now;
        ++steel_state_.in_count;
        if (auto_capture) {
          start_production_capture_worker_locked(body);
        }
      } else {
        ++production_save_generation_;
        steel_state_.present = false;
        steel_state_.phase = "steel-out";
        steel_state_.capture_save_state = json_string_field(body, "captureSaveState", "discard");
        steel_state_.save_enabled = false;
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
      if (continuous_capture_enabled_locked() && !production_capture_running_ &&
          (driver_mode_ == DriverMode::Simulated || !sdk_capture_restart_required())) {
        start_production_capture_worker_locked(body);
      }
    } else if (cmd == "reset" || cmd == "clear") {
      request_stop_production_capture_worker_locked();
      const std::string capture_mode = steel_state_.capture_mode;
      steel_state_ = SteelState{};
      steel_state_.capture_mode = capture_mode;
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
    if (phase == "steel-in-waiting-images") return "steel-in-waiting-images";
    if (phase == "steel-in-saving") return "steel-in-saving";
    if (phase == "sdk-restart-required") return "sdk-restart-required";
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
    std::string session_id = json_string_field(body, "sessionId", json_string_field(body, "session_id"));
    if (!session_id.empty()) {
      session_id = safe_path_segment(session_id);
      if (steel_state_.session_id != session_id) {
        steel_state_.session_id = session_id;
        steel_state_.capture_dir.clear();
        steel_state_.summary_path.clear();
        steel_state_.session_started_at.clear();
        steel_state_.session_finished_at.clear();
        steel_state_.next_capture_sequence = 1;
      }
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

  void record_capture_log(const std::string& level,
                          const std::string& camera_ip,
                          const std::string& message) {
    std::lock_guard<std::mutex> lock(mutex_);
    capture_logs_.push_front({now_iso(), level, camera_ip, message});
    constexpr std::size_t kCaptureLogLimit = 200;
    while (capture_logs_.size() > kCaptureLogLimit) {
      capture_logs_.pop_back();
    }
  }

  std::string capture_logs_json() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::ostringstream json;
    json << "{\"events\":[";
    for (std::size_t index = 0; index < capture_logs_.size(); ++index) {
      const CaptureLogEntry& event = capture_logs_[index];
      if (index != 0) json << ",";
      json << "{" << json_pair("id", "provider-" + std::to_string(index + 1)) << ","
           << json_pair("time", event.time) << ","
           << json_pair("level", event.level) << ","
           << json_pair("source", "provider-log") << ","
           << json_pair("cameraIp", event.camera_ip) << ","
           << json_pair("message", event.message) << "}";
    }
    json << "]}";
    return json.str();
  }

  std::mutex mutex_;
  struct CaptureLogEntry {
    std::string time;
    std::string level;
    std::string camera_ip;
    std::string message;
  };
  std::deque<CaptureLogEntry> capture_logs_;
  DriverMode driver_mode_ = DriverMode::Lvm;
  bool sdk_ready_ = false;
  bool sdk_initialized_here_ = false;
  std::atomic<bool> shutting_down_{false};
  std::atomic<bool> sdk_capture_poisoned_{false};
  mutable std::mutex sdk_capture_state_mutex_;
  std::string sdk_capture_poisoned_at_;
  std::string sdk_capture_poison_reason_;
  steel_capture::OwnedWorkerRegistry owned_capture_workers_;
  std::filesystem::path storage_root_;
  std::filesystem::path config_root_;
  std::map<std::string, std::filesystem::path> camera_storage_roots_;
  int expected_cameras_ = 6;
  std::string simulated_image_source_dir_;
  std::string simulated_calibration_fail_ip_;
  SteelState steel_state_;
  std::map<std::string, CameraSession> sessions_;
  std::map<std::string, CalibrationRollbackRecord> calibration_rollbacks_;
  bool calibration_rollback_manifest_set_valid_ = true;
  std::atomic<unsigned long long> calibration_rollback_counter_{0};
  int storage_enqueue_timeout_ms_ = 2000;
  std::size_t storage_pending_ticket_limit_ =
      steel_capture::StorageThreadPool::kDefaultMaxPendingItems;
  int simulated_storage_delay_ms_ = 0;
  std::mutex offline_depth_save_mutex_;
  mutable steel_capture::StorageThreadPool storage_pool_;
  std::atomic<unsigned long long> frame_write_ticket_counter_{0};
  int active_capture_batches_ = 0;
  std::atomic<unsigned long long> production_capture_generation_{0};
  unsigned long long production_save_generation_ = 0;
  std::atomic<bool> production_capture_stop_{false};
  bool production_capture_running_ = false;
  std::condition_variable production_capture_cv_;
  std::string production_capture_started_at_;
  std::string production_capture_finished_at_;
  int continuous_acquisition_round_ = 0;
  unsigned long long continuous_acquisition_frame_count_ = 0;
  unsigned long long continuous_discarded_frame_count_ = 0;
  std::string last_continuous_acquisition_at_;
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
  if (!result.body.empty()) {
    chunk.DataChunkType = HttpDataChunkFromMemory;
    chunk.FromMemory.pBuffer = const_cast<char*>(result.body.data());
    chunk.FromMemory.BufferLength = static_cast<ULONG>(result.body.size());
    response.EntityChunkCount = 1;
    response.pEntityChunks = &chunk;
  }

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

  if (!g_running.load(std::memory_order_acquire)) {
    closesocket(client);
    return;
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
  int exit_code = 0;
  while (g_running.load()) {
    fd_set readable{};
    FD_ZERO(&readable);
    FD_SET(server, &readable);
    timeval timeout{};
    timeout.tv_sec = 0;
    timeout.tv_usec = 250000;
    const int select_result = select(0, &readable, nullptr, nullptr, &timeout);
    if (select_result == SOCKET_ERROR) {
      if (!g_running.load(std::memory_order_acquire)) {
        break;
      }
      std::cerr << "socket select failed: " << WSAGetLastError() << "\n";
      exit_code = 1;
      break;
    }
    if (select_result == 0) {
      continue;
    }
    SOCKET client = accept(server, nullptr, nullptr);
    if (client == INVALID_SOCKET) {
      if (!g_running.load(std::memory_order_acquire)) {
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(25));
      continue;
    }
    DWORD socket_timeout_ms = 1000;
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO,
               reinterpret_cast<const char*>(&socket_timeout_ms), sizeof(socket_timeout_ms));
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO,
               reinterpret_cast<const char*>(&socket_timeout_ms), sizeof(socket_timeout_ms));
    g_socket_clients.fetch_add(1, std::memory_order_acq_rel);
    try {
      std::thread([client]() {
        SocketClientCountGuard client_count;
        try {
          handle_socket_client(client);
        } catch (const std::exception& ex) {
          closesocket(client);
          std::cerr << "socket client failed: " << ex.what() << "\n";
        } catch (...) {
          closesocket(client);
          std::cerr << "socket client failed with an unknown error.\n";
        }
      }).detach();
    } catch (const std::exception& ex) {
      g_socket_clients.fetch_sub(1, std::memory_order_acq_rel);
      closesocket(client);
      std::cerr << "cannot start socket client thread: " << ex.what() << "\n";
    }
  }

  closesocket(server);
  const auto client_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (g_socket_clients.load(std::memory_order_acquire) != 0 &&
         std::chrono::steady_clock::now() < client_deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(25));
  }
  if (g_socket_clients.load(std::memory_order_acquire) != 0) {
    std::cerr << "Socket clients did not drain before Winsock shutdown; immediate process exit required.\n";
    g_process_exit_required.store(true, std::memory_order_release);
    return 4;
  }
  WSACleanup();
  return exit_code;
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
  auto cleanup_http_server = [&]() {
    if (queue) {
      HttpCloseRequestQueue(queue);
      queue = nullptr;
    }
    if (group) {
      HttpCloseUrlGroup(group);
      group = 0;
    }
    if (session) {
      HttpCloseServerSession(session);
      session = 0;
    }
    HttpTerminate(HTTP_INITIALIZE_SERVER, nullptr);
  };
  result = HttpCreateServerSession(version, &session, 0);
  if (result == NO_ERROR) result = HttpCreateUrlGroup(session, &group, 0);
  if (result == NO_ERROR) result = HttpCreateRequestQueue(version, nullptr, nullptr, 0, &queue);
  if (result != NO_ERROR) {
    std::cerr << "HTTP server setup failed: " << result << "\n";
    cleanup_http_server();
    return 1;
  }

  HTTP_BINDING_INFO binding{};
  binding.Flags.Present = 1;
  binding.RequestQueueHandle = queue;
  result = HttpSetUrlGroupProperty(group, HttpServerBindingProperty, &binding, sizeof(binding));
  if (result != NO_ERROR) {
    std::cerr << "HttpSetUrlGroupProperty failed: " << result << "\n";
    cleanup_http_server();
    return 1;
  }

  std::string prefix_utf8 = "http://127.0.0.1:" + std::to_string(port) + "/";
  std::wstring prefix = widen(prefix_utf8);
  result = HttpAddUrlToUrlGroup(group, prefix.c_str(), 0, 0);
  if (result != NO_ERROR) {
    std::cerr << "HttpAddUrlToUrlGroup failed: " << result << "\n";
    std::cerr << "Try running as administrator or reserve the URL with netsh.\n";
    cleanup_http_server();
    return 1;
  }

  std::cout << "steel_capture_service listening on " << prefix_utf8 << "\n";
  std::vector<char> request_buffer(sizeof(HTTP_REQUEST) + 16384);
  HANDLE stop_event = g_console_stop_event.load(std::memory_order_acquire);
  std::thread stop_watcher;
  if (stop_event) {
    stop_watcher = std::thread([queue, stop_event]() {
      if (WaitForSingleObject(stop_event, INFINITE) == WAIT_OBJECT_0) {
        HttpShutdownRequestQueue(queue);
      }
    });
  }
  std::exception_ptr server_error;
  try {
    while (g_running.load()) {
      auto* request = reinterpret_cast<PHTTP_REQUEST>(request_buffer.data());
      RtlZeroMemory(request, request_buffer.size());
      ULONG bytes = 0;
      result = HttpReceiveHttpRequest(queue, HTTP_NULL_ID, 0, request,
                                      static_cast<ULONG>(request_buffer.size()), &bytes, nullptr);
      if (result != NO_ERROR) {
        if (!g_running.load(std::memory_order_acquire)) break;
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
      if (!g_running.load(std::memory_order_acquire)) {
        break;
      }
      RouteResult route_result = CaptureRuntime::instance().route(method, path, query, body);
      send_response(queue, request->RequestId, route_result);
    }
  } catch (...) {
    server_error = std::current_exception();
    g_running.store(false, std::memory_order_release);
    if (stop_event) {
      SetEvent(stop_event);
    }
  }

  if (stop_watcher.joinable()) {
    stop_watcher.join();
  }

  HttpRemoveUrlFromUrlGroup(group, prefix.c_str(), 0);
  cleanup_http_server();
  if (server_error) {
    std::rethrow_exception(server_error);
  }
  return 0;
}

}  // namespace

int run_capture_service_app(int argc, char** argv) {
  int port = 4317;
  const char* driver_environment = std::getenv("CAPTURE_DRIVER");
  bool force_driver_mode = driver_environment && *driver_environment;
  DriverMode driver_mode = parse_driver_mode(
      force_driver_mode ? driver_environment : "", DriverMode::Lvm);
  for (int i = 1; i + 1 < argc; ++i) {
    if (std::string(argv[i]) == "--port") {
      port = std::stoi(argv[i + 1]);
    } else if (std::string(argv[i]) == "--driver" || std::string(argv[i]) == "--driver-mode") {
      driver_mode = parse_driver_mode(argv[i + 1], driver_mode);
      force_driver_mode = true;
    }
  }

  CaptureSdkOwnerMutex sdk_owner;
  // The simulated driver never loads or calls the vendor SDK. Keeping it out
  // of the global SDK-owner mutex lets isolated regression fixtures run while
  // the real production provider remains online, without weakening ownership
  // for either real SDK mode.
  if (driver_mode != DriverMode::Simulated && !sdk_owner.try_acquire()) {
    std::cerr << "steel_capture_service cannot start: " << sdk_owner.error() << ".\n"
              << "SDK owner mutex: Global\\SteelPlate3DInspection.CaptureSdkOwner.v1\n";
    return 2;
  }

  CaptureConsoleStopHandler stop_handler;
  if (!stop_handler.install()) {
    std::cerr << "steel_capture_service cannot start: " << stop_handler.error() << ".\n";
    return 3;
  }

  CaptureRuntime& runtime = CaptureRuntime::instance();
  int exit_code = 1;
  try {
    runtime.configure(driver_mode, force_driver_mode);
    exit_code = run_server(port);
  } catch (const std::exception& ex) {
    std::cerr << "steel_capture_service failed: " << ex.what() << "\n";
  } catch (...) {
    std::cerr << "steel_capture_service failed with an unknown error.\n";
  }

  const bool clean_shutdown = runtime.shutdown();
#ifdef _WIN32
  stop_handler.signal_shutdown_complete();
#endif
  if (!clean_shutdown) {
    std::cerr << "steel_capture_service is terminating without static destruction because SDK cleanup is unsafe.\n";
    std::cout.flush();
    std::cerr.flush();
    std::_Exit(exit_code == 0 ? 4 : exit_code);
  }
#ifdef _WIN32
  const DWORD stop_reason = g_console_stop_reason.load(std::memory_order_relaxed);
  if (stop_reason != 0) {
    std::cout << "steel_capture_service stopped after console control event "
              << stop_reason << ".\n";
  }
#endif
  return exit_code;
}
