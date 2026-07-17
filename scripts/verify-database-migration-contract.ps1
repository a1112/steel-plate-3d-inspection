param(
  [string]$ContractPath = "",
  [string]$IndexPath = "",
  [string]$PackageRoot = "",
  [string]$ManifestPath = ""
)

$ErrorActionPreference = "Stop"

function Assert-ExactProperties {
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
    throw "$Label properties must be exactly: $($Expected -join ', ')."
  }
}

function Assert-JsonInteger {
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

function Assert-CanonicalRelativePath {
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

function Resolve-ContainedFile {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string]$Label
  )

  Assert-CanonicalRelativePath -Path $RelativePath -Label $Label
  $ResolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $Resolved = [System.IO.Path]::GetFullPath((Join-Path $ResolvedRoot ($RelativePath -replace '/', '\')))
  if (-not $Resolved.StartsWith($ResolvedRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label escapes its trusted root: $RelativePath"
  }
  if (-not (Test-Path -LiteralPath $Resolved -PathType Leaf)) {
    throw "$Label does not exist: $RelativePath"
  }
  $Item = Get-Item -LiteralPath $Resolved -Force
  if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label must not be a reparse point: $RelativePath"
  }
  return $Resolved
}

function Read-JsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is missing: $Path"
  }
  $Item = Get-Item -LiteralPath $Path -Force
  if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label must not be a reparse point: $Path"
  }
  try {
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "$Label must be valid UTF-8 JSON: $Path"
  }
}

function Assert-Sha256 {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ($Value -notmatch '^[0-9a-f]{64}$') {
    throw "$Label must be a lowercase SHA-256 value."
  }
}

function Assert-DatabaseContractObject {
  param([Parameter(Mandatory = $true)]$Contract)

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
  Assert-ExactProperties -Value $Contract -Expected $ContractProperties -Label 'Database contract'
  if ([string]$Contract.contractSchema -cne 'steel.database-contract.v1') {
    throw 'Database contract schema must be steel.database-contract.v1.'
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
    Assert-JsonInteger -Value $Contract.$Field -Label "Database contract $Field" -Minimum 1 -Maximum 2147483647
  }

  $SchemaVersion = [long]$Contract.schemaVersion
  $MinUpgradeable = [long]$Contract.minUpgradeableSchemaVersion
  $MaxUpgradeable = [long]$Contract.maxUpgradeableSchemaVersion
  $MinReadable = [long]$Contract.minReadableSchemaVersion
  $MaxReadable = [long]$Contract.maxReadableSchemaVersion
  $RollbackReadableThrough = [long]$Contract.rollbackReadableThrough
  $ExpectedMaxUpgradeable = if ($SchemaVersion -gt $MinUpgradeable) { $SchemaVersion - 1 } else { $SchemaVersion }
  if ($MinUpgradeable -gt $MaxUpgradeable -or
      $MaxUpgradeable -ne $ExpectedMaxUpgradeable -or
      $MinReadable -gt $MaxReadable -or
      $MaxReadable -ne $SchemaVersion -or
      $RollbackReadableThrough -lt $MinReadable -or
      $RollbackReadableThrough -gt $SchemaVersion) {
    throw 'Database contract upgrade, readable, or rollback version ranges are inconsistent.'
  }

  $Engines = @($Contract.engines)
  if ($Engines.Count -ne 2 -or
      [string]$Engines[0] -cne 'sqlite' -or
      [string]$Engines[1] -cne 'mysql') {
    throw 'Database contract engines must be the canonical ordered set: sqlite, mysql.'
  }
  if ([string]$Contract.migrationIndex -cne 'database/migrations/index.json') {
    throw 'Database contract migrationIndex must be database/migrations/index.json.'
  }
  Assert-Sha256 -Value ([string]$Contract.migrationIndexSha256) -Label 'Database migration index hash'
  return $ContractProperties
}

