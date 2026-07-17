param(
  [ValidateSet('sqlite', 'mysql')]
  [string]$Engine = 'sqlite',
  [string]$RuntimeRoot = '',
  [string]$StateRoot = $env:STEEL_RUNTIME_STATE_ROOT,
  [string]$ActiveDeploymentPath = '',
  [string]$OutputRoot = '',
  [string]$ServiceOrigin = 'http://127.0.0.1:4873',
  [string]$AdminToken = '',
  [string]$MySqlDefaultsFile = '',
  [string]$MySqlDatabase = 'steel_inspection',
  [string]$MySqlVerificationDatabase = '',
  [string]$MySqlDumpExe = 'mysqldump.exe',
  [string]$MySqlExe = 'mysql.exe',
  [switch]$AllowMySqlVerificationDatabaseReset,
  [string]$ArtifactRoots = '',
  [switch]$AllowEngineeringPackage
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$CommonScript = Join-Path $PSScriptRoot 'database-recovery-common.ps1'
if (-not (Test-Path -LiteralPath $CommonScript -PathType Leaf)) {
  throw "Database recovery common library is missing: $CommonScript"
}
. $CommonScript

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
    throw "mysql temporary restore failed with exit code $($Process.ExitCode)."
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
  if ($Columns.Count -ne 3) {
    throw "MySQL schema ledger row has an invalid shape in $Database."
  }
  $SchemaVersion = 0L
  if (-not [long]::TryParse($Columns[0], [ref]$SchemaVersion) -or $SchemaVersion -lt 1 -or
      $Columns[1] -cne '0' -or -not [string]::IsNullOrEmpty($Columns[2])) {
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
    dirty = 0
    activeMigrationId = ''
    unresolvedMigrations = 0
  }
}

function Get-SteelAuthenticatedJson {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][hashtable]$Headers
  )

  return Invoke-RestMethod `
    -Uri "$($ServiceOrigin.TrimEnd('/'))$Path" `
    -Headers $Headers `
    -Method Get `
    -TimeoutSec 120 `
    -UseBasicParsing
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

if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -PathType Leaf) {
    $RuntimeRoot = $PSScriptRoot
  } else {
    throw 'RuntimeRoot is required. Run the packaged script from an installed immutable release, or pass its release root explicitly.'
  }
}
if ([string]::IsNullOrWhiteSpace($StateRoot)) {
  $StateRoot = Join-Path $env:ProgramData 'SteelInspectionRuntime'
}
$StateRoot = [System.IO.Path]::GetFullPath($StateRoot)
if ([string]::IsNullOrWhiteSpace($ActiveDeploymentPath)) {
  $ActiveDeploymentPath = Join-Path $StateRoot 'deployment\active.json'
}
$Context = Get-SteelRuntimeDatabaseContext `
  -RuntimeRoot $RuntimeRoot `
  -ActiveDeploymentPath $ActiveDeploymentPath `
  -RequireActiveDeployment

if (-not $AllowEngineeringPackage) {
  if ([string]$Context.manifest.packageClass -cne 'formal-release' -or $Context.manifest.source.dirty -ne $false) {
    throw 'Production backups require an installed formal-release package built from a clean source commit.'
  }
}
if (@($Context.contract.engines) -cnotcontains $Engine) {
  throw "Runtime database contract does not support engine $Engine."
}
if ([string]::IsNullOrWhiteSpace($AdminToken)) {
  throw 'AdminToken is required to bind the backup to authenticated service schema and integrity evidence.'
}
if ($ServiceOrigin -cnotmatch '^http://127\.0\.0\.1:[1-9][0-9]{0,4}$') {
  throw 'ServiceOrigin must be an explicit loopback HTTP origin.'
}

