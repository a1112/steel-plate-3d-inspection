param(
  [Parameter(Mandatory = $true)]
  [string]$BackupDir,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedBackupManifestSha256,
  [ValidateSet('sqlite', 'mysql')]
  [string]$Engine = 'sqlite',
  [string]$TargetRuntimeRoot = '',
  [string]$TargetStateRoot = $env:STEEL_RUNTIME_STATE_ROOT,
  [string]$TargetActiveDeploymentPath = '',
  [string]$DatabasePath = '',
  [int]$ServicePort = 4873,
  [string]$ServiceName = 'SteelInspectionRuntime',
  [string]$ReceiptRoot = '',
  [string]$MySqlDefaultsFile = '',
  [string]$MySqlDatabase = 'steel_inspection',
  [string]$MySqlExe = 'mysql.exe',
  [string]$MySqlPreRestoreBackupDir = '',
  [string]$ExpectedMySqlPreRestoreManifestSha256 = '',
  [switch]$AllowNonAtomicMySqlRestore,
  [switch]$AllowEngineeringPackage,
  [string]$Confirm = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$CommonScript = Join-Path $PSScriptRoot 'database-recovery-common.ps1'
if (-not (Test-Path -LiteralPath $CommonScript -PathType Leaf)) {
  throw "Database recovery common library is missing: $CommonScript"
}
. $CommonScript
$RestoreScriptPath = $MyInvocation.MyCommand.Path

function Resolve-SteelCommandPath {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $Resolved = Get-Command $Command -CommandType Application -ErrorAction Stop | Select-Object -First 1
  if ($null -eq $Resolved -or -not (Test-Path -LiteralPath $Resolved.Source -PathType Leaf)) {
    throw "$Label executable is unavailable: $Command"
  }
  Assert-SteelNoReparseChain -Path $Resolved.Source | Out-Null
  return $Resolved.Source
}

function Invoke-SteelMySqlQuery {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$DefaultsFile,
    [Parameter(Mandatory = $true)][string]$Sql,
    [string]$Database = ''
  )

  $Arguments = @(
    "--defaults-extra-file=$DefaultsFile",
    '--batch',
    '--raw',
    '--skip-column-names',
    "--execute=$Sql"
  )
  if (-not [string]::IsNullOrWhiteSpace($Database)) {
    $Arguments += "--database=$Database"
  }
  $Output = @(& $Executable @Arguments 2>$null)
  if ($LASTEXITCODE -ne 0) {
    throw "mysql query failed with exit code $LASTEXITCODE."
  }
  return @($Output | ForEach-Object { [string]$_ })
}

function Invoke-SteelMySqlImport {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$DefaultsFile,
    [Parameter(Mandatory = $true)][string]$Database,
    [Parameter(Mandatory = $true)][string]$InputFile
  )

  $Arguments = @(
    "--defaults-extra-file=`"$DefaultsFile`"",
    '--binary-mode',
    "--database=$Database"
  )
  $Process = Start-Process -FilePath $Executable -ArgumentList $Arguments -RedirectStandardInput $InputFile -NoNewWindow -Wait -PassThru
  if ($Process.ExitCode -ne 0) {
    throw "mysql restore failed with exit code $($Process.ExitCode)."
  }
}

function Get-SteelMySqlLedger {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$DefaultsFile,
    [Parameter(Mandatory = $true)][string]$Database
  )

  $Rows = @(Invoke-SteelMySqlQuery `
    -Executable $Executable `
    -DefaultsFile $DefaultsFile `
    -Database $Database `
    -Sql "SELECT CAST(current_version AS CHAR), CAST(dirty AS CHAR), COALESCE(active_migration_id, '') FROM steel_schema_state WHERE singleton_id = 1")
  if ($Rows.Count -ne 1) {
    throw "MySQL schema ledger must contain exactly one singleton row in $Database."
  }
  $Columns = @($Rows[0] -split "`t", -1)
  $SchemaVersion = 0L
  if ($Columns.Count -ne 3 -or
      -not [long]::TryParse($Columns[0], [ref]$SchemaVersion) -or
      $SchemaVersion -lt 1 -or
      $Columns[1] -cne '0' -or
      -not [string]::IsNullOrEmpty($Columns[2])) {
    throw "MySQL schema ledger is invalid, dirty, or has an active migration in $Database."
  }
  $Unresolved = @(Invoke-SteelMySqlQuery `
    -Executable $Executable `
    -DefaultsFile $DefaultsFile `
    -Database $Database `
    -Sql "SELECT CAST(COUNT(*) AS CHAR) FROM steel_schema_migration WHERE state NOT IN ('applied', 'rolled-back')")
  if ($Unresolved.Count -ne 1 -or $Unresolved[0] -cne '0') {
    throw "MySQL migration ledger contains an unresolved migration in $Database."
  }
  return [pscustomobject][ordered]@{
    schemaVersion = $SchemaVersion
    unresolvedMigrations = 0
  }
}

