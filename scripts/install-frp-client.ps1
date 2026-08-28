param(
  [string]$Version = "0.71.0",
  [string]$InstallRoot = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$ReleaseHashes = @{
  "0.71.0" = "9e5062e3e5cf07e67144a3a4acf175ef6a2486f3605dd6cf288bae34ab39819f"
}
if (-not $ReleaseHashes.ContainsKey($Version)) {
  throw "Unsupported FRP version '$Version'. Add its official release SHA-256 before installing it."
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $InstallRoot = Join-Path $RepoRoot "target\tools\frp"
} elseif (-not [System.IO.Path]::IsPathRooted($InstallRoot)) {
  $InstallRoot = Join-Path $RepoRoot $InstallRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$VersionRoot = Join-Path $InstallRoot $Version
$ArchiveName = "frp_${Version}_windows_amd64.zip"
$ArchivePath = Join-Path $VersionRoot $ArchiveName
$ExpandedRoot = Join-Path $VersionRoot "expanded"
$PackageRoot = Join-Path $ExpandedRoot "frp_${Version}_windows_amd64"
$FrpcExe = Join-Path $PackageRoot "frpc.exe"

New-Item -ItemType Directory -Force -Path $VersionRoot | Out-Null
if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
  $DownloadUrl = "https://github.com/fatedier/frp/releases/download/v${Version}/${ArchiveName}"
  Write-Host "Downloading FRP client $Version from the official release..."
  Invoke-WebRequest -UseBasicParsing -Uri $DownloadUrl -OutFile $ArchivePath -TimeoutSec 120
}

$ActualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ArchivePath).Hash.ToLowerInvariant()
$ExpectedHash = [string]$ReleaseHashes[$Version]
if ($ActualHash -ne $ExpectedHash) {
  throw "FRP archive SHA-256 mismatch. Expected $ExpectedHash but received $ActualHash."
}

if (-not (Test-Path -LiteralPath $FrpcExe -PathType Leaf)) {
  New-Item -ItemType Directory -Force -Path $ExpandedRoot | Out-Null
  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExpandedRoot -Force
}
if (-not (Test-Path -LiteralPath $FrpcExe -PathType Leaf)) {
  throw "Official FRP archive did not contain the expected client executable: $FrpcExe"
}

$InstalledVersion = (& $FrpcExe --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $InstalledVersion -ne $Version) {
  throw "FRP client version verification failed for $FrpcExe."
}

Write-Host "FRP client ready: $FrpcExe"
Write-Output $FrpcExe