$Headers = @{
  Authorization = "Bearer $AdminToken"
  Accept = 'application/json'
}
$ProductionStatus = Get-SteelAuthenticatedJson -Path '/api/production/status' -Headers $Headers
if ([int]$ProductionStatus.code -ne 0 -or
    [string]$ProductionStatus.database.engine -cne $Engine -or
    [long]$ProductionStatus.database.schemaVersion -ne [long]$Context.contract.schemaVersion) {
  throw 'The running service database engine/schema does not match the installed release contract.'
}
$IntegrityStatus = Get-SteelAuthenticatedJson -Path '/api/admin/database/integrity' -Headers $Headers
if ([int]$IntegrityStatus.code -ne 0 -or [string]$IntegrityStatus.status -cne 'ok') {
  throw 'The running service database integrity check did not pass.'
}

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  $OutputRoot = Join-Path $StateRoot 'backups\manual'
}
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot).TrimEnd('\', '/')
$RuntimeFullPath = [System.IO.Path]::GetFullPath($Context.runtimeRoot).TrimEnd('\', '/')
if ($OutputRoot.Equals($RuntimeFullPath, [System.StringComparison]::OrdinalIgnoreCase) -or
    $OutputRoot.StartsWith($RuntimeFullPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Backup output must be outside the immutable runtime release root.'
}
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
Assert-SteelNoReparseChain -Path $OutputRoot | Out-Null

$ArtifactRootValues = [System.Collections.Generic.List[string]]::new()
$ArtifactRootSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($ArtifactRoot in @($ArtifactRoots -split ';')) {
  if ([string]::IsNullOrWhiteSpace($ArtifactRoot)) { continue }
  $ArtifactFullPath = [System.IO.Path]::GetFullPath($ArtifactRoot.Trim()).TrimEnd('\', '/')
  if (-not [System.IO.Path]::IsPathRooted($ArtifactFullPath) -or -not $ArtifactRootSet.Add($ArtifactFullPath)) {
    throw "ArtifactRoots contains a duplicate or invalid path: $ArtifactRoot"
  }
  $ArtifactRootValues.Add($ArtifactFullPath)
}

$BackupId = [Guid]::NewGuid().ToString('D')
$Timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss.fffZ')
$FinalDirectoryName = "database-$Engine-$Timestamp-$($BackupId.Substring(0, 8))"
$FinalBackupDir = Join-Path $OutputRoot $FinalDirectoryName
$StagingBackupDir = Join-Path $OutputRoot ('.incomplete-' + $FinalDirectoryName)
if ((Test-Path -LiteralPath $FinalBackupDir) -or (Test-Path -LiteralPath $StagingBackupDir)) {
  throw 'Generated backup destination unexpectedly already exists.'
}
New-Item -ItemType Directory -Path $StagingBackupDir | Out-Null
Assert-SteelNoReparseChain -Path $StagingBackupDir | Out-Null

$BackupFileName = if ($Engine -eq 'sqlite') { 'steel-inspection.sqlite' } else { 'steel-inspection.sql' }
$BackupFile = Join-Path $StagingBackupDir $BackupFileName
$Verification = $null
$DatabaseServerVersion = ''
$MySqlClientVersion = ''
$MySqlDumpVersion = ''

if ($Engine -eq 'sqlite') {
  $DownloadPath = Join-Path $StagingBackupDir ('.download-' + [Guid]::NewGuid().ToString('N') + '.sqlite')
  try {
    Invoke-WebRequest `
      -Uri "$($ServiceOrigin.TrimEnd('/'))/api/admin/database/backup" `
      -Headers @{ Authorization = "Bearer $AdminToken"; Accept = 'application/x-sqlite3' } `
      -OutFile $DownloadPath `
      -UseBasicParsing `
      -TimeoutSec 120
    Copy-SteelDurableFile -Source $DownloadPath -Destination $BackupFile | Out-Null
  } finally {
    if (Test-Path -LiteralPath $DownloadPath -PathType Leaf) {
      Remove-Item -LiteralPath $DownloadPath -Force
    }
  }
  $SnapshotEvidence = Get-SteelSqliteSnapshotEvidence -DatabasePath $BackupFile
  if ([long]$SnapshotEvidence.schemaVersion -ne [long]$Context.contract.schemaVersion) {
    throw 'SQLite snapshot schema version does not match the installed release contract.'
  }
  $Verification = [ordered]@{
    status = 'passed'
    method = [string]$SnapshotEvidence.method
    verifiedAtUtc = [DateTime]::UtcNow.ToString('o')
    schemaVersion = [long]$SnapshotEvidence.schemaVersion
    integrityCheck = [string]$SnapshotEvidence.integrityCheck
    foreignKeyViolations = [int]$SnapshotEvidence.foreignKeyViolations
    unresolvedMigrations = [int]$SnapshotEvidence.unresolvedMigrations
    nonInnoDbTables = 0
    restoredTableCount = 0
  }
} else {
  if ($MySqlDatabase -cnotmatch '^[A-Za-z0-9_]{1,64}$') {
    throw 'MySqlDatabase must be a simple 1..64 character identifier.'
  }
  if ($MySqlVerificationDatabase -cnotmatch '^[A-Za-z0-9_]{1,64}$' -or
      $MySqlVerificationDatabase -ceq $MySqlDatabase) {
    throw 'MySqlVerificationDatabase must be a distinct simple 1..64 character identifier.'
  }
  if (-not $AllowMySqlVerificationDatabaseReset) {
    throw 'MySQL backup restorability proof requires -AllowMySqlVerificationDatabaseReset for the explicitly named temporary database.'
  }
  if ([string]::IsNullOrWhiteSpace($MySqlDefaultsFile) -or
      -not (Test-Path -LiteralPath $MySqlDefaultsFile -PathType Leaf)) {
    throw 'MySqlDefaultsFile is required. Store credentials in its [client] section and restrict its ACL.'
  }
  Assert-SteelNoReparseChain -Path $MySqlDefaultsFile | Out-Null
  $ResolvedMySqlExe = Resolve-SteelCommandPath -Command $MySqlExe -Label 'mysql'
  $ResolvedMySqlDumpExe = Resolve-SteelCommandPath -Command $MySqlDumpExe -Label 'mysqldump'
  $MySqlClientVersion = ((& $ResolvedMySqlExe '--version' 2>$null) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($MySqlClientVersion)) {
    throw 'Unable to obtain mysql client version.'
  }
  $MySqlDumpVersion = ((& $ResolvedMySqlDumpExe '--version' 2>$null) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($MySqlDumpVersion)) {
    throw 'Unable to obtain mysqldump version.'
  }
  $DatabaseServerVersionRows = @(Invoke-SteelMySqlQuery -Executable $ResolvedMySqlExe -DefaultsFile $MySqlDefaultsFile -Sql 'SELECT VERSION()')
  if ($DatabaseServerVersionRows.Count -ne 1 -or [string]::IsNullOrWhiteSpace($DatabaseServerVersionRows[0])) {
    throw 'Unable to obtain MySQL server version.'
  }
  $DatabaseServerVersion = $DatabaseServerVersionRows[0]
  $SourceLedger = Get-SteelMySqlLedger -Executable $ResolvedMySqlExe -DefaultsFile $MySqlDefaultsFile -Database $MySqlDatabase
  if ([long]$SourceLedger.schemaVersion -ne [long]$Context.contract.schemaVersion) {
    throw 'MySQL source schema version does not match the installed release contract.'
  }
  $NonInnoDbRows = @(Invoke-SteelMySqlQuery `
    -Executable $ResolvedMySqlExe `
    -DefaultsFile $MySqlDefaultsFile `
    -Sql "SELECT CAST(COUNT(*) AS CHAR) FROM information_schema.tables WHERE table_schema = '$MySqlDatabase' AND table_type = 'BASE TABLE' AND engine <> 'InnoDB'")
  $SourceTableRows = @(Invoke-SteelMySqlQuery `
    -Executable $ResolvedMySqlExe `
    -DefaultsFile $MySqlDefaultsFile `
    -Sql "SELECT CAST(COUNT(*) AS CHAR) FROM information_schema.tables WHERE table_schema = '$MySqlDatabase' AND table_type = 'BASE TABLE'")
  if ($NonInnoDbRows.Count -ne 1 -or $NonInnoDbRows[0] -cne '0') {
    throw 'MySQL --single-transaction backup is forbidden unless every application table uses InnoDB.'
  }
  $SourceTableCount = 0L
  if ($SourceTableRows.Count -ne 1 -or
      -not [long]::TryParse($SourceTableRows[0], [ref]$SourceTableCount) -or
      $SourceTableCount -lt 1) {
    throw 'MySQL source database must contain at least one base table.'
  }

  $DumpArguments = @(
    "--defaults-extra-file=`"$MySqlDefaultsFile`"",
    '--single-transaction',
    '--quick',
    '--routines',
    '--triggers',
    '--events',
    '--hex-blob',
    '--set-gtid-purged=OFF',
    '--skip-lock-tables',
    '--no-tablespaces',
    '--default-character-set=utf8mb4',
    "--result-file=`"$BackupFile`"",
    $MySqlDatabase
  )
  $DumpProcess = Start-Process -FilePath $ResolvedMySqlDumpExe -ArgumentList $DumpArguments -NoNewWindow -Wait -PassThru
  if ($DumpProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $BackupFile -PathType Leaf)) {
    throw "mysqldump failed with exit code $($DumpProcess.ExitCode)."
  }
  $DumpFlush = [System.IO.FileStream]::new(
    $BackupFile,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::Read,
    4096,
    [System.IO.FileOptions]::WriteThrough
  )
  try { $DumpFlush.Flush($true) } finally { $DumpFlush.Dispose() }

  $VerificationDatabaseCreated = $false
  $VerificationFailure = $null
  try {
    Invoke-SteelMySqlQuery `
      -Executable $ResolvedMySqlExe `
      -DefaultsFile $MySqlDefaultsFile `
      -Sql "DROP DATABASE IF EXISTS ``$MySqlVerificationDatabase``; CREATE DATABASE ``$MySqlVerificationDatabase``" | Out-Null
    $VerificationDatabaseCreated = $true
    Invoke-SteelMySqlImport `
      -Executable $ResolvedMySqlExe `
      -DefaultsFile $MySqlDefaultsFile `
      -Database $MySqlVerificationDatabase `
      -InputFile $BackupFile
    $RestoredLedger = Get-SteelMySqlLedger `
      -Executable $ResolvedMySqlExe `
      -DefaultsFile $MySqlDefaultsFile `
      -Database $MySqlVerificationDatabase
    $RestoredTableRows = @(Invoke-SteelMySqlQuery `
      -Executable $ResolvedMySqlExe `
      -DefaultsFile $MySqlDefaultsFile `
      -Sql "SELECT CAST(COUNT(*) AS CHAR) FROM information_schema.tables WHERE table_schema = '$MySqlVerificationDatabase' AND table_type = 'BASE TABLE'")
    $RestoredTableCount = 0L
    if ($RestoredTableRows.Count -ne 1 -or
        -not [long]::TryParse($RestoredTableRows[0], [ref]$RestoredTableCount) -or
        $RestoredTableCount -ne $SourceTableCount -or
        [long]$RestoredLedger.schemaVersion -ne [long]$Context.contract.schemaVersion) {
      throw 'MySQL temporary restore table count or schema ledger differs from the source database.'
    }
    $Verification = [ordered]@{
      status = 'passed'
      method = 'mysql-temporary-database-restore'
      verifiedAtUtc = [DateTime]::UtcNow.ToString('o')
      schemaVersion = [long]$RestoredLedger.schemaVersion
      integrityCheck = 'ledger-and-table-count'
      foreignKeyViolations = 0
      unresolvedMigrations = [int]$RestoredLedger.unresolvedMigrations
      nonInnoDbTables = 0
      restoredTableCount = [long]$RestoredTableCount
    }
  } catch {
    $VerificationFailure = $_
  } finally {
    if ($VerificationDatabaseCreated) {
      try {
        Invoke-SteelMySqlQuery `
          -Executable $ResolvedMySqlExe `
          -DefaultsFile $MySqlDefaultsFile `
          -Sql "DROP DATABASE ``$MySqlVerificationDatabase``" | Out-Null
      } catch {
        if ($null -eq $VerificationFailure) {
          $VerificationFailure = $_
        } else {
          $VerificationFailure = [System.Management.Automation.RuntimeException]::new(
            "$($VerificationFailure.Exception.Message) Temporary verification database cleanup also failed: $($_.Exception.Message)"
          )
        }
      }
    }
  }
  if ($null -ne $VerificationFailure) {
    throw $VerificationFailure
  }
}

$BackupItem = Get-Item -LiteralPath $BackupFile
$BackupHash = Get-SteelFileSha256 -Path $BackupFile
$BackupScriptHash = Get-SteelFileSha256 -Path $MyInvocation.MyCommand.Path
$ConsistencyModel = if ($Engine -eq 'sqlite') { 'sqlite-vacuum-into' } else { 'mysql-single-transaction-innodb' }
$Manifest = [ordered]@{
  schema = 'steel.database-backup.v2'
  backupId = $BackupId
  engine = $Engine
  createdAtUtc = [DateTime]::UtcNow.ToString('o')
  release = [ordered]@{
    releaseId = [string]$Context.releaseId
    releaseVersion = [string]$Context.releaseVersion
    releaseCommit = [string]$Context.releaseCommit
    transactionId = [string]$Context.transactionId
    packageManifestSha256 = [string]$Context.manifestSha256
    activeDeploymentSha256 = [string]$Context.activeDeploymentSha256
  }
  database = [ordered]@{
    schemaVersion = [long]$Context.contract.schemaVersion
    contractSchema = [string]$Context.contract.contractSchema
    contractSha256 = [string]$Context.contractSha256
    migrationIndexSha256 = [string]$Context.migrationIndexSha256
    stateLayoutVersion = [long]$Context.contract.stateLayoutVersion
    mysqlDatabase = if ($Engine -eq 'mysql') { $MySqlDatabase } else { $null }
    serverVersion = if ($Engine -eq 'mysql') { $DatabaseServerVersion } else { 'winsqlite3' }
  }
  payload = [ordered]@{
    file = $BackupFileName
    bytes = [long]$BackupItem.Length
    sha256 = $BackupHash
    consistencyModel = $ConsistencyModel
  }
  verification = $Verification
  source = [ordered]@{
    serviceOrigin = $ServiceOrigin
    serviceReportedEngine = [string]$ProductionStatus.database.engine
    serviceReportedSchemaVersion = [long]$ProductionStatus.database.schemaVersion
    serviceIntegrityStatus = [string]$IntegrityStatus.status
  }
  artifactRoots = @($ArtifactRootValues)
  tool = [ordered]@{
    backupScriptSha256 = $BackupScriptHash
    commonScriptSha256 = Get-SteelFileSha256 -Path $CommonScript
    powerShellVersion = $PSVersionTable.PSVersion.ToString()
    mysqlClientVersion = $MySqlClientVersion
    mysqlDumpVersion = $MySqlDumpVersion
  }
}

$ManifestPath = Join-Path $StagingBackupDir 'manifest.json'
Write-SteelDurableJson -Path $ManifestPath -Value $Manifest | Out-Null
$ParsedManifest = Read-SteelJsonFile -Path $ManifestPath -Label 'Completed backup manifest'
Assert-SteelBackupManifestV2 -Manifest $ParsedManifest
if ((Get-SteelFileSha256 -Path $BackupFile) -cne [string]$ParsedManifest.payload.sha256) {
  throw 'Backup payload changed after manifest creation.'
}

[System.IO.Directory]::Move($StagingBackupDir, $FinalBackupDir)
$FinalManifestPath = Join-Path $FinalBackupDir 'manifest.json'
$Result = [pscustomobject][ordered]@{
  schema = 'steel.database-backup-result.v2'
  code = 0
  backupId = $BackupId
  engine = $Engine
  backupDirectory = $FinalBackupDir
  manifestPath = $FinalManifestPath
  manifestSha256 = Get-SteelFileSha256 -Path $FinalManifestPath
  payloadPath = Join-Path $FinalBackupDir $BackupFileName
  payloadSha256 = $BackupHash
  verificationStatus = 'passed'
}
$Result | ConvertTo-Json -Depth 5
} finally {
  if ($DeploymentMutexAcquired) {
    try { $DeploymentMutex.ReleaseMutex() } catch { }
  }
  $DeploymentMutex.Dispose()
}