function Assert-SteelServiceStopped {
  $Service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($null -ne $Service -and $Service.Status -ne 'Stopped') {
    throw "Windows service $ServiceName must be stopped before database restore."
  }
  $Listener = Get-NetTCPConnection -State Listen -LocalPort $ServicePort -ErrorAction SilentlyContinue
  if ($null -ne $Listener) {
    throw "Service port $ServicePort is still listening. Stop the runtime before database restore."
  }
}

function Get-SteelVerifiedBackup {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$ExpectedManifestHash,
    [Parameter(Mandatory = $true)][string]$Label
  )

  Assert-SteelLowerSha256 -Value $ExpectedManifestHash -Label "$Label expected manifest hash"
  $ResolvedDirectory = (Resolve-Path -LiteralPath $Directory -ErrorAction Stop).Path
  Assert-SteelNoReparseChain -Path $ResolvedDirectory | Out-Null
  $ManifestPath = Join-Path $ResolvedDirectory 'manifest.json'
  $ActualManifestHash = Get-SteelFileSha256 -Path $ManifestPath
  if ($ActualManifestHash -cne $ExpectedManifestHash) {
    throw "$Label manifest SHA-256 does not match the independently supplied value."
  }
  $Manifest = Read-SteelJsonFile -Path $ManifestPath -Label "$Label manifest"
  Assert-SteelBackupManifestV2 -Manifest $Manifest
  $PayloadPath = Resolve-SteelContainedFile `
    -Root $ResolvedDirectory `
    -RelativePath ([string]$Manifest.payload.file) `
    -Label "$Label payload"
  $Payload = Get-Item -LiteralPath $PayloadPath
  if ([long]$Payload.Length -ne [long]$Manifest.payload.bytes -or
      (Get-SteelFileSha256 -Path $PayloadPath) -cne [string]$Manifest.payload.sha256) {
    throw "$Label payload size or SHA-256 verification failed."
  }
  return [pscustomobject][ordered]@{
    directory = $ResolvedDirectory
    manifestPath = $ManifestPath
    manifestSha256 = $ActualManifestHash
    manifest = $Manifest
    payloadPath = $PayloadPath
  }
}

function Write-SteelRestoreReceipt {
  param(
    [Parameter(Mandatory = $true)][string]$Outcome,
    [Parameter(Mandatory = $true)][string]$Detail,
    $PreRestore,
    $Restored
  )

  $Receipt = [ordered]@{
    schema = 'steel.database-restore-receipt.v2'
    restoreId = $RestoreId
    backupId = [string]$Backup.manifest.backupId
    engine = $Engine
    outcome = $Outcome
    startedAtUtc = $RestoreStartedAt
    completedAtUtc = [DateTime]::UtcNow.ToString('o')
    detail = $Detail
    coordination = if ($Engine -eq 'sqlite') {
      'offline-same-volume-file-replace-with-durable-rollback-copy'
    } else {
      'offline-non-atomic-server-import-with-required-pre-restore-backup'
    }
    target = [ordered]@{
      releaseId = [string]$TargetContext.releaseId
      releaseVersion = [string]$TargetContext.releaseVersion
      releaseCommit = [string]$TargetContext.releaseCommit
      transactionId = [string]$TargetContext.transactionId
      packageManifestSha256 = [string]$TargetContext.manifestSha256
      schemaVersion = [long]$TargetContext.contract.schemaVersion
    }
    backupManifestSha256 = [string]$Backup.manifestSha256
    backupPayloadSha256 = [string]$Backup.manifest.payload.sha256
    preRestore = $PreRestore
    restored = $Restored
    restoreScriptSha256 = Get-SteelFileSha256 -Path $RestoreScriptPath
    commonScriptSha256 = Get-SteelFileSha256 -Path $CommonScript
  }
  $ReceiptPath = Join-Path $ReceiptRoot ("$RestoreId.json")
  Write-SteelDurableJson -Path $ReceiptPath -Value $Receipt -Overwrite | Out-Null
  return $ReceiptPath
}

$DeploymentMutex = [System.Threading.Mutex]::new($false, 'Global\SteelInspectionRuntime-Deployment')
$DeploymentMutexAcquired = $false
try {
  try {
    $DeploymentMutexAcquired = $DeploymentMutex.WaitOne([TimeSpan]::FromSeconds(30))
  } catch [System.Threading.AbandonedMutexException] {
    $DeploymentMutexAcquired = $true
  }
  if (-not $DeploymentMutexAcquired) {
    throw 'Another SteelInspectionRuntime deployment, backup, restore, or uninstall transaction holds the global deployment mutex.'
  }

if ([string]::IsNullOrWhiteSpace($TargetRuntimeRoot)) {
  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -PathType Leaf) {
    $TargetRuntimeRoot = $PSScriptRoot
  } else {
    throw 'TargetRuntimeRoot is required. Pass the installed immutable release root that will read the restored database.'
  }
}
if ([string]::IsNullOrWhiteSpace($TargetStateRoot)) {
  $TargetStateRoot = Join-Path $env:ProgramData 'SteelInspectionRuntime'
}
$TargetStateRoot = [System.IO.Path]::GetFullPath($TargetStateRoot).TrimEnd('\', '/')
if ([string]::IsNullOrWhiteSpace($TargetActiveDeploymentPath)) {
  $TargetActiveDeploymentPath = Join-Path $TargetStateRoot 'deployment\active.json'
}
$TargetContext = Get-SteelRuntimeDatabaseContext `
  -RuntimeRoot $TargetRuntimeRoot `
  -ActiveDeploymentPath $TargetActiveDeploymentPath `
  -RequireActiveDeployment
