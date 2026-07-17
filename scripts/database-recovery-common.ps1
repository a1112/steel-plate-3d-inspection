Set-StrictMode -Version 3.0

function Assert-SteelLowerSha256 {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if ($Value -cnotmatch '^[0-9a-f]{64}$') {
    throw "$Label must be a lowercase SHA-256 value."
  }
}

function Get-SteelFileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Required file is missing: $Path"
  }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-SteelNoReparseChain {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$AllowMissingLeaf
  )

  $FullPath = [System.IO.Path]::GetFullPath($Path)
  $Cursor = $FullPath
  $First = $true
  while (-not [string]::IsNullOrWhiteSpace($Cursor)) {
    if (Test-Path -LiteralPath $Cursor) {
      $Item = Get-Item -LiteralPath $Cursor -Force
      if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Database recovery paths must not traverse a reparse point: $Cursor"
      }
    } elseif (-not ($AllowMissingLeaf -and $First)) {
      $Parent = Split-Path -Parent $Cursor
      if ($Parent -eq $Cursor) { break }
      $Cursor = $Parent
      $First = $false
      continue
    }
    $Parent = Split-Path -Parent $Cursor
    if ([string]::IsNullOrWhiteSpace($Parent) -or $Parent -eq $Cursor) { break }
    $Cursor = $Parent
    $First = $false
  }
  return $FullPath
}

function Assert-SteelCanonicalRelativePath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if ([string]::IsNullOrWhiteSpace($Path) -or
      [System.IO.Path]::IsPathRooted($Path) -or
      $Path.Contains('\') -or
      $Path -match '(^/|/$|//|(^|/)\.\.?(/|$)|[:\x00-\x1f])') {
    throw "$Label must be a canonical forward-slash relative path: $Path"
  }
}

function Resolve-SteelContainedFile {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string]$Label
  )

  Assert-SteelCanonicalRelativePath -Path $RelativePath -Label $Label
  $ResolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $ResolvedPath = [System.IO.Path]::GetFullPath((Join-Path $ResolvedRoot ($RelativePath -replace '/', '\')))
  if (-not $ResolvedPath.StartsWith(
      $ResolvedRoot + [System.IO.Path]::DirectorySeparatorChar,
      [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label escapes its trusted root: $RelativePath"
  }
  if (-not (Test-Path -LiteralPath $ResolvedPath -PathType Leaf)) {
    throw "$Label is missing: $RelativePath"
  }
  Assert-SteelNoReparseChain -Path $ResolvedPath | Out-Null
  return $ResolvedPath
}

function Read-SteelJsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is missing: $Path"
  }
  Assert-SteelNoReparseChain -Path $Path | Out-Null
  try {
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "$Label must be valid UTF-8 JSON: $Path"
  }
}

function Write-SteelDurableBytes {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][byte[]]$Bytes,
    [switch]$Overwrite
  )

  $FullPath = [System.IO.Path]::GetFullPath($Path)
  $Parent = Split-Path -Parent $FullPath
  if ([string]::IsNullOrWhiteSpace($Parent)) {
    throw "Durable output path has no parent: $FullPath"
  }
  if (-not (Test-Path -LiteralPath $Parent -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $Parent | Out-Null
  }
  Assert-SteelNoReparseChain -Path $Parent | Out-Null
  if ((Test-Path -LiteralPath $FullPath) -and -not $Overwrite) {
    throw "Refusing to overwrite durable output: $FullPath"
  }
  $TemporaryPath = Join-Path $Parent ('.durable-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $ReplaceBackupPath = Join-Path $Parent ('.durable-replaced-' + [Guid]::NewGuid().ToString('N') + '.bak')
  try {
    $Stream = [System.IO.FileStream]::new(
      $TemporaryPath,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::None,
      65536,
      [System.IO.FileOptions]::WriteThrough
    )
    try {
      $Stream.Write($Bytes, 0, $Bytes.Length)
      $Stream.Flush($true)
    } finally {
      $Stream.Dispose()
    }
    if ($Overwrite -and (Test-Path -LiteralPath $FullPath -PathType Leaf)) {
      [System.IO.File]::Replace($TemporaryPath, $FullPath, $ReplaceBackupPath, $true)
      Remove-Item -LiteralPath $ReplaceBackupPath -Force
    } else {
      [System.IO.File]::Move($TemporaryPath, $FullPath)
    }
  } finally {
    if (Test-Path -LiteralPath $TemporaryPath -PathType Leaf) {
      Remove-Item -LiteralPath $TemporaryPath -Force
    }
    if (Test-Path -LiteralPath $ReplaceBackupPath -PathType Leaf) {
      Remove-Item -LiteralPath $ReplaceBackupPath -Force
    }
  }
  return $FullPath
}

function Write-SteelDurableJson {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value,
    [switch]$Overwrite
  )

  $Json = $Value | ConvertTo-Json -Depth 20
  $Bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Json + "`n")
  return Write-SteelDurableBytes -Path $Path -Bytes $Bytes -Overwrite:$Overwrite
}

