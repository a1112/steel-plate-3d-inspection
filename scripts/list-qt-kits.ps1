param(
  [string]$QtRoot = "C:\Qt"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $QtRoot)) {
  throw "Qt root not found: $QtRoot"
}

$Kits = Get-ChildItem -Path $QtRoot -Recurse -Directory -ErrorAction SilentlyContinue |
  Where-Object {
    (Test-Path (Join-Path $_.FullName "lib\cmake\Qt6\Qt6Config.cmake")) -or
    (Test-Path (Join-Path $_.FullName "lib\cmake\Qt5\Qt5Config.cmake"))
  } |
  Sort-Object FullName |
  ForEach-Object {
    $Name = $_.Name.ToLowerInvariant()
    $Toolchain = if ($Name -like "msvc*_64") {
      "msvc-x64"
    } elseif ($Name -like "mingw*") {
      "mingw"
    } else {
      "unknown"
    }
    $Version = if (Test-Path (Join-Path $_.FullName "lib\cmake\Qt6\Qt6Config.cmake")) {
      "Qt6"
    } else {
      "Qt5"
    }
    [PSCustomObject]@{
      Path = $_.FullName
      Name = $_.Name
      Qt = $Version
      Toolchain = $Toolchain
      CompatibleWithLvmSdk = ($Toolchain -eq "msvc-x64")
    }
  }

if (-not $Kits) {
  Write-Host "No Qt kits with QtConfig.cmake found under $QtRoot"
  exit 1
}

$Kits | Format-Table -AutoSize

$Compatible = $Kits | Where-Object { $_.CompatibleWithLvmSdk } | Select-Object -First 1
if ($Compatible) {
  Write-Host "Recommended Qt kit for LVM SDK: $($Compatible.Path)"
  exit 0
}

Write-Host "No MSVC x64 Qt kit found. Install a Qt msvc*_64 kit with $QtRoot\MaintenanceTool.exe."
exit 2
