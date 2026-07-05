param(
  [string]$Configuration = "Release",
  [string]$GeneratorPlatform = "x64",
  [string]$QtPrefixPath = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$BuildDir = Join-Path $RepoRoot "target\capture-qt"
$Args = @("-S", (Join-Path $RepoRoot "app\capture-qt"), "-B", $BuildDir, "-A", $GeneratorPlatform)

function Resolve-QtPrefixPath {
  param([string]$Path)

  if ($Path.Trim().Length -eq 0) {
    return ""
  }

  $Resolved = Resolve-Path $Path -ErrorAction Stop
  $ResolvedPath = $Resolved.Path

  if (Test-Path (Join-Path $ResolvedPath "lib\cmake\Qt6\Qt6Config.cmake") -PathType Leaf) {
    return $ResolvedPath
  }

  if (Test-Path (Join-Path $ResolvedPath "lib\cmake\Qt5\Qt5Config.cmake") -PathType Leaf) {
    return $ResolvedPath
  }

  $MsvcKits = Get-ChildItem -Path $ResolvedPath -Recurse -Directory -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -like "msvc*_64" -and (
        (Test-Path (Join-Path $_.FullName "lib\cmake\Qt6\Qt6Config.cmake")) -or
        (Test-Path (Join-Path $_.FullName "lib\cmake\Qt5\Qt5Config.cmake"))
      )
    } |
    Sort-Object FullName

  if ($MsvcKits.Count -gt 0) {
    return $MsvcKits[0].FullName
  }

  $MingwKits = Get-ChildItem -Path $ResolvedPath -Recurse -Directory -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -like "mingw*" -and (
        (Test-Path (Join-Path $_.FullName "lib\cmake\Qt6\Qt6Config.cmake")) -or
        (Test-Path (Join-Path $_.FullName "lib\cmake\Qt5\Qt5Config.cmake"))
      )
    } |
    Sort-Object FullName

  if ($MingwKits.Count -gt 0) {
    $List = ($MingwKits | ForEach-Object { $_.FullName }) -join ", "
    throw "Found only MinGW Qt kit(s): $List. The LVM SDK is MSVC x64, so install a Qt msvc*_64 kit with C:\Qt\MaintenanceTool.exe. Run scripts/list-qt-kits.ps1 -QtRoot $ResolvedPath to inspect installed kits."
  }

  throw "No Qt kit with QtConfig.cmake found under $ResolvedPath. Install Qt msvc*_64 or pass -QtPrefixPath to the exact kit directory."
}

function Invoke-Checked {
  param(
    [string]$Command,
    [string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

function Resolve-WindeployQt {
  param([string]$ResolvedQtPrefixPath)

  if ($ResolvedQtPrefixPath.Trim().Length -gt 0) {
    $Candidate = Join-Path $ResolvedQtPrefixPath "bin\windeployqt.exe"
    if (Test-Path $Candidate -PathType Leaf) {
      return $Candidate
    }
  }

  $CachePath = Join-Path $BuildDir "CMakeCache.txt"
  if (Test-Path $CachePath -PathType Leaf) {
    $QtDir = Select-String -LiteralPath $CachePath -Pattern "^(Qt6_DIR|Qt5_DIR):PATH=(.+)$" |
      Select-Object -First 1
    if ($QtDir) {
      $QtCmakeDir = $QtDir.Matches[0].Groups[2].Value
      $KitRoot = Split-Path (Split-Path (Split-Path $QtCmakeDir -Parent) -Parent) -Parent
      $Candidate = Join-Path $KitRoot "bin\windeployqt.exe"
      if (Test-Path $Candidate -PathType Leaf) {
        return $Candidate
      }
    }
  }

  $Command = Get-Command "windeployqt.exe" -ErrorAction SilentlyContinue
  if ($Command) {
    return $Command.Source
  }

  return ""
}

function Clear-CMakeConfigureCache {
  if (-not (Test-Path $BuildDir)) {
    return
  }

  $ResolvedBuildDir = Resolve-Path $BuildDir
  $TargetRoot = Resolve-Path (Join-Path $RepoRoot "target")
  if (-not $ResolvedBuildDir.Path.StartsWith($TargetRoot.Path, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clear CMake cache outside target: $ResolvedBuildDir"
  }

  Remove-Item -LiteralPath (Join-Path $ResolvedBuildDir "CMakeCache.txt") -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $ResolvedBuildDir "CMakeFiles") -Recurse -Force -ErrorAction SilentlyContinue
}

$ResolvedQtPrefixPath = ""
if ($QtPrefixPath.Trim().Length -gt 0) {
  $ResolvedQtPrefixPath = Resolve-QtPrefixPath $QtPrefixPath
  Write-Host "Using Qt kit: $ResolvedQtPrefixPath"
  $Args += "-DCMAKE_PREFIX_PATH=$ResolvedQtPrefixPath"
}

Clear-CMakeConfigureCache
Invoke-Checked "cmake" $Args
Invoke-Checked "cmake" @("--build", $BuildDir, "--config", $Configuration)

$ExePath = Join-Path $BuildDir "$Configuration\steel_capture_qt_terminal.exe"
$WindeployQt = Resolve-WindeployQt $ResolvedQtPrefixPath
if ($WindeployQt.Trim().Length -eq 0) {
  throw "Qt capture terminal built, but windeployqt.exe was not found. Pass -QtPrefixPath to the exact Qt msvc*_64 kit so Qt DLLs can be deployed."
}
Invoke-Checked $WindeployQt @("--release", "--no-translations", $ExePath)

Write-Host "Qt capture terminal built at target/capture-qt/$Configuration/steel_capture_qt_terminal.exe"
