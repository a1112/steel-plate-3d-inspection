param(
  [int]$ServicePort = 4873,
  [string]$EnvFile = "",
  [ValidateRange(5, 120)]
  [int]$ServiceReadyTimeoutSec = 30,
  [switch]$SkipServiceBuild,
  [switch]$NoService,
  [switch]$NoProcessingServices,
  [switch]$AllowNetworkDependencyFetch,
  [string]$DataRoot = "D:\Data",
  [string]$SickCaptureProfile = "",
  [switch]$SickCaptureHistoryOnly,
  [string]$PythonExecutable = "D:\project\py312\python.exe",
  [string]$CargoRegistryMirror = "https://rsproxy.cn/index/"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ClientDir = Join-Path $RepoRoot "app\client"
$RunDir = Join-Path $RepoRoot "target\run\tauri-dev"
. (Join-Path $PSScriptRoot "lib-env.ps1")

Import-EnvFile $EnvFile
# Tauri debug mode always talks to the locally started inspection service.
# Keeping this deterministic prevents an EnvFile production origin from
# bypassing the split image/algorithm services started below.
$env:VITE_INSPECTION_SERVICE_ORIGIN = "http://127.0.0.1:$ServicePort"

$NpmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
$NpmPath = if ($NpmCommand) { $NpmCommand.Source } else { Join-Path $env:ProgramFiles "nodejs\npm.cmd" }
if (-not (Test-Path $NpmPath -PathType Leaf)) {
  throw "npm.cmd was not found. Install Node.js or add its directory to PATH."
}
$NodeDirectory = Split-Path $NpmPath -Parent
if (($env:Path -split ";" | ForEach-Object { $_.TrimEnd("\") }) -notcontains $NodeDirectory.TrimEnd("\")) {
  $env:Path = "$NodeDirectory;$env:Path"
}

$ServiceOrigin = "http://127.0.0.1:$ServicePort"
$ImageServicePort = 4874
$ImageWorkerPort = 4875
$DefectWorkerPort = 4876
$BkvWorkerPort = 4877
$ProcessingRoot = Join-Path $RunDir "processing"
$ResultRoot = Join-Path $DataRoot "inspection-results"
$AlgorithmInputRoot = Join-Path $ProcessingRoot "algorithm-input"
$InspectionWorldCacheRoot = Join-Path $RunDir "cache\inspection-world"
$LogRoot = Join-Path $RunDir "logs"
$env:STEEL_RUNTIME_STATE_ROOT = $RunDir
$env:STEEL_RUNTIME_LOG_DIR = $LogRoot
$ImageServiceLauncher = $null
$ImageWorkerLauncher = $null
$DefectWorkerLauncher = $null
$BkvWorkerLauncher = $null
$ServiceLauncher = $null
$SickCaptureLauncher = $null
$OwnedServicePid = $null
New-Item -ItemType Directory -Force -Path $RunDir, $LogRoot | Out-Null

if ($SickCaptureProfile -and $SickCaptureProfile.Trim().Length -gt 0) {
  $SickCaptureProfile = [string](Resolve-Path $SickCaptureProfile)
  if (-not (Test-Path $PythonExecutable -PathType Leaf)) {
    throw "Python executable was not found: $PythonExecutable"
  }
  $env:STEEL_SICK_CAPTURE_PROFILE = $SickCaptureProfile
  $env:STEEL_PYTHON_EXECUTABLE = $PythonExecutable
  $env:CAPTURE_SERVICE_ORIGIN = "http://127.0.0.1:4317"
  $env:INSPECTION_SERVICE_ORIGIN = $ServiceOrigin
  if (-not $env:STEEL_TRIGGER_HEALTH_REQUIRED) {
    # This profile derives steel-in/out directly from the six grayscale
    # streams; an external trigger gateway is therefore optional.
    $env:STEEL_TRIGGER_HEALTH_REQUIRED = "0"
  }
}
if ($SickCaptureHistoryOnly -and -not $SickCaptureProfile) {
  throw "-SickCaptureHistoryOnly requires -SickCaptureProfile."
}

function Test-InspectionServiceReady {
  try {
    $Response = Invoke-WebRequest -UseBasicParsing -Uri "$ServiceOrigin/api/health/live" -TimeoutSec 2
    return $Response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Test-HttpReady([string]$Uri) {
  try { return (Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }
}

function Get-InspectionServicePid {
  $Listener = Get-NetTCPConnection -LocalPort $ServicePort -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @("127.0.0.1", "0.0.0.0", "::1", "::") } |
    Select-Object -First 1
  if ($Listener) {
    return [int]$Listener.OwningProcess
  }
  return $null
}

function Stop-ProcessTree([int]$RootProcessId) {
  $Children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$RootProcessId" -ErrorAction SilentlyContinue)
  foreach ($Child in $Children) {
    Stop-ProcessTree -RootProcessId ([int]$Child.ProcessId)
  }
  Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
}

try {
  if ($SickCaptureProfile) {
    if (Test-HttpReady "http://127.0.0.1:4317/health") {
      Write-Host "Using SICK capture service already running at http://127.0.0.1:4317."
    } else {
      $SickCaptureArguments = @(
        (Join-Path $RepoRoot "scripts\sick_capture_service.py"),
        "--profile", $SickCaptureProfile,
        "--host", "127.0.0.1",
        "--port", "4317"
      )
      if ($SickCaptureHistoryOnly) {
        $SickCaptureArguments += "--history-only"
      }
      $SickCaptureLauncher = Start-Process -FilePath $PythonExecutable `
        -ArgumentList $SickCaptureArguments `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogRoot "sick-capture.out.log") `
        -RedirectStandardError (Join-Path $LogRoot "sick-capture.err.log") `
        -PassThru
      try {
        # Camera transport and steel-boundary decisions must preempt optional
        # historical preprocessing when both are active on the same host.
        $SickCaptureLauncher.PriorityClass = "AboveNormal"
      } catch {
        Write-Warning "Could not raise SICK capture priority: $($_.Exception.Message)"
      }
      $CaptureDeadline = (Get-Date).AddSeconds($ServiceReadyTimeoutSec)
      while ((Get-Date) -lt $CaptureDeadline -and -not (Test-HttpReady "http://127.0.0.1:4317/health")) {
        if ($SickCaptureLauncher.HasExited) {
          $CaptureError = Get-Content (Join-Path $LogRoot "sick-capture.err.log") -Tail 30 -ErrorAction SilentlyContinue
          throw "SICK capture service exited before readiness. $($CaptureError -join [Environment]::NewLine)"
        }
        Start-Sleep -Milliseconds 250
      }
      if (-not (Test-HttpReady "http://127.0.0.1:4317/health")) {
        throw "SICK capture service did not become ready within $ServiceReadyTimeoutSec seconds."
      }
      $SickCaptureMode = if ($SickCaptureHistoryOnly) { "history-only; cameras remain disconnected" } else { "live" }
      Write-Host "SICK capture service ready at http://127.0.0.1:4317 (PID $($SickCaptureLauncher.Id), mode: $SickCaptureMode)."
    }
  }
  if (-not $NoProcessingServices) {
    & (Join-Path $PSScriptRoot "build-image-service.ps1") -Profile debug
    if ($SickCaptureProfile) {
      & (Join-Path $PSScriptRoot "build-pipeline-workers.ps1") -Profile debug
    } else {
      & (Join-Path $PSScriptRoot "build-algorithm-service.ps1") -Profile debug
    }
    New-Item -ItemType Directory -Force -Path $RunDir, $LogRoot, $DataRoot, $ResultRoot, $AlgorithmInputRoot, $InspectionWorldCacheRoot | Out-Null
    $env:STEEL_RESULT_ROOT = $ResultRoot
    $env:STEEL_ALGORITHM_INPUT_ROOTS = $AlgorithmInputRoot
    $env:STEEL_BKV_HISTORY_WORK_ROOT = $AlgorithmInputRoot
    $env:STEEL_INSPECTION_WORLD_CACHE_ROOT = $InspectionWorldCacheRoot
    $env:STEEL_INSPECTION_WORLD_HISTORY_LIMIT = "399"
    $env:STEEL_IMAGE_SERVICE_PORT = [string]$ImageServicePort
    $env:STEEL_RESULT_PROXY_ONLY = "1"
    $env:STEEL_IMAGE_PROXY = "1"
    $env:STEEL_CAPTURE_MANAGED_BY_SUPERVISOR = "1"
    $ImageExe = Join-Path $RepoRoot "target\image-service\debug\steel-image-service.exe"
    $ImageServiceLauncher = Start-Process -FilePath $ImageExe -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $LogRoot "image-service.out.log") `
      -RedirectStandardError (Join-Path $LogRoot "image-service.err.log")
    if ($SickCaptureProfile) {
      $env:STEEL_IMAGE_WORKER_PORT = [string]$ImageWorkerPort
      $env:STEEL_DEFECT_WORKER_PORT = [string]$DefectWorkerPort
      $env:STEEL_IMAGE_WORKER_ORIGIN = "http://127.0.0.1:$ImageWorkerPort"
      $env:STEEL_DEFECT_WORKER_ORIGIN = "http://127.0.0.1:$DefectWorkerPort"
      $ImageWorkerExe = Join-Path $RepoRoot "target\pipeline-workers\debug\steel-image-worker.exe"
      $DefectWorkerExe = Join-Path $RepoRoot "target\pipeline-workers\debug\steel-defect-worker.exe"
      $ImageWorkerLauncher = Start-Process -FilePath $ImageWorkerExe -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $LogRoot "image-worker.out.log") `
        -RedirectStandardError (Join-Path $LogRoot "image-worker.err.log")
      $DefectWorkerLauncher = Start-Process -FilePath $DefectWorkerExe -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $LogRoot "defect-worker.out.log") `
        -RedirectStandardError (Join-Path $LogRoot "defect-worker.err.log")
    } else {
      # BKV remains an independent offline import/display adapter. It never
      # starts real-camera processing or defect inference.
      $env:STEEL_HISTORY_RECONSTRUCTION = "1"
      $env:STEEL_BKV_IMAGE_WORKER_PORT = [string]$BkvWorkerPort
      $env:STEEL_BKV_IMAGE_WORKER_ORIGIN = "http://127.0.0.1:$BkvWorkerPort"
      if (-not $env:STEEL_BKV_HISTORY_RUNS_ROOT) {
        $HistoryRunsRoot = "D:\steel-inspection\algorithm-data\runs"
        if (Test-Path $HistoryRunsRoot -PathType Container) {
          $env:STEEL_BKV_HISTORY_RUNS_ROOT = $HistoryRunsRoot
        }
      }
      if (-not $env:STEEL_BKV_IMAGE_HOST) { $env:STEEL_BKV_IMAGE_HOST = "\\10.5.241.17" }
      if (-not $env:STEEL_BKV_REFRESH_INTERVAL_MS) { $env:STEEL_BKV_REFRESH_INTERVAL_MS = "10000" }
      if (-not $env:STEEL_BKV_MYSQL_HOST) {
        Write-Warning "BKV MySQL environment is not loaded; only the unified result catalog will be used."
      }
      $BkvWorkerExe = Join-Path $RepoRoot "target\algorithm-service\debug\steel-image-worker-bkv.exe"
      $BkvWorkerLauncher = Start-Process -FilePath $BkvWorkerExe -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $LogRoot "bkv-image-worker.out.log") `
        -RedirectStandardError (Join-Path $LogRoot "bkv-image-worker.err.log")
    }
    $ProcessingDeadline = (Get-Date).AddSeconds($ServiceReadyTimeoutSec)
    $RequiredWorkerPorts = if ($SickCaptureProfile) { @($ImageWorkerPort, $DefectWorkerPort) } else { @($BkvWorkerPort) }
    while ((Get-Date) -lt $ProcessingDeadline -and (-not (Test-HttpReady "http://127.0.0.1:$ImageServicePort/api/health/live") -or @($RequiredWorkerPorts | Where-Object { -not (Test-HttpReady "http://127.0.0.1:$_/api/health/live") }).Count -gt 0)) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-HttpReady "http://127.0.0.1:$ImageServicePort/api/health/live") -or @($RequiredWorkerPorts | Where-Object { -not (Test-HttpReady "http://127.0.0.1:$_/api/health/live") }).Count -gt 0) { throw "Artifact or processing worker did not become ready." }
  }
  if (-not $NoService) {
    if (Test-InspectionServiceReady) {
      Write-Host "Using inspection API already running at $ServiceOrigin."
    } else {
      $ExistingPid = Get-InspectionServicePid
      if ($ExistingPid) {
        throw "Port $ServicePort is occupied by process $ExistingPid, but the inspection API health check failed."
      }
      if (-not $SkipServiceBuild) {
        & (Join-Path $PSScriptRoot "build-service.ps1") -Profile debug
      }

      $env:STEEL_RESULT_PROXY_ONLY = "1"
      $env:STEEL_IMAGE_PROXY = "1"
      $env:STEEL_CAPTURE_MANAGED_BY_SUPERVISOR = "1"

      New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
      New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
      $Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
      $StdoutPath = Join-Path $LogRoot "inspection-service-$Stamp.out.log"
      $StderrPath = Join-Path $LogRoot "inspection-service-$Stamp.err.log"
      $ServiceArguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", (Join-Path $PSScriptRoot "run-service.ps1"),
        "-Port", [string]$ServicePort,
        "-NoCaptureAutostart",
        "-RuntimeStateRoot", $RunDir,
        "-RuntimeLogDir", $LogRoot
      )
      if (-not $NoProcessingServices) {
        $ServiceArguments += @(
          "-ResultRoot", $ResultRoot,
          "-AlgorithmInputRoot", $AlgorithmInputRoot,
          "-InspectionWorldCacheRoot", $InspectionWorldCacheRoot,
          "-ResultProxyOnly"
        )
      }
      if ($EnvFile -and $EnvFile.Trim().Length -gt 0) {
        $ServiceArguments += @("-EnvFile", [string](Resolve-Path $EnvFile))
      }

      # Keep one canonical process PATH entry so Start-Process does not reject
      # environments containing both Path and PATH.
      $ProcessPath = [Environment]::GetEnvironmentVariable("Path", "Process")
      [Environment]::SetEnvironmentVariable("PATH", $null, "Process")
      [Environment]::SetEnvironmentVariable("Path", $ProcessPath, "Process")
      $ServiceLauncher = Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList $ServiceArguments `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $StdoutPath `
        -RedirectStandardError $StderrPath `
        -PassThru

      $Deadline = (Get-Date).AddSeconds($ServiceReadyTimeoutSec)
      while ((Get-Date) -lt $Deadline) {
        if ($ServiceLauncher.HasExited) {
          $ErrorTail = if (Test-Path $StderrPath) { (Get-Content $StderrPath -Tail 20) -join [Environment]::NewLine } else { "" }
          throw "Inspection API launcher exited before readiness. $ErrorTail"
        }
        if (Test-InspectionServiceReady) {
          $OwnedServicePid = Get-InspectionServicePid
          break
        }
        Start-Sleep -Milliseconds 250
      }
      if (-not $OwnedServicePid) {
        throw "Inspection API did not become ready at $ServiceOrigin within $ServiceReadyTimeoutSec seconds."
      }
      Write-Host "Inspection API ready at $ServiceOrigin (PID $OwnedServicePid)."
      Write-Host "Service logs: $StdoutPath"
    }
  }

  if (-not $NoProcessingServices -and -not $SickCaptureProfile) {
    try {
      Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$BkvWorkerPort/internal/v1/reprocess" -Body "{}" -ContentType "application/json" -TimeoutSec 5 | Out-Null
      Write-Host "BKV adapter input scan requested."
    } catch {
      Write-Warning "BKV adapter input scan request failed: $($_.Exception.Message)"
    }
  }

  Push-Location $ClientDir
  try {
    # Invoke the package's `tauri` script and pass Tauri 2's `dev` command
    # through npm.  The second separator keeps Cargo's --locked flag in the
    # runner argument list instead of sending it to the application.
    $TauriArguments = @("run", "tauri", "--", "dev", "--", "--locked")
    $RepoCargoConfig = Join-Path $RepoRoot ".cargo\config.toml"
    $RepoAlreadyDefinesMirror = (Test-Path $RepoCargoConfig -PathType Leaf) -and (
      Select-String -Path $RepoCargoConfig -Pattern '^\s*replace-with\s*=' -Quiet
    )
    if (-not $RepoAlreadyDefinesMirror -and $CargoRegistryMirror -and $CargoRegistryMirror.Trim().Length -gt 0) {
      $NormalizedMirror = $CargoRegistryMirror.Trim().TrimEnd("/") + "/"
      $TauriArguments += @(
        "--config", "source.crates-io.replace-with='rsproxy'",
        "--config", "source.rsproxy.registry='sparse+$NormalizedMirror'"
      )
    }
    if (-not $AllowNetworkDependencyFetch) {
      $TauriArguments += "--offline"
    }
    & $NpmPath @TauriArguments
    if ($LASTEXITCODE -ne 0) {
      throw "Tauri development runtime failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
} finally {
  if ($OwnedServicePid) {
    Stop-Process -Id $OwnedServicePid -Force -ErrorAction SilentlyContinue
  }
  if ($ServiceLauncher -and -not $ServiceLauncher.HasExited) {
    Stop-ProcessTree -RootProcessId $ServiceLauncher.Id
  }
  if ($ImageServiceLauncher -and -not $ImageServiceLauncher.HasExited) { Stop-ProcessTree -RootProcessId $ImageServiceLauncher.Id }
  if ($ImageWorkerLauncher -and -not $ImageWorkerLauncher.HasExited) { Stop-ProcessTree -RootProcessId $ImageWorkerLauncher.Id }
  if ($DefectWorkerLauncher -and -not $DefectWorkerLauncher.HasExited) { Stop-ProcessTree -RootProcessId $DefectWorkerLauncher.Id }
  if ($BkvWorkerLauncher -and -not $BkvWorkerLauncher.HasExited) { Stop-ProcessTree -RootProcessId $BkvWorkerLauncher.Id }
  if ($SickCaptureLauncher -and -not $SickCaptureLauncher.HasExited) { Stop-ProcessTree -RootProcessId $SickCaptureLauncher.Id }
}
