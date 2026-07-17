param(
  [switch]$SkipFrontendBuild,
  [switch]$SkipClientTests,
  [switch]$SkipServiceTests,
  [switch]$SkipTriggerTests,
  [switch]$SkipCaptureBuild,
  [switch]$SkipServiceBuild,
  [switch]$SkipTriggerBuild,
  [switch]$SkipExternalProviderCheck,
  [switch]$SkipPackage,
  [string]$ExistingPackageDir = "",
  [switch]$PackageOnly,
  [switch]$RequireFormalPackage,
  [string]$ExpectedFirstPartyThumbprint = "",
  [string[]]$AllowedVendorSdkSignerThumbprints = @(),
  [string]$ExpectedPublisher = "",
  [string]$ExpectedReleasePolicySha256 = "",
  [string]$ExpectedBundleToolchainManifestSha256 = "",
  [string]$ExpectedExternalComponentsSha256 = "",
  [switch]$AllowPackageCodeExecution,
  [switch]$SkipPackagedClientSmoke
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

function Assert-PathExists {
  param(
    [string]$Path,
    [string]$Message,
    [ValidateSet("Any", "Leaf", "Container")]
    [string]$Type = "Any"
  )

  $PathType = if ($Type -eq "Any") { "Any" } else { $Type }
  if ($PathType -eq "Any") {
    if (-not (Test-Path $Path)) {
      throw $Message
    }
  } elseif (-not (Test-Path $Path -PathType $PathType)) {
    throw $Message
  }
}

function Assert-PowerShellScriptParses {
  param([string]$Path)

  Assert-PathExists $Path "Missing PowerShell script: $Path" "Leaf"
  $Tokens = $null
  $Errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$Tokens, [ref]$Errors) | Out-Null
  if ($Errors.Count -gt 0) {
    $Errors | Format-List | Out-String | Write-Host
    throw "PowerShell script has parse errors: $Path"
  }
}

