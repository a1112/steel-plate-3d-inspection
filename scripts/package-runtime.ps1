param(
  [string]$Configuration = "Release",
  [ValidateSet("debug", "release")]
  [string]$ServiceProfile = "debug",
  [switch]$SkipBuild,
  [switch]$IncludeQt,
  [string]$QtPrefixPath = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$PackageRoot = Join-Path $RepoRoot "target\packages"
$OutRoot = Join-Path $PackageRoot "steel-inspection-runtime"
$CaptureOut = Join-Path $OutRoot "capture-headless"
$CaptureQtOut = Join-Path $OutRoot "capture-qt"
$ServiceOut = Join-Path $OutRoot "service"
$ClientOut = Join-Path $OutRoot "client"
$ConfigOut = Join-Path $OutRoot "config"
$DocsOut = Join-Path $OutRoot "docs"
$ScriptsOut = Join-Path $OutRoot "scripts"
$AlgorithmCoreOut = Join-Path $OutRoot "algorithm-core"

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

function Copy-RequiredFile {
  param(
    [string]$Source,
    [string]$Destination
  )
  if (-not (Test-Path $Source -PathType Leaf)) {
    throw "Missing required file: $Source"
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Write-PackageFile {
  param(
    [string]$RelativePath,
    [string]$Content
  )
  $Destination = Join-Path $OutRoot $RelativePath
  $DestinationDir = Split-Path -Parent $Destination
  if ($DestinationDir -and -not (Test-Path $DestinationDir -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $DestinationDir | Out-Null
  }
  Set-Content -Path $Destination -Value $Content -Encoding UTF8
}

function Resolve-QtDeployTool {
  param([string]$Path)

  $SearchRoot = if ($Path.Trim().Length -gt 0) {
    (Resolve-Path $Path -ErrorAction Stop).Path
  } else {
    "C:\Qt"
  }

  if (Test-Path (Join-Path $SearchRoot "bin\windeployqt.exe") -PathType Leaf) {
    return (Join-Path $SearchRoot "bin\windeployqt.exe")
  }

  $DeployTool = Get-ChildItem -Path $SearchRoot -Recurse -Filter "windeployqt.exe" -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "msvc.*_64" } |
    Sort-Object FullName |
    Select-Object -First 1

  if (-not $DeployTool) {
    throw "No MSVC x64 windeployqt.exe found under $SearchRoot. Install a Qt msvc*_64 kit or pass -QtPrefixPath."
  }

  return $DeployTool.FullName
}

if (-not $SkipBuild) {
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-capture-headless.ps1"), "-Configuration", $Configuration)
  if ($IncludeQt) {
    $QtBuildArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-capture-qt.ps1"), "-Configuration", $Configuration)
    if ($QtPrefixPath.Trim().Length -gt 0) {
      $QtBuildArgs += @("-QtPrefixPath", $QtPrefixPath)
    }
    Invoke-Checked "powershell" $QtBuildArgs
  }
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-service.ps1"), "-Profile", $ServiceProfile)
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-trigger-gateway.ps1"), "-Profile", $ServiceProfile)
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-client.ps1"))
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-algorithm-core.ps1"), "-Configuration", $Configuration)
}

if ((Resolve-Path $PackageRoot -ErrorAction SilentlyContinue) -and (Test-Path $OutRoot)) {
  $ResolvedOut = Resolve-Path $OutRoot
  if (-not $ResolvedOut.Path.StartsWith((Resolve-Path $PackageRoot).Path)) {
    throw "Refusing to remove package directory outside target/packages: $ResolvedOut"
  }
  Remove-Item -LiteralPath $ResolvedOut -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $CaptureOut, $ServiceOut, $ClientOut, $ConfigOut, $DocsOut, $ScriptsOut, $AlgorithmCoreOut | Out-Null
if ($IncludeQt) {
  New-Item -ItemType Directory -Force -Path $CaptureQtOut | Out-Null
}

$CaptureBuild = Join-Path $RepoRoot "target\capture\$Configuration"
Copy-RequiredFile (Join-Path $CaptureBuild "steel_capture_service.exe") $CaptureOut
Copy-RequiredFile (Join-Path $CaptureBuild "nvt_lvm_sdk.dll") $CaptureOut

if ($IncludeQt) {
  $CaptureQtBuild = Join-Path $RepoRoot "target\capture-qt\$Configuration"
  Copy-RequiredFile (Join-Path $CaptureQtBuild "steel_capture_qt_terminal.exe") $CaptureQtOut
  Copy-RequiredFile (Join-Path $CaptureQtBuild "nvt_lvm_sdk.dll") $CaptureQtOut
  $DeployTool = Resolve-QtDeployTool $QtPrefixPath
  Invoke-Checked $DeployTool @("--release", "--no-translations", (Join-Path $CaptureQtOut "steel_capture_qt_terminal.exe"))
}

$ServiceBuild = if ($ServiceProfile -eq "release") {
  Join-Path $RepoRoot "target\cargo\release"
} else {
  Join-Path $RepoRoot "target\cargo\debug"
}
Copy-RequiredFile (Join-Path $ServiceBuild "steel-inspection-service.exe") $ServiceOut
$TriggerBuild = if ($ServiceProfile -eq "release") {
  Join-Path $RepoRoot "target\trigger\release"
} else {
  Join-Path $RepoRoot "target\trigger\debug"
}
Copy-RequiredFile (Join-Path $TriggerBuild "steel-trigger-gateway.exe") $ServiceOut

$AlgorithmCoreBuild = Join-Path $RepoRoot "target\algorithm-core\$Configuration"
Copy-RequiredFile (Join-Path $AlgorithmCoreBuild "steel_bar_surface_core.exe") $AlgorithmCoreOut

$ClientBuild = Join-Path $RepoRoot "target\client\frontend-dist"
if (-not (Test-Path $ClientBuild -PathType Container)) {
  throw "Missing client build directory: $ClientBuild"
}
Get-ChildItem -LiteralPath $ClientBuild -Force | Copy-Item -Destination $ClientOut -Recurse -Force

Copy-Item -LiteralPath (Join-Path $RepoRoot "config\env") -Destination $ConfigOut -Recurse -Force
if (Test-Path (Join-Path $RepoRoot "config\capture") -PathType Container) {
  Copy-Item -LiteralPath (Join-Path $RepoRoot "config\capture") -Destination $ConfigOut -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $RepoRoot "README.md") -Destination $DocsOut -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "docs\independent-architecture.md") -Destination $DocsOut -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "docs\capture-api-contract.md") -Destination $DocsOut -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "docs\integrated-capture-management-acceptance.md") -Destination $DocsOut -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "scripts\README.md") -Destination $DocsOut -Force
