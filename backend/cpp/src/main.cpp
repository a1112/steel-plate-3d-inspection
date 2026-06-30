#include <arpa/inet.h>
#include <algorithm>
#include <cmath>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <iostream>
#include <sstream>
#include <string>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
#include <vector>

namespace {

volatile std::sig_atomic_t g_running = 1;

struct DefectType {
  std::string id;
  std::string label;
  std::string color;
  std::string shape;
};

struct Record {
  std::string id;
  std::string time;
  std::string plate_no;
  std::string status;
  int defect_count;
};

struct Plate {
  std::string plate_no;
  int width_mm;
  int length_mm;
  int thickness_mm;
  std::string steel_grade;
  std::string detected_at;
};

struct Defect {
  std::string id;
  std::string plate_no;
  std::string type_id;
  std::string type_label;
  std::string surface;
  std::string severity;
  int distance_head_mm;
  int operator_side_mm;
  int drive_side_mm;
  double width_mm;
  double height_mm;
  double depth_mm;
  double x_ratio;
  double y_offset_mm;
  int preview_x;
  int preview_y;
};

const std::vector<DefectType> kDefectTypes = {
    {"pit", "凹坑", "#2f6bff", "circle"},
    {"roll", "辊印", "#ff7f1f", "square"},
    {"scratch", "划伤", "#24a647", "rect"},
    {"foreign", "异物压入", "#f0141e", "diamond"},
    {"burnt", "烂钢", "#8b5cf6", "square"},
    {"edge", "边裂", "#f6b800", "diamond"},
    {"longitudinal", "纵裂", "#17bce1", "rect"},
    {"bubble", "气泡", "#ec4899", "circle"},
    {"inclusion", "夹杂", "#a63a1f", "circle"},
    {"review", "待复核", "#737373", "star"},
};

const std::vector<Record> kRecords = {
    {"R-001", "19:00", "202606131900", "detecting", 12},
    {"R-002", "18:42", "202606131858", "completed", 8},
    {"R-003", "18:20", "202606131820", "completed", 0},
    {"R-004", "17:55", "202606131755", "completed", 24},
    {"R-005", "17:30", "202606131730", "completed", 5},
    {"R-006", "17:05", "202606131705", "completed", 16},
    {"R-007", "16:40", "202606131640", "completed", 2},
    {"R-008", "16:15", "202606131615", "completed", 7},
    {"R-009", "15:50", "202606131550", "completed", 10},
    {"R-010", "15:25", "202606131525", "completed", 3},
};

const std::vector<Defect> kCurrentDefects = {
    {"D-001", "202606131900", "pit", "凹坑", "top", "severe", 8342, 1260, 2240, 0.42, 0.36, -0.12, 0.18, 0.92, 54, 48},
    {"D-002", "202606131900", "scratch", "划伤", "bottom", "minor", 5260, 580, 2920, 0.64, 0.18, -0.05, 0.12, 0.52, 38, 40},
    {"D-003", "202606131900", "roll", "辊印", "top", "review", 4100, 2050, 1450, 0.28, 0.28, -0.08, 0.42, -0.4, 50, 54},
    {"D-004", "202606131900", "foreign", "异物压入", "bottom", "severe", 3880, 960, 2540, 0.48, 0.42, -0.14, 0.04, 0.82, 43, 48},
    {"D-005", "202606131900", "pit", "凹坑", "top", "severe", 3200, 1780, 1720, 0.38, 0.31, -0.10, 0.61, 0.84, 56, 45},
    {"D-006", "202606131900", "scratch", "划伤", "top", "minor", 2910, 1560, 1940, 0.71, 0.16, -0.04, 0.62, -0.48, 48, 53},
    {"D-007", "202606131900", "roll", "辊印", "bottom", "review", 2600, 1440, 2060, 0.36, 0.33, -0.07, 0.24, -0.52, 46, 57},
    {"D-008", "202606131900", "pit", "凹坑", "bottom", "minor", 1980, 1840, 1660, 0.40, 0.33, -0.09, 0.72, -0.45, 59, 50},
    {"D-009", "202606131900", "bubble", "气泡", "bottom", "minor", 1460, 1740, 1760, 0.26, 0.24, -0.03, 0.71, 0.52, 52, 49},
    {"D-010", "202606131900", "foreign", "异物压入", "top", "severe", 920, 2680, 820, 0.50, 0.42, -0.16, 0.78, 0.90, 61, 45},
    {"D-011", "202606131900", "burnt", "烂钢", "bottom", "review", 640, 2240, 1260, 0.34, 0.34, -0.08, 0.82, -0.52, 63, 55},
    {"D-012", "202606131900", "edge", "边裂", "bottom", "minor", 540, 2480, 1020, 0.55, 0.26, -0.05, 0.84, -0.95, 65, 58},
};

void handle_signal(int) {
  g_running = 0;
}

std::string escape_json(const std::string& value) {
  std::ostringstream out;
  for (const char ch : value) {
    switch (ch) {
      case '"':
        out << "\\\"";
        break;
      case '\\':
        out << "\\\\";
        break;
      case '\n':
        out << "\\n";
        break;
      case '\r':
        out << "\\r";
        break;
      case '\t':
        out << "\\t";
        break;
      default:
        out << ch;
    }
  }
  return out.str();
}

void field(std::ostringstream& out, const std::string& name, const std::string& value, bool comma = true) {
  out << "\"" << name << "\":\"" << escape_json(value) << "\"";
  if (comma) {
    out << ",";
  }
}

void field(std::ostringstream& out, const std::string& name, int value, bool comma = true) {
  out << "\"" << name << "\":" << value;
  if (comma) {
    out << ",";
  }
}

void field(std::ostringstream& out, const std::string& name, double value, bool comma = true) {
  out << "\"" << name << "\":" << value;
  if (comma) {
    out << ",";
  }
}

Plate plate_from_record(const Record& record, std::size_t index) {
  if (record.plate_no == "202606131900") {
    return {record.plate_no, 3500, 12000, 12, "Q355B", "2026-06-13 " + record.time};
  }
  if (record.plate_no == "202606131858") {
    return {record.plate_no, 3600, 11800, 14, "Q355B", "2026-06-13 " + record.time};
  }
  if (record.plate_no == "202606131820") {
    return {record.plate_no, 3200, 10000, 10, "Q235B", "2026-06-13 " + record.time};
  }
  if (record.plate_no == "202606131755") {
    return {record.plate_no, 3800, 12500, 16, "Q420B", "2026-06-13 " + record.time};
  }
  return {record.plate_no,
          3300 + static_cast<int>(index % 4) * 120,
          10800 + static_cast<int>(index % 5) * 350,
          10 + static_cast<int>(index % 4) * 2,
          index % 3 == 0 ? "Q355B" : "Q235B",
          "2026-06-13 " + record.time};
}

std::vector<std::string> severity_plan(const Record& record) {
  if (record.plate_no == "202606131858") {
    return {"severe", "review", "minor", "review", "severe", "minor", "review", "minor"};
  }
  if (record.plate_no == "202606131755") {
    return {"severe", "review", "minor", "minor", "severe", "review", "minor", "severe",
            "review", "minor", "minor", "review", "severe", "minor", "review", "minor",
            "severe", "review", "minor", "minor", "review", "severe", "minor", "minor"};
  }
  const std::vector<std::string> cycle = {"minor", "review", "minor", "severe", "review"};
  std::vector<std::string> result;
  for (int i = 0; i < record.defect_count; ++i) {
    result.push_back(cycle[static_cast<std::size_t>(i) % cycle.size()]);
  }
  return result;
}

std::vector<Defect> defects_for_record(const Record& record, const Plate& plate, std::size_t record_index) {
  if (record.plate_no == "202606131900") {
    return kCurrentDefects;
  }
  const auto severities = severity_plan(record);
  std::vector<Defect> defects;
  for (std::size_t index = 0; index < severities.size(); ++index) {
    const auto& type = kDefectTypes[(record_index + index) % (kDefectTypes.size() - 1)];
    const int distance_head = static_cast<int>(((index + 1) * plate.length_mm) / (severities.size() + 1));
    const int side_position = static_cast<int>(((index * 431 + record_index * 277) % plate.width_mm) + 1);
    const int operator_side = std::min(side_position, plate.width_mm - 80);
    const int drive_side = std::max(80, plate.width_mm - operator_side);
    const std::string& severity = severities[index];
    double depth = -0.035 - static_cast<int>(index % 3) * 0.008;
    if (severity == "severe") {
      depth = -0.13 - static_cast<int>(index % 3) * 0.015;
    } else if (severity == "review") {
      depth = -0.08 - static_cast<int>(index % 2) * 0.01;
    }
    defects.push_back({
        "D-" + std::to_string(record_index + 1) + (index + 1 < 10 ? "0" : "") + std::to_string(index + 1),
        record.plate_no,
        type.id,
        type.label,
        index % 2 == 0 ? "top" : "bottom",
        severity,
        distance_head,
        operator_side,
        drive_side,
        0.24 + static_cast<int>(index % 5) * 0.09,
        0.16 + static_cast<int>(index % 4) * 0.07,
        depth,
        static_cast<double>(distance_head) / plate.length_mm,
        ((static_cast<double>(operator_side) / plate.width_mm) - 0.5) * 2,
        34 + static_cast<int>((index * 7 + record_index * 5) % 32),
        38 + static_cast<int>((index * 5 + record_index * 3) % 22),
    });
  }
  return defects;
}

std::vector<double> height_profile(double depth, int center) {
  std::vector<double> values;
  for (int index = 0; index < 81; ++index) {
    const double offset = static_cast<double>(index - center);
    const double dip = std::exp(-(offset * offset) / 16.0) * depth;
    const double ripple = std::sin(index / 6.0) * 0.012;
    values.push_back(dip + ripple);
  }
  return values;
}

void write_plate(std::ostringstream& out, const Plate& plate) {
  out << "{";
  field(out, "plateNo", plate.plate_no);
  field(out, "widthMm", plate.width_mm);
  field(out, "lengthMm", plate.length_mm);
  field(out, "thicknessMm", plate.thickness_mm);
  field(out, "steelGrade", plate.steel_grade);
  field(out, "detectedAt", plate.detected_at, false);
  out << "}";
}

void write_defect(std::ostringstream& out, const Defect& defect) {
  out << "{";
  field(out, "id", defect.id);
  field(out, "plateNo", defect.plate_no);
  field(out, "typeId", defect.type_id);
  field(out, "typeLabel", defect.type_label);
  field(out, "surface", defect.surface);
  field(out, "severity", defect.severity);
  field(out, "distanceHeadMm", defect.distance_head_mm);
  field(out, "operatorSideMm", defect.operator_side_mm);
  field(out, "driveSideMm", defect.drive_side_mm);
  field(out, "widthMm", defect.width_mm);
  field(out, "heightMm", defect.height_mm);
  field(out, "depthMm", defect.depth_mm);
  field(out, "xRatio", defect.x_ratio);
  field(out, "yOffsetMm", defect.y_offset_mm);
  field(out, "previewX", defect.preview_x);
  field(out, "previewY", defect.preview_y);
  field(out, "previewImageUrl", "", false);
  out << "}";
}

void write_defects(std::ostringstream& out, const std::vector<Defect>& defects) {
  out << "[";
  for (std::size_t i = 0; i < defects.size(); ++i) {
    if (i != 0) {
      out << ",";
    }
    write_defect(out, defects[i]);
  }
  out << "]";
}

void write_height_profile(std::ostringstream& out, const std::vector<double>& values) {
  out << "[";
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (i != 0) {
      out << ",";
    }
    out << "{\"x\":" << i << ",\"z\":" << values[i] << "}";
  }
  out << "]";
}

