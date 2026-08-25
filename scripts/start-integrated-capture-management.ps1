param(
  [int]$CapturePort = 4317,
  [int]$ServicePort = 4873,
  [int]$TriggerPort = 4881,
  [int]$ClientPort = 1432,
  [string]$Configuration = "Release",
  [ValidateSet("debug", "release")]
  [string]$ServiceProfile = "release",
  [string]$StorageRoot = "H:\",
  [string]$CameraStorageRoot = "H:\",
  [Parameter(Mandatory = $true)]
  [string]$ArtifactAllowedRoots,
  [string]$CaptureProfile = "current-8-time-trigger",
  [ValidateSet("api", "tcp", "udp", "gray", "secondary", "manual")]
  [string]$TriggerMode = "manual",
  [switch]$StopExisting,
  [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogDir = Join-Path $RepoRoot "target\logs\integrated"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Test-LocalTcpPort {
  param([int]$Port)

  try {
    $Client = [System.Net.Sockets.TcpClient]::new()
    try {
      $Async = $Client.BeginConnect("127.0.0.1", $Port, $null, $null)
      if (-not $Async.AsyncWaitHandle.WaitOne(500)) {
        return $false
      }
      $Client.EndConnect($Async)
      return $true
    } finally {
      $Client.Dispose()
    }
  } catch {
    return $false
  }
}

function Wait-HttpJson {
  param(
    [string]$Name,
    [string]$Uri,
    [int]$TimeoutSec = 30
  )

  $Deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    try {
      return Invoke-RestMethod -Method Get -Uri $Uri -TimeoutSec 3
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $Deadline)

  throw "$Name did not become ready at $Uri within ${TimeoutSec}s."
}

function Wait-HttpHtml {
  param(
    [string]$Name,
    [string]$Uri,
    [int]$TimeoutSec = 30
  )

  $Deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    try {
      $Response = Invoke-WebRequest -Method Get -Uri $Uri -UseBasicParsing -TimeoutSec 3
      if ($Response.StatusCode -eq 200 -and [string]$Response.Content -match "<html") {
        return $Response
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $Deadline)

  throw "$Name did not become ready at $Uri within ${TimeoutSec}s."
}

function Normalize-ProcessPathEnvironment {
  $PathValue = [Environment]::GetEnvironmentVariable("Path", "Process")
  if ([string]::IsNullOrEmpty($PathValue)) {
    $PathValue = [Environment]::GetEnvironmentVariable("PATH", "Process")
  }
  [Environment]::SetEnvironmentVariable("PATH", $null, "Process")
  if (-not [string]::IsNullOrEmpty($PathValue)) {
    [Environment]::SetEnvironmentVariable("Path", $PathValue, "Process")
  }
}

function Start-LongRunningScript {
  param(
    [string]$Name,
    [string]$ScriptPath,
    [string[]]$Arguments
  )

  $OutLog = Join-Path $LogDir "$Name.out.log"
  $ErrLog = Join-Path $LogDir "$Name.err.log"
  $ArgList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath) + $Arguments
  Normalize-ProcessPathEnvironment
  $Process = Start-Process -FilePath "powershell.exe" `
    -ArgumentList $ArgList `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog `
    -PassThru
  Write-Host "$Name started: PID $($Process.Id), logs $OutLog"
  return $Process
}

if ($StopExisting) {
  $StopScript = Join-Path $PSScriptRoot "stop-runtime.ps1"
  if (Test-Path $StopScript -PathType Leaf) {
    & $StopScript -Ports @($CapturePort, $ServicePort, $TriggerPort, $ClientPort)
  }
}

$CaptureScript = Join-Path $PSScriptRoot "start-capture-stack.ps1"
$ServiceScript = Join-Path $PSScriptRoot "run-service.ps1"
$TriggerScript = Join-Path $PSScriptRoot "run-trigger-gateway.ps1"
$WebRoot = Join-Path $RepoRoot "target\client\frontend-dist"

if (-not (Test-Path $CaptureScript -PathType Leaf)) { throw "Missing $CaptureScript" }
if (-not (Test-Path $ServiceScript -PathType Leaf)) { throw "Missing $ServiceScript" }
if (-not (Test-Path $TriggerScript -PathType Leaf)) { throw "Missing $TriggerScript" }
if (-not (Test-Path (Join-Path $WebRoot "index.html") -PathType Leaf)) {
  throw "Missing built web client in $WebRoot. Run scripts/build-client.ps1 first."
}

$CaptureExe = Join-Path $RepoRoot "target\capture\$Configuration\steel_capture_service.exe"
$CaptureConfigRoot = Join-Path $RepoRoot "target\config\capture"
if (-not (Test-Path $CaptureExe -PathType Leaf)) {
  throw "Missing $CaptureExe. Run scripts/build-capture-headless.ps1 first."
}
New-Item -ItemType Directory -Force -Path $CaptureConfigRoot | Out-Null
$SeedConfigRoot = Join-Path $RepoRoot "config\capture"
$ExpectedProfilePath = Join-Path $CaptureConfigRoot "profiles\$CaptureProfile\profile.json"
if (-not (Test-Path $ExpectedProfilePath -PathType Leaf) -and (Test-Path $SeedConfigRoot -PathType Container)) {
  Get-ChildItem -LiteralPath $SeedConfigRoot -Force | Copy-Item -Destination $CaptureConfigRoot -Recurse -Force
}

Write-Host "Starting Rust service with managed capture child..."
if (-not (Test-LocalTcpPort -Port $ServicePort)) {
  Start-LongRunningScript -Name "service" -ScriptPath $ServiceScript -Arguments @(
    "-Provider", "headless-cpp",
    "-CaptureOrigin", "http://127.0.0.1:$CapturePort",
    "-CaptureExe", $CaptureExe,
    "-CaptureConfigRoot", $CaptureConfigRoot,
    "-CaptureStorageRoot", $StorageRoot,
    "-CameraStorageRoot", $CameraStorageRoot,
    "-TriggerOrigin", "http://127.0.0.1:$TriggerPort",
    "-Port", [string]$ServicePort,
    "-WebRoot", $WebRoot,
    "-Profile", $ServiceProfile,
    "-ArtifactAllowedRoots", $ArtifactAllowedRoots,
    "-ForceParameters"
  ) | Out-Null
} else {
  Write-Host "Rust service already listening on port $ServicePort."
}
$ServiceLive = Wait-HttpJson -Name "Rust service" -Uri "http://127.0.0.1:$ServicePort/api/health/live" -TimeoutSec 30
$CaptureLifecycle = Wait-HttpJson -Name "Managed capture lifecycle" -Uri "http://127.0.0.1:$ServicePort/api/capture/lifecycle" -TimeoutSec 30
if ([string]$CaptureLifecycle.lifecycle.phase -ne "ready") {
  throw "Managed capture lifecycle is '$($CaptureLifecycle.lifecycle.phase)': $($CaptureLifecycle.lifecycle.lastError)"
}

# Reuse the capture configuration/profile checks, but the provider is already
# running as a Rust-owned child and this script will not spawn another process.
$CaptureStartArgs = @{
  Port = $CapturePort
  Configuration = $Configuration
  StorageRoot = $StorageRoot
  CameraStorageRoot = $CameraStorageRoot
  Profile = $CaptureProfile
}
& $CaptureScript @CaptureStartArgs
$CaptureHealth = Wait-HttpJson -Name "Capture provider" -Uri "http://127.0.0.1:$CapturePort/health" -TimeoutSec 30
Write-Host ("Capture ready: sdkReady={0}, cameraCount={1}" -f $CaptureHealth.sdkReady, $CaptureHealth.cameraCount)

$ProductionStatus = Wait-HttpJson -Name "Rust service" -Uri "http://127.0.0.1:$ServicePort/api/production/status" -TimeoutSec 30
Write-Host ("Service ready: production code={0}" -f $ProductionStatus.code)

if (-not (Test-LocalTcpPort -Port $TriggerPort)) {
  Start-LongRunningScript -Name "trigger-gateway" -ScriptPath $TriggerScript -Arguments @(
    "-Port", [string]$TriggerPort,
    "-InspectionServiceOrigin", "http://127.0.0.1:$ServicePort",
    "-Mode", $TriggerMode,
    "-Profile", $ServiceProfile,
    "-ForceParameters"
  ) | Out-Null
} else {
  Write-Host "Trigger gateway already listening on port $TriggerPort."
}
$TriggerStatus = Wait-HttpJson -Name "Trigger gateway" -Uri "http://127.0.0.1:$TriggerPort/api/trigger/status" -TimeoutSec 30
Write-Host ("Trigger gateway ready: mode={0}, manualAllowed={1}" -f $TriggerStatus.mode, $TriggerStatus.manualAllowed)

$ClientUrl = "http://127.0.0.1:$ServicePort/?app=terminal"
Wait-HttpHtml -Name "Service-hosted client" -Uri $ClientUrl -TimeoutSec 30 | Out-Null
Write-Host "Client ready: $ClientUrl"

if ($OpenBrowser -and (Test-LocalTcpPort -Port $ServicePort)) {
  Start-Process $ClientUrl | Out-Null
}

Write-Host ""
Write-Host "Integrated capture management is ready:"
Write-Host "  Capture API     http://127.0.0.1:$CapturePort"
Write-Host "  Rust service    http://127.0.0.1:$ServicePort"
Write-Host "  Trigger gateway http://127.0.0.1:$TriggerPort/manual"
Write-Host "  Client          $ClientUrl"
Write-Host "  Logs            $LogDir"
