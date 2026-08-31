param(
  [ValidateRange(1024, 65535)]
  [int]$ServicePort = 4873,
  [ValidateRange(5, 120)]
  [int]$ReadyTimeoutSec = 30,
  [ValidateSet("debug", "release")]
  [string]$Profile = "debug",
  [string]$EnvFile = "",
  [string]$ConfigRoot = "",
  [string]$RuntimeStateRoot = "",
  [string]$RuntimeLogDir = "",
  [string]$WebRoot = "",
  [string]$CargoTargetDir = "",
  [switch]$SkipBuild,
  [switch]$NoBrowser,
  [switch]$Detach,
  [switch]$ProbeOnly
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ClientDir = Join-Path $RepoRoot "app\client"
$RunRoot = Join-Path $RepoRoot "target\run\background-management"
$ServiceOrigin = "http://127.0.0.1:$ServicePort"
$ManagementUrl = "$ServiceOrigin/?app=parameters&service=page"

if ([string]::IsNullOrWhiteSpace($ConfigRoot)) {
  $ConfigRoot = Join-Path $RepoRoot "target\config\service"
}
if ([string]::IsNullOrWhiteSpace($RuntimeStateRoot)) {
  $RuntimeStateRoot = $RunRoot
}
if ([string]::IsNullOrWhiteSpace($RuntimeLogDir)) {
  $RuntimeLogDir = Join-Path $RunRoot "logs"
}
if ([string]::IsNullOrWhiteSpace($WebRoot)) {
  $WebRoot = Join-Path $RepoRoot "target\client\frontend-dist"
}
if ([string]::IsNullOrWhiteSpace($CargoTargetDir)) {
  # Keep this executable independent from long-running development services so
  # Windows never has to replace an image that another process has locked.
  $CargoTargetDir = Join-Path $RepoRoot "target\cargo-background-management"
} elseif (-not [System.IO.Path]::IsPathRooted($CargoTargetDir)) {
  $CargoTargetDir = Join-Path $RepoRoot $CargoTargetDir
}
$CargoTargetDir = [System.IO.Path]::GetFullPath($CargoTargetDir)

function Get-ListenerProcessId([int]$Port) {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @("127.0.0.1", "0.0.0.0", "::1", "::") } |
    Select-Object -First 1
  if ($listener) {
    return [int]$listener.OwningProcess
  }
  return $null
}

function Test-ServiceReady {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$ServiceOrigin/api/health/live" -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

$occupiedBy = Get-ListenerProcessId -Port $ServicePort
if ($occupiedBy) {
  throw "Service port $ServicePort is already owned by PID $occupiedBy. Stop the existing runtime or choose another port."
}

if (-not $SkipBuild) {
  $previousCargoTargetDir = $env:CARGO_TARGET_DIR
  try {
    $env:CARGO_TARGET_DIR = $CargoTargetDir
    & (Join-Path $PSScriptRoot "build-service.ps1") -Profile $Profile -Locked
    if ($LASTEXITCODE -ne 0) {
      throw "Inspection service build failed."
    }
  } finally {
    $env:CARGO_TARGET_DIR = $previousCargoTargetDir
  }

  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCommand) {
    throw "npm.cmd was not found. Install Node.js or add it to PATH."
  }
  $previousClientOrigin = $env:VITE_INSPECTION_SERVICE_ORIGIN
  try {
    $env:VITE_INSPECTION_SERVICE_ORIGIN = $ServiceOrigin
    & $npmCommand.Source --prefix $ClientDir run build
    if ($LASTEXITCODE -ne 0) {
      throw "Background management frontend build failed."
    }
  } finally {
    $env:VITE_INSPECTION_SERVICE_ORIGIN = $previousClientOrigin
  }
}

$serviceProfileDirectory = if ($Profile -eq "release") { "release" } else { "debug" }
$serviceExe = Join-Path $CargoTargetDir "$serviceProfileDirectory\steel-inspection-service.exe"
if (-not (Test-Path -LiteralPath $serviceExe -PathType Leaf)) {
  throw "Missing inspection service executable: $serviceExe. Run without -SkipBuild first."
}
if (-not (Test-Path -LiteralPath (Join-Path $WebRoot "index.html") -PathType Leaf)) {
  throw "Missing built management frontend: $WebRoot\index.html. Run without -SkipBuild first."
}

New-Item -ItemType Directory -Force -Path $ConfigRoot, $RuntimeStateRoot, $RuntimeLogDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stdoutPath = Join-Path $RuntimeLogDir "background-management-$stamp.out.log"
$stderrPath = Join-Path $RuntimeLogDir "background-management-$stamp.err.log"
$servicePidPath = Join-Path $RuntimeStateRoot "background-management-$stamp.pid"
$serviceArguments = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", (Join-Path $PSScriptRoot "run-service.ps1"),
  "-Provider", "headless-cpp",
  "-HostAddress", "0.0.0.0",
  "-Port", [string]$ServicePort,
  "-Profile", $Profile,
  "-ServiceExe", $serviceExe,
  "-ServicePidFile", $servicePidPath,
  "-RuntimeProfile", "development",
  "-AlgorithmMode", "demo",
  "-DatabaseEngine", "sqlite",
  "-DatabaseFallback", "none",
  "-ConfigRoot", $ConfigRoot,
  "-RuntimeStateRoot", $RuntimeStateRoot,
  "-RuntimeLogDir", $RuntimeLogDir,
  "-WebRoot", $WebRoot,
  "-NoCaptureAutostart",
  "-ManagementOnly",
  "-ForceParameters"
)
if (-not [string]::IsNullOrWhiteSpace($EnvFile)) {
  $serviceArguments += @("-EnvFile", (Resolve-Path -LiteralPath $EnvFile).Path)
}