std::string build_snapshot_json() {
  std::ostringstream out;
  const Plate current_plate = plate_from_record(kRecords[0], 0);
  const auto current_height = height_profile(-0.18, 36);

  out << "{";
  out << "\"currentPlate\":";
  write_plate(out, current_plate);
  out << ",\"defectTypes\":[";
  for (std::size_t i = 0; i < kDefectTypes.size(); ++i) {
    if (i != 0) {
      out << ",";
    }
    out << "{";
    field(out, "id", kDefectTypes[i].id);
    field(out, "label", kDefectTypes[i].label);
    field(out, "color", kDefectTypes[i].color);
    field(out, "shape", kDefectTypes[i].shape, false);
    out << "}";
  }
  out << "],\"defects\":";
  write_defects(out, kCurrentDefects);
  out << ",\"records\":[";
  for (std::size_t i = 0; i < kRecords.size(); ++i) {
    if (i != 0) {
      out << ",";
    }
    out << "{";
    field(out, "id", kRecords[i].id);
    field(out, "time", kRecords[i].time);
    field(out, "plateNo", kRecords[i].plate_no);
    field(out, "status", kRecords[i].status);
    field(out, "defectCount", kRecords[i].defect_count, false);
    out << "}";
  }
  out << "],\"status\":{\"receiverPorts\":[";
  for (int i = 1; i <= 8; ++i) {
    if (i != 1) {
      out << ",";
    }
    out << "{\"index\":" << i << ",\"ok\":" << (i == 3 ? "false" : "true") << "}";
  }
  out << "],\"cameraPorts\":[";
  for (int i = 1; i <= 8; ++i) {
    if (i != 1) {
      out << ",";
    }
    out << "{\"index\":" << i << ",\"ok\":" << (i == 3 ? "false" : "true") << "}";
  }
  out << "],\"encoder\":\"sync\",\"plc\":\"normal\",\"l2\":\"normal\",\"alarmCount\":1}";
  out << ",\"summary\":{\"total\":12,\"bySeverity\":{\"severe\":4,\"review\":3,\"minor\":5},\"bySurface\":{\"top\":5,\"bottom\":7}}";
  out << ",\"heightProfile\":";
  write_height_profile(out, current_height);
  out << ",\"inspections\":[";
  for (std::size_t i = 0; i < kRecords.size(); ++i) {
    if (i != 0) {
      out << ",";
    }
    const Plate plate = plate_from_record(kRecords[i], i);
    const auto defects = defects_for_record(kRecords[i], plate, i);
    const auto profile = i == 0 ? current_height : height_profile(defects.empty() ? -0.02 : defects[0].depth_mm, 28 + static_cast<int>((i * 7) % 22));
    out << "{\"plate\":";
    write_plate(out, plate);
    out << ",\"defects\":";
    write_defects(out, defects);
    out << ",\"heightProfile\":";
    write_height_profile(out, profile);
    out << "}";
  }
  out << "]}";
  return out.str();
}

