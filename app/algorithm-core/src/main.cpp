#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace {

struct Args {
  fs::path manifest_path;
  fs::path mesh_path;
  fs::path output_dir;
  bool help = false;
};

struct Topology {
  double max_face_edge_mm = 0.0;
  std::uint64_t candidate_quads = 0;
  std::uint64_t kept_quads = 0;
  std::uint64_t skipped_invalid_quads = 0;
  std::uint64_t skipped_gap_quads = 0;
  bool available = false;
};

struct MeshData {
  std::string schema;
  std::string coordinate_unit;
  std::string stitch_mode;
  std::uint32_t calibrated_camera_count = 0;
  std::uint32_t camera_count = 0;
  std::uint32_t rows = 0;
  std::uint32_t cols_per_camera = 0;
  std::vector<float> positions;
  std::vector<float> uvs;
  std::vector<float> colors;
  std::vector<std::uint8_t> valid_mask;
  std::vector<std::uint8_t> calibrated_mask;
  std::vector<std::uint32_t> indices;
  Topology topology;
};

struct BuildContext {
  std::string material_id;
  std::string run_id;
  fs::path manifest_path;
  fs::path mesh_path;
  fs::path output_dir;
  fs::path binary_path;
  fs::path summary_path;
};

std::string read_text_file(const fs::path& path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) {
    throw std::runtime_error("failed to open " + path.string());
  }
  std::ostringstream buffer;
  buffer << file.rdbuf();
  return buffer.str();
}

void write_text_file(const fs::path& path, const std::string& body) {
  fs::create_directories(path.parent_path());
  std::ofstream file(path, std::ios::binary | std::ios::trunc);
  if (!file) {
    throw std::runtime_error("failed to write " + path.string());
  }
  file << body;
}

std::string json_escape(const std::string& value) {
  std::ostringstream out;
  for (char ch : value) {
    switch (ch) {
      case '\\': out << "\\\\"; break;
      case '"': out << "\\\""; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (static_cast<unsigned char>(ch) < 0x20) {
          out << "\\u" << std::hex << std::setw(4) << std::setfill('0')
              << static_cast<int>(static_cast<unsigned char>(ch)) << std::dec;
        } else {
          out << ch;
        }
        break;
    }
  }
  return out.str();
}

std::size_t find_key(const std::string& text, const std::string& key, std::size_t start = 0) {
  const std::string needle = "\"" + key + "\"";
  return text.find(needle, start);
}

std::size_t skip_ws(const std::string& text, std::size_t pos) {
  while (pos < text.size() && std::isspace(static_cast<unsigned char>(text[pos]))) {
    ++pos;
  }
  return pos;
}

std::size_t value_start_after_key(const std::string& text, const std::string& key, std::size_t start = 0) {
  const std::size_t key_pos = find_key(text, key, start);
  if (key_pos == std::string::npos) {
    return std::string::npos;
  }
  const std::size_t colon = text.find(':', key_pos + key.size() + 2);
  if (colon == std::string::npos) {
    return std::string::npos;
  }
  return skip_ws(text, colon + 1);
}

std::string parse_json_string_at(const std::string& text, std::size_t pos) {
  if (pos == std::string::npos || pos >= text.size() || text[pos] != '"') {
    throw std::runtime_error("expected JSON string");
  }
  std::string out;
  for (++pos; pos < text.size(); ++pos) {
    const char ch = text[pos];
    if (ch == '"') {
      return out;
    }
    if (ch != '\\') {
      out.push_back(ch);
      continue;
    }
    if (++pos >= text.size()) {
      break;
    }
    const char esc = text[pos];
    switch (esc) {
      case '"': out.push_back('"'); break;
      case '\\': out.push_back('\\'); break;
      case '/': out.push_back('/'); break;
      case 'b': out.push_back('\b'); break;
      case 'f': out.push_back('\f'); break;
      case 'n': out.push_back('\n'); break;
      case 'r': out.push_back('\r'); break;
      case 't': out.push_back('\t'); break;
      case 'u':
        out.push_back('?');
        pos = std::min<std::size_t>(pos + 4, text.size() - 1);
        break;
      default:
        out.push_back(esc);
        break;
    }
  }
  throw std::runtime_error("unterminated JSON string");
}

std::string extract_string(const std::string& text, const std::string& key, const std::string& fallback = "", std::size_t start = 0) {
  const std::size_t pos = value_start_after_key(text, key, start);
  if (pos == std::string::npos || pos >= text.size() || text[pos] != '"') {
    return fallback;
  }
  return parse_json_string_at(text, pos);
}

