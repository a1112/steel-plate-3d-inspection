#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
service_port="${INSPECTION_SERVICE_PORT:-4873}"
vite_port="${VITE_PORT:-1432}"
state_root="${STEEL_BKV_SAMPLE_STATE_DIR:-${XDG_STATE_HOME:-${HOME}/.local/state}/steel-plate-3d-inspection/bkv-sample-dev}"
python_bin="${STEEL_PYTHON:-python3}"
codex_python="${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"
project_config="${repo_root}/config/project.bkv-sample.json"
sample_cache_root="${STEEL_SAMPLE_DATA_CACHE_ROOT:-${repo_root}/target/sample-data-cache}"
sample_repository_cache="${STEEL_SAMPLE_DATA_REPOSITORY_CACHE:-${repo_root}/target/sample-data-repository}"
sample_root="${STEEL_BKV_SAMPLE_ROOT:-${sample_cache_root}/content/sample-data/bkv/1908500}"
manifest_path="${sample_root}/bkv-runtime-manifest.json"
service_log="${state_root}/logs/service.log"

command -v cargo >/dev/null 2>&1 || {
  echo "cargo is required to run the BKV sample service." >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  echo "npm is required to run the operator client." >&2
  exit 1
}
if ! command -v "${python_bin}" >/dev/null 2>&1 \
  || ! "${python_bin}" -c "import numpy, PIL" >/dev/null 2>&1; then
  if [[ -z "${STEEL_PYTHON:-}" ]] \
    && [[ -x "${codex_python}" ]] \
    && "${codex_python}" -c "import numpy, PIL" >/dev/null 2>&1; then
    python_bin="${codex_python}"
  else
    echo "Python is required to verify and import the BKV sample." >&2
    echo "Set STEEL_PYTHON to an interpreter that provides numpy and Pillow." >&2
    exit 1
  fi
fi
"${python_bin}" -c "import numpy, PIL" >/dev/null 2>&1 || {
  echo "Python packages numpy and Pillow are required. Set STEEL_PYTHON to a prepared interpreter." >&2
  exit 1
}

if [[ ! -f "${sample_root}/manifest.json" ]]; then
  echo "Fetching and verifying versioned BKV sample data..."
  "${python_bin}" "${repo_root}/scripts/fetch_sample_data.py" \
    --project-root "${repo_root}" \
    --cache-root "${sample_cache_root}" \
    --repository-cache "${sample_repository_cache}"
fi

if lsof -nP -iTCP:"${service_port}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${service_port} is already in use; stop the existing inspection service first." >&2
  exit 1
fi
if lsof -nP -iTCP:"${vite_port}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${vite_port} is already in use; stop the existing operator client first." >&2
  exit 1
fi

mkdir -p \
  "${state_root}/config" \
  "${state_root}/logs" \
  "${repo_root}/target/data/bkv-sample-1908500-runtime"

echo "Verifying downloaded BKV sample manifest..."
"${python_bin}" "${repo_root}/scripts/build_bkv_sample_runtime.py" \
  --project-root "${repo_root}" \
  --sample-root "${sample_root}" \
  --output "${manifest_path}" \
  --check

echo "Importing BKV sample into the normalized local store..."
"${python_bin}" "${repo_root}/scripts/bkv_import_service.py" \
  --project "${project_config}" \
  --once

if [[ ! -d "${repo_root}/app/client/node_modules" ]]; then
  echo "Installing client dependencies..."
  npm --prefix "${repo_root}/app/client" ci
fi

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${state_root}/cargo}"
export INSPECTION_SERVICE_PORT="${service_port}"
export STEEL_RUNTIME_PROFILE="development"
export STEEL_PROJECT_CONFIG_PATH="${project_config}"
export STEEL_SITE_CONFIG_ID="bkv-sample"
export STEEL_WORKSPACE_ROOT="${repo_root}"
export STEEL_BKV_DATA_ROOT="${repo_root}"
export STEEL_BKV_MANIFEST_PATH="${manifest_path}"
export STEEL_BKV_CURSOR_PATH="${repo_root}/target/data/bkv-sample-1908500-runtime/replay.json"
export STEEL_SERVICE_CONFIG_DIR="${state_root}/config"
export STEEL_DATABASE_ENGINE="sqlite"
export STEEL_DATABASE_FALLBACK="none"
export STEEL_SEED_DEMO_DATA="0"
export STEEL_CAPTURE_SERVICE_AUTOSTART="0"
export STEEL_TRIGGER_HEALTH_REQUIRED="0"
export VITE_INSPECTION_SERVICE_ORIGIN="http://127.0.0.1:${service_port}"
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,${NO_PROXY}}"
export no_proxy="${NO_PROXY}"

service_pid=""
cleanup() {
  if [[ -n "${service_pid}" ]] && kill -0 "${service_pid}" 2>/dev/null; then
    kill "${service_pid}" 2>/dev/null || true
    wait "${service_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "Starting BKV sample service on http://127.0.0.1:${service_port} ..."
cargo run \
  --locked \
  --manifest-path "${repo_root}/app/service/Cargo.toml" \
  >"${service_log}" 2>&1 &
service_pid="$!"

health_url="http://127.0.0.1:${service_port}/api/health/live"
ready=false
for _ in $(seq 1 480); do
  if ! kill -0 "${service_pid}" 2>/dev/null; then
    echo "The BKV sample service exited during startup:" >&2
    tail -n 100 "${service_log}" >&2 || true
    exit 1
  fi
  if curl --noproxy "*" --fail --silent --max-time 1 "${health_url}" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.25
done

if [[ "${ready}" != "true" ]]; then
  echo "The BKV sample service did not become live at ${health_url}." >&2
  tail -n 100 "${service_log}" >&2 || true
  exit 1
fi

echo "BKV sample is live. Service log: ${service_log}"
echo "Opening operator client at http://127.0.0.1:${vite_port}/?app=terminal&view=bkv"
npm --prefix "${repo_root}/app/client" run dev -- \
  --host "127.0.0.1" \
  --port "${vite_port}"
