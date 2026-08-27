#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdio>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <iterator>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "runtime_supervisor_recovery_policy.h"

namespace fs = std::filesystem;

namespace {

constexpr wchar_t kServiceName[] = L"SteelInspectionRuntime";
constexpr DWORD kStopTimeoutMs = 30000;
constexpr DWORD kDrainTimeoutMs = 60000;
constexpr DWORD kDrainPollMs = 250;
constexpr DWORD kManagedRecoveryPollMs = 2000;
constexpr int kManagedRecoveryConfirmations = 2;
constexpr DWORD kRestartBudgetWindowSeconds = 10 * 60;
constexpr std::size_t kRestartBudgetMaximum = 5;
constexpr DWORD kRestartBudgetRecoveryStableSeconds = 30;
constexpr std::uintmax_t kLogRotateBytes = 50ULL * 1024ULL * 1024ULL;
constexpr int kLogGenerations = 5;

SERVICE_STATUS_HANDLE g_status_handle = nullptr;
SERVICE_STATUS g_status{};
HANDLE g_stop_event = nullptr;
fs::path g_runtime_root;
fs::path g_state_root;

struct ChildSpec {
  std::wstring name;
  fs::path executable;
  fs::path working_directory;
  std::wstring arguments;
  unsigned short readiness_port = 0;
  std::string readiness_path;
  std::string readiness_marker;
  DWORD stop_timeout_ms = 15000;
};

struct ChildProcess {
  ChildSpec spec;
  PROCESS_INFORMATION process{};
  HANDLE job_handle = nullptr;
  HANDLE log_thread = nullptr;
};

bool rotate_log(const fs::path &path, std::string *error_message = nullptr, bool force = false);

std::wstring quote(const std::wstring &value) {
  std::wstring escaped;
  escaped.reserve(value.size() + 2);
  escaped.push_back(L'"');
  std::size_t slashes = 0;
  for (wchar_t ch : value) {
    if (ch == L'\\') {
      ++slashes;
      continue;
    }
    if (ch == L'"') {
      escaped.append(slashes * 2 + 1, L'\\');
      escaped.push_back(L'"');
      slashes = 0;
      continue;
    }
    escaped.append(slashes, L'\\');
    slashes = 0;
    escaped.push_back(ch);
  }
  escaped.append(slashes * 2, L'\\');
  escaped.push_back(L'"');
  return escaped;
}

std::string narrow(const std::wstring &value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(),
                                       static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string output(static_cast<std::size_t>(std::max(0, size)), '\0');
  if (size > 0) {
    WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
                        output.data(), size, nullptr, nullptr);
  }
  return output;
}

void append_supervisor_log(const std::string &message) {
  try {
    const fs::path log_dir = g_state_root / "logs";
    fs::create_directories(log_dir);
    const fs::path log_path = log_dir / "supervisor.log";
    rotate_log(log_path);
    std::ofstream stream(log_path, std::ios::app);
    SYSTEMTIME time{};
    GetSystemTime(&time);
    stream << time.wYear << '-' << time.wMonth << '-' << time.wDay << 'T'
           << time.wHour << ':' << time.wMinute << ':' << time.wSecond << "Z "
           << message << '\n';
  } catch (...) {
  }
}

std::string json_escape(const std::string &value) {
  std::string escaped;
  escaped.reserve(value.size() + 16);
  for (const unsigned char ch : value) {
    switch (ch) {
      case '"':
        escaped += "\\\"";
        break;
      case '\\':
        escaped += "\\\\";
        break;
      case '\b':
        escaped += "\\b";
        break;
      case '\f':
        escaped += "\\f";
        break;
      case '\n':
        escaped += "\\n";
        break;
      case '\r':
        escaped += "\\r";
        break;
      case '\t':
        escaped += "\\t";
        break;
      default:
        if (ch < 0x20) {
          constexpr char hex[] = "0123456789abcdef";
          escaped += "\\u00";
          escaped.push_back(hex[(ch >> 4) & 0x0f]);
          escaped.push_back(hex[ch & 0x0f]);
        } else {
          escaped.push_back(static_cast<char>(ch));
        }
    }
  }
  return escaped;
}

std::string utc_timestamp() {
  SYSTEMTIME time{};
  GetSystemTime(&time);
  char buffer[32]{};
  std::snprintf(buffer, sizeof(buffer), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
                time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute,
                time.wSecond, time.wMilliseconds);
  return buffer;
}

fs::path supervisor_status_path() {
  return g_state_root / "service" / "supervisor-status.json";
}

bool write_supervisor_status(const std::string &status, bool budget_exhausted,
                             std::size_t restart_count, const std::string &reason,
                             std::string *error_message = nullptr) {
  try {
    const fs::path target = supervisor_status_path();
    fs::create_directories(target.parent_path());
    const fs::path temporary =
        target.wstring() + L".tmp-" + std::to_wstring(GetCurrentProcessId());
    {
      std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
      if (!stream) {
        if (error_message) *error_message = "cannot create supervisor status temporary file";
        return false;
      }
      stream << "{\n"
             << "  \"schema\":\"steel.runtime-supervisor.status.v1\",\n"
             << "  \"status\":\"" << json_escape(status) << "\",\n"
             << "  \"restartBudgetExhausted\":"
             << (budget_exhausted ? "true" : "false") << ",\n"
             << "  \"restartCountWindow\":" << restart_count << ",\n"
             << "  \"restartBudgetMaximum\":" << kRestartBudgetMaximum << ",\n"
             << "  \"restartBudgetWindowSeconds\":" << kRestartBudgetWindowSeconds
             << ",\n"
             << "  \"recoveryStableSeconds\":"
             << kRestartBudgetRecoveryStableSeconds << ",\n"
             << "  \"reason\":\"" << json_escape(reason) << "\",\n"
             << "  \"updatedAt\":\"" << utc_timestamp() << "\"\n"
             << "}\n";
      stream.flush();
      if (!stream) {
        if (error_message) *error_message = "cannot flush supervisor status temporary file";
        return false;
      }
    }
    if (!MoveFileExW(temporary.c_str(), target.c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
      const DWORD code = GetLastError();
      DeleteFileW(temporary.c_str());
      if (error_message) {
        *error_message = "cannot atomically publish supervisor status error=" +
                         std::to_string(code);
      }
      return false;
    }
    return true;
  } catch (const std::exception &error) {
    if (error_message) *error_message = error.what();
    return false;
  }
}

bool prior_restart_budget_exhausted() {
  try {
    std::ifstream stream(supervisor_status_path(), std::ios::binary);
    if (!stream) return false;
    const std::string text((std::istreambuf_iterator<char>(stream)),
                           std::istreambuf_iterator<char>());
    return text.find("\"schema\":\"steel.runtime-supervisor.status.v1\"") !=
               std::string::npos &&
           steel_runtime::json_boolean_field(text, "restartBudgetExhausted")
               .value_or(false);
  } catch (...) {
    return false;
  }
}

void publish_supervisor_status(const std::string &status, bool budget_exhausted,
                               std::size_t restart_count,
                               const std::string &reason) {
  std::string error;
  if (!write_supervisor_status(status, budget_exhausted, restart_count, reason,
                               &error)) {
    append_supervisor_log("supervisor status persistence failed: " + error);
  }
}

bool rotate_log(const fs::path &path, std::string *error_message, bool force) {
  std::error_code error;
  if (!fs::exists(path, error)) return true;
  const auto size = fs::file_size(path, error);
  if (error) {
    if (error_message) *error_message = "cannot inspect log before rotation: " + error.message();
    return false;
  }
  if (!force && size < kLogRotateBytes) return true;
  fs::remove(path.wstring() + L"." + std::to_wstring(kLogGenerations), error);
  error.clear();
  for (int generation = kLogGenerations - 1; generation >= 1; --generation) {
    const fs::path from = path.wstring() + L"." + std::to_wstring(generation);
    const fs::path to = path.wstring() + L"." + std::to_wstring(generation + 1);
    if (fs::exists(from, error)) {
      error.clear();
      fs::rename(from, to, error);
      if (error) {
        if (error_message) *error_message = "cannot advance log generation: " + error.message();
        return false;
      }
    }
    error.clear();
  }
  fs::rename(path, path.wstring() + L".1", error);
  if (error) {
    if (error_message) *error_message = "cannot rotate active log: " + error.message();
    return false;
  }
  return true;
}

class RotatingLogWriter {
 public:
  explicit RotatingLogWriter(fs::path path) : path_(std::move(path)) {}
  ~RotatingLogWriter() { close(); }

  bool prepare(std::string &error) { return ensure_open(error); }

  bool write(const char *data, std::size_t length, std::string &error) {
    while (length > 0) {
      if (!ensure_open(error)) return false;
      const std::uintmax_t available = kLogRotateBytes - size_;
      const DWORD chunk = static_cast<DWORD>(
          std::min<std::uintmax_t>(available, std::min<std::size_t>(length, 64 * 1024)));
      DWORD written = 0;
      if (chunk == 0 || !WriteFile(handle_, data, chunk, &written, nullptr) || written == 0) {
        error = "cannot append child log, error=" + std::to_string(GetLastError());
        return false;
      }
      data += written;
      length -= written;
      size_ += written;
      if (size_ >= kLogRotateBytes && !rotate(error)) return false;
    }
    return true;
  }

 private:
  bool ensure_open(std::string &error) {
    if (handle_ != INVALID_HANDLE_VALUE) return true;
    std::error_code fs_error;
    fs::create_directories(path_.parent_path(), fs_error);
    if (fs_error) {
      error = "cannot create child log directory: " + fs_error.message();
      return false;
    }
    if (!rotate_log(path_, &error)) return false;
    handle_ = CreateFileW(path_.c_str(), FILE_APPEND_DATA,
                          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                          OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle_ == INVALID_HANDLE_VALUE) {
      error = "cannot open child log, error=" + std::to_string(GetLastError());
      return false;
    }
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(handle_, &size) || size.QuadPart < 0) {
      error = "cannot read child log size, error=" + std::to_string(GetLastError());
      close();
      return false;
    }
    size_ = static_cast<std::uintmax_t>(size.QuadPart);
    return true;
  }

  bool rotate(std::string &error) {
    close();
    if (!rotate_log(path_, &error)) return false;
    return ensure_open(error);
  }

  void close() {
    if (handle_ != INVALID_HANDLE_VALUE) {
      FlushFileBuffers(handle_);
      CloseHandle(handle_);
      handle_ = INVALID_HANDLE_VALUE;
    }
    size_ = 0;
  }

  fs::path path_;
  HANDLE handle_ = INVALID_HANDLE_VALUE;
  std::uintmax_t size_ = 0;
};

