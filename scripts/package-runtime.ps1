param(
  [string]$Configuration = "Release",
  [ValidateSet("debug", "release")]
  [string]$ServiceProfile = "release",
  [switch]$SkipBuild,
  [switch]$SkipDesktopBundle,
  [switch]$AllowDebugPackage,
  [switch]$AllowDirtyWorktree,
  [string]$CaptureBuildRoot = "",
  [string]$VcRedistPath = $env:VC_REDIST_X64_PATH,
  [string]$ReleaseVersion = "",
  [string]$ExpectedPublisher = $env:TAURI_WINDOWS_PUBLISHER,
  [string]$ReleasePolicyPath = "",
  [string]$ExpectedReleasePolicySha256 = $env:STEEL_RELEASE_POLICY_SHA256,
  [string]$BundleToolchainRoot = $env:TAURI_BUNDLE_TOOLCHAIN_ROOT,
  [string]$ExpectedBundleToolchainManifestSha256 = $env:STEEL_BUNDLE_TOOLCHAIN_MANIFEST_SHA256,
  [string]$ExternalComponentsPath = $env:STEEL_EXTERNAL_COMPONENTS_PATH,
  [string]$ExpectedExternalComponentsSha256 = $env:STEEL_EXTERNAL_COMPONENTS_SHA256
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$DefaultReleasePolicyPath = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot "config\release\desktop-release-policy.json"))
if ([string]::IsNullOrWhiteSpace($ReleasePolicyPath)) {
  $ReleasePolicyPath = $DefaultReleasePolicyPath
}
$ReleasePolicyPath = (Resolve-Path -LiteralPath $ReleasePolicyPath -ErrorAction Stop).Path
$ReleasePolicy = Get-Content -LiteralPath $ReleasePolicyPath -Raw | ConvertFrom-Json
$ReleasePolicyHash = (Get-FileHash -LiteralPath $ReleasePolicyPath -Algorithm SHA256).Hash.ToLowerInvariant()
$CargoConfigPath = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot ".cargo\config.toml"))
$CargoConfigHash = (Get-FileHash -LiteralPath $CargoConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ([string]$ReleasePolicy.schema -cne 'steel.desktop-release-policy.v1') {
  throw "ReleasePolicyPath must contain a steel.desktop-release-policy.v1 policy."
}
$PackageRoot = Join-Path $RepoRoot "target\packages"
$OutRoot = Join-Path $PackageRoot "steel-inspection-runtime"
$CaptureOut = Join-Path $OutRoot "capture-headless"
$ServiceOut = Join-Path $OutRoot "service"
$ClientOut = Join-Path $OutRoot "client"
$ConfigOut = Join-Path $OutRoot "config"
$DocsOut = Join-Path $OutRoot "docs"
$ScriptsOut = Join-Path $OutRoot "scripts"
$AlgorithmCoreOut = Join-Path $OutRoot "algorithm-core"
$DatabaseOut = Join-Path $OutRoot "database"
$DesktopOut = Join-Path $OutRoot "desktop-installer"
$BuildEvidenceOut = Join-Path $OutRoot "build-evidence"
$RuntimeIconsOut = Join-Path $OutRoot "icons"
$IntegrityCatalogRelativePath = ""
$BuildStartedAt = (Get-Date).ToUniversalTime().ToString("o")

if (($Configuration -ne "Release" -or $ServiceProfile -ne "release") -and -not $AllowDebugPackage) {
  throw "Production packages require -Configuration Release and -ServiceProfile release. Use -AllowDebugPackage only for an explicit development artifact."
}
$SourceStatus = @(& git -C $RepoRoot status --porcelain)
$SourceCommit = ((& git -C $RepoRoot rev-parse HEAD 2>$null) | Out-String).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $SourceCommit -notmatch '^[0-9a-f]{40,64}$') {
  throw "Packaging requires an exact Git source commit."
}
$TauriConfigSourcePath = Join-Path $RepoRoot "app\client\src-tauri\tauri.conf.json"
$TauriConfigSourceHash = (Get-FileHash -LiteralPath $TauriConfigSourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
$TauriConfig = Get-Content -LiteralPath $TauriConfigSourcePath -Raw | ConvertFrom-Json
$TauriCargoSourcePath = Join-Path $RepoRoot "app\client\src-tauri\Cargo.toml"
$TauriCargoSourceHash = (Get-FileHash -LiteralPath $TauriCargoSourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
$TauriCargoSourceText = Get-Content -LiteralPath $TauriCargoSourcePath -Raw
$TauriReleaseProfile = [regex]::Match($TauriCargoSourceText, '(?ms)^\[profile\.release\]\s*\r?\n(?<body>.*?)(?=^\[|\z)')
$ClientPackage = Get-Content -LiteralPath (Join-Path $RepoRoot "app\client\package.json") -Raw | ConvertFrom-Json
$DeclaredReleaseVersions = @(
  [string]$TauriConfig.version,
  [string]$ClientPackage.version
)
foreach ($CargoManifest in @(
  "app\client\src-tauri\Cargo.toml",
  "app\service\Cargo.toml",
  "app\trigger\Cargo.toml",
  "app\camera-worker\Cargo.toml",
  "app\pipeline-workers\Cargo.toml",
  "app\runtime-contract\Cargo.toml",
  "app\image-service\Cargo.toml",
  "app\tray\Cargo.toml"
)) {
  $CargoText = Get-Content -LiteralPath (Join-Path $RepoRoot $CargoManifest) -Raw
  if ($CargoText -notmatch '(?m)^version\s*=\s*"([^"]+)"\s*$') {
    throw "Cannot read release version from $CargoManifest"
  }
  $DeclaredReleaseVersions += [string]$Matches[1]
}
$UniqueReleaseVersions = @($DeclaredReleaseVersions | Sort-Object -Unique)
if ($UniqueReleaseVersions.Count -ne 1 -or $UniqueReleaseVersions[0] -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
  throw "Tauri, npm, service, and trigger release versions must be one valid SemVer: $($UniqueReleaseVersions -join ', ')"
}
if ([string]::IsNullOrWhiteSpace($ReleaseVersion)) {
  $ReleaseVersion = $UniqueReleaseVersions[0]
} elseif ($ReleaseVersion -cne $UniqueReleaseVersions[0]) {
  throw "-ReleaseVersion must match every source manifest version ($($UniqueReleaseVersions[0]))."
}
$ReleaseTags = @(& git -C $RepoRoot tag --points-at $SourceCommit 2>$null)
$ReleaseTag = @($ReleaseTags | Where-Object { $_ -ceq "v$ReleaseVersion" -or $_ -ceq $ReleaseVersion } | Select-Object -First 1)
if ($SourceStatus.Count -gt 0 -and -not $AllowDirtyWorktree) {
  throw "Production packaging requires a clean Git worktree. Commit the reviewed release scope or use -AllowDirtyWorktree only for an explicitly non-release artifact."
}
if ($SkipDesktopBundle -and -not $AllowDebugPackage -and -not $AllowDirtyWorktree) {
  throw "A package without the desktop MSI and NSIS bundle is an engineering artifact; explicitly use -AllowDebugPackage or -AllowDirtyWorktree."
}
$FormalReleasePackage = -not $AllowDebugPackage -and -not $AllowDirtyWorktree -and -not $SkipDesktopBundle
if ($FormalReleasePackage -and $SkipBuild) {
  throw "Formal release packaging must build all artifacts in this invocation; -SkipBuild is engineering-only."
}
$CanonicalCaptureBuildRoot = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot "target\capture"))
if ([string]::IsNullOrWhiteSpace($CaptureBuildRoot)) {
  $CaptureBuildRoot = $CanonicalCaptureBuildRoot
} else {
  if (-not [System.IO.Path]::IsPathRooted($CaptureBuildRoot)) {
    $CaptureBuildRoot = Join-Path $RepoRoot $CaptureBuildRoot
  }
  $CaptureBuildRoot = [System.IO.Path]::GetFullPath($CaptureBuildRoot)
}
$RepoBoundary = ([System.IO.Path]::GetFullPath([string]$RepoRoot)).TrimEnd('\', '/')
if (-not $CaptureBuildRoot.StartsWith(
      $RepoBoundary + [System.IO.Path]::DirectorySeparatorChar,
      [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "CaptureBuildRoot must stay inside the repository workspace."
}
if ($FormalReleasePackage -and
    -not $CaptureBuildRoot.Equals(
      $CanonicalCaptureBuildRoot,
      [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Formal release packaging must use the clean canonical target/capture build root."
}
if ($FormalReleasePackage -and ($ReleaseVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or $ReleaseVersion -ceq '0.1.0' -or $ReleaseTag.Count -ne 1)) {
  throw "Formal release packaging requires a non-placeholder synchronized version and an exact v<version> (or <version>) Git tag on the source commit."
}
if ($FormalReleasePackage -and -not $ReleasePolicyPath.Equals($DefaultReleasePolicyPath, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Formal release packaging must use the reviewed, source-controlled config/release/desktop-release-policy.json."
}
if ($FormalReleasePackage) {
  $ExpectedReleasePolicySha256 = $ExpectedReleasePolicySha256.Trim().ToLowerInvariant()
  if ($ExpectedReleasePolicySha256 -notmatch '^[0-9a-f]{64}$' -or
      $ReleasePolicyHash -cne $ExpectedReleasePolicySha256) {
    throw "Formal release packaging requires the out-of-band approved STEEL_RELEASE_POLICY_SHA256 to match the tracked desktop release policy."
  }
  if ([string]$ReleasePolicy.cargoConfigSha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$ReleasePolicy.cargoConfigSha256 -cne $CargoConfigHash -or
      [string]$ReleasePolicy.tauriConfigSha256 -cne $TauriConfigSourceHash -or
      [string]$ReleasePolicy.tauriCargoSha256 -cne $TauriCargoSourceHash -or
      -not $TauriReleaseProfile.Success -or
      [string]$TauriReleaseProfile.Groups['body'].Value -notmatch '(?m)^debug-assertions\s*=\s*false\s*$' -or
      $TauriCargoSourceText -match '(?m)^\s*\[\s*profile\s*\.\s*release\s*\.' -or
      [string]$TauriReleaseProfile.Groups['body'].Value -match '(?m)^\s*package\s*\.') {
    throw "Formal release packaging requires the policy-pinned Cargo config and an explicit release debug-assertions=false profile."
  }
  $ExpectedBundleToolchainManifestSha256 = $ExpectedBundleToolchainManifestSha256.Trim().ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($BundleToolchainRoot) -or
      $ExpectedBundleToolchainManifestSha256 -notmatch '^[0-9a-f]{64}$') {
    throw "Formal release packaging requires TAURI_BUNDLE_TOOLCHAIN_ROOT and an out-of-band STEEL_BUNDLE_TOOLCHAIN_MANIFEST_SHA256."
  }
  $BundleToolchainRoot = (Resolve-Path -LiteralPath $BundleToolchainRoot -ErrorAction Stop).Path
  $RepoBoundary = ([System.IO.Path]::GetFullPath([string]$RepoRoot)).TrimEnd('\', '/')
  if ($BundleToolchainRoot.Equals($RepoBoundary, [System.StringComparison]::OrdinalIgnoreCase) -or
      $BundleToolchainRoot.StartsWith($RepoBoundary + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Formal bundle toolchain provisioning must live outside the source repository and target tree."
  }
  $ExpectedExternalComponentsSha256 = $ExpectedExternalComponentsSha256.Trim().ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($ExternalComponentsPath) -or
      $ExpectedExternalComponentsSha256 -notmatch '^[0-9a-f]{64}$') {
    throw "Formal release packaging requires STEEL_EXTERNAL_COMPONENTS_PATH and an out-of-band STEEL_EXTERNAL_COMPONENTS_SHA256."
  }
  $ExternalComponentsPath = (Resolve-Path -LiteralPath $ExternalComponentsPath -ErrorAction Stop).Path
  if ((Get-FileHash -LiteralPath $ExternalComponentsPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedExternalComponentsSha256) {
    throw "Formal external-component policy does not match its out-of-band approved SHA-256."
  }
}
$PackageClass = if ($FormalReleasePackage) { "formal-release" } else { "engineering" }
$IntegrityCatalogRelativePath = if ($FormalReleasePackage) { "release-integrity.cat" } else { "" }
$ReleaseCertificate = $null
$ReleaseTimestampUrl = ""
$TauriFeatureResolution = $null

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

function Assert-TimestampedAuthenticodeSignature {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [string]$RequiredSignerPattern = "",
    [string]$RequiredSignerThumbprint = ""
  )

  $Signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Release artifact is not Authenticode-valid: $Path ($($Signature.Status): $($Signature.StatusMessage))"
  }
  if ($null -eq $Signature.TimeStamperCertificate) {
    throw "Release artifact is signed but has no trusted timestamp: $Path"
  }
  if (
    -not [string]::IsNullOrWhiteSpace($RequiredSignerPattern) -and
    [string]$Signature.SignerCertificate.Subject -notmatch $RequiredSignerPattern
  ) {
    throw "Release artifact signer is not allowed: $Path ($($Signature.SignerCertificate.Subject))"
  }
  if (
    -not [string]::IsNullOrWhiteSpace($RequiredSignerThumbprint) -and
    [string]$Signature.SignerCertificate.Thumbprint -cne $RequiredSignerThumbprint.ToUpperInvariant()
  ) {
    throw "Release artifact signer thumbprint does not match the approved release certificate: $Path"
  }
  return $Signature
}

function Get-ReleaseCodeSigningCertificate {
  param([Parameter(Mandatory = $true)][string]$Thumbprint)

  $Normalized = $Thumbprint.Replace(' ', '').ToUpperInvariant()
  foreach ($Store in @('Cert:\CurrentUser\My', 'Cert:\LocalMachine\My')) {
    $Certificate = Get-ChildItem -LiteralPath $Store -CodeSigningCert -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Thumbprint.Replace(' ', '').ToUpperInvariant() -ceq $Normalized -and
        $_.NotBefore -le (Get-Date) -and $_.NotAfter -gt (Get-Date)
      } |
      Select-Object -First 1
    if ($Certificate) { return $Certificate }
  }
  throw "Approved release code-signing certificate was not found or is expired: $Thumbprint"
}

function Set-ReleaseAuthenticodeSignature {
  param([Parameter(Mandatory = $true)][string]$Path)

  $Result = Set-AuthenticodeSignature `
    -LiteralPath $Path `
    -Certificate $ReleaseCertificate `
    -TimestampServer $ReleaseTimestampUrl `
    -HashAlgorithm SHA256 `
    -IncludeChain All
  if ($Result.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
      $null -eq $Result.TimeStamperCertificate) {
    throw "Release artifact signing or trusted timestamping failed: $Path ($($Result.Status))"
  }
  return Assert-TimestampedAuthenticodeSignature `
    -Path $Path `
    -RequiredSignerThumbprint ([string]$ReleaseCertificate.Thumbprint)
}

function Assert-FormalSourceStillClean {
  if (-not $FormalReleasePackage) { return }
  $CurrentCommit = ((& git -C $RepoRoot rev-parse HEAD 2>$null) | Out-String).Trim().ToLowerInvariant()
  $CurrentStatus = @(& git -C $RepoRoot status --porcelain)
  if ($LASTEXITCODE -ne 0 -or $CurrentCommit -cne $SourceCommit -or $CurrentStatus.Count -gt 0) {
    throw "Source commit or worktree changed during the formal release build. Review and restart from a clean worktree."
  }
}

function Remove-FormalBuildDirectory {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return }
  $TargetRoot = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot "target")).TrimEnd('\', '/')
  $Resolved = (Resolve-Path -LiteralPath $Path).Path.TrimEnd('\', '/')
  if (-not $Resolved.StartsWith($TargetRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or
      $Resolved -eq $TargetRoot) {
    throw "Refusing to clean a formal build directory outside the repository target root: $Resolved"
  }
  Remove-Item -LiteralPath $Resolved -Recurse -Force
}

function Get-TauriFeatureResolution {
  param([Parameter(Mandatory = $true)][string]$RustTarget)

  $MetadataText = & cargo metadata `
    --manifest-path (Join-Path $RepoRoot "app\client\src-tauri\Cargo.toml") `
    --format-version 1 `
    --locked `
    --offline `
    --filter-platform $RustTarget
  if ($LASTEXITCODE -ne 0) {
    throw "cargo metadata failed while resolving production Tauri features."
  }
  $Metadata = ($MetadataText -join "`n") | ConvertFrom-Json
  $TauriPackageIds = @($Metadata.packages | Where-Object { [string]$_.name -ceq 'tauri' } | ForEach-Object { [string]$_.id })
  $TauriNodes = @($Metadata.resolve.nodes | Where-Object { $TauriPackageIds -ccontains [string]$_.id })
  if ($TauriPackageIds.Count -lt 1 -or $TauriNodes.Count -lt 1) {
    throw "cargo metadata did not resolve the Tauri runtime dependency."
  }
  return [ordered]@{
    schema = "steel.tauri-feature-resolution.v1"
    rustTarget = $RustTarget
    requestedFeatures = @()
    packageIds = @($TauriPackageIds | Sort-Object -Unique)
    enabledFeatures = @($TauriNodes.features | Sort-Object -Unique)
  }
}

function Assert-PeTargetMachine {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$RustTarget
  )

  if ($RustTarget -cne 'x86_64-pc-windows-msvc') {
    throw "Unsupported formal desktop Rust target: $RustTarget"
  }
  $Stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  $Reader = [System.IO.BinaryReader]::new($Stream)
  try {
    if ($Stream.Length -lt 64 -or $Reader.ReadUInt16() -ne 0x5A4D) {
      throw "Artifact is not a valid PE file: $Path"
    }
    $Stream.Position = 0x3C
    $PeOffset = $Reader.ReadInt32()
    if ($PeOffset -lt 64 -or $PeOffset + 6 -gt $Stream.Length) {
      throw "Artifact has an invalid PE header offset: $Path"
    }
    $Stream.Position = $PeOffset
    if ($Reader.ReadUInt32() -ne 0x00004550 -or $Reader.ReadUInt16() -ne 0x8664) {
      throw "Formal artifact is not an x86-64 PE matching ${RustTarget}: $Path"
    }
  } finally {
    $Reader.Dispose()
    $Stream.Dispose()
  }
}

function Assert-NoUnreviewedTauriConfigInputs {
  $TauriConfigDir = Join-Path $RepoRoot "app\client\src-tauri"
  $ConfigVariants = @(Get-ChildItem -LiteralPath $TauriConfigDir -File -Force | Where-Object {
    $_.Name -imatch '^tauri.*(?:\.conf\.json5?|\.toml)$' -and $_.Name -cne 'tauri.conf.json'
  })
  if ($ConfigVariants.Count -gt 0) {
    throw "Formal packaging rejects automatically merged Tauri config variants: $($ConfigVariants.Name -join ', ')"
  }
  $AllowedTauriEnvironment = @(
    'TAURI_WINDOWS_CERTIFICATE_THUMBPRINT',
    'TAURI_WINDOWS_TIMESTAMP_URL',
    'TAURI_WINDOWS_TSP',
    'TAURI_WINDOWS_PUBLISHER'
  )
  $UnapprovedTauriEnvironment = @(Get-ChildItem Env: | Where-Object {
    $_.Name.ToUpperInvariant().StartsWith('TAURI_') -and
    $AllowedTauriEnvironment -cnotcontains $_.Name.ToUpperInvariant()
  })
  if ($UnapprovedTauriEnvironment.Count -gt 0) {
    throw "Formal packaging rejects unreviewed TAURI_* environment overrides: $($UnapprovedTauriEnvironment.Name -join ', ')"
  }
}

function Assert-NoUnreviewedRustBuildInputs {
  $ExactHighRiskNames = @(
    'RUSTFLAGS',
    'CARGO_ENCODED_RUSTFLAGS',
    'RUSTC',
    'RUSTC_BOOTSTRAP',
    'RUSTC_WRAPPER',
    'RUSTC_WORKSPACE_WRAPPER',
    'CARGO_BUILD_RUSTFLAGS',
    'CARGO_BUILD_RUSTC',
    'CARGO_BUILD_RUSTC_WRAPPER',
    'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER',
    'CARGO_BUILD_TARGET'
  )
  $HighRiskEnvironment = @(Get-ChildItem Env: | Where-Object {
    $Name = $_.Name.ToUpperInvariant()
    $ExactHighRiskNames -ccontains $Name -or
    $Name.StartsWith('CARGO_PROFILE_RELEASE_') -or
    $Name -match '^CARGO_TARGET_.+_(?:RUSTFLAGS|RUSTC|RUSTC_WRAPPER|LINKER)$'
  })
  if ($HighRiskEnvironment.Count -gt 0) {
    throw "Formal packaging rejects inherited Rust compiler/profile overrides: $($HighRiskEnvironment.Name -join ', ')"
  }

  $ApprovedCargoConfig = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot '.cargo\config.toml'))
  $UnapprovedCargoConfigs = @()
  $SearchDir = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot 'app\client\src-tauri'))
  while ($null -ne $SearchDir) {
    foreach ($Name in @('config.toml', 'config')) {
      $Candidate = [System.IO.Path]::GetFullPath((Join-Path $SearchDir ".cargo\$Name"))
      if ((Test-Path -LiteralPath $Candidate -PathType Leaf) -and
          -not $Candidate.Equals($ApprovedCargoConfig, [System.StringComparison]::OrdinalIgnoreCase)) {
        $UnapprovedCargoConfigs += $Candidate
      }
    }
    $Parent = [System.IO.Directory]::GetParent($SearchDir)
    $SearchDir = if ($null -eq $Parent) { $null } else { $Parent.FullName }
  }
  $CargoHome = if ([string]::IsNullOrWhiteSpace([string]$env:CARGO_HOME)) {
    Join-Path $HOME '.cargo'
  } else {
    [string]$env:CARGO_HOME
  }
  foreach ($Name in @('config.toml', 'config')) {
    $Candidate = [System.IO.Path]::GetFullPath((Join-Path $CargoHome $Name))
    if ((Test-Path -LiteralPath $Candidate -PathType Leaf) -and
        -not $Candidate.Equals($ApprovedCargoConfig, [System.StringComparison]::OrdinalIgnoreCase)) {
      $UnapprovedCargoConfigs += $Candidate
    }
  }
  $UnapprovedCargoConfigs = @($UnapprovedCargoConfigs | Sort-Object -Unique)
  if ($UnapprovedCargoConfigs.Count -gt 0) {
    throw "Formal packaging rejects unreviewed Cargo config files: $($UnapprovedCargoConfigs -join ', ')"
  }
}