function Assert-MigrationIndexObject {
  param(
    [Parameter(Mandatory = $true)]$Contract,
    [Parameter(Mandatory = $true)]$Index,
    [Parameter(Mandatory = $true)][string]$ResolvedIndexPath
  )

  Assert-ExactProperties -Value $Index -Expected @(
    'schema',
    'baseSchemaVersion',
    'targetSchemaVersion',
    'engines',
    'migrations'
  ) -Label 'Database migration index'
  if ([string]$Index.schema -cne 'steel.database-migration-index.v1') {
    throw 'Database migration index schema must be steel.database-migration-index.v1.'
  }
  Assert-JsonInteger -Value $Index.baseSchemaVersion -Label 'Migration index baseSchemaVersion' -Minimum 1 -Maximum 2147483647
  Assert-JsonInteger -Value $Index.targetSchemaVersion -Label 'Migration index targetSchemaVersion' -Minimum 1 -Maximum 2147483647
  if ([long]$Index.baseSchemaVersion -ne [long]$Contract.minUpgradeableSchemaVersion -or
      [long]$Index.targetSchemaVersion -ne [long]$Contract.schemaVersion) {
    throw 'Migration index base/target versions do not match the database contract.'
  }
  $IndexEngines = @($Index.engines)
  if ($IndexEngines.Count -ne 2 -or
      [string]$IndexEngines[0] -cne 'sqlite' -or
      [string]$IndexEngines[1] -cne 'mysql') {
    throw 'Migration index engines must exactly match the database contract.'
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
  $MigrationRoot = Split-Path -Parent $ResolvedIndexPath
  $Migrations = @($Index.migrations)
  $Ids = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $PayloadPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $VersionEdges = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)

  foreach ($Migration in $Migrations) {
    Assert-ExactProperties -Value $Migration -Expected $MigrationProperties -Label 'Database migration entry'
    $Id = [string]$Migration.id
    if ($Id -notmatch '^[0-9]{3}-[a-z0-9][a-z0-9-]{0,95}$' -or -not $Ids.Add($Id)) {
      throw "Migration id must be canonical and globally unique: $Id"
    }
    Assert-JsonInteger -Value $Migration.fromVersion -Label "Migration $Id fromVersion" -Minimum 1 -Maximum 2147483646
    Assert-JsonInteger -Value $Migration.toVersion -Label "Migration $Id toVersion" -Minimum 2 -Maximum 2147483647
    $FromVersion = [long]$Migration.fromVersion
    $ToVersion = [long]$Migration.toVersion
    if ($ToVersion -ne $FromVersion + 1 -or
        $FromVersion -lt [long]$Index.baseSchemaVersion -or
        $ToVersion -gt [long]$Index.targetSchemaVersion) {
      throw "Migration $Id must advance exactly one version inside the declared index range."
    }
    $Engine = [string]$Migration.engine
    if ($Engine -cnotin @('sqlite', 'mysql')) {
      throw "Migration $Id has an unsupported engine: $Engine"
    }
    $Edge = "$Engine`:$FromVersion`:$ToVersion"
    if (-not $VersionEdges.Add($Edge)) {
      throw "Migration chain contains a duplicate engine/version edge: $Edge"
    }
    if ([string]$Migration.mode -cne 'offline') {
      throw "Migration $Id mode must be offline."
    }
    if ($Migration.reversible -isnot [bool]) {
      throw "Migration $Id reversible must be a JSON boolean."
    }
    Assert-JsonInteger -Value $Migration.estimatedLockSeconds -Label "Migration $Id estimatedLockSeconds" -Minimum 0 -Maximum 86400

    $TransactionModel = [string]$Migration.transactionModel
    if (($Engine -ceq 'sqlite' -and $TransactionModel -cne 'sqlite-transactional') -or
        ($Engine -ceq 'mysql' -and $TransactionModel -cnotin @('mysql-expand-contract', 'mysql-nontransactional'))) {
      throw "Migration $Id transactionModel is invalid for engine $Engine."
    }

    $ForwardPath = [string]$Migration.path
    Assert-CanonicalRelativePath -Path $ForwardPath -Label "Migration $Id forward path"
    if (-not $ForwardPath.StartsWith("$Engine/", [System.StringComparison]::Ordinal) -or
        -not $ForwardPath.EndsWith('.sql', [System.StringComparison]::Ordinal)) {
      throw "Migration $Id forward path must be a lowercase-engine SQL path."
    }
    if (-not $PayloadPaths.Add($ForwardPath)) {
      throw "Migration payload path is duplicated: $ForwardPath"
    }
    Assert-Sha256 -Value ([string]$Migration.sha256) -Label "Migration $Id forward hash"
    $ForwardFile = Resolve-ContainedFile -Root $MigrationRoot -RelativePath $ForwardPath -Label "Migration $Id forward payload"
    $ForwardHash = (Get-FileHash -LiteralPath $ForwardFile -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ForwardHash -cne [string]$Migration.sha256) {
      throw "Migration $Id forward payload hash mismatch."
    }

    $RollbackPath = [string]$Migration.rollbackPath
    $RollbackSha256 = [string]$Migration.rollbackSha256
    if ($Migration.reversible) {
      Assert-CanonicalRelativePath -Path $RollbackPath -Label "Migration $Id rollback path"
      if (-not $RollbackPath.StartsWith("$Engine/", [System.StringComparison]::Ordinal) -or
          -not $RollbackPath.EndsWith('.sql', [System.StringComparison]::Ordinal) -or
          $RollbackPath -ceq $ForwardPath -or
          -not $PayloadPaths.Add($RollbackPath)) {
        throw "Migration $Id rollback path is invalid or duplicated."
      }
      Assert-Sha256 -Value $RollbackSha256 -Label "Migration $Id rollback hash"
      $RollbackFile = Resolve-ContainedFile -Root $MigrationRoot -RelativePath $RollbackPath -Label "Migration $Id rollback payload"
      $RollbackHash = (Get-FileHash -LiteralPath $RollbackFile -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($RollbackHash -cne $RollbackSha256) {
        throw "Migration $Id rollback payload hash mismatch."
      }
    } elseif (-not [string]::IsNullOrEmpty($RollbackPath) -or -not [string]::IsNullOrEmpty($RollbackSha256)) {
      throw "Irreversible migration $Id must declare empty rollbackPath and rollbackSha256 fields."
    }
  }

  $BaseVersion = [long]$Index.baseSchemaVersion
  $TargetVersion = [long]$Index.targetSchemaVersion
  $RequiredSteps = [int]($TargetVersion - $BaseVersion)
  foreach ($Engine in @('sqlite', 'mysql')) {
    $Chain = @($Migrations | Where-Object { [string]$_.engine -ceq $Engine } | Sort-Object { [long]$_.fromVersion })
    if ($Chain.Count -ne $RequiredSteps) {
      throw "Migration chain for $Engine is not complete from $BaseVersion to $TargetVersion."
    }
    $ExpectedFrom = $BaseVersion
    foreach ($Migration in $Chain) {
      if ([long]$Migration.fromVersion -ne $ExpectedFrom -or [long]$Migration.toVersion -ne $ExpectedFrom + 1) {
        throw "Migration chain for $Engine is not continuous at version $ExpectedFrom."
      }
      $ExpectedFrom++
    }
    if ($ExpectedFrom -ne $TargetVersion) {
      throw "Migration chain for $Engine does not terminate at $TargetVersion."
    }
  }

  return [pscustomobject]@{
    migrationCount = $Migrations.Count
    payloadCount = $PayloadPaths.Count
  }
}

$UsingPackageMode = -not [string]::IsNullOrWhiteSpace($PackageRoot)
$UsingExplicitMode = -not [string]::IsNullOrWhiteSpace($ContractPath) -or -not [string]::IsNullOrWhiteSpace($IndexPath)
if ($UsingPackageMode -eq $UsingExplicitMode) {
  throw 'Use exactly one mode: -PackageRoot (optionally -ManifestPath), or both -ContractPath and -IndexPath.'
}

$Manifest = $null
if ($UsingPackageMode) {
  $PackageRoot = (Resolve-Path -LiteralPath $PackageRoot -ErrorAction Stop).Path
  if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $ManifestPath = Join-Path $PackageRoot 'manifest.json'
  }
  $ManifestPath = (Resolve-Path -LiteralPath $ManifestPath -ErrorAction Stop).Path
  $ManifestRoot = [System.IO.Path]::GetFullPath($PackageRoot).TrimEnd('\', '/')
  if (-not $ManifestPath.StartsWith($ManifestRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'ManifestPath must stay inside PackageRoot.'
  }
  $Manifest = Read-JsonFile -Path $ManifestPath -Label 'Runtime package manifest'
  $Database = $Manifest.database
  $DatabaseProperties = @(
    'contractPath',
    'contractSha256',
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
  Assert-ExactProperties -Value $Database -Expected $DatabaseProperties -Label 'Runtime manifest database contract'
  if ([string]$Database.contractPath -cne 'database/contract.json') {
    throw 'Runtime manifest database.contractPath must be database/contract.json.'
  }
  Assert-Sha256 -Value ([string]$Database.contractSha256) -Label 'Runtime manifest database contract hash'
  $ContractPath = Resolve-ContainedFile -Root $PackageRoot -RelativePath ([string]$Database.contractPath) -Label 'Database contract file'
  $ContractHash = (Get-FileHash -LiteralPath $ContractPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ContractHash -cne [string]$Database.contractSha256) {
    throw 'Runtime manifest database contract hash does not match database/contract.json.'
  }
  $Contract = Read-JsonFile -Path $ContractPath -Label 'Database contract'
  $ContractProperties = Assert-DatabaseContractObject -Contract $Contract
  foreach ($Property in $ContractProperties) {
    if ($Property -ceq 'engines') {
      if ((@($Database.engines) -join "`n") -cne (@($Contract.engines) -join "`n")) {
        throw 'Runtime manifest database engines do not match database/contract.json.'
      }
    } elseif ([string]$Database.$Property -cne [string]$Contract.$Property) {
      throw "Runtime manifest database.$Property does not match database/contract.json."
    }
  }
  $IndexPath = Resolve-ContainedFile -Root $PackageRoot -RelativePath ([string]$Contract.migrationIndex) -Label 'Database migration index'
} else {
  if ([string]::IsNullOrWhiteSpace($ContractPath) -or [string]::IsNullOrWhiteSpace($IndexPath)) {
    throw 'Explicit mode requires both -ContractPath and -IndexPath.'
  }
  $ContractPath = (Resolve-Path -LiteralPath $ContractPath -ErrorAction Stop).Path
  $IndexPath = (Resolve-Path -LiteralPath $IndexPath -ErrorAction Stop).Path
  $Contract = Read-JsonFile -Path $ContractPath -Label 'Database contract'
  [void](Assert-DatabaseContractObject -Contract $Contract)
}

$ActualIndexHash = (Get-FileHash -LiteralPath $IndexPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualIndexHash -cne [string]$Contract.migrationIndexSha256) {
  throw 'Database migration index hash does not match the database contract.'
}
$Index = Read-JsonFile -Path $IndexPath -Label 'Database migration index'
$IndexContract = Assert-MigrationIndexObject -Contract $Contract -Index $Index -ResolvedIndexPath $IndexPath

[ordered]@{
  schema = 'steel.database-contract-verification.v1'
  code = 0
  mode = if ($UsingPackageMode) { 'package' } else { 'explicit' }
  contractPath = $ContractPath
  contractSha256 = (Get-FileHash -LiteralPath $ContractPath -Algorithm SHA256).Hash.ToLowerInvariant()
  migrationIndex = $IndexPath
  migrationIndexSha256 = $ActualIndexHash
  schemaVersion = [long]$Contract.schemaVersion
  engines = @($Contract.engines)
  migrationCount = [int]$IndexContract.migrationCount
  payloadCount = [int]$IndexContract.payloadCount
} | ConvertTo-Json -Depth 5