std::string http_response(int status, const std::string& status_text, const std::string& body, const std::string& content_type = "application/json; charset=utf-8") {
  std::ostringstream out;
  out << "HTTP/1.1 " << status << " " << status_text << "\r\n";
  out << "Content-Type: " << content_type << "\r\n";
  out << "Content-Length: " << body.size() << "\r\n";
  out << "Access-Control-Allow-Origin: *\r\n";
  out << "Access-Control-Allow-Methods: GET, OPTIONS\r\n";
  out << "Access-Control-Allow-Headers: Content-Type\r\n";
  out << "Connection: close\r\n\r\n";
  out << body;
  return out.str();
}

void send_all(int fd, const std::string& response) {
  const char* data = response.data();
  std::size_t remaining = response.size();
  while (remaining > 0) {
    const ssize_t sent = send(fd, data, remaining, 0);
    if (sent <= 0) {
      return;
    }
    data += sent;
    remaining -= static_cast<std::size_t>(sent);
  }
}

void handle_client(int client_fd, const std::string& snapshot_json) {
  char buffer[4096] = {};
  const ssize_t received = recv(client_fd, buffer, sizeof(buffer) - 1, 0);
  if (received <= 0) {
    close(client_fd);
    return;
  }
  const std::string request(buffer, static_cast<std::size_t>(received));
  std::istringstream request_stream(request);
  std::string method;
  std::string path;
  request_stream >> method >> path;

  if (method == "OPTIONS") {
    send_all(client_fd, http_response(204, "No Content", ""));
  } else if (method == "GET" && path == "/api/health") {
    send_all(client_fd, http_response(200, "OK", "{\"ok\":true,\"service\":\"steel-inspection-backend\"}"));
  } else if (method == "GET" && path == "/api/inspection/snapshot") {
    send_all(client_fd, http_response(200, "OK", snapshot_json));
  } else {
    send_all(client_fd, http_response(404, "Not Found", "{\"error\":\"not_found\"}"));
  }
  close(client_fd);
}

