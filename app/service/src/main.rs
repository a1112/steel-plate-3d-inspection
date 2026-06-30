use std::env;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone)]
struct DefectType {
    id: &'static str,
    label: &'static str,
    color: &'static str,
    shape: &'static str,
}

#[derive(Clone)]
struct Record {
    id: &'static str,
    time: &'static str,
    plate_no: &'static str,
    status: &'static str,
    defect_count: usize,
}

#[derive(Clone)]
struct Plate {
    plate_no: String,
    width_mm: i32,
    length_mm: i32,
    thickness_mm: i32,
    steel_grade: String,
    detected_at: String,
}

#[derive(Clone)]
struct Defect {
    id: String,
    plate_no: String,
    type_id: String,
    type_label: String,
    surface: &'static str,
    severity: String,
    distance_head_mm: i32,
    operator_side_mm: i32,
    drive_side_mm: i32,
    width_mm: f64,
    height_mm: f64,
    depth_mm: f64,
    x_ratio: f64,
    y_offset_mm: f64,
    preview_x: i32,
    preview_y: i32,
}

const DEFECT_TYPES: &[DefectType] = &[
    DefectType {
        id: "pit",
        label: "凹坑",
        color: "#2f6bff",
        shape: "circle",
    },
    DefectType {
        id: "roll",
        label: "辊印",
        color: "#ff7f1f",
        shape: "square",
    },
    DefectType {
        id: "scratch",
        label: "划伤",
        color: "#24a647",
        shape: "rect",
    },
    DefectType {
        id: "foreign",
        label: "异物压入",
        color: "#f0141e",
        shape: "diamond",
    },
    DefectType {
        id: "burnt",
        label: "烂钢",
        color: "#8b5cf6",
        shape: "square",
    },
    DefectType {
        id: "edge",
        label: "边裂",
        color: "#f6b800",
        shape: "diamond",
    },
    DefectType {
        id: "longitudinal",
        label: "纵裂",
        color: "#17bce1",
        shape: "rect",
    },
    DefectType {
        id: "bubble",
        label: "气泡",
        color: "#ec4899",
        shape: "circle",
    },
    DefectType {
        id: "inclusion",
        label: "夹杂",
        color: "#a63a1f",
        shape: "circle",
    },
    DefectType {
        id: "review",
        label: "待复核",
        color: "#737373",
        shape: "star",
    },
];

const RECORDS: &[Record] = &[
    Record {
        id: "R-001",
        time: "19:00",
        plate_no: "202606131900",
        status: "detecting",
        defect_count: 12,
    },
    Record {
        id: "R-002",
        time: "18:42",
        plate_no: "202606131858",
        status: "completed",
        defect_count: 8,
    },
    Record {
        id: "R-003",
        time: "18:20",
        plate_no: "202606131820",
        status: "completed",
        defect_count: 0,
    },
    Record {
        id: "R-004",
        time: "17:55",
        plate_no: "202606131755",
        status: "completed",
        defect_count: 24,
    },
    Record {
        id: "R-005",
        time: "17:30",
        plate_no: "202606131730",
        status: "completed",
        defect_count: 5,
    },
    Record {
        id: "R-006",
        time: "17:05",
        plate_no: "202606131705",
        status: "completed",
        defect_count: 16,
    },
    Record {
        id: "R-007",
        time: "16:40",
        plate_no: "202606131640",
        status: "completed",
        defect_count: 2,
    },
    Record {
        id: "R-008",
        time: "16:15",
        plate_no: "202606131615",
        status: "completed",
        defect_count: 7,
    },
    Record {
        id: "R-009",
        time: "15:50",
        plate_no: "202606131550",
        status: "completed",
        defect_count: 10,
    },
    Record {
        id: "R-010",
        time: "15:25",
        plate_no: "202606131525",
        status: "completed",
        defect_count: 3,
    },
];

