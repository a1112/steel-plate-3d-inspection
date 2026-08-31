#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
frontend_mode="web"
if [[ "${1:-}" == "--tauri" ]]; then
  frontend_mode="tauri"
  shift
fi
if [[ "$#" -gt 0 ]]; then
  echo "Usage: scripts/run-simulated-dev.sh [--tauri]" >&2
  exit 2
fi

service_port="${INSPECTION_SERVICE_PORT:-4873}"
trigger_port="${TRIGGER_GATEWAY_PORT:-4881}"
trigger_tcp_port="${TRIGGER_TCP_PORT:-4882}"
trigger_udp_port="${TRIGGER_UDP_PORT:-4883}"
vite_port="${VITE_PORT:-1432}"
default_state_root="${XDG_STATE_HOME:-${HOME}/.local/state}/steel-plate-3d-inspection/simulated-dev"
state_root="${STEEL_SIM_STATE_DIR:-${default_state_root}}"
service_config_dir="${STEEL_SERVICE_CONFIG_DIR:-${state_root}/config}"
log_dir="${state_root}/logs"
service_log="${log_dir}/service.log"
trigger_log="${log_dir}/trigger.log"
capture_root="${STEEL_BAR_CAPTURE_ROOT:-${state_root}/capture}"
algorithm_data_root="${STEEL_ALGORITHM_DATA_ROOT:-${state_root}/algorithm}"
algorithm_config="${STEEL_ALGORITHM_CONFIG:-${repo_root}/config/algorithm/bar-surface-production.json}"
algorithm_calibration_path="${STEEL_ALGORITHM_CALIBRATION_PATH:-${repo_root}/config/capture/calibrations/current-8-time-trigger/ArrayCalibration.xml}"

tauri_target_dir=""
if [[ "${frontend_mode}" == "tauri" ]]; then
  # External/macOS-incompatible volumes create AppleDouble `._*` sidecars in
  # Cargo build-script output. Tauri treats those files as permission manifests,
  # so keep desktop build artifacts on the local writable state volume.
  tauri_target_dir="${TAURI_CARGO_TARGET_DIR:-${state_root}/cargo-tauri}"
fi

command -v cargo >/dev/null 2>&1 || {
  echo "cargo is required to run the simulated Rust service." >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  echo "npm is required to run the operator client." >&2
  exit 1
}

mkdir -p \
  "${service_config_dir}" \
  "${log_dir}" \
  "${capture_root}" \
  "${algorithm_data_root}"

if [[ ! -d "${repo_root}/app/client/node_modules" ]]; then
  echo "Installing client dependencies..."
  npm --prefix "${repo_root}/app/client" ci
fi

export INSPECTION_SERVICE_PORT="${service_port}"
export STEEL_CAPTURE_PROVIDER="simulated"
export STEEL_RUNTIME_PROFILE="${STEEL_RUNTIME_PROFILE:-development}"
export STEEL_ALGORITHM_MODE="${STEEL_ALGORITHM_MODE:-demo}"
export BAR_SURFACE_MOCK_DEFECT_COUNT="${BAR_SURFACE_MOCK_DEFECT_COUNT:-0}"
export STEEL_DATABASE_ENGINE="${STEEL_DATABASE_ENGINE:-sqlite}"
export STEEL_DATABASE_FALLBACK="${STEEL_DATABASE_FALLBACK:-none}"
export STEEL_SEED_DEMO_DATA="${STEEL_SEED_DEMO_DATA:-1}"
export STEEL_CAPTURE_SERVICE_AUTOSTART="0"
export STEEL_TRIGGER_HEALTH_REQUIRED="${STEEL_TRIGGER_HEALTH_REQUIRED:-1}"
export TRIGGER_GATEWAY_ORIGIN="${TRIGGER_GATEWAY_ORIGIN:-http://127.0.0.1:${trigger_port}}"
export STEEL_SERVICE_CONFIG_DIR="${service_config_dir}"
export STEEL_BAR_CAPTURE_ROOT="${capture_root}"
export STEEL_ALGORITHM_DATA_ROOT="${algorithm_data_root}"
export STEEL_ALGORITHM_CONFIG="${algorithm_config}"
export STEEL_ALGORITHM_CALIBRATION_PATH="${algorithm_calibration_path}"
export VITE_INSPECTION_SERVICE_ORIGIN="http://127.0.0.1:${service_port}"
export TRIGGER_GATEWAY_HOST="127.0.0.1"
export TRIGGER_GATEWAY_PORT="${trigger_port}"
export TRIGGER_TCP_PORT="${trigger_tcp_port}"
export TRIGGER_UDP_PORT="${trigger_udp_port}"
export TRIGGER_MODE="${TRIGGER_MODE:-manual}"
export INSPECTION_SERVICE_ORIGIN="http://127.0.0.1:${service_port}"