struct LogPumpContext {
  HANDLE read_handle = INVALID_HANDLE_VALUE;
  fs::path path;
};

DWORD WINAPI log_pump_main(LPVOID raw_context) {
  std::unique_ptr<LogPumpContext> context(static_cast<LogPumpContext *>(raw_context));
  RotatingLogWriter writer(context->path);
  std::vector<char> buffer(64 * 1024);
  std::string error;
  for (;;) {
    DWORD read = 0;
    if (!ReadFile(context->read_handle, buffer.data(), static_cast<DWORD>(buffer.size()), &read,
                  nullptr)) {
      const DWORD code = GetLastError();
      if (code != ERROR_BROKEN_PIPE && code != ERROR_OPERATION_ABORTED) {
        append_supervisor_log("child log pipe read failed error=" + std::to_string(code));
      }
      break;
    }
    if (read == 0) break;
    if (!writer.write(buffer.data(), read, error)) {
      append_supervisor_log("child log pump failed for " + context->path.string() + ": " + error);
      break;
    }
  }
  CloseHandle(context->read_handle);
  context->read_handle = INVALID_HANDLE_VALUE;
  return 0;
}

void finish_log_pump(HANDLE &thread_handle) {
  if (!thread_handle) return;
  if (WaitForSingleObject(thread_handle, 5000) == WAIT_TIMEOUT) {
    CancelSynchronousIo(thread_handle);
    WaitForSingleObject(thread_handle, 5000);
  }
  CloseHandle(thread_handle);
  thread_handle = nullptr;
}

void remove_log_test_files(const fs::path &path) {
  std::error_code error;
  fs::remove(path, error);
  for (int generation = 1; generation <= kLogGenerations + 1; ++generation) {
    error.clear();
    fs::remove(path.wstring() + L"." + std::to_wstring(generation), error);
  }
}

bool log_rotation_self_test() {
  const fs::path path = g_state_root / "logs" / "rotation-self-test.log";
  fs::create_directories(path.parent_path());
  remove_log_test_files(path);
  std::string error;
  {
    RotatingLogWriter writer(path);
    if (!writer.prepare(error)) {
      std::cerr << error << '\n';
      return false;
    }
    std::vector<char> chunk(64 * 1024, 'L');
    std::uintmax_t remaining = kLogRotateBytes - 1;
    while (remaining > 0) {
      const std::size_t count = static_cast<std::size_t>(
          std::min<std::uintmax_t>(remaining, chunk.size()));
      if (!writer.write(chunk.data(), count, error)) {
        std::cerr << error << '\n';
        return false;
      }
      remaining -= count;
    }
    if (fs::exists(path.wstring() + L".1") || fs::file_size(path) != kLogRotateBytes - 1) {
      std::cerr << "below-threshold log unexpectedly rotated\n";
      return false;
    }
    const char final_byte = 'R';
    if (!writer.write(&final_byte, 1, error)) {
      std::cerr << error << '\n';
      return false;
    }
    if (!fs::exists(path.wstring() + L".1") ||
        fs::file_size(path.wstring() + L".1") != kLogRotateBytes ||
        !fs::exists(path) || fs::file_size(path) != 0) {
      std::cerr << "threshold log did not rotate while writer remained active\n";
      return false;
    }
  }
  remove_log_test_files(path);
  for (int rotation = 0; rotation < kLogGenerations + 1; ++rotation) {
    {
      std::ofstream stream(path, std::ios::binary | std::ios::trunc);
      stream << rotation;
    }
    if (!rotate_log(path, &error, true)) {
      std::cerr << error << '\n';
      return false;
    }
  }
  for (int generation = 1; generation <= kLogGenerations; ++generation) {
    if (!fs::exists(path.wstring() + L"." + std::to_wstring(generation))) {
      std::cerr << "missing retained log generation " << generation << '\n';
      return false;
    }
  }
  if (fs::exists(path.wstring() + L"." + std::to_wstring(kLogGenerations + 1))) {
    std::cerr << "log retention exceeded configured generations\n";
    return false;
  }
  remove_log_test_files(path);
  std::cout << "log-below-threshold=passed log-live-rotation=passed log-generations=5\n";
  return true;
}

std::string trim(std::string value) {
  const auto first = value.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) return {};
  const auto last = value.find_last_not_of(" \t\r\n");
  return value.substr(first, last - first + 1);
}

bool valid_environment_name(const std::string &name) {
  if (name.empty()) return false;
  return std::all_of(name.begin(), name.end(), [](unsigned char ch) {
    return std::isalnum(ch) != 0 || ch == '_';
  });
}

bool is_secret_environment_name(const std::string &name) {
  static const std::vector<std::string> names = {
      "TRIGGER_SHARED_SECRET", "TRIGGER_OPERATOR_TOKEN", "STEEL_DATABASE_URL",
      "STEEL_BOOTSTRAP_ADMIN_PASSWORD"};
  return std::find(names.begin(), names.end(), name) != names.end() ||
         name.rfind("STEEL_BKV_", 0) == 0;
}

bool is_public_environment_name(const std::string &name) {
  static const std::vector<std::string> names = {
      "STEEL_RUNTIME_PROFILE",
      "STEEL_ALGORITHM_MODE",
      "STEEL_RESULT_ROOT",
      "STEEL_RESULT_PROXY_ONLY",
      "STEEL_CAPTURE_MANAGED_BY_SUPERVISOR",
      "STEEL_IMAGE_SERVICE_PORT",
      "STEEL_IMAGE_WORKER_PORT",
      "STEEL_DEFECT_WORKER_PORT",
      "STEEL_IMAGE_WORKER_ORIGIN",
      "STEEL_DEFECT_WORKER_ORIGIN",
      "STEEL_IMAGE_PROXY",
      "STEEL_ALGORITHM_INPUT_ROOTS",
      "STEEL_SICK_CAPTURE_PROFILE",
      "STEEL_PYTHON_EXECUTABLE",
      "BAR_SURFACE_MOCK_DEFECT_COUNT",
      "STEEL_ALGORITHM_ACCEPTANCE_REPORT",
      "STEEL_ALGORITHM_CALIBRATION_PATH",
      "STEEL_BAR_SURFACE_CORE_EXE",
      "STEEL_RELEASE_COMMIT",
      "INSPECTION_SERVICE_HOST",
      "INSPECTION_SERVICE_PORT",
      "STEEL_CAPTURE_PROVIDER",
      "CAPTURE_SERVICE_ORIGIN",
      "STEEL_CAPTURE_SERVICE_AUTOSTART",
      "STEEL_CAPTURE_SERVICE_EXE",
      "STEEL_CAPTURE_RESTART_BUDGET",
      "STEEL_CAPTURE_RESTART_BACKOFF_MS",
      "STEEL_CAPTURE_READY_TIMEOUT_MS",
       "CAPTURE_STORAGE_ROOT",
       "CAPTURE_CAMERA_STORAGE_ROOT",
       "STEEL_BAR_CAPTURE_ROOT",
       "STEEL_ALGORITHM_DATA_ROOT",
       "STEEL_ALGORITHM_PROCESS_TIMEOUT_SEC",
       "STEEL_REPORT_ARCHIVE_ROOT",
       "TRIGGER_GATEWAY_HOST",
      "TRIGGER_GATEWAY_PORT",
      "TRIGGER_GATEWAY_ORIGIN",
      "TRIGGER_SOURCE_ALLOWLIST",
      "TRIGGER_ALLOW_MODE_MUTATION",
      "STEEL_TRIGGER_HEALTH_REQUIRED",
      "STEEL_STORAGE_MIN_FREE_BYTES",
      "STEEL_STORAGE_MIN_FREE_PERCENT",
      "STEEL_ARTIFACT_ALLOWED_ROOTS"};
  return std::find(names.begin(), names.end(), name) != names.end();
}