std::size_t matching_bracket(const std::string& text, std::size_t open_pos, char open_ch, char close_ch) {
  if (open_pos == std::string::npos || open_pos >= text.size() || text[open_pos] != open_ch) {
    return std::string::npos;
  }
  int depth = 0;
  bool in_string = false;
  bool escaped = false;
  for (std::size_t pos = open_pos; pos < text.size(); ++pos) {
    const char ch = text[pos];
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
    } else if (ch == open_ch) {
      ++depth;
    } else if (ch == close_ch) {
      --depth;
      if (depth == 0) {
        return pos;
      }
    }
  }
  return std::string::npos;
}

std::string extract_object_text(const std::string& text, const std::string& key, std::size_t start = 0) {
  const std::size_t pos = value_start_after_key(text, key, start);
  if (pos == std::string::npos || pos >= text.size() || text[pos] != '{') {
    return {};
  }
  const std::size_t end = matching_bracket(text, pos, '{', '}');
  if (end == std::string::npos) {
    return {};
  }
  return text.substr(pos, end - pos + 1);
}

double extract_double(const std::string& text, const std::string& key, double fallback = 0.0, std::size_t start = 0) {
  const std::size_t pos = value_start_after_key(text, key, start);
  if (pos == std::string::npos || pos >= text.size()) {
    return fallback;
  }
  char* end = nullptr;
  const double value = std::strtod(text.c_str() + pos, &end);
  if (end == text.c_str() + pos) {
    return fallback;
  }
  return value;
}

std::uint32_t extract_u32(const std::string& text, const std::string& key, std::uint32_t fallback = 0, std::size_t start = 0) {
  const double value = extract_double(text, key, static_cast<double>(fallback), start);
  if (value < 0.0) {
    return fallback;
  }
  if (value > static_cast<double>(std::numeric_limits<std::uint32_t>::max())) {
    return std::numeric_limits<std::uint32_t>::max();
  }
  return static_cast<std::uint32_t>(value);
}

std::uint64_t extract_u64(const std::string& text, const std::string& key, std::uint64_t fallback = 0) {
  const double value = extract_double(text, key, static_cast<double>(fallback));
  if (value < 0.0) {
    return fallback;
  }
  if (value > static_cast<double>(std::numeric_limits<std::uint64_t>::max())) {
    return std::numeric_limits<std::uint64_t>::max();
  }
  return static_cast<std::uint64_t>(value);
}

std::pair<std::size_t, std::size_t> array_range(const std::string& text, const std::string& key) {
  const std::size_t pos = value_start_after_key(text, key);
  if (pos == std::string::npos || pos >= text.size() || text[pos] != '[') {
    return {std::string::npos, std::string::npos};
  }
  const std::size_t end = matching_bracket(text, pos, '[', ']');
  return {pos, end};
}

bool number_start(char ch) {
  return std::isdigit(static_cast<unsigned char>(ch)) || ch == '-' || ch == '+';
}

std::vector<float> extract_float_array(const std::string& text, const std::string& key, bool required) {
  const auto range = array_range(text, key);
  if (range.first == std::string::npos || range.second == std::string::npos) {
    if (required) {
      throw std::runtime_error("missing float array: " + key);
    }
    return {};
  }
  std::vector<float> values;
  const char* base = text.c_str();
  const char* cursor = base + range.first + 1;
  const char* end = base + range.second;
  while (cursor < end) {
    while (cursor < end && !number_start(*cursor)) {
      ++cursor;
    }
    if (cursor >= end) {
      break;
    }
    char* number_end = nullptr;
    const double value = std::strtod(cursor, &number_end);
    if (number_end == cursor) {
      ++cursor;
      continue;
    }
    values.push_back(static_cast<float>(value));
    cursor = number_end;
  }
  return values;
}

std::vector<std::uint32_t> extract_u32_array(const std::string& text, const std::string& key, bool required) {
  const auto range = array_range(text, key);
  if (range.first == std::string::npos || range.second == std::string::npos) {
    if (required) {
      throw std::runtime_error("missing integer array: " + key);
    }
    return {};
  }
  std::vector<std::uint32_t> values;
  const char* base = text.c_str();
  const char* cursor = base + range.first + 1;
  const char* end = base + range.second;
  while (cursor < end) {
    while (cursor < end && !number_start(*cursor)) {
      ++cursor;
    }
    if (cursor >= end) {
      break;
    }
    char* number_end = nullptr;
    const unsigned long value = std::strtoul(cursor, &number_end, 10);
    if (number_end == cursor) {
      ++cursor;
      continue;
    }
    values.push_back(static_cast<std::uint32_t>(std::min<unsigned long>(value, std::numeric_limits<std::uint32_t>::max())));
    cursor = number_end;
  }
  return values;
}