fn current_defects() -> Vec<Defect> {
    vec![
        defect(
            "D-001",
            "202606131900",
            "pit",
            "凹坑",
            "top",
            "severe",
            8342,
            1260,
            2240,
            0.42,
            0.36,
            -0.12,
            0.18,
            0.92,
            54,
            48,
        ),
        defect(
            "D-002",
            "202606131900",
            "scratch",
            "划伤",
            "bottom",
            "minor",
            5260,
            580,
            2920,
            0.64,
            0.18,
            -0.05,
            0.12,
            0.52,
            38,
            40,
        ),
        defect(
            "D-003",
            "202606131900",
            "roll",
            "辊印",
            "top",
            "review",
            4100,
            2050,
            1450,
            0.28,
            0.28,
            -0.08,
            0.42,
            -0.40,
            50,
            54,
        ),
        defect(
            "D-004",
            "202606131900",
            "foreign",
            "异物压入",
            "bottom",
            "severe",
            3880,
            960,
            2540,
            0.48,
            0.42,
            -0.14,
            0.04,
            0.82,
            43,
            48,
        ),
        defect(
            "D-005",
            "202606131900",
            "pit",
            "凹坑",
            "top",
            "severe",
            3200,
            1780,
            1720,
            0.38,
            0.31,
            -0.10,
            0.61,
            0.84,
            56,
            45,
        ),
        defect(
            "D-006",
            "202606131900",
            "scratch",
            "划伤",
            "top",
            "minor",
            2910,
            1560,
            1940,
            0.71,
            0.16,
            -0.04,
            0.62,
            -0.48,
            48,
            53,
        ),
        defect(
            "D-007",
            "202606131900",
            "roll",
            "辊印",
            "bottom",
            "review",
            2600,
            1440,
            2060,
            0.36,
            0.33,
            -0.07,
            0.24,
            -0.52,
            46,
            57,
        ),
        defect(
            "D-008",
            "202606131900",
            "pit",
            "凹坑",
            "bottom",
            "minor",
            1980,
            1840,
            1660,
            0.40,
            0.33,
            -0.09,
            0.72,
            -0.45,
            59,
            50,
        ),
        defect(
            "D-009",
            "202606131900",
            "bubble",
            "气泡",
            "bottom",
            "minor",
            1460,
            1740,
            1760,
            0.26,
            0.24,
            -0.03,
            0.71,
            0.52,
            52,
            49,
        ),
        defect(
            "D-010",
            "202606131900",
            "foreign",
            "异物压入",
            "top",
            "severe",
            920,
            2680,
            820,
            0.50,
            0.42,
            -0.16,
            0.78,
            0.90,
            61,
            45,
        ),
        defect(
            "D-011",
            "202606131900",
            "burnt",
            "烂钢",
            "bottom",
            "review",
            640,
            2240,
            1260,
            0.34,
            0.34,
            -0.08,
            0.82,
            -0.52,
            63,
            55,
        ),
        defect(
            "D-012",
            "202606131900",
            "edge",
            "边裂",
            "bottom",
            "minor",
            540,
            2480,
            1020,
            0.55,
            0.26,
            -0.05,
            0.84,
            -0.95,
            65,
            58,
        ),
    ]
}

#[allow(clippy::too_many_arguments)]
fn defect(
    id: &str,
    plate_no: &str,
    type_id: &str,
    type_label: &str,
    surface: &'static str,
    severity: &str,
    distance_head_mm: i32,
    operator_side_mm: i32,
    drive_side_mm: i32,
    width_mm: f64,
    height_mm: f64,
    depth_mm: f64,
    x_ratio: f64,
    y_offset_mm: f64,
    preview_x: i32,
    preview_y: i32,
) -> Defect {
    Defect {
        id: id.to_string(),
        plate_no: plate_no.to_string(),
        type_id: type_id.to_string(),
        type_label: type_label.to_string(),
        surface,
        severity: severity.to_string(),
        distance_head_mm,
        operator_side_mm,
        drive_side_mm,
        width_mm,
        height_mm,
        depth_mm,
        x_ratio,
        y_offset_mm,
        preview_x,
        preview_y,
    }
}

fn plate_from_record(record: &Record, index: usize) -> Plate {
    let (width_mm, length_mm, thickness_mm, steel_grade) = match record.plate_no {
        "202606131900" => (3500, 12000, 12, "Q355B"),
        "202606131858" => (3600, 11800, 14, "Q355B"),
        "202606131820" => (3200, 10000, 10, "Q235B"),
        "202606131755" => (3800, 12500, 16, "Q420B"),
        _ => (
            3300 + (index % 4) as i32 * 120,
            10800 + (index % 5) as i32 * 350,
            10 + (index % 4) as i32 * 2,
            if index % 3 == 0 { "Q355B" } else { "Q235B" },
        ),
    };
    Plate {
        plate_no: record.plate_no.to_string(),
        width_mm,
        length_mm,
        thickness_mm,
        steel_grade: steel_grade.to_string(),
        detected_at: format!("2026-06-13 {}", record.time),
    }
}

fn severity_plan(record: &Record) -> Vec<&'static str> {
    match record.plate_no {
        "202606131858" => vec![
            "severe", "review", "minor", "review", "severe", "minor", "review", "minor",
        ],
        "202606131755" => vec![
            "severe", "review", "minor", "minor", "severe", "review", "minor", "severe", "review",
            "minor", "minor", "review", "severe", "minor", "review", "minor", "severe", "review",
            "minor", "minor", "review", "severe", "minor", "minor",
        ],
        _ => {
            let cycle = ["minor", "review", "minor", "severe", "review"];
            (0..record.defect_count)
                .map(|index| cycle[index % cycle.len()])
                .collect()
        }
    }
}

