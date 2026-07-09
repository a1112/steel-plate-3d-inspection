param(
  [int]$CapturePort = 4317,
  [int]$ServicePort = 4873,
  [int]$TriggerPort = 4881,
  [int]$ClientPort = 1432,
  [string]$Configuration = "Release",
  [ValidateSet("debug", "release")]
  [string]$ServiceProfile = "debug",
  [string]$StorageRoot = "H:\",
  [string]$CameraStorageRoot = "H:\",
  [string]$CaptureProfile = "current-6-soft-trigger",
  [ValidateSet("api", "gray", "secondary", "manual")]
  [string]$TriggerMode = "manual",
  [switch]$NoQt,
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
$ClientScript = Join-Path $PSScriptRoot "run-client-static.ps1"

if (-not (Test-Path $CaptureScript -PathType Leaf)) { throw "Missing $CaptureScript" }
if (-not (Test-Path $ServiceScript -PathType Leaf)) { throw "Missing $ServiceScript" }
if (-not (Test-Path $TriggerScript -PathType Leaf)) { throw "Missing $TriggerScript" }
if (-not (Test-Path $ClientScript -PathType Leaf)) { throw "Missing $ClientScript" }

Write-Host "Starting capture provider and Qt viewer..."
$CaptureStartArgs = @{
  Port = $CapturePort
  Configuration = $Configuration
  StorageRoot = $StorageRoot
  CameraStorageRoot = $CameraStorageRoot
  Profile = $CaptureProfile
}
if ($NoQt) {
  $CaptureStartArgs.NoQt = $true
}
if ($StopExisting) {
  $CaptureStartArgs.StopExisting = $true
}
& $CaptureScript @CaptureStartArgs
$CaptureHealth = Wait-HttpJson -Name "Capture provider" -Uri "http://127.0.0.1:$CapturePort/health" -TimeoutSec 30
Write-Host ("Capture ready: sdkReady={0}, cameraCount={1}" -f $CaptureHealth.sdkReady, $CaptureHealth.cameraCount)

if (-not (Test-LocalTcpPort -Port $ServicePort)) {
  Start-LongRunningScript -Name "service" -ScriptPath $ServiceScript -Arguments @(
    "-Provider", "external-api",
    "-CaptureOrigin", "http://127.0.0.1:$CapturePort",
    "-Port", [string]$ServicePort,
    "-Profile", $ServiceProfile,
    "-NoCaptureAutostart",
    "-ForceParameters"
  ) | Out-Null
} else {
  Write-Host "Rust service already listening on port $ServicePort."
}
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

if (-not (Test-LocalTcpPort -Port $ClientPort)) {
  $ClientArgs = @("-Port", [string]$ClientPort)
  if ($OpenBrowser) {
    $ClientArgs += "-OpenBrowser"
  }
  Start-LongRunningScript -Name "client-static" -ScriptPath $ClientScript -Arguments $ClientArgs | Out-Null
} else {
  Write-Host "Client static server already listening on port $ClientPort."
}

$ClientUrl = "http://127.0.0.1:$ClientPort/?app=terminal"
Wait-HttpHtml -Name "Static client" -Uri $ClientUrl -TimeoutSec 30 | Out-Null
Write-Host "Client ready: $ClientUrl"

if ($OpenBrowser -and (Test-LocalTcpPort -Port $ClientPort)) {
  Start-Process $ClientUrl | Out-Null
}

Write-Host ""
Write-Host "Integrated capture management is ready:"
Write-Host "  Capture API     http://127.0.0.1:$CapturePort"
Write-Host "  Rust service    http://127.0.0.1:$ServicePort"
Write-Host "  Trigger gateway http://127.0.0.1:$TriggerPort/manual"
Write-Host "  Client          $ClientUrl"
Write-Host "  Logs            $LogDir"
