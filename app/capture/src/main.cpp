#include <http.h>
#include <windows.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "lvm_sdk.h"

#pragma comment(lib, "httpapi.lib")

namespace {

std::mutex g_camera_mutex;
std::atomic<bool> g_running{true};
bool g_sdk_ready = false;
lvm_dev_t* g_device = nullptr;
std::string g_connected_ip;

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
  for (char ch : value) {
    switch (ch) {
      case '\\': out += "\\\\"; break;
      case '"': out += "\\\""; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(ch) < 0x20) {
          char buffer[8]{};
          snprintf(buffer, sizeof(buffer), "\\u%04x", ch);
          out += buffer;
        } else {
          out += ch;
        }
    }
  }
  return out;
}

std::string json_pair(const std::string& key, const std::string& value) {
  return "\"" + json_escape(key) + "\":\"" + json_escape(value) + "\"";
}

std::string get_query_param(const std::string& query, const std::string& key) {
  std::string needle = key + "=";
  size_t pos = query.find(needle);
  if (pos == std::string::npos) {
    return "";
  }
  pos += needle.size();
  size_t end = query.find('&', pos);
  return query.substr(pos, end == std::string::npos ? std::string::npos : end - pos);
}

std::string trim(std::string value) {
  value.erase(value.begin(), std::find_if(value.begin(), value.end(), [](unsigned char ch) { return !std::isspace(ch); }));
  value.erase(std::find_if(value.rbegin(), value.rend(), [](unsigned char ch) { return !std::isspace(ch); }).base(), value.end());
  return value;
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
  size_t end = body.find('"', quote + 1);
  if (end == std::string::npos) {
    return fallback;
  }
  return body.substr(quote + 1, end - quote - 1);
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

int device_change_cb(lvm_device_changes_t change, lvm_cam_info_t info) {
  std::cout << "[camera] " << (change == DEV_CHANGE_CONNECT ? "connected " : "disconnected ")
            << (info.ip ? info.ip : "") << " " << (info.model ? info.model : "") << "\n";
  return 0;
}

int ensure_sdk() {
  std::lock_guard<std::mutex> lock(g_camera_mutex);
  if (g_sdk_ready) {
    return CORRECT;
  }
  CreateDirectoryA("logs", nullptr);
  int ret = lvm_init_sdk(device_change_cb, "logs/");
  g_sdk_ready = (ret == CORRECT || ret == SDK_REPEATED_INIT);
  return ret;
}

std::string health_json() {
  int sdk_ret = ensure_sdk();
  std::lock_guard<std::mutex> lock(g_camera_mutex);
  int connected = g_device ? lvm_get_dev_connect_status(g_device) : 0;
  std::ostringstream json;
  json << "{"
       << json_pair("service", "steel_capture_service") << ","
       << json_pair("time", now_iso()) << ","
       << "\"sdkReady\":" << (g_sdk_ready ? "true" : "false") << ","
       << "\"sdkCode\":" << sdk_ret << ","
       << "\"connected\":" << (connected == 1 ? "true" : "false") << ","
       << json_pair("ip", g_connected_ip)
       << "}";
  return json.str();
}

std::string cameras_json() {
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
           << json_pair("sn", cam_info[i].sn ? cam_info[i].sn : "")
           << "}";
    }
  }
  json << "]}";
  return json.str();
}

std::string connect_json(const std::string& body) {
  int sdk_ret = ensure_sdk();
  if (!(sdk_ret == CORRECT || sdk_ret == SDK_REPEATED_INIT)) {
    return "{\"code\":" + std::to_string(sdk_ret) + ",\"connected\":false}";
  }

  std::string ip = json_string_field(body, "ip", "192.168.10.13");
  int dev_type = json_int_field(body, "devType", -1);
  std::lock_guard<std::mutex> lock(g_camera_mutex);
  if (g_device) {
    lvm_disconnect_dev(g_device);
    lvm_destroy_dev(g_device);
    g_device = nullptr;
  }

  char ip_buffer[DEVICE_NET_INFO_LEN]{};
  strncpy_s(ip_buffer, ip.c_str(), _TRUNCATE);
  g_device = lvm_create_dev(ip_buffer, dev_type);
  int ret = g_device ? lvm_connect_dev(g_device) : DEV_INIT_FAILED;
  if (ret == CORRECT) {
    g_connected_ip = ip;
  }

  std::ostringstream json;
  json << "{\"code\":" << ret << ",\"connected\":" << (ret == CORRECT ? "true" : "false") << ","
       << json_pair("ip", ip) << "}";
  return json.str();
}