Copy-RequiredFile (Join-Path $RepoRoot "scripts\run-client-static.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-capture-api.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-capture-continuous.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-integrated-management-smoke.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-integrated-runtime-ready.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-integrated-capture-management-full.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-integrated-acceptance-audit.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-runtime-acceptance.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-runtime-layout.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-runtime-ui-smoke.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-real-hardware-acceptance.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-production-stability.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\bar_surface_reconstruct.py") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "scripts\fit_array_calibration_cross_section.py") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-bar-surface-e2e.ps1") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "scripts\build-algorithm-core.ps1") $ScriptsOut

Write-PackageFile "run-capture-headless.ps1" @'
param(
  [int]$Port = 4317,
  [string]$StorageRoot = "H:\",
  [string]$CameraStorageRoot = "H:\"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "capture-headless\steel_capture_service.exe"

if (-not (Test-Path $Exe -PathType Leaf)) {
  throw "Missing capture executable: $Exe"
}

$env:CAPTURE_STORAGE_ROOT = $StorageRoot
$env:CAPTURE_CONFIG_ROOT = Join-Path $Root "config\capture"
$env:CAPTURE_CAMERA_STORAGE_ROOT = $CameraStorageRoot
New-Item -ItemType Directory -Force -Path $env:CAPTURE_CONFIG_ROOT | Out-Null

Push-Location (Split-Path -Parent $Exe)
try {
  & $Exe --port $Port
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
'@

if ($IncludeQt) {
  Write-PackageFile "run-capture-qt.ps1" @'
param(
  [int]$Port = 4317,
  [string]$StorageRoot = "H:\",
  [string]$CameraStorageRoot = "H:\"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "capture-qt\steel_capture_qt_terminal.exe"

if (-not (Test-Path $Exe -PathType Leaf)) {
  throw "Missing Qt capture executable: $Exe"
}

$env:PATH = "$(Split-Path -Parent $Exe);$env:PATH"
$env:CAPTURE_SERVICE_PORT = [string]$Port
$env:CAPTURE_STORAGE_ROOT = $StorageRoot
$env:CAPTURE_CONFIG_ROOT = Join-Path $Root "config\capture"
$env:CAPTURE_CAMERA_STORAGE_ROOT = $CameraStorageRoot
New-Item -ItemType Directory -Force -Path $env:CAPTURE_CONFIG_ROOT | Out-Null
& $Exe
exit $LASTEXITCODE
'@
}

Write-PackageFile "run-service-external.ps1" @'
param(
  [int]$Port = 4873,
  [string]$CaptureOrigin = "http://127.0.0.1:4317",
  [string]$ConfigRoot = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "service\steel-inspection-service.exe"

if (-not (Test-Path $Exe -PathType Leaf)) {
  throw "Missing service executable: $Exe"
}

$env:INSPECTION_SERVICE_HOST = "127.0.0.1"
$env:INSPECTION_SERVICE_PORT = [string]$Port
$env:STEEL_CAPTURE_PROVIDER = "external-api"
$env:CAPTURE_SERVICE_ORIGIN = $CaptureOrigin
$env:STEEL_CAPTURE_SERVICE_AUTOSTART = "0"
$env:STEEL_WORKSPACE_ROOT = $Root
$env:STEEL_BAR_SURFACE_CORE_EXE = Join-Path $Root "algorithm-core\steel_bar_surface_core.exe"
if ([string]::IsNullOrWhiteSpace($ConfigRoot)) {
  $ConfigRoot = Join-Path $Root "config\service"
}
$env:STEEL_SERVICE_CONFIG_DIR = $ConfigRoot
New-Item -ItemType Directory -Force -Path $env:STEEL_SERVICE_CONFIG_DIR | Out-Null

& $Exe
exit $LASTEXITCODE
'@

Write-PackageFile "run-service-simulated.ps1" @'
param(
  [int]$Port = 4873,
  [string]$ConfigRoot = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "service\steel-inspection-service.exe"

if (-not (Test-Path $Exe -PathType Leaf)) {
  throw "Missing service executable: $Exe"
}

$env:INSPECTION_SERVICE_HOST = "127.0.0.1"
$env:INSPECTION_SERVICE_PORT = [string]$Port
$env:STEEL_CAPTURE_PROVIDER = "simulated"
$env:STEEL_CAPTURE_SERVICE_AUTOSTART = "0"
$env:STEEL_WORKSPACE_ROOT = $Root
$env:STEEL_BAR_SURFACE_CORE_EXE = Join-Path $Root "algorithm-core\steel_bar_surface_core.exe"
if ([string]::IsNullOrWhiteSpace($ConfigRoot)) {
  $ConfigRoot = Join-Path $Root "config\service"
}
$env:STEEL_SERVICE_CONFIG_DIR = $ConfigRoot
New-Item -ItemType Directory -Force -Path $env:STEEL_SERVICE_CONFIG_DIR | Out-Null
Remove-Item Env:\CAPTURE_SERVICE_ORIGIN -ErrorAction SilentlyContinue

& $Exe
exit $LASTEXITCODE
'@

Write-PackageFile "run-trigger-gateway.ps1" @'
param(
  [int]$Port = 4881,
  [string]$HostAddress = "127.0.0.1",
  [string]$InspectionServiceOrigin = "http://127.0.0.1:4873",
  [ValidateSet("api", "gray", "secondary", "manual")]
  [string]$Mode = "api"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "service\steel-trigger-gateway.exe"

if (-not (Test-Path $Exe -PathType Leaf)) {
  throw "Missing trigger gateway executable: $Exe"
}

$env:TRIGGER_GATEWAY_PORT = [string]$Port
$env:TRIGGER_GATEWAY_HOST = $HostAddress
$env:INSPECTION_SERVICE_ORIGIN = $InspectionServiceOrigin
$env:TRIGGER_MODE = $Mode

& $Exe
exit $LASTEXITCODE
'@

Write-PackageFile "run-integrated-capture-management.ps1" @'
param(
  [int]$CapturePort = 4317,
  [int]$ServicePort = 4873,
  [int]$TriggerPort = 4881,
  [int]$ClientPort = 1432,
  [string]$StorageRoot = "H:\",
  [string]$CameraStorageRoot = "H:\",
  [ValidateSet("api", "gray", "secondary", "manual")]
  [string]$TriggerMode = "manual",
  [switch]$NoQt,
  [switch]$StopExisting,
  [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir = Join-Path $Root "logs\integrated"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Test-LocalTcpPort {
  param([int]$Port)
  try {
    $Client = [System.Net.Sockets.TcpClient]::new()
    try {
      $Async = $Client.BeginConnect("127.0.0.1", $Port, $null, $null)
      if (-not $Async.AsyncWaitHandle.WaitOne(500)) { return $false }
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
  param([string]$Name, [string]$Uri, [int]$TimeoutSec = 30)
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
  param([string]$Name, [string]$Uri, [int]$TimeoutSec = 30)
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

function Normalize-PathText {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return "" }
  try {
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/').ToLowerInvariant()
  } catch {
    return $Path.TrimEnd('\', '/').ToLowerInvariant()
  }
}

function Assert-CaptureProviderMatches {
  param([object]$Health, [string]$ExpectedStorageRoot, [string]$ExpectedConfigRoot)
  if ((Normalize-PathText ([string]$Health.storageRoot)) -ne (Normalize-PathText $ExpectedStorageRoot)) {
    throw "Capture provider on port $CapturePort uses storageRoot '$($Health.storageRoot)', expected '$ExpectedStorageRoot'. Stop it first or rerun with -StopExisting to avoid writing frames to the wrong root."
  }
  if ((Normalize-PathText ([string]$Health.configRoot)) -ne (Normalize-PathText $ExpectedConfigRoot)) {
    throw "Capture provider on port $CapturePort uses configRoot '$($Health.configRoot)', expected '$ExpectedConfigRoot'. Stop it first or rerun with -StopExisting to avoid loading the wrong profile."
  }
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

function Start-PackageScript {
  param([string]$Name, [string]$ScriptPath, [string[]]$Arguments)
  $OutLog = Join-Path $LogDir "$Name.out.log"
  $ErrLog = Join-Path $LogDir "$Name.err.log"
  $ArgList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath) + $Arguments
  Normalize-ProcessPathEnvironment
  $Process = Start-Process -FilePath "powershell.exe" -ArgumentList $ArgList -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru
  Write-Host "$Name started: PID $($Process.Id), logs $OutLog"
}

if ($StopExisting) {
  $StopScript = Join-Path $Root "stop-runtime.ps1"
  if (Test-Path $StopScript -PathType Leaf) {
    & $StopScript -Ports @($CapturePort, $ServicePort, $TriggerPort, $ClientPort)
  }
}

$CaptureScript = if (-not $NoQt -and (Test-Path (Join-Path $Root "run-capture-qt.ps1") -PathType Leaf)) {
  Join-Path $Root "run-capture-qt.ps1"
} else {
  Join-Path $Root "run-capture-headless.ps1"
}
$ServiceScript = Join-Path $Root "run-service-external.ps1"
$TriggerScript = Join-Path $Root "run-trigger-gateway.ps1"
$ClientScript = Join-Path $Root "run-client-static.ps1"

if (-not (Test-LocalTcpPort -Port $CapturePort)) {
  Start-PackageScript -Name "capture" -ScriptPath $CaptureScript -Arguments @("-Port", [string]$CapturePort, "-StorageRoot", $StorageRoot, "-CameraStorageRoot", $CameraStorageRoot)
} else {
  Write-Host "Capture provider already listening on port $CapturePort."
}
$CaptureHealth = Wait-HttpJson -Name "Capture provider" -Uri "http://127.0.0.1:$CapturePort/health" -TimeoutSec 30
$ExpectedCaptureConfigRoot = Join-Path $Root "config\capture"
Assert-CaptureProviderMatches -Health $CaptureHealth -ExpectedStorageRoot $StorageRoot -ExpectedConfigRoot $ExpectedCaptureConfigRoot
Write-Host ("Capture ready: sdkReady={0}, cameraCount={1}" -f $CaptureHealth.sdkReady, $CaptureHealth.cameraCount)

if (-not (Test-LocalTcpPort -Port $ServicePort)) {
  Start-PackageScript -Name "service" -ScriptPath $ServiceScript -Arguments @("-Port", [string]$ServicePort, "-CaptureOrigin", "http://127.0.0.1:$CapturePort")
} else {
  Write-Host "Rust service already listening on port $ServicePort."
}
$ProductionStatus = Wait-HttpJson -Name "Rust service" -Uri "http://127.0.0.1:$ServicePort/api/production/status" -TimeoutSec 30
Write-Host ("Service ready: production code={0}" -f $ProductionStatus.code)

if (-not (Test-LocalTcpPort -Port $TriggerPort)) {
  Start-PackageScript -Name "trigger-gateway" -ScriptPath $TriggerScript -Arguments @("-Port", [string]$TriggerPort, "-InspectionServiceOrigin", "http://127.0.0.1:$ServicePort", "-Mode", $TriggerMode)
} else {
  Write-Host "Trigger gateway already listening on port $TriggerPort."
}
$TriggerStatus = Wait-HttpJson -Name "Trigger gateway" -Uri "http://127.0.0.1:$TriggerPort/api/trigger/status" -TimeoutSec 30
Write-Host ("Trigger gateway ready: mode={0}, manualAllowed={1}" -f $TriggerStatus.mode, $TriggerStatus.manualAllowed)

if ((Test-Path $ClientScript -PathType Leaf) -and -not (Test-LocalTcpPort -Port $ClientPort)) {
  Start-PackageScript -Name "client-static" -ScriptPath $ClientScript -Arguments @("-Port", [string]$ClientPort)
}

$ClientUrl = "http://127.0.0.1:$ClientPort/?app=terminal"
Wait-HttpHtml -Name "Static client" -Uri $ClientUrl -TimeoutSec 30 | Out-Null
Write-Host "Client ready: $ClientUrl"

if ($OpenBrowser) {
  Start-Process $ClientUrl | Out-Null
}

Write-Host ""
Write-Host "Integrated capture management is ready:"
Write-Host "  Capture API     http://127.0.0.1:$CapturePort"
Write-Host "  Rust service    http://127.0.0.1:$ServicePort"
Write-Host "  Trigger gateway http://127.0.0.1:$TriggerPort/manual"
Write-Host "  Client          $ClientUrl"
Write-Host "  Logs            $LogDir"
'@

Write-PackageFile "stop-runtime.ps1" @'
param(
  [int[]]$Ports = @(4317, 4873, 4881, 1432)
)

$ErrorActionPreference = "Stop"

function Get-ListenerProcessIds {
  param([int]$Port)

  $Ids = @()
  try {
    $Ids = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
  } catch {
    $Ids = @()
  }

  if (-not $Ids -or $Ids.Count -eq 0) {
    $Lines = netstat -ano | Select-String ":$Port\s"
    foreach ($Line in $Lines) {
      if ([string]$Line -match "LISTENING\s+(\d+)") {
        $Ids += [int]$Matches[1]
      }
    }
  }

  return @($Ids | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
}

$ProcessNames = @(
  "steel-inspection-service",
  "steel-trigger-gateway",
  "steel_trigger_gateway",
  "steel_capture_service",
  "steel_capture_qt_terminal"
)

$Processes = @()
foreach ($Name in $ProcessNames) {
  $Processes += Get-Process -Name $Name -ErrorAction SilentlyContinue
}
foreach ($Port in $Ports) {
  foreach ($ProcessId in (Get-ListenerProcessIds -Port $Port)) {
    $Process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($Process) {
      $Processes += $Process
    }
  }
}

$Processes = @($Processes | Where-Object { $_ -and $_.Id -gt 4 -and $_.Id -ne $PID } | Sort-Object Id -Unique)
if (-not $Processes -or $Processes.Count -eq 0) {
  Write-Host "No steel inspection runtime processes found."
  return
}

$Processes | Select-Object Id, ProcessName, Path | Format-Table -AutoSize
$Processes | Stop-Process -Force
Write-Host "Stopped $($Processes.Count) runtime process(es)."
'@

Write-PackageFile "README.md" @'
# Steel Inspection Runtime Package

This package keeps runtime boundaries independent:

- `capture-headless/`: C++ capture provider and camera SDK runtime DLL.
- `service/`: Rust service API executable.
- `service/steel-trigger-gateway.exe`: standalone L2/PLC/API trigger gateway.
- `client/`: built frontend files.
- `config/env/`: environment templates.
- `docs/`: architecture and API documentation copied from the source tree.

## Start Headless Capture + Rust Service

Terminal 1:

```powershell
.\run-capture-headless.ps1 -Port 4317
```

Terminal 2:

```powershell
.\run-service-external.ps1 -Port 4873 -CaptureOrigin http://127.0.0.1:4317
```

The service then exposes capture proxy APIs such as:

```text
http://127.0.0.1:4873/api/capture/health
http://127.0.0.1:4873/api/cameras
```

## One-Command Integrated Startup

```powershell
.\run-integrated-capture-management.ps1 -TriggerMode manual -OpenBrowser
```

This starts the capture provider, Rust service, trigger gateway, and static client, then waits for:

```text
http://127.0.0.1:4317/health
http://127.0.0.1:4873/api/production/status
http://127.0.0.1:4881/api/trigger/status
http://127.0.0.1:1432/?app=terminal
```

Use `-NoQt` to force the headless capture provider even when the package includes Qt.
Use `-StopExisting` to first stop known project executables and listeners on the selected ports.

## Start Qt Capture + Rust Service

If this package was created with `-IncludeQt`, Terminal 1 can run:

```powershell
.\run-capture-qt.ps1
```

Terminal 2:

```powershell
.\run-service-external.ps1 -Port 4873 -CaptureOrigin http://127.0.0.1:4317
```

## Run Without Cameras

```powershell
.\run-service-simulated.ps1 -Port 4873
```

## Integrated Smoke Test

```powershell
.\test-integrated-management-smoke.ps1
```

This starts the simulated Rust service, standalone trigger gateway, and static client on temporary ports. It verifies the manual-mode guard, steel-info, steel-in, record-before-capture flow, steel-out, and the built terminal page. It does not require cameras.

## Runtime Layout Check

```powershell
.\test-runtime-layout.ps1
```

This checks the package manifest, required executables, SDK DLLs, built client, run scripts, stop script, and integrated smoke-test coverage without starting long-running services.

## Folder Acceptance Check

```powershell
.\test-runtime-acceptance.ps1
```

This is the one-command folder acceptance check. It runs the static layout check and then the simulated integrated smoke test on temporary ports `4973`, `4981`, and `1494`.

## Real Hardware Acceptance

Read-only live stack and six-camera storage checks:

```powershell
.\test-real-hardware-acceptance.ps1
```

Run one real production capture round through the Rust service after the real capture provider is connected:

```powershell
.\test-real-hardware-acceptance.ps1 -RunCapture
```

Run repeated production in/out steel cycles for stability. Use `-MaxCycles` for a short acceptance check, or `-DurationSec 600` for a ten-minute soak. `-RunAlgorithmEvery` optionally runs 3D reconstruction every N cycles.

```powershell
.\test-production-stability.ps1 -MaxCycles 2
.\test-production-stability.ps1 -DurationSec 600 -RunAlgorithmEvery 10
```

## Live Runtime Ready Check

After starting the real stack, run:

```powershell
.\test-integrated-runtime-ready.ps1
```

This checks the running capture provider, Rust service production API, network monitor API, trigger gateway, and terminal client page without starting or stopping processes. Pass custom origins when the stack uses non-default ports.

## Full Integrated Capture Management Check

After starting the real stack and client, run:

```powershell
.\test-integrated-capture-management-full.ps1
```

This writes one combined report for runtime layout, live readiness, six-camera hardware/storage checks, and UI smoke. Add `-RunCapture`, `-RunBarSurface`, or `-RunShortStability` when you want the full script to include a real production capture, 3D reconstruction, or a production stability loop. Add `-RequireFullCoverage` when skipped live-stack, hardware, UI, trigger-route, storage, or 3D reconstruction coverage must fail the report. By default `-RunShortStability` uses `-StabilityCycles 1`; use `-StabilityDurationSec 600 -StabilityIntervalSec 2` for a ten-minute soak in the same integrated report. Add `-StabilityUseTriggerGateway` to prove the production cycle enters through the trigger gateway before the Rust service calls capture.

```powershell
.\test-integrated-capture-management-full.ps1 -RunShortStability -StabilityUseTriggerGateway -RunBarSurface -RequireFullCoverage -StabilityDurationSec 600 -StabilityIntervalSec 2
```

For a shorter full-coverage acceptance run, keep the same switches and use `-StabilityDurationSec 45 -StabilityIntervalSec 0`. The JSON report includes `coverage.full`, `coverage.covered`, `coverage.required`, and per-item skipped/uncovered reasons.

## Live UI Smoke Test

After starting the real stack and client, run:

```powershell
.\test-runtime-ui-smoke.ps1 -ClientOrigin http://127.0.0.1:1432/?app=terminal
```

This opens a headless Edge/Chrome page, captures screenshots, and verifies the terminal, capture, and 3D reconstruction pages. It also opens the receiver network popover and checks the monitoring-only realtime upload, realtime download, and bandwidth fields.

## Trigger Gateway

```powershell
.\run-trigger-gateway.ps1 -Port 4881 -InspectionServiceOrigin http://127.0.0.1:4873 -Mode api
```

Use `-Mode gray` when a grayscale/sensor-side signal owns the in/out steel decision and the gateway should record that source mode.

## Client Files

The `client/` folder contains the built web assets. Serve it with the package-local static server:

```powershell
.\run-client-static.ps1 -Port 1432
```

Then open:

```text
http://127.0.0.1:1432/
```

The client calls the Rust service on `http://127.0.0.1:4873` by default.

## Stop Processes

```powershell
.\stop-runtime.ps1
```

This stops the known C++/Rust executables and listeners on ports `4317`, `4873`, `4881`, and `1432`, including the PowerShell static client server. Use `-Ports` if the stack was started on custom ports.

## Auto-Connect And Continuous Capture Test

With either capture provider running:

```powershell
.\test-capture-api.ps1 -Origin http://127.0.0.1:4317 -ExpectedCameras 6
```

```powershell
.\test-capture-continuous.ps1 -Origin http://127.0.0.1:4317 -ExpectedCameras 6 -Rounds 3 -IntervalMs 500
```
'@

$Manifest = [ordered]@{
  name = "steel-inspection-runtime"
  createdAt = (Get-Date).ToString("o")
  capture = @{
    path = "capture-headless/steel_capture_service.exe"
    sdk = "capture-headless/nvt_lvm_sdk.dll"
  }
  service = @{
    path = "service/steel-inspection-service.exe"
    triggerGateway = "service/steel-trigger-gateway.exe"
    profile = $ServiceProfile
  }
  client = @{
    path = "client/index.html"
  }
  algorithm = @{
    core = "algorithm-core/steel_bar_surface_core.exe"
    scripts = "scripts"
  }
  config = @{
    envTemplates = "config/env"
  }
  scripts = @{
    captureHeadless = "run-capture-headless.ps1"
    serviceExternal = "run-service-external.ps1"
    serviceSimulated = "run-service-simulated.ps1"
    triggerGateway = "run-trigger-gateway.ps1"
    integrated = "run-integrated-capture-management.ps1"
    clientStatic = "run-client-static.ps1"
    captureApiTest = "test-capture-api.ps1"
    continuousCaptureTest = "test-capture-continuous.ps1"
    integratedFullAcceptanceTest = "test-integrated-capture-management-full.ps1"
    integratedAcceptanceAuditTest = "test-integrated-acceptance-audit.ps1"
    integratedSmokeTest = "test-integrated-management-smoke.ps1"
    integratedReadyTest = "test-integrated-runtime-ready.ps1"
    runtimeAcceptanceTest = "test-runtime-acceptance.ps1"
    runtimeLayoutTest = "test-runtime-layout.ps1"
    runtimeUiSmokeTest = "test-runtime-ui-smoke.ps1"
    realHardwareAcceptanceTest = "test-real-hardware-acceptance.ps1"
    productionStabilityTest = "test-production-stability.ps1"
    barSurfaceE2ETest = "scripts/test-bar-surface-e2e.ps1"
    stop = "stop-runtime.ps1"
  }
  docs = @{
    readme = "README.md"
    sourceDocs = "docs"
  }
}

if ($IncludeQt) {
  $Manifest.captureQt = @{
    path = "capture-qt/steel_capture_qt_terminal.exe"
    sdk = "capture-qt/nvt_lvm_sdk.dll"
  }
  $Manifest.scripts.captureQt = "run-capture-qt.ps1"
}

$Manifest | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $OutRoot "manifest.json") -Encoding UTF8

Write-Host "Runtime package created at $OutRoot"
