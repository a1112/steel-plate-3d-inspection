param(
  [int]$Port = 4317,
  [string]$Configuration = "Release",
  [string]$StorageRoot = "H:\",
  [string]$CameraStorageRoot = "H:\",
  [string]$ConfigRoot = "",
  [string]$Profile = "current-8-time-trigger",
  [int]$ExpectedCameras = 8,
  [int]$Lines = 1000,
  [int]$TimeTriggerFreq = 300,
  [int]$LaserPower = 100,
  [int]$LaserLineSelect = 0,
  [int]$ControlMode = 0,
  [switch]$ApplyPreset,
  [switch]$StopExisting
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

function Normalize-PathText {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return ""
  }
  try {
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/').ToLowerInvariant()
  } catch {
    return $Path.TrimEnd('\', '/').ToLowerInvariant()
  }
}

function Assert-CaptureProviderMatches {
  param(
    [object]$Health,
    [string]$ExpectedStorageRoot,
    [string]$ExpectedConfigRoot
  )

  $ActualStorage = Normalize-PathText ([string]$Health.storageRoot)
  $ExpectedStorage = Normalize-PathText $ExpectedStorageRoot
  if ($ActualStorage -ne $ExpectedStorage) {
    throw "Capture provider on port $Port uses storageRoot '$($Health.storageRoot)', expected '$ExpectedStorageRoot'. Stop it first or rerun with -StopExisting to avoid writing frames to the wrong root."
  }

  $ActualConfig = Normalize-PathText ([string]$Health.configRoot)
  $ExpectedConfig = Normalize-PathText $ExpectedConfigRoot
  if ($ActualConfig -ne $ExpectedConfig) {
    throw "Capture provider on port $Port uses configRoot '$($Health.configRoot)', expected '$ExpectedConfigRoot'. Stop it first or rerun with -StopExisting to avoid loading the wrong profile."
  }
}

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
if ($ConfigRoot.Trim().Length -eq 0) {
  $ConfigRoot = Join-Path $RepoRoot "target\config\capture"
}
$CaptureExe = Join-Path $RepoRoot "target\capture\$Configuration\steel_capture_service.exe"
$LogDir = Join-Path $RepoRoot "target\logs\capture"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path $ConfigRoot | Out-Null

$SeedConfigRoot = Join-Path $RepoRoot "config\capture"
$ExpectedProfilePath = Join-Path $ConfigRoot "profiles\$Profile\profile.json"
if (-not (Test-Path $ExpectedProfilePath -PathType Leaf) -and (Test-Path $SeedConfigRoot -PathType Container)) {
  Get-ChildItem -LiteralPath $SeedConfigRoot -Force | Copy-Item -Destination $ConfigRoot -Recurse -Force
  Write-Host "Seeded capture config from $SeedConfigRoot to $ConfigRoot."
}

if (-not (Test-Path $CaptureExe -PathType Leaf)) {
  throw "Missing $CaptureExe. Run scripts/build-capture-headless.ps1 first."
}
if ($StopExisting) {
  Get-Process steel_capture_service -ErrorAction SilentlyContinue | Stop-Process -Force
}

$ExistingHealth = $null
try {
  $ExistingHealth = Invoke-CaptureJson -Method GET -Path "/health" -TimeoutSec 3
} catch {
  $ExistingHealth = $null
}

if ($ExistingHealth) {
  Write-Host "Using existing capture provider on port $Port."
  Assert-CaptureProviderMatches -Health $ExistingHealth -ExpectedStorageRoot $StorageRoot -ExpectedConfigRoot $ConfigRoot
} else {
  $OldStorageRoot = $env:CAPTURE_STORAGE_ROOT
  $OldCameraStorageRoot = $env:CAPTURE_CAMERA_STORAGE_ROOT
  $OldConfigRoot = $env:CAPTURE_CONFIG_ROOT
  $env:CAPTURE_STORAGE_ROOT = $StorageRoot
  $env:CAPTURE_CAMERA_STORAGE_ROOT = $CameraStorageRoot
  $env:CAPTURE_CONFIG_ROOT = $ConfigRoot
  $Process = Start-Process -FilePath $CaptureExe `
    -ArgumentList @("--port", [string]$Port) `
    -WorkingDirectory (Split-Path $CaptureExe) `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir "capture-service.out.log") `
    -RedirectStandardError (Join-Path $LogDir "capture-service.err.log") `
    -PassThru
  $env:CAPTURE_STORAGE_ROOT = $OldStorageRoot
  $env:CAPTURE_CAMERA_STORAGE_ROOT = $OldCameraStorageRoot
  $env:CAPTURE_CONFIG_ROOT = $OldConfigRoot
  Write-Host "Started capture provider PID $($Process.Id) on port $Port."
}

$Health = Wait-CaptureHealth
Assert-CaptureProviderMatches -Health $Health -ExpectedStorageRoot $StorageRoot -ExpectedConfigRoot $ConfigRoot
Write-Host "Provider health: sdkReady=$($Health.sdkReady), cameraCount=$($Health.cameraCount), storageRoot=$($Health.storageRoot)"

$Apply = Invoke-CaptureJson -Method POST -Path "/api/config/profile/apply" -TimeoutSec 60 -Body @{
  name = $Profile
  autoConnect = $true
  applyCameraParams = $false
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

Write-Host "Headless capture stack ready at http://127.0.0.1:$Port"
