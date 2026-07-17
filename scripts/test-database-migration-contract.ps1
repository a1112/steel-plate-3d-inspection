param(
  [string]$VerifierPath = (Join-Path $PSScriptRoot 'verify-database-migration-contract.ps1'),
  [string]$TrackedContractPath = (Join-Path $PSScriptRoot '..\config\release\database\contract.json'),
  [string]$ServiceDatabaseSourcePath = (Join-Path $PSScriptRoot '..\app\service\src\db\mod.rs')
)

$ErrorActionPreference = 'Stop'
$VerifierPath = (Resolve-Path -LiteralPath $VerifierPath -ErrorAction Stop).Path
$TrackedContractPath = (Resolve-Path -LiteralPath $TrackedContractPath -ErrorAction Stop).Path
$ServiceDatabaseSourcePath = (Resolve-Path -LiteralPath $ServiceDatabaseSourcePath -ErrorAction Stop).Path
$TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("steel-database-contract-test-" + [guid]::NewGuid().ToString('N'))

function Write-JsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )
  $Parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $Parent | Out-Null
  $Value | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Get-LowerSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function New-TestFixture {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [scriptblock]$Mutator
  )

  $DatabaseRoot = Join-Path $Root 'database'
  $MigrationRoot = Join-Path $DatabaseRoot 'migrations'
  $SqliteRoot = Join-Path $MigrationRoot 'sqlite'
  $MysqlRoot = Join-Path $MigrationRoot 'mysql'
  New-Item -ItemType Directory -Force -Path $SqliteRoot, $MysqlRoot | Out-Null

  $SqliteUp = Join-Path $SqliteRoot '002-up.sql'
  $SqliteDown = Join-Path $SqliteRoot '002-down.sql'
  $MysqlUp = Join-Path $MysqlRoot '002-up.sql'
  'ALTER TABLE inspection_record ADD COLUMN trace_id TEXT;' | Set-Content -LiteralPath $SqliteUp -Encoding UTF8
  'ALTER TABLE inspection_record DROP COLUMN trace_id;' | Set-Content -LiteralPath $SqliteDown -Encoding UTF8
  'ALTER TABLE inspection_record ADD COLUMN trace_id VARCHAR(128);' | Set-Content -LiteralPath $MysqlUp -Encoding UTF8

  $Index = [ordered]@{
    schema = 'steel.database-migration-index.v1'
    baseSchemaVersion = 1
    targetSchemaVersion = 2
    engines = @('sqlite', 'mysql')
    migrations = @(
      [ordered]@{
        id = '002-add-inspection-trace-sqlite'
        fromVersion = 1
        toVersion = 2
        engine = 'sqlite'
        path = 'sqlite/002-up.sql'
        sha256 = Get-LowerSha256 $SqliteUp
        mode = 'offline'
        reversible = $true
        rollbackPath = 'sqlite/002-down.sql'
        rollbackSha256 = Get-LowerSha256 $SqliteDown
        transactionModel = 'sqlite-transactional'
        estimatedLockSeconds = 10
      },
      [ordered]@{
        id = '002-add-inspection-trace-mysql'
        fromVersion = 1
        toVersion = 2
        engine = 'mysql'
        path = 'mysql/002-up.sql'
        sha256 = Get-LowerSha256 $MysqlUp
        mode = 'offline'
        reversible = $false
        rollbackPath = ''
        rollbackSha256 = ''
        transactionModel = 'mysql-expand-contract'
        estimatedLockSeconds = 30
      }
    )
  }
  if ($Mutator) {
    & $Mutator $Index $MigrationRoot
  }

  $IndexPath = Join-Path $MigrationRoot 'index.json'
  Write-JsonFile -Path $IndexPath -Value $Index
  $Contract = [ordered]@{
    contractSchema = 'steel.database-contract.v1'
    schemaVersion = 2
    minUpgradeableSchemaVersion = 1
    maxUpgradeableSchemaVersion = 1
    minReadableSchemaVersion = 1
    maxReadableSchemaVersion = 2
    rollbackReadableThrough = 1
    engines = @('sqlite', 'mysql')
    migrationIndex = 'database/migrations/index.json'
    migrationIndexSha256 = Get-LowerSha256 $IndexPath
    stateLayoutVersion = 1
  }
  $ContractPath = Join-Path $DatabaseRoot 'contract.json'
  Write-JsonFile -Path $ContractPath -Value $Contract

  return [pscustomobject]@{
    root = $Root
    contractPath = $ContractPath
    indexPath = $IndexPath
  }
}

