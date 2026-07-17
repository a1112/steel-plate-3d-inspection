param(
  [Parameter(Mandatory = $true)]
  [string]$ProvisioningRoot,
  [Parameter(Mandatory = $true)]
  [string]$TauriCliVersion,
  [Parameter(Mandatory = $true)]
  [string]$WixVersion,
  [Parameter(Mandatory = $true)]
  [string]$WixLicense,
  [Parameter(Mandatory = $true)]
  [string]$NsisVersion,
  [Parameter(Mandatory = $true)]
  [string]$NsisLicense,
  [Parameter(Mandatory = $true)]
  [string]$WebView2Version,
  [Parameter(Mandatory = $true)]
  [string]$WebView2License,
  [string]$WixPathPrefix = "WixTools314",
  [string]$NsisPathPrefix = "NSIS",
  [string]$WebView2PathPrefix = "WebView2",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

function Assert-NotReparsePoint {
  param([Parameter(Mandatory = $true)][string]$Path)

  $Item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Bundle toolchain source paths must not contain reparse points: $Path"
  }
}

function Get-CanonicalPrefix {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $Value = $Value.TrimEnd('/')
  if ([string]::IsNullOrWhiteSpace($Value) -or
      $Value.Contains('\') -or
      [System.IO.Path]::IsPathRooted($Value) -or
      $Value -match '(^/|//|(^|/)\.\.?(/|$))' -or
      $Value -match '[:\x00-\x1f]') {
    throw "$Name must be a canonical payload-relative directory prefix."
  }
  return $Value
}

foreach ($RequiredValue in @(
  $TauriCliVersion,
  $WixVersion,
  $WixLicense,
  $NsisVersion,
  $NsisLicense,
  $WebView2Version,
  $WebView2License
)) {
  if ([string]::IsNullOrWhiteSpace($RequiredValue)) {
    throw "Bundle toolchain versions and licenses must all be explicit."
  }
}

$ProvisioningRoot = (Resolve-Path -LiteralPath $ProvisioningRoot -ErrorAction Stop).Path
$PayloadRoot = Join-Path $ProvisioningRoot "payload"
if (-not (Test-Path -LiteralPath $PayloadRoot -PathType Container)) {
  throw "ProvisioningRoot must already contain payload/."
}
Assert-NotReparsePoint $ProvisioningRoot
Assert-NotReparsePoint $PayloadRoot

$Components = @(
  [ordered]@{
    id = 'wix'
    version = $WixVersion
    license = $WixLicense
    prefix = Get-CanonicalPrefix -Value $WixPathPrefix -Name 'WixPathPrefix'
  },
  [ordered]@{
    id = 'nsis'
    version = $NsisVersion
    license = $NsisLicense
    prefix = Get-CanonicalPrefix -Value $NsisPathPrefix -Name 'NsisPathPrefix'
  },
  [ordered]@{
    id = 'webview2-offline'
    version = $WebView2Version
    license = $WebView2License
    prefix = Get-CanonicalPrefix -Value $WebView2PathPrefix -Name 'WebView2PathPrefix'
  }
)
$DistinctPrefixes = @($Components | ForEach-Object { [string]$_.prefix } | Sort-Object -Unique)
if ($DistinctPrefixes.Count -ne $Components.Count) {
  throw "Wix, NSIS, and WebView2 payload prefixes must be distinct."
}

$PayloadItems = @(Get-ChildItem -LiteralPath $PayloadRoot -Recurse -Force)
foreach ($Item in $PayloadItems) {
  Assert-NotReparsePoint $Item.FullName
}
$Files = @($PayloadItems | Where-Object { -not $_.PSIsContainer } | ForEach-Object {
  $Item = $_
  $RelativePath = $Item.FullName.Substring($PayloadRoot.Length + 1).Replace('\', '/')
  $Matches = @($Components | Where-Object {
    $RelativePath.StartsWith(([string]$_.prefix + '/'), [System.StringComparison]::Ordinal)
  })
  if ($Matches.Count -ne 1) {
    throw "Every payload file must map to exactly one declared component prefix: $RelativePath"
  }
  [ordered]@{
    path = $RelativePath
    component = [string]$Matches[0].id
    size = [Int64]$Item.Length
    sha256 = (Get-FileHash -LiteralPath $Item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
} | Sort-Object { [string]$_.path })

foreach ($Component in $Components) {
  if (@($Files | Where-Object { [string]$_.component -ceq [string]$Component.id }).Count -lt 1) {
    throw "Bundle toolchain component has no payload files: $($Component.id)"
  }
}

$ManifestPath = Join-Path $ProvisioningRoot "bundle-toolchain-manifest.json"
if ((Test-Path -LiteralPath $ManifestPath) -and -not $Force) {
  throw "Bundle toolchain manifest already exists; use -Force only after intentionally changing the payload or metadata."
}
$Manifest = [ordered]@{
  schema = 'steel.tauri-bundle-toolchain.v1'
  rustTarget = 'x86_64-pc-windows-msvc'
  tauriCliVersion = $TauriCliVersion
  components = @($Components | ForEach-Object {
    [ordered]@{
      id = [string]$_.id
      version = [string]$_.version
      license = [string]$_.license
    }
  })
  files = $Files
}
$TemporaryPath = "$ManifestPath.new-$([guid]::NewGuid().ToString('N'))"
try {
  $Manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $TemporaryPath -Encoding UTF8
  Move-Item -LiteralPath $TemporaryPath -Destination $ManifestPath -Force
} finally {
  if (Test-Path -LiteralPath $TemporaryPath) {
    Remove-Item -LiteralPath $TemporaryPath -Force
  }
}

[ordered]@{
  schema = 'steel.tauri-bundle-toolchain-manifest-generation-report.v1'
  code = 0
  manifestPath = $ManifestPath
  manifestSha256 = (Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  rustTarget = 'x86_64-pc-windows-msvc'
  tauriCliVersion = $TauriCliVersion
  componentCount = $Components.Count
  fileCount = $Files.Count
  approvalRequired = $true
} | ConvertTo-Json -Depth 5
