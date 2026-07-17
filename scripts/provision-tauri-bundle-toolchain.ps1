param(
  [Parameter(Mandatory = $true)]
  [string]$ProvisioningRoot,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9A-Fa-f]{64}$')]
  [string]$ExpectedManifestSha256,
  [string]$DestinationRoot = "",
  [switch]$SourceOnly,
  [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ApprovedDestinationParent = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot "target\cargo"))
if ([string]::IsNullOrWhiteSpace($DestinationRoot)) {
  $DestinationRoot = Join-Path $ApprovedDestinationParent ".tauri"
}
$DestinationRoot = [System.IO.Path]::GetFullPath($DestinationRoot)

function Assert-NotReparsePoint {
  param([Parameter(Mandatory = $true)][string]$Path)

  $Item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Bundle toolchain paths must not contain reparse points: $Path"
  }
}

function Resolve-InventoryPath {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$RelativePath
  )

  if ([string]::IsNullOrWhiteSpace($RelativePath) -or
      $RelativePath.Contains('\') -or
      [System.IO.Path]::IsPathRooted($RelativePath) -or
      $RelativePath -match '(^|/)\.\.?(/|$)' -or
      $RelativePath -match '[:\x00-\x1f]') {
    throw "Bundle toolchain inventory path is not canonical: $RelativePath"
  }
  $RootBoundary = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $Resolved = [System.IO.Path]::GetFullPath((Join-Path $RootBoundary $RelativePath.Replace('/', '\')))
  if (-not $Resolved.StartsWith($RootBoundary + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Bundle toolchain inventory path escapes its root: $RelativePath"
  }
  return $Resolved
}

function Get-ExpectedInventoryDirectories {
  param([Parameter(Mandatory = $true)][object[]]$Files)

  $Directories = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($File in $Files) {
    $Segments = @(([string]$File.path).Split('/'))
    for ($Index = 1; $Index -lt $Segments.Count; $Index++) {
      [void]$Directories.Add(($Segments[0..($Index - 1)] -join '/'))
    }
  }
  return @($Directories | Sort-Object)
}

function Assert-ExactInventoryTree {
  param(
    [Parameter(Mandatory = $true)][object[]]$Items,
    [Parameter(Mandatory = $true)][object[]]$Files,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Context
  )

  $ActualFiles = @($Items | Where-Object { -not $_.PSIsContainer } | ForEach-Object {
    $_.FullName.Substring($Root.Length + 1).Replace('\', '/')
  } | Sort-Object)
  $ExpectedFiles = @($Files | ForEach-Object { [string]$_.path } | Sort-Object)
  if ($ActualFiles.Count -ne $ExpectedFiles.Count -or ($ActualFiles -join "`n") -cne ($ExpectedFiles -join "`n")) {
    throw "$Context is not the exact bidirectional manifest file inventory."
  }

  $ActualDirectories = @($Items | Where-Object { $_.PSIsContainer } | ForEach-Object {
    $_.FullName.Substring($Root.Length + 1).Replace('\', '/')
  } | Sort-Object)
  $ExpectedDirectories = @(Get-ExpectedInventoryDirectories -Files $Files)
  if ($ActualDirectories.Count -ne $ExpectedDirectories.Count -or
      ($ActualDirectories -join "`n") -cne ($ExpectedDirectories -join "`n")) {
    throw "$Context contains an unapproved extra or missing directory."
  }
}

function Read-And-ValidateManifest {
  param([Parameter(Mandatory = $true)][string]$Root)

  Assert-NotReparsePoint $Root
  $ManifestPath = Join-Path $Root "bundle-toolchain-manifest.json"
  $PayloadRoot = Join-Path $Root "payload"
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $PayloadRoot -PathType Container)) {
    throw "ProvisioningRoot must contain bundle-toolchain-manifest.json and payload/."
  }
  Assert-NotReparsePoint $ManifestPath
  Assert-NotReparsePoint $PayloadRoot
  $ActualManifestSha256 = (Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ActualManifestSha256 -cne $ExpectedManifestSha256.ToLowerInvariant()) {
    throw "Bundle toolchain manifest does not match the out-of-band approved SHA-256."
  }
  try {
    $Manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "Bundle toolchain manifest must be valid UTF-8 JSON: $ManifestPath"
  }
  if ([string]$Manifest.schema -cne 'steel.tauri-bundle-toolchain.v1' -or
      [string]$Manifest.rustTarget -cne 'x86_64-pc-windows-msvc' -or
      [string]::IsNullOrWhiteSpace([string]$Manifest.tauriCliVersion)) {
    throw "Bundle toolchain manifest schema, Rust target, or Tauri CLI version is invalid."
  }

  $Components = @($Manifest.components)
  $ComponentIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($Component in $Components) {
    $Id = [string]$Component.id
    if ($Id -notmatch '^[a-z0-9][a-z0-9.-]{1,63}$' -or
        -not $ComponentIds.Add($Id) -or
        [string]::IsNullOrWhiteSpace([string]$Component.version) -or
        [string]::IsNullOrWhiteSpace([string]$Component.license)) {
      throw "Bundle toolchain component identifiers, versions, and licenses must be explicit and unique."
    }
  }
  foreach ($RequiredComponent in @('wix', 'nsis', 'webview2-offline')) {
    if (-not $ComponentIds.Contains($RequiredComponent)) {
      throw "Bundle toolchain manifest is missing required component: $RequiredComponent"
    }
  }

  $Files = @($Manifest.files)
  if ($Files.Count -lt 3) {
    throw "Bundle toolchain inventory must contain at least one file for each required component."
  }
  $DeclaredPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $ComponentsWithFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($File in $Files) {
    $RelativePath = [string]$File.path
    $ComponentId = [string]$File.component
    if (-not $DeclaredPaths.Add($RelativePath)) {
      throw "Bundle toolchain inventory contains a duplicate path: $RelativePath"
    }
    if (-not $ComponentIds.Contains($ComponentId)) {
      throw "Bundle toolchain file references an unknown component: $ComponentId"
    }
    [void]$ComponentsWithFiles.Add($ComponentId)
    if ([string]$File.sha256 -notmatch '^[0-9a-f]{64}$' -or [Int64]$File.size -lt 0) {
      throw "Bundle toolchain file hash or size is invalid: $RelativePath"
    }
    $PayloadPath = Resolve-InventoryPath -Root $PayloadRoot -RelativePath $RelativePath
    if (-not (Test-Path -LiteralPath $PayloadPath -PathType Leaf)) {
      throw "Bundle toolchain inventory points to a missing file: $RelativePath"
    }
    Assert-NotReparsePoint $PayloadPath
    $PayloadItem = Get-Item -LiteralPath $PayloadPath -Force
    if ([Int64]$PayloadItem.Length -ne [Int64]$File.size -or
        (Get-FileHash -LiteralPath $PayloadPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$File.sha256) {
      throw "Bundle toolchain payload size or SHA-256 mismatch: $RelativePath"
    }
  }
  foreach ($RequiredComponent in @('wix', 'nsis', 'webview2-offline')) {
    if (-not $ComponentsWithFiles.Contains($RequiredComponent)) {
      throw "Bundle toolchain component has no payload files: $RequiredComponent"
    }
  }
  $PayloadItems = @(Get-ChildItem -LiteralPath $PayloadRoot -Recurse -Force)
  foreach ($Item in $PayloadItems) {
    Assert-NotReparsePoint $Item.FullName
  }
  Assert-ExactInventoryTree -Items $PayloadItems -Files $Files -Root $PayloadRoot -Context 'Bundle toolchain payload'
  return [pscustomobject]@{
    Manifest = $Manifest
    ManifestPath = $ManifestPath
    ManifestSha256 = $ActualManifestSha256
    PayloadRoot = $PayloadRoot
    ComponentCount = $Components.Count
    FileCount = $Files.Count
  }
}

function Assert-DestinationMatchesManifest {
  param(
    [Parameter(Mandatory = $true)]$Validated,
    [Parameter(Mandatory = $true)][string]$Root
  )

  if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    throw "Missing provisioned Tauri bundle toolchain destination: $Root"
  }
  Assert-NotReparsePoint $Root
  $Files = @($Validated.Manifest.files)
  foreach ($File in $Files) {
    $DestinationPath = Resolve-InventoryPath -Root $Root -RelativePath ([string]$File.path)
    if (-not (Test-Path -LiteralPath $DestinationPath -PathType Leaf)) {
      throw "Provisioned bundle toolchain is missing: $($File.path)"
    }
    Assert-NotReparsePoint $DestinationPath
    $Item = Get-Item -LiteralPath $DestinationPath -Force
    if ([Int64]$Item.Length -ne [Int64]$File.size -or
        (Get-FileHash -LiteralPath $DestinationPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$File.sha256) {
      throw "Provisioned bundle toolchain changed after approval: $($File.path)"
    }
  }
  $DestinationItems = @(Get-ChildItem -LiteralPath $Root -Recurse -Force)
  foreach ($Item in $DestinationItems) {
    Assert-NotReparsePoint $Item.FullName
  }
  Assert-ExactInventoryTree -Items $DestinationItems -Files $Files -Root $Root -Context 'Provisioned bundle toolchain'
}

$ProvisioningRoot = (Resolve-Path -LiteralPath $ProvisioningRoot -ErrorAction Stop).Path
$Validated = Read-And-ValidateManifest -Root $ProvisioningRoot

if ($SourceOnly -and $VerifyOnly) {
  throw "-SourceOnly and -VerifyOnly are mutually exclusive."
}
if ($SourceOnly) {
  # Source validation is intentionally complete before a formal build clears prior artifacts.
} elseif ($VerifyOnly) {
  Assert-DestinationMatchesManifest -Validated $Validated -Root $DestinationRoot
} else {
  if (-not $DestinationRoot.StartsWith($ApprovedDestinationParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to provision outside the repository target/cargo root: $DestinationRoot"
  }
  if (Test-Path -LiteralPath $DestinationRoot) {
    throw "Bundle toolchain destination must not already exist: $DestinationRoot"
  }
  $DestinationParent = Split-Path -Parent $DestinationRoot
  New-Item -ItemType Directory -Force -Path $DestinationParent | Out-Null
  Assert-NotReparsePoint $DestinationParent
  $StageRoot = "$DestinationRoot.stage-$([guid]::NewGuid().ToString('N'))"
  try {
    New-Item -ItemType Directory -Path $StageRoot | Out-Null
    Get-ChildItem -LiteralPath $Validated.PayloadRoot -Force | Copy-Item -Destination $StageRoot -Recurse -Force
    Assert-DestinationMatchesManifest -Validated $Validated -Root $StageRoot
    Move-Item -LiteralPath $StageRoot -Destination $DestinationRoot
  } finally {
    if (Test-Path -LiteralPath $StageRoot) {
      $ResolvedStage = (Resolve-Path -LiteralPath $StageRoot).Path
      if (-not $ResolvedStage.StartsWith($ApprovedDestinationParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a staging directory outside target/cargo: $ResolvedStage"
      }
      Remove-Item -LiteralPath $ResolvedStage -Recurse -Force
    }
  }
  Assert-DestinationMatchesManifest -Validated $Validated -Root $DestinationRoot
}

[ordered]@{
  schema = 'steel.tauri-bundle-toolchain-provisioning-report.v1'
  code = 0
  mode = if ($SourceOnly) { 'source-only' } elseif ($VerifyOnly) { 'verify-only' } else { 'provision' }
  manifestSha256 = $Validated.ManifestSha256
  rustTarget = [string]$Validated.Manifest.rustTarget
  tauriCliVersion = [string]$Validated.Manifest.tauriCliVersion
  componentCount = $Validated.ComponentCount
  fileCount = $Validated.FileCount
  destination = $DestinationRoot
} | ConvertTo-Json -Depth 5