service_pid=""
trigger_pid=""
cleanup() {
  if [[ -n "${trigger_pid}" ]] && kill -0 "${trigger_pid}" 2>/dev/null; then
    kill "${trigger_pid}" 2>/dev/null || true
    wait "${trigger_pid}" 2>/dev/null || true
  fi
  if [[ -n "${service_pid}" ]] && kill -0 "${service_pid}" 2>/dev/null; then
    kill "${service_pid}" 2>/dev/null || true
    wait "${service_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "Starting simulated inspection service on http://127.0.0.1:${service_port} ..."
cargo run \
  --locked \
  --manifest-path "${repo_root}/app/service/Cargo.toml" \
  >"${service_log}" 2>&1 &
service_pid="$!"

health_url="http://127.0.0.1:${service_port}/api/health/live"
ready=false
for _ in $(seq 1 120); do
  if ! kill -0 "${service_pid}" 2>/dev/null; then
    echo "The simulated inspection service exited during startup:" >&2
    tail -n 80 "${service_log}" >&2 || true
    exit 1
  fi
  if curl --noproxy "*" --fail --silent --max-time 1 "${health_url}" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.25
done

if [[ "${ready}" != "true" ]]; then
  echo "The simulated inspection service did not become live at ${health_url}." >&2
  tail -n 80 "${service_log}" >&2 || true
  exit 1
fi

echo "Starting simulated trigger gateway on http://127.0.0.1:${trigger_port} ..."
cargo run \
  --locked \
  --manifest-path "${repo_root}/app/trigger/Cargo.toml" \
  >"${trigger_log}" 2>&1 &
trigger_pid="$!"

trigger_status_url="http://127.0.0.1:${trigger_port}/api/trigger/status"
trigger_ready=false
for _ in $(seq 1 120); do
  if ! kill -0 "${trigger_pid}" 2>/dev/null; then
    echo "The simulated trigger gateway exited during startup:" >&2
    tail -n 80 "${trigger_log}" >&2 || true
    exit 1
  fi
  if curl --noproxy "*" --fail --silent --max-time 1 "${trigger_status_url}" >/dev/null 2>&1; then
    trigger_ready=true
    break
  fi
  sleep 0.25
done

if [[ "${trigger_ready}" != "true" ]]; then
  echo "The simulated trigger gateway did not become ready at ${trigger_status_url}." >&2
  tail -n 80 "${trigger_log}" >&2 || true
  exit 1
fi

echo "Simulation is live. Service log: ${service_log}"
echo "Trigger log: ${trigger_log}"
if [[ "${frontend_mode}" == "tauri" ]]; then
  echo "Starting the Tauri operator desktop (frontend: http://127.0.0.1:${vite_port})"
  CARGO_TARGET_DIR="${tauri_target_dir}" \
    npm --prefix "${repo_root}/app/client" run tauri -- dev
else
  echo "Opening operator client at http://127.0.0.1:${vite_port}"
  npm --prefix "${repo_root}/app/client" run dev -- \
    --host "127.0.0.1" \
    --port "${vite_port}"
fi
