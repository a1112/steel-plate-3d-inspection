param(
  [ValidateSet("Operator", "Management")]
  [string]$Mode = "Operator",
  [ValidateRange(1024, 65535)]
  [int]$ServicePort = 4873
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ServiceOrigin = "http://127.0.0.1:$ServicePort"
$DesktopExe = Join-Path $RepoRoot "target\cargo\release\steel-plate-3d-inspection-tauri.exe"
$MonitorExe = Join-Path $RepoRoot "target\cargo\release\steel-inspection-server-monitor.exe"
$MonitorOrigin = "http://127.0.0.1:4899"
$CaptureOrigin = "http://127.0.0.1:4317"
$PythonExe = "D:\project\py312\python.exe"
$CaptureScript = Join-Path $RepoRoot "scripts\sick_capture_service.py"
$CaptureProfile = Join-Path $RepoRoot "config\sites\sick-array-6\capture.json"
$MonitorLogDir = Join-Path $RepoRoot "target\run\server-monitor\logs"

function Test-ServiceLive {
  try {
    $response = Invoke-WebRequest `
      -UseBasicParsing `
      -Uri "$ServiceOrigin/api/health/live" `
      -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Test-MonitorLive {
  try {
    $response = Invoke-WebRequest `
      -UseBasicParsing `
      -Uri "$MonitorOrigin/api/health" `
      -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Test-CaptureHistoryLive {
  try {
    $response = Invoke-RestMethod `
      -Uri "$CaptureOrigin/health" `
      -TimeoutSec 2
    return $null -ne $response
  } catch {
    return $false
  }
}

if (-not (Test-ServiceLive)) {
  $managementLauncher = Join-Path $PSScriptRoot "start-background-management.ps1"
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $managementLauncher,
    "-SkipBuild",
    "-Detach",
    "-NoBrowser",
    "-EnableCaptureControl",
    "-ServicePort", [string]$ServicePort
  )
  $launcher = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList $arguments `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -PassThru
  $serviceDeadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $serviceDeadline -and -not (Test-ServiceLive)) {
    if ($launcher.HasExited -and $launcher.ExitCode -ne 0) { break }
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-ServiceLive)) {
    throw "Background management service failed to start at $ServiceOrigin."
  }
}

if (-not (Test-MonitorLive)) {
  if (-not (Test-Path -LiteralPath $MonitorExe -PathType Leaf)) {
    throw "Missing service monitor: $MonitorExe"
  }
  Start-Process `
    -FilePath $MonitorExe `
    -WorkingDirectory $RepoRoot | Out-Null
  $monitorDeadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $monitorDeadline -and -not (Test-MonitorLive)) {
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-MonitorLive)) {
    throw "Service monitor failed to start at $MonitorOrigin."
  }
}

if (-not (Test-CaptureHistoryLive)) {
  if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
    throw "Missing Python executable: $PythonExe"
  }
  New-Item -ItemType Directory -Force -Path $MonitorLogDir | Out-Null
  Start-Process `
    -FilePath $PythonExe `
    -ArgumentList @(
      $CaptureScript,
      "--profile", $CaptureProfile,
      "--host", "127.0.0.1",
      "--port", "4317",
      "--history-only"
    ) `
    -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput (Join-Path $MonitorLogDir "sick-capture-history-only-current.out.log") `
    -RedirectStandardError (Join-Path $MonitorLogDir "sick-capture-history-only-current.err.log") `
    -WindowStyle Hidden | Out-Null
  # Importing the vendor GenTL stack can take well over 30 seconds on a cold
  # workstation start, even in history-only mode.
  $captureDeadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $captureDeadline -and -not (Test-CaptureHistoryLive)) {
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-CaptureHistoryLive)) {
    throw "Capture history service failed to start at $CaptureOrigin."
  }
}

if ($Mode -eq "Management") {
  Start-Process "$ServiceOrigin/?app=parameters&service=page" | Out-Null
  exit 0
}

if (-not (Test-Path -LiteralPath $DesktopExe -PathType Leaf)) {
  throw "Missing desktop application: $DesktopExe"
}
Start-Process `
  -FilePath $DesktopExe `
  -WorkingDirectory $RepoRoot | Out-Null
