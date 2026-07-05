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
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-client.ps1"))
}

if ((Resolve-Path $PackageRoot -ErrorAction SilentlyContinue) -and (Test-Path $OutRoot)) {
  $ResolvedOut = Resolve-Path $OutRoot
  if (-not $ResolvedOut.Path.StartsWith((Resolve-Path $PackageRoot).Path)) {
    throw "Refusing to remove package directory outside target/packages: $ResolvedOut"
  }
  Remove-Item -LiteralPath $ResolvedOut -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $CaptureOut, $ServiceOut, $ClientOut, $ConfigOut, $DocsOut | Out-Null
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

$ClientBuild = Join-Path $RepoRoot "target\client\frontend-dist"
if (-not (Test-Path $ClientBuild -PathType Container)) {
  throw "Missing client build directory: $ClientBuild"
}
Get-ChildItem -LiteralPath $ClientBuild -Force | Copy-Item -Destination $ClientOut -Recurse -Force

Copy-Item -LiteralPath (Join-Path $RepoRoot "config\env") -Destination $ConfigOut -Recurse -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "README.md") -Destination $DocsOut -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "docs\independent-architecture.md") -Destination $DocsOut -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "docs\capture-api-contract.md") -Destination $DocsOut -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "scripts\README.md") -Destination $DocsOut -Force
Copy-RequiredFile (Join-Path $RepoRoot "scripts\run-client-static.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-capture-api.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-capture-continuous.ps1") $OutRoot

Write-PackageFile "run-capture-headless.ps1" @'
param(
  [int]$Port = 4317
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "capture-headless\steel_capture_service.exe"

if (-not (Test-Path $Exe -PathType Leaf)) {
  throw "Missing capture executable: $Exe"
}

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
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "capture-qt\steel_capture_qt_terminal.exe"

if (-not (Test-Path $Exe -PathType Leaf)) {
  throw "Missing Qt capture executable: $Exe"
}

$env:PATH = "$(Split-Path -Parent $Exe);$env:PATH"
& $Exe
exit $LASTEXITCODE
'@
}

Write-PackageFile "run-service-external.ps1" @'
param(
  [int]$Port = 4873,
  [string]$CaptureOrigin = "http://127.0.0.1:4317"
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

& $Exe
exit $LASTEXITCODE
'@

Write-PackageFile "run-service-simulated.ps1" @'
param(
  [int]$Port = 4873
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
Remove-Item Env:\CAPTURE_SERVICE_ORIGIN -ErrorAction SilentlyContinue

& $Exe
exit $LASTEXITCODE
'@

Write-PackageFile "stop-runtime.ps1" @'
$ErrorActionPreference = "Stop"

$ProcessNames = @(
  "steel-inspection-service",
  "steel_capture_service",
  "steel_capture_qt_terminal"
)

foreach ($Name in $ProcessNames) {
  Get-Process -Name $Name -ErrorAction SilentlyContinue | Stop-Process -Force
}
'@

Write-PackageFile "README.md" @'
# Steel Inspection Runtime Package

This package keeps runtime boundaries independent:

- `capture-headless/`: C++ capture provider and camera SDK runtime DLL.
- `service/`: Rust service API executable.
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
    profile = $ServiceProfile
  }
  client = @{
    path = "client/index.html"
  }
  config = @{
    envTemplates = "config/env"
  }
  scripts = @{
    captureHeadless = "run-capture-headless.ps1"
    serviceExternal = "run-service-external.ps1"
    serviceSimulated = "run-service-simulated.ps1"
    clientStatic = "run-client-static.ps1"
    captureApiTest = "test-capture-api.ps1"
    continuousCaptureTest = "test-capture-continuous.ps1"
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
