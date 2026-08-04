param(
  [int]$ServicePort = 4873,
  [string]$EnvFile = "",
  [ValidateRange(5, 120)]
  [int]$ServiceReadyTimeoutSec = 30,
  [switch]$SkipServiceBuild,
  [switch]$NoService,
  [switch]$NoProcessingServices,
  [switch]$AllowNetworkDependencyFetch,
  [string]$CargoRegistryMirror = "https://rsproxy.cn/index/"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ClientDir = Join-Path $RepoRoot "app\client"
$RunDir = Join-Path $RepoRoot "target\run\tauri-dev"
. (Join-Path $PSScriptRoot "lib-env.ps1")

Import-EnvFile $EnvFile
if (-not $env:VITE_INSPECTION_SERVICE_ORIGIN) {
  $env:VITE_INSPECTION_SERVICE_ORIGIN = "http://127.0.0.1:$ServicePort"
}

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
$AlgorithmServicePort = 4875
$ProcessingRoot = Join-Path $RunDir "processing"
$ResultRoot = Join-Path $ProcessingRoot "result-data"
$AlgorithmInputRoot = Join-Path $ProcessingRoot "algorithm-input"
$ImageServiceLauncher = $null
$AlgorithmServiceLauncher = $null
$ServiceLauncher = $null
$OwnedServicePid = $null

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

try {
  if (-not $NoProcessingServices) {
    & (Join-Path $PSScriptRoot "build-image-service.ps1") -Profile debug
    & (Join-Path $PSScriptRoot "build-algorithm-service.ps1") -Profile debug
    New-Item -ItemType Directory -Force -Path $ResultRoot, $AlgorithmInputRoot | Out-Null
    $env:STEEL_RESULT_ROOT = $ResultRoot
    $env:STEEL_ALGORITHM_INPUT_ROOTS = $AlgorithmInputRoot
    $env:STEEL_IMAGE_SERVICE_PORT = [string]$ImageServicePort
    $env:STEEL_ALGORITHM_SERVICE_PORT = [string]$AlgorithmServicePort
    $env:STEEL_RESULT_PROXY_ONLY = "1"
    $ImageExe = Join-Path $RepoRoot "target\image-service\debug\steel-image-service.exe"
    $AlgorithmExe = Join-Path $RepoRoot "target\algorithm-service\debug\steel-algorithm-service.exe"
    $ImageServiceLauncher = Start-Process -FilePath $ImageExe -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru
    $AlgorithmServiceLauncher = Start-Process -FilePath $AlgorithmExe -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru
    $ProcessingDeadline = (Get-Date).AddSeconds($ServiceReadyTimeoutSec)
    while ((Get-Date) -lt $ProcessingDeadline -and (-not (Test-HttpReady "http://127.0.0.1:$ImageServicePort/api/health/live") -or -not (Test-HttpReady "http://127.0.0.1:$AlgorithmServicePort/api/health/live"))) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-HttpReady "http://127.0.0.1:$ImageServicePort/api/health/live") -or -not (Test-HttpReady "http://127.0.0.1:$AlgorithmServicePort/api/health/live")) { throw "Image or algorithm service did not become ready." }
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

      New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
      $Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
      $StdoutPath = Join-Path $RunDir "service-$Stamp.out.log"
      $StderrPath = Join-Path $RunDir "service-$Stamp.err.log"
      $ServiceArguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", (Join-Path $PSScriptRoot "run-service.ps1"),
        "-Port", [string]$ServicePort,
        "-NoCaptureAutostart"
      )
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

  Push-Location $ClientDir
  try {
    $TauriArguments = @("run", "tauri", "--", "dev", "--", "--locked")
    if ($CargoRegistryMirror -and $CargoRegistryMirror.Trim().Length -gt 0) {
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
    Stop-Process -Id $ServiceLauncher.Id -Force -ErrorAction SilentlyContinue
  }
  if ($ImageServiceLauncher -and -not $ImageServiceLauncher.HasExited) { Stop-Process -Id $ImageServiceLauncher.Id -Force -ErrorAction SilentlyContinue }
  if ($AlgorithmServiceLauncher -and -not $AlgorithmServiceLauncher.HasExited) { Stop-Process -Id $AlgorithmServiceLauncher.Id -Force -ErrorAction SilentlyContinue }
}