std::string disconnect_json() {
  std::lock_guard<std::mutex> lock(g_camera_mutex);
  int ret = CORRECT;
  if (g_device) {
    ret = lvm_disconnect_dev(g_device);
    lvm_destroy_dev(g_device);
    g_device = nullptr;
  }
  g_connected_ip.clear();
  return "{\"code\":" + std::to_string(ret) + ",\"connected\":false}";
}

std::string status_json() {
  std::lock_guard<std::mutex> lock(g_camera_mutex);
  int connected = g_device ? lvm_get_dev_connect_status(g_device) : 0;
  int dev_id = g_device ? lvm_get_dev_id(g_device) : -1;
  std::ostringstream json;
  json << "{\"connected\":" << (connected == 1 ? "true" : "false")
       << ",\"deviceId\":" << dev_id << ","
       << json_pair("ip", g_connected_ip);
  if (g_device && g_device->status) {
    json << ",\"task\":" << g_device->status->task
         << ",\"status\":" << g_device->status->status
         << ",\"linkHealth\":" << g_device->status->link_health
         << ",\"temperatureJ28\":" << g_device->status->temperature_j28
         << ",\"temperatureJ29\":" << g_device->status->temperature_j29
         << ",\"temperatureJ30\":" << g_device->status->temperature_j30
         << ",\"lostPulseCounter\":" << g_device->status->lost_pulse_counter
         << ",\"bufferOverflowCounter\":" << g_device->status->buffer_overflow_counter;
  }
  json << "}";
  return json.str();
}

std::string get_param_json(const std::string& query) {
  std::string key = get_query_param(query, "key");
  std::string type = get_query_param(query, "type");
  if (key.empty()) {
    return "{\"code\":400,\"error\":\"missing key\"}";
  }
  std::lock_guard<std::mutex> lock(g_camera_mutex);
  if (!g_device) {
    return "{\"code\":" + std::to_string(DEV_NOT_LINK_ERROR) + ",\"error\":\"camera not connected\"}";
  }
  if (type == "float") {
    float value = 0;
    int ret = lvm_get_param_float_value(g_device, key.c_str(), &value);
    return "{\"code\":" + std::to_string(ret) + "," + json_pair("key", key) + ",\"value\":" + std::to_string(value) + "}";
  }
  if (type == "string") {
    char* value = nullptr;
    int ret = lvm_get_param_string_value(g_device, key.c_str(), &value);
    return "{\"code\":" + std::to_string(ret) + "," + json_pair("key", key) + "," + json_pair("value", value ? value : "") + "}";
  }
  int value = 0;
  int ret = lvm_get_param_int_value(g_device, key.c_str(), &value);
  return "{\"code\":" + std::to_string(ret) + "," + json_pair("key", key) + ",\"value\":" + std::to_string(value) + "}";
}

std::string set_param_json(const std::string& body) {
  std::string key = json_string_field(body, "key");
  std::string type = json_string_field(body, "type", "int");
  if (key.empty()) {
    return "{\"code\":400,\"error\":\"missing key\"}";
  }
  std::lock_guard<std::mutex> lock(g_camera_mutex);
  if (!g_device) {
    return "{\"code\":" + std::to_string(DEV_NOT_LINK_ERROR) + ",\"error\":\"camera not connected\"}";
  }
  int ret = INPUT_PARAMETER_ERROR;
  if (type == "float") {
    ret = lvm_set_param_float_value(g_device, key.c_str(), json_float_field(body, "value", 0));
  } else {
    ret = lvm_set_param_int_value(g_device, key.c_str(), json_int_field(body, "value", 0));
  }
  return "{\"code\":" + std::to_string(ret) + "," + json_pair("key", key) + "}";
}