function Copy-SteelDurableFile {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [switch]$Overwrite
  )

  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "Durable copy source is missing: $Source"
  }
  Assert-SteelNoReparseChain -Path $Source | Out-Null
  $DestinationFullPath = [System.IO.Path]::GetFullPath($Destination)
  $Parent = Split-Path -Parent $DestinationFullPath
  if (-not (Test-Path -LiteralPath $Parent -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $Parent | Out-Null
  }
  Assert-SteelNoReparseChain -Path $Parent | Out-Null
  if ((Test-Path -LiteralPath $DestinationFullPath) -and -not $Overwrite) {
    throw "Refusing to overwrite durable copy destination: $DestinationFullPath"
  }
  $TemporaryPath = Join-Path $Parent ('.copy-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $ReplaceBackupPath = Join-Path $Parent ('.copy-replaced-' + [Guid]::NewGuid().ToString('N') + '.bak')
  try {
    $Input = [System.IO.FileStream]::new(
      [System.IO.Path]::GetFullPath($Source),
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::Read,
      65536,
      [System.IO.FileOptions]::SequentialScan
    )
    try {
      $Output = [System.IO.FileStream]::new(
        $TemporaryPath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None,
        65536,
        [System.IO.FileOptions]::WriteThrough
      )
      try {
        $Input.CopyTo($Output, 65536)
        $Output.Flush($true)
      } finally {
        $Output.Dispose()
      }
    } finally {
      $Input.Dispose()
    }
    if ($Overwrite -and (Test-Path -LiteralPath $DestinationFullPath -PathType Leaf)) {
      [System.IO.File]::Replace($TemporaryPath, $DestinationFullPath, $ReplaceBackupPath, $true)
      Remove-Item -LiteralPath $ReplaceBackupPath -Force
    } else {
      [System.IO.File]::Move($TemporaryPath, $DestinationFullPath)
    }
  } finally {
    if (Test-Path -LiteralPath $TemporaryPath -PathType Leaf) {
      Remove-Item -LiteralPath $TemporaryPath -Force
    }
    if (Test-Path -LiteralPath $ReplaceBackupPath -PathType Leaf) {
      Remove-Item -LiteralPath $ReplaceBackupPath -Force
    }
  }
  return $DestinationFullPath
}

function Initialize-SteelWinSqlite {
  if ('Steel.DatabaseRecovery.WinSqliteV2' -as [type]) {
    return
  }

  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace Steel.DatabaseRecovery {
  public static class WinSqliteV2 {
    private const int SQLITE_OK = 0;
    private const int SQLITE_ROW = 100;
    private const int SQLITE_DONE = 101;

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_open_v2(IntPtr filename, out IntPtr database, int flags, IntPtr vfs);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_close_v2(IntPtr database);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_errmsg(IntPtr database);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_prepare_v2(IntPtr database, IntPtr sql, int byteCount, out IntPtr statement, IntPtr tail);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_step(IntPtr statement);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_finalize(IntPtr statement);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_column_count(IntPtr statement);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_column_text(IntPtr statement, int column);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_column_bytes(IntPtr statement, int column);

    private static IntPtr Utf8Pointer(string value) {
      byte[] bytes = Encoding.UTF8.GetBytes(value + "\0");
      IntPtr pointer = Marshal.AllocHGlobal(bytes.Length);
      Marshal.Copy(bytes, 0, pointer, bytes.Length);
      return pointer;
    }

    private static string Utf8String(IntPtr pointer, int byteCount) {
      if (pointer == IntPtr.Zero || byteCount <= 0) return String.Empty;
      byte[] bytes = new byte[byteCount];
      Marshal.Copy(pointer, bytes, 0, byteCount);
      return Encoding.UTF8.GetString(bytes);
    }

    private static string Error(IntPtr database, int code) {
      if (database == IntPtr.Zero) return "SQLite error " + code;
      IntPtr pointer = sqlite3_errmsg(database);
      if (pointer == IntPtr.Zero) return "SQLite error " + code;
      int length = 0;
      while (Marshal.ReadByte(pointer, length) != 0) length++;
      return Utf8String(pointer, length) + " (SQLite code " + code + ")";
    }

    public static string[][] Query(string path, string sql, int flags) {
      IntPtr database = IntPtr.Zero;
      IntPtr statement = IntPtr.Zero;
      IntPtr pathPointer = IntPtr.Zero;
      IntPtr sqlPointer = IntPtr.Zero;
      try {
        pathPointer = Utf8Pointer(path);
        int openCode = sqlite3_open_v2(pathPointer, out database, flags, IntPtr.Zero);
        if (openCode != SQLITE_OK) throw new InvalidOperationException(Error(database, openCode));
        sqlPointer = Utf8Pointer(sql);
        int prepareCode = sqlite3_prepare_v2(database, sqlPointer, -1, out statement, IntPtr.Zero);
        if (prepareCode != SQLITE_OK) throw new InvalidOperationException(Error(database, prepareCode));
        List<string[]> rows = new List<string[]>();
        while (true) {
          int stepCode = sqlite3_step(statement);
          if (stepCode == SQLITE_DONE) break;
          if (stepCode != SQLITE_ROW) throw new InvalidOperationException(Error(database, stepCode));
          int columns = sqlite3_column_count(statement);
          string[] row = new string[columns];
          for (int column = 0; column < columns; column++) {
            IntPtr value = sqlite3_column_text(statement, column);
            row[column] = Utf8String(value, sqlite3_column_bytes(statement, column));
          }
          rows.Add(row);
        }
        return rows.ToArray();
      } finally {
        if (statement != IntPtr.Zero) sqlite3_finalize(statement);
        if (database != IntPtr.Zero) sqlite3_close_v2(database);
        if (sqlPointer != IntPtr.Zero) Marshal.FreeHGlobal(sqlPointer);
        if (pathPointer != IntPtr.Zero) Marshal.FreeHGlobal(pathPointer);
      }
    }
  }
}
'@
}

function Invoke-SteelSqliteQuery {
  param(
    [Parameter(Mandatory = $true)][string]$DatabasePath,
    [Parameter(Mandatory = $true)][string]$Sql,
    [ValidateSet('ReadOnly', 'ReadWrite', 'Create')][string]$Mode = 'ReadOnly'
  )

  Initialize-SteelWinSqlite
  $Flags = switch ($Mode) {
    'ReadOnly' { 0x00000001 }
    'ReadWrite' { 0x00000002 }
    'Create' { 0x00000006 }
  }
  $Rows = [Steel.DatabaseRecovery.WinSqliteV2]::Query(
    [System.IO.Path]::GetFullPath($DatabasePath),
    $Sql,
    $Flags
  )
  return ,$Rows
}

function Get-SteelSqliteSnapshotEvidence {
  param([Parameter(Mandatory = $true)][string]$DatabasePath)

  if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
    throw "SQLite snapshot is missing: $DatabasePath"
  }
  Assert-SteelNoReparseChain -Path $DatabasePath | Out-Null
  $File = Get-Item -LiteralPath $DatabasePath
  if ($File.Length -lt 100) {
    throw "SQLite snapshot is too small to be valid: $DatabasePath"
  }
  $HeaderBytes = New-Object byte[] 16
  $HeaderStream = [System.IO.File]::OpenRead($DatabasePath)
  try {
    if ($HeaderStream.Read($HeaderBytes, 0, $HeaderBytes.Length) -ne 16) {
      throw "SQLite snapshot header is truncated: $DatabasePath"
    }
  } finally {
    $HeaderStream.Dispose()
  }
  if ([System.Text.Encoding]::ASCII.GetString($HeaderBytes) -cne "SQLite format 3`0") {
    throw "SQLite snapshot header is invalid: $DatabasePath"
  }

  $IntegrityRows = Invoke-SteelSqliteQuery -DatabasePath $DatabasePath -Sql 'PRAGMA integrity_check'
  if ($IntegrityRows.Count -ne 1 -or $IntegrityRows[0].Count -ne 1 -or [string]$IntegrityRows[0][0] -cne 'ok') {
    $Messages = @($IntegrityRows | ForEach-Object { $_ -join ':' })
    throw "SQLite integrity_check failed: $($Messages -join '; ')"
  }
  $ForeignKeyRows = Invoke-SteelSqliteQuery -DatabasePath $DatabasePath -Sql 'PRAGMA foreign_key_check'
  if ($ForeignKeyRows.Count -ne 0) {
    throw "SQLite foreign_key_check returned $($ForeignKeyRows.Count) violation(s)."
  }
  $LedgerRows = Invoke-SteelSqliteQuery -DatabasePath $DatabasePath -Sql "SELECT CAST(current_version AS TEXT), CAST(dirty AS TEXT), COALESCE(active_migration_id, '') FROM steel_schema_state WHERE singleton_id = 1"
  if ($LedgerRows.Count -ne 1 -or $LedgerRows[0].Count -ne 3) {
    throw 'SQLite schema ledger must contain exactly one singleton row.'
  }
  $SchemaVersion = 0L
  if (-not [long]::TryParse([string]$LedgerRows[0][0], [ref]$SchemaVersion) -or $SchemaVersion -lt 1) {
    throw 'SQLite schema ledger current_version is invalid.'
  }
  if ([string]$LedgerRows[0][1] -cne '0' -or -not [string]::IsNullOrEmpty([string]$LedgerRows[0][2])) {
    throw 'SQLite schema ledger is dirty or has an active migration.'
  }
  $PendingRows = Invoke-SteelSqliteQuery -DatabasePath $DatabasePath -Sql "SELECT CAST(COUNT(*) AS TEXT) FROM steel_schema_migration WHERE state NOT IN ('applied', 'rolled-back')"
  if ($PendingRows.Count -ne 1 -or $PendingRows[0].Count -ne 1 -or [string]$PendingRows[0][0] -cne '0') {
    throw 'SQLite migration ledger contains an unresolved migration.'
  }

  return [pscustomobject][ordered]@{
    method = 'winsqlite3-readonly-integrity-check'
    integrityCheck = 'ok'
    foreignKeyViolations = 0
    unresolvedMigrations = 0
    schemaVersion = $SchemaVersion
    bytes = [long]$File.Length
    sha256 = Get-SteelFileSha256 -Path $DatabasePath
  }
}

