param()

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TestParent = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot "target\bundle-toolchain-test"))
$CargoTestParent = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot "target\cargo\bundle-toolchain-test"))
$TestRoot = Join-Path $TestParent ([guid]::NewGuid().ToString("N"))
$DestinationParent = Join-Path $CargoTestParent ([guid]::NewGuid().ToString("N"))
$Destination = Join-Path $DestinationParent ".tauri"
$Provisioner = Join-Path $PSScriptRoot "provision-tauri-bundle-toolchain.ps1"
$ManifestGenerator = Join-Path $PSScriptRoot "new-tauri-bundle-toolchain-manifest.ps1"

function Remove-TestTree {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Boundary
  )
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $Resolved = (Resolve-Path -LiteralPath $Path).Path
  $Boundary = [System.IO.Path]::GetFullPath($Boundary).TrimEnd('\', '/')
  if (-not $Resolved.StartsWith($Boundary + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove bundle-toolchain test data outside its boundary: $Resolved"
  }
  Remove-Item -LiteralPath $Resolved -Recurse -Force
}

function Assert-Throws {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Action,
    [Parameter(Mandatory = $true)][string]$Pattern
  )
  try {
    & $Action | Out-Null
  } catch {
    if ($_.Exception.Message -notmatch $Pattern) {
      throw "Expected rejection matching '$Pattern', got: $($_.Exception.Message)"
    }
    return
  }
  throw "Expected bundle toolchain rejection matching: $Pattern"
}