if (-not $AllowEngineeringPackage) {
  if ([string]$TargetContext.manifest.packageClass -cne 'formal-release' -or $TargetContext.manifest.source.dirty -ne $false) {
    throw 'Production restore requires an installed formal-release package built from a clean source commit.'
  }
}
if (@($TargetContext.contract.engines) -cnotcontains $Engine) {
  throw "Target release does not support database engine $Engine."
}

$Backup = Get-SteelVerifiedBackup `
  -Directory $BackupDir `
  -ExpectedManifestHash $ExpectedBackupManifestSha256 `
  -Label 'Restore backup'
if ([string]$Backup.manifest.engine -cne $Engine) {
  throw 'Backup engine does not match -Engine.'
}
$BackupSchemaVersion = [long]$Backup.manifest.database.schemaVersion
if ($BackupSchemaVersion -lt [long]$TargetContext.contract.minReadableSchemaVersion -or
    $BackupSchemaVersion -gt [long]$TargetContext.contract.maxReadableSchemaVersion -or
    $BackupSchemaVersion -gt [long]$TargetContext.contract.rollbackReadableThrough) {
  throw "Backup schema version $BackupSchemaVersion is outside target release readable/rollback bounds."
}
if ([string]$Backup.manifest.release.releaseId -ceq [string]$TargetContext.releaseId -and
    [string]$Backup.manifest.release.packageManifestSha256 -cne [string]$TargetContext.manifestSha256) {
  throw 'Backup claims the target release identity but binds a different package manifest hash.'
}

$ExpectedConfirm = "RESTORE $Engine $($Backup.manifest.backupId) TO $($TargetContext.releaseId)"
if ($Confirm -cne $ExpectedConfirm) {
  throw "Explicit confirmation required: -Confirm '$ExpectedConfirm'"
}
Assert-SteelServiceStopped

if ([string]::IsNullOrWhiteSpace($ReceiptRoot)) {
  $ReceiptRoot = Join-Path $TargetStateRoot 'deployment\restore-history'
}
$ReceiptRoot = [System.IO.Path]::GetFullPath($ReceiptRoot)
New-Item -ItemType Directory -Force -Path $ReceiptRoot | Out-Null
Assert-SteelNoReparseChain -Path $ReceiptRoot | Out-Null
$RestoreId = [Guid]::NewGuid().ToString('D')
$RestoreStartedAt = [DateTime]::UtcNow.ToString('o')

if ($Engine -eq 'sqlite') {
  $ExpectedDatabasePath = Join-Path $TargetStateRoot 'service\steel-inspection.sqlite'
  if ([string]::IsNullOrWhiteSpace($DatabasePath)) {
    $DatabasePath = $ExpectedDatabasePath
  }
  $DatabasePath = [System.IO.Path]::GetFullPath($DatabasePath)
  if (-not $DatabasePath.Equals(
      [System.IO.Path]::GetFullPath($ExpectedDatabasePath),
      [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Managed SQLite restore path must be TargetStateRoot\service\steel-inspection.sqlite.'
  }
  $DatabaseParent = Split-Path -Parent $DatabasePath
  New-Item -ItemType Directory -Force -Path $DatabaseParent | Out-Null
  Assert-SteelNoReparseChain -Path $DatabaseParent | Out-Null

  $StagedRestorePath = Join-Path $DatabaseParent ('.restore-stage-' + $RestoreId + '.sqlite')
  Copy-SteelDurableFile -Source $Backup.payloadPath -Destination $StagedRestorePath | Out-Null
  $StagedEvidence = Get-SteelSqliteSnapshotEvidence -DatabasePath $StagedRestorePath
  if ([long]$StagedEvidence.schemaVersion -ne $BackupSchemaVersion -or
      [string]$StagedEvidence.sha256 -cne [string]$Backup.manifest.payload.sha256) {
    throw 'Staged SQLite snapshot differs from the verified backup contract.'
  }

  $RollbackRoot = Join-Path $TargetStateRoot ("deployment\restore-backups\$RestoreId")
  New-Item -ItemType Directory -Force -Path $RollbackRoot | Out-Null
  Assert-SteelNoReparseChain -Path $RollbackRoot | Out-Null
  $PreRestore = $null
  $TargetAcl = $null
  $TargetExisted = Test-Path -LiteralPath $DatabasePath -PathType Leaf
  if ($TargetExisted) {
    Assert-SteelNoReparseChain -Path $DatabasePath | Out-Null
    $TargetAcl = Get-Acl -LiteralPath $DatabasePath
    $CheckpointRows = Invoke-SteelSqliteQuery -DatabasePath $DatabasePath -Mode ReadWrite -Sql 'PRAGMA wal_checkpoint(TRUNCATE)'
    if ($CheckpointRows.Count -ne 1 -or $CheckpointRows[0].Count -lt 1 -or [string]$CheckpointRows[0][0] -cne '0') {
      throw 'Unable to prove a non-busy SQLite WAL checkpoint before restore.'
    }
    $WalPath = "$DatabasePath-wal"
    $ShmPath = "$DatabasePath-shm"
    if ((Test-Path -LiteralPath $WalPath -PathType Leaf) -and (Get-Item -LiteralPath $WalPath).Length -gt 0) {
      throw 'SQLite WAL still contains bytes after checkpoint; restore is forbidden.'
    }
    $CurrentEvidence = Get-SteelSqliteSnapshotEvidence -DatabasePath $DatabasePath
    $RollbackDatabasePath = Join-Path $RollbackRoot 'pre-restore.sqlite'
    Copy-SteelDurableFile -Source $DatabasePath -Destination $RollbackDatabasePath | Out-Null
    $RollbackEvidence = Get-SteelSqliteSnapshotEvidence -DatabasePath $RollbackDatabasePath
    if ([string]$RollbackEvidence.sha256 -cne [string]$CurrentEvidence.sha256) {
      throw 'Durable pre-restore SQLite rollback copy does not match the current database.'
    }
    $PreRestore = [ordered]@{
      existed = $true
      schemaVersion = [long]$CurrentEvidence.schemaVersion
      bytes = [long]$CurrentEvidence.bytes
      sha256 = [string]$CurrentEvidence.sha256
      rollbackPath = $RollbackDatabasePath
      rollbackSha256 = [string]$RollbackEvidence.sha256
      walCheckpoint = 'truncate-passed'
    }
    Write-SteelDurableJson `
      -Path (Join-Path $RollbackRoot 'rollback.json') `
      -Value ([ordered]@{
        schema = 'steel.database-restore-rollback.v2'
        restoreId = $RestoreId
        databasePath = $DatabasePath
        evidence = $PreRestore
        createdAtUtc = [DateTime]::UtcNow.ToString('o')
      }) | Out-Null
  } else {
    $PreRestore = [ordered]@{
      existed = $false
      schemaVersion = $null
      bytes = 0
      sha256 = ''
      rollbackPath = ''
      rollbackSha256 = ''
      walCheckpoint = 'not-applicable'
    }
  }

  $Switched = $false
  try {
    if ($TargetExisted) {
      $OperatingSystemBackupPath = Join-Path $RollbackRoot 'replace-file-backup.sqlite'
      [System.IO.File]::Replace($StagedRestorePath, $DatabasePath, $OperatingSystemBackupPath, $true)
    } else {
      [System.IO.File]::Move($StagedRestorePath, $DatabasePath)
    }
    $Switched = $true
    if ($null -ne $TargetAcl) {
      Set-Acl -LiteralPath $DatabasePath -AclObject $TargetAcl
    }
    foreach ($SidecarPath in @("$DatabasePath-wal", "$DatabasePath-shm")) {
      if (Test-Path -LiteralPath $SidecarPath -PathType Leaf) {
        if ((Get-Item -LiteralPath $SidecarPath).Length -gt 0 -and $SidecarPath.EndsWith('-wal')) {
          throw 'A non-empty SQLite WAL unexpectedly appeared during the offline atomic switch.'
        }
        Remove-Item -LiteralPath $SidecarPath -Force
      }
    }
    $RestoredEvidence = Get-SteelSqliteSnapshotEvidence -DatabasePath $DatabasePath
    if ([string]$RestoredEvidence.sha256 -cne [string]$Backup.manifest.payload.sha256 -or
        [long]$RestoredEvidence.schemaVersion -ne $BackupSchemaVersion) {
      throw 'Post-switch SQLite verification differs from the selected backup.'
    }
    $Restored = [ordered]@{
      schemaVersion = [long]$RestoredEvidence.schemaVersion
      bytes = [long]$RestoredEvidence.bytes
      sha256 = [string]$RestoredEvidence.sha256
      integrityCheck = [string]$RestoredEvidence.integrityCheck
      foreignKeyViolations = [int]$RestoredEvidence.foreignKeyViolations
      unresolvedMigrations = [int]$RestoredEvidence.unresolvedMigrations
      activation = 'service-remains-stopped'
    }
    $ReceiptPath = Write-SteelRestoreReceipt `
      -Outcome 'committed' `
      -Detail 'SQLite payload was durably staged, switched with a same-volume atomic file operation, and verified read-only.' `
      -PreRestore $PreRestore `
      -Restored $Restored
  } catch {
    $RestoreError = $_
    if ($Switched -and $TargetExisted) {
      $RollbackSucceeded = $false
      $RollbackFailure = $null
      try {
        $RollbackStage = Join-Path $DatabaseParent ('.restore-rollback-' + $RestoreId + '.sqlite')
        Copy-SteelDurableFile -Source ([string]$PreRestore.rollbackPath) -Destination $RollbackStage | Out-Null
        $FailedRestoreQuarantine = Join-Path $RollbackRoot 'failed-restored-payload.sqlite'
        [System.IO.File]::Replace($RollbackStage, $DatabasePath, $FailedRestoreQuarantine, $true)
        if ($null -ne $TargetAcl) {
          Set-Acl -LiteralPath $DatabasePath -AclObject $TargetAcl
        }
        $RollbackValidation = Get-SteelSqliteSnapshotEvidence -DatabasePath $DatabasePath
        if ([string]$RollbackValidation.sha256 -cne [string]$PreRestore.sha256) {
          throw 'Rollback payload hash does not match pre-restore evidence.'
        }
        $ReceiptPath = Write-SteelRestoreReceipt `
          -Outcome 'rolled-back' `
          -Detail "SQLite post-switch validation failed and the durable prior database was restored: $($RestoreError.Exception.Message)" `
          -PreRestore $PreRestore `
          -Restored $null
        $RollbackSucceeded = $true
      } catch {
        $RollbackFailure = $_
      }
      if ($RollbackSucceeded) {
        throw "SQLite restore failed after the switch; prior database was restored. Receipt: $ReceiptPath. Cause: $($RestoreError.Exception.Message)"
      } else {
        $ReceiptPath = Write-SteelRestoreReceipt `
          -Outcome 'failed-safe' `
          -Detail "SQLite restore and automatic rollback could not both be proven: restore=$($RestoreError.Exception.Message); rollback=$($RollbackFailure.Exception.Message)" `
          -PreRestore $PreRestore `
          -Restored $null
        throw "SQLite restore entered failed-safe state. Keep the service stopped. Receipt: $ReceiptPath"
      }
    } elseif ($Switched) {
      $QuarantinePath = Join-Path $RollbackRoot 'failed-new-database.sqlite'
      try {
        [System.IO.File]::Move($DatabasePath, $QuarantinePath)
      } catch {
        # The failed-safe receipt below is authoritative even if quarantine cannot complete.
      }
    }
    $ReceiptPath = Write-SteelRestoreReceipt `
      -Outcome 'failed-safe' `
      -Detail "SQLite restore did not commit: $($RestoreError.Exception.Message)" `
      -PreRestore $PreRestore `
      -Restored $null
    throw "SQLite restore failed. Keep the service stopped. Receipt: $ReceiptPath. Cause: $($RestoreError.Exception.Message)"
  } finally {
    if (Test-Path -LiteralPath $StagedRestorePath -PathType Leaf) {
      Remove-Item -LiteralPath $StagedRestorePath -Force
    }
  }
} else {
  if (-not $AllowNonAtomicMySqlRestore) {
    throw 'MySQL restore is not an atomic database operation; pass -AllowNonAtomicMySqlRestore only after approving its pre-restore backup and failed-safe runbook.'
  }
  if ($MySqlDatabase -cnotmatch '^[A-Za-z0-9_]{1,64}$' -or
      [string]$Backup.manifest.database.mysqlDatabase -cne $MySqlDatabase) {
    throw 'MySqlDatabase must be a simple identifier and match the backup manifest.'
  }
  if ([string]::IsNullOrWhiteSpace($MySqlDefaultsFile) -or
      -not (Test-Path -LiteralPath $MySqlDefaultsFile -PathType Leaf)) {
    throw 'MySqlDefaultsFile is required for MySQL restore.'
  }
  Assert-SteelNoReparseChain -Path $MySqlDefaultsFile | Out-Null
  if ([string]::IsNullOrWhiteSpace($MySqlPreRestoreBackupDir) -or
      [string]::IsNullOrWhiteSpace($ExpectedMySqlPreRestoreManifestSha256)) {
    throw 'MySQL restore requires an independently hash-pinned pre-restore backup of the current target database.'
  }
  $PreRestoreBackup = Get-SteelVerifiedBackup `
    -Directory $MySqlPreRestoreBackupDir `
    -ExpectedManifestHash $ExpectedMySqlPreRestoreManifestSha256 `
    -Label 'MySQL pre-restore backup'
  if ([string]$PreRestoreBackup.manifest.engine -cne 'mysql' -or
      [string]$PreRestoreBackup.manifest.backupId -ceq [string]$Backup.manifest.backupId -or
      [string]$PreRestoreBackup.manifest.database.mysqlDatabase -cne $MySqlDatabase) {
    throw 'MySQL pre-restore backup must be a distinct verified backup of the same target database.'
  }

  $ResolvedMySqlExe = Resolve-SteelCommandPath -Command $MySqlExe -Label 'mysql'
  $CurrentLedger = Get-SteelMySqlLedger `
    -Executable $ResolvedMySqlExe `
    -DefaultsFile $MySqlDefaultsFile `
    -Database $MySqlDatabase
  if ([long]$CurrentLedger.schemaVersion -ne [long]$PreRestoreBackup.manifest.database.schemaVersion) {
    throw 'Current MySQL schema ledger does not match the required pre-restore backup.'
  }
  $PreRestore = [ordered]@{
    existed = $true
    schemaVersion = [long]$CurrentLedger.schemaVersion
    backupId = [string]$PreRestoreBackup.manifest.backupId
    backupManifestSha256 = [string]$PreRestoreBackup.manifestSha256
    backupPayloadSha256 = [string]$PreRestoreBackup.manifest.payload.sha256
  }

  try {
    Invoke-SteelMySqlImport `
      -Executable $ResolvedMySqlExe `
      -DefaultsFile $MySqlDefaultsFile `
      -Database $MySqlDatabase `
      -InputFile $Backup.payloadPath
    $RestoredLedger = Get-SteelMySqlLedger `
      -Executable $ResolvedMySqlExe `
      -DefaultsFile $MySqlDefaultsFile `
      -Database $MySqlDatabase
    $TableRows = @(Invoke-SteelMySqlQuery `
      -Executable $ResolvedMySqlExe `
      -DefaultsFile $MySqlDefaultsFile `
      -Sql "SELECT CAST(COUNT(*) AS CHAR) FROM information_schema.tables WHERE table_schema = '$MySqlDatabase' AND table_type = 'BASE TABLE'")
    $TableCount = 0L
    if ([long]$RestoredLedger.schemaVersion -ne $BackupSchemaVersion -or
        $TableRows.Count -ne 1 -or
        -not [long]::TryParse($TableRows[0], [ref]$TableCount) -or
        $TableCount -ne [long]$Backup.manifest.verification.restoredTableCount) {
      throw 'Post-import MySQL schema ledger or table count differs from backup restorability evidence.'
    }
    $Restored = [ordered]@{
      schemaVersion = [long]$RestoredLedger.schemaVersion
      tableCount = [long]$TableCount
      unresolvedMigrations = [int]$RestoredLedger.unresolvedMigrations
      activation = 'service-remains-stopped'
    }
    $ReceiptPath = Write-SteelRestoreReceipt `
      -Outcome 'committed' `
      -Detail 'MySQL import and post-import ledger/table-count checks passed; the operation was explicitly non-atomic.' `
      -PreRestore $PreRestore `
      -Restored $Restored
  } catch {
    $ReceiptPath = Write-SteelRestoreReceipt `
      -Outcome 'failed-safe' `
      -Detail "MySQL import could not be proven complete; use the pinned pre-restore backup and DBA runbook: $($_.Exception.Message)" `
      -PreRestore $PreRestore `
      -Restored $null
    throw "MySQL restore entered failed-safe state. Keep the service stopped and restore the pinned pre-restore backup. Receipt: $ReceiptPath"
  }
}

$Result = [pscustomobject][ordered]@{
  schema = 'steel.database-restore-result.v2'
  code = 0
  restoreId = $RestoreId
  backupId = [string]$Backup.manifest.backupId
  engine = $Engine
  targetReleaseId = [string]$TargetContext.releaseId
  schemaVersion = $BackupSchemaVersion
  receiptPath = $ReceiptPath
  serviceState = 'stopped'
  nextRequiredAction = 'Start the pinned target release and pass database plus full runtime readiness checks before resuming production admission.'
}
$Result | ConvertTo-Json -Depth 5
} finally {
  if ($DeploymentMutexAcquired) {
    try { $DeploymentMutex.ReleaseMutex() } catch { }
  }
  $DeploymentMutex.Dispose()
}