if ($FormalReleasePackage) {
  Assert-NoUnreviewedTauriConfigInputs
  Assert-NoUnreviewedRustBuildInputs
  $BundleToolchainProvisioner = Join-Path $RepoRoot "scripts\provision-tauri-bundle-toolchain.ps1"
  Invoke-Checked "powershell" @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $BundleToolchainProvisioner,
    "-ProvisioningRoot", $BundleToolchainRoot,
    "-ExpectedManifestSha256", $ExpectedBundleToolchainManifestSha256,
    "-SourceOnly"
  )
  $ReleaseSignerThumbprint = [string]$env:TAURI_WINDOWS_CERTIFICATE_THUMBPRINT
  if ($ReleaseSignerThumbprint -notmatch '^[0-9A-Fa-f]{40}$') {
    throw "Formal release packaging requires TAURI_WINDOWS_CERTIFICATE_THUMBPRINT as a 40-hex code-signing certificate thumbprint."
  }
  $ReleaseTimestampUrl = [string]$env:TAURI_WINDOWS_TIMESTAMP_URL
  if ($ReleaseTimestampUrl -notmatch '^https://') {
    throw "Formal release packaging requires an HTTPS TAURI_WINDOWS_TIMESTAMP_URL."
  }
  $ReleaseCertificate = Get-ReleaseCodeSigningCertificate -Thumbprint $ReleaseSignerThumbprint
  $ConfiguredTauriTargets = @($TauriConfig.bundle.targets | Sort-Object)
  $ConfiguredCsp = [string]$TauriConfig.app.security.csp
  $ConfiguredWindows = @($TauriConfig.app.windows)
  $PolicyTargets = @($ReleasePolicy.targets | Sort-Object)
  if ($TauriConfig.bundle.active -ne $true -or
      [string]$ReleasePolicy.rustTarget -cne 'x86_64-pc-windows-msvc' -or
      @($ReleasePolicy.PSObject.Properties.Name) -cnotcontains 'cargoFeatures' -or
      @($TauriConfig.build.PSObject.Properties.Name) -cnotcontains 'features' -or
      @($ReleasePolicy.cargoFeatures).Count -ne 0 -or
      @($TauriConfig.build.features).Count -ne 0 -or
      ($ConfiguredTauriTargets -join ',') -cne ($PolicyTargets -join ',') -or
      [string]$TauriConfig.build.beforeDevCommand -cne [string]$ReleasePolicy.beforeDevCommand -or
      [string]$TauriConfig.build.beforeBuildCommand -cne [string]$ReleasePolicy.beforeBuildCommand -or
      [string]$TauriConfig.bundle.windows.webviewInstallMode.type -cne [string]$ReleasePolicy.webView2InstallMode -or
      [string]$TauriConfig.bundle.windows.nsis.installMode -cne [string]$ReleasePolicy.nsisInstallMode -or
      $TauriConfig.bundle.windows.allowDowngrades -ne $ReleasePolicy.allowDowngrades -or
      [string]::IsNullOrWhiteSpace($ExpectedPublisher) -or
      [string]$TauriConfig.bundle.publisher -cne $ExpectedPublisher -or
      [string]$ReleasePolicy.publisher -cne $ExpectedPublisher -or
      $ConfiguredCsp -cne [string]$ReleasePolicy.contentSecurityPolicy -or
      $ConfiguredWindows.Count -lt 1 -or
      @($ConfiguredWindows | Where-Object { $_.devtools -ne $ReleasePolicy.devtools }).Count -gt 0) {
    throw "Formal Tauri configuration must declare the approved publisher, fixed frontend commands, restrictive CSP, devtools off, MSI+NSIS, offline WebView2, per-machine NSIS, and no downgrades."
  }
  $TauriFeatureResolution = Get-TauriFeatureResolution -RustTarget ([string]$ReleasePolicy.rustTarget)
  if (@($TauriFeatureResolution.enabledFeatures) -ccontains 'devtools') {
    throw "Resolved production Tauri features enable devtools."
  }
  foreach ($BuildDirectory in @(
    (Join-Path $RepoRoot "target\capture"),
    (Join-Path $RepoRoot "target\cargo"),
    (Join-Path $RepoRoot "target\trigger"),
    (Join-Path $RepoRoot "target\algorithm-core"),
    (Join-Path $RepoRoot "target\client\frontend-dist")
  )) {
    Remove-FormalBuildDirectory -Path $BuildDirectory
  }
  Invoke-Checked "powershell" @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $BundleToolchainProvisioner,
    "-ProvisioningRoot", $BundleToolchainRoot,
    "-ExpectedManifestSha256", $ExpectedBundleToolchainManifestSha256,
    "-DestinationRoot", (Join-Path $RepoRoot "target\cargo\.tauri")
  )
  Invoke-Checked "npm.cmd" @("ci", "--no-audit", "--no-fund") (Join-Path $RepoRoot "app\client")
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