function Resolve-PackagePath {
  param(
    [string]$PackageDir,
    [string]$RelativePath
  )
  if ([string]::IsNullOrWhiteSpace($RelativePath) -or [System.IO.Path]::IsPathRooted($RelativePath)) {
    throw "Package path must be a non-empty relative path: $RelativePath"
  }
  $Root = [System.IO.Path]::GetFullPath($PackageDir).TrimEnd('\', '/')
  $Resolved = [System.IO.Path]::GetFullPath((Join-Path $Root ($RelativePath -replace "/", "\")))
  if (-not $Resolved.StartsWith($Root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Package path escapes the package root: $RelativePath"
  }
  return $Resolved
}

function Assert-BundleToolchainManifestContract {
  param([Parameter(Mandatory = $true)]$Manifest)

  if ([string]$Manifest.schema -cne 'steel.tauri-bundle-toolchain.v1' -or
      [string]$Manifest.rustTarget -cne 'x86_64-pc-windows-msvc' -or
      [string]::IsNullOrWhiteSpace([string]$Manifest.tauriCliVersion)) {
    throw "Packaged bundle toolchain evidence has an invalid schema, Rust target, or Tauri CLI version."
  }

  $Components = @($Manifest.components)
  $ComponentIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($Component in $Components) {
    $Id = [string]$Component.id
    if ($Id -notmatch '^[a-z0-9][a-z0-9.-]{1,63}$' -or
        -not $ComponentIds.Add($Id) -or
        [string]::IsNullOrWhiteSpace([string]$Component.version) -or
        [string]::IsNullOrWhiteSpace([string]$Component.license)) {
      throw "Packaged bundle toolchain component identifiers, versions, and licenses must be explicit and unique."
    }
  }
  foreach ($RequiredComponent in @('wix', 'nsis', 'webview2-offline')) {
    if (-not $ComponentIds.Contains($RequiredComponent)) {
      throw "Packaged bundle toolchain evidence is missing required component: $RequiredComponent"
    }
  }

  $Files = @($Manifest.files)
  if ($Files.Count -lt 3) {
    throw "Packaged bundle toolchain evidence must inventory at least one file for every required component."
  }
  $DeclaredPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $ComponentsWithFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($File in $Files) {
    $RelativePath = [string]$File.path
    $ComponentId = [string]$File.component
    if ([string]::IsNullOrWhiteSpace($RelativePath) -or
        $RelativePath.Contains('\') -or
        [System.IO.Path]::IsPathRooted($RelativePath) -or
        $RelativePath -match '(^/|/$|//|(^|/)\.\.?(/|$))' -or
        $RelativePath -match '[:\x00-\x1f]' -or
        -not $DeclaredPaths.Add($RelativePath)) {
      throw "Packaged bundle toolchain inventory contains a non-canonical or duplicate path: $RelativePath"
    }
    if (-not $ComponentIds.Contains($ComponentId)) {
      throw "Packaged bundle toolchain file references an unknown component: $ComponentId"
    }
    if ([string]$File.sha256 -notmatch '^[0-9a-f]{64}$' -or
        [string]$File.size -notmatch '^(0|[1-9]\d*)$') {
      throw "Packaged bundle toolchain file size or SHA-256 is invalid: $RelativePath"
    }
    [void]$ComponentsWithFiles.Add($ComponentId)
  }
  foreach ($RequiredComponent in @('wix', 'nsis', 'webview2-offline')) {
    if (-not $ComponentsWithFiles.Contains($RequiredComponent)) {
      throw "Packaged bundle toolchain component has no inventoried files: $RequiredComponent"
    }
  }

  return [pscustomobject]@{
    ComponentCount = $Components.Count
    FileCount = $Files.Count
  }
}

function Assert-DatabaseExactProperties {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string[]]$Expected,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ($null -eq $Value -or $Value -is [string] -or $Value -is [System.Array]) {
    throw "$Label must be a JSON object."
  }
  $Actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $Required = @($Expected | Sort-Object)
  if ($Actual.Count -ne $Required.Count -or ($Actual -join "`n") -cne ($Required -join "`n")) {
    throw "$Label properties are not the exact release contract."
  }
}

function Assert-DatabaseJsonInteger {
  param(
    $Value,
    [Parameter(Mandatory = $true)][string]$Label,
    [long]$Minimum = 0,
    [long]$Maximum = [long]::MaxValue
  )
  $IsInteger = $Value -is [byte] -or $Value -is [sbyte] -or
    $Value -is [int16] -or $Value -is [uint16] -or
    $Value -is [int32] -or $Value -is [uint32] -or
    $Value -is [int64] -or $Value -is [uint64]
  if (-not $IsInteger -or [decimal]$Value -lt $Minimum -or [decimal]$Value -gt $Maximum) {
    throw "$Label must be a JSON integer in range $Minimum..$Maximum."
  }
}

function Assert-DatabaseCanonicalPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ([string]::IsNullOrWhiteSpace($Path) -or
      $Path.Contains('\') -or
      [System.IO.Path]::IsPathRooted($Path) -or
      $Path -match '(^/|/$|//|(^|/)\.\.?(/|$))' -or
      $Path -match '[:\x00-\x1f]') {
    throw "$Label must be a canonical forward-slash relative path: $Path"
  }
}

function Assert-PackagedDatabaseMigrationContract {
  param(
    [Parameter(Mandatory = $true)][string]$PackageDir,
    [Parameter(Mandatory = $true)]$Database
  )

  $ContractProperties = @(
    'contractSchema',
    'schemaVersion',
    'minUpgradeableSchemaVersion',
    'maxUpgradeableSchemaVersion',
    'minReadableSchemaVersion',
    'maxReadableSchemaVersion',
    'rollbackReadableThrough',
    'engines',
    'migrationIndex',
    'migrationIndexSha256',
    'stateLayoutVersion'
  )
  $DatabaseProperties = @('contractPath', 'contractSha256') + $ContractProperties
  Assert-DatabaseExactProperties -Value $Database -Expected $DatabaseProperties -Label 'Runtime manifest database contract'
  if ([string]$Database.contractPath -cne 'database/contract.json' -or
      [string]$Database.contractSha256 -notmatch '^[0-9a-f]{64}$') {
    throw 'Runtime manifest database contract path or SHA-256 is invalid.'
  }
  $ContractPath = Resolve-PackagePath $PackageDir ([string]$Database.contractPath)
  Assert-PathExists $ContractPath 'Runtime package is missing database/contract.json.' 'Leaf'
  if (((Get-Item -LiteralPath $ContractPath -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Packaged database contract must not be a reparse point.'
  }
  $ContractHash = (Get-FileHash -LiteralPath $ContractPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ContractHash -cne [string]$Database.contractSha256) {
    throw 'Packaged database contract SHA-256 does not match the runtime manifest.'
  }
  try {
    $Contract = Get-Content -LiteralPath $ContractPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw 'Packaged database contract must be valid UTF-8 JSON.'
  }
  Assert-DatabaseExactProperties -Value $Contract -Expected $ContractProperties -Label 'Packaged database contract'
  foreach ($Property in $ContractProperties) {
    if ($Property -ceq 'engines') {
      if ((@($Database.engines) -join "`n") -cne (@($Contract.engines) -join "`n")) {
        throw 'Runtime manifest database engines do not match database/contract.json.'
      }
    } elseif ([string]$Database.$Property -cne [string]$Contract.$Property) {
      throw "Runtime manifest database.$Property does not match database/contract.json."
    }
  }
  if ([string]$Contract.contractSchema -cne 'steel.database-contract.v1') {
    throw 'Packaged database contract schema is invalid.'
  }
  foreach ($Field in @(
    'schemaVersion',
    'minUpgradeableSchemaVersion',
    'maxUpgradeableSchemaVersion',
    'minReadableSchemaVersion',
    'maxReadableSchemaVersion',
    'rollbackReadableThrough',
    'stateLayoutVersion'
  )) {
    Assert-DatabaseJsonInteger -Value $Contract.$Field -Label "Database contract $Field" -Minimum 1 -Maximum 2147483647
  }
  $SchemaVersion = [long]$Contract.schemaVersion
  $MinUpgradeable = [long]$Contract.minUpgradeableSchemaVersion
  $MaxUpgradeable = [long]$Contract.maxUpgradeableSchemaVersion
  $MinReadable = [long]$Contract.minReadableSchemaVersion
  $MaxReadable = [long]$Contract.maxReadableSchemaVersion
  $RollbackReadableThrough = [long]$Contract.rollbackReadableThrough
  $ExpectedMaxUpgradeable = if ($SchemaVersion -gt $MinUpgradeable) { $SchemaVersion - 1 } else { $SchemaVersion }
  if ($SchemaVersion -ne 1 -or
      $MinUpgradeable -gt $MaxUpgradeable -or
      $MaxUpgradeable -ne $ExpectedMaxUpgradeable -or
      $MinReadable -gt $MaxReadable -or
      $MaxReadable -ne $SchemaVersion -or
      $RollbackReadableThrough -lt $MinReadable -or
      $RollbackReadableThrough -gt $SchemaVersion) {
    throw 'Packaged database version ranges do not match the service schema v1 contract.'
  }
  $Engines = @($Contract.engines)
  if ($Engines.Count -ne 2 -or [string]$Engines[0] -cne 'sqlite' -or [string]$Engines[1] -cne 'mysql') {
    throw 'Packaged database engines must be the canonical ordered set: sqlite, mysql.'
  }
  if ([string]$Contract.migrationIndex -cne 'database/migrations/index.json' -or
      [string]$Contract.migrationIndexSha256 -notmatch '^[0-9a-f]{64}$') {
    throw 'Packaged database migration index path or SHA-256 is invalid.'
  }

  $IndexPath = Resolve-PackagePath $PackageDir ([string]$Contract.migrationIndex)
  Assert-PathExists $IndexPath 'Runtime package is missing database/migrations/index.json.' 'Leaf'
  if (((Get-Item -LiteralPath $IndexPath -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Packaged database migration index must not be a reparse point.'
  }
  $IndexHash = (Get-FileHash -LiteralPath $IndexPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($IndexHash -cne [string]$Contract.migrationIndexSha256) {
    throw 'Packaged database migration index SHA-256 does not match its contract.'
  }
  try {
    $Index = Get-Content -LiteralPath $IndexPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw 'Packaged database migration index must be valid UTF-8 JSON.'
  }
  Assert-DatabaseExactProperties -Value $Index -Expected @(
    'schema',
    'baseSchemaVersion',
    'targetSchemaVersion',
    'engines',
    'migrations'
  ) -Label 'Packaged database migration index'
  if ([string]$Index.schema -cne 'steel.database-migration-index.v1') {
    throw 'Packaged database migration index schema is invalid.'
  }
  Assert-DatabaseJsonInteger -Value $Index.baseSchemaVersion -Label 'Migration index baseSchemaVersion' -Minimum 1 -Maximum 2147483647
  Assert-DatabaseJsonInteger -Value $Index.targetSchemaVersion -Label 'Migration index targetSchemaVersion' -Minimum 1 -Maximum 2147483647
  if ([long]$Index.baseSchemaVersion -ne $MinUpgradeable -or
      [long]$Index.targetSchemaVersion -ne $SchemaVersion -or
      (@($Index.engines) -join "`n") -cne (@($Contract.engines) -join "`n")) {
    throw 'Packaged database migration index versions or engines do not match its contract.'
  }

  $MigrationProperties = @(
    'id',
    'fromVersion',
    'toVersion',
    'engine',
    'path',
    'sha256',
    'mode',
    'reversible',
    'rollbackPath',
    'rollbackSha256',
    'transactionModel',
    'estimatedLockSeconds'
  )
  $Migrations = @($Index.migrations)
  $Ids = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $PayloadPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $Edges = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($Migration in $Migrations) {
    Assert-DatabaseExactProperties -Value $Migration -Expected $MigrationProperties -Label 'Packaged database migration entry'
    $Id = [string]$Migration.id
    if ($Id -notmatch '^[0-9]{3}-[a-z0-9][a-z0-9-]{0,95}$' -or -not $Ids.Add($Id)) {
      throw "Packaged database migration id is invalid or duplicated: $Id"
    }
    Assert-DatabaseJsonInteger -Value $Migration.fromVersion -Label "Migration $Id fromVersion" -Minimum 1 -Maximum 2147483646
    Assert-DatabaseJsonInteger -Value $Migration.toVersion -Label "Migration $Id toVersion" -Minimum 2 -Maximum 2147483647
    Assert-DatabaseJsonInteger -Value $Migration.estimatedLockSeconds -Label "Migration $Id estimatedLockSeconds" -Minimum 0 -Maximum 86400
    $FromVersion = [long]$Migration.fromVersion
    $ToVersion = [long]$Migration.toVersion
    $Engine = [string]$Migration.engine
    if ($ToVersion -ne $FromVersion + 1 -or
        $FromVersion -lt [long]$Index.baseSchemaVersion -or
        $ToVersion -gt [long]$Index.targetSchemaVersion -or
        $Engine -cnotin @('sqlite', 'mysql') -or
        -not $Edges.Add("$Engine`:$FromVersion`:$ToVersion")) {
      throw "Packaged migration $Id has an invalid, discontinuous, or duplicate version edge."
    }
    if ([string]$Migration.mode -cne 'offline' -or $Migration.reversible -isnot [bool]) {
      throw "Packaged migration $Id must be offline and declare reversible as a JSON boolean."
    }
    $TransactionModel = [string]$Migration.transactionModel
    if (($Engine -ceq 'sqlite' -and $TransactionModel -cne 'sqlite-transactional') -or
        ($Engine -ceq 'mysql' -and $TransactionModel -cnotin @('mysql-expand-contract', 'mysql-nontransactional'))) {
      throw "Packaged migration $Id transactionModel is invalid for $Engine."
    }

    $ForwardPath = [string]$Migration.path
    Assert-DatabaseCanonicalPath -Path $ForwardPath -Label "Migration $Id forward path"
    if (-not $ForwardPath.StartsWith("$Engine/", [System.StringComparison]::Ordinal) -or
        -not $ForwardPath.EndsWith('.sql', [System.StringComparison]::Ordinal) -or
        -not $PayloadPaths.Add($ForwardPath) -or
        [string]$Migration.sha256 -notmatch '^[0-9a-f]{64}$') {
      throw "Packaged migration $Id forward path or SHA-256 is invalid."
    }
    $ForwardPackagePath = "database/migrations/$ForwardPath"
    $ForwardFile = Resolve-PackagePath $PackageDir $ForwardPackagePath
    Assert-PathExists $ForwardFile "Missing packaged migration payload: $ForwardPackagePath" 'Leaf'
    if (((Get-Item -LiteralPath $ForwardFile -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        (Get-FileHash -LiteralPath $ForwardFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$Migration.sha256) {
      throw "Packaged migration $Id forward payload hash mismatch or reparse point."
    }

    $RollbackPath = [string]$Migration.rollbackPath
    $RollbackSha256 = [string]$Migration.rollbackSha256
    if ($Migration.reversible) {
      Assert-DatabaseCanonicalPath -Path $RollbackPath -Label "Migration $Id rollback path"
      if (-not $RollbackPath.StartsWith("$Engine/", [System.StringComparison]::Ordinal) -or
          -not $RollbackPath.EndsWith('.sql', [System.StringComparison]::Ordinal) -or
          $RollbackPath -ceq $ForwardPath -or
          -not $PayloadPaths.Add($RollbackPath) -or
          $RollbackSha256 -notmatch '^[0-9a-f]{64}$') {
        throw "Packaged migration $Id rollback path or SHA-256 is invalid."
      }
      $RollbackPackagePath = "database/migrations/$RollbackPath"
      $RollbackFile = Resolve-PackagePath $PackageDir $RollbackPackagePath
      Assert-PathExists $RollbackFile "Missing packaged rollback payload: $RollbackPackagePath" 'Leaf'
      if (((Get-Item -LiteralPath $RollbackFile -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
          (Get-FileHash -LiteralPath $RollbackFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $RollbackSha256) {
        throw "Packaged migration $Id rollback payload hash mismatch or reparse point."
      }
    } elseif (-not [string]::IsNullOrEmpty($RollbackPath) -or -not [string]::IsNullOrEmpty($RollbackSha256)) {
      throw "Packaged irreversible migration $Id must have empty rollback fields."
    }
  }

  $BaseVersion = [long]$Index.baseSchemaVersion
  $TargetVersion = [long]$Index.targetSchemaVersion
  $RequiredSteps = [int]($TargetVersion - $BaseVersion)
  foreach ($Engine in @('sqlite', 'mysql')) {
    $Chain = @($Migrations | Where-Object { [string]$_.engine -ceq $Engine } | Sort-Object { [long]$_.fromVersion })
    if ($Chain.Count -ne $RequiredSteps) {
      throw "Packaged migration chain for $Engine is incomplete."
    }
    $ExpectedFrom = $BaseVersion
    foreach ($Migration in $Chain) {
      if ([long]$Migration.fromVersion -ne $ExpectedFrom -or [long]$Migration.toVersion -ne $ExpectedFrom + 1) {
        throw "Packaged migration chain for $Engine is not continuous at version $ExpectedFrom."
      }
      $ExpectedFrom++
    }
    if ($ExpectedFrom -ne $TargetVersion) {
      throw "Packaged migration chain for $Engine does not terminate at $TargetVersion."
    }
  }

  return [pscustomobject]@{
    schemaVersion = $SchemaVersion
    migrationCount = $Migrations.Count
    payloadCount = $PayloadPaths.Count
  }
}

function Get-TauriFeatureResolution {
  param(
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [Parameter(Mandatory = $true)][string]$RustTarget
  )

  $MetadataText = & cargo metadata `
    --manifest-path $ManifestPath `
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
    schema = 'steel.tauri-feature-resolution.v1'
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

function Assert-TimestampedAuthenticodeSignature {
  param([Parameter(Mandatory = $true)][string]$Path)

  $Signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Packaged desktop artifact is not Authenticode-valid: $Path ($($Signature.Status))"
  }
  if ($null -eq $Signature.TimeStamperCertificate) {
    throw "Packaged desktop artifact has no trusted timestamp: $Path"
  }
  return $Signature
}

function Assert-WindowsFileVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion
  )

  $VersionInfo = (Get-Item -LiteralPath $Path).VersionInfo
  $Candidates = @([string]$VersionInfo.ProductVersion, [string]$VersionInfo.FileVersion)
  if (@($Candidates | Where-Object { $_ -match ('^' + [regex]::Escape($ExpectedVersion) + '(?:\.0)?(?:\s|$)') }).Count -lt 1) {
    throw "Windows artifact version does not match releaseVersion=${ExpectedVersion}: $Path"
  }
}

function Get-MsiProductVersion {
  param([Parameter(Mandatory = $true)][string]$Path)

  $Installer = $null
  $Database = $null
  $View = $null
  $Record = $null
  try {
    $Installer = New-Object -ComObject WindowsInstaller.Installer
    $Database = $Installer.OpenDatabase($Path, 0)
    $View = $Database.OpenView("SELECT `Value` FROM `Property` WHERE `Property`='ProductVersion'")
    $View.Execute()
    $Record = $View.Fetch()
    if ($null -eq $Record) { throw "MSI has no ProductVersion property: $Path" }
    return [string]$Record.StringData(1)
  } finally {
    foreach ($ComObject in @($Record, $View, $Database, $Installer)) {
      if ($null -ne $ComObject -and [System.Runtime.InteropServices.Marshal]::IsComObject($ComObject)) {
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($ComObject)
      }
    }
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

function Get-FreeLocalPort {
  $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), 0)
  try {
    $Listener.Start()
    return $Listener.LocalEndpoint.Port
  } finally {
    $Listener.Stop()
  }
}

function Test-PackagedRuntimeContract {
  param(
    [Parameter(Mandatory = $true)][string]$PackageDir,
    [switch]$RequireFormal,
    [string]$ApprovedFirstPartyThumbprint = "",
    [string[]]$ApprovedVendorSdkSignerThumbprints = @(),
    [string]$ApprovedPublisher = "",
    [string]$ApprovedReleasePolicySha256 = "",
    [string]$ApprovedBundleToolchainManifestSha256 = "",
    [string]$ApprovedExternalComponentsSha256 = "",
    [switch]$AllowPackageExecution
  )

  $PackageDir = (Resolve-Path -LiteralPath $PackageDir -ErrorAction Stop).Path
  Assert-PathExists $PackageDir "Missing runtime package directory: $PackageDir" "Container"

  $ManifestPath = Join-Path $PackageDir "manifest.json"
  Assert-PathExists $ManifestPath "Missing runtime manifest: $ManifestPath" "Leaf"
  try {
    $Manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
  } catch {
    throw "Runtime manifest must be valid JSON: $ManifestPath"
  }

  $ChecksumPath = Join-Path $PackageDir "checksums.sha256"
  Assert-PathExists $ChecksumPath "Missing runtime SHA-256 inventory: $ChecksumPath" "Leaf"
  $ChecksumLines = @(Get-Content -LiteralPath $ChecksumPath)
  if ($ChecksumLines.Count -lt 1 -or @($ChecksumLines | Where-Object { $_ -notmatch '^[0-9a-f]{64}  .+$' }).Count -gt 0) {
    throw "Runtime SHA-256 inventory is malformed: $ChecksumPath"
  }
  if ([string]$Manifest.integrity.checksumAlgorithm -cne 'sha256' -or
      [string]$Manifest.integrity.checksumInventory -cne 'checksums.sha256') {
    throw "Runtime manifest must declare the SHA-256 checksum inventory."
  }
  $ExpectedChecksumExcludes = if ([string]$Manifest.packageClass -ceq 'formal-release') {
    @('checksums.sha256', 'release-integrity.cat')
  } else {
    @('checksums.sha256')
  }
  $DeclaredChecksumExcludes = @($Manifest.integrity.checksumExcludes)
  if ((@($DeclaredChecksumExcludes | Sort-Object) -join '|') -cne (@($ExpectedChecksumExcludes | Sort-Object) -join '|')) {
    throw "Runtime manifest checksum exclusions are not the exact package-class contract."
  }
  $SeenChecksumPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($Line in $ChecksumLines) {
    $ExpectedHash, $RelativePath = $Line -split '  ', 2
    if ($RelativePath.Contains('\') -or $DeclaredChecksumExcludes -ccontains $RelativePath -or -not $SeenChecksumPaths.Add($RelativePath)) {
      throw "Runtime SHA-256 inventory contains a non-canonical, excluded, or duplicate path: $RelativePath"
    }
    $ArtifactPath = Resolve-PackagePath $PackageDir $RelativePath
    Assert-PathExists $ArtifactPath "SHA-256 inventory points to missing artifact: $RelativePath" "Leaf"
    $ActualHash = (Get-FileHash -LiteralPath $ArtifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualHash -ne $ExpectedHash) {
      throw "SHA-256 mismatch for packaged artifact: $RelativePath"
    }
  }
  $ActualInventoryPaths = @(Get-ChildItem -LiteralPath $PackageDir -Recurse -File -Force | ForEach-Object {
    $_.FullName.Substring($PackageDir.Length + 1).Replace('\', '/')
  } | Where-Object { $DeclaredChecksumExcludes -cnotcontains $_ } | Sort-Object)
  $DeclaredInventoryPaths = @($SeenChecksumPaths | Sort-Object)
  if ($ActualInventoryPaths.Count -ne $DeclaredInventoryPaths.Count -or
      ($ActualInventoryPaths -join "`n") -cne ($DeclaredInventoryPaths -join "`n")) {
    $Missing = @($ActualInventoryPaths | Where-Object { -not $SeenChecksumPaths.Contains($_) })
    $Unexpected = @($DeclaredInventoryPaths | Where-Object { $ActualInventoryPaths -cnotcontains $_ })
    throw "Runtime SHA-256 inventory is not complete. missing=$($Missing -join ',') unexpected=$($Unexpected -join ',')"
  }
  if ([string]$Manifest.schema -ne "steel.runtime-package.v1") {
    throw "Runtime manifest must declare the steel.runtime-package.v1 schema."
  }
  if ([string]$Manifest.source.gitCommit -notmatch '^[0-9a-f]{40,64}$') {
    throw "Runtime manifest must bind an exact lowercase Git source commit."
  }
  if ([string]$Manifest.service.windowsServiceName -ne "SteelInspectionRuntime") {
    throw "Runtime manifest must declare the fixed Windows service name."
  }

  if ([string]$Manifest.packageClass -notin @('engineering', 'formal-release')) {
    throw "Runtime manifest has an unsupported packageClass."
  }
  $IsFormalPackage = [string]$Manifest.packageClass -ceq 'formal-release'
  if ($RequireFormal -and -not $IsFormalPackage) {
    throw "Formal package verification was requested, but the manifest declares an engineering package."
  }
  $DatabaseContract = Assert-PackagedDatabaseMigrationContract `
    -PackageDir $PackageDir `
    -Database $Manifest.database
  if ([long]$DatabaseContract.schemaVersion -ne 1) {
    throw "Runtime package database contract does not match this verifier's service schema v1 boundary."
  }
  $PackagedSbomVerifier = Join-Path $PSScriptRoot 'verify-packaged-release-sbom.ps1'
  Assert-PowerShellScriptParses $PackagedSbomVerifier
  $PackagedSbomArguments = @{
    PackageDir = $PackageDir
    ManifestPath = $ManifestPath
  }
  if ($IsFormalPackage) {
    $PackagedSbomArguments.ExpectedExternalComponentsSha256 = $ApprovedExternalComponentsSha256
  } else {
    $PackagedSbomArguments.Engineering = $true
  }
  $PackagedSbomReportText = (& $PackagedSbomVerifier @PackagedSbomArguments | Out-String)
  $PackagedSbomReport = $PackagedSbomReportText | ConvertFrom-Json
  if ($PackagedSbomReport.code -ne 0 -or
      [string]$PackagedSbomReport.schema -cne 'steel.packaged-release-sbom-verification.v1') {
    throw "Runtime package failed static SBOM verification."
  }
  if (-not $IsFormalPackage -and (
      [string]$Manifest.integrity.algorithm -cne 'checksums-only-engineering' -or
      -not [string]::IsNullOrEmpty([string]$Manifest.integrity.catalog) -or
      [int]$Manifest.integrity.catalogVersion -ne 0 -or
      $Manifest.integrity.timestampRequired -ne $false)) {
    throw "Engineering package must declare checksums-only integrity and must not claim a release catalog."
  }
  if ($IsFormalPackage) {
    $ApprovedFirstPartyThumbprint = $ApprovedFirstPartyThumbprint.Replace(' ', '').ToUpperInvariant()
    $ApprovedVendorSdkSignerThumbprints = @($ApprovedVendorSdkSignerThumbprints | ForEach-Object { $_.Replace(' ', '').ToUpperInvariant() } | Sort-Object -Unique)
    if ($ApprovedFirstPartyThumbprint -notmatch '^[0-9A-F]{40}$') {
      throw "Formal package verification requires an out-of-band ExpectedFirstPartyThumbprint."
    }
    if ($ApprovedVendorSdkSignerThumbprints.Count -lt 1 -or
        @($ApprovedVendorSdkSignerThumbprints | Where-Object { $_ -notmatch '^[0-9A-F]{40}$' }).Count -gt 0) {
      throw "Formal package verification requires an out-of-band vendor SDK signer thumbprint allowlist."
    }
    if ([string]::IsNullOrWhiteSpace($ApprovedPublisher) -or
        [string]$Manifest.desktop.publisher -cne $ApprovedPublisher) {
      throw "Formal package verification requires the out-of-band approved desktop publisher."
    }
    $ApprovedReleasePolicySha256 = $ApprovedReleasePolicySha256.Trim().ToLowerInvariant()
    if ($ApprovedReleasePolicySha256 -notmatch '^[0-9a-f]{64}$') {
      throw "Formal package verification requires an out-of-band ExpectedReleasePolicySha256."
    }
    $ApprovedBundleToolchainManifestSha256 = $ApprovedBundleToolchainManifestSha256.Trim().ToLowerInvariant()
    if ($ApprovedBundleToolchainManifestSha256 -notmatch '^[0-9a-f]{64}$') {
      throw "Formal package verification requires an out-of-band ExpectedBundleToolchainManifestSha256."
    }
    if ($Manifest.source.dirty -ne $false -or $Manifest.build.desktopBundleIncluded -ne $true) {
      throw "Formal package must be clean and desktop-inclusive."
    }
    if ([string]$Manifest.build.captureConfiguration -cne 'Release' -or
        [string]$Manifest.build.rustProfile -cne 'release' -or
        [string]$Manifest.service.profile -cne 'release') {
      throw "Formal package must contain Release C++ and release Rust artifacts."
    }
    $ReleaseVersion = [string]$Manifest.releaseVersion
    if ($ReleaseVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or $ReleaseVersion -ceq '0.1.0' -or
        [string]$Manifest.desktop.version -cne $ReleaseVersion -or
        [string]$Manifest.source.gitTag -notin @($ReleaseVersion, "v$ReleaseVersion")) {
      throw "Formal package must bind one non-placeholder stable releaseVersion to its Git tag and desktop inventory."
    }
    if ($Manifest.build.performed -ne $true -or
        [string]$Manifest.build.provenance -cne 'built-in-this-invocation' -or
        [string]$Manifest.build.sourceCommit -cne [string]$Manifest.source.gitCommit) {
      throw "Formal package must prove that all artifacts were built from its declared source commit in the packaging invocation."
    }
    if ([string]$Manifest.integrity.algorithm -ne 'windows-file-catalog-sha256' -or
        [string]$Manifest.integrity.catalog -ne 'release-integrity.cat' -or
        [int]$Manifest.integrity.catalogVersion -ne 2 -or
        $Manifest.integrity.timestampRequired -ne $true) {
      throw "Formal package must declare a timestamp-signed SHA-256 Windows file catalog."
    }
    if ([string]$Manifest.build.dependencyInstall -cne 'npm-ci') {
      throw "Formal package must record a clean npm ci dependency installation."
    }
    $ExpectedLockPaths = @(
      'build-evidence/client-package-lock.json',
      'build-evidence/service-Cargo.lock',
      'build-evidence/tauri-Cargo.lock',
      'build-evidence/trigger-Cargo.lock'
    )
    $LockEvidence = @($Manifest.build.dependencyLocks)
    if ($LockEvidence.Count -ne $ExpectedLockPaths.Count) {
      throw "Formal package dependency lock evidence is incomplete."
    }
    foreach ($LockPath in $ExpectedLockPaths) {
      $Evidence = @($LockEvidence | Where-Object { [string]$_.path -ceq $LockPath })
      if ($Evidence.Count -ne 1) { throw "Missing or duplicate dependency lock evidence: $LockPath" }
      $ResolvedLockPath = Resolve-PackagePath $PackageDir $LockPath
      Assert-PathExists $ResolvedLockPath "Missing packaged dependency lock: $LockPath" "Leaf"
      if ([string]$Evidence[0].sha256 -cne (Get-FileHash -LiteralPath $ResolvedLockPath -Algorithm SHA256).Hash.ToLowerInvariant()) {
        throw "Dependency lock evidence hash mismatch: $LockPath"
      }
    }
    if ([string]$Manifest.build.releasePolicy.path -cne 'build-evidence/desktop-release-policy.json') {
      throw "Formal package is missing the exact desktop release policy evidence path."
    }
    $PackagedReleasePolicyPath = Resolve-PackagePath $PackageDir ([string]$Manifest.build.releasePolicy.path)
    Assert-PathExists $PackagedReleasePolicyPath "Missing packaged desktop release policy evidence." "Leaf"
    $PackagedReleasePolicyHash = (Get-FileHash -LiteralPath $PackagedReleasePolicyPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]$Manifest.build.releasePolicy.sha256 -cne $PackagedReleasePolicyHash -or
        $PackagedReleasePolicyHash -cne $ApprovedReleasePolicySha256) {
      throw "Packaged desktop release policy does not match its manifest and out-of-band approved SHA-256."
    }
    try {
      $PackagedReleasePolicy = Get-Content -LiteralPath $PackagedReleasePolicyPath -Raw | ConvertFrom-Json
    } catch {
      throw "Packaged desktop release policy must be valid JSON."
    }
    if ([string]$PackagedReleasePolicy.schema -cne 'steel.desktop-release-policy.v1' -or
        [string]$PackagedReleasePolicy.publisher -cne $ApprovedPublisher -or
        [string]::IsNullOrWhiteSpace([string]$PackagedReleasePolicy.contentSecurityPolicy) -or
        [string]$PackagedReleasePolicy.rustTarget -cne 'x86_64-pc-windows-msvc' -or
        [string]$PackagedReleasePolicy.cargoConfigSha256 -notmatch '^[0-9a-f]{64}$' -or
        [string]$PackagedReleasePolicy.tauriConfigSha256 -notmatch '^[0-9a-f]{64}$' -or
        [string]$PackagedReleasePolicy.tauriCargoSha256 -notmatch '^[0-9a-f]{64}$' -or
        @($PackagedReleasePolicy.PSObject.Properties.Name) -cnotcontains 'cargoFeatures' -or
        @($PackagedReleasePolicy.cargoFeatures).Count -ne 0 -or
        $PackagedReleasePolicy.devtools -ne $false) {
      throw "Packaged desktop release policy is invalid or does not bind the approved publisher."
    }
    if ([string]$Manifest.build.bundleToolchain.path -cne 'build-evidence/bundle-toolchain-manifest.json') {
      throw "Formal package is missing the exact bundle toolchain evidence path."
    }
    $PackagedBundleToolchainPath = Resolve-PackagePath $PackageDir ([string]$Manifest.build.bundleToolchain.path)
    Assert-PathExists $PackagedBundleToolchainPath "Missing packaged bundle toolchain evidence." "Leaf"
    $PackagedBundleToolchainHash = (Get-FileHash -LiteralPath $PackagedBundleToolchainPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]$Manifest.build.bundleToolchain.sha256 -cne $PackagedBundleToolchainHash -or
        $PackagedBundleToolchainHash -cne $ApprovedBundleToolchainManifestSha256) {
      throw "Packaged bundle toolchain evidence does not match its manifest and out-of-band approved SHA-256."
    }
    try {
      $PackagedBundleToolchain = Get-Content -LiteralPath $PackagedBundleToolchainPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
      throw "Packaged bundle toolchain evidence must be valid UTF-8 JSON."
    }
    $BundleToolchainContract = Assert-BundleToolchainManifestContract -Manifest $PackagedBundleToolchain
    if ([string]$Manifest.build.bundleToolchain.schema -cne [string]$PackagedBundleToolchain.schema -or
        [string]$Manifest.build.bundleToolchain.tauriCliVersion -cne [string]$PackagedBundleToolchain.tauriCliVersion -or
        [string]$Manifest.build.bundleToolchain.rustTarget -cne [string]$PackagedBundleToolchain.rustTarget -or
        [int]$Manifest.build.bundleToolchain.componentCount -ne [int]$BundleToolchainContract.ComponentCount -or
        [int]$Manifest.build.bundleToolchain.fileCount -ne [int]$BundleToolchainContract.FileCount -or
        [string]$PackagedBundleToolchain.rustTarget -cne [string]$PackagedReleasePolicy.rustTarget) {
      throw "Runtime manifest bundle toolchain metadata does not match its approved evidence or release policy."
    }
    if ([string]$Manifest.build.tauriConfig.path -cne 'build-evidence/tauri.conf.json') {
      throw "Formal package is missing the exact Tauri configuration evidence path."
    }
    $PackagedTauriConfigPath = Resolve-PackagePath $PackageDir ([string]$Manifest.build.tauriConfig.path)
    Assert-PathExists $PackagedTauriConfigPath "Missing packaged Tauri configuration evidence." "Leaf"
    $PackagedTauriConfigHash = (Get-FileHash -LiteralPath $PackagedTauriConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]$Manifest.build.tauriConfig.sha256 -cne $PackagedTauriConfigHash -or
        [string]$PackagedReleasePolicy.tauriConfigSha256 -cne $PackagedTauriConfigHash) {
      throw "Packaged Tauri configuration evidence hash mismatch."
    }
    $PackagedTauriConfig = Get-Content -LiteralPath $PackagedTauriConfigPath -Raw | ConvertFrom-Json
    $PackagedCsp = [string]$PackagedTauriConfig.app.security.csp
    $PackagedWindows = @($PackagedTauriConfig.app.windows)
    if ([string]$PackagedTauriConfig.version -cne $ReleaseVersion -or
        $PackagedTauriConfig.bundle.active -ne $true -or
        @($PackagedTauriConfig.build.PSObject.Properties.Name) -cnotcontains 'features' -or
        @($PackagedTauriConfig.build.features).Count -ne 0 -or
        (@($PackagedTauriConfig.bundle.targets | Sort-Object) -join ',') -cne (@($PackagedReleasePolicy.targets | Sort-Object) -join ',') -or
        [string]$PackagedTauriConfig.build.beforeDevCommand -cne [string]$PackagedReleasePolicy.beforeDevCommand -or
        [string]$PackagedTauriConfig.build.beforeBuildCommand -cne [string]$PackagedReleasePolicy.beforeBuildCommand -or
        [string]$PackagedTauriConfig.bundle.windows.webviewInstallMode.type -cne [string]$PackagedReleasePolicy.webView2InstallMode -or
        [string]$PackagedTauriConfig.bundle.windows.nsis.installMode -cne [string]$PackagedReleasePolicy.nsisInstallMode -or
        $PackagedTauriConfig.bundle.windows.allowDowngrades -ne $PackagedReleasePolicy.allowDowngrades -or
        [string]$PackagedTauriConfig.bundle.publisher -cne $ApprovedPublisher -or
        $PackagedCsp -cne [string]$PackagedReleasePolicy.contentSecurityPolicy -or
        $PackagedWindows.Count -lt 1 -or
        @($PackagedWindows | Where-Object { $_.devtools -ne $PackagedReleasePolicy.devtools }).Count -gt 0) {
      throw "Packaged Tauri configuration does not match the formal offline/per-machine/no-downgrade release contract."
    }
    if ([string]$Manifest.build.tauriCargo.path -cne 'build-evidence/tauri-Cargo.toml') {
      throw "Formal package is missing the exact Tauri Cargo manifest evidence path."
    }
    $PackagedTauriCargoPath = Resolve-PackagePath $PackageDir ([string]$Manifest.build.tauriCargo.path)
    Assert-PathExists $PackagedTauriCargoPath "Missing packaged Tauri Cargo manifest evidence." "Leaf"
    $PackagedTauriCargoHash = (Get-FileHash -LiteralPath $PackagedTauriCargoPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]$Manifest.build.tauriCargo.sha256 -cne $PackagedTauriCargoHash -or
        [string]$PackagedReleasePolicy.tauriCargoSha256 -cne $PackagedTauriCargoHash) {
      throw "Packaged Tauri Cargo manifest evidence hash mismatch."
    }
    $PackagedTauriCargoText = Get-Content -LiteralPath $PackagedTauriCargoPath -Raw
    $PackagedTauriReleaseProfile = [regex]::Match($PackagedTauriCargoText, '(?ms)^\[profile\.release\]\s*\r?\n(?<body>.*?)(?=^\[|\z)')
    if (-not $PackagedTauriReleaseProfile.Success -or
        [string]$PackagedTauriReleaseProfile.Groups['body'].Value -notmatch '(?m)^debug-assertions\s*=\s*false\s*$' -or
        $PackagedTauriCargoText -match '(?m)^\s*\[\s*profile\s*\.\s*release\s*\.' -or
        [string]$PackagedTauriReleaseProfile.Groups['body'].Value -match '(?m)^\s*package\s*\.') {
      throw "Packaged Tauri Cargo manifest must explicitly disable release debug assertions."
    }
    if ([string]$Manifest.build.cargoConfig.path -cne 'build-evidence/cargo-config.toml') {
      throw "Formal package is missing the exact Cargo config evidence path."
    }
    $PackagedCargoConfigPath = Resolve-PackagePath $PackageDir ([string]$Manifest.build.cargoConfig.path)
    Assert-PathExists $PackagedCargoConfigPath "Missing packaged Cargo config evidence." "Leaf"
    $PackagedCargoConfigHash = (Get-FileHash -LiteralPath $PackagedCargoConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]$Manifest.build.cargoConfig.sha256 -cne $PackagedCargoConfigHash -or
        [string]$PackagedReleasePolicy.cargoConfigSha256 -cne $PackagedCargoConfigHash) {
      throw "Packaged Cargo config does not match its manifest and the approved release policy."
    }
    if ([string]$Manifest.build.tauriFeatureResolution.path -cne 'build-evidence/tauri-feature-resolution.json') {
      throw "Formal package is missing the exact resolved Tauri feature evidence path."
    }
    $PackagedTauriFeaturePath = Resolve-PackagePath $PackageDir ([string]$Manifest.build.tauriFeatureResolution.path)
    Assert-PathExists $PackagedTauriFeaturePath "Missing packaged resolved Tauri feature evidence." "Leaf"
    $PackagedTauriFeatureHash = (Get-FileHash -LiteralPath $PackagedTauriFeaturePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]$Manifest.build.tauriFeatureResolution.sha256 -cne $PackagedTauriFeatureHash) {
      throw "Packaged resolved Tauri feature evidence hash mismatch."
    }
    try {
      $PackagedTauriFeatureResolution = Get-Content -LiteralPath $PackagedTauriFeaturePath -Raw | ConvertFrom-Json
    } catch {
      throw "Packaged resolved Tauri feature evidence must be valid JSON."
    }
    if ([string]$PackagedTauriFeatureResolution.schema -cne 'steel.tauri-feature-resolution.v1' -or
        [string]$PackagedTauriFeatureResolution.rustTarget -cne [string]$PackagedReleasePolicy.rustTarget -or
        @($PackagedTauriFeatureResolution.PSObject.Properties.Name) -cnotcontains 'requestedFeatures' -or
        @($PackagedTauriFeatureResolution.requestedFeatures).Count -ne 0 -or
        @($PackagedTauriFeatureResolution.packageIds).Count -lt 1 -or
        @($PackagedTauriFeatureResolution.packageIds | Where-Object { [string]::IsNullOrWhiteSpace([string]$_) -or $_ -notmatch '(?:^|#)tauri(?:@|\s|$)' }).Count -gt 0 -or
        @($PackagedTauriFeatureResolution.enabledFeatures) -ccontains 'devtools') {
      throw "Resolved production Tauri feature evidence is invalid or enables devtools."
    }
    if ((@($Manifest.desktop.targets | Sort-Object) -join ',') -cne 'msi,nsis' -or
        [string]$Manifest.desktop.rustTarget -cne [string]$PackagedReleasePolicy.rustTarget -or
        $Manifest.desktop.allowDowngrades -ne $false -or
        [string]$Manifest.desktop.nsisInstallMode -cne 'perMachine') {
      throw "Formal desktop inventory does not reflect the approved Tauri release configuration."
    }
    if ([string]$Manifest.desktop.webView2InstallMode -ne "offlineInstaller") {
      throw "Formal desktop package must embed the offline WebView2 installer."
    }
    if ([string]::IsNullOrWhiteSpace([string]$Manifest.desktop.vcRuntimePrerequisite)) {
      throw "Formal desktop package must declare the offline VC++ x64 runtime prerequisite."
    }
    $DesktopInstallerPaths = @($Manifest.desktop.installers)
    $MsiPaths = @($DesktopInstallerPaths | Where-Object { $_ -match '\.msi$' })
    $NsisPaths = @($DesktopInstallerPaths | Where-Object { $_ -match '[\\/]nsis[\\/].*\.exe$' })
    if ($MsiPaths.Count -ne 1 -or $NsisPaths.Count -ne 1) {
      throw "Formal desktop package must declare exactly one MSI and one NSIS installer."
    }
    $SignedDesktopPaths = @($DesktopInstallerPaths) + @("desktop-installer/steel-plate-3d-inspection-tauri.exe")
    $DesktopEvidence = @($Manifest.desktop.signatures)
    if ($DesktopEvidence.Count -ne $SignedDesktopPaths.Count) {
      throw "Formal desktop package must record signature evidence for the app EXE, MSI, and NSIS installer."
    }
    foreach ($RelativePath in $SignedDesktopPaths) {
      $Evidence = @($DesktopEvidence | Where-Object { [string]$_.path -ceq [string]$RelativePath })
      if ($Evidence.Count -ne 1) {
        throw "Formal desktop signature evidence is missing or duplicated: $RelativePath"
      }
      $ArtifactPath = Resolve-PackagePath $PackageDir ([string]$RelativePath)
      Assert-PathExists $ArtifactPath "Missing signed desktop artifact: $RelativePath" "Leaf"
      if ([string]$RelativePath -ceq 'desktop-installer/steel-plate-3d-inspection-tauri.exe') {
        Assert-PeTargetMachine -Path $ArtifactPath -RustTarget ([string]$PackagedReleasePolicy.rustTarget)
      }
      $DesktopSignature = Assert-TimestampedAuthenticodeSignature $ArtifactPath
      if ([string]$DesktopSignature.SignerCertificate.Thumbprint -cne $ApprovedFirstPartyThumbprint -or
          [string]$Evidence[0].signerThumbprint -cne $ApprovedFirstPartyThumbprint) {
        throw "Desktop artifact signer does not match the out-of-band approved release signer: $RelativePath"
      }
    }
    $MsiProductVersion = Get-MsiProductVersion -Path (Resolve-PackagePath $PackageDir ([string]$MsiPaths[0]))
    if ($MsiProductVersion -cne $ReleaseVersion) {
      throw "MSI ProductVersion does not match releaseVersion=$ReleaseVersion."
    }
    Assert-WindowsFileVersion -Path (Resolve-PackagePath $PackageDir ([string]$NsisPaths[0])) -ExpectedVersion $ReleaseVersion
    Assert-WindowsFileVersion -Path (Resolve-PackagePath $PackageDir "desktop-installer/steel-plate-3d-inspection-tauri.exe") -ExpectedVersion $ReleaseVersion
    $VcRuntimePath = Resolve-PackagePath $PackageDir ([string]$Manifest.desktop.vcRuntimePrerequisite)
    Assert-PathExists $VcRuntimePath "Missing VC++ x64 runtime prerequisite." "Leaf"
    $VcRuntimeSignature = Assert-TimestampedAuthenticodeSignature $VcRuntimePath
    if ([string]$VcRuntimeSignature.SignerCertificate.Subject -notmatch '(^|, )O=Microsoft Corporation(,|$)') {
      throw "VC++ prerequisite must be Authenticode-signed by Microsoft Corporation."
    }

    $RuntimeSignedPaths = @(
      "capture-headless/steel_capture_service.exe",
      "service/steel-runtime-supervisor.exe",
      "service/steel-inspection-service.exe",
      "service/steel-trigger-gateway.exe",
      "algorithm-core/steel_bar_surface_core.exe",
      "capture-headless/nvt_lvm_sdk.dll"
    )
    $RuntimeEvidence = @($Manifest.service.signatures)
    if ($RuntimeEvidence.Count -ne $RuntimeSignedPaths.Count) {
      throw "Formal package must record timestamped signature evidence for every runtime EXE and SDK DLL."
    }
    foreach ($RelativePath in $RuntimeSignedPaths) {
      $Evidence = @($RuntimeEvidence | Where-Object { [string]$_.path -ceq $RelativePath })
      if ($Evidence.Count -ne 1) {
        throw "Formal package runtime signature evidence is missing or duplicated: $RelativePath"
      }
      $ArtifactPath = Resolve-PackagePath $PackageDir $RelativePath
      Assert-PathExists $ArtifactPath "Missing signed runtime artifact: $RelativePath" "Leaf"
      Assert-PeTargetMachine -Path $ArtifactPath -RustTarget ([string]$PackagedReleasePolicy.rustTarget)
      $RuntimeSignature = Assert-TimestampedAuthenticodeSignature $ArtifactPath
      $ActualRuntimeThumbprint = [string]$RuntimeSignature.SignerCertificate.Thumbprint
      if ([string]$Evidence[0].signerThumbprint -cne $ActualRuntimeThumbprint) {
        throw "Runtime signature evidence does not match the signed artifact: $RelativePath"
      }
      if ($RelativePath -eq "capture-headless/nvt_lvm_sdk.dll") {
        if ($ApprovedVendorSdkSignerThumbprints -cnotcontains $ActualRuntimeThumbprint) {
          throw "Vendor SDK signer is not in the out-of-band allowlist."
        }
      } elseif ($ActualRuntimeThumbprint -cne $ApprovedFirstPartyThumbprint) {
        throw "First-party runtime artifact is not signed by the out-of-band approved release signer: $RelativePath"
      }
    }
    $CatalogPath = Resolve-PackagePath $PackageDir ([string]$Manifest.integrity.catalog)
    Assert-PathExists $CatalogPath "Formal package is missing release-integrity.cat." "Leaf"
    $CatalogSignature = Assert-TimestampedAuthenticodeSignature $CatalogPath
    if ([string]$CatalogSignature.SignerCertificate.Thumbprint -cne $ApprovedFirstPartyThumbprint) {
      throw "Release integrity catalog is not signed by the approved desktop release certificate."
    }
    $CatalogValidation = Test-FileCatalog -Path $PackageDir -CatalogFilePath $CatalogPath -Detailed
    if ([string]$CatalogValidation.Status -ne 'Valid' -or [string]$CatalogValidation.HashAlgorithm -ne 'SHA256') {
      throw "Release integrity catalog does not validate the complete package with SHA-256."
    }
  }

  $RequiredManifestValues = @{
    "capture.path" = $Manifest.capture.path
    "capture.sdk" = $Manifest.capture.sdk
    "service.path" = $Manifest.service.path
    "service.triggerGateway" = $Manifest.service.triggerGateway
    "service.supervisor" = $Manifest.service.supervisor
    "client.path" = $Manifest.client.path
    "config.algorithm" = $Manifest.config.algorithm
    "config.algorithmAcceptanceTemplate" = $Manifest.config.algorithmAcceptanceTemplate
    "config.functionalGoLivePlanTemplate" = $Manifest.config.functionalGoLivePlanTemplate
    "config.plcL2FunctionalAcceptanceTemplate" = $Manifest.config.plcL2FunctionalAcceptanceTemplate
    "config.targetMachineFunctionalAcceptanceTemplate" = $Manifest.config.targetMachineFunctionalAcceptanceTemplate
    "config.functionalScenarioEvidenceTemplate" = $Manifest.config.functionalScenarioEvidenceTemplate
    "scripts.captureHeadless" = $Manifest.scripts.captureHeadless
    "scripts.serviceExternal" = $Manifest.scripts.serviceExternal
    "scripts.serviceSimulated" = $Manifest.scripts.serviceSimulated
    "scripts.triggerGateway" = $Manifest.scripts.triggerGateway
    "scripts.integrated" = $Manifest.scripts.integrated
    "scripts.integratedFullAcceptanceTest" = $Manifest.scripts.integratedFullAcceptanceTest
    "scripts.integratedAcceptanceAuditTest" = $Manifest.scripts.integratedAcceptanceAuditTest
    "scripts.migrationArchitectureTest" = $Manifest.scripts.migrationArchitectureTest
    "scripts.integratedSmokeTest" = $Manifest.scripts.integratedSmokeTest
    "scripts.integratedReadyTest" = $Manifest.scripts.integratedReadyTest
    "scripts.runtimeAcceptanceTest" = $Manifest.scripts.runtimeAcceptanceTest
    "scripts.runtimeLayoutTest" = $Manifest.scripts.runtimeLayoutTest
    "scripts.runtimePackageVerify" = $Manifest.scripts.runtimePackageVerify
    "scripts.runtimeSupervisorTest" = $Manifest.scripts.runtimeSupervisorTest
    "scripts.algorithmAcceptanceTest" = $Manifest.scripts.algorithmAcceptanceTest
    "scripts.functionalGoLiveReadinessTest" = $Manifest.scripts.functionalGoLiveReadinessTest
    "scripts.functionalScenarioEvidenceGenerator" = $Manifest.scripts.functionalScenarioEvidenceGenerator
    "scripts.functionalAcceptanceWorkspaceInitializer" = $Manifest.scripts.functionalAcceptanceWorkspaceInitializer
    "scripts.functionalAcceptanceWorkspaceContractTest" = $Manifest.scripts.functionalAcceptanceWorkspaceContractTest
    "scripts.functionalScenarioEvidenceAttacher" = $Manifest.scripts.functionalScenarioEvidenceAttacher
    "scripts.functionalScenarioAttachmentContractTest" = $Manifest.scripts.functionalScenarioAttachmentContractTest
    "scripts.algorithmTraceabilityTest" = $Manifest.scripts.algorithmTraceabilityTest
    "scripts.installRuntimeService" = $Manifest.scripts.installRuntimeService
    "scripts.uninstallRuntimeService" = $Manifest.scripts.uninstallRuntimeService
    "scripts.runtimeUiSmokeTest" = $Manifest.scripts.runtimeUiSmokeTest
    "scripts.realHardwareAcceptanceTest" = $Manifest.scripts.realHardwareAcceptanceTest
    "scripts.realCalibrationAcceptanceTest" = $Manifest.scripts.realCalibrationAcceptanceTest
    "scripts.realCalibrationCrashRecoveryTest" = $Manifest.scripts.realCalibrationCrashRecoveryTest
    "scripts.realCalibrationIntegrityGenerationTest" = $Manifest.scripts.realCalibrationIntegrityGenerationTest
    "scripts.productionStabilityTest" = $Manifest.scripts.productionStabilityTest
    "scripts.productionStabilityWorkRootContractTest" = $Manifest.scripts.productionStabilityWorkRootContractTest
    "scripts.databaseBackup" = $Manifest.scripts.databaseBackup
    "scripts.databaseRestore" = $Manifest.scripts.databaseRestore
    "scripts.reportArchiveRecovery" = $Manifest.scripts.reportArchiveRecovery
    "scripts.reportArchiveRecoveryTest" = $Manifest.scripts.reportArchiveRecoveryTest
    "scripts.databaseRecoveryCommon" = $Manifest.scripts.databaseRecoveryCommon
    "scripts.databaseContractVerify" = $Manifest.scripts.databaseContractVerify
    "scripts.databaseContractTest" = $Manifest.scripts.databaseContractTest
    "scripts.releaseSbomStaticVerify" = $Manifest.scripts.releaseSbomStaticVerify
    "scripts.barSurfaceE2ETest" = $Manifest.scripts.barSurfaceE2ETest
    "scripts.clientStatic" = $Manifest.scripts.clientStatic
    "scripts.stop" = $Manifest.scripts.stop
    "algorithm.core" = $Manifest.algorithm.core
  }

  foreach ($Entry in $RequiredManifestValues.GetEnumerator()) {
    if ([string]::IsNullOrWhiteSpace([string]$Entry.Value)) {
      throw "Runtime manifest missing $($Entry.Key)"
    }
    $ExpectedPath = Resolve-PackagePath $PackageDir ([string]$Entry.Value)
    Assert-PathExists $ExpectedPath "Runtime manifest points to missing file for $($Entry.Key): $ExpectedPath" "Leaf"
  }

  if ($IsFormalPackage -or $AllowPackageExecution) {
    $MigrationArchitectureTest = Resolve-PackagePath $PackageDir $Manifest.scripts.migrationArchitectureTest
    $MigrationArchitectureReportText = (& $MigrationArchitectureTest -ManifestPath $ManifestPath | Out-String)
    $MigrationArchitectureReport = $MigrationArchitectureReportText | ConvertFrom-Json
    if ($MigrationArchitectureReport.code -ne 0) {
      throw "Packaged runtime failed the architecture migration contract."
    }
  }

  $ScriptNames = @(
    "run-capture-headless.ps1",
    "run-service-external.ps1",
    "run-service-simulated.ps1",
    "run-trigger-gateway.ps1",
    "run-integrated-capture-management.ps1",
    "test-integrated-capture-management-full.ps1",
    "test-integrated-acceptance-audit.ps1",
    "test-architecture-migration-contract.ps1",
    "test-integrated-management-smoke.ps1",
    "test-integrated-runtime-ready.ps1",
    "test-trigger-gateway-security.ps1",
    "test-runtime-acceptance.ps1",
    "test-real-hardware-acceptance.ps1",
    "test-real-calibration-acceptance.ps1",
    "test-real-calibration-crash-recovery.ps1",
    "test-real-calibration-integrity-generation.ps1",
    "test-production-stability.ps1",
    "test-production-stability-workroot-contract.ps1",
    "backup-database.ps1",
    "restore-database.ps1",
    "manage-report-archives.ps1",
    "test-report-archive-recovery.ps1",
    "database-recovery-common.ps1",
    "verify-database-migration-contract.ps1",
    "test-database-migration-contract.ps1",
    "test-runtime-ui-smoke.ps1",
    "scripts\test-bar-surface-e2e.ps1",
    "test-runtime-layout.ps1",
    "verify-independent-architecture.ps1",
    "verify-runtime-package.ps1",
    "verify-packaged-release-sbom.ps1",
    "test-runtime-supervisor.ps1",
    "test-algorithm-acceptance-report.ps1",
    "install-runtime-service.ps1",
    "uninstall-runtime-service.ps1",
    "run-client-static.ps1",
    "stop-runtime.ps1"
  )
  foreach ($Script in $ScriptNames) {
    Assert-PowerShellScriptParses (Join-Path $PackageDir $Script)
  }
  if ($IsFormalPackage -or $AllowPackageExecution) {
    $PythonTraceabilityTest = Join-Path $PackageDir "scripts\test_algorithm_traceability.py"
    & python -B $PythonTraceabilityTest
    if ($LASTEXITCODE -ne 0) {
      throw "Packaged Python algorithm traceability contract test failed."
    }
  }

  $IntegratedScript = Join-Path $PackageDir "run-integrated-capture-management.ps1"
  $IntegratedText = Get-Content $IntegratedScript -Raw
  foreach ($RequiredText in @("/health", "/api/production/status", "/api/trigger/status", "run-trigger-gateway.ps1", "run-client-static.ps1", "StopExisting", "stop-runtime.ps1", "Wait-HttpHtml", "Client ready", "Assert-CaptureProviderMatches", "storageRoot", "configRoot")) {
    if ($IntegratedText -notmatch [regex]::Escape($RequiredText)) {
      throw "Integrated runtime script must wait for or invoke $RequiredText"
    }
  }

  foreach ($CaptureScriptName in @("run-capture-headless.ps1", "run-integrated-capture-management.ps1")) {
    $CaptureScript = Join-Path $PackageDir $CaptureScriptName
    if (-not (Test-Path $CaptureScript -PathType Leaf)) {
      continue
    }
    $CaptureText = Get-Content $CaptureScript -Raw
    if ($CaptureText -match [regex]::Escape("H:\steel-capture-data")) {
      throw "Packaged $CaptureScriptName must not default to H:\steel-capture-data; production frames must land under H:\camera1..camera8."
    }
    $RequiredStorageTexts = if ($CaptureScriptName -eq "run-integrated-capture-management.ps1") {
      @('[string]$StorageRoot = "H:\"', '[string]$CameraStorageRoot = "H:\"', "-CameraStorageRoot")
    } else {
      @('[string]$StorageRoot = "H:\"', '[string]$CameraStorageRoot = "H:\"', '$env:CAPTURE_CAMERA_STORAGE_ROOT = $CameraStorageRoot')
    }
    foreach ($RequiredText in $RequiredStorageTexts) {
      if ($CaptureText -notmatch [regex]::Escape($RequiredText)) {
        throw "Packaged $CaptureScriptName must keep the H:\ production storage default via $RequiredText"
      }
    }
  }

  $StopScript = Join-Path $PackageDir "stop-runtime.ps1"
  $StopText = Get-Content $StopScript -Raw
  foreach ($RequiredText in @("Get-NetTCPConnection", "netstat -ano", "1432", ".Id -gt 4", '-ne $PID')) {
    if ($StopText -notmatch [regex]::Escape($RequiredText)) {
      throw "Packaged stop-runtime.ps1 must stop static-client listeners by port using $RequiredText"
    }
  }

  $SmokeScript = Join-Path $PackageDir "test-integrated-management-smoke.ps1"
  $SmokeText = Get-Content $SmokeScript -Raw
  foreach ($RequiredText in @("run-service-simulated.ps1", "/api/production/tasks/steel-info", "/api/production/tasks/steel-in", "/api/production/tasks/steel-out", "/api/production/tasks", "/api/production/tasks/detail", "/api/trigger/manual/steel-in", "recordWrittenBeforeCapture", "/api/system/network", "totalUploadMbps", "totalDownloadMbps", "totalBandwidthMbps", "uploadMbps", "downloadMbps", "rateFields", "/api/production/capture-once", "captureGuard", "captureOnce", "captureFileRows", "durableTasks", "chainId", "dependsOnTaskId", "dependencyPolicy", "require-success", "dependencyOrder", "requestId", "RunId", 'runs\$RunId\work', "steel-runtime-package-smoke", "-ConfigRoot", '[string]$WorkRoot', "Write-SmokeReport", "reportPath", "startedProcesses", "startedListeners", "exit 0")) {
    if ($SmokeText -notmatch [regex]::Escape($RequiredText)) {
      throw "Integrated smoke test must verify $RequiredText"
    }
  }

  foreach ($ServiceScriptName in @("run-service-simulated.ps1", "run-service-external.ps1")) {
    $ServiceScript = Join-Path $PackageDir $ServiceScriptName
    $ServiceText = Get-Content $ServiceScript -Raw
  foreach ($RequiredText in @('[string]$ConfigRoot', '$env:STEEL_SERVICE_CONFIG_DIR = $ConfigRoot')) {
    if ($ServiceText -notmatch [regex]::Escape($RequiredText)) {
      throw "Packaged $ServiceScriptName must support isolated service config roots via $RequiredText"
    }
  }
  foreach ($RequiredText in @('$env:STEEL_WORKSPACE_ROOT = $Root', '$env:STEEL_BAR_SURFACE_CORE_EXE = Join-Path $Root "algorithm-core\steel_bar_surface_core.exe"')) {
    if ($ServiceText -notmatch [regex]::Escape($RequiredText)) {
      throw "Packaged $ServiceScriptName must expose packaged algorithm assets via $RequiredText"
    }
  }
}

  $ReadyScript = Join-Path $PackageDir "test-integrated-runtime-ready.ps1"
  $ReadyText = Get-Content $ReadyScript -Raw
  foreach ($RequiredText in @("/health", "/api/health/details", "/api/production/status", "/api/system/network", "database", "taskWorker", "capture", "calibrationReconciliation", "storage", "trigger", "trigger.required", "totalUploadMbps", "totalDownloadMbps", "totalBandwidthMbps", "uploadMbps", "downloadMbps", "bandwidthMbps", "/api/trigger/status", "?app=terminal")) {
    if ($ReadyText -notmatch [regex]::Escape($RequiredText)) {
      throw "Integrated ready test must verify $RequiredText"
    }
  }

  $IntegratedFullScript = Join-Path $PackageDir "test-integrated-capture-management-full.ps1"
  $IntegratedFullText = Get-Content $IntegratedFullScript -Raw
  foreach ($RequiredText in @(
    "steel.integrated-capture-management.acceptance.v1",
    "test-runtime-layout.ps1",
    "test-integrated-runtime-ready.ps1",
    "test-real-hardware-acceptance.ps1",
    "test-real-calibration-acceptance.ps1",
    "test-real-calibration-crash-recovery.ps1",
    "test-real-calibration-integrity-generation.ps1",
    "test-runtime-ui-smoke.ps1",
    "test-bar-surface-e2e.ps1",
    "test-production-stability.ps1",
    "RunCapture",
    "RunCalibrationApplyRollback",
    "CalibrationSafetyConfirmation",
    "ApplyCrashRecoveryReportPath",
    "RollbackCrashRecoveryReportPath",
    "CalibrationIntegrityGenerationReportPath",
    "RunBarSurface",
    "RunShortStability",
    "StabilityDurationSec",
    "StabilityIntervalSec",
    "StabilityRunAlgorithmEvery",
    "StabilityUseTriggerGateway",
    "RequireFullCoverage",
    "coverage",
    "full =",
    "covered =",
    "required =",
    "uncovered",
    "trigger-gateway-route",
    "production-trigger-security",
    "real-calibration-apply-rollback",
    "real-calibration-crash-recovery",
    "real-calibration-integrity-generation",
    "bar-surface-e2e",
    "integrated-capture-management",
    "reportPath"
  )) {
    if ($IntegratedFullText -notmatch [regex]::Escape($RequiredText)) {
      throw "Integrated full acceptance test must orchestrate $RequiredText"
    }
  }

  $IntegratedAuditScript = Join-Path $PackageDir "test-integrated-acceptance-audit.ps1"
  $IntegratedAuditText = Get-Content $IntegratedAuditScript -Raw
  foreach ($RequiredText in @(
    "steel.integrated-capture-management.acceptance-audit.v1",
    "ICM-01",
    "ICM-23",
    "ICM-24",
    'RequiredCount = 24',
    "test-architecture-migration-contract.ps1",
    "integratedReportPath",
    "tenMinuteReportPath",
    "acceptance-audit",
    "MinEnduranceCycles",
    "estimated-speed fallback",
    "calibrated-3d",
    "sdkDerived",
    "trigger-gateway-route",
    "trigger-security",
    "HMAC-SHA256",
    "verify-independent-architecture.ps1"
  )) {
    if ($IntegratedAuditText -notmatch [regex]::Escape($RequiredText)) {
      throw "Integrated acceptance audit must verify $RequiredText"
    }
  }

  $IntegratedAcceptanceDoc = Join-Path $PackageDir "docs\integrated-capture-management-acceptance.md"
  Assert-PathExists (Join-Path $PackageDir "docs\release-deployment-and-operations.md") "Runtime package is missing the release deployment and operations runbook." "Leaf"
  Assert-PathExists (Join-Path $PackageDir "docs\production-readiness-gap-and-closure-design.md") "Runtime package is missing the production readiness closure design." "Leaf"
  $AtomicUpgradeDoc = Join-Path $PackageDir "docs\atomic-upgrade-and-database-migration-design.md"
  Assert-PathExists $AtomicUpgradeDoc "Runtime package is missing the atomic upgrade and database migration design." "Leaf"
  Assert-PathExists (Join-Path $PackageDir "scripts\README.md") "Runtime package is missing the script usage runbook at scripts/README.md." "Leaf"
  $AtomicUpgradeDocText = Get-Content $AtomicUpgradeDoc -Raw
  foreach ($RequiredText in @(
    "Global\SteelInspectionRuntime-Deployment",
    "steel.database-backup.v2",
    "failed-safe",
    "P0 No-Go"
  )) {
    if ($AtomicUpgradeDocText -notmatch [regex]::Escape($RequiredText)) {
      throw "Packaged atomic upgrade and database migration design must document $RequiredText"
    }
  }
  Assert-PathExists $IntegratedAcceptanceDoc "Runtime package must include integrated capture management acceptance matrix." "Leaf"
  $IntegratedAcceptanceDocText = Get-Content $IntegratedAcceptanceDoc -Raw
  foreach ($RequiredText in @(
    "Integrated Capture Management Acceptance Matrix",
    "RequireFullCoverage",
    "coverage.full",
    "coverage.covered",
    "coverage.required",
    "ICM-01",
    "ICM-23",
    "ICM-24",
    "summary.passed=24",
    "test-architecture-migration-contract.ps1",
    "H:\camera1",
    "integrated-capture-management-20260709-121522-831.json",
    "BAR-STABILITY-20260709-121618-010",
    "BAR-STABILITY-20260709-114929-127",
    "production-stability-20260709-114934-134.json",
    "estimated-speed fallback",
    "calibrated-3d"
  )) {
    if ($IntegratedAcceptanceDocText -notmatch [regex]::Escape($RequiredText)) {
      throw "Integrated acceptance matrix must document $RequiredText"
    }
  }

  $UiSmokeScript = Join-Path $PackageDir "test-runtime-ui-smoke.ps1"
  $UiSmokeText = Get-Content $UiSmokeScript -Raw
  foreach ($RequiredText in @(
    "steel.runtime.ui-smoke.v1",
    "Target.createTarget",
    "Page.captureScreenshot",
    "receiver-status-button",
    "\u5b9e\u65f6\u4e0a\u4f20",
    "\u5b9e\u65f6\u4e0b\u8f7d",
    "\u5e26\u5bbd\u76d1\u63a7",
    "Windows \u7f51\u5361\u5b9e\u65f6\u6536\u53d1\u901f\u7387",
    "network monitor pending",
    "network monitor offline",
    "\u4f30\u7b97\u7f51\u901f",
    "terminal",
    "capture",
    "bar-surface",
    "ui-smoke-report.json",
    "msedge.exe",
    "chrome.exe"
  )) {
    if ($UiSmokeText -notmatch [regex]::Escape($RequiredText)) {
      throw "Runtime UI smoke test must verify $RequiredText"
    }
  }

  $AcceptanceScript = Join-Path $PackageDir "test-runtime-acceptance.ps1"
  $AcceptanceText = Get-Content $AcceptanceScript -Raw
  foreach ($RequiredText in @("test-runtime-layout.ps1", "test-integrated-management-smoke.ps1", "Stop-AcceptancePorts", "Get-NetTCPConnection", "netstat -ano", "SteelInspectionRuntimeAcceptance", "Assert-SmokeResult", "Read-JsonFromOutput", "reportPath", "totalUploadMbps", "totalDownloadMbps", "totalBandwidthMbps", "rateFields", "captureGuard", "captureOnce", "captureFileRows")) {
    if ($AcceptanceText -notmatch [regex]::Escape($RequiredText)) {
      throw "Runtime acceptance test must verify $RequiredText"
    }
  }

  $RealHardwareScript = Join-Path $PackageDir "test-real-hardware-acceptance.ps1"
  $RealHardwareText = Get-Content $RealHardwareScript -Raw
  foreach ($RequiredText in @("/api/production/capture-once", "/api/system/network", "totalUploadMbps", "totalDownloadMbps", "totalBandwidthMbps", "uploadMbps", "downloadMbps", "H:\camera", "saveSdkDerived", "productionLayout", "steel.production.summary.v1", "captureFiles")) {
    if ($RealHardwareText -notmatch [regex]::Escape($RequiredText)) {
      throw "Real hardware acceptance test must verify $RequiredText"
    }
  }

  $RealCalibrationScript = Join-Path $PackageDir "test-real-calibration-acceptance.ps1"
  $RealCalibrationText = Get-Content $RealCalibrationScript -Raw
  foreach ($RequiredText in @("steel.real-calibration.acceptance.v1", "/api/calibration/apply-all", "/api/calibration/rollback", "/api/calibration/operations/detail", "SafetyConfirmation", "/api/capture/continuous-test", "calibrationReconciliation")) {
    if ($RealCalibrationText -notmatch [regex]::Escape($RequiredText)) {
      throw "Real calibration acceptance test must verify $RequiredText"
    }
  }

  $RealCalibrationCrashScript = Join-Path $PackageDir "test-real-calibration-crash-recovery.ps1"
  $RealCalibrationCrashText = Get-Content $RealCalibrationCrashScript -Raw
  foreach ($RequiredText in @("steel.real-calibration.crash-recovery.v1", "ApplyCrash", "RollbackCrash", "calibrationCrashFailpointArmed", "expectedApplyOperationId", "parentOperationId", "reconciled")) {
    if ($RealCalibrationCrashText -notmatch [regex]::Escape($RequiredText)) {
      throw "Real calibration crash-recovery test must verify $RequiredText"
    }
  }

  $RealCalibrationIntegrityScript = Join-Path $PackageDir "test-real-calibration-integrity-generation.ps1"
  $RealCalibrationIntegrityText = Get-Content $RealCalibrationIntegrityScript -Raw
  foreach ($RequiredText in @("steel.real-calibration.integrity-generation.v1", "sideEffects", "zeroWriteEvidence", "staleGeneration", "stagedTamper")) {
    if ($RealCalibrationIntegrityText -notmatch [regex]::Escape($RequiredText)) {
      throw "Real calibration integrity/generation test must verify $RequiredText"
    }
  }

  $ProductionStabilityScript = Join-Path $PackageDir "test-production-stability.ps1"
  $ProductionStabilityText = Get-Content $ProductionStabilityScript -Raw
  foreach ($RequiredText in @("/api/production/steel-in", "/api/production/capture-once", "/api/production/steel-out", "/api/production/algorithm/run", "/api/system/network", "/api/trigger/manual/steel-in", "/api/trigger/capture-once", "UseTriggerGateway", "triggerRoute", "totalUploadMbps", "totalDownloadMbps", "totalBandwidthMbps", "uploadMbps", "downloadMbps", "steel.production.stability.v1", "steel.production.summary.v1", "H:\", "RunAlgorithmEvery", "activeSession", "sdkDerived", '[string]$WorkRoot', '[string]$ReleaseManifestPath', "manifestSha256", "steel-runtime-package-stability", "queueDepthAvailable", "activeTaskId", "admission.inFlight", "identityBinding", "identityIsolation", "finalConvergence")) {
    if ($ProductionStabilityText -notmatch [regex]::Escape($RequiredText)) {
      throw "Production stability test must verify $RequiredText"
    }
  }

  Assert-PathExists (Join-Path $PackageDir "scripts\bar_surface_reconstruct.py") "Runtime package is missing bar surface reconstruction script." "Leaf"
  Assert-PathExists (Join-Path $PackageDir "scripts\fit_array_calibration_cross_section.py") "Runtime package is missing calibration fit script." "Leaf"
  Assert-PathExists (Join-Path $PackageDir "algorithm-core\steel_bar_surface_core.exe") "Runtime package is missing bar surface C++ core executable." "Leaf"
  $BarSurfaceScript = Join-Path $PackageDir "scripts\test-bar-surface-e2e.ps1"
  $BarSurfaceText = Get-Content $BarSurfaceScript -Raw
  foreach ($RequiredText in @("/api/production/algorithm/run", "/api/algorithm/bar-surface/latest", "captureSummary", "steel.production.summary.v1", "coreOutputBytes", "sdkDerived", "contourCrop")) {
    if ($BarSurfaceText -notmatch [regex]::Escape($RequiredText)) {
      throw "Bar surface E2E test must verify $RequiredText"
    }
  }

  $BarSurfaceAlgorithmScript = Join-Path $PackageDir "scripts\bar_surface_reconstruct.py"
  $BarSurfaceAlgorithmText = Get-Content $BarSurfaceAlgorithmScript -Raw
  foreach ($RequiredText in @(
    '("camera1", "192.168.101.100", "3G506601BE09220")',
    '("camera2", "192.168.102.100", "3G506501CA09164")',
    '("camera3", "192.168.103.100", "3G506401RE08999")',
    '("camera4", "192.168.104.100", "YF-0270")',
    '("camera5", "192.168.105.100", "3G506601BE09221")',
    '("camera6", "192.168.106.100", "3G506501CA09163")',
    '("camera7", "192.168.107.100", "3G506401RE08995")',
    '("camera8", "192.168.108.100", "YF-0269")',
    'metadata_text(frame.metadata, "sn", "serial", "cameraSn")',
    'metadata_text(frame.metadata, "ip", "cameraIp")'
  )) {
    if ($BarSurfaceAlgorithmText -notmatch [regex]::Escape($RequiredText)) {
      throw "Packaged bar_surface_reconstruct.py must preserve current eight-camera metadata/calibration mapping via $RequiredText"
    }
  }
}

function Test-PackagedClientStaticServer {
  param([Parameter(Mandatory = $true)][string]$PackageDir)

  $PackageDir = (Resolve-Path -LiteralPath $PackageDir -ErrorAction Stop).Path
  $ClientScript = Join-Path $PackageDir "run-client-static.ps1"
  if (-not (Test-Path $ClientScript -PathType Leaf)) {
    throw "Missing packaged client static server script: $ClientScript"
  }

  $Port = Get-FreeLocalPort
  $LogDir = Join-Path $RepoRoot "target\logs\verify"
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $OutLog = Join-Path $LogDir "client-static.out.log"
  $ErrLog = Join-Path $LogDir "client-static.err.log"
  Remove-Item $OutLog, $ErrLog -ErrorAction SilentlyContinue
  Normalize-ProcessPathEnvironment
  $Process = Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $ClientScript,
    "-Port",
    [string]$Port
  ) -WorkingDirectory $PackageDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog

  try {
    $Ready = $false
    for ($i = 0; $i -lt 60; $i++) {
      if ($Process.HasExited) {
        break
      }
      Start-Sleep -Milliseconds 500
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
      $OutText = Get-Content $OutLog -Raw -ErrorAction SilentlyContinue
      $ErrText = Get-Content $ErrLog -Raw -ErrorAction SilentlyContinue
      throw "Packaged client static server did not serve index.html on port $Port. stdout: $OutText stderr: $ErrText"
    }
  } finally {
    if ($Process -and -not $Process.HasExited) {
      Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    }
  }
}

if ($PackageOnly) {
  if ([string]::IsNullOrWhiteSpace($ExistingPackageDir)) {
    throw "-PackageOnly requires -ExistingPackageDir."
  }
  Test-PackagedRuntimeContract `
    -PackageDir $ExistingPackageDir `
    -RequireFormal:$RequireFormalPackage `
    -ApprovedFirstPartyThumbprint $ExpectedFirstPartyThumbprint `
    -ApprovedVendorSdkSignerThumbprints $AllowedVendorSdkSignerThumbprints `
    -ApprovedPublisher $ExpectedPublisher `
    -ApprovedReleasePolicySha256 $ExpectedReleasePolicySha256 `
    -ApprovedBundleToolchainManifestSha256 $ExpectedBundleToolchainManifestSha256 `
    -ApprovedExternalComponentsSha256 $ExpectedExternalComponentsSha256 `
    -AllowPackageExecution:$AllowPackageCodeExecution
  $ExistingManifest = Get-Content -LiteralPath (Join-Path $ExistingPackageDir 'manifest.json') -Raw | ConvertFrom-Json
  $PackageExecutionTrusted = [string]$ExistingManifest.packageClass -ceq 'formal-release' -or $AllowPackageCodeExecution
  if (-not $SkipPackagedClientSmoke -and $PackageExecutionTrusted) {
    Test-PackagedClientStaticServer -PackageDir $ExistingPackageDir
  }
  Write-Host "Existing runtime package verification passed."
  return
}
if (-not [string]::IsNullOrWhiteSpace($ExistingPackageDir) -or $RequireFormalPackage) {
  throw "Existing-package and formal-package options require -PackageOnly."
}

Write-Host "Checking client/runtime boundaries..."
Assert-NoMatches "NVT_LVM_SDK_ROOT|nvt_lvm_sdk|capture_sdk|rustc-link-lib" (Join-Path $ClientDir "src-tauri") "Tauri client must not link or copy the camera SDK."
Assert-NoMatches "dev:service|service:build|service:start|capture:configure|capture:build|capture:start" (Join-Path $ClientDir "package.json") "Client package scripts must not start services or build capture providers."
Assert-NoMatches "dev-with-service|scripts/cmake" $ClientDir "Client must not keep integrated backend/capture build scripts."
Assert-PathExists (Join-Path $RepoRoot "app\trigger\Cargo.toml") "Standalone trigger gateway project must live under app/trigger." "Leaf"
Assert-PathExists (Join-Path $RepoRoot "scripts\build-trigger-gateway.ps1") "Missing trigger gateway build script." "Leaf"
Assert-PathExists (Join-Path $RepoRoot "scripts\start-integrated-capture-management.ps1") "Missing source integrated capture-management startup script." "Leaf"
$MigrationArchitectureTest = Join-Path $RepoRoot "scripts\test-architecture-migration-contract.ps1"
Assert-PowerShellScriptParses $MigrationArchitectureTest
$MigrationArchitectureReportText = (& $MigrationArchitectureTest -RepoRoot ([string]$RepoRoot) | Out-String)
$MigrationArchitectureReport = $MigrationArchitectureReportText | ConvertFrom-Json
if ($MigrationArchitectureReport.code -ne 0) {
  throw "Source tree failed the architecture migration contract."
}
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\start-integrated-capture-management.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-integrated-capture-management-full.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-integrated-management-smoke.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-integrated-runtime-ready.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-runtime-acceptance.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-real-hardware-acceptance.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-real-calibration-acceptance.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-real-calibration-crash-recovery.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-real-calibration-integrity-generation.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-production-stability.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-production-stability-workroot-contract.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-bar-surface-e2e.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-runtime-layout.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\test-runtime-ui-smoke.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\run-service.ps1")
Assert-PowerShellScriptParses (Join-Path $RepoRoot "scripts\run-trigger-gateway.ps1")
$DatabaseContractVerifier = Join-Path $RepoRoot "scripts\verify-database-migration-contract.ps1"
$DatabaseContractTest = Join-Path $RepoRoot "scripts\test-database-migration-contract.ps1"
$TrackedDatabaseContract = Join-Path $RepoRoot "config\release\database\contract.json"
$TrackedDatabaseMigrationIndex = Join-Path $RepoRoot "config\release\database\migrations\index.json"
Assert-PowerShellScriptParses $DatabaseContractVerifier
Assert-PowerShellScriptParses $DatabaseContractTest
$TrackedDatabaseReportText = (& $DatabaseContractVerifier `
  -ContractPath $TrackedDatabaseContract `
  -IndexPath $TrackedDatabaseMigrationIndex | Out-String)
$TrackedDatabaseReport = $TrackedDatabaseReportText | ConvertFrom-Json
if ($TrackedDatabaseReport.code -ne 0 -or
    [long]$TrackedDatabaseReport.schemaVersion -ne 1 -or
    [int]$TrackedDatabaseReport.migrationCount -ne 0) {
  throw "Tracked database contract/index must declare the validated initial schema v1 with no upgrade entries."
}
$DatabaseContractTestText = (& $DatabaseContractTest | Out-String)
$DatabaseContractTestReport = $DatabaseContractTestText | ConvertFrom-Json
foreach ($RequiredDatabaseTest in @(
  'serviceSchemaVersionBinding',
  'positive',
  'packagePositive',
  'canonicalPathRejection',
  'payloadHashRejection',
  'indexHashRejection',
  'engineRejection',
  'discontinuousChainRejection',
  'duplicateChainRejection',
  'reversibleFieldRejection',
  'manifestBindingRejection'
)) {
  if ($DatabaseContractTestReport.code -ne 0 -or
      [string]$DatabaseContractTestReport.$RequiredDatabaseTest -cne 'passed') {
    throw "Database contract negative test failed: $RequiredDatabaseTest"
  }
}
$ReleaseSbomCommon = Join-Path $RepoRoot "scripts\release-sbom-common.ps1"
$ReleaseSbomGenerator = Join-Path $RepoRoot "scripts\generate-release-sbom.ps1"
$ReleaseSbomVerifier = Join-Path $RepoRoot "scripts\verify-release-sbom.ps1"
$ReleaseSbomTest = Join-Path $RepoRoot "scripts\test-release-sbom.ps1"
$PackagedReleaseSbomVerifier = Join-Path $RepoRoot "scripts\verify-packaged-release-sbom.ps1"
$PackagedReleaseSbomTest = Join-Path $RepoRoot "scripts\test-packaged-release-sbom.ps1"
foreach ($SbomScript in @(
  $ReleaseSbomCommon,
  $ReleaseSbomGenerator,
  $ReleaseSbomVerifier,
  $ReleaseSbomTest,
  $PackagedReleaseSbomVerifier,
  $PackagedReleaseSbomTest
)) {
  Assert-PowerShellScriptParses $SbomScript
}
$ReleaseSbomTestText = (& $ReleaseSbomTest | Out-String)
$ReleaseSbomTestReport = $ReleaseSbomTestText | ConvertFrom-Json
$ExpectedReleaseSbomCases = @(
  [ordered]@{ name = 'offline generation with all six external categories'; expected = 'success' },
  [ordered]@{ name = 'offline semantic verification'; expected = 'success' },
  [ordered]@{ name = 'second deterministic generation'; expected = 'success' },
  [ordered]@{ name = 'deterministic output hash'; expected = 'identical' },
  [ordered]@{ name = 'tampered SBOM component rejected'; expected = 'failure' },
  [ordered]@{ name = 'tampered generator environment rejected'; expected = 'failure' },
  [ordered]@{ name = 'changed lock hash rejected'; expected = 'failure' },
  [ordered]@{ name = 'dirty source rejected by default'; expected = 'failure' },
  [ordered]@{ name = 'SBOM input overwrite rejected'; expected = 'failure' },
  [ordered]@{ name = 'missing external category rejected'; expected = 'failure' },
  [ordered]@{ name = 'out-of-band external policy hash mismatch rejected'; expected = 'failure' }
)
if ([string]$ReleaseSbomTestReport.schema -cne 'steel.release-sbom-test.v1' -or
    $ReleaseSbomTestReport.code -ne 0 -or
    $ReleaseSbomTestReport.offline -ne $true -or
    [int]$ReleaseSbomTestReport.total -ne 11 -or
    [int]$ReleaseSbomTestReport.passed -ne 11 -or
    @($ReleaseSbomTestReport.cases).Count -ne 11 -or
    @($ReleaseSbomTestReport.cases | Where-Object { $_.passed -ne $true }).Count -ne 0) {
  throw "Offline release SBOM generation and semantic verification contract failed."
}
for ($CaseIndex = 0; $CaseIndex -lt $ExpectedReleaseSbomCases.Count; $CaseIndex++) {
  $ActualCase = @($ReleaseSbomTestReport.cases)[$CaseIndex]
  $ExpectedCase = $ExpectedReleaseSbomCases[$CaseIndex]
  if ([string]$ActualCase.name -cne [string]$ExpectedCase.name -or
      [string]$ActualCase.expected -cne [string]$ExpectedCase.expected -or
      $ActualCase.passed -ne $true) {
    throw "Offline release SBOM test case order or outcome changed at index $CaseIndex."
  }
}
$PackagedReleaseSbomTestText = (& $PackagedReleaseSbomTest | Out-String)
$PackagedReleaseSbomTestReport = $PackagedReleaseSbomTestText | ConvertFrom-Json
if ([string]$PackagedReleaseSbomTestReport.schema -cne 'steel.packaged-release-sbom-test.v1' -or
    $PackagedReleaseSbomTestReport.code -ne 0 -or
    [string]$PackagedReleaseSbomTestReport.formalPositive -cne 'passed' -or
    [string]$PackagedReleaseSbomTestReport.sbomTamperRejection -cne 'passed') {
  throw "Packaged formal SBOM static verification contract failed."
}
$BundleToolchainProvisioner = Join-Path $RepoRoot "scripts\provision-tauri-bundle-toolchain.ps1"
$BundleToolchainManifestGenerator = Join-Path $RepoRoot "scripts\new-tauri-bundle-toolchain-manifest.ps1"
$BundleToolchainProvisioningTest = Join-Path $RepoRoot "scripts\test-tauri-bundle-toolchain-provisioning.ps1"
$PackageRuntimeScript = Join-Path $RepoRoot "scripts\package-runtime.ps1"
Assert-PowerShellScriptParses $BundleToolchainProvisioner
Assert-PowerShellScriptParses $BundleToolchainManifestGenerator
Assert-PowerShellScriptParses $BundleToolchainProvisioningTest
Assert-PowerShellScriptParses $PackageRuntimeScript
$PackageRuntimeScriptText = Get-Content -LiteralPath $PackageRuntimeScript -Raw
foreach ($RequiredBundleToolchainGate in @(
  'TAURI_BUNDLE_TOOLCHAIN_ROOT',
  'STEEL_BUNDLE_TOOLCHAIN_MANIFEST_SHA256',
  '-SourceOnly',
  '-VerifyOnly'
)) {
  if ($PackageRuntimeScriptText -notmatch [regex]::Escape($RequiredBundleToolchainGate)) {
    throw "Formal packaging is missing the offline bundle toolchain gate: $RequiredBundleToolchainGate"
  }
}
foreach ($RequiredSbomGate in @(
  'STEEL_EXTERNAL_COMPONENTS_PATH',
  'STEEL_EXTERNAL_COMPONENTS_SHA256',
  'generate-release-sbom.ps1',
  'verify-release-sbom.ps1',
  'steel-release-sbom.cdx.json',
  'verify-packaged-release-sbom.ps1'
)) {
  if ($PackageRuntimeScriptText -notmatch [regex]::Escape($RequiredSbomGate)) {
    throw "Formal packaging is missing the offline SBOM gate: $RequiredSbomGate"
  }
}
$BundleToolchainProvisioningReportText = (& $BundleToolchainProvisioningTest | Out-String)
$BundleToolchainProvisioningReport = $BundleToolchainProvisioningReportText | ConvertFrom-Json
if ($BundleToolchainProvisioningReport.code -ne 0 -or
    [string]$BundleToolchainProvisioningReport.manifestGeneration -cne 'passed' -or
    [string]$BundleToolchainProvisioningReport.manifestOverwriteGuard -cne 'passed' -or
    [string]$BundleToolchainProvisioningReport.componentPrefixGuard -cne 'passed' -or
    [string]$BundleToolchainProvisioningReport.unmappedFileGuard -cne 'passed' -or
    [string]$BundleToolchainProvisioningReport.sourceOnlyValidation -cne 'passed' -or
    [string]$BundleToolchainProvisioningReport.exactInventory -cne 'passed' -or
    [string]$BundleToolchainProvisioningReport.tamperRejection -cne 'passed' -or
    [string]$BundleToolchainProvisioningReport.extraDirectoryRejection -cne 'passed' -or
    [string]$BundleToolchainProvisioningReport.extraFileRejection -cne 'passed' -or
    [string]$BundleToolchainProvisioningReport.outOfBandHashRejection -cne 'passed') {
  throw "Offline bundle toolchain provisioning contract failed."
}

$TauriConfigPath = Join-Path $ClientDir "src-tauri\tauri.conf.json"
$ReleasePolicyPath = Join-Path $RepoRoot "config\release\desktop-release-policy.json"
$SourceCargoConfigPath = Join-Path $RepoRoot ".cargo\config.toml"
try {
  $TauriConfig = Get-Content $TauriConfigPath -Raw | ConvertFrom-Json
} catch {
  throw "Tauri config must be valid JSON: $TauriConfigPath"
}
try {
  $ReleasePolicy = Get-Content -LiteralPath $ReleasePolicyPath -Raw | ConvertFrom-Json
} catch {
  throw "Desktop release policy must be valid JSON: $ReleasePolicyPath"
}
if ([string]$ReleasePolicy.schema -cne 'steel.desktop-release-policy.v1' -or
    [string]::IsNullOrWhiteSpace([string]$ReleasePolicy.publisher) -or
    [string]::IsNullOrWhiteSpace([string]$ReleasePolicy.contentSecurityPolicy) -or
    [string]$ReleasePolicy.rustTarget -cne 'x86_64-pc-windows-msvc' -or
    [string]$ReleasePolicy.cargoConfigSha256 -cne (Get-FileHash -LiteralPath $SourceCargoConfigPath -Algorithm SHA256).Hash.ToLowerInvariant() -or
    [string]$ReleasePolicy.tauriConfigSha256 -cne (Get-FileHash -LiteralPath $TauriConfigPath -Algorithm SHA256).Hash.ToLowerInvariant() -or
    [string]$ReleasePolicy.tauriCargoSha256 -cne (Get-FileHash -LiteralPath (Join-Path $ClientDir 'src-tauri\Cargo.toml') -Algorithm SHA256).Hash.ToLowerInvariant() -or
    @($ReleasePolicy.PSObject.Properties.Name) -cnotcontains 'cargoFeatures' -or
    @($ReleasePolicy.cargoFeatures).Count -ne 0 -or
    $ReleasePolicy.devtools -ne $false) {
  throw "Desktop release policy must bind the approved publisher, CSP, Rust target, and devtools-off decision."
}
$SourceTauriConfigVariants = @(Get-ChildItem -LiteralPath (Split-Path -Parent $TauriConfigPath) -File -Force | Where-Object {
  $_.Name -imatch '^tauri.*(?:\.conf\.json5?|\.toml)$' -and $_.Name -cne 'tauri.conf.json'
})
if ($SourceTauriConfigVariants.Count -gt 0) {
  throw "Source tree contains an automatically merged, unreviewed Tauri config variant: $($SourceTauriConfigVariants.Name -join ', ')"
}

if ([string]$TauriConfig.build.beforeDevCommand -cne [string]$ReleasePolicy.beforeDevCommand) {
  throw "Tauri beforeDevCommand must only start the frontend dev server."
}
if ([string]$TauriConfig.build.beforeBuildCommand -cne [string]$ReleasePolicy.beforeBuildCommand) {
  throw "Tauri beforeBuildCommand must only build the frontend."
}
if ($TauriConfig.bundle.active -ne $true) {
  throw "Tauri production bundling must be active."
}
if (@($TauriConfig.build.PSObject.Properties.Name) -cnotcontains 'features' -or
    @($TauriConfig.build.features).Count -ne 0) {
  throw "Tauri production build.features must be explicitly present and empty."
}
if ((@($TauriConfig.bundle.targets | Sort-Object) -join ',') -cne (@($ReleasePolicy.targets | Sort-Object) -join ',')) {
  throw "Tauri production bundle must target MSI and NSIS."
}
$SourceCsp = [string]$TauriConfig.app.security.csp
if ($SourceCsp -cne [string]$ReleasePolicy.contentSecurityPolicy) {
  throw "Tauri production client CSP must exactly match the approved desktop release policy."
}
$SourceWindows = @($TauriConfig.app.windows)
if ($SourceWindows.Count -lt 1 -or @($SourceWindows | Where-Object { $_.devtools -ne $ReleasePolicy.devtools }).Count -gt 0) {
  throw "Every Tauri production window must explicitly disable devtools."
}
if ([string]$TauriConfig.bundle.publisher -cne [string]$ReleasePolicy.publisher) {
  throw "Tauri production bundle publisher must exactly match the approved desktop release policy."
}
if ([string]$TauriConfig.bundle.windows.webviewInstallMode.type -cne [string]$ReleasePolicy.webView2InstallMode) {
  throw "Tauri production bundle must embed the offline WebView2 installer."
}
if ($TauriConfig.bundle.windows.allowDowngrades -ne $ReleasePolicy.allowDowngrades) {
  throw "Tauri production bundle must reject version downgrades."
}
if ([string]$TauriConfig.bundle.windows.nsis.installMode -cne [string]$ReleasePolicy.nsisInstallMode) {
  throw "Tauri production NSIS bundle must install per-machine."
}

$TauriCargoPath = Join-Path $ClientDir "src-tauri\Cargo.toml"
$SourceTauriCargoText = Get-Content -LiteralPath $TauriCargoPath -Raw
$SourceTauriReleaseProfile = [regex]::Match($SourceTauriCargoText, '(?ms)^\[profile\.release\]\s*\r?\n(?<body>.*?)(?=^\[|\z)')
if (-not $SourceTauriReleaseProfile.Success -or
    [string]$SourceTauriReleaseProfile.Groups['body'].Value -notmatch '(?m)^debug-assertions\s*=\s*false\s*$' -or
    $SourceTauriCargoText -match '(?m)^\s*\[\s*profile\s*\.\s*release\s*\.' -or
    [string]$SourceTauriReleaseProfile.Groups['body'].Value -match '(?m)^\s*package\s*\.') {
  throw "Tauri release profile must explicitly set debug-assertions=false."
}
$SourceTauriFeatureResolution = Get-TauriFeatureResolution `
  -ManifestPath $TauriCargoPath `
  -RustTarget ([string]$ReleasePolicy.rustTarget)
if (@($SourceTauriFeatureResolution.enabledFeatures) -ccontains 'devtools') {
  throw "Resolved Tauri production features must not enable devtools."
}
$ClientBuildScriptText = Get-Content -LiteralPath (Join-Path $RepoRoot "scripts\build-client.ps1") -Raw
foreach ($RequiredReleaseGate in @(
  "TAURI_WINDOWS_CERTIFICATE_THUMBPRINT",
  "TAURI_WINDOWS_TIMESTAMP_URL",
  "TAURI_CONFIG",
  "CARGO_PROFILE_RELEASE_",
  "CARGO_ENCODED_RUSTFLAGS",
  "RUSTC_WRAPPER",
  "RustTarget",
  '"--target"',
  "AllowUnsignedDesktopBundle",
  '"--locked"'
)) {
  if ($ClientBuildScriptText -notmatch [regex]::Escape($RequiredReleaseGate)) {
    throw "Formal client build script is missing the release gate: $RequiredReleaseGate"
  }
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

if (-not $SkipTriggerTests) {
  Invoke-Checked "cargo" @("test", "--manifest-path", (Join-Path $RepoRoot "app\trigger\Cargo.toml"), "--target-dir", (Join-Path $RepoRoot "target\trigger-test"))
}

if (-not $SkipServiceBuild) {
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-service.ps1"))
}

if (-not $SkipTriggerBuild) {
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-trigger-gateway.ps1"))
}

if (-not $SkipCaptureBuild) {
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\build-capture-headless.ps1"))
}

if (-not $SkipExternalProviderCheck) {
  Invoke-Checked "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\verify-external-provider.ps1"))
}

if (-not $SkipPackage) {
  $PackageArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\package-runtime.ps1"), "-SkipDesktopBundle", "-AllowDirtyWorktree")
  Invoke-Checked "powershell" $PackageArgs
  $GeneratedPackageDir = Join-Path $RepoRoot "target\packages\steel-inspection-runtime"
  Test-PackagedRuntimeContract -PackageDir $GeneratedPackageDir -AllowPackageExecution
  Test-PackagedClientStaticServer -PackageDir $GeneratedPackageDir
}

Write-Host "Independent architecture verification passed."