std::vector<std::uint8_t> extract_mask_array(const std::string& text, const std::string& key) {
  const std::vector<std::uint32_t> values = extract_u32_array(text, key, false);
  std::vector<std::uint8_t> mask;
  mask.reserve(values.size());
  for (std::uint32_t value : values) {
    mask.push_back(value == 0 ? 0 : 1);
  }
  return mask;
}

fs::path resolve_path(const fs::path& path, const fs::path& base) {
  if (path.empty()) {
    return {};
  }
  if (path.is_absolute()) {
    return path.lexically_normal();
  }
  return (base / path).lexically_normal();
}

Args parse_args(int argc, char** argv) {
  Args args;
  for (int index = 1; index < argc; ++index) {
    const std::string arg = argv[index];
    auto require_value = [&](const std::string& name) -> std::string {
      if (index + 1 >= argc) {
        throw std::runtime_error("missing value for " + name);
      }
      return argv[++index];
    };
    if (arg == "--help" || arg == "-h") {
      args.help = true;
    } else if (arg == "--manifest") {
      args.manifest_path = require_value(arg);
    } else if (arg == "--mesh") {
      args.mesh_path = require_value(arg);
    } else if (arg == "--output-dir") {
      args.output_dir = require_value(arg);
    } else {
      throw std::runtime_error("unknown argument: " + arg);
    }
  }
  return args;
}

BuildContext build_context(const Args& args) {
  if (args.manifest_path.empty() && args.mesh_path.empty()) {
    throw std::runtime_error("provide --manifest or --mesh");
  }

  BuildContext context;
  context.manifest_path = args.manifest_path.lexically_normal();

  if (!context.manifest_path.empty()) {
    const std::string manifest = read_text_file(context.manifest_path);
    const fs::path manifest_dir = context.manifest_path.parent_path();
    context.material_id = extract_string(manifest, "materialId");
    context.run_id = extract_string(manifest, "runId");
    const std::string mesh_object = extract_object_text(manifest, "mesh");
    std::string mesh_path = extract_string(mesh_object.empty() ? manifest : mesh_object, "json");
    if (mesh_path.empty()) {
      mesh_path = extract_string(manifest, "meshJson");
    }
    if (mesh_path.empty()) {
      throw std::runtime_error("manifest does not include mesh.json path");
    }
    context.mesh_path = resolve_path(fs::path(mesh_path), manifest_dir);
  }

  if (!args.mesh_path.empty()) {
    context.mesh_path = resolve_path(args.mesh_path, fs::current_path());
  }
  if (context.mesh_path.empty()) {
    throw std::runtime_error("mesh path is empty");
  }

  context.output_dir = args.output_dir.empty()
                           ? context.mesh_path.parent_path()
                           : resolve_path(args.output_dir, fs::current_path());
  context.binary_path = (context.output_dir / "bar_surface.bsmesh").lexically_normal();
  context.summary_path = (context.output_dir / "bar_surface_core_summary.json").lexically_normal();
  return context;
}

Topology parse_topology(const std::string& mesh_text) {
  Topology topology;
  const std::string object = extract_object_text(mesh_text, "topology");
  if (object.empty()) {
    return topology;
  }
  topology.available = true;
  topology.max_face_edge_mm = extract_double(object, "maxFaceEdgeMm", 0.0);
  topology.candidate_quads = extract_u64(object, "candidateQuads", 0);
  topology.kept_quads = extract_u64(object, "keptQuads", 0);
  topology.skipped_invalid_quads = extract_u64(object, "skippedInvalidQuads", 0);
  topology.skipped_gap_quads = extract_u64(object, "skippedGapQuads", 0);
  return topology;
}