$MigrationArchitectureTest = Join-Path $RepoRoot "scripts\test-architecture-migration-contract.ps1"
$MigrationArchitectureReportText = (& $MigrationArchitectureTest -RepoRoot ([string]$RepoRoot) | Out-String)
$MigrationArchitectureReport = $MigrationArchitectureReportText | ConvertFrom-Json
if ($MigrationArchitectureReport.code -ne 0) {
  throw "Architecture migration contract failed before packaging."
}
$MigrationArchitecture = $MigrationArchitectureReport.contract

$DatabaseContractVerifier = Join-Path $RepoRoot "scripts\verify-database-migration-contract.ps1"
$DatabaseContractTest = Join-Path $RepoRoot "scripts\test-database-migration-contract.ps1"
$DatabaseContractSource = Join-Path $RepoRoot "config\release\database\contract.json"
$DatabaseMigrationIndexSource = Join-Path $RepoRoot "config\release\database\migrations\index.json"
$DatabaseContractReportText = (& $DatabaseContractVerifier `
  -ContractPath $DatabaseContractSource `
  -IndexPath $DatabaseMigrationIndexSource | Out-String)
$DatabaseContractReport = $DatabaseContractReportText | ConvertFrom-Json
if ($DatabaseContractReport.code -ne 0 -or
    [string]$DatabaseContractReport.schema -cne 'steel.database-contract-verification.v1') {
  throw "Database contract validation failed before packaging."
}
$DatabaseContract = Get-Content -LiteralPath $DatabaseContractSource -Raw -Encoding UTF8 | ConvertFrom-Json
$ServiceDatabaseSource = Get-Content -LiteralPath (Join-Path $RepoRoot "app\service\src\db\mod.rs") -Raw -Encoding UTF8
$ServiceSchemaVersionMatches = [regex]::Matches(
  $ServiceDatabaseSource,
  '(?m)^pub const DATABASE_SCHEMA_VERSION: i64 = ([1-9][0-9]*);\r?$'
)
if ($ServiceSchemaVersionMatches.Count -ne 1 -or
    [long]$DatabaseContract.schemaVersion -ne [long]$ServiceSchemaVersionMatches[0].Groups[1].Value -or
    [long]$DatabaseContract.minReadableSchemaVersion -ne [long]$DatabaseContract.schemaVersion -or
    [long]$DatabaseContract.maxReadableSchemaVersion -ne [long]$DatabaseContract.schemaVersion) {
  throw "Database package contract must exactly match the Rust DATABASE_SCHEMA_VERSION and readable range."
}

if (-not $SkipBuild) {
  Invoke-Checked "powershell" @(
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $RepoRoot "scripts\build-capture-headless.ps1"),
    "-Configuration", $Configuration,
    "-BuildDir", $CaptureBuildRoot
  )
  $ServiceBuildArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-service.ps1"), "-Profile", $ServiceProfile)
  $TriggerBuildArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-trigger-gateway.ps1"), "-Profile", $ServiceProfile)
  if ($FormalReleasePackage) {
    $ServiceBuildArgs += "-Locked"
    $TriggerBuildArgs += "-Locked"
  }
  Invoke-Checked "powershell" $ServiceBuildArgs
  Invoke-Checked "powershell" $TriggerBuildArgs
  $PipelineWorkerBuildArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-pipeline-workers.ps1"), "-Profile", $ServiceProfile)
  $CameraWorkerBuildArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-camera-worker.ps1"), "-Profile", $ServiceProfile)
  $ImageServiceBuildArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-image-service.ps1"), "-Profile", $ServiceProfile)
  $TrayBuildArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-tray.ps1"), "-Profile", $ServiceProfile)
  if ($FormalReleasePackage) { $PipelineWorkerBuildArgs += "-Locked"; $CameraWorkerBuildArgs += "-Locked"; $ImageServiceBuildArgs += "-Locked"; $TrayBuildArgs += "-Locked" }
  Invoke-Checked "powershell" $CameraWorkerBuildArgs
  Invoke-Checked "powershell" $PipelineWorkerBuildArgs
  Invoke-Checked "powershell" $ImageServiceBuildArgs
  Invoke-Checked "powershell" $TrayBuildArgs
  $ClientBuildArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-client.ps1"))
  if (-not $SkipDesktopBundle) {
    $ClientBuildArgs += "-Tauri"
    if ($FormalReleasePackage) {
      $ClientBuildArgs += @("-RustTarget", [string]$ReleasePolicy.rustTarget)
    }
    if (-not $FormalReleasePackage) {
      $ClientBuildArgs += "-AllowUnsignedDesktopBundle"
    }
  }
  Invoke-Checked "powershell" $ClientBuildArgs
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-algorithm-core.ps1"), "-Configuration", $Configuration)
  if ($FormalReleasePackage) {
    Invoke-Checked "powershell" @(
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $BundleToolchainProvisioner,
      "-ProvisioningRoot", $BundleToolchainRoot,
      "-ExpectedManifestSha256", $ExpectedBundleToolchainManifestSha256,
      "-DestinationRoot", (Join-Path $RepoRoot "target\cargo\.tauri"),
      "-VerifyOnly"
    )
  }
}

Assert-FormalSourceStillClean

