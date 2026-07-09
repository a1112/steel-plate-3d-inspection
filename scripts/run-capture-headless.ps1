param(
  [int]$Port = 4317,
  [string]$Configuration = "Release",
  [string]$StorageRoot = "H:\",
  [string]$CameraStorageRoot = "H:\",
  [string]$ConfigRoot = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Exe = Join-Path $RepoRoot "target\capture\$Configuration\steel_capture_service.exe"
if ($ConfigRoot.Trim().Length -eq 0) {
  $ConfigRoot = Join-Path $RepoRoot "target\config\capture"
}
New-Item -ItemType Directory -Force -Path $ConfigRoot | Out-Null

if (-not (Test-Path $Exe)) {
  throw "Missing $Exe. Run scripts/build-capture-headless.ps1 first."
}

Push-Location (Split-Path $Exe)
try {
  $env:CAPTURE_STORAGE_ROOT = $StorageRoot
  $env:CAPTURE_CAMERA_STORAGE_ROOT = $CameraStorageRoot
  $env:CAPTURE_CONFIG_ROOT = $ConfigRoot
  & $Exe --port $Port
} finally {
  Pop-Location
}
