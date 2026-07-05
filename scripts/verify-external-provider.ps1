param(
  [int]$CapturePort = 4318,
  [int]$ServicePort = 4898,
  [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$CaptureExe = Join-Path $RepoRoot "target\capture\$Configuration\steel_capture_service.exe"
$ServiceExe = Join-Path $RepoRoot "target\cargo\debug\steel-inspection-service.exe"

function Invoke-Checked {
  param(
    [string]$Command,
    [string[]]$Arguments,
    [string]$WorkingDirectory = $RepoRoot
  )
  Push-Location $WorkingDirectory
  try {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "$Command failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Stop-IfRunning {
  param($Process)
  if ($Process -and -not $Process.HasExited) {
    $Process.Kill()
    $Process.WaitForExit()
  }
}

if (-not (Test-Path $CaptureExe)) {
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-capture-headless.ps1"), "-Configuration", $Configuration)
}

Invoke-Checked "cargo" @("build", "--manifest-path", (Join-Path $RepoRoot "app\service\Cargo.toml"))

if (-not (Test-Path $ServiceExe)) {
  throw "Missing service executable: $ServiceExe"
}

$Capture = $null
$Service = $null

try {
  $Capture = Start-Process -FilePath $CaptureExe -ArgumentList "--port", $CapturePort -WorkingDirectory (Split-Path $CaptureExe) -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 800

  $ServiceStart = New-Object System.Diagnostics.ProcessStartInfo
  $ServiceStart.FileName = $ServiceExe
  $ServiceStart.WorkingDirectory = $RepoRoot
  $ServiceStart.UseShellExecute = $false
  $ServiceStart.CreateNoWindow = $true
  $ServiceStart.Environment["STEEL_CAPTURE_PROVIDER"] = "external-api"
  $ServiceStart.Environment["CAPTURE_SERVICE_ORIGIN"] = "http://127.0.0.1:$CapturePort"
  $ServiceStart.Environment["INSPECTION_SERVICE_PORT"] = [string]$ServicePort
  $Service = [System.Diagnostics.Process]::Start($ServiceStart)

  Start-Sleep -Milliseconds 1200

  $Health = Invoke-WebRequest -Uri "http://127.0.0.1:$ServicePort/api/capture/health" -UseBasicParsing -ErrorAction Stop
  $HealthJson = $Health.Content | ConvertFrom-Json
  if ($Health.StatusCode -ne 200 -or -not $HealthJson.service) {
    throw "Unexpected capture health response: $($Health.Content)"
  }

  $Cameras = Invoke-WebRequest -Uri "http://127.0.0.1:$ServicePort/api/cameras" -UseBasicParsing -ErrorAction Stop
  $CamerasJson = $Cameras.Content | ConvertFrom-Json
  if ($Cameras.StatusCode -ne 200 -or $CamerasJson.count -lt 1) {
    throw "Expected at least one camera through the external provider proxy: $($Cameras.Content)"
  }

  Write-Host "External provider proxy verified: service=$($HealthJson.service), cameras=$($CamerasJson.count), origin=http://127.0.0.1:$CapturePort"
} finally {
  Stop-IfRunning $Service
  Stop-IfRunning $Capture
}