std::string capture_depth_json(const std::string& body) {
  int lines = json_int_field(body, "lines", 1280);
  int width = json_int_field(body, "width", 0);
  int timeout_ms = json_int_field(body, "timeoutMs", 5000);
  int data_mode = json_int_field(body, "dataMode", 1);
  std::string output = json_string_field(body, "output", "capture-depth.png");

  std::lock_guard<std::mutex> lock(g_camera_mutex);
  if (!g_device) {
    return "{\"code\":" + std::to_string(DEV_NOT_LINK_ERROR) + ",\"error\":\"camera not connected\"}";
  }

  if (width <= 0) {
    width = lvm_get_depth_map_width(g_device, lines);
  }
  if (width <= 0) {
    width = 4096;
  }

  lvm_buf_t* buffer = lvm_alloc_depth_map_buf(g_device, data_mode, width, lines, 1);
  if (!buffer) {
    return "{\"code\":" + std::to_string(MALLOC_FAILED) + ",\"error\":\"depth buffer allocation failed\"}";
  }

  int ret = lvm_bind_buf(g_device, buffer);
  void* frame = nullptr;
  if (ret == CORRECT) {
    ret = lvm_trigger_en_ctrl(g_device, true);
  }
  if (ret == CORRECT) {
    frame = lvm_grab_frame(g_device, timeout_ms);
    ret = frame ? CORRECT : DEV_LOAD_DATA_ERROR;
  }
  if (ret == CORRECT && frame) {
    ret = lvm_save_depth_map(g_device, output.c_str(), static_cast<lvm_depth_map_t*>(frame));
  }
  lvm_grab_stop(g_device);
  lvm_free_buf(buffer);

  std::ostringstream json;
  json << "{\"code\":" << ret << ",\"lines\":" << lines << ",\"width\":" << width << ","
       << json_pair("output", output) << "}";
  return json.str();
}