if ((Resolve-Path $PackageRoot -ErrorAction SilentlyContinue) -and (Test-Path $OutRoot)) {
  $ResolvedOut = Resolve-Path $OutRoot
  if (-not $ResolvedOut.Path.StartsWith((Resolve-Path $PackageRoot).Path)) {
    throw "Refusing to remove package directory outside target/packages: $ResolvedOut"
  }
  Remove-Item -LiteralPath $ResolvedOut -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $CaptureOut, $ServiceOut, $ClientOut, $ConfigOut, $DocsOut, $ScriptsOut, $AlgorithmCoreOut, $DatabaseOut, $BuildEvidenceOut, $RuntimeIconsOut | Out-Null

Copy-RequiredFile $DatabaseContractSource (Join-Path $DatabaseOut "contract.json")
Copy-Item -LiteralPath (Split-Path -Parent $DatabaseMigrationIndexSource) -Destination $DatabaseOut -Recurse -Force
$PackagedDatabaseContractPath = Join-Path $DatabaseOut "contract.json"
$PackagedDatabaseMigrationIndexPath = Join-Path $DatabaseOut "migrations\index.json"
$PackagedDatabaseContractHash = (Get-FileHash -LiteralPath $PackagedDatabaseContractPath -Algorithm SHA256).Hash.ToLowerInvariant()
$PackagedDatabaseMigrationIndexHash = (Get-FileHash -LiteralPath $PackagedDatabaseMigrationIndexPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($PackagedDatabaseMigrationIndexHash -cne [string]$DatabaseContract.migrationIndexSha256) {
  throw "Packaged database migration index changed after source validation."
}
[void](& $DatabaseContractVerifier `
  -ContractPath $PackagedDatabaseContractPath `
  -IndexPath $PackagedDatabaseMigrationIndexPath | Out-String)

$DependencyLockEvidence = @()
foreach ($LockFile in @(
  @{ source = "app\client\package-lock.json"; destination = "client-package-lock.json" },
  @{ source = "app\client\src-tauri\Cargo.lock"; destination = "tauri-Cargo.lock" },
  @{ source = "app\service\Cargo.lock"; destination = "service-Cargo.lock" },
  @{ source = "app\trigger\Cargo.lock"; destination = "trigger-Cargo.lock" },
  @{ source = "app\camera-worker\Cargo.lock"; destination = "camera-worker-Cargo.lock" },
  @{ source = "app\result-contract\Cargo.lock"; destination = "result-contract-Cargo.lock" },
  @{ source = "app\pipeline-workers\Cargo.lock"; destination = "pipeline-workers-Cargo.lock" },
  @{ source = "app\runtime-contract\Cargo.lock"; destination = "runtime-contract-Cargo.lock" },
  @{ source = "app\image-service\Cargo.lock"; destination = "image-service-Cargo.lock" },
  @{ source = "app\tray\Cargo.lock"; destination = "tray-Cargo.lock" }
)) {
  $SourceLock = Join-Path $RepoRoot ([string]$LockFile.source)
  $DestinationLock = Join-Path $BuildEvidenceOut ([string]$LockFile.destination)
  Copy-RequiredFile $SourceLock $DestinationLock
  $DependencyLockEvidence += [ordered]@{
    path = $DestinationLock.Substring($OutRoot.Length + 1).Replace('\', '/')
    sha256 = (Get-FileHash -LiteralPath $DestinationLock -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
$TauriConfigEvidencePath = Join-Path $BuildEvidenceOut "tauri.conf.json"
Copy-RequiredFile (Join-Path $RepoRoot "app\client\src-tauri\tauri.conf.json") $TauriConfigEvidencePath
$TauriConfigEvidenceHash = (Get-FileHash -LiteralPath $TauriConfigEvidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
$TauriCargoEvidencePath = Join-Path $BuildEvidenceOut "tauri-Cargo.toml"
Copy-RequiredFile (Join-Path $RepoRoot "app\client\src-tauri\Cargo.toml") $TauriCargoEvidencePath
$TauriCargoEvidenceHash = (Get-FileHash -LiteralPath $TauriCargoEvidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
$CargoConfigEvidencePath = Join-Path $BuildEvidenceOut "cargo-config.toml"
Copy-RequiredFile $CargoConfigPath $CargoConfigEvidencePath
$CargoConfigEvidenceHash = (Get-FileHash -LiteralPath $CargoConfigEvidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
$ReleasePolicyEvidencePath = Join-Path $BuildEvidenceOut "desktop-release-policy.json"
Copy-RequiredFile $ReleasePolicyPath $ReleasePolicyEvidencePath
$ReleasePolicyEvidenceHash = (Get-FileHash -LiteralPath $ReleasePolicyEvidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
$BundleToolchainEvidencePath = ""
$BundleToolchainEvidenceHash = ""
$BundleToolchainManifest = $null
if ($FormalReleasePackage) {
  $BundleToolchainEvidencePath = Join-Path $BuildEvidenceOut "bundle-toolchain-manifest.json"
  Copy-RequiredFile (Join-Path $BundleToolchainRoot "bundle-toolchain-manifest.json") $BundleToolchainEvidencePath
  $BundleToolchainEvidenceHash = (Get-FileHash -LiteralPath $BundleToolchainEvidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($BundleToolchainEvidenceHash -cne $ExpectedBundleToolchainManifestSha256) {
    throw "Packaged bundle toolchain evidence changed after provisioning."
  }
  $BundleToolchainManifest = Get-Content -LiteralPath $BundleToolchainEvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json
}
$TauriFeatureEvidencePath = ""
$TauriFeatureEvidenceHash = ""
if ($FormalReleasePackage) {
  $TauriFeatureEvidencePath = Join-Path $BuildEvidenceOut "tauri-feature-resolution.json"
  $TauriFeatureResolution | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $TauriFeatureEvidencePath -Encoding UTF8
  $TauriFeatureEvidenceHash = (Get-FileHash -LiteralPath $TauriFeatureEvidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
}

$RequiredExternalComponentCategories = @(
  'cpp-toolchain',
  'camera-sdk',
  'vc-runtime',
  'webview2-runtime',
  'wix-toolset',
  'nsis'
)
$ReleaseSbomManifest = [ordered]@{
  schema = ""
  format = ""
  specVersion = ""
  path = ""
  sha256 = ""
  sourceCommit = ""
  dirty = $null
  componentCount = 0
  npmComponentCount = 0
  cargoComponentCount = 0
  externalComponentCount = 0
  metadataPropertyCount = 0
  dependencyLockCount = 0
  toolCount = 0
  requiredExternalCategories = @()
  externalComponents = [ordered]@{
    path = ""
    sha256 = ""
    sourceName = ""
    schema = ""
    approved = $null
    componentCount = 0
  }
  dependencyLocks = @()
  tools = @()
}
if ($FormalReleasePackage) {
  $SbomGenerator = Join-Path $RepoRoot "scripts\generate-release-sbom.ps1"
  $SbomVerifier = Join-Path $RepoRoot "scripts\verify-release-sbom.ps1"
  $SbomCommon = Join-Path $RepoRoot "scripts\release-sbom-common.ps1"
  $ReleaseSbomEvidencePath = Join-Path $BuildEvidenceOut "steel-release-sbom.cdx.json"
  $ExternalComponentsEvidencePath = Join-Path $BuildEvidenceOut "external-components.json"
  $SbomToolsEvidenceOut = Join-Path $BuildEvidenceOut "sbom-tools"
  New-Item -ItemType Directory -Force -Path $SbomToolsEvidenceOut | Out-Null

  $ReleaseSbomGenerationText = (& $SbomGenerator `
    -RepoRoot ([string]$RepoRoot) `
    -ExternalComponentsPath $ExternalComponentsPath `
    -ExpectedExternalComponentsSha256 $ExpectedExternalComponentsSha256 `
    -ExpectedCommit $SourceCommit `
    -OutputPath $ReleaseSbomEvidencePath | Out-String)
  $ReleaseSbomGeneration = $ReleaseSbomGenerationText | ConvertFrom-Json
  if ([string]$ReleaseSbomGeneration.schema -cne 'steel.release-sbom.cyclonedx.v1' -or
      [string]$ReleaseSbomGeneration.sourceCommit -cne $SourceCommit -or
      $ReleaseSbomGeneration.dirty -ne $false -or
      [int]$ReleaseSbomGeneration.componentCount -lt 6 -or
      [int]$ReleaseSbomGeneration.externalComponentCount -lt 6) {
    throw "Formal SBOM generation did not produce clean, commit-bound CycloneDX evidence."
  }
  $ReleaseSbomHash = (Get-FileHash -LiteralPath $ReleaseSbomEvidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ReleaseSbomHash -cne [string]$ReleaseSbomGeneration.sha256) {
    throw "Generated SBOM hash changed before semantic verification."
  }
  $ReleaseSbomVerificationText = (& $SbomVerifier `
    -SbomPath $ReleaseSbomEvidencePath `
    -RepoRoot ([string]$RepoRoot) `
    -ExternalComponentsPath $ExternalComponentsPath `
    -ExpectedExternalComponentsSha256 $ExpectedExternalComponentsSha256 `
    -ExpectedSbomSha256 $ReleaseSbomHash `
    -ExpectedCommit $SourceCommit | Out-String)
  $ReleaseSbomVerification = $ReleaseSbomVerificationText | ConvertFrom-Json
  if ($ReleaseSbomVerification.valid -ne $true -or
      [string]$ReleaseSbomVerification.schema -cne 'steel.release-sbom.cyclonedx.v1' -or
      [string]$ReleaseSbomVerification.sha256 -cne $ReleaseSbomHash -or
      [string]$ReleaseSbomVerification.sourceCommit -cne $SourceCommit -or
      $ReleaseSbomVerification.dirty -ne $false -or
      [int]$ReleaseSbomVerification.componentCount -ne [int]$ReleaseSbomGeneration.componentCount -or
      $ReleaseSbomVerification.offline -ne $true) {
    throw "Formal SBOM failed source-semantic offline verification."
  }

  Copy-RequiredFile $ExternalComponentsPath $ExternalComponentsEvidencePath
  if ((Get-FileHash -LiteralPath $ExternalComponentsEvidencePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedExternalComponentsSha256) {
    throw "Packaged external-component policy changed after approval."
  }
  $ExternalComponentsPolicy = Get-Content -LiteralPath $ExternalComponentsEvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $ExternalCategories = @($ExternalComponentsPolicy.components | ForEach-Object { [string]$_.category } | Sort-Object -Unique)
  if ([string]$ExternalComponentsPolicy.schema -cne 'steel.release-external-components.v1' -or
      $ExternalComponentsPolicy.approved -ne $true -or
      ($ExternalCategories -join "`n") -cne (@($RequiredExternalComponentCategories | Sort-Object) -join "`n") -or
      @($ExternalComponentsPolicy.components).Count -ne [int]$ReleaseSbomGeneration.externalComponentCount) {
    throw "Packaged external-component policy does not contain the six approved release categories."
  }

  $SbomToolDefinitions = @(
    [ordered]@{ id = 'generate'; name = 'generate-release-sbom.ps1'; source = $SbomGenerator; metadata = 'steel.tool.generate.sha256' },
    [ordered]@{ id = 'verify'; name = 'verify-release-sbom.ps1'; source = $SbomVerifier; metadata = 'steel.tool.verify.sha256' },
    [ordered]@{ id = 'common'; name = 'release-sbom-common.ps1'; source = $SbomCommon; metadata = 'steel.tool.common.sha256' }
  )
  $SbomToolEvidence = @()
  foreach ($Tool in $SbomToolDefinitions) {
    $ToolEvidencePath = Join-Path $SbomToolsEvidenceOut ([string]$Tool.name)
    Copy-RequiredFile ([string]$Tool.source) $ToolEvidencePath
    $SbomToolEvidence += ,[ordered]@{
      id = [string]$Tool.id
      name = [string]$Tool.name
      path = $ToolEvidencePath.Substring($OutRoot.Length + 1).Replace('\', '/')
      sha256 = (Get-FileHash -LiteralPath $ToolEvidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
      metadataProperty = [string]$Tool.metadata
    }
  }

  $SbomLockDefinitions = @(
    [ordered]@{ id = 'npm-client'; sourcePath = 'app/client/package-lock.json'; evidencePath = 'build-evidence/client-package-lock.json' },
    [ordered]@{ id = 'cargo-tauri'; sourcePath = 'app/client/src-tauri/Cargo.lock'; evidencePath = 'build-evidence/tauri-Cargo.lock' },
    [ordered]@{ id = 'cargo-service'; sourcePath = 'app/service/Cargo.lock'; evidencePath = 'build-evidence/service-Cargo.lock' },
    [ordered]@{ id = 'cargo-trigger'; sourcePath = 'app/trigger/Cargo.lock'; evidencePath = 'build-evidence/trigger-Cargo.lock' },
    [ordered]@{ id = 'cargo-camera-worker'; sourcePath = 'app/camera-worker/Cargo.lock'; evidencePath = 'build-evidence/camera-worker-Cargo.lock' },
    [ordered]@{ id = 'cargo-result-contract'; sourcePath = 'app/result-contract/Cargo.lock'; evidencePath = 'build-evidence/result-contract-Cargo.lock' },
    [ordered]@{ id = 'cargo-pipeline-workers'; sourcePath = 'app/pipeline-workers/Cargo.lock'; evidencePath = 'build-evidence/pipeline-workers-Cargo.lock' },
    [ordered]@{ id = 'cargo-runtime-contract'; sourcePath = 'app/runtime-contract/Cargo.lock'; evidencePath = 'build-evidence/runtime-contract-Cargo.lock' },
    [ordered]@{ id = 'cargo-image-service'; sourcePath = 'app/image-service/Cargo.lock'; evidencePath = 'build-evidence/image-service-Cargo.lock' },
    [ordered]@{ id = 'cargo-tray'; sourcePath = 'app/tray/Cargo.lock'; evidencePath = 'build-evidence/tray-Cargo.lock' }
  )
  $SbomLockEvidence = @()
  foreach ($Lock in $SbomLockDefinitions) {
    $Evidence = @($DependencyLockEvidence | Where-Object { [string]$_.path -ceq [string]$Lock.evidencePath })
    if ($Evidence.Count -ne 1) {
      throw "SBOM cannot bind unique packaged lock evidence: $($Lock.id)"
    }
    $SbomLockEvidence += ,[ordered]@{
      id = [string]$Lock.id
      sourcePath = [string]$Lock.sourcePath
      evidencePath = [string]$Lock.evidencePath
      sha256 = [string]$Evidence[0].sha256
    }
  }

  $ReleaseSbomDocument = Get-Content -LiteralPath $ReleaseSbomEvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $SbomMetadataProperties = @($ReleaseSbomDocument.metadata.properties)
  $SbomPropertyMap = @{}
  foreach ($Property in $SbomMetadataProperties) {
    $Name = [string]$Property.name
    if ([string]::IsNullOrWhiteSpace($Name) -or $SbomPropertyMap.ContainsKey($Name)) {
      throw "SBOM metadata property is empty or duplicated: $Name"
    }
    $SbomPropertyMap[$Name] = [string]$Property.value
  }
  $ExpectedSbomPropertyNames = @(
    'steel.sbom.schema',
    'steel.generator.version',
    'steel.source.gitCommit',
    'steel.source.dirty',
    'steel.source.commitTimestamp',
    'steel.input.npm-client.path',
    'steel.input.npm-client.sha256',
    'steel.input.cargo-tauri.path',
    'steel.input.cargo-tauri.sha256',
    'steel.input.cargo-service.path',
    'steel.input.cargo-service.sha256',
    'steel.input.cargo-trigger.path',
    'steel.input.cargo-trigger.sha256',
    'steel.input.cargo-camera-worker.path',
    'steel.input.cargo-camera-worker.sha256',
    'steel.input.cargo-result-contract.path',
    'steel.input.cargo-result-contract.sha256',
    'steel.input.cargo-pipeline-workers.path',
    'steel.input.cargo-pipeline-workers.sha256',
    'steel.input.cargo-runtime-contract.path',
    'steel.input.cargo-runtime-contract.sha256',
    'steel.input.cargo-image-service.path',
    'steel.input.cargo-image-service.sha256',
    'steel.input.cargo-tray.path',
    'steel.input.cargo-tray.sha256',
    'steel.input.external-components.path',
    'steel.input.external-components.sha256',
    'steel.tool.generate.sha256',
    'steel.tool.verify.sha256',
    'steel.tool.common.sha256',
    'steel.component.count.npm',
    'steel.component.count.cargo',
    'steel.component.count.external',
    'steel.component.count.total'
  )
  if ((@($SbomPropertyMap.Keys | Sort-Object) -join "`n") -cne (@($ExpectedSbomPropertyNames | Sort-Object) -join "`n") -or
      [string]$SbomPropertyMap['steel.sbom.schema'] -cne 'steel.release-sbom.cyclonedx.v1' -or
      [string]$SbomPropertyMap['steel.source.gitCommit'] -cne $SourceCommit -or
      [string]$SbomPropertyMap['steel.source.dirty'] -cne 'false' -or
      [string]$SbomPropertyMap['steel.input.external-components.path'] -cne "external:$([System.IO.Path]::GetFileName($ExternalComponentsPath))" -or
      [string]$SbomPropertyMap['steel.input.external-components.sha256'] -cne $ExpectedExternalComponentsSha256) {
    throw "SBOM metadata properties do not bind the formal source and approved external policy."
  }
  foreach ($Lock in $SbomLockEvidence) {
    if ([string]$SbomPropertyMap["steel.input.$($Lock.id).path"] -cne [string]$Lock.sourcePath -or
        [string]$SbomPropertyMap["steel.input.$($Lock.id).sha256"] -cne [string]$Lock.sha256) {
      throw "SBOM metadata does not bind packaged lock evidence: $($Lock.id)"
    }
  }
  foreach ($Tool in $SbomToolEvidence) {
    if ([string]$SbomPropertyMap[[string]$Tool.metadataProperty] -cne [string]$Tool.sha256) {
      throw "SBOM metadata does not bind packaged tool evidence: $($Tool.id)"
    }
  }
  if ([int]$SbomPropertyMap['steel.component.count.npm'] -ne [int]$ReleaseSbomGeneration.npmComponentCount -or
      [int]$SbomPropertyMap['steel.component.count.cargo'] -ne [int]$ReleaseSbomGeneration.cargoComponentCount -or
      [int]$SbomPropertyMap['steel.component.count.external'] -ne [int]$ReleaseSbomGeneration.externalComponentCount -or
      [int]$SbomPropertyMap['steel.component.count.total'] -ne [int]$ReleaseSbomGeneration.componentCount) {
    throw "SBOM component counts do not match generation evidence."
  }

  $ReleaseSbomManifest = [ordered]@{
    schema = 'steel.release-sbom.cyclonedx.v1'
    format = 'CycloneDX'
    specVersion = '1.5'
    path = $ReleaseSbomEvidencePath.Substring($OutRoot.Length + 1).Replace('\', '/')
    sha256 = $ReleaseSbomHash
    sourceCommit = $SourceCommit
    dirty = $false
    componentCount = [int]$ReleaseSbomGeneration.componentCount
    npmComponentCount = [int]$ReleaseSbomGeneration.npmComponentCount
    cargoComponentCount = [int]$ReleaseSbomGeneration.cargoComponentCount
    externalComponentCount = [int]$ReleaseSbomGeneration.externalComponentCount
    metadataPropertyCount = $SbomMetadataProperties.Count
    dependencyLockCount = $SbomLockEvidence.Count
    toolCount = $SbomToolEvidence.Count
    requiredExternalCategories = @($RequiredExternalComponentCategories)
    externalComponents = [ordered]@{
      path = $ExternalComponentsEvidencePath.Substring($OutRoot.Length + 1).Replace('\', '/')
      sha256 = $ExpectedExternalComponentsSha256
      sourceName = [System.IO.Path]::GetFileName($ExternalComponentsPath)
      schema = [string]$ExternalComponentsPolicy.schema
      approved = $true
      componentCount = @($ExternalComponentsPolicy.components).Count
    }
    dependencyLocks = $SbomLockEvidence
    tools = $SbomToolEvidence
  }
}

$CaptureBuild = Join-Path $CaptureBuildRoot $Configuration
Copy-RequiredFile (Join-Path $CaptureBuild "steel_runtime_supervisor.exe") (Join-Path $ServiceOut "steel-runtime-supervisor.exe")

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
$PipelineWorkerBuild = if ($ServiceProfile -eq "release") { Join-Path $RepoRoot "target\pipeline-workers\release" } else { Join-Path $RepoRoot "target\pipeline-workers\debug" }
Copy-RequiredFile (Join-Path $PipelineWorkerBuild "steel-image-worker.exe") $ServiceOut
Copy-RequiredFile (Join-Path $PipelineWorkerBuild "steel-defect-worker.exe") $ServiceOut
$CameraWorkerBuild = if ($ServiceProfile -eq "release") { Join-Path $RepoRoot "target\camera-worker\release" } else { Join-Path $RepoRoot "target\camera-worker\debug" }
Copy-RequiredFile (Join-Path $CameraWorkerBuild "steel-capture-service.exe") $ServiceOut
$ImageServiceBuild = if ($ServiceProfile -eq "release") { Join-Path $RepoRoot "target\image-service\release" } else { Join-Path $RepoRoot "target\image-service\debug" }
Copy-RequiredFile (Join-Path $ImageServiceBuild "steel-image-service.exe") $ServiceOut
$TrayBuild = if ($ServiceProfile -eq "release") { Join-Path $RepoRoot "target\tray\release" } else { Join-Path $RepoRoot "target\tray\debug" }
Copy-RequiredFile (Join-Path $TrayBuild "steel-inspection-tray.exe") $ServiceOut

$AlgorithmCoreBuild = Join-Path $RepoRoot "target\algorithm-core\$Configuration"
Copy-RequiredFile (Join-Path $AlgorithmCoreBuild "steel_bar_surface_core.exe") $AlgorithmCoreOut

$RuntimeSignatureEvidence = @()
if ($FormalReleasePackage) {
  $FirstPartyRuntimeArtifacts = @(
    (Join-Path $ServiceOut "steel-capture-service.exe"),
    (Join-Path $ServiceOut "steel-runtime-supervisor.exe"),
    (Join-Path $ServiceOut "steel-inspection-service.exe"),
    (Join-Path $ServiceOut "steel-trigger-gateway.exe"),
    (Join-Path $ServiceOut "steel-image-service.exe"),
    (Join-Path $ServiceOut "steel-image-worker.exe"),
    (Join-Path $ServiceOut "steel-defect-worker.exe"),
    (Join-Path $ServiceOut "steel-inspection-tray.exe"),
    (Join-Path $AlgorithmCoreOut "steel_bar_surface_core.exe")
  )
  foreach ($ArtifactPath in $FirstPartyRuntimeArtifacts) {
    Assert-PeTargetMachine -Path $ArtifactPath -RustTarget ([string]$ReleasePolicy.rustTarget)
  }
  foreach ($ArtifactPath in $FirstPartyRuntimeArtifacts) {
    $Signature = Set-ReleaseAuthenticodeSignature -Path $ArtifactPath
    $RuntimeSignatureEvidence += [ordered]@{
      path = $ArtifactPath.Substring($OutRoot.Length + 1).Replace('\', '/')
      signer = [string]$Signature.SignerCertificate.Subject
      signerThumbprint = [string]$Signature.SignerCertificate.Thumbprint
      timestampSigner = [string]$Signature.TimeStamperCertificate.Subject
    }
  }
}

$ClientBuild = Join-Path $RepoRoot "target\client\frontend-dist"
if (-not (Test-Path $ClientBuild -PathType Container)) {
  throw "Missing client build directory: $ClientBuild"
}
Get-ChildItem -LiteralPath $ClientBuild -Force | Copy-Item -Destination $ClientOut -Recurse -Force

$DesktopInstallers = @()
$DesktopSignatureEvidence = @()
$VcRedistRelativePath = ""
if (-not $SkipDesktopBundle) {
  $TauriArtifactRoot = if ($FormalReleasePackage) {
    Join-Path $RepoRoot "target\cargo\$([string]$ReleasePolicy.rustTarget)\release"
  } else {
    Join-Path $RepoRoot "target\cargo\release"
  }
  $TauriBundleRoot = Join-Path $TauriArtifactRoot "bundle"
  if (-not (Test-Path -LiteralPath $TauriBundleRoot -PathType Container)) {
    throw "Missing Tauri Release bundle: $TauriBundleRoot"
  }
  New-Item -ItemType Directory -Force -Path $DesktopOut | Out-Null
  Get-ChildItem -LiteralPath $TauriBundleRoot -Force | Copy-Item -Destination $DesktopOut -Recurse -Force
  $DesktopInstallers = @(Get-ChildItem -LiteralPath $DesktopOut -Recurse -File | Where-Object { $_.Extension -in @('.msi', '.exe') })
  $MsiInstallers = @($DesktopInstallers | Where-Object { $_.Extension -eq '.msi' })
  $NsisInstallers = @($DesktopInstallers | Where-Object { $_.Extension -eq '.exe' -and $_.FullName -match '[\\/]nsis[\\/]' })
  if ($MsiInstallers.Count -ne 1 -or $NsisInstallers.Count -ne 1) {
    throw "Formal Tauri bundle must produce exactly one MSI and one NSIS installer; found MSI=$($MsiInstallers.Count), NSIS=$($NsisInstallers.Count)."
  }

  $StandaloneDesktopExe = Join-Path $TauriArtifactRoot "steel-plate-3d-inspection-tauri.exe"
  Copy-RequiredFile $StandaloneDesktopExe (Join-Path $DesktopOut "steel-plate-3d-inspection-tauri.exe")
  if ($FormalReleasePackage) {
    Assert-PeTargetMachine -Path (Join-Path $DesktopOut "steel-plate-3d-inspection-tauri.exe") -RustTarget ([string]$ReleasePolicy.rustTarget)
    $SignedDesktopArtifacts = @($DesktopInstallers) + @((Get-Item -LiteralPath (Join-Path $DesktopOut "steel-plate-3d-inspection-tauri.exe")))
    foreach ($Artifact in $SignedDesktopArtifacts) {
      $Signature = Assert-TimestampedAuthenticodeSignature -Path $Artifact.FullName -RequiredSignerThumbprint ([string]$env:TAURI_WINDOWS_CERTIFICATE_THUMBPRINT)
      $DesktopSignatureEvidence += [ordered]@{
        path = $Artifact.FullName.Substring($OutRoot.Length + 1).Replace('\', '/')
        signer = [string]$Signature.SignerCertificate.Subject
        signerThumbprint = [string]$Signature.SignerCertificate.Thumbprint
        timestampSigner = [string]$Signature.TimeStamperCertificate.Subject
      }
    }

    if ([string]::IsNullOrWhiteSpace($VcRedistPath)) {
      throw "Formal offline desktop package requires VC_REDIST_X64_PATH (or -VcRedistPath) pointing to the Microsoft-signed VC_redist.x64.exe prerequisite."
    }
    $ResolvedVcRedist = (Resolve-Path -LiteralPath $VcRedistPath -ErrorAction Stop).Path
    if ([System.IO.Path]::GetFileName($ResolvedVcRedist) -ne 'VC_redist.x64.exe') {
      throw "The VC++ prerequisite must be named VC_redist.x64.exe: $ResolvedVcRedist"
    }
    [void](Assert-TimestampedAuthenticodeSignature -Path $ResolvedVcRedist -RequiredSignerPattern '(^|, )O=Microsoft Corporation(,|$)')
    $PrerequisiteOut = Join-Path $DesktopOut "prerequisites"
    New-Item -ItemType Directory -Force -Path $PrerequisiteOut | Out-Null
    Copy-RequiredFile $ResolvedVcRedist (Join-Path $PrerequisiteOut "VC_redist.x64.exe")
    $VcRedistRelativePath = "desktop-installer/prerequisites/VC_redist.x64.exe"
  }
}

Copy-Item -LiteralPath (Join-Path $RepoRoot "config\env") -Destination $ConfigOut -Recurse -Force
Copy-RequiredFile (Join-Path $RepoRoot "config\service-registry.json") $ConfigOut
if (Test-Path (Join-Path $RepoRoot "config\capture") -PathType Container) {
  Copy-Item -LiteralPath (Join-Path $RepoRoot "config\capture") -Destination $ConfigOut -Recurse -Force
}
if (Test-Path (Join-Path $RepoRoot "config\algorithm") -PathType Container) {
  Copy-Item -LiteralPath (Join-Path $RepoRoot "config\algorithm") -Destination $ConfigOut -Recurse -Force
}
if (Test-Path (Join-Path $RepoRoot "config\acceptance") -PathType Container) {
  Copy-Item -LiteralPath (Join-Path $RepoRoot "config\acceptance") -Destination $ConfigOut -Recurse -Force
}
if (Test-Path (Join-Path $RepoRoot "config\sites\sick-array-6") -PathType Container) {
  New-Item -ItemType Directory -Force -Path (Join-Path $ConfigOut "sites") | Out-Null
  Copy-Item -LiteralPath (Join-Path $RepoRoot "config\sites\sick-array-6") -Destination (Join-Path $ConfigOut "sites") -Recurse -Force
}
if (Test-Path (Join-Path $RepoRoot "models") -PathType Container) {
  Copy-Item -LiteralPath (Join-Path $RepoRoot "models") -Destination $OutRoot -Recurse -Force
}
if (Test-Path (Join-Path $RepoRoot "packages\contracts") -PathType Container) {
  New-Item -ItemType Directory -Force -Path (Join-Path $OutRoot "contracts") | Out-Null
  Copy-Item -LiteralPath (Join-Path $RepoRoot "packages\contracts\schemas") -Destination (Join-Path $OutRoot "contracts") -Recurse -Force
}
Copy-Item -Path (Join-Path $RepoRoot "app\runtime-icons\*") -Destination $RuntimeIconsOut -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "docs\independent-architecture.md") -Destination $DocsOut -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "docs\runtime-boundaries-v2.md") -Destination $DocsOut -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "docs\capture-api-contract.md") -Destination $DocsOut -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "docs\integrated-capture-management-acceptance.md") -Destination $DocsOut -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "docs\qt-to-tauri-migration.md") -Destination $DocsOut -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "docs\release-deployment-and-operations.md") -Destination $DocsOut -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "docs\production-readiness-gap-and-closure-design.md") -Destination $DocsOut -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "docs\atomic-upgrade-and-database-migration-design.md") -Destination $DocsOut -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "scripts\README.md") -Destination $ScriptsOut -Force
Copy-RequiredFile (Join-Path $RepoRoot "scripts\run-client-static.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-capture-api.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-capture-continuous.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-integrated-management-smoke.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-trigger-gateway-security.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-integrated-runtime-ready.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-integrated-capture-management-full.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-integrated-acceptance-audit.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-architecture-migration-contract.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-runtime-acceptance.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-runtime-layout.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\verify-independent-architecture.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\verify-runtime-package.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\verify-packaged-release-sbom.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-runtime-supervisor.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-algorithm-acceptance-report.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-functional-go-live-readiness.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\new-functional-scenario-evidence.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\new-functional-acceptance-workspace.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-functional-acceptance-workspace-contract.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\add-functional-scenario-evidence.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-functional-scenario-attachment-contract.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test_algorithm_traceability.py") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "scripts\install-runtime-service.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\uninstall-runtime-service.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-runtime-ui-smoke.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-real-hardware-acceptance.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-real-calibration-acceptance.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-real-calibration-crash-recovery.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-real-calibration-integrity-generation.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-production-stability.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-production-stability-workroot-contract.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\backup-database.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\restore-database.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\manage-report-archives.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-report-archive-recovery.ps1") $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\database-recovery-common.ps1") $OutRoot
Copy-RequiredFile $DatabaseContractVerifier $OutRoot
Copy-RequiredFile $DatabaseContractTest $OutRoot
Copy-RequiredFile (Join-Path $RepoRoot "scripts\bar_surface_reconstruct.py") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "scripts\fit_array_calibration_cross_section.py") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "scripts\test-bar-surface-e2e.ps1") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "scripts\build-algorithm-core.ps1") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "scripts\sick_capture_service.py") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "scripts\sick_flow_analysis_service.py") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "scripts\sick_capture_requirements.txt") $ScriptsOut
Copy-RequiredFile (Join-Path $RepoRoot "scripts\requirements-sick-defect.txt") $ScriptsOut
Copy-Item -LiteralPath (Join-Path $RepoRoot "scripts\sick_capture") -Destination $ScriptsOut -Recurse -Force

Write-PackageFile "run-capture-headless.ps1" @'
param(
  [int]$Port = 4317,
  [Parameter(Mandatory = $true)]
  [string]$CaptureProfile,
  [Parameter(Mandatory = $true)]
  [string]$PythonExecutable
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "service\steel-capture-service.exe"

if (-not (Test-Path $Exe -PathType Leaf)) {
  throw "Missing capture executable: $Exe"
}

$env:STEEL_CAPTURE_SERVICE_PORT = [string]$Port
$env:STEEL_SICK_CAPTURE_PROFILE = (Resolve-Path -LiteralPath $CaptureProfile).Path
$env:STEEL_PYTHON_EXECUTABLE = (Resolve-Path -LiteralPath $PythonExecutable).Path
$env:STEEL_SICK_CAPTURE_SCRIPT = Join-Path $Root "scripts\sick_capture_service.py"

Push-Location (Split-Path -Parent $Exe)
try {
  & $Exe
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
'@

Write-PackageFile "run-service-external.ps1" @'
param(
  [int]$Port = 4873,
  [string]$CaptureOrigin = "http://127.0.0.1:4317",
  [string]$TriggerOrigin = "http://127.0.0.1:4881",
  [string]$ConfigRoot = "",
  [Parameter(Mandatory = $true)]
  [string]$ArtifactAllowedRoots
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "service\steel-inspection-service.exe"

if (-not (Test-Path $Exe -PathType Leaf)) {
  throw "Missing service executable: $Exe"
}

$env:INSPECTION_SERVICE_HOST = "0.0.0.0"
$env:INSPECTION_SERVICE_PORT = [string]$Port
$env:STEEL_CAPTURE_PROVIDER = "external-api"
$env:CAPTURE_SERVICE_ORIGIN = $CaptureOrigin
$env:TRIGGER_GATEWAY_ORIGIN = $TriggerOrigin
$env:STEEL_CAPTURE_SERVICE_AUTOSTART = "0"
$env:STEEL_RUNTIME_PROFILE = "production"
$env:STEEL_ALGORITHM_MODE = "production"
$env:BAR_SURFACE_MOCK_DEFECT_COUNT = "0"
$env:STEEL_TRIGGER_HEALTH_REQUIRED = "1"
$env:STEEL_STORAGE_MIN_FREE_BYTES = "21474836480"
$env:STEEL_STORAGE_MIN_FREE_PERCENT = "10"
$env:STEEL_ARTIFACT_ALLOWED_ROOTS = $ArtifactAllowedRoots
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

Write-PackageFile "run-service-managed.ps1" @'
param(
  [int]$Port = 4873,
  [int]$CapturePort = 4317,
  [string]$TriggerOrigin = "http://127.0.0.1:4881",
  [Parameter(Mandatory = $true)]
  [string]$CaptureProfile,
  [Parameter(Mandatory = $true)]
  [string]$PythonExecutable,
  [string]$ConfigRoot = "",
  [Parameter(Mandatory = $true)]
  [string]$ArtifactAllowedRoots
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "service\steel-inspection-service.exe"
$CaptureExe = Join-Path $Root "service\steel-capture-service.exe"
if (-not (Test-Path $Exe -PathType Leaf)) { throw "Missing service executable: $Exe" }
if (-not (Test-Path $CaptureExe -PathType Leaf)) { throw "Missing capture executable: $CaptureExe" }

$env:INSPECTION_SERVICE_HOST = "0.0.0.0"
$env:INSPECTION_SERVICE_PORT = [string]$Port
$env:STEEL_CAPTURE_PROVIDER = "external-api"
$env:CAPTURE_SERVICE_ORIGIN = "http://127.0.0.1:$CapturePort"
$env:STEEL_CAPTURE_SERVICE_AUTOSTART = "1"
$env:STEEL_CAPTURE_SERVICE_EXE = $CaptureExe
$env:STEEL_CAPTURE_RESTART_BUDGET = "5"
$env:STEEL_CAPTURE_RESTART_BACKOFF_MS = "1000"
$env:STEEL_CAPTURE_READY_TIMEOUT_MS = "15000"
$env:STEEL_SICK_CAPTURE_PROFILE = (Resolve-Path -LiteralPath $CaptureProfile).Path
$env:STEEL_PYTHON_EXECUTABLE = (Resolve-Path -LiteralPath $PythonExecutable).Path
$env:STEEL_SICK_CAPTURE_SCRIPT = Join-Path $Root "scripts\sick_capture_service.py"
$env:CAPTURE_CONFIG_ROOT = Join-Path $Root "config\capture"
$env:TRIGGER_GATEWAY_ORIGIN = $TriggerOrigin
$env:STEEL_RUNTIME_PROFILE = "production"
$env:STEEL_ALGORITHM_MODE = "production"
$env:BAR_SURFACE_MOCK_DEFECT_COUNT = "0"
$env:STEEL_TRIGGER_HEALTH_REQUIRED = "1"
$env:STEEL_STORAGE_MIN_FREE_BYTES = "21474836480"
$env:STEEL_STORAGE_MIN_FREE_PERCENT = "10"
$env:STEEL_ARTIFACT_ALLOWED_ROOTS = $ArtifactAllowedRoots
$env:STEEL_WORKSPACE_ROOT = $Root
$env:STEEL_BAR_SURFACE_CORE_EXE = Join-Path $Root "algorithm-core\steel_bar_surface_core.exe"
if ([string]::IsNullOrWhiteSpace($ConfigRoot)) {
  $ConfigRoot = Join-Path $Root "config\service"
}
$env:STEEL_SERVICE_CONFIG_DIR = $ConfigRoot
New-Item -ItemType Directory -Force -Path $env:STEEL_SERVICE_CONFIG_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $env:CAPTURE_CONFIG_ROOT | Out-Null

& $Exe
exit $LASTEXITCODE
'@

Write-PackageFile "run-service-simulated.ps1" @'
param(
  [int]$Port = 4873,
  [string]$ConfigRoot = "",
  [string]$TriggerOrigin = "http://127.0.0.1:4881",
  [ValidateSet("development", "acceptance")]
  [string]$RuntimeProfile = "development",
  [ValidateSet("demo", "validation")]
  [string]$AlgorithmMode = "demo"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "service\steel-inspection-service.exe"

if (-not (Test-Path $Exe -PathType Leaf)) {
  throw "Missing service executable: $Exe"
}

$env:INSPECTION_SERVICE_HOST = "0.0.0.0"
$env:INSPECTION_SERVICE_PORT = [string]$Port
$env:STEEL_CAPTURE_PROVIDER = "simulated"
$env:STEEL_CAPTURE_SERVICE_AUTOSTART = "0"
$env:TRIGGER_GATEWAY_ORIGIN = $TriggerOrigin
$env:STEEL_RUNTIME_PROFILE = $RuntimeProfile
$env:STEEL_ALGORITHM_MODE = $AlgorithmMode
$env:STEEL_MOCK_DEFECT_COUNT = "0"
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
  [int]$TcpPort = 4882,
  [int]$UdpPort = 4883,
  [string]$HostAddress = "127.0.0.1",
  [string]$InspectionServiceOrigin = "http://127.0.0.1:4873",
  [ValidateSet("api", "tcp", "udp", "gray", "secondary", "manual")]
  [string]$Mode = "api",
  [ValidateSet("development", "acceptance", "production")]
  [string]$RuntimeProfile = "production",
  [string]$SourceAllowlist = "",
  [switch]$AllowModeMutation
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "service\steel-trigger-gateway.exe"

if (-not (Test-Path $Exe -PathType Leaf)) {
  throw "Missing trigger gateway executable: $Exe"
}

$env:TRIGGER_GATEWAY_PORT = [string]$Port
$env:TRIGGER_TCP_PORT = [string]$TcpPort
$env:TRIGGER_UDP_PORT = [string]$UdpPort
$env:TRIGGER_GATEWAY_HOST = $HostAddress
$env:INSPECTION_SERVICE_ORIGIN = $InspectionServiceOrigin
$env:TRIGGER_MODE = $Mode
$env:STEEL_RUNTIME_PROFILE = $RuntimeProfile
$env:TRIGGER_SOURCE_ALLOWLIST = $SourceAllowlist
$env:TRIGGER_ALLOW_MODE_MUTATION = if ($AllowModeMutation) { "1" } else { "0" }

& $Exe
exit $LASTEXITCODE
'@

Write-PackageFile "run-integrated-capture-management.ps1" @'
param(
  [int]$CapturePort = 4317,
  [int]$ServicePort = 4873,
  [int]$TriggerPort = 4881,
  [int]$ClientPort = 1432,
  [Parameter(Mandatory = $true)]
  [string]$CaptureProfile,
  [Parameter(Mandatory = $true)]
  [string]$PythonExecutable,
  [Parameter(Mandatory = $true)]
  [string]$ArtifactAllowedRoots,
  [ValidateSet("api", "tcp", "udp", "gray", "secondary", "manual")]
  [string]$TriggerMode = "manual",
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

$CaptureProfile = (Resolve-Path -LiteralPath $CaptureProfile).Path
$PythonExecutable = (Resolve-Path -LiteralPath $PythonExecutable).Path
$CaptureProfilePayload = Get-Content -LiteralPath $CaptureProfile -Raw | ConvertFrom-Json
$ServiceScript = Join-Path $Root "run-service-managed.ps1"
$TriggerScript = Join-Path $Root "run-trigger-gateway.ps1"

if (-not (Test-LocalTcpPort -Port $ServicePort)) {
  Start-PackageScript -Name "service" -ScriptPath $ServiceScript -Arguments @("-Port", [string]$ServicePort, "-CapturePort", [string]$CapturePort, "-TriggerOrigin", "http://127.0.0.1:$TriggerPort", "-CaptureProfile", $CaptureProfile, "-PythonExecutable", $PythonExecutable, "-ArtifactAllowedRoots", $ArtifactAllowedRoots)
} else {
  Write-Host "Rust service already listening on port $ServicePort."
}
$CaptureLifecycle = Wait-HttpJson -Name "Managed capture lifecycle" -Uri "http://127.0.0.1:$ServicePort/api/capture/lifecycle" -TimeoutSec 30
if ([string]$CaptureLifecycle.lifecycle.phase -ne "ready") {
  throw "Managed capture lifecycle is '$($CaptureLifecycle.lifecycle.phase)': $($CaptureLifecycle.lifecycle.lastError)"
}
$CaptureHealth = Wait-HttpJson -Name "Capture provider" -Uri "http://127.0.0.1:$CapturePort/health" -TimeoutSec 30
$ExpectedCaptureConfigRoot = Split-Path -Parent $CaptureProfile
Assert-CaptureProviderMatches -Health $CaptureHealth -ExpectedStorageRoot ([string]$CaptureProfilePayload.storageRoot) -ExpectedConfigRoot $ExpectedCaptureConfigRoot
Write-Host ("Managed capture ready: sdkReady={0}, cameraCount={1}" -f $CaptureHealth.sdkReady, $CaptureHealth.cameraCount)
$ProductionStatus = Wait-HttpJson -Name "Rust service" -Uri "http://127.0.0.1:$ServicePort/api/production/status" -TimeoutSec 30
Write-Host ("Service ready: production code={0}" -f $ProductionStatus.code)

if (-not (Test-LocalTcpPort -Port $TriggerPort)) {
  Start-PackageScript -Name "trigger-gateway" -ScriptPath $TriggerScript -Arguments @("-Port", [string]$TriggerPort, "-InspectionServiceOrigin", "http://127.0.0.1:$ServicePort", "-Mode", $TriggerMode)
} else {
  Write-Host "Trigger gateway already listening on port $TriggerPort."
}
$TriggerStatus = Wait-HttpJson -Name "Trigger gateway" -Uri "http://127.0.0.1:$TriggerPort/api/trigger/status" -TimeoutSec 30
Write-Host ("Trigger gateway ready: mode={0}, manualAllowed={1}" -f $TriggerStatus.mode, $TriggerStatus.manualAllowed)

$ClientUrl = "http://127.0.0.1:$ServicePort/?app=terminal"
Wait-HttpHtml -Name "Service-hosted client" -Uri $ClientUrl -TimeoutSec 30 | Out-Null
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
  [int[]]$Ports = @(4317, 4873, 4874, 4875, 4876, 4881, 1432)
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
  "steel-capture-service",
  "steel-image-service",
  "steel-image-worker",
  "steel-defect-worker"
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

- `service/steel-capture-service.exe`: the only formal SICK camera process host; it owns the GenTL sidecar lifecycle.
- `service/`: Rust runtime executables.
- `service/steel-trigger-gateway.exe`: standalone L2/PLC/API trigger gateway.
- `service/steel-image-service.exe`: loopback Rust image decode, preview and tile service.
- `service/steel-image-worker.exe`: real-camera alignment, measurement and surface reconstruction worker.
- `service/steel-defect-worker.exe`: real-camera defect inference and evidence worker.
- `service/steel-inspection-tray.exe`: per-user Windows task-tray companion for SCM controls.
- `client/`: built frontend files.
- `config/env/`: environment templates.
- `docs/`: architecture and API documentation copied from the source tree.

## Start the Runtime Supervisor

```powershell
.\service\steel-runtime-supervisor.exe --service --root . --state-root <StateRoot>
```

The Supervisor starts Artifact, Image Worker, Defect Worker, SICK Capture, Business, and Trigger processes in order and stops them in reverse order. The business service is proxy-only in production and exposes:

```text
http://127.0.0.1:4873/api/capture/lifecycle
http://127.0.0.1:4873/api/capture/health
http://127.0.0.1:4873/api/cameras
```

## One-Command Integrated Startup

The packaged trigger gateway defaults to `STEEL_RUNTIME_PROFILE=production`. Inject different values for `TRIGGER_SHARED_SECRET` and `TRIGGER_OPERATOR_TOKEN`, each with at least 32 random bytes, through the service manager before starting it; a non-loopback bind also requires `TRIGGER_SOURCE_ALLOWLIST`. The shared secret authenticates PLC/L2 traffic, while the operator token is only for the loopback Rust-to-gateway hop. Production mode mutation is locked unless an explicitly approved maintenance run passes `-AllowModeMutation`.

```powershell
.\run-integrated-capture-management.ps1 -CaptureProfile D:\site\sick-capture.json -PythonExecutable D:\python\python.exe -ArtifactAllowedRoots "D:\steel-sick-data;E:\steel-sick-data;F:\steel-sick-data;G:\steel-sick-data;H:\steel-sick-data" -TriggerMode manual -OpenBrowser
```

This starts Rust (which owns the capture child and serves the web client) and the trigger gateway, then waits for:

```text
http://127.0.0.1:4317/health
http://127.0.0.1:4873/api/production/status
http://127.0.0.1:4881/api/trigger/status
http://127.0.0.1:4873/?app=terminal
```

The integrated startup always uses the headless C++ capture provider and Tauri/React operator client.
Use `-StopExisting` to first stop known project executables and listeners on the selected ports.

## Run Without Cameras

```powershell
.\run-service-simulated.ps1 -Port 4873
```

## Integrated Smoke Test

```powershell
.\test-integrated-management-smoke.ps1
```

This starts the simulated Rust service, standalone trigger gateway, and static client on temporary ports. It verifies the manual-mode guard, steel-info, steel-in, record-before-capture flow, steel-out, and the built terminal page. It does not require cameras.

## Trigger Security Gate

```powershell
.\test-trigger-gateway-security.ps1
```

This isolated production-mode test verifies missing-secret startup failure, HMAC-SHA256 acceptance and replay rejection on HTTP/TCP/UDP, source policy, mode locking, status redaction, and absence of wildcard CORS.

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

Read-only live stack and eight-camera storage checks:

```powershell
.\test-real-hardware-acceptance.ps1
```

Run one real production capture round through the Rust service after the real capture provider is connected:

```powershell
.\test-real-hardware-acceptance.ps1 -RunCapture
```

Run the authenticated calibration dry-run with a reviewed eight-camera plan. Add the mutation switch and exact phrase only during the approved apply/rollback window:

```powershell
.\test-real-calibration-acceptance.ps1 -PlanPath C:\maintenance\eight-camera-calibration-plan.json -AdminToken $adminToken
.\test-real-calibration-acceptance.ps1 -PlanPath C:\maintenance\eight-camera-calibration-plan.json -AdminToken $adminToken -RunApplyRollback -SafetyConfirmation "RUN REAL EIGHT CAMERA CALIBRATION APPLY AND ROLLBACK"
```

Run the controlled process-crash drill separately for `ApplyCrash` and `RollbackCrash`; clear all crash environment variables and restart the provider before each Resume phase:

```powershell
.\test-real-calibration-crash-recovery.ps1 -Mode Prepare -Scenario ApplyCrash -PlanPath C:\maintenance\eight-camera-calibration-plan.json -AdminToken $adminToken -SafetyConfirmation "RUN CONTROLLED CALIBRATION PROCESS CRASH RECOVERY"
.\test-real-calibration-crash-recovery.ps1 -Mode Resume -StatePath .\logs\real-calibration-crash-recovery\active-calibration-crash-drill.json -AdminToken $adminToken -SafetyConfirmation "RUN CONTROLLED CALIBRATION PROCESS CRASH RECOVERY"
```

Run the real stale-generation and staged-hash zero-write drill:

```powershell
.\test-real-calibration-integrity-generation.ps1 -PlanPath C:\maintenance\eight-camera-calibration-plan.json -AdminToken $adminToken -SafetyConfirmation "RUN REAL CALIBRATION INTEGRITY AND GENERATION DRILL"
```

Run repeated production in/out steel cycles for stability. Use `-MaxCycles` for a short acceptance check, or `-DurationSec 600` for a ten-minute soak. `-RunAlgorithmEvery` optionally runs 3D reconstruction every N cycles.

```powershell
.\test-production-stability.ps1 -MaxCycles 2
.\test-production-stability.ps1 -DurationSec 600 -RunAlgorithmEvery 10
```

## Functional Go/No-Go

Copy and complete the three templates under `config\acceptance`, bind the real evidence paths in the plan, then run:

```powershell
.\new-functional-acceptance-workspace.ps1 -ReleaseManifestPath .\manifest.json -WorkspaceRoot D:\steel-acceptance\release-1.2.3 -Line line-1 -Plc plc-1 -L2 l2-1 -TargetMachine ipc-01
.\test-functional-go-live-readiness.ps1 -PlanPath D:\steel-acceptance\release-1.2.3\functional-go-live-plan.json -ReportDir D:\steel-acceptance\release-1.2.3\10-signoff
```

This decision is intentionally functional-only. It requires an exact release identity, a passing real labeled algorithm audit, an unskipped real eight-camera 24/24 report, real PLC/L2 scenario evidence, one complete real production-shift soak, and clean target-machine lifecycle evidence. Security, signing, and supply-chain status are recorded elsewhere and are not part of this functional decision.

The initializer creates a new release-bound evidence workspace and refuses to reuse a populated directory. The packaged `config\acceptance` files remain reference templates.

Create each scenario evidence JSON from its raw log:

```powershell
.\new-functional-scenario-evidence.ps1 -ReleaseManifestPath .\manifest.json -ScenarioId service-restart -SourceSystem PLC-L2-line-1 -CommandOrProcedure "Restart service and verify recovery" -RawLogPath D:\steel-acceptance\03-plc-l2\raw\service-restart.log -OutputPath D:\steel-acceptance\03-plc-l2\evidence\service-restart.json
```

The returned path/SHA-256 reference goes into the PLC/L2 or target-machine report. The final gate rechecks the evidence semantics, candidate manifest hash, and original raw-log hash.

Inside an initialized workspace, prefer the atomic attachment command after setting the report execution window and placing the raw log in its `raw` directory:

```powershell
.\add-functional-scenario-evidence.ps1 -WorkspaceRoot D:\steel-acceptance\release-1.2.3 -Scope plc-l2 -ScenarioId service-restart -SourceSystem PLC-L2-line-1 -CommandOrProcedure "Restart service and verify recovery" -RawLogPath D:\steel-acceptance\release-1.2.3\03-plc-l2\raw\service-restart.log -ObservedAt 2026-07-16T10:15:00+08:00
```

It atomically updates the one matching scenario, rejects duplicate or out-of-window evidence, and freezes all later evidence mutations after approval.

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

This writes one combined report for runtime layout, live readiness, eight-camera hardware/storage checks, calibration recovery, and UI smoke. `-RequireFullCoverage` requires real calibration apply/rollback, successful ApplyCrash and RollbackCrash Resume reports, and the integrity/generation report.

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

The `client/` folder contains the built web assets. The Rust service serves this folder on its own origin by default:

```powershell
.\run-integrated-capture-management.ps1 -CaptureProfile D:\site\sick-capture.json -PythonExecutable D:\python\python.exe -ArtifactAllowedRoots "D:\steel-sick-data;E:\steel-sick-data;F:\steel-sick-data;G:\steel-sick-data;H:\steel-sick-data"
```

Then open:

```text
http://127.0.0.1:4873/
```

The web client uses the current HTTP/HTTPS page origin, so it needs no separate IP or UI-port configuration. `run-client-static.ps1` is retained only as a compatibility tool.

## Stop Processes

```powershell
.\stop-runtime.ps1
```

This stops the known C++/Rust executables and listeners on ports `4317`, `4873`, `4881`, and `1432`, including the PowerShell static client server. Use `-Ports` if the stack was started on custom ports.

## Auto-Connect And Continuous Capture Test

With either capture provider running:

```powershell
.\test-capture-api.ps1 -Origin http://127.0.0.1:4317 -ExpectedCameras 8
```

```powershell
.\test-capture-continuous.ps1 -Origin http://127.0.0.1:4317 -ExpectedCameras 8 -Rounds 3 -IntervalMs 500
```
'@

$Manifest = [ordered]@{
  schema = "steel.runtime-package.v1"
  name = "steel-inspection-runtime"
  packageClass = $PackageClass
  releaseVersion = $ReleaseVersion
  createdAt = (Get-Date).ToString("o")
  source = @{
    gitCommit = $SourceCommit
    gitTag = if ($ReleaseTag.Count -eq 1) { [string]$ReleaseTag[0] } else { "" }
    dirty = $SourceStatus.Count -gt 0
  }
  integrity = @{
    algorithm = if ($FormalReleasePackage) { "windows-file-catalog-sha256" } else { "checksums-only-engineering" }
    catalog = $IntegrityCatalogRelativePath
    catalogVersion = if ($FormalReleasePackage) { 2 } else { 0 }
    timestampRequired = $FormalReleasePackage
    checksumAlgorithm = "sha256"
    checksumInventory = "checksums.sha256"
    checksumExcludes = if ($FormalReleasePackage) { @("checksums.sha256", "release-integrity.cat") } else { @("checksums.sha256") }
  }
  build = @{
    performed = -not $SkipBuild
    provenance = if ($SkipBuild) { "prebuilt-engineering-only" } else { "built-in-this-invocation" }
    sourceCommit = $SourceCommit
    startedAt = $BuildStartedAt
    completedAt = (Get-Date).ToUniversalTime().ToString("o")
    dependencyInstall = if ($FormalReleasePackage) { "npm-ci" } else { "preexisting-engineering" }
    dependencyLocks = $DependencyLockEvidence
    captureBuild = @{
      root = $CaptureBuildRoot.Substring($RepoBoundary.Length + 1).Replace('\', '/')
      configuration = $Configuration
    }
    tauriConfig = @{
      path = $TauriConfigEvidencePath.Substring($OutRoot.Length + 1).Replace('\', '/')
      sha256 = $TauriConfigEvidenceHash
    }
    tauriCargo = @{
      path = $TauriCargoEvidencePath.Substring($OutRoot.Length + 1).Replace('\', '/')
      sha256 = $TauriCargoEvidenceHash
    }
    cargoConfig = @{
      path = $CargoConfigEvidencePath.Substring($OutRoot.Length + 1).Replace('\', '/')
      sha256 = $CargoConfigEvidenceHash
    }
    releasePolicy = @{
      path = $ReleasePolicyEvidencePath.Substring($OutRoot.Length + 1).Replace('\', '/')
      sha256 = $ReleasePolicyEvidenceHash
    }
    bundleToolchain = @{
      path = if ($FormalReleasePackage) { $BundleToolchainEvidencePath.Substring($OutRoot.Length + 1).Replace('\', '/') } else { "" }
      sha256 = $BundleToolchainEvidenceHash
      schema = if ($FormalReleasePackage) { [string]$BundleToolchainManifest.schema } else { "" }
      tauriCliVersion = if ($FormalReleasePackage) { [string]$BundleToolchainManifest.tauriCliVersion } else { "" }
      rustTarget = if ($FormalReleasePackage) { [string]$BundleToolchainManifest.rustTarget } else { "" }
      componentCount = if ($FormalReleasePackage) { @($BundleToolchainManifest.components).Count } else { 0 }
      fileCount = if ($FormalReleasePackage) { @($BundleToolchainManifest.files).Count } else { 0 }
    }
    tauriFeatureResolution = @{
      path = if ($FormalReleasePackage) { $TauriFeatureEvidencePath.Substring($OutRoot.Length + 1).Replace('\', '/') } else { "" }
      sha256 = $TauriFeatureEvidenceHash
    }
    captureConfiguration = $Configuration
    rustProfile = $ServiceProfile
    desktopBundleIncluded = -not $SkipDesktopBundle
    desktopInstallerCount = $DesktopInstallers.Count
  }
  sbom = $ReleaseSbomManifest
  desktop = @{
    version = $ReleaseVersion
    publisher = [string]$TauriConfig.bundle.publisher
    rustTarget = if ($FormalReleasePackage) { [string]$ReleasePolicy.rustTarget } else { "" }
    targets = @($TauriConfig.bundle.targets)
    allowDowngrades = [bool]$TauriConfig.bundle.windows.allowDowngrades
    nsisInstallMode = [string]$TauriConfig.bundle.windows.nsis.installMode
    webView2InstallMode = if ($SkipDesktopBundle) { "not-bundled" } else { [string]$TauriConfig.bundle.windows.webviewInstallMode.type }
    installers = if ($SkipDesktopBundle) { @() } else { @($DesktopInstallers | ForEach-Object { $_.FullName.Substring($OutRoot.Length + 1).Replace('\', '/') }) }
    vcRuntimePrerequisite = $VcRedistRelativePath
    signatures = $DesktopSignatureEvidence
    timestampRequired = $FormalReleasePackage
  }
  formalCapture = "sick-gentl"
  capture = @{
    path = "service/steel-capture-service.exe"
    sdk = "external-sick-gentl-cti"
    role = "only-formal-camera-owner"
  }
  service = @{
    path = "service/steel-inspection-service.exe"
    triggerGateway = "service/steel-trigger-gateway.exe"
    supervisor = "service/steel-runtime-supervisor.exe"
    image = "service/steel-image-service.exe"
    capture = "service/steel-capture-service.exe"
    imageWorker = "service/steel-image-worker.exe"
    defectWorker = "service/steel-defect-worker.exe"
    tray = "service/steel-inspection-tray.exe"
    windowsServiceName = "SteelInspectionRuntime"
    profile = $ServiceProfile
    signatures = $RuntimeSignatureEvidence
  }
  client = @{
    path = "client/index.html"
    desktopInstallers = if ($SkipDesktopBundle) { @() } else { @($DesktopInstallers | ForEach-Object { $_.FullName.Substring($OutRoot.Length + 1).Replace('\', '/') }) }
  }
  algorithm = @{
    core = "algorithm-core/steel_bar_surface_core.exe"
    imageWorker = "service/steel-image-worker.exe"
    defectWorker = "service/steel-defect-worker.exe"
    resultSchema = "steel.inspection-result.v1"
    resultRoot = "state-root/result-data"
    scripts = "scripts"
  }
  config = @{
    envTemplates = "config/env"
    algorithm = "config/algorithm/bar-surface-production.json"
    algorithmAcceptanceTemplate = "config/algorithm/acceptance-report.example.json"
    functionalGoLivePlanTemplate = "config/acceptance/functional-go-live-plan.example.json"
    plcL2FunctionalAcceptanceTemplate = "config/acceptance/plc-l2-functional-acceptance.example.json"
    targetMachineFunctionalAcceptanceTemplate = "config/acceptance/target-machine-functional-acceptance.example.json"
    functionalScenarioEvidenceTemplate = "config/acceptance/functional-scenario-evidence.example.json"
  }
  database = [ordered]@{
    contractPath = "database/contract.json"
    contractSha256 = $PackagedDatabaseContractHash
    contractSchema = [string]$DatabaseContract.contractSchema
    schemaVersion = [int]$DatabaseContract.schemaVersion
    minUpgradeableSchemaVersion = [int]$DatabaseContract.minUpgradeableSchemaVersion
    maxUpgradeableSchemaVersion = [int]$DatabaseContract.maxUpgradeableSchemaVersion
    minReadableSchemaVersion = [int]$DatabaseContract.minReadableSchemaVersion
    maxReadableSchemaVersion = [int]$DatabaseContract.maxReadableSchemaVersion
    rollbackReadableThrough = [int]$DatabaseContract.rollbackReadableThrough
    engines = @($DatabaseContract.engines)
    migrationIndex = [string]$DatabaseContract.migrationIndex
    migrationIndexSha256 = $PackagedDatabaseMigrationIndexHash
    stateLayoutVersion = [int]$DatabaseContract.stateLayoutVersion
  }
  migrationArchitecture = $MigrationArchitecture
  scripts = @{
    captureHeadless = "run-capture-headless.ps1"
    serviceExternal = "run-service-external.ps1"
    serviceManaged = "run-service-managed.ps1"
    serviceSimulated = "run-service-simulated.ps1"
    triggerGateway = "run-trigger-gateway.ps1"
    integrated = "run-integrated-capture-management.ps1"
    clientStatic = "run-client-static.ps1"
    captureApiTest = "test-capture-api.ps1"
    continuousCaptureTest = "test-capture-continuous.ps1"
    integratedFullAcceptanceTest = "test-integrated-capture-management-full.ps1"
    integratedAcceptanceAuditTest = "test-integrated-acceptance-audit.ps1"
    migrationArchitectureTest = "test-architecture-migration-contract.ps1"
    integratedSmokeTest = "test-integrated-management-smoke.ps1"
    triggerSecurityTest = "test-trigger-gateway-security.ps1"
    integratedReadyTest = "test-integrated-runtime-ready.ps1"
    runtimeAcceptanceTest = "test-runtime-acceptance.ps1"
    runtimeLayoutTest = "test-runtime-layout.ps1"
    runtimePackageVerify = "verify-runtime-package.ps1"
    releaseSbomStaticVerify = "verify-packaged-release-sbom.ps1"
    runtimeSupervisorTest = "test-runtime-supervisor.ps1"
    algorithmAcceptanceTest = "test-algorithm-acceptance-report.ps1"
    functionalGoLiveReadinessTest = "test-functional-go-live-readiness.ps1"
    functionalScenarioEvidenceGenerator = "new-functional-scenario-evidence.ps1"
    functionalAcceptanceWorkspaceInitializer = "new-functional-acceptance-workspace.ps1"
    functionalAcceptanceWorkspaceContractTest = "test-functional-acceptance-workspace-contract.ps1"
    functionalScenarioEvidenceAttacher = "add-functional-scenario-evidence.ps1"
    functionalScenarioAttachmentContractTest = "test-functional-scenario-attachment-contract.ps1"
    algorithmTraceabilityTest = "scripts/test_algorithm_traceability.py"
    installRuntimeService = "install-runtime-service.ps1"
    uninstallRuntimeService = "uninstall-runtime-service.ps1"
    runtimeUiSmokeTest = "test-runtime-ui-smoke.ps1"
    realHardwareAcceptanceTest = "test-real-hardware-acceptance.ps1"
    realCalibrationAcceptanceTest = "test-real-calibration-acceptance.ps1"
    realCalibrationCrashRecoveryTest = "test-real-calibration-crash-recovery.ps1"
    realCalibrationIntegrityGenerationTest = "test-real-calibration-integrity-generation.ps1"
    productionStabilityTest = "test-production-stability.ps1"
    productionStabilityWorkRootContractTest = "test-production-stability-workroot-contract.ps1"
    databaseBackup = "backup-database.ps1"
    databaseRestore = "restore-database.ps1"
    reportArchiveRecovery = "manage-report-archives.ps1"
    reportArchiveRecoveryTest = "test-report-archive-recovery.ps1"
    databaseRecoveryCommon = "database-recovery-common.ps1"
    databaseContractVerify = "verify-database-migration-contract.ps1"
    databaseContractTest = "test-database-migration-contract.ps1"
    barSurfaceE2ETest = "scripts/test-bar-surface-e2e.ps1"
    stop = "stop-runtime.ps1"
  }
  docs = @{
    readme = "README.md"
    sourceDocs = "docs"
  }
}

Assert-FormalSourceStillClean
$Manifest | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $OutRoot "manifest.json") -Encoding UTF8

$PackagedSbomStaticArguments = @{
  PackageDir = $OutRoot
  ManifestPath = (Join-Path $OutRoot "manifest.json")
}
if ($FormalReleasePackage) {
  $PackagedSbomStaticArguments.ExpectedExternalComponentsSha256 = $ExpectedExternalComponentsSha256
} else {
  $PackagedSbomStaticArguments.Engineering = $true
}
$PackagedSbomStaticReportText = (& (Join-Path $RepoRoot "scripts\verify-packaged-release-sbom.ps1") @PackagedSbomStaticArguments | Out-String)
$PackagedSbomStaticReport = $PackagedSbomStaticReportText | ConvertFrom-Json
if ($PackagedSbomStaticReport.code -ne 0 -or
    [string]$PackagedSbomStaticReport.schema -cne 'steel.packaged-release-sbom-verification.v1') {
  throw "Packaged runtime failed static release SBOM verification."
}

Invoke-Checked "powershell" @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  (Join-Path $RepoRoot "scripts\test-runtime-layout.ps1"),
  "-RuntimeRoot",
  $OutRoot
)

$ChecksumPath = Join-Path $OutRoot "checksums.sha256"
$ChecksumLines = Get-ChildItem -LiteralPath $OutRoot -Recurse -File |
  Where-Object { $_.FullName -ne $ChecksumPath } |
  Sort-Object FullName |
  ForEach-Object {
    $Relative = $_.FullName.Substring($OutRoot.Length + 1).Replace('\', '/')
    $Hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$Hash  $Relative"
  }
$ChecksumLines | Set-Content -LiteralPath $ChecksumPath -Encoding ascii

if ($FormalReleasePackage) {
  $TemporaryCatalog = Join-Path ([System.IO.Path]::GetTempPath()) ("steel-runtime-" + [Guid]::NewGuid().ToString("N") + ".cat")
  try {
    New-FileCatalog -Path $OutRoot -CatalogFilePath $TemporaryCatalog -CatalogVersion 2.0 | Out-Null
    $CatalogSignature = Set-AuthenticodeSignature -LiteralPath $TemporaryCatalog -Certificate $ReleaseCertificate -TimestampServer $ReleaseTimestampUrl -HashAlgorithm SHA256 -IncludeChain All
    if ($CatalogSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $CatalogSignature.TimeStamperCertificate) {
      throw "Release package catalog signing or trusted timestamping failed: $($CatalogSignature.Status)"
    }
    $CatalogPath = Join-Path $OutRoot $IntegrityCatalogRelativePath
    Copy-Item -LiteralPath $TemporaryCatalog -Destination $CatalogPath -Force
    $CatalogValidation = Test-FileCatalog -Path $OutRoot -CatalogFilePath $CatalogPath -Detailed
    if ([string]$CatalogValidation.Status -ne 'Valid') {
      throw "Signed release package catalog does not match the completed package: $($CatalogValidation.Status)"
    }
  } finally {
    Remove-Item -LiteralPath $TemporaryCatalog -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "Runtime package created at $OutRoot"
