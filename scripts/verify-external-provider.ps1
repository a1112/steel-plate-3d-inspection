param(
  [int]$CapturePort = 4318,
  [int]$ServicePort = 4898,
  [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$CaptureExe = Join-Path $RepoRoot "target\capture\$Configuration\steel_capture_service.exe"
$ServiceExe = Join-Path $RepoRoot "target\cargo\debug\steel-inspection-service.exe"
$TestConfigDir = Join-Path ([System.IO.Path]::GetTempPath()) ("steel-external-provider-" + [Guid]::NewGuid().ToString("N"))

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

function Wait-HttpResponse {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)]$Process,
    [int]$TimeoutSeconds = 20
  )

  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if ($Process.HasExited) {
      throw "Process exited before HTTP readiness at $Uri (exit=$($Process.ExitCode))."
    }
    try {
      return Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    } catch {
      Start-Sleep -Milliseconds 200
    }
  } while ([DateTime]::UtcNow -lt $Deadline)
  throw "Timed out waiting for HTTP readiness at $Uri."
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
  # This is an architecture-boundary test, not a hardware-discovery test. Keep
  # it deterministic and independent from whichever real cameras are attached.
  $Capture = Start-Process -FilePath $CaptureExe -ArgumentList "--port", $CapturePort, "--driver", "simulated" -WorkingDirectory (Split-Path $CaptureExe) -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 800

  $ServiceStart = New-Object System.Diagnostics.ProcessStartInfo
  $ServiceStart.FileName = $ServiceExe
  $ServiceStart.WorkingDirectory = $RepoRoot
  $ServiceStart.UseShellExecute = $false
  $ServiceStart.CreateNoWindow = $true
  $ServiceStart.Environment["STEEL_CAPTURE_PROVIDER"] = "external-api"
  $ServiceStart.Environment["CAPTURE_SERVICE_ORIGIN"] = "http://127.0.0.1:$CapturePort"
  $ServiceStart.Environment["INSPECTION_SERVICE_PORT"] = [string]$ServicePort
  $ServiceStart.Environment["STEEL_RUNTIME_PROFILE"] = "test"
  $ServiceStart.Environment["STEEL_ALGORITHM_MODE"] = "demo"
  $ServiceStart.Environment["BAR_SURFACE_MOCK_DEFECT_COUNT"] = "0"
  $ServiceStart.Environment["STEEL_TRIGGER_HEALTH_REQUIRED"] = "0"
  $ServiceStart.Environment["STEEL_DATABASE_ENGINE"] = "sqlite"
  $ServiceStart.Environment["STEEL_SERVICE_CONFIG_DIR"] = $TestConfigDir
  foreach ($InheritedDatabaseSecret in @(
    "STEEL_DATABASE_URL",
    "STEEL_MYSQL_HOST",
    "STEEL_MYSQL_PORT",
    "STEEL_MYSQL_USER",
    "STEEL_MYSQL_PASSWORD",
    "STEEL_MYSQL_DATABASE",
    "STEEL_MYSQL_TLS_MODE",
    "STEEL_MYSQL_CA_PATH"
  )) {
    [void]$ServiceStart.Environment.Remove($InheritedDatabaseSecret)
  }
  $Service = [System.Diagnostics.Process]::Start($ServiceStart)

  $Health = Wait-HttpResponse -Uri "http://127.0.0.1:$ServicePort/api/capture/health" -Process $Service
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
  if (Test-Path -LiteralPath $TestConfigDir -PathType Container) {
    Remove-Item -LiteralPath $TestConfigDir -Recurse -Force
  }
}