bool load_environment_file(const fs::path &path, bool required, bool secret_file,
                           std::string &error) {
  if (path.empty()) return !required;
  std::ifstream stream(path);
  if (!stream) {
    if (!required) return true;
    error = "required environment file unavailable: " + path.string();
    return false;
  }
  std::map<std::string, std::size_t> seen;
  std::string line;
  std::size_t line_number = 0;
  while (std::getline(stream, line)) {
    ++line_number;
    if (line_number == 1 && line.size() >= 3 &&
        static_cast<unsigned char>(line[0]) == 0xEF &&
        static_cast<unsigned char>(line[1]) == 0xBB &&
        static_cast<unsigned char>(line[2]) == 0xBF) {
      line.erase(0, 3);
    }
    line = trim(line);
    if (line.empty() || line.front() == '#') continue;
    const auto equals = line.find('=');
    if (equals == std::string::npos) {
      error = "invalid environment line " + std::to_string(line_number);
      return false;
    }
    const std::string name = trim(line.substr(0, equals));
    const std::string value = trim(line.substr(equals + 1));
    if (!valid_environment_name(name) || seen.count(name) != 0) {
      error = "invalid or duplicate environment key at line " + std::to_string(line_number);
      return false;
    }
    const bool allowed = secret_file ? is_secret_environment_name(name)
                                     : is_public_environment_name(name);
    if (!allowed) {
      error = secret_file ? "key is not allowed in secret environment file: " + name
                          : "key is not allowed in public environment file: " + name;
      return false;
    }
    seen[name] = line_number;
    const std::wstring wide_name(name.begin(), name.end());
    const int wide_size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                               static_cast<int>(value.size()), nullptr, 0);
    if (wide_size == 0 && !value.empty()) {
      error = "invalid UTF-8 environment value at line " + std::to_string(line_number);
      return false;
    }
    std::wstring wide_value(static_cast<std::size_t>(wide_size), L'\0');
    if (wide_size > 0) {
      MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), wide_value.data(), wide_size);
    }
    if (!SetEnvironmentVariableW(wide_name.c_str(), wide_value.c_str())) {
      error = "failed to set environment key " + name;
      return false;
    }
  }
  return true;
}

std::optional<std::wstring> environment_value(const wchar_t *name) {
  const DWORD size = GetEnvironmentVariableW(name, nullptr, 0);
  if (size == 0) return std::nullopt;
  std::wstring value(size, L'\0');
  GetEnvironmentVariableW(name, value.data(), size);
  value.resize(size - 1);
  return value;
}

fs::path default_state_root() {
  const auto program_data = environment_value(L"PROGRAMDATA");
  if (program_data && !program_data->empty()) {
    return fs::path(*program_data) / "SteelInspectionRuntime";
  }
  return fs::path(L"C:\\ProgramData") / "SteelInspectionRuntime";
}

bool same_path_component(const fs::path &left, const fs::path &right) {
  return _wcsicmp(left.c_str(), right.c_str()) == 0;
}

bool path_is_same_or_descendant(const fs::path &candidate, const fs::path &base) {
  const fs::path normalized_candidate = candidate.lexically_normal();
  const fs::path normalized_base = base.lexically_normal();
  auto candidate_part = normalized_candidate.begin();
  for (auto base_part = normalized_base.begin(); base_part != normalized_base.end();
       ++base_part, ++candidate_part) {
    if (candidate_part == normalized_candidate.end() ||
        !same_path_component(*candidate_part, *base_part)) {
      return false;
    }
  }
  return true;
}

bool configure_environment(std::string &error) {
  const fs::path public_env = g_state_root / "config" / "runtime-service.env";
  if (!load_environment_file(public_env, true, false, error)) return false;
  const auto secret = environment_value(L"STEEL_RUNTIME_SECRET_ENV_FILE");
  if (secret && !secret->empty() && !load_environment_file(*secret, true, true, error)) return false;
  SetEnvironmentVariableW(L"STEEL_WORKSPACE_ROOT", g_runtime_root.c_str());
  SetEnvironmentVariableW(L"STEEL_RUNTIME_STATE_ROOT", g_state_root.c_str());
  SetEnvironmentVariableW(L"STEEL_RUNTIME_LOG_DIR", (g_state_root / "logs").c_str());
  SetEnvironmentVariableW(L"STEEL_BAR_SURFACE_CORE_EXE",
                          (g_runtime_root / "algorithm-core" / "steel_bar_surface_core.exe").c_str());
  SetEnvironmentVariableW(L"STEEL_SERVICE_CONFIG_DIR",
                          (g_state_root / "service").c_str());
  SetEnvironmentVariableW(L"STEEL_RESULT_ROOT",
                          (g_state_root / "result-data").c_str());
  SetEnvironmentVariableW(L"STEEL_RESULT_PROXY_ONLY", L"1");
  SetEnvironmentVariableW(L"STEEL_CAPTURE_MANAGED_BY_SUPERVISOR", L"1");
  SetEnvironmentVariableW(L"STEEL_IMAGE_SERVICE_PORT", L"4874");
  SetEnvironmentVariableW(L"STEEL_IMAGE_WORKER_PORT", L"4875");
  SetEnvironmentVariableW(L"STEEL_DEFECT_WORKER_PORT", L"4876");
  SetEnvironmentVariableW(L"STEEL_IMAGE_WORKER_ORIGIN", L"http://127.0.0.1:4875");
  SetEnvironmentVariableW(L"STEEL_DEFECT_WORKER_ORIGIN", L"http://127.0.0.1:4876");
  SetEnvironmentVariableW(L"STEEL_SICK_CAPTURE_SCRIPT",
                          (g_runtime_root / "scripts" / "sick_capture_service.py").c_str());
  SetEnvironmentVariableW(L"STEEL_SICK_ALGORITHM_SCRIPT",
                          (g_runtime_root / "scripts" / "sick_flow_analysis_service.py").c_str());
  SetEnvironmentVariableW(L"STEEL_IMAGE_PROXY", L"1");
  SetEnvironmentVariableW(L"STEEL_ALGORITHM_INPUT_ROOTS",
                          (g_state_root / "algorithm-input").c_str());
  SetEnvironmentVariableW(L"STEEL_ALGORITHM_CONFIG",
                          (g_runtime_root / "config" / "algorithm" /
                           "bar-surface-production.json").c_str());
  SetEnvironmentVariableW(L"CAPTURE_CONFIG_ROOT",
                          (g_state_root / "capture-config").c_str());
  SetEnvironmentVariableW(
      L"STEEL_CAPTURE_SERVICE_EXE",
      (g_runtime_root / "service" / "steel-capture-service.exe").c_str());
  SetEnvironmentVariableW(L"TEMP", (g_state_root / "temp").c_str());
  SetEnvironmentVariableW(L"TMP", (g_state_root / "temp").c_str());
  return true;
}

