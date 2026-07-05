param(
  [switch]$SkipFrontendBuild,
  [switch]$SkipClientTests,
  [switch]$SkipServiceTests,
  [switch]$SkipCaptureBuild,
  [switch]$SkipServiceBuild,
  [switch]$SkipExternalProviderCheck,
  [switch]$SkipPackage,
  [switch]$CheckQt
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ClientDir = Join-Path $RepoRoot "app\client"

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

function Assert-NoMatches {
  param(
    [string]$Pattern,
    [string]$Path,
    [string]$Message
  )
  $Matches = & rg -n $Pattern $Path
  if ($LASTEXITCODE -eq 0) {
    Write-Host $Matches
    throw $Message
  }
  if ($LASTEXITCODE -gt 1) {
    throw "rg failed while checking $Path"
  }
}

function Test-PackagedClientStaticServer {
  $PackageDir = Join-Path $RepoRoot "target\packages\steel-inspection-runtime"
  $ClientScript = Join-Path $PackageDir "run-client-static.ps1"
  if (-not (Test-Path $ClientScript -PathType Leaf)) {
    throw "Missing packaged client static server script: $ClientScript"
  }

  $Port = 1492
  $Process = Start-Process -FilePath "powershell" -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $ClientScript,
    "-Port",
    [string]$Port
  ) -WorkingDirectory $PackageDir -PassThru -WindowStyle Hidden

  try {
    $Ready = $false
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 250
      try {
        $Response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2
        if ($Response.StatusCode -eq 200 -and $Response.Content -match "<html") {
          $Ready = $true
          break
        }
      } catch {
      }
    }

    if (-not $Ready) {
      throw "Packaged client static server did not serve index.html"
    }
  } finally {
    if ($Process -and -not $Process.HasExited) {
      Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Host "Checking client/runtime boundaries..."
Assert-NoMatches "NVT_LVM_SDK_ROOT|nvt_lvm_sdk|capture_sdk|rustc-link-lib" (Join-Path $ClientDir "src-tauri") "Tauri client must not link or copy the camera SDK."
Assert-NoMatches "dev:service|service:build|service:start|capture:configure|capture:build|capture:start" (Join-Path $ClientDir "package.json") "Client package scripts must not start services or build capture providers."
Assert-NoMatches "dev-with-service|scripts/cmake" $ClientDir "Client must not keep integrated backend/capture build scripts."

$TauriConfigPath = Join-Path $ClientDir "src-tauri\tauri.conf.json"
try {
  $TauriConfig = Get-Content $TauriConfigPath -Raw | ConvertFrom-Json
} catch {
  throw "Tauri config must be valid JSON: $TauriConfigPath"
}

if ($TauriConfig.build.beforeDevCommand -ne "npm run dev") {
  throw "Tauri beforeDevCommand must only start the frontend dev server."
}
if ($TauriConfig.build.beforeBuildCommand -ne "npm run build") {
  throw "Tauri beforeBuildCommand must only build the frontend."
}

if (-not $SkipClientTests) {
  Invoke-Checked "npm.cmd" @("test", "--", "--run") $ClientDir
}

if (-not $SkipFrontendBuild) {
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-client.ps1"))
}

if (-not $SkipServiceTests) {
  Invoke-Checked "cargo" @("test", "--manifest-path", (Join-Path $RepoRoot "app\service\Cargo.toml"))
}

if (-not $SkipServiceBuild) {
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-service.ps1"))
}

if (-not $SkipCaptureBuild) {
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-capture-headless.ps1"))
}

if (-not $SkipExternalProviderCheck) {
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\verify-external-provider.ps1"))
}

if ($CheckQt) {
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-capture-qt.ps1"))
}

if (-not $SkipPackage) {
  $PackageArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\package-runtime.ps1"), "-SkipBuild")
  if ($CheckQt) {
    $PackageArgs += "-IncludeQt"
  }
  Invoke-Checked "powershell" $PackageArgs
  Test-PackagedClientStaticServer
}

Write-Host "Independent architecture verification passed."