function Assert-ExplicitAccepted {
  param([Parameter(Mandatory = $true)]$Fixture)
  $Text = (& $VerifierPath -ContractPath $Fixture.contractPath -IndexPath $Fixture.indexPath | Out-String)
  $Report = $Text | ConvertFrom-Json
  if ($Report.code -ne 0 -or
      [string]$Report.schema -cne 'steel.database-contract-verification.v1' -or
      [int]$Report.migrationCount -ne 2 -or
      [int]$Report.payloadCount -ne 3) {
    throw 'Valid explicit database migration fixture did not pass the complete contract.'
  }
}

function Assert-Rejected {
  param([Parameter(Mandatory = $true)][scriptblock]$Action)
  $Rejected = $false
  try {
    & $Action | Out-Null
  } catch {
    $Rejected = $true
  }
  if (-not $Rejected) {
    throw 'Invalid database migration fixture was not rejected.'
  }
}

function New-PackageManifest {
  param([Parameter(Mandatory = $true)]$Fixture)
  $Contract = Get-Content -LiteralPath $Fixture.contractPath -Raw -Encoding UTF8 | ConvertFrom-Json
  return [ordered]@{
    schema = 'steel.runtime-package.v1'
    database = [ordered]@{
      contractPath = 'database/contract.json'
      contractSha256 = Get-LowerSha256 $Fixture.contractPath
      contractSchema = [string]$Contract.contractSchema
      schemaVersion = [int]$Contract.schemaVersion
      minUpgradeableSchemaVersion = [int]$Contract.minUpgradeableSchemaVersion
      maxUpgradeableSchemaVersion = [int]$Contract.maxUpgradeableSchemaVersion
      minReadableSchemaVersion = [int]$Contract.minReadableSchemaVersion
      maxReadableSchemaVersion = [int]$Contract.maxReadableSchemaVersion
      rollbackReadableThrough = [int]$Contract.rollbackReadableThrough
      engines = @($Contract.engines)
      migrationIndex = [string]$Contract.migrationIndex
      migrationIndexSha256 = [string]$Contract.migrationIndexSha256
      stateLayoutVersion = [int]$Contract.stateLayoutVersion
    }
  }
}