$serviceLauncher = $null
$servicePid = $null
$keepService = $false
try {
  # Some Codex/Windows hosts expose both PATH and Path. PowerShell 5.1's
  # Start-Process rejects that environment block as a duplicate-key map.
  # Normalize only this launcher process; the caller's environment is untouched.
  $processEnvironment = [Environment]::GetEnvironmentVariables("Process")
  $processEnvironmentKeys = @($processEnvironment.Keys | ForEach-Object { [string]$_ })
  if ($processEnvironmentKeys -ccontains "PATH" -and $processEnvironmentKeys -ccontains "Path") {
    $effectivePath = [string]$processEnvironment["Path"]
    [Environment]::SetEnvironmentVariable("PATH", $null, "Process")
    [Environment]::SetEnvironmentVariable("Path", $effectivePath, "Process")
  }

  $serviceLauncher = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList $serviceArguments `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

  $pidDeadline = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $pidDeadline -and
      -not (Test-Path -LiteralPath $servicePidPath -PathType Leaf) -and
      -not $serviceLauncher.HasExited) {
    Start-Sleep -Milliseconds 100
  }
  if (-not (Test-Path -LiteralPath $servicePidPath -PathType Leaf)) {
    throw "Background management service did not publish its tracked PID."
  }
  $servicePidText = (Get-Content -LiteralPath $servicePidPath -Raw).Trim()
  $parsedServicePid = 0
  if (-not [int]::TryParse($servicePidText, [ref]$parsedServicePid) -or $parsedServicePid -le 0) {
    throw "Background management service published an invalid PID: $servicePidText"
  }
  $trackedService = Get-Process -Id $parsedServicePid -ErrorAction Stop
  if (-not $trackedService.Path.Equals($serviceExe, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Background management PID points to an unexpected executable: $($trackedService.Path)"
  }
  $servicePid = $parsedServicePid

  $deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
  while ((Get-Date) -lt $deadline -and -not (Test-ServiceReady)) {
    if ($serviceLauncher.HasExited) {
      $errorTail = @(Get-Content -LiteralPath $stderrPath -Tail 30 -ErrorAction SilentlyContinue)
      throw "Background management service exited before readiness. $($errorTail -join [Environment]::NewLine)"
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-ServiceReady)) {
    throw "Background management service did not become ready at $ServiceOrigin within $ReadyTimeoutSec seconds."
  }

  $lifecycle = Invoke-RestMethod -UseBasicParsing -Uri "$ServiceOrigin/api/capture/lifecycle" -TimeoutSec 5
  $captureStarted = [bool]$lifecycle.running -or
    [bool]$lifecycle.lifecycle.desiredRunning -or
    $null -ne $lifecycle.lifecycle.pid
  $managementFenceMissing = [bool]$lifecycle.controlAllowed -or -not [bool]$lifecycle.managementOnly
  if ($captureStarted -or $managementFenceMissing -or [bool]$lifecycle.lifecycle.autostart) {
    throw "Management-only safety check failed: capture lifecycle is not fenced and stopped."
  }

  Write-Host "Background management ready: $ManagementUrl"
  Write-Host "Business API PID: $servicePid"
  Write-Host "Capture autostart: disabled; capture controls: disabled; capture PID: none"
  Write-Host "Logs: $RuntimeLogDir"

  if (-not $NoBrowser -and -not $ProbeOnly) {
    Start-Process -FilePath $ManagementUrl | Out-Null
  }
  if ($ProbeOnly) {
    Write-Host "Background management safety probe passed."
    return
  }
  if ($Detach) {
    $keepService = $true
    Write-Host "Detached. Stop PID $servicePid when background management is no longer needed."
    return
  }

  Write-Host "Press Ctrl+C to stop the background management service."
  $serviceLauncher.WaitForExit()
} finally {
  if (-not $keepService) {
    if ($servicePid) {
      $trackedService = Get-Process -Id $servicePid -ErrorAction SilentlyContinue
      if ($trackedService -and $trackedService.Path.Equals($serviceExe, [System.StringComparison]::OrdinalIgnoreCase)) {
        Stop-Process -Id $servicePid -Force -ErrorAction SilentlyContinue
      }
    }
    if ($serviceLauncher -and -not $serviceLauncher.HasExited) {
      if (-not $serviceLauncher.WaitForExit(5000)) {
        Stop-Process -Id $serviceLauncher.Id -Force -ErrorAction SilentlyContinue
      }
    }
    Remove-Item -LiteralPath $servicePidPath -Force -ErrorAction SilentlyContinue
  }
}