fn defects_for_record(record: &Record, plate: &Plate, record_index: usize) -> Vec<Defect> {
    if record.plate_no == "202606131900" {
        return current_defects();
    }
    let severities = severity_plan(record);
    severities
        .iter()
        .enumerate()
        .map(|(index, severity)| {
            let defect_type = &DEFECT_TYPES[(record_index + index) % (DEFECT_TYPES.len() - 1)];
            let distance_head_mm = (((index + 1) as f64 * plate.length_mm as f64)
                / (severities.len() + 1) as f64)
                .round() as i32;
            let side_position =
                ((index * 431 + record_index * 277) % plate.width_mm as usize + 1) as i32;
            let operator_side_mm = side_position.min(plate.width_mm - 80);
            let drive_side_mm = 80.max(plate.width_mm - operator_side_mm);
            let depth_mm = match *severity {
                "severe" => -0.13 - (index % 3) as f64 * 0.015,
                "review" => -0.08 - (index % 2) as f64 * 0.01,
                _ => -0.035 - (index % 3) as f64 * 0.008,
            };
            Defect {
                id: format!("D-{}{:02}", record_index + 1, index + 1),
                plate_no: record.plate_no.to_string(),
                type_id: defect_type.id.to_string(),
                type_label: defect_type.label.to_string(),
                surface: if index % 2 == 0 { "top" } else { "bottom" },
                severity: (*severity).to_string(),
                distance_head_mm,
                operator_side_mm,
                drive_side_mm,
                width_mm: 0.24 + (index % 5) as f64 * 0.09,
                height_mm: 0.16 + (index % 4) as f64 * 0.07,
                depth_mm,
                x_ratio: distance_head_mm as f64 / plate.length_mm as f64,
                y_offset_mm: ((operator_side_mm as f64 / plate.width_mm as f64) - 0.5) * 2.0,
                preview_x: 34 + ((index * 7 + record_index * 5) % 32) as i32,
                preview_y: 38 + ((index * 5 + record_index * 3) % 22) as i32,
            }
        })
        .collect()
}

fn height_profile(depth: f64, center: i32) -> Vec<f64> {
    (0..81)
        .map(|index| {
            let offset = (index - center) as f64;
            let dip = (-(offset * offset) / 16.0).exp() * depth;
            let ripple = (index as f64 / 6.0).sin() * 0.012;
            dip + ripple
        })
        .collect()
}

fn json_escape(value: &str) -> String {
    value
        .chars()
        .flat_map(|ch| match ch {
            '"' => "\\\"".chars().collect::<Vec<_>>(),
            '\\' => "\\\\".chars().collect(),
            '\n' => "\\n".chars().collect(),
            '\r' => "\\r".chars().collect(),
            '\t' => "\\t".chars().collect(),
            _ => vec![ch],
        })
        .collect()
}

fn plate_json(plate: &Plate) -> String {
    format!(
        "{{\"plateNo\":\"{}\",\"widthMm\":{},\"lengthMm\":{},\"thicknessMm\":{},\"steelGrade\":\"{}\",\"detectedAt\":\"{}\"}}",
        json_escape(&plate.plate_no),
        plate.width_mm,
        plate.length_mm,
        plate.thickness_mm,
        json_escape(&plate.steel_grade),
        json_escape(&plate.detected_at)
    )
}

fn defect_json(defect: &Defect) -> String {
    format!(
        "{{\"id\":\"{}\",\"plateNo\":\"{}\",\"typeId\":\"{}\",\"typeLabel\":\"{}\",\"surface\":\"{}\",\"severity\":\"{}\",\"distanceHeadMm\":{},\"operatorSideMm\":{},\"driveSideMm\":{},\"widthMm\":{:.3},\"heightMm\":{:.3},\"depthMm\":{:.3},\"xRatio\":{:.5},\"yOffsetMm\":{:.5},\"previewX\":{},\"previewY\":{},\"previewImageUrl\":\"\"}}",
        json_escape(&defect.id),
        json_escape(&defect.plate_no),
        json_escape(&defect.type_id),
        json_escape(&defect.type_label),
        defect.surface,
        json_escape(&defect.severity),
        defect.distance_head_mm,
        defect.operator_side_mm,
        defect.drive_side_mm,
        defect.width_mm,
        defect.height_mm,
        defect.depth_mm,
        defect.x_ratio,
        defect.y_offset_mm,
        defect.preview_x,
        defect.preview_y
    )
}