bool validate_production_environment(std::string &error) {
  const auto require_exact = [&](const wchar_t *name, const wchar_t *expected) {
    const auto value = environment_value(name);
    if (!value || *value != expected) {
      error = "required production environment value is invalid: " + narrow(name);
      return false;
    }
    return true;
  };
  if (!require_exact(L"STEEL_RUNTIME_PROFILE", L"production") ||
      !require_exact(L"STEEL_ALGORITHM_MODE", L"production") ||
      !require_exact(L"BAR_SURFACE_MOCK_DEFECT_COUNT", L"0") ||
      !require_exact(L"STEEL_CAPTURE_PROVIDER", L"external-api") ||
      !require_exact(L"STEEL_CAPTURE_SERVICE_AUTOSTART", L"1") ||
      !require_exact(L"TRIGGER_ALLOW_MODE_MUTATION", L"0") ||
      !require_exact(L"STEEL_TRIGGER_HEALTH_REQUIRED", L"1")) {
    return false;
  }

  const auto state_root = environment_value(L"STEEL_RUNTIME_STATE_ROOT");
  const auto service_config = environment_value(L"STEEL_SERVICE_CONFIG_DIR");
  const auto capture_config = environment_value(L"CAPTURE_CONFIG_ROOT");
  const auto capture_executable = environment_value(L"STEEL_CAPTURE_SERVICE_EXE");
  const auto path_equals = [](const fs::path &left, const fs::path &right) {
    return path_is_same_or_descendant(left, right) && path_is_same_or_descendant(right, left);
  };
  if (!state_root || !path_equals(fs::path(*state_root), g_state_root) ||
      !service_config || !path_equals(fs::path(*service_config), g_state_root / "service") ||
      !capture_config || !path_equals(fs::path(*capture_config),
                                      g_state_root / "capture-config") ||
      !capture_executable ||
      !path_equals(fs::path(*capture_executable),
                   g_runtime_root / "service" /
                       "steel-capture-service.exe")) {
    error = "trusted mutable state environment paths do not match --state-root";
    return false;
  }

  for (const auto name : {L"STEEL_ALGORITHM_ACCEPTANCE_REPORT",
                          L"STEEL_ALGORITHM_CALIBRATION_PATH",
                          L"STEEL_BAR_SURFACE_CORE_EXE",
                          L"STEEL_SICK_CAPTURE_PROFILE",
                          L"STEEL_PYTHON_EXECUTABLE",
                          L"STEEL_SICK_CAPTURE_SCRIPT",
                          L"STEEL_SICK_ALGORITHM_SCRIPT"}) {
    const auto value = environment_value(name);
    if (!value || value->empty() || !fs::is_regular_file(fs::path(*value))) {
      error = "required production file environment is invalid: " + narrow(name);
      return false;
    }
  }
  const auto calibration_path = environment_value(L"STEEL_ALGORITHM_CALIBRATION_PATH");
  if (!calibration_path ||
      !path_is_same_or_descendant(fs::path(*calibration_path),
                                  g_state_root / "capture-config")) {
    error = "STEEL_ALGORITHM_CALIBRATION_PATH must be inside mutable capture state";
    return false;
  }
  const auto sick_profile = environment_value(L"STEEL_SICK_CAPTURE_PROFILE");
  if (!sick_profile ||
      !path_is_same_or_descendant(fs::path(*sick_profile),
                                  g_state_root / "capture-config")) {
    error = "STEEL_SICK_CAPTURE_PROFILE must be inside mutable capture state";
    return false;
  }
  const auto release_commit = environment_value(L"STEEL_RELEASE_COMMIT");
  if (!release_commit || release_commit->size() < 40 || release_commit->size() > 64 ||
      !std::all_of(release_commit->begin(), release_commit->end(), [](wchar_t ch) {
        return (ch >= L'0' && ch <= L'9') || (ch >= L'a' && ch <= L'f') ||
               (ch >= L'A' && ch <= L'F');
      })) {
    error = "STEEL_RELEASE_COMMIT must be an exact 40-64 character hexadecimal commit";
    return false;
  }
  const auto shared_secret = environment_value(L"TRIGGER_SHARED_SECRET");
  const auto operator_token = environment_value(L"TRIGGER_OPERATOR_TOKEN");
  if (!shared_secret || shared_secret->size() < 32 || !operator_token ||
      operator_token->size() < 32 || *shared_secret == *operator_token) {
    error = "trigger secrets must be distinct and contain at least 32 characters";
    return false;
  }
  const auto database_url = environment_value(L"STEEL_DATABASE_URL");
  if (database_url && database_url->size() >= 6 &&
      _wcsnicmp(database_url->c_str(), L"sqlite", 6) == 0 &&
      (database_url->size() == 6 || (*database_url)[6] == L':')) {
    error = "managed SQLite must use STEEL_SERVICE_CONFIG_DIR under --state-root";
    return false;
  }
  const auto source_allowlist = environment_value(L"TRIGGER_SOURCE_ALLOWLIST");
  if (!source_allowlist || source_allowlist->empty()) {
    error = "TRIGGER_SOURCE_ALLOWLIST is required in production";
    return false;
  }
  const auto allowed_roots = environment_value(L"STEEL_ARTIFACT_ALLOWED_ROOTS");
  if (!allowed_roots || allowed_roots->empty()) {
    error = "STEEL_ARTIFACT_ALLOWED_ROOTS is required in production";
    return false;
  }
  std::size_t offset = 0;
  while (offset <= allowed_roots->size()) {
    const std::size_t delimiter = allowed_roots->find(L';', offset);
    const std::wstring item = allowed_roots->substr(
        offset, delimiter == std::wstring::npos ? std::wstring::npos : delimiter - offset);
    const fs::path root(item);
    if (item.empty() || !root.is_absolute() || !fs::is_directory(root) ||
        root.lexically_normal() == root.root_path()) {
      error = "STEEL_ARTIFACT_ALLOWED_ROOTS contains an invalid or drive-root path";
      return false;
    }
    if (delimiter == std::wstring::npos) break;
    offset = delimiter + 1;
  }
  return true;
}

bool child_inherits_environment_name(const ChildSpec &spec, const std::wstring &name) {
  if (_wcsicmp(name.c_str(), L"STEEL_RUNTIME_SECRET_ENV_FILE") == 0) return false;
  // The formal camera runtime never passes BKV credentials to any child.
  // BKV import/display is packaged and launched as an independent adapter.
  if (name.rfind(L"STEEL_BKV_", 0) == 0) return false;
  const bool shared = _wcsicmp(name.c_str(), L"TRIGGER_SHARED_SECRET") == 0;
  const bool operator_token = _wcsicmp(name.c_str(), L"TRIGGER_OPERATOR_TOKEN") == 0;
  const bool database = _wcsicmp(name.c_str(), L"STEEL_DATABASE_URL") == 0;
  const bool bootstrap = _wcsicmp(name.c_str(), L"STEEL_BOOTSTRAP_ADMIN_PASSWORD") == 0;
  if (!shared && !operator_token && !database && !bootstrap) return true;
  if (spec.name == L"trigger") return shared || operator_token;
  if (spec.name == L"service") return operator_token || database || bootstrap;
  return false;
}

std::optional<std::vector<wchar_t>> child_environment_block(const ChildSpec &spec,
                                                             std::string &error) {
  LPWCH environment = GetEnvironmentStringsW();
  if (!environment) {
    error = "GetEnvironmentStringsW failed for " + narrow(spec.name);
    return std::nullopt;
  }
  std::vector<wchar_t> output;
  for (const wchar_t *cursor = environment; *cursor != L'\0';) {
    const std::wstring entry(cursor);
    cursor += entry.size() + 1;
    const std::size_t equals = entry.find(L'=');
    const bool system_drive_entry = equals == 0;
    const std::wstring name = equals == std::wstring::npos
                                  ? entry
                                  : entry.substr(0, equals);
    if (!system_drive_entry && !child_inherits_environment_name(spec, name)) continue;
    output.insert(output.end(), entry.begin(), entry.end());
    output.push_back(L'\0');
  }
  FreeEnvironmentStringsW(environment);
  output.push_back(L'\0');
  return output;
}

std::vector<ChildSpec> child_specs() {
  return {
      {L"image", g_runtime_root / "service" / "steel-image-service.exe",
       g_state_root / "work" / "image", L"", 4874, "/api/health/live", "\"status\":\"live\"",
       15000},
      {L"image-worker", g_runtime_root / "service" / "steel-image-worker.exe",
       g_state_root / "work" / "image-worker", L"", 4875, "/api/health/live", "\"ready\":true",
       20000},
      {L"defect-worker", g_runtime_root / "service" / "steel-defect-worker.exe",
       g_state_root / "work" / "defect-worker", L"", 4876, "/api/health/live", "\"ready\":true",
       20000},
      {L"capture", g_runtime_root / "service" / "steel-capture-service.exe",
       g_state_root / "work" / "capture", L"", 4317, "/health", "\"ready\":true",
       30000},
      {L"service", g_runtime_root / "service" / "steel-inspection-service.exe",
       g_state_root / "work" / "service", L"", 4873, "/api/health/live", "\"status\":\"live\"",
       20000},
      {L"trigger", g_runtime_root / "service" / "steel-trigger-gateway.exe",
       g_state_root / "work" / "trigger", L"", 4881, "/health", "\"gatewayReady\":true", 15000},
  };
}

bool validate_runtime(std::string &error) {
  for (const auto &spec : child_specs()) {
    if (!fs::is_regular_file(spec.executable)) {
      error = "missing runtime executable: " + spec.executable.string();
      return false;
    }
  }
  for (const auto &path : {g_runtime_root / "service" /
                               "steel-capture-service.exe",
                           g_runtime_root / "service" / "steel-image-service.exe",
                           g_runtime_root / "service" / "steel-image-worker.exe",
                           g_runtime_root / "service" / "steel-defect-worker.exe",
                           g_runtime_root / "scripts" / "sick_capture_service.py",
                           g_runtime_root / "scripts" / "sick_flow_analysis_service.py",
                           g_runtime_root / "scripts" / "sick_capture",
                           g_runtime_root / "algorithm-core" / "steel_bar_surface_core.exe",
                           g_runtime_root / "config" / "capture",
                           g_runtime_root / "config" / "algorithm" /
                               "bar-surface-production.json"}) {
    if (!fs::exists(path)) {
      error = "missing runtime dependency: " + path.string();
      return false;
    }
  }
  return true;
}

