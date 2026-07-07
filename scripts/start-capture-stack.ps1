param(
  [int]$Port = 4317,
  [string]$Configuration = "Release",
  [string]$StorageRoot = "E:\steel-capture-data",
  [string]$ConfigRoot = "E:\steel-capture-data\config",
  [string]$Profile = "current-6-soft-trigger",
  [int]$ExpectedCameras = 6,
  [int]$Lines = 1000,
  [int]$TimeTriggerFreq = 300,
  [int]$LaserPower = 100,
  [int]$LaserLineSelect = 0,
  [int]$ControlMode = 0,
  [switch]$ApplyPreset,
  [switch]$StopExisting,
  [switch]$NoQt
)

$ErrorActionPreference = "Stop"

function Invoke-CaptureJson {
  param(
    [ValidateSet("GET", "POST")]
    [string]$Method,
    [string]$Path,
    [object]$Body = $null,
    [int]$TimeoutSec = 30
  )

  $Uri = "http://127.0.0.1:$Port$Path"
  if ($Method -eq "POST") {
    $Json = if ($null -eq $Body) { "{}" } else { $Body | ConvertTo-Json -Depth 8 -Compress }
    return Invoke-RestMethod -Method Post -Uri $Uri -ContentType "application/json; charset=utf-8" -Body $Json -TimeoutSec $TimeoutSec
  }

  return Invoke-RestMethod -Method Get -Uri $Uri -TimeoutSec $TimeoutSec
}

function Wait-CaptureHealth {
  param([int]$TimeoutSec = 20)

  $Deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    try {
      return Invoke-CaptureJson -Method GET -Path "/health" -TimeoutSec 3
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $Deadline)

  throw "Capture provider did not become healthy on port $Port within ${TimeoutSec}s."
}

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$CaptureExe = Join-Path $RepoRoot "target\capture\$Configuration\steel_capture_service.exe"
$QtExe = Join-Path $RepoRoot "target\capture-qt\$Configuration\steel_capture_qt_terminal.exe"
$LogDir = Join-Path $StorageRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not (Test-Path $CaptureExe -PathType Leaf)) {
  throw "Missing $CaptureExe. Run scripts/build-capture-headless.ps1 first."
}
if (-not $NoQt -and -not (Test-Path $QtExe -PathType Leaf)) {
  throw "Missing $QtExe. Run scripts/build-capture-qt.ps1 -QtPrefixPath C:\Qt first, or pass -NoQt."
}

if ($StopExisting) {
  Get-Process steel_capture_qt_terminal, steel_capture_service -ErrorAction SilentlyContinue | Stop-Process -Force
}

$ExistingHealth = $null
try {
  $ExistingHealth = Invoke-CaptureJson -Method GET -Path "/health" -TimeoutSec 3
} catch {
  $ExistingHealth = $null
}

if ($ExistingHealth) {
  Write-Host "Using existing capture provider on port $Port."
} else {
  $OldStorageRoot = $env:CAPTURE_STORAGE_ROOT
  $OldConfigRoot = $env:CAPTURE_CONFIG_ROOT
  $env:CAPTURE_STORAGE_ROOT = $StorageRoot
  $env:CAPTURE_CONFIG_ROOT = $ConfigRoot
  $Process = Start-Process -FilePath $CaptureExe `
    -ArgumentList @("--port", [string]$Port) `
    -WorkingDirectory (Split-Path $CaptureExe) `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir "capture-service.out.log") `
    -RedirectStandardError (Join-Path $LogDir "capture-service.err.log") `
    -PassThru
  $env:CAPTURE_STORAGE_ROOT = $OldStorageRoot
  $env:CAPTURE_CONFIG_ROOT = $OldConfigRoot
  Write-Host "Started capture provider PID $($Process.Id) on port $Port."
}

$Health = Wait-CaptureHealth
Write-Host "Provider health: sdkReady=$($Health.sdkReady), cameraCount=$($Health.cameraCount), storageRoot=$($Health.storageRoot)"

$Apply = Invoke-CaptureJson -Method POST -Path "/api/config/profile/apply" -TimeoutSec 60 -Body @{
  name = $Profile
  connect = $true
  applySoftTrigger = [bool]$ApplyPreset
  expectedCameras = $ExpectedCameras
}
Write-Host ("Profile apply: code={0}, connected={1}, paramApplied={2}" -f $Apply.code, $Apply.connected, $Apply.paramApplied)

$Cameras = Invoke-CaptureJson -Method GET -Path "/api/cameras" -TimeoutSec 15
$Ips = @($Cameras.cameras | ForEach-Object { $_.ip } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($Ips.Count -eq 0) {
  throw "No cameras discovered after profile apply."
}

if ($ApplyPreset) {
  $Preset = Invoke-CaptureJson -Method POST -Path "/api/capture/preset/line-continuous" -TimeoutSec 60 -Body @{
    ips = $Ips
    lines = $Lines
    timeTriggerFreq = $TimeTriggerFreq
    laserPower = $LaserPower
    laserLineSelect = $LaserLineSelect
    controlMode = $ControlMode
    connectFirst = $false
    saveToDevice = $false
  }
  Write-Host ("Line preset: code={0}, applied={1}, failed={2}, lines={3}, controlMode={4}" -f $Preset.code, $Preset.applied, $Preset.failed, $Preset.lines, $Preset.controlMode)
} else {
  Write-Host "Line preset skipped; preserving device/profile parameters. Pass -ApplyPreset to force the generic 1000-line preset."
}

$Statuses = Invoke-CaptureJson -Method GET -Path "/api/camera/statuses" -TimeoutSec 15
$StatusRows = @($Statuses.statuses | Sort-Object ip | ForEach-Object {
  [pscustomobject]@{
    ip = $_.ip
    connected = $_.connected
    mode = $_.captureConfig.controlMode
    trigger = $_.captureConfig.triggerInputType
    lines = $_.captureConfig.triggerLines
    laser = $_.captureConfig.laserEnable
    array = $_.captureConfig.arrayEnable
    power = $_.captureConfig.laserPower
  }
})
$StatusRows | Format-Table -AutoSize

if (-not $NoQt) {
  $QtRunning = Get-Process steel_capture_qt_terminal -ErrorAction SilentlyContinue
  if ($QtRunning) {
    Write-Host "Qt capture viewer is already running: $($QtRunning.Id -join ', ')."
  } else {
    $OldQtAutostart = $env:CAPTURE_QT_API_AUTOSTART
    $OldServicePort = $env:CAPTURE_SERVICE_PORT
    $env:CAPTURE_QT_API_AUTOSTART = "0"
    $env:CAPTURE_SERVICE_PORT = [string]$Port
    $QtProcess = Start-Process -FilePath $QtExe `
      -WorkingDirectory (Split-Path $QtExe) `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $LogDir "capture-qt.out.log") `
      -RedirectStandardError (Join-Path $LogDir "capture-qt.err.log") `
      -PassThru
    $env:CAPTURE_QT_API_AUTOSTART = $OldQtAutostart
    $env:CAPTURE_SERVICE_PORT = $OldServicePort
    Write-Host "Started Qt capture viewer PID $($QtProcess.Id)."
  }
}

Write-Host "Capture stack ready at http://127.0.0.1:$Port"