fn defects_json(defects: &[Defect]) -> String {
    format!(
        "[{}]",
        defects
            .iter()
            .map(defect_json)
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn height_profile_json(values: &[f64]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .enumerate()
            .map(|(index, z)| format!("{{\"x\":{},\"z\":{:.5}}}", index, z))
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn build_snapshot_json() -> String {
    let current_plate = plate_from_record(&RECORDS[0], 0);
    let current_defects = current_defects();
    let current_height = height_profile(-0.18, 36);
    let defect_types = DEFECT_TYPES
        .iter()
        .map(|item| {
            format!(
                "{{\"id\":\"{}\",\"label\":\"{}\",\"color\":\"{}\",\"shape\":\"{}\"}}",
                item.id,
                json_escape(item.label),
                item.color,
                item.shape
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let records = RECORDS
        .iter()
        .map(|record| {
            format!(
                "{{\"id\":\"{}\",\"time\":\"{}\",\"plateNo\":\"{}\",\"status\":\"{}\",\"defectCount\":{}}}",
                record.id, record.time, record.plate_no, record.status, record.defect_count
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let inspections = RECORDS
        .iter()
        .enumerate()
        .map(|(index, record)| {
            let plate = plate_from_record(record, index);
            let defects = defects_for_record(record, &plate, index);
            let profile = if index == 0 {
                current_height.clone()
            } else {
                height_profile(
                    defects.first().map(|item| item.depth_mm).unwrap_or(-0.02),
                    28 + ((index * 7) % 22) as i32,
                )
            };
            format!(
                "{{\"plate\":{},\"defects\":{},\"heightProfile\":{}}}",
                plate_json(&plate),
                defects_json(&defects),
                height_profile_json(&profile)
            )
        })
        .collect::<Vec<_>>()
        .join(",");

    format!(
        "{{\"currentPlate\":{},\"defectTypes\":[{}],\"defects\":{},\"records\":[{}],\"status\":{},\"summary\":{},\"heightProfile\":{},\"inspections\":[{}]}}",
        plate_json(&current_plate),
        defect_types,
        defects_json(&current_defects),
        records,
        "{\"receiverPorts\":[{\"index\":1,\"ok\":true},{\"index\":2,\"ok\":true},{\"index\":3,\"ok\":false},{\"index\":4,\"ok\":true},{\"index\":5,\"ok\":true},{\"index\":6,\"ok\":true},{\"index\":7,\"ok\":true},{\"index\":8,\"ok\":true}],\"cameraPorts\":[{\"index\":1,\"ok\":true},{\"index\":2,\"ok\":true},{\"index\":3,\"ok\":false},{\"index\":4,\"ok\":true},{\"index\":5,\"ok\":true},{\"index\":6,\"ok\":true},{\"index\":7,\"ok\":true},{\"index\":8,\"ok\":true}],\"encoder\":\"sync\",\"plc\":\"normal\",\"l2\":\"normal\",\"alarmCount\":1}",
        "{\"total\":12,\"bySeverity\":{\"severe\":4,\"review\":3,\"minor\":5},\"bySurface\":{\"top\":5,\"bottom\":7}}",
        height_profile_json(&current_height),
        inspections
    )
}

fn http_response(status: &str, content_type: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nConnection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
    )
    .into_bytes()
}

fn handle_client(mut stream: TcpStream, snapshot_json: Arc<String>) {
    let mut buffer = [0_u8; 4096];
    let read = match stream.read(&mut buffer) {
        Ok(read) => read,
        Err(_) => return,
    };
    let request = String::from_utf8_lossy(&buffer[..read]);
    let mut parts = request
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace();
    let method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default();
    let response = match (method, path) {
        ("OPTIONS", _) => http_response("204 No Content", "application/json; charset=utf-8", ""),
        ("GET", "/api/health") => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            "{\"ok\":true,\"service\":\"steel-inspection-service\",\"language\":\"rust\"}",
        ),
        ("GET", "/api/inspection/snapshot") => {
            http_response("200 OK", "application/json; charset=utf-8", &snapshot_json)
        }
        _ => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            "{\"error\":\"not_found\"}",
        ),
    };
    let _ = stream.write_all(&response);
}

fn main() -> std::io::Result<()> {
    let port = env::var("INSPECTION_SERVICE_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(4873);
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    listener.set_nonblocking(false)?;
    let snapshot_json = Arc::new(build_snapshot_json());
    println!("steel inspection service listening on http://127.0.0.1:{port}");
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let snapshot_json = Arc::clone(&snapshot_json);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                handle_client(stream, snapshot_json);
            }
            Err(error) => eprintln!("failed to accept connection: {error}"),
        }
    }
    Ok(())
}