bool validate_state_root(std::string &error) {
  if (g_state_root.empty() || !g_state_root.is_absolute() ||
      !fs::is_directory(g_state_root)) {
    error = "runtime state root is missing or not absolute: " + g_state_root.string();
    return false;
  }
  if (path_is_same_or_descendant(g_state_root, g_runtime_root) ||
      path_is_same_or_descendant(g_runtime_root, g_state_root)) {
    error = "runtime payload root and mutable state root must not overlap";
    return false;
  }
  for (const auto &path : {g_state_root / "config" / "runtime-service.env",
                           g_state_root / "logs",
                           g_state_root / "service",
                           g_state_root / "capture-config",
                           g_state_root / "result-data",
                           g_state_root / "algorithm-input",
                           g_state_root / "temp",
                           g_state_root / "work" / "capture",
                           g_state_root / "work" / "image",
                           g_state_root / "work" / "image-worker",
                           g_state_root / "work" / "defect-worker",
                           g_state_root / "work" / "trigger",
                           g_state_root / "work" / "service"}) {
    if (!fs::exists(path)) {
      error = "missing mutable runtime state dependency: " + path.string();
      return false;
    }
  }
  return true;
}

bool application_ready(const ChildSpec &spec) {
  SOCKET socket_handle = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (socket_handle == INVALID_SOCKET) return false;
  const DWORD timeout_ms = 1500;
  setsockopt(socket_handle, SOL_SOCKET, SO_RCVTIMEO,
             reinterpret_cast<const char *>(&timeout_ms), sizeof(timeout_ms));
  setsockopt(socket_handle, SOL_SOCKET, SO_SNDTIMEO,
             reinterpret_cast<const char *>(&timeout_ms), sizeof(timeout_ms));
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port = htons(spec.readiness_port);
  InetPtonW(AF_INET, L"127.0.0.1", &address.sin_addr);
  if (connect(socket_handle, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0) {
    closesocket(socket_handle);
    return false;
  }
  const std::string request = "GET " + spec.readiness_path +
                              " HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
  std::size_t sent = 0;
  while (sent < request.size()) {
    const int written = send(socket_handle, request.data() + sent,
                             static_cast<int>(request.size() - sent), 0);
    if (written <= 0) {
      closesocket(socket_handle);
      return false;
    }
    sent += static_cast<std::size_t>(written);
  }
  shutdown(socket_handle, SD_SEND);
  std::string response;
  response.reserve(4096);
  char buffer[4096];
  while (response.size() < 128 * 1024) {
    const int received = recv(socket_handle, buffer, sizeof(buffer), 0);
    if (received == 0) break;
    if (received == SOCKET_ERROR) {
      closesocket(socket_handle);
      return false;
    }
    response.append(buffer, static_cast<std::size_t>(received));
  }
  closesocket(socket_handle);
  const bool status_ok = response.rfind("HTTP/1.1 200", 0) == 0 ||
                         response.rfind("HTTP/1.0 200", 0) == 0;
  return status_ok && response.find(spec.readiness_marker) != std::string::npos;
}

struct LocalHttpResponse {
  int status_code = 0;
  std::string body;
};

std::optional<LocalHttpResponse> local_http_request(
    unsigned short port, const std::string &method, const std::string &path,
    const std::string &body,
    const std::vector<std::pair<std::string, std::string>> &headers, DWORD timeout_ms) {
  SOCKET socket_handle = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (socket_handle == INVALID_SOCKET) return std::nullopt;
  setsockopt(socket_handle, SOL_SOCKET, SO_RCVTIMEO,
             reinterpret_cast<const char *>(&timeout_ms), sizeof(timeout_ms));
  setsockopt(socket_handle, SOL_SOCKET, SO_SNDTIMEO,
             reinterpret_cast<const char *>(&timeout_ms), sizeof(timeout_ms));
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port = htons(port);
  InetPtonW(AF_INET, L"127.0.0.1", &address.sin_addr);
  if (connect(socket_handle, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0) {
    closesocket(socket_handle);
    return std::nullopt;
  }
  std::string request = method + " " + path +
                        " HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n";
  for (const auto &header : headers) {
    request += header.first + ": " + header.second + "\r\n";
  }
  if (method == "POST") {
    request += "Content-Type: application/json\r\nContent-Length: " +
               std::to_string(body.size()) + "\r\n";
  }
  request += "\r\n" + body;
  std::size_t sent = 0;
  while (sent < request.size()) {
    const int written = send(socket_handle, request.data() + sent,
                             static_cast<int>(request.size() - sent), 0);
    if (written <= 0) {
      closesocket(socket_handle);
      return std::nullopt;
    }
    sent += static_cast<std::size_t>(written);
  }
  shutdown(socket_handle, SD_SEND);
  std::string response;
  response.reserve(4096);
  char buffer[4096];
  while (response.size() < 256 * 1024) {
    const int received = recv(socket_handle, buffer, sizeof(buffer), 0);
    if (received == 0) break;
    if (received == SOCKET_ERROR) {
      closesocket(socket_handle);
      return std::nullopt;
    }
    response.append(buffer, static_cast<std::size_t>(received));
  }
  closesocket(socket_handle);
  const auto line_end = response.find("\r\n");
  const auto first_space = response.find(' ');
  if (line_end == std::string::npos || first_space == std::string::npos ||
      first_space >= line_end) {
    return std::nullopt;
  }
  const auto second_space = response.find(' ', first_space + 1);
  try {
    const int status = std::stoi(response.substr(
        first_space + 1,
        (second_space == std::string::npos ? line_end : second_space) - first_space - 1));
    const auto body_offset = response.find("\r\n\r\n");
    return LocalHttpResponse{status,
                             body_offset == std::string::npos
                                 ? std::string{}
                                 : response.substr(body_offset + 4)};
  } catch (...) {
    return std::nullopt;
  }
}

bool wait_for_readiness(const ChildProcess &child, DWORD timeout_ms) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (std::chrono::steady_clock::now() < deadline) {
    if (WaitForSingleObject(g_stop_event, 0) == WAIT_OBJECT_0) return false;
    if (WaitForSingleObject(child.process.hProcess, 0) == WAIT_OBJECT_0) return false;
    if (application_ready(child.spec)) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
  }
  return false;
}

HANDLE create_child_job(const ChildSpec &spec, std::string &error) {
  HANDLE job_handle = CreateJobObjectW(nullptr, nullptr);
  if (!job_handle) {
    error = "CreateJobObject failed for " + narrow(spec.name) + ": " +
            std::to_string(GetLastError());
    return nullptr;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job_handle, JobObjectExtendedLimitInformation, &limits,
                               sizeof(limits))) {
    const DWORD last_error = GetLastError();
    CloseHandle(job_handle);
    error = "SetInformationJobObject failed for " + narrow(spec.name) + ": " +
            std::to_string(last_error);
    return nullptr;
  }
  return job_handle;
}