std::string ui_html() {
  return R"(<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Steel Capture</title>
  <style>
    :root { color-scheme: dark; font-family: "Segoe UI", Arial, sans-serif; background: #0e1418; color: #eef5f7; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: linear-gradient(135deg, #0c1216, #172128); }
    main { max-width: 1120px; margin: 0 auto; padding: 28px; }
    header { display: flex; justify-content: space-between; gap: 20px; align-items: center; margin-bottom: 18px; }
    h1 { margin: 0; font-size: 26px; letter-spacing: 0; }
    .pill { padding: 7px 11px; border: 1px solid #274755; border-radius: 6px; background: #111e25; color: #9eddeb; font-weight: 700; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .card { border: 1px solid #233743; border-radius: 8px; background: rgba(17, 29, 36, 0.92); padding: 14px; box-shadow: 0 12px 30px rgba(0, 0, 0, 0.18); }
    .card h2 { margin: 0 0 12px; font-size: 16px; color: #9eddeb; }
    .wide { grid-column: span 2; }
    .full { grid-column: 1 / -1; }
    dl { display: grid; grid-template-columns: 110px 1fr; gap: 8px 10px; margin: 0; }
    dt { color: #8aa0aa; }
    dd { margin: 0; font-weight: 700; overflow-wrap: anywhere; }
    label { display: grid; gap: 6px; color: #9dafb7; font-size: 13px; }
    input { width: 100%; height: 36px; border: 1px solid #315061; border-radius: 6px; background: #0b151b; color: #f4fbfd; padding: 0 10px; }
    button { height: 36px; border: 1px solid #26a8c7; border-radius: 6px; background: #123644; color: #c9f5ff; font-weight: 800; cursor: pointer; }
    button:hover { background: #17495a; }
    .form-grid { display: grid; grid-template-columns: 1.2fr 0.7fr 0.7fr; gap: 10px; align-items: end; }
    .camera-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
    .camera { border: 1px solid #2b4652; border-radius: 6px; padding: 10px; background: #0c171d; cursor: pointer; }
    .camera strong, .camera span, .camera em { display: block; font-style: normal; overflow-wrap: anywhere; }
    .camera span, .camera em { color: #91a8b2; font-size: 12px; margin-top: 4px; }
    pre { min-height: 180px; max-height: 260px; overflow: auto; margin: 0; padding: 12px; border-radius: 6px; background: #071015; color: #b7e9f4; white-space: pre-wrap; }
    @media (max-width: 820px) { main { padding: 18px; } .grid, .form-grid { grid-template-columns: 1fr; } .wide { grid-column: auto; } header { display: grid; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Steel Capture Console</h1>
        <p>Local camera control for the LVM 3D acquisition service.</p>
      </div>
      <span class="pill" id="apiState">Starting</span>
    </header>

    <section class="grid">
      <article class="card wide">
        <h2>Service</h2>
        <dl id="health"></dl>
      </article>
      <article class="card wide">
        <h2>Camera Status</h2>
        <dl id="status"></dl>
      </article>

      <article class="card full">
        <h2>Cameras</h2>
        <div class="camera-list" id="cameras"></div>
      </article>

      <article class="card full">
        <h2>Connection</h2>
        <div class="form-grid">
          <label>Camera IP<input id="ip" value="192.168.10.13"></label>
          <button id="connect">Connect</button>
          <button id="disconnect">Disconnect</button>
        </div>
      </article>

      <article class="card full">
        <h2>Parameters</h2>
        <div class="form-grid">
          <label>ExposureTime<input id="exposure" type="number" value="50" min="1"></label>
          <label>GainK<input id="gain" type="number" value="1" min="0" step="0.1"></label>
          <button id="applyParams">Apply</button>
        </div>
      </article>

      <article class="card full">
        <h2>Depth Capture</h2>
        <div class="form-grid">
          <label>Lines<input id="lines" type="number" value="1280" min="1"></label>
          <label>Output<input id="output" value="capture-ui.png"></label>
          <button id="capture">Capture</button>
        </div>
      </article>

      <article class="card full">
        <h2>Log</h2>
        <pre id="log"></pre>
      </article>
    </section>
  </main>
  <script>
    const logEl = document.getElementById('log');
    const write = (message, data) => {
      const line = `[${new Date().toLocaleTimeString()}] ${message}` + (data ? `\n${JSON.stringify(data, null, 2)}` : '');
      logEl.textContent = `${line}\n\n${logEl.textContent}`.slice(0, 12000);
    };
    const api = async (path, options) => {
      const res = await fetch(path, options);
      if (!res.ok) throw new Error(`${path} ${res.status}`);
      return res.json();
    };
    const renderDl = (id, data) => {
      document.getElementById(id).innerHTML = Object.entries(data || {})
        .map(([key, value]) => `<dt>${key}</dt><dd>${value ?? '-'}</dd>`)
        .join('');
    };
    async function refresh() {
      try {
        const [health, cameras, status] = await Promise.all([
          api('/health'),
          api('/api/cameras'),
          api('/api/camera/status')
        ]);
        document.getElementById('apiState').textContent = health.sdkReady ? 'SDK Ready' : 'SDK Error';
        renderDl('health', health);
        renderDl('status', status);
        const list = cameras.cameras || [];
        document.getElementById('cameras').innerHTML = list.length
          ? list.map(cam => `<div class="camera" data-ip="${cam.ip}"><strong>${cam.ip}</strong><span>${cam.model}</span><em>${cam.sn}</em></div>`).join('')
          : '<p>No camera found.</p>';
        document.querySelectorAll('.camera').forEach(item => {
          item.onclick = () => document.getElementById('ip').value = item.dataset.ip || '';
        });
      } catch (error) {
        document.getElementById('apiState').textContent = 'Offline';
        write('Refresh failed', { error: String(error) });
      }
    }
    const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    document.getElementById('connect').onclick = async () => { const r = await post('/api/camera/connect', { ip: ip.value, devType: -1 }); write('Connect', r); refresh(); };
    document.getElementById('disconnect').onclick = async () => { const r = await post('/api/camera/disconnect', {}); write('Disconnect', r); refresh(); };
    document.getElementById('applyParams').onclick = async () => {
      const exposureResult = await post('/api/param', { key: 'ExposureTime', type: 'int', value: Number(exposure.value) });
      const gainResult = await post('/api/param', { key: 'GainK', type: 'float', value: Number(gain.value) });
      write('Apply parameters', { exposureResult, gainResult });
      refresh();
    };
    document.getElementById('capture').onclick = async () => {
      const r = await post('/api/capture/depth-map', { lines: Number(lines.value), output: output.value, timeoutMs: 8000 });
      write('Capture depth map', r);
      refresh();
    };
    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>)";
}

std::string route(const std::string& method, const std::string& path, const std::string& query, const std::string& body, USHORT& status) {
  status = 200;
  if (method == "OPTIONS") return "{}";
  if (method == "GET" && (path == "/" || path == "/ui")) return ui_html();
  if (method == "GET" && path == "/health") return health_json();
  if (method == "GET" && path == "/api/cameras") return cameras_json();
  if (method == "POST" && path == "/api/camera/connect") return connect_json(body);
  if (method == "POST" && path == "/api/camera/disconnect") return disconnect_json();
  if (method == "GET" && path == "/api/camera/status") return status_json();
  if (method == "GET" && path == "/api/param") return get_param_json(query);
  if (method == "POST" && path == "/api/param") return set_param_json(body);
  if (method == "POST" && path == "/api/capture/depth-map") return capture_depth_json(body);
  status = 404;
  return "{\"code\":404,\"error\":\"not found\"}";
}

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

void send_response(HANDLE queue, HTTP_REQUEST_ID request_id, USHORT status, const std::string& body, const char* content_type_value) {
  HTTP_RESPONSE response{};
  response.StatusCode = status;
  response.pReason = status == 200 ? "OK" : (status == 404 ? "Not Found" : "Error");
  response.ReasonLength = static_cast<USHORT>(strlen(response.pReason));

  HTTP_KNOWN_HEADER& content_type = response.Headers.KnownHeaders[HttpHeaderContentType];
  content_type.pRawValue = content_type_value;
  content_type.RawValueLength = static_cast<USHORT>(strlen(content_type.pRawValue));

  HTTP_UNKNOWN_HEADER cors_headers[3]{};
  cors_headers[0].pName = "Access-Control-Allow-Origin";
  cors_headers[0].NameLength = static_cast<USHORT>(strlen(cors_headers[0].pName));
  cors_headers[0].pRawValue = "*";
  cors_headers[0].RawValueLength = 1;
  cors_headers[1].pName = "Access-Control-Allow-Methods";
  cors_headers[1].NameLength = static_cast<USHORT>(strlen(cors_headers[1].pName));
  cors_headers[1].pRawValue = "GET, POST, OPTIONS";
  cors_headers[1].RawValueLength = static_cast<USHORT>(strlen(cors_headers[1].pRawValue));
  cors_headers[2].pName = "Access-Control-Allow-Headers";
  cors_headers[2].NameLength = static_cast<USHORT>(strlen(cors_headers[2].pName));
  cors_headers[2].pRawValue = "Content-Type";
  cors_headers[2].RawValueLength = static_cast<USHORT>(strlen(cors_headers[2].pRawValue));
  response.Headers.UnknownHeaderCount = 3;
  response.Headers.pUnknownHeaders = cors_headers;

  HTTP_DATA_CHUNK chunk{};
  chunk.DataChunkType = HttpDataChunkFromMemory;
  chunk.FromMemory.pBuffer = const_cast<char*>(body.data());
  chunk.FromMemory.BufferLength = static_cast<ULONG>(body.size());
  response.EntityChunkCount = 1;
  response.pEntityChunks = &chunk;

  ULONG sent = 0;
  HttpSendHttpResponse(queue, request_id, 0, &response, nullptr, &sent, nullptr, 0, nullptr, nullptr);
}

std::wstring widen(const std::string& value) {
  if (value.empty()) return L"";
  int size = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
  std::wstring result(size - 1, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, &result[0], size);
  return result;
}

int run_server(int port) {
  HTTPAPI_VERSION version = HTTPAPI_VERSION_2;
  ULONG result = HttpInitialize(version, HTTP_INITIALIZE_SERVER, nullptr);
  if (result != NO_ERROR) {
    std::cerr << "HttpInitialize failed: " << result << "\n";
    return 1;
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
    USHORT status = 200;
    std::string payload = route(method, path, query, body, status);
    const char* content_type = (method == "GET" && (path == "/" || path == "/ui"))
                                 ? "text/html; charset=utf-8"
                                 : "application/json; charset=utf-8";
    send_response(queue, request->RequestId, status, payload, content_type);
  }

  HttpRemoveUrlFromUrlGroup(group, prefix.c_str(), 0);
  HttpCloseRequestQueue(queue);
  HttpCloseUrlGroup(group);
  HttpCloseServerSession(session);
  HttpTerminate(HTTP_INITIALIZE_SERVER, nullptr);
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  int port = 4317;
  for (int i = 1; i + 1 < argc; ++i) {
    if (std::string(argv[i]) == "--port") {
      port = std::stoi(argv[i + 1]);
    }
  }
  return run_server(port);
}