function Get-SteelRuntimeDatabaseContext {
  param(
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [string]$ActiveDeploymentPath = '',
    [switch]$RequireActiveDeployment
  )

  $RuntimeRoot = (Resolve-Path -LiteralPath $RuntimeRoot -ErrorAction Stop).Path
  Assert-SteelNoReparseChain -Path $RuntimeRoot | Out-Null
  $ManifestPath = Join-Path $RuntimeRoot 'manifest.json'
  $Manifest = Read-SteelJsonFile -Path $ManifestPath -Label 'Runtime package manifest'
  if ([string]$Manifest.schema -cne 'steel.runtime-package.v1') {
    throw 'Runtime package manifest schema must be steel.runtime-package.v1.'
  }
  if ([string]$Manifest.releaseVersion -cnotmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' -or
      [string]$Manifest.source.gitCommit -cnotmatch '^[0-9a-f]{40,64}$') {
    throw 'Runtime package release identity is invalid.'
  }
  if ($null -eq $Manifest.database) {
    throw 'Runtime package manifest has no database contract.'
  }
  $ContractRelativePath = [string]$Manifest.database.contractPath
  $ContractPath = Resolve-SteelContainedFile -Root $RuntimeRoot -RelativePath $ContractRelativePath -Label 'Database contract path'
  $ContractHash = Get-SteelFileSha256 -Path $ContractPath
  Assert-SteelLowerSha256 -Value ([string]$Manifest.database.contractSha256) -Label 'Manifest database contract hash'
  if ($ContractHash -cne [string]$Manifest.database.contractSha256) {
    throw 'Runtime database contract hash does not match manifest.json.'
  }
  $Contract = Read-SteelJsonFile -Path $ContractPath -Label 'Database contract'
  if ([string]$Contract.contractSchema -cne 'steel.database-contract.v1' -or
      [long]$Contract.schemaVersion -ne [long]$Manifest.database.schemaVersion) {
    throw 'Runtime database contract schema/version does not match manifest.json.'
  }
  $IndexRelativePath = [string]$Contract.migrationIndex
  $IndexPath = Resolve-SteelContainedFile -Root $RuntimeRoot -RelativePath $IndexRelativePath -Label 'Database migration index path'
  $IndexHash = Get-SteelFileSha256 -Path $IndexPath
  foreach ($ExpectedHash in @([string]$Contract.migrationIndexSha256, [string]$Manifest.database.migrationIndexSha256)) {
    Assert-SteelLowerSha256 -Value $ExpectedHash -Label 'Database migration index hash'
    if ($IndexHash -cne $ExpectedHash) {
      throw 'Runtime database migration index hash is inconsistent.'
    }
  }
  $Index = Read-SteelJsonFile -Path $IndexPath -Label 'Database migration index'
  if ([string]$Index.schema -cne 'steel.database-migration-index.v1' -or
      [long]$Index.targetSchemaVersion -ne [long]$Contract.schemaVersion) {
    throw 'Runtime database migration index does not match the database contract.'
  }

  $ReleaseId = ([string]$Manifest.releaseVersion + '-' + ([string]$Manifest.source.gitCommit).Substring(0, 12))
  $Active = $null
  $ActiveHash = ''
  if (-not [string]::IsNullOrWhiteSpace($ActiveDeploymentPath)) {
    $ActiveDeploymentPath = (Resolve-Path -LiteralPath $ActiveDeploymentPath -ErrorAction Stop).Path
    $Active = Read-SteelJsonFile -Path $ActiveDeploymentPath -Label 'Active deployment receipt'
    if ([string]$Active.schema -cne 'steel.runtime-active-deployment.v1' -or
        [string]$Active.releaseId -cne $ReleaseId -or
        [string]$Active.releaseVersion -cne [string]$Manifest.releaseVersion -or
        [string]$Active.releaseCommit -cne [string]$Manifest.source.gitCommit -or
        -not [System.IO.Path]::GetFullPath([string]$Active.releaseRoot).Equals(
          [System.IO.Path]::GetFullPath($RuntimeRoot),
          [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'Active deployment receipt does not identify the supplied immutable runtime root.'
    }
    if ($null -eq $Active.database -or
        [long]$Active.database.schemaVersion -ne [long]$Contract.schemaVersion -or
        [string]$Active.database.contractSha256 -cne $ContractHash -or
        [string]$Active.database.migrationIndexSha256 -cne $IndexHash -or
        [long]$Active.database.migrationCount -ne @($Index.migrations).Count -or
        [string]$Active.database.phase -cnotin @('not-started', 'migration-complete', 'validated')) {
      throw 'Active deployment database receipt does not match the immutable runtime database contract.'
    }
    $ActiveHash = Get-SteelFileSha256 -Path $ActiveDeploymentPath
  } elseif ($RequireActiveDeployment) {
    throw 'An active deployment receipt is required for a production database operation.'
  }

  return [pscustomobject][ordered]@{
    runtimeRoot = $RuntimeRoot
    manifestPath = $ManifestPath
    manifestSha256 = Get-SteelFileSha256 -Path $ManifestPath
    manifest = $Manifest
    releaseId = $ReleaseId
    releaseVersion = [string]$Manifest.releaseVersion
    releaseCommit = [string]$Manifest.source.gitCommit
    transactionId = if ($null -ne $Active) { [string]$Active.transactionId } else { '' }
    activeDeploymentPath = if ($null -ne $Active) { $ActiveDeploymentPath } else { '' }
    activeDeploymentSha256 = $ActiveHash
    contractPath = $ContractPath
    contractSha256 = $ContractHash
    contract = $Contract
    migrationIndexPath = $IndexPath
    migrationIndexSha256 = $IndexHash
    migrationIndex = $Index
  }
}

function Assert-SteelBackupManifestV2 {
  param([Parameter(Mandatory = $true)]$Manifest)

  if ([string]$Manifest.schema -cne 'steel.database-backup.v2') {
    throw 'Backup manifest schema must be steel.database-backup.v2.'
  }
  $BackupGuid = [Guid]::Empty
  if (-not [Guid]::TryParseExact([string]$Manifest.backupId, 'D', [ref]$BackupGuid)) {
    throw 'Backup manifest backupId must be a canonical UUID.'
  }
  if ([string]$Manifest.engine -cnotin @('sqlite', 'mysql')) {
    throw 'Backup manifest engine must be sqlite or mysql.'
  }
  $CreatedAt = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$Manifest.createdAtUtc, [ref]$CreatedAt) -or
      $CreatedAt.Offset -ne [TimeSpan]::Zero) {
    throw 'Backup manifest createdAtUtc must be a UTC timestamp.'
  }
  if ([string]$Manifest.release.releaseVersion -cnotmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' -or
      [string]$Manifest.release.releaseCommit -cnotmatch '^[0-9a-f]{40,64}$' -or
      [string]$Manifest.release.releaseId -cne ([string]$Manifest.release.releaseVersion + '-' + ([string]$Manifest.release.releaseCommit).Substring(0, 12))) {
    throw 'Backup release identity is invalid.'
  }
  $TransactionGuid = [Guid]::Empty
  if ([string]$Manifest.release.transactionId -cnotmatch '^[0-9a-f]{32}$' -and
      -not [Guid]::TryParseExact([string]$Manifest.release.transactionId, 'D', [ref]$TransactionGuid)) {
    throw 'Backup release transactionId must be the active deployment transaction identifier.'
  }
  foreach ($HashField in @(
    [string]$Manifest.release.packageManifestSha256,
    [string]$Manifest.release.activeDeploymentSha256,
    [string]$Manifest.database.contractSha256,
    [string]$Manifest.database.migrationIndexSha256,
    [string]$Manifest.payload.sha256,
    [string]$Manifest.tool.backupScriptSha256,
    [string]$Manifest.tool.commonScriptSha256
  )) {
    Assert-SteelLowerSha256 -Value $HashField -Label 'Backup manifest hash'
  }
  if ([long]$Manifest.database.schemaVersion -lt 1 -or
      [long]$Manifest.database.stateLayoutVersion -lt 1 -or
      [long]$Manifest.payload.bytes -lt 1 -or
      [string]$Manifest.database.contractSchema -cne 'steel.database-contract.v1') {
    throw 'Backup database/payload metadata is invalid.'
  }
  Assert-SteelCanonicalRelativePath -Path ([string]$Manifest.payload.file) -Label 'Backup payload path'
  if ([string]$Manifest.verification.status -cne 'passed' -or
      [long]$Manifest.verification.schemaVersion -ne [long]$Manifest.database.schemaVersion -or
      [long]$Manifest.verification.unresolvedMigrations -ne 0) {
    throw 'Backup manifest does not contain passing restorability evidence.'
  }
  if ($Manifest.engine -eq 'sqlite') {
    if ([string]$Manifest.payload.consistencyModel -cne 'sqlite-vacuum-into' -or
        [string]$Manifest.verification.integrityCheck -cne 'ok' -or
        [long]$Manifest.verification.foreignKeyViolations -ne 0) {
      throw 'SQLite backup manifest has incomplete snapshot verification evidence.'
    }
  } else {
    if ([string]$Manifest.payload.consistencyModel -cne 'mysql-single-transaction-innodb' -or
        [string]::IsNullOrWhiteSpace([string]$Manifest.database.mysqlDatabase) -or
        [long]$Manifest.verification.nonInnoDbTables -ne 0 -or
        [long]$Manifest.verification.restoredTableCount -lt 1) {
      throw 'MySQL backup manifest has incomplete temporary-restore evidence.'
    }
  }
}