bool start_child(const ChildSpec &spec, ChildProcess &child, std::string &error) {
  fs::create_directories(g_state_root / "logs");
  fs::create_directories(spec.working_directory);
  const fs::path log_path = g_state_root / "logs" / (narrow(spec.name) + ".log");
  {
    RotatingLogWriter preflight(log_path);
    if (!preflight.prepare(error)) return false;
  }
  SECURITY_ATTRIBUTES inheritable_attributes{};
  inheritable_attributes.nLength = sizeof(inheritable_attributes);
  inheritable_attributes.bInheritHandle = TRUE;
  HANDLE log_read = INVALID_HANDLE_VALUE;
  HANDLE log_write = INVALID_HANDLE_VALUE;
  if (!CreatePipe(&log_read, &log_write, &inheritable_attributes, 0) ||
      !SetHandleInformation(log_read, HANDLE_FLAG_INHERIT, 0)) {
    const DWORD last_error = GetLastError();
    if (log_read != INVALID_HANDLE_VALUE) CloseHandle(log_read);
    if (log_write != INVALID_HANDLE_VALUE) CloseHandle(log_write);
    error = "cannot create child log pipe for " + narrow(spec.name) + ": " +
            std::to_string(last_error);
    return false;
  }
  HANDLE input_handle = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                    &inheritable_attributes, OPEN_EXISTING,
                                    FILE_ATTRIBUTE_NORMAL, nullptr);
  if (input_handle == INVALID_HANDLE_VALUE) {
    const DWORD last_error = GetLastError();
    CloseHandle(log_read);
    CloseHandle(log_write);
    error = "cannot open NUL stdin for " + narrow(spec.name) + ": " +
            std::to_string(last_error);
    return false;
  }
  HANDLE job_handle = create_child_job(spec, error);
  if (!job_handle) {
    CloseHandle(input_handle);
    CloseHandle(log_read);
    CloseHandle(log_write);
    return false;
  }

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = input_handle;
  startup.StartupInfo.hStdOutput = log_write;
  startup.StartupInfo.hStdError = log_write;
  SIZE_T attribute_bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_bytes);
  std::vector<unsigned char> attribute_storage(attribute_bytes);
  startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
      attribute_storage.data());
  if (attribute_bytes == 0 ||
      !InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0,
                                         &attribute_bytes)) {
    const DWORD last_error = GetLastError();
    CloseHandle(job_handle);
    CloseHandle(input_handle);
    CloseHandle(log_read);
    CloseHandle(log_write);
    error = "InitializeProcThreadAttributeList failed for " + narrow(spec.name) + ": " +
            std::to_string(last_error);
    return false;
  }
  HANDLE inherited_handles[] = {input_handle, log_write};
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0,
                                 PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited_handles,
                                 sizeof(inherited_handles), nullptr, nullptr)) {
    const DWORD last_error = GetLastError();
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    CloseHandle(job_handle);
    CloseHandle(input_handle);
    CloseHandle(log_read);
    CloseHandle(log_write);
    error = "UpdateProcThreadAttribute failed for " + narrow(spec.name) + ": " +
            std::to_string(last_error);
    return false;
  }
  std::wstring command = quote(spec.executable.wstring());
  if (!spec.arguments.empty()) command += L" " + spec.arguments;
  std::vector<wchar_t> mutable_command(command.begin(), command.end());
  mutable_command.push_back(L'\0');
  auto environment = child_environment_block(spec, error);
  if (!environment) {
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    CloseHandle(job_handle);
    CloseHandle(input_handle);
    CloseHandle(log_read);
    CloseHandle(log_write);
    return false;
  }
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(spec.executable.c_str(), mutable_command.data(), nullptr, nullptr, TRUE,
                      CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED |
                          EXTENDED_STARTUPINFO_PRESENT,
                      environment->data(), spec.working_directory.c_str(), &startup.StartupInfo,
                      &process)) {
    const DWORD last_error = GetLastError();
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    CloseHandle(job_handle);
    CloseHandle(input_handle);
    CloseHandle(log_read);
    CloseHandle(log_write);
    error = "CreateProcess failed for " + narrow(spec.name) + ": " +
            std::to_string(last_error);
    return false;
  }
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  CloseHandle(input_handle);
  CloseHandle(log_write);
  log_write = INVALID_HANDLE_VALUE;
  if (!AssignProcessToJobObject(job_handle, process.hProcess)) {
    const DWORD last_error = GetLastError();
    TerminateProcess(process.hProcess, last_error);
    WaitForSingleObject(process.hProcess, 5000);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job_handle);
    CloseHandle(log_read);
    error = "AssignProcessToJobObject failed for " + narrow(spec.name) + ": " +
            std::to_string(last_error);
    return false;
  }
  auto log_context = std::make_unique<LogPumpContext>();
  log_context->read_handle = log_read;
  log_context->path = log_path;
  HANDLE log_thread = CreateThread(nullptr, 0, log_pump_main, log_context.get(), 0, nullptr);
  if (!log_thread) {
    const DWORD last_error = GetLastError();
    CloseHandle(log_read);
    TerminateJobObject(job_handle, last_error);
    WaitForSingleObject(process.hProcess, 5000);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job_handle);
    error = "cannot start child log pump for " + narrow(spec.name) + ": " +
            std::to_string(last_error);
    return false;
  }
  log_context.release();
  if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
    const DWORD last_error = GetLastError();
    TerminateJobObject(job_handle, last_error);
    WaitForSingleObject(process.hProcess, 5000);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job_handle);
    finish_log_pump(log_thread);
    error = "ResumeThread failed for " + narrow(spec.name) + ": " +
            std::to_string(last_error);
    return false;
  }
  CloseHandle(process.hThread);
  process.hThread = nullptr;
  child = ChildProcess{spec, process, job_handle, log_thread};
  append_supervisor_log("started " + narrow(spec.name) + " pid=" + std::to_string(process.dwProcessId));
  return true;
}

void request_child_stop(ChildProcess &child) {
  if (!child.process.hProcess ||
      WaitForSingleObject(child.process.hProcess, 0) != WAIT_TIMEOUT) {
    return;
  }
  if (!GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, child.process.dwProcessId)) {
    append_supervisor_log("CTRL_BREAK delivery failed for " + narrow(child.spec.name) +
                          " error=" + std::to_string(GetLastError()));
  }
}

bool children_stopped(const std::vector<ChildProcess> &children) {
  return std::all_of(children.begin(), children.end(), [](const ChildProcess &child) {
    return !child.process.hProcess ||
           WaitForSingleObject(child.process.hProcess, 0) != WAIT_TIMEOUT;
  });
}

void wait_for_children_until(const std::vector<ChildProcess> &children,
                             std::chrono::steady_clock::time_point deadline) {
  while (!children_stopped(children) && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
}

void finish_log_pumps(std::vector<ChildProcess> &children) {
  const auto pumps_stopped = [&]() {
    return std::all_of(children.begin(), children.end(), [](const ChildProcess &child) {
      return !child.log_thread || WaitForSingleObject(child.log_thread, 0) != WAIT_TIMEOUT;
    });
  };
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (!pumps_stopped() && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(25));
  }
  if (!pumps_stopped()) {
    for (auto &child : children) {
      if (child.log_thread && WaitForSingleObject(child.log_thread, 0) == WAIT_TIMEOUT) {
        CancelSynchronousIo(child.log_thread);
      }
    }
    deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (!pumps_stopped() && std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(std::chrono::milliseconds(25));
    }
  }
  for (auto &child : children) {
    if (child.log_thread) {
      CloseHandle(child.log_thread);
      child.log_thread = nullptr;
    }
  }
}

void stop_children(std::vector<ChildProcess> &children) {
  for (auto iterator = children.rbegin(); iterator != children.rend(); ++iterator) {
    request_child_stop(*iterator);
  }
  DWORD graceful_timeout = 0;
  for (const auto &child : children) {
    graceful_timeout = std::max(graceful_timeout, child.spec.stop_timeout_ms);
  }
  wait_for_children_until(
      children, std::chrono::steady_clock::now() + std::chrono::milliseconds(graceful_timeout));
  for (auto iterator = children.rbegin(); iterator != children.rend(); ++iterator) {
    auto &child = *iterator;
    if (child.process.hProcess &&
        WaitForSingleObject(child.process.hProcess, 0) == WAIT_TIMEOUT) {
      append_supervisor_log("forced termination after graceful timeout: " +
                            narrow(child.spec.name));
      if (!child.job_handle || !TerminateJobObject(child.job_handle, ERROR_TIMEOUT)) {
        TerminateProcess(child.process.hProcess, ERROR_TIMEOUT);
      }
    }
  }
  wait_for_children_until(children,
                          std::chrono::steady_clock::now() + std::chrono::seconds(5));
  for (auto iterator = children.rbegin(); iterator != children.rend(); ++iterator) {
    auto &child = *iterator;
    // Even when the direct child exits cleanly, close/terminate its job so no
    // descendant can survive a restart of this runtime generation.
    if (child.job_handle) {
      TerminateJobObject(child.job_handle, NO_ERROR);
      CloseHandle(child.job_handle);
      child.job_handle = nullptr;
    }
    if (child.process.hProcess) {
      CloseHandle(child.process.hProcess);
      child.process.hProcess = nullptr;
    }
  }
  finish_log_pumps(children);
  children.clear();
}

bool start_children(std::vector<ChildProcess> &children, std::string &error) {
  for (const auto &spec : child_specs()) {
    ChildProcess child;
    if (!start_child(spec, child, error)) {
      stop_children(children);
      return false;
    }
    children.push_back(child);
    if (!wait_for_readiness(children.back(), 45000)) {
      error = "application readiness probe failed for " + narrow(spec.name);
      stop_children(children);
      return false;
    }
  }
  return true;
}

void set_service_status(DWORD state, DWORD win32_exit = NO_ERROR, DWORD wait_hint = 0) {
  if (!g_status_handle) return;
  g_status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  g_status.dwCurrentState = state;
  g_status.dwWin32ExitCode = win32_exit;
  g_status.dwWaitHint = wait_hint;
  g_status.dwControlsAccepted = (state == SERVICE_RUNNING || state == SERVICE_START_PENDING)
                                    ? SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN
                                    : 0;
  static DWORD checkpoint = 1;
  g_status.dwCheckPoint = (state == SERVICE_START_PENDING || state == SERVICE_STOP_PENDING)
                             ? checkpoint++
                             : 0;
  SetServiceStatus(g_status_handle, &g_status);
}

using DrainRequester = std::function<std::optional<LocalHttpResponse>(
    unsigned short, const std::string &, const std::string &, const std::string &,
    const std::vector<std::pair<std::string, std::string>> &, DWORD)>;

bool response_contains_all(const std::optional<LocalHttpResponse> &response,
                           const std::vector<std::string> &markers) {
  if (!response || response->status_code < 200 || response->status_code >= 300) return false;
  return std::all_of(markers.begin(), markers.end(), [&](const std::string &marker) {
    return response->body.find(marker) != std::string::npos;
  });
}