MeshData parse_mesh(const std::string& mesh_text) {
  MeshData mesh;
  mesh.schema = extract_string(mesh_text, "schema");
  mesh.coordinate_unit = extract_string(mesh_text, "coordinateUnit", "mm");
  mesh.stitch_mode = extract_string(mesh_text, "stitchMode", "unknown");
  mesh.calibrated_camera_count = extract_u32(mesh_text, "calibratedCameraCount");
  mesh.camera_count = extract_u32(mesh_text, "cameraCount");
  mesh.rows = extract_u32(mesh_text, "rows");
  mesh.cols_per_camera = extract_u32(mesh_text, "colsPerCamera");
  mesh.positions = extract_float_array(mesh_text, "positions", true);
  mesh.uvs = extract_float_array(mesh_text, "uvs", false);
  mesh.colors = extract_float_array(mesh_text, "colors", false);
  mesh.valid_mask = extract_mask_array(mesh_text, "validMask");
  mesh.calibrated_mask = extract_mask_array(mesh_text, "calibratedMask");
  mesh.indices = extract_u32_array(mesh_text, "indices", true);
  mesh.topology = parse_topology(mesh_text);

  if (mesh.positions.empty() || mesh.positions.size() % 3 != 0) {
    throw std::runtime_error("positions must be non-empty xyz triplets");
  }
  if (mesh.indices.empty() || mesh.indices.size() % 3 != 0) {
    throw std::runtime_error("indices must be non-empty triangle triplets");
  }

  const std::size_t vertex_count = mesh.positions.size() / 3;
  if (mesh.uvs.empty()) {
    mesh.uvs.assign(vertex_count * 2, 0.0f);
  }
  if (mesh.colors.empty()) {
    mesh.colors.assign(vertex_count * 3, 1.0f);
  }
  if (mesh.uvs.size() != vertex_count * 2) {
    throw std::runtime_error("uv count does not match vertex count");
  }
  if (mesh.colors.size() != vertex_count * 3) {
    throw std::runtime_error("color count does not match vertex count");
  }
  if (!mesh.valid_mask.empty() && mesh.valid_mask.size() != vertex_count) {
    throw std::runtime_error("validMask count does not match vertex count");
  }
  if (!mesh.calibrated_mask.empty() && mesh.calibrated_mask.size() != vertex_count) {
    throw std::runtime_error("calibratedMask count does not match vertex count");
  }
  for (std::uint32_t index : mesh.indices) {
    if (index >= vertex_count) {
      throw std::runtime_error("mesh index exceeds vertex count");
    }
  }
  return mesh;
}

template <typename T>
void write_binary_value(std::ofstream& file, T value) {
  file.write(reinterpret_cast<const char*>(&value), sizeof(T));
}

template <typename T>
void write_binary_vector(std::ofstream& file, const std::vector<T>& values) {
  if (!values.empty()) {
    file.write(reinterpret_cast<const char*>(values.data()), static_cast<std::streamsize>(values.size() * sizeof(T)));
  }
}

std::uint32_t checked_u32(std::size_t value, const std::string& name) {
  if (value > std::numeric_limits<std::uint32_t>::max()) {
    throw std::runtime_error(name + " exceeds uint32 limit");
  }
  return static_cast<std::uint32_t>(value);
}

std::uintmax_t file_size_or_zero(const fs::path& path) {
  std::error_code error;
  const std::uintmax_t size = fs::file_size(path, error);
  return error ? 0 : size;
}

void write_bsmesh(const BuildContext& context, const MeshData& mesh) {
  fs::create_directories(context.binary_path.parent_path());
  std::ofstream file(context.binary_path, std::ios::binary | std::ios::trunc);
  if (!file) {
    throw std::runtime_error("failed to write " + context.binary_path.string());
  }

  const std::uint32_t vertex_count = checked_u32(mesh.positions.size() / 3, "vertex count");
  const std::uint32_t index_count = checked_u32(mesh.indices.size(), "index count");
  std::uint32_t flags = 0;
  flags |= mesh.colors.empty() ? 0u : 0x01u;
  flags |= mesh.valid_mask.empty() ? 0u : 0x02u;
  flags |= mesh.calibrated_mask.empty() ? 0u : 0x04u;
  flags |= mesh.topology.available ? 0x08u : 0u;

  const char magic[8] = {'B', 'S', 'M', 'E', 'S', 'H', '0', '1'};
  file.write(magic, sizeof(magic));
  write_binary_value<std::uint32_t>(file, 1);
  write_binary_value<std::uint32_t>(file, vertex_count);
  write_binary_value<std::uint32_t>(file, index_count);
  write_binary_value<std::uint32_t>(file, flags);
  write_binary_value<std::uint32_t>(file, mesh.rows);
  write_binary_value<std::uint32_t>(file, mesh.cols_per_camera);
  write_binary_value<std::uint32_t>(file, mesh.camera_count);
  write_binary_value<std::uint32_t>(file, mesh.calibrated_camera_count);
  write_binary_vector(file, mesh.positions);
  write_binary_vector(file, mesh.uvs);
  write_binary_vector(file, mesh.colors);
  write_binary_vector(file, mesh.indices);
  write_binary_vector(file, mesh.valid_mask);
  write_binary_vector(file, mesh.calibrated_mask);
}

