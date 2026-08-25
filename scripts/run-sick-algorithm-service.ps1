param(
  [Parameter(Mandatory = $true)]
  [string]$CaptureProfile,
  [string]$PythonExecutable = "D:\project\py312\python.exe",
  [string]$CaptureOrigin = "http://127.0.0.1:4317",
  [string]$InspectionOrigin = "http://127.0.0.1:4873",
  [int]$Port = 4875,
  [string]$ResultRoot = "D:\Data\inspection-results",
  [string]$InputRoot = "",
  [ValidateSet("debug", "release")]
  [string]$Profile = "debug"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$CaptureProfile = (Resolve-Path -LiteralPath $CaptureProfile).Path
if (-not (Test-Path -LiteralPath $PythonExecutable -PathType Leaf)) {
  throw "Python executable was not found: $PythonExecutable"
}
$Executable = Join-Path $RepoRoot "target\algorithm-service\$Profile\steel-algorithm-service.exe"
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
  throw "Algorithm service was not built: $Executable"
}
if ([string]::IsNullOrWhiteSpace($InputRoot)) {
  $InputRoot = Join-Path $RepoRoot "target\run\sick-algorithm"
}
New-Item -ItemType Directory -Force -Path $ResultRoot, $InputRoot | Out-Null

$env:STEEL_SICK_CAPTURE_PROFILE = $CaptureProfile
$env:STEEL_PYTHON_EXECUTABLE = (Resolve-Path -LiteralPath $PythonExecutable).Path
$env:CAPTURE_SERVICE_ORIGIN = $CaptureOrigin.TrimEnd("/")
$env:INSPECTION_SERVICE_ORIGIN = $InspectionOrigin.TrimEnd("/")
$env:STEEL_ALGORITHM_SERVICE_PORT = [string]$Port
$env:STEEL_RESULT_ROOT = (Resolve-Path -LiteralPath $ResultRoot).Path
$env:STEEL_ALGORITHM_INPUT_ROOTS = (Resolve-Path -LiteralPath $InputRoot).Path
$env:STEEL_SICK_ALGORITHM_POLL_SECONDS = "1"
$env:STEEL_SICK_ALGORITHM_SETTLE_SECONDS = "2"

& $Executable
exit $LASTEXITCODE