bool wait_for_business_drain(const DrainRequester &request, const std::string &operator_token,
                             unsigned short service_port, unsigned short trigger_port,
                             DWORD timeout_ms, DWORD poll_ms, bool service_mode,
                             bool emit_logs) {
  if (operator_token.size() < 32) {
    if (emit_logs) append_supervisor_log("business drain refused: operator token unavailable");
    return false;
  }
  const std::vector<std::pair<std::string, std::string>> drain_headers = {
      {"X-Trigger-Operator-Token", operator_token}};
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  const auto request_timeout = [&]() {
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) return DWORD{1};
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
    return std::max<DWORD>(
        1, std::min<DWORD>(1500, static_cast<DWORD>(remaining.count())));
  };
  bool trigger_closed = false;
  bool service_closed = false;
  unsigned int stable_polls = 0;
  unsigned int attempts = 0;
  do {
    ++attempts;
    if (!trigger_closed) {
      if (std::chrono::steady_clock::now() >= deadline) break;
      const auto response = request(trigger_port, "POST", "/api/trigger/drain", "{}",
                                    drain_headers, request_timeout());
      trigger_closed = response_contains_all(response, {"\"accepting\":false"});
      if (trigger_closed && emit_logs) append_supervisor_log("trigger admission closed");
    }
    if (!service_closed) {
      if (std::chrono::steady_clock::now() >= deadline) break;
      const auto response = request(service_port, "POST", "/api/runtime/drain", "{}",
                                    drain_headers, request_timeout());
      service_closed = response_contains_all(
          response, {"\"draining\":true", "\"accepting\":false"});
      if (service_closed && emit_logs) append_supervisor_log("service admission closed");
    }
    if (trigger_closed && service_closed) {
      if (std::chrono::steady_clock::now() >= deadline) break;
      const auto trigger_status = request(trigger_port, "GET", "/api/trigger/status", "", {},
                                          request_timeout());
      if (std::chrono::steady_clock::now() >= deadline) break;
      const auto service_status = request(service_port, "GET", "/api/production/status", "", {},
                                          request_timeout());
      const bool trigger_drained = response_contains_all(
          trigger_status, {"\"accepting\":false", "\"inFlight\":0"});
      const bool service_drained = response_contains_all(
          service_status,
          {"\"accepting\":false", "\"inFlight\":0", "\"activeSession\":null",
           "\"queueDepth\":0", "\"activeTaskId\":null"});
      stable_polls = trigger_drained && service_drained ? stable_polls + 1 : 0;
      if (stable_polls >= 4) {
        if (emit_logs) {
          append_supervisor_log("business drain completed after " + std::to_string(attempts) +
                                " poll(s)");
        }
        return true;
      }
    }
    if (service_mode) {
      set_service_status(SERVICE_STOP_PENDING, NO_ERROR,
                         kDrainTimeoutMs + kStopTimeoutMs + 10000);
    }
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) break;
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
    std::this_thread::sleep_for(std::min(
        remaining, std::chrono::milliseconds(std::max<DWORD>(1, poll_ms))));
  } while (std::chrono::steady_clock::now() < deadline);
  if (emit_logs) {
    append_supervisor_log("business drain timed out: triggerClosed=" +
                          std::string(trigger_closed ? "true" : "false") +
                          " serviceClosed=" + (service_closed ? "true" : "false") +
                          " stablePolls=" + std::to_string(stable_polls));
  }
  return false;
}

bool business_drain_self_test() {
  unsigned int service_status_polls = 0;
  const DrainRequester positive = [&](unsigned short port, const std::string &method,
                                      const std::string &path, const std::string &,
                                      const std::vector<std::pair<std::string, std::string>> &,
                                      DWORD) -> std::optional<LocalHttpResponse> {
    if (method == "POST" && path == "/api/trigger/drain") {
      return LocalHttpResponse{200, "{\"accepting\":false,\"inFlight\":1}"};
    }
    if (method == "POST" && path == "/api/runtime/drain") {
      return LocalHttpResponse{200,
                               "{\"admission\":{\"draining\":true,\"accepting\":false,"
                               "\"inFlight\":1}}"};
    }
    if (method == "GET" && path == "/api/trigger/status") {
      return LocalHttpResponse{200, "{\"accepting\":false,\"inFlight\":0}"};
    }
    if (method == "GET" && path == "/api/production/status") {
      ++service_status_polls;
      if (service_status_polls == 1) {
        return LocalHttpResponse{
            200,
            "{\"admission\":{\"accepting\":false,\"inFlight\":1},"
            "\"activeSession\":{},\"tasks\":{\"queueDepth\":1,"
            "\"worker\":{\"activeTaskId\":\"TASK-1\"}}}"};
      }
      return LocalHttpResponse{
          200,
          "{\"admission\":{\"accepting\":false,\"inFlight\":0},"
          "\"activeSession\":null,\"tasks\":{\"queueDepth\":0,"
          "\"worker\":{\"activeTaskId\":null}}}"};
    }
    (void)port;
    return std::nullopt;
  };
  if (!wait_for_business_drain(positive, std::string(32, 't'), 4873, 4881, 250, 1,
                               false, false) ||
      service_status_polls < 5) {
    return false;
  }
  unsigned int negative_attempts = 0;
  const DrainRequester negative = [&](unsigned short, const std::string &, const std::string &,
                                      const std::string &,
                                      const std::vector<std::pair<std::string, std::string>> &,
                                      DWORD) -> std::optional<LocalHttpResponse> {
    ++negative_attempts;
    return std::nullopt;
  };
  if (wait_for_business_drain(negative, std::string(32, 't'), 4873, 4881, 25, 1, false,
                              false) ||
      negative_attempts < 2) {
    return false;
  }
  std::cout << "business-drain-positive=passed business-drain-timeout=passed\n";
  return true;
}

bool managed_recovery_self_test() {
  const std::string healthy_health =
      "{\"ready\":true,\"sdkReady\":true,\"sdkCode\":0,"
      "\"recoveryRequired\":false,\"invalidManifest\":false,"
      "\"sdkCaptureState\":{\"restartRequired\":false}}";
  const std::string restart_health =
      "{\"ready\":false,\"sdkReady\":false,\"sdkCode\":49007,"
      "\"recoveryRequired\":false,\"invalidManifest\":false,"
      "\"sdkCaptureState\":{\"restartRequired\":true}}";
  const std::string reconciliation_health =
      "{\"ready\":false,\"sdkReady\":false,\"sdkCode\":49007,"
      "\"recoveryRequired\":true,\"invalidManifest\":false,"
      "\"sdkCaptureState\":{\"restartRequired\":true}}";
  if (steel_runtime::capture_requires_managed_restart(200, healthy_health) ||
      !steel_runtime::capture_requires_managed_restart(200, restart_health) ||
      steel_runtime::capture_requires_managed_restart(200, reconciliation_health)) {
    return false;
  }
  steel_runtime::ManagedRestartConfirmation confirmation(
      kManagedRecoveryConfirmations);
  if (confirmation.observe(true) || !confirmation.observe(true) ||
      confirmation.observe(false) || confirmation.observations() != 0) {
    return false;
  }
  std::cout << "managed-recovery-49007=passed "
               "managed-recovery-two-confirmations=passed "
               "calibration-reconciliation-bypass=rejected\n";
  return true;
}

bool restart_budget_status_self_test() {
  std::error_code error;
  fs::create_directories(g_state_root / "service", error);
  if (error) return false;
  fs::remove(supervisor_status_path(), error);
  error.clear();

  std::string write_error;
  if (!write_supervisor_status("restart-budget-exhausted", true, 6,
                               "more_than_5_restarts_in_10_minutes",
                               &write_error) ||
      !prior_restart_budget_exhausted()) {
    std::cerr << write_error << '\n';
    return false;
  }
  std::ifstream exhausted_stream(supervisor_status_path(), std::ios::binary);
  const std::string exhausted((std::istreambuf_iterator<char>(exhausted_stream)),
                              std::istreambuf_iterator<char>());
  exhausted_stream.close();
  if (exhausted.find("\"schema\":\"steel.runtime-supervisor.status.v1\"") ==
          std::string::npos ||
      exhausted.find("\"status\":\"restart-budget-exhausted\"") ==
          std::string::npos ||
      exhausted.find("\"restartCountWindow\":6") == std::string::npos ||
      exhausted.find("\"restartBudgetMaximum\":5") == std::string::npos ||
      exhausted.find("\"restartBudgetWindowSeconds\":600") ==
          std::string::npos) {
    return false;
  }

  if (!write_supervisor_status(
          "running", false, 0,
          "restart_budget_recovered_after_stable_runtime", &write_error) ||
      prior_restart_budget_exhausted()) {
    std::cerr << write_error << '\n';
    return false;
  }
  const fs::path temporary =
      supervisor_status_path().wstring() + L".tmp-" +
      std::to_wstring(GetCurrentProcessId());
  if (fs::exists(temporary)) return false;
  std::cout << "restart-budget-status-atomic=passed "
               "restart-budget-exhausted-persistent=passed "
               "restart-budget-recovery=passed\n";
  return true;
}

DWORD WINAPI service_handler(DWORD control, DWORD, LPVOID, LPVOID) {
  if (control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN) {
    set_service_status(SERVICE_STOP_PENDING, NO_ERROR,
                       kDrainTimeoutMs + kStopTimeoutMs + 10000);
    SetEvent(g_stop_event);
  }
  return NO_ERROR;
}

BOOL WINAPI console_handler(DWORD control) {
  if (control == CTRL_C_EVENT || control == CTRL_BREAK_EVENT || control == CTRL_CLOSE_EVENT ||
      control == CTRL_SHUTDOWN_EVENT) {
    SetEvent(g_stop_event);
    return TRUE;
  }
  return FALSE;
}