try {
  $TrackedContract = Get-Content -LiteralPath $TrackedContractPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $ServiceDatabaseSource = Get-Content -LiteralPath $ServiceDatabaseSourcePath -Raw -Encoding UTF8
  $SchemaVersionMatches = [regex]::Matches(
    $ServiceDatabaseSource,
    '(?m)^pub const DATABASE_SCHEMA_VERSION: i64 = ([1-9][0-9]*);$'
  )
  if ($SchemaVersionMatches.Count -ne 1 -or
      [long]$TrackedContract.schemaVersion -ne [long]$SchemaVersionMatches[0].Groups[1].Value -or
      [long]$TrackedContract.minReadableSchemaVersion -ne [long]$TrackedContract.schemaVersion -or
      [long]$TrackedContract.maxReadableSchemaVersion -ne [long]$TrackedContract.schemaVersion) {
    throw 'Tracked database contract schemaVersion/readable range must exactly match the Rust DATABASE_SCHEMA_VERSION constant.'
  }

  New-Item -ItemType Directory -Force -Path $TestRoot | Out-Null

  $Positive = New-TestFixture -Root (Join-Path $TestRoot 'positive')
  Assert-ExplicitAccepted -Fixture $Positive

  $PackageManifest = New-PackageManifest -Fixture $Positive
  $PackageManifestPath = Join-Path $Positive.root 'manifest.json'
  Write-JsonFile -Path $PackageManifestPath -Value $PackageManifest
  $PackageText = (& $VerifierPath -PackageRoot $Positive.root -ManifestPath $PackageManifestPath | Out-String)
  $PackageReport = $PackageText | ConvertFrom-Json
  if ($PackageReport.code -ne 0 -or [string]$PackageReport.mode -cne 'package') {
    throw 'Valid package database contract did not pass.'
  }

  $Canonical = New-TestFixture -Root (Join-Path $TestRoot 'canonical') -Mutator {
    param($Index)
    $Index.migrations[0].path = '../escape.sql'
  }
  Assert-Rejected { & $VerifierPath -ContractPath $Canonical.contractPath -IndexPath $Canonical.indexPath }

  $PayloadHash = New-TestFixture -Root (Join-Path $TestRoot 'payload-hash') -Mutator {
    param($Index)
    $Index.migrations[0].sha256 = ('0' * 64)
  }
  Assert-Rejected { & $VerifierPath -ContractPath $PayloadHash.contractPath -IndexPath $PayloadHash.indexPath }

  $IndexHash = New-TestFixture -Root (Join-Path $TestRoot 'index-hash')
  Add-Content -LiteralPath $IndexHash.indexPath -Value ' ' -Encoding UTF8
  Assert-Rejected { & $VerifierPath -ContractPath $IndexHash.contractPath -IndexPath $IndexHash.indexPath }

  $Engine = New-TestFixture -Root (Join-Path $TestRoot 'engine') -Mutator {
    param($Index)
    $Index.migrations[1].engine = 'postgres'
  }
  Assert-Rejected { & $VerifierPath -ContractPath $Engine.contractPath -IndexPath $Engine.indexPath }

  $Discontinuous = New-TestFixture -Root (Join-Path $TestRoot 'discontinuous') -Mutator {
    param($Index)
    $Index.migrations[0].toVersion = 3
  }
  Assert-Rejected { & $VerifierPath -ContractPath $Discontinuous.contractPath -IndexPath $Discontinuous.indexPath }

  $Duplicate = New-TestFixture -Root (Join-Path $TestRoot 'duplicate') -Mutator {
    param($Index)
    $Index.migrations += [ordered]@{
      id = '002-duplicate-sqlite-edge'
      fromVersion = 1
      toVersion = 2
      engine = 'sqlite'
      path = 'sqlite/002-up.sql'
      sha256 = [string]$Index.migrations[0].sha256
      mode = 'offline'
      reversible = $false
      rollbackPath = ''
      rollbackSha256 = ''
      transactionModel = 'sqlite-transactional'
      estimatedLockSeconds = 1
    }
  }
  Assert-Rejected { & $VerifierPath -ContractPath $Duplicate.contractPath -IndexPath $Duplicate.indexPath }

  $Reversible = New-TestFixture -Root (Join-Path $TestRoot 'reversible') -Mutator {
    param($Index)
    $Index.migrations[0].rollbackPath = ''
    $Index.migrations[0].rollbackSha256 = ''
  }
  Assert-Rejected { & $VerifierPath -ContractPath $Reversible.contractPath -IndexPath $Reversible.indexPath }

  $ManifestBinding = New-TestFixture -Root (Join-Path $TestRoot 'manifest-binding')
  $BadManifest = New-PackageManifest -Fixture $ManifestBinding
  $BadManifest.database.schemaVersion = 3
  $BadManifestPath = Join-Path $ManifestBinding.root 'manifest.json'
  Write-JsonFile -Path $BadManifestPath -Value $BadManifest
  Assert-Rejected { & $VerifierPath -PackageRoot $ManifestBinding.root -ManifestPath $BadManifestPath }

  [ordered]@{
    schema = 'steel.database-contract-test.v1'
    code = 0
    serviceSchemaVersionBinding = 'passed'
    positive = 'passed'
    packagePositive = 'passed'
    canonicalPathRejection = 'passed'
    payloadHashRejection = 'passed'
    indexHashRejection = 'passed'
    engineRejection = 'passed'
    discontinuousChainRejection = 'passed'
    duplicateChainRejection = 'passed'
    reversibleFieldRejection = 'passed'
    manifestBindingRejection = 'passed'
  } | ConvertTo-Json -Depth 4
} finally {
  if (Test-Path -LiteralPath $TestRoot) {
    Remove-Item -LiteralPath $TestRoot -Recurse -Force
  }
}