int read_port() {
  const char* env_port = std::getenv("INSPECTION_BACKEND_PORT");
  if (!env_port) {
    return 4873;
  }
  const int port = std::atoi(env_port);
  return port > 0 ? port : 4873;
}

}  // namespace

int main() {
  std::signal(SIGINT, handle_signal);
  std::signal(SIGTERM, handle_signal);

  const int port = read_port();
  const std::string snapshot_json = build_snapshot_json();
  const int server_fd = socket(AF_INET, SOCK_STREAM, 0);
  if (server_fd < 0) {
    std::cerr << "failed to create socket\n";
    return 1;
  }

  int reuse = 1;
  setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));

  sockaddr_in address {};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = htons(static_cast<uint16_t>(port));

  if (bind(server_fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0) {
    std::cerr << "failed to bind 127.0.0.1:" << port << "\n";
    close(server_fd);
    return 1;
  }

  if (listen(server_fd, 16) < 0) {
    std::cerr << "failed to listen\n";
    close(server_fd);
    return 1;
  }

  std::cout << "steel inspection backend listening on http://127.0.0.1:" << port << "\n";
  while (g_running) {
    fd_set read_fds;
    FD_ZERO(&read_fds);
    FD_SET(server_fd, &read_fds);
    timeval timeout {};
    timeout.tv_sec = 1;
    timeout.tv_usec = 0;
    const int ready = select(server_fd + 1, &read_fds, nullptr, nullptr, &timeout);
    if (ready < 0) {
      if (g_running) {
        std::cerr << "failed while waiting for client\n";
      }
      continue;
    }
    if (ready == 0) {
      continue;
    }

    sockaddr_in client_address {};
    socklen_t client_length = sizeof(client_address);
    const int client_fd = accept(server_fd, reinterpret_cast<sockaddr*>(&client_address), &client_length);
    if (client_fd < 0) {
      if (g_running) {
        std::cerr << "failed to accept client\n";
      }
      continue;
    }
    handle_client(client_fd, snapshot_json);
  }
  close(server_fd);
  return 0;
}