std::string topology_json(const Topology& topology) {
  if (!topology.available) {
    return "{}";
  }
  std::ostringstream json;
  json << "{"
       << "\"maxFaceEdgeMm\":" << topology.max_face_edge_mm << ","
       << "\"candidateQuads\":" << topology.candidate_quads << ","
       << "\"keptQuads\":" << topology.kept_quads << ","
       << "\"skippedInvalidQuads\":" << topology.skipped_invalid_quads << ","
       << "\"skippedGapQuads\":" << topology.skipped_gap_quads
       << "}";
  return json.str();
}

std::string make_summary_json(const BuildContext& context,
                              const MeshData& mesh,
                              std::uintmax_t input_bytes,
                              std::uintmax_t output_bytes) {
  const std::uint32_t vertex_count = checked_u32(mesh.positions.size() / 3, "vertex count");
  const std::uint32_t triangle_count = checked_u32(mesh.indices.size() / 3, "triangle count");
  std::ostringstream json;
  json << "{\n"
       << "  \"schema\": \"steel.bar_surface.core.summary.v1\",\n"
       << "  \"materialId\": \"" << json_escape(context.material_id) << "\",\n"
       << "  \"runId\": \"" << json_escape(context.run_id) << "\",\n"
       << "  \"meshSchema\": \"" << json_escape(mesh.schema) << "\",\n"
       << "  \"coordinateUnit\": \"" << json_escape(mesh.coordinate_unit) << "\",\n"
       << "  \"stitchMode\": \"" << json_escape(mesh.stitch_mode) << "\",\n"
       << "  \"manifestPath\": \"" << json_escape(context.manifest_path.string()) << "\",\n"
       << "  \"meshJson\": \"" << json_escape(context.mesh_path.string()) << "\",\n"
       << "  \"binary\": \"" << json_escape(context.binary_path.string()) << "\",\n"
       << "  \"vertexCount\": " << vertex_count << ",\n"
       << "  \"triangleCount\": " << triangle_count << ",\n"
       << "  \"indexCount\": " << mesh.indices.size() << ",\n"
       << "  \"rows\": " << mesh.rows << ",\n"
       << "  \"colsPerCamera\": " << mesh.cols_per_camera << ",\n"
       << "  \"cameraCount\": " << mesh.camera_count << ",\n"
       << "  \"calibratedCameraCount\": " << mesh.calibrated_camera_count << ",\n"
       << "  \"hasValidMask\": " << (mesh.valid_mask.empty() ? "false" : "true") << ",\n"
       << "  \"hasCalibratedMask\": " << (mesh.calibrated_mask.empty() ? "false" : "true") << ",\n"
       << "  \"inputBytes\": " << input_bytes << ",\n"
       << "  \"outputBytes\": " << output_bytes << ",\n"
       << "  \"topology\": " << topology_json(mesh.topology) << "\n"
       << "}\n";
  return json.str();
}

void print_help() {
  std::cout
      << "steel_bar_surface_core --manifest <manifest.json> [--output-dir <dir>]\n"
      << "steel_bar_surface_core --mesh <bar_surface_mesh.json> [--output-dir <dir>]\n\n"
      << "Converts the Python prototype mesh JSON into a compact bar_surface.bsmesh file\n"
      << "and writes bar_surface_core_summary.json beside it.\n";
}

}  // namespace

int main(int argc, char** argv) {
  try {
    const Args args = parse_args(argc, argv);
    if (args.help) {
      print_help();
      return 0;
    }

    const BuildContext context = build_context(args);
    const std::string mesh_text = read_text_file(context.mesh_path);
    const MeshData mesh = parse_mesh(mesh_text);
    write_bsmesh(context, mesh);

    const std::uintmax_t input_bytes = file_size_or_zero(context.mesh_path);
    const std::uintmax_t output_bytes = file_size_or_zero(context.binary_path);
    write_text_file(context.summary_path, make_summary_json(context, mesh, input_bytes, output_bytes));

    std::cout << "{"
              << "\"code\":0,"
              << "\"binary\":\"" << json_escape(context.binary_path.string()) << "\","
              << "\"summary\":\"" << json_escape(context.summary_path.string()) << "\","
              << "\"vertexCount\":" << (mesh.positions.size() / 3) << ","
              << "\"triangleCount\":" << (mesh.indices.size() / 3)
              << "}" << std::endl;
    return 0;
  } catch (const std::exception& ex) {
    std::cerr << "steel_bar_surface_core: " << ex.what() << std::endl;
    return 1;
  }
}