DWORD run_supervisor(bool service_mode) {
  std::string error;
  if (!validate_runtime(error) || !validate_state_root(error) || !configure_environment(error) ||
      !validate_production_environment(error)) {
    append_supervisor_log(error);
    if (service_mode) set_service_status(SERVICE_STOPPED, ERROR_INVALID_DATA);
    std::cerr << error << '\n';
    return ERROR_INVALID_DATA;
  }
  bool restart_budget_exhausted = prior_restart_budget_exhausted();
  publish_supervisor_status("starting", restart_budget_exhausted, 0,
                            restart_budget_exhausted
                                ? "previous_restart_budget_exhaustion_pending_recovery"
                                : "");
  WSADATA winsock{};
  if (WSAStartup(MAKEWORD(2, 2), &winsock) != 0) return ERROR_NETWORK_UNREACHABLE;
  std::vector<ChildProcess> children;
  std::vector<std::chrono::steady_clock::time_point> restarts;
  DWORD result = NO_ERROR;
  while (WaitForSingleObject(g_stop_event, 0) == WAIT_TIMEOUT) {
    if (service_mode) set_service_status(SERVICE_START_PENDING, NO_ERROR, 120000);
    if (!start_children(children, error)) {
      append_supervisor_log("startup failed: " + error);
      publish_supervisor_status("startup-failed", restart_budget_exhausted,
                                restarts.size(), error);
    } else {
      if (service_mode) set_service_status(SERVICE_RUNNING);
      const auto generation_started = std::chrono::steady_clock::now();
      publish_supervisor_status("running", restart_budget_exhausted,
                                restarts.size(),
                                restart_budget_exhausted
                                    ? "previous_restart_budget_exhaustion_pending_recovery"
                                    : "");
      std::vector<HANDLE> handles{g_stop_event};
      for (const auto &child : children) handles.push_back(child.process.hProcess);
      steel_runtime::ManagedRestartConfirmation capture_recovery(
          kManagedRecoveryConfirmations);
      bool generation_finished = false;
      while (!generation_finished) {
        const DWORD wait = WaitForMultipleObjects(
            static_cast<DWORD>(handles.size()), handles.data(), FALSE,
            kManagedRecoveryPollMs);
        if (wait == WAIT_OBJECT_0) {
          const auto operator_token = environment_value(L"TRIGGER_OPERATOR_TOKEN");
          const DrainRequester requester = local_http_request;
          const bool drained = operator_token &&
                               wait_for_business_drain(requester, narrow(*operator_token), 4873,
                                                       4881, kDrainTimeoutMs, kDrainPollMs,
                                                       service_mode, true);
          if (!drained) {
            append_supervisor_log(
                "business drain gate did not reach zero; proceeding to bounded CTRL_BREAK fallback");
          }
          generation_finished = true;
        } else if (wait > WAIT_OBJECT_0 && wait < WAIT_OBJECT_0 + handles.size()) {
          const std::size_t index = wait - WAIT_OBJECT_0 - 1;
          DWORD exit_code = 0;
          GetExitCodeProcess(children[index].process.hProcess, &exit_code);
          append_supervisor_log("unexpected child exit " + narrow(children[index].spec.name) +
                                " code=" + std::to_string(exit_code));
          generation_finished = true;
        } else if (wait == WAIT_TIMEOUT) {
          if (restart_budget_exhausted &&
              std::chrono::steady_clock::now() - generation_started >=
                  std::chrono::seconds(kRestartBudgetRecoveryStableSeconds)) {
            restart_budget_exhausted = false;
            publish_supervisor_status("running", false, restarts.size(),
                                      "restart_budget_recovered_after_stable_runtime");
            append_supervisor_log(
                "previous restart budget exhaustion cleared after 30 seconds of stable runtime");
          }
          const auto health = local_http_request(
              4317, "GET", "/health", "", {}, 1500);
          const bool requires_restart =
              health && steel_runtime::capture_requires_managed_restart(
                            health->status_code, health->body);
          if (capture_recovery.observe(requires_restart)) {
            append_supervisor_log(
                "capture 49007 restartRequired confirmed twice; restarting managed runtime group without clearing calibration reconciliation");
            generation_finished = true;
          }
        } else {
          append_supervisor_log(
              "runtime child wait failed error=" + std::to_string(GetLastError()));
          generation_finished = true;
        }
      }
    }
    stop_children(children);
    if (WaitForSingleObject(g_stop_event, 0) == WAIT_OBJECT_0) break;
    const auto now = std::chrono::steady_clock::now();
    restarts.erase(std::remove_if(restarts.begin(), restarts.end(), [&](const auto &time) {
                     return now - time > std::chrono::minutes(10);
                   }), restarts.end());
    restarts.push_back(now);
    if (restarts.size() > kRestartBudgetMaximum) {
      append_supervisor_log("restart budget exhausted: more than 5 restarts in 10 minutes");
      restart_budget_exhausted = true;
      publish_supervisor_status("restart-budget-exhausted", true,
                                restarts.size(),
                                "more_than_5_restarts_in_10_minutes");
      result = ERROR_RETRY;
      break;
    }
    if (WaitForSingleObject(g_stop_event, 5000) == WAIT_OBJECT_0) break;
  }
  stop_children(children);
  WSACleanup();
  if (result != ERROR_RETRY) {
    publish_supervisor_status("stopped", restart_budget_exhausted,
                              restarts.size(),
                              restart_budget_exhausted
                                  ? "restart_budget_exhaustion_pending_recovery"
                                  : "");
  }
  if (service_mode) set_service_status(SERVICE_STOPPED, result);
  return result;
}

void WINAPI service_main(DWORD, LPWSTR *) {
  g_status_handle = RegisterServiceCtrlHandlerExW(kServiceName, service_handler, nullptr);
  if (!g_status_handle) return;
  set_service_status(SERVICE_START_PENDING, NO_ERROR, 120000);
  g_stop_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!g_stop_event) {
    set_service_status(SERVICE_STOPPED, GetLastError());
    return;
  }
  if (AllocConsole()) {
    ShowWindow(GetConsoleWindow(), SW_HIDE);
    SetConsoleCtrlHandler(nullptr, TRUE);
  }
  run_supervisor(true);
  FreeConsole();
  CloseHandle(g_stop_event);
  g_stop_event = nullptr;
}

fs::path executable_path() {
  std::wstring buffer(32768, L'\0');
  const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
  buffer.resize(length);
  return fs::path(buffer);
}

}  // namespace

int wmain(int argc, wchar_t **argv) {
  bool console_mode = false;
  bool check_only = false;
  bool business_drain_test = false;
  bool log_rotation_test = false;
  bool managed_recovery_test = false;
  bool restart_budget_status_test = false;
  g_runtime_root = executable_path().parent_path().parent_path();
  g_state_root = default_state_root();
  for (int index = 1; index < argc; ++index) {
    const std::wstring argument = argv[index];
    if (argument == L"--console") console_mode = true;
    else if (argument == L"--check") check_only = true;
    else if (argument == L"--test-business-drain") business_drain_test = true;
    else if (argument == L"--test-log-rotation") log_rotation_test = true;
    else if (argument == L"--test-managed-recovery") managed_recovery_test = true;
    else if (argument == L"--test-restart-budget-status") restart_budget_status_test = true;
    else if (argument == L"--root" && index + 1 < argc) g_runtime_root = fs::absolute(argv[++index]);
    else if (argument == L"--state-root" && index + 1 < argc) g_state_root = fs::absolute(argv[++index]);
    else if (argument != L"--service") {
      std::wcerr << L"unknown argument: " << argument << L'\n';
      return ERROR_INVALID_PARAMETER;
    }
  }
  std::string error;
  if (business_drain_test) return business_drain_self_test() ? 0 : ERROR_INVALID_DATA;
  if (log_rotation_test) return log_rotation_self_test() ? 0 : ERROR_INVALID_DATA;
  if (managed_recovery_test) return managed_recovery_self_test() ? 0 : ERROR_INVALID_DATA;
  if (restart_budget_status_test)
    return restart_budget_status_self_test() ? 0 : ERROR_INVALID_DATA;
  if (check_only) {
    if (!validate_runtime(error) || !validate_state_root(error) || !configure_environment(error) ||
        !validate_production_environment(error)) {
      std::cerr << error << '\n';
      return ERROR_FILE_NOT_FOUND;
    }
    std::cout << "runtime supervisor check passed\n";
    return 0;
  }
  if (console_mode) {
    g_stop_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    SetConsoleCtrlHandler(console_handler, TRUE);
    const DWORD result = run_supervisor(false);
    CloseHandle(g_stop_event);
    return static_cast<int>(result);
  }
  SERVICE_TABLE_ENTRYW table[] = {{const_cast<LPWSTR>(kServiceName), service_main}, {nullptr, nullptr}};
  if (!StartServiceCtrlDispatcherW(table)) {
    std::cerr << "StartServiceCtrlDispatcher failed: " << GetLastError()
              << "; use --console for interactive diagnostics\n";
    return static_cast<int>(GetLastError());
  }
  return 0;
}
