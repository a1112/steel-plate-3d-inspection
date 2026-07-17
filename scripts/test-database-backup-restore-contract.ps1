param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$CommonScript = Join-Path $RepoRoot 'scripts\database-recovery-common.ps1'
$RestoreScript = Join-Path $RepoRoot 'scripts\restore-database.ps1'
$BackupScript = Join-Path $RepoRoot 'scripts\backup-database.ps1'
. $CommonScript

function Assert-True {
  param(
    [Parameter(Mandatory = $true)][bool]$Condition,
    [Parameter(Mandatory = $true)][string]$Message
  )
  if (-not $Condition) { throw $Message }
}

function Invoke-ExpectedFailure {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Action,
    [Parameter(Mandatory = $true)][string]$ExpectedPattern
  )

  try {
    & $Action
  } catch {
    if ($_.Exception.Message -notmatch $ExpectedPattern) {
      throw "Expected failure /$ExpectedPattern/, got: $($_.Exception.Message)"
    }
    return $true
  }
  throw "Expected action to fail with /$ExpectedPattern/."
}

function New-TestDatabase {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Marker
  )

  Invoke-SteelSqliteQuery -DatabasePath $Path -Mode Create -Sql @'
CREATE TABLE steel_schema_state (
  singleton_id INTEGER PRIMARY KEY NOT NULL,
  current_version BIGINT NOT NULL,
  dirty INTEGER NOT NULL,
  active_migration_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
'@ | Out-Null
  Invoke-SteelSqliteQuery -DatabasePath $Path -Mode ReadWrite -Sql "INSERT INTO steel_schema_state VALUES (1, 1, 0, '', 'test')" | Out-Null
  Invoke-SteelSqliteQuery -DatabasePath $Path -Mode ReadWrite -Sql @'
CREATE TABLE steel_schema_migration (
  migration_id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL
)
'@ | Out-Null
  Invoke-SteelSqliteQuery -DatabasePath $Path -Mode ReadWrite -Sql 'CREATE TABLE sample_state (marker TEXT NOT NULL)' | Out-Null
  $EscapedMarker = $Marker.Replace("'", "''")
  Invoke-SteelSqliteQuery -DatabasePath $Path -Mode ReadWrite -Sql "INSERT INTO sample_state VALUES ('$EscapedMarker')" | Out-Null
}

function Invoke-RestoreProcess {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedBackupDir,
    [Parameter(Mandatory = $true)][string]$ManifestHash,
    [Parameter(Mandatory = $true)][string]$Confirmation
  )

  $Arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $RestoreScript,
    '-BackupDir', $SelectedBackupDir,
    '-ExpectedBackupManifestSha256', $ManifestHash,
    '-Engine', 'sqlite',
    '-TargetRuntimeRoot', $RuntimeRoot,
    '-TargetStateRoot', $StateRoot,
    '-TargetActiveDeploymentPath', $ActiveDeploymentPath,
    '-ServiceName', $ServiceName,
    '-ServicePort', [string]$ServicePort,
    '-AllowEngineeringPackage',
    '-Confirm', $Confirmation
  )
  $PreviousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $Output = @(& powershell @Arguments 2>&1)
    $ExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $PreviousErrorActionPreference
  }
  return [pscustomobject]@{
    exitCode = $ExitCode
    output = ($Output | Out-String).Trim()
  }
}