try {
  $PayloadRoot = Join-Path $TestRoot "payload"
  $FixtureFiles = [ordered]@{
    "WixTools314/candle.exe" = "fixture-wix"
    "NSIS/makensis.exe" = "fixture-nsis"
    "WebView2/MicrosoftEdgeWebview2Setup.exe" = "fixture-webview2"
  }
  foreach ($Entry in $FixtureFiles.GetEnumerator()) {
    $Path = Join-Path $PayloadRoot $Entry.Key.Replace('/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [System.IO.File]::WriteAllText($Path, [string]$Entry.Value, [System.Text.UTF8Encoding]::new($false))
  }
  $ManifestPath = Join-Path $TestRoot "bundle-toolchain-manifest.json"
  $GenerationReport = (& $ManifestGenerator `
    -ProvisioningRoot $TestRoot `
    -TauriCliVersion "2.10.0-test" `
    -WixVersion "3.14-test" `
    -WixLicense "MS-RL" `
    -NsisVersion "3-test" `
    -NsisLicense "zlib" `
    -WebView2Version "test" `
    -WebView2License "Microsoft" | Out-String) | ConvertFrom-Json
  if ($GenerationReport.code -ne 0 -or $GenerationReport.approvalRequired -ne $true) {
    throw "Bundle toolchain manifest generator did not require an explicit approval step."
  }
  Assert-Throws -Pattern 'already exists' -Action {
    & $ManifestGenerator `
      -ProvisioningRoot $TestRoot `
      -TauriCliVersion "2.10.0-test" `
      -WixVersion "3.14-test" `
      -WixLicense "MS-RL" `
      -NsisVersion "3-test" `
      -NsisLicense "zlib" `
      -WebView2Version "test" `
      -WebView2License "Microsoft"
  }
  Assert-Throws -Pattern 'must be distinct' -Action {
    & $ManifestGenerator `
      -ProvisioningRoot $TestRoot `
      -TauriCliVersion "2.10.0-test" `
      -WixVersion "3.14-test" `
      -WixLicense "MS-RL" `
      -NsisVersion "3-test" `
      -NsisLicense "zlib" `
      -WebView2Version "test" `
      -WebView2License "Microsoft" `
      -NsisPathPrefix "WixTools314" `
      -Force
  }
  $UnmappedFile = Join-Path $PayloadRoot "unknown\tool.exe"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $UnmappedFile) | Out-Null
  [System.IO.File]::WriteAllText($UnmappedFile, "unknown", [System.Text.UTF8Encoding]::new($false))
  Assert-Throws -Pattern 'map to exactly one' -Action {
    & $ManifestGenerator `
      -ProvisioningRoot $TestRoot `
      -TauriCliVersion "2.10.0-test" `
      -WixVersion "3.14-test" `
      -WixLicense "MS-RL" `
      -NsisVersion "3-test" `
      -NsisLicense "zlib" `
      -WebView2Version "test" `
      -WebView2License "Microsoft" `
      -Force
  }
  Remove-Item -LiteralPath $UnmappedFile -Force
  Remove-Item -LiteralPath (Split-Path -Parent $UnmappedFile) -Force
  $ManifestHash = (Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash

  & $Provisioner `
    -ProvisioningRoot $TestRoot `
    -ExpectedManifestSha256 $ManifestHash `
    -DestinationRoot $Destination `
    -SourceOnly | Out-Null
  if (Test-Path -LiteralPath $Destination) {
    throw "Source-only validation must not provision a destination."
  }

  & $Provisioner `
    -ProvisioningRoot $TestRoot `
    -ExpectedManifestSha256 $ManifestHash `
    -DestinationRoot $Destination | Out-Null
  & $Provisioner `
    -ProvisioningRoot $TestRoot `
    -ExpectedManifestSha256 $ManifestHash `
    -DestinationRoot $Destination `
    -VerifyOnly | Out-Null

  Assert-Throws -Pattern 'out-of-band approved SHA-256' -Action {
    & $Provisioner `
      -ProvisioningRoot $TestRoot `
      -ExpectedManifestSha256 ('0' * 64) `
      -DestinationRoot $Destination `
      -VerifyOnly
  }

  $TamperedFile = Join-Path $Destination "WixTools314\candle.exe"
  Add-Content -LiteralPath $TamperedFile -Value "tampered"
  Assert-Throws -Pattern 'changed after approval' -Action {
    & $Provisioner `
      -ProvisioningRoot $TestRoot `
      -ExpectedManifestSha256 $ManifestHash `
      -DestinationRoot $Destination `
      -VerifyOnly
  }
  Copy-Item -LiteralPath (Join-Path $PayloadRoot "WixTools314\candle.exe") -Destination $TamperedFile -Force

  $ExtraDirectory = Join-Path $Destination "unapproved-empty"
  New-Item -ItemType Directory -Path $ExtraDirectory | Out-Null
  Assert-Throws -Pattern 'unapproved extra or missing directory' -Action {
    & $Provisioner `
      -ProvisioningRoot $TestRoot `
      -ExpectedManifestSha256 $ManifestHash `
      -DestinationRoot $Destination `
      -VerifyOnly
  }
  Remove-Item -LiteralPath $ExtraDirectory -Force

  $ExtraFile = Join-Path $Destination "unapproved.exe"
  [System.IO.File]::WriteAllText($ExtraFile, "extra", [System.Text.UTF8Encoding]::new($false))
  Assert-Throws -Pattern 'exact bidirectional manifest file inventory' -Action {
    & $Provisioner `
      -ProvisioningRoot $TestRoot `
      -ExpectedManifestSha256 $ManifestHash `
      -DestinationRoot $Destination `
      -VerifyOnly
  }

  [ordered]@{
    schema = "steel.tauri-bundle-toolchain-provisioning-test.v1"
    code = 0
    manifestGeneration = "passed"
    manifestOverwriteGuard = "passed"
    componentPrefixGuard = "passed"
    unmappedFileGuard = "passed"
    sourceOnlyValidation = "passed"
    approvedManifest = "passed"
    exactInventory = "passed"
    tamperRejection = "passed"
    extraDirectoryRejection = "passed"
    extraFileRejection = "passed"
    outOfBandHashRejection = "passed"
  } | ConvertTo-Json -Depth 4
} finally {
  Remove-TestTree -Path $TestRoot -Boundary $TestParent
  Remove-TestTree -Path $DestinationParent -Boundary $CargoTestParent
}