$TestRoot = Join-Path $env:TEMP ('steel-database-recovery-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TestRoot | Out-Null
try {
  $RuntimeRoot = Join-Path $TestRoot 'runtime\releases\1.0.0-0123456789ab'
  $StateRoot = Join-Path $TestRoot 'state'
  $DatabaseDirectory = Join-Path $StateRoot 'service'
  $DatabasePath = Join-Path $DatabaseDirectory 'steel-inspection.sqlite'
  $BackupDir = Join-Path $TestRoot 'backup'
  $DatabaseDirectoryInRuntime = Join-Path $RuntimeRoot 'database\migrations'
  New-Item -ItemType Directory -Force -Path $DatabaseDirectoryInRuntime, $DatabaseDirectory, $BackupDir | Out-Null

  $IndexPath = Join-Path $RuntimeRoot 'database\migrations\index.json'
  $Index = [ordered]@{
    schema = 'steel.database-migration-index.v1'
    baseSchemaVersion = 1
    targetSchemaVersion = 1
    engines = @('sqlite', 'mysql')
    migrations = @()
  }
  Write-SteelDurableJson -Path $IndexPath -Value $Index | Out-Null
  $IndexHash = Get-SteelFileSha256 -Path $IndexPath
  $ContractPath = Join-Path $RuntimeRoot 'database\contract.json'
  $Contract = [ordered]@{
    contractSchema = 'steel.database-contract.v1'
    schemaVersion = 1
    minUpgradeableSchemaVersion = 1
    maxUpgradeableSchemaVersion = 1
    minReadableSchemaVersion = 1
    maxReadableSchemaVersion = 1
    rollbackReadableThrough = 1
    engines = @('sqlite', 'mysql')
    migrationIndex = 'database/migrations/index.json'
    migrationIndexSha256 = $IndexHash
    stateLayoutVersion = 1
  }
  Write-SteelDurableJson -Path $ContractPath -Value $Contract | Out-Null
  $ContractHash = Get-SteelFileSha256 -Path $ContractPath

  $ReleaseCommit = '0123456789abcdef0123456789abcdef01234567'
  $ReleaseId = '1.0.0-0123456789ab'
  $RuntimeManifestPath = Join-Path $RuntimeRoot 'manifest.json'
  $RuntimeManifest = [ordered]@{
    schema = 'steel.runtime-package.v1'
    name = 'steel-inspection-runtime'
    packageClass = 'engineering'
    releaseVersion = '1.0.0'
    source = [ordered]@{
      gitCommit = $ReleaseCommit
      gitTag = ''
      dirty = $true
    }
    database = [ordered]@{
      contractPath = 'database/contract.json'
      contractSha256 = $ContractHash
      contractSchema = 'steel.database-contract.v1'
      schemaVersion = 1
      minUpgradeableSchemaVersion = 1
      maxUpgradeableSchemaVersion = 1
      minReadableSchemaVersion = 1
      maxReadableSchemaVersion = 1
      rollbackReadableThrough = 1
      engines = @('sqlite', 'mysql')
      migrationIndex = 'database/migrations/index.json'
      migrationIndexSha256 = $IndexHash
      stateLayoutVersion = 1
    }
  }
  Write-SteelDurableJson -Path $RuntimeManifestPath -Value $RuntimeManifest | Out-Null
  $RuntimeManifestHash = Get-SteelFileSha256 -Path $RuntimeManifestPath

  $DeploymentDirectory = Join-Path $StateRoot 'deployment'
  New-Item -ItemType Directory -Force -Path $DeploymentDirectory | Out-Null
  $ActiveDeploymentPath = Join-Path $DeploymentDirectory 'active.json'
  $TransactionId = [Guid]::NewGuid().ToString('D')
  $ActiveDeployment = [ordered]@{
    schema = 'steel.runtime-active-deployment.v1'
    releaseId = $ReleaseId
    releaseVersion = '1.0.0'
    releaseCommit = $ReleaseCommit
    releaseRoot = $RuntimeRoot
    stateRoot = $StateRoot
    serviceName = 'SteelInspectionRuntime-Test'
    transactionId = $TransactionId
    activatedAtUtc = [DateTime]::UtcNow.ToString('o')
    serviceRunning = $false
    database = [ordered]@{
      schemaVersion = 1
      contractSha256 = $ContractHash
      migrationIndexSha256 = $IndexHash
      migrationCount = 0
      phase = 'not-started'
    }
  }
  Write-SteelDurableJson -Path $ActiveDeploymentPath -Value $ActiveDeployment | Out-Null
  $ActiveDeploymentHash = Get-SteelFileSha256 -Path $ActiveDeploymentPath

  New-TestDatabase -Path $DatabasePath -Marker 'before-restore'
  $BackupPayloadPath = Join-Path $BackupDir 'steel-inspection.sqlite'
  New-TestDatabase -Path $BackupPayloadPath -Marker 'selected-backup'
  $BackupEvidence = Get-SteelSqliteSnapshotEvidence -DatabasePath $BackupPayloadPath
  $BackupId = [Guid]::NewGuid().ToString('D')
  $BackupManifest = [ordered]@{
    schema = 'steel.database-backup.v2'
    backupId = $BackupId
    engine = 'sqlite'
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    release = [ordered]@{
      releaseId = $ReleaseId
      releaseVersion = '1.0.0'
      releaseCommit = $ReleaseCommit
      transactionId = $TransactionId
      packageManifestSha256 = $RuntimeManifestHash
      activeDeploymentSha256 = $ActiveDeploymentHash
    }
    database = [ordered]@{
      schemaVersion = 1
      contractSchema = 'steel.database-contract.v1'
      contractSha256 = $ContractHash
      migrationIndexSha256 = $IndexHash
      stateLayoutVersion = 1
      mysqlDatabase = $null
      serverVersion = 'winsqlite3'
    }
    payload = [ordered]@{
      file = 'steel-inspection.sqlite'
      bytes = [long]$BackupEvidence.bytes
      sha256 = [string]$BackupEvidence.sha256
      consistencyModel = 'sqlite-vacuum-into'
    }
    verification = [ordered]@{
      status = 'passed'
      method = [string]$BackupEvidence.method
      verifiedAtUtc = [DateTime]::UtcNow.ToString('o')
      schemaVersion = 1
      integrityCheck = 'ok'
      foreignKeyViolations = 0
      unresolvedMigrations = 0
      nonInnoDbTables = 0
      restoredTableCount = 0
    }
    source = [ordered]@{
      serviceOrigin = 'http://127.0.0.1:4873'
      serviceReportedEngine = 'sqlite'
      serviceReportedSchemaVersion = 1
      serviceIntegrityStatus = 'ok'
    }
    artifactRoots = @()
    tool = [ordered]@{
      backupScriptSha256 = Get-SteelFileSha256 -Path $BackupScript
      commonScriptSha256 = Get-SteelFileSha256 -Path $CommonScript
      powerShellVersion = $PSVersionTable.PSVersion.ToString()
      mysqlClientVersion = ''
      mysqlDumpVersion = ''
    }
  }
  $BackupManifestPath = Join-Path $BackupDir 'manifest.json'
  Write-SteelDurableJson -Path $BackupManifestPath -Value $BackupManifest | Out-Null
  $BackupManifestHash = Get-SteelFileSha256 -Path $BackupManifestPath
  Assert-SteelBackupManifestV2 -Manifest (Read-SteelJsonFile -Path $BackupManifestPath -Label 'Fixture backup manifest')

  $ServiceName = 'SteelInspectionRuntime-Test-' + [Guid]::NewGuid().ToString('N')
  $ServicePort = 61973
  $Confirmation = "RESTORE sqlite $BackupId TO $ReleaseId"
  $Restore = Invoke-RestoreProcess `
    -SelectedBackupDir $BackupDir `
    -ManifestHash $BackupManifestHash `
    -Confirmation $Confirmation
  Assert-True ($Restore.exitCode -eq 0) "SQLite restore failed: $($Restore.output)"
  $RestoreResult = $Restore.output | ConvertFrom-Json
  Assert-True ([string]$RestoreResult.schema -ceq 'steel.database-restore-result.v2') 'Restore result schema mismatch.'
  $MarkerRows = Invoke-SteelSqliteQuery -DatabasePath $DatabasePath -Sql 'SELECT marker FROM sample_state'
  Assert-True ($MarkerRows.Count -eq 1 -and [string]$MarkerRows[0][0] -ceq 'selected-backup') 'Selected SQLite backup was not restored.'
  $Receipt = Read-SteelJsonFile -Path ([string]$RestoreResult.receiptPath) -Label 'Restore receipt'
  Assert-True ([string]$Receipt.schema -ceq 'steel.database-restore-receipt.v2' -and [string]$Receipt.outcome -ceq 'committed') 'Committed restore receipt mismatch.'
  Assert-True (Test-Path -LiteralPath ([string]$Receipt.preRestore.rollbackPath) -PathType Leaf) 'Pre-restore durable rollback copy is missing.'

  $BadHashResult = Invoke-RestoreProcess `
    -SelectedBackupDir $BackupDir `
    -ManifestHash ('0' * 64) `
    -Confirmation $Confirmation
  Assert-True ($BadHashResult.exitCode -ne 0 -and $BadHashResult.output -match 'independently supplied') 'Out-of-band manifest hash mismatch was not rejected.'

  $BadConfirmResult = Invoke-RestoreProcess `
    -SelectedBackupDir $BackupDir `
    -ManifestHash $BackupManifestHash `
    -Confirmation 'RESTORE sqlite wrong'
  Assert-True ($BadConfirmResult.exitCode -ne 0 -and $BadConfirmResult.output -match 'Explicit confirmation required') 'Incorrect restore confirmation was not rejected.'

  $TamperedBackupDir = Join-Path $TestRoot 'tampered-backup'
  Copy-Item -LiteralPath $BackupDir -Destination $TamperedBackupDir -Recurse
  [System.IO.File]::AppendAllText((Join-Path $TamperedBackupDir 'steel-inspection.sqlite'), 'tamper')
  $TamperedResult = Invoke-RestoreProcess `
    -SelectedBackupDir $TamperedBackupDir `
    -ManifestHash $BackupManifestHash `
    -Confirmation $Confirmation
  Assert-True ($TamperedResult.exitCode -ne 0 -and $TamperedResult.output -match 'payload size or SHA-256') 'Tampered backup payload was not rejected.'

  $IncompatibleBackupDir = Join-Path $TestRoot 'incompatible-backup'
  Copy-Item -LiteralPath $BackupDir -Destination $IncompatibleBackupDir -Recurse
  $IncompatibleManifestPath = Join-Path $IncompatibleBackupDir 'manifest.json'
  $IncompatibleManifest = Read-SteelJsonFile -Path $IncompatibleManifestPath -Label 'Incompatible fixture manifest'
  $IncompatibleManifest.database.schemaVersion = 2
  $IncompatibleManifest.verification.schemaVersion = 2
  Write-SteelDurableJson -Path $IncompatibleManifestPath -Value $IncompatibleManifest -Overwrite | Out-Null
  $IncompatibleHash = Get-SteelFileSha256 -Path $IncompatibleManifestPath
  $IncompatibleResult = Invoke-RestoreProcess `
    -SelectedBackupDir $IncompatibleBackupDir `
    -ManifestHash $IncompatibleHash `
    -Confirmation $Confirmation
  Assert-True ($IncompatibleResult.exitCode -ne 0 -and $IncompatibleResult.output -match 'readable/rollback bounds') 'Unreadable schema backup was not rejected.'

  $RestoreSource = Get-Content -LiteralPath $RestoreScript -Raw -Encoding UTF8
  $BackupSource = Get-Content -LiteralPath $BackupScript -Raw -Encoding UTF8
  $AtomicContract = @(
    '[System.IO.File]::Replace',
    'PRAGMA wal_checkpoint(TRUNCATE)',
    'Get-SteelSqliteSnapshotEvidence',
    "Outcome 'rolled-back'",
    "Outcome 'failed-safe'",
    'AllowNonAtomicMySqlRestore',
    'ExpectedMySqlPreRestoreManifestSha256'
  ) | ForEach-Object { $RestoreSource.Contains($_) }
  $DeploymentMutexContract = @(
    $RestoreSource.Contains("'Global\SteelInspectionRuntime-Deployment'"),
    $BackupSource.Contains("'Global\SteelInspectionRuntime-Deployment'"),
    $RestoreSource.Contains('$DeploymentMutex.ReleaseMutex()'),
    $BackupSource.Contains('$DeploymentMutex.ReleaseMutex()')
  )

  [pscustomobject][ordered]@{
    schema = 'steel.database-backup-restore-contract-test.v2'
    code = 0
    checks = [ordered]@{
      winSqliteIntegrity = $true
      successfulAtomicRestore = $true
      committedReceipt = $true
      durableRollbackCopy = $true
      outOfBandManifestHashRejection = $true
      confirmationRejection = $true
      payloadTamperRejection = $true
      schemaCompatibilityRejection = $true
      atomicAndMySqlFailSafeContract = @($AtomicContract | Where-Object { -not $_ }).Count -eq 0
      sharedDeploymentMutexContract = @($DeploymentMutexContract | Where-Object { -not $_ }).Count -eq 0
    }
  } | ConvertTo-Json -Depth 6
} finally {
  $ResolvedTestRoot = [System.IO.Path]::GetFullPath($TestRoot)
  $ResolvedTempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\', '/')
  if ($ResolvedTestRoot.StartsWith($ResolvedTempRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -and
      (Test-Path -LiteralPath $ResolvedTestRoot -PathType Container)) {
    Remove-Item -LiteralPath $ResolvedTestRoot -Recurse -Force
  }
}
