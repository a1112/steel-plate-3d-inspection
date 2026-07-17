param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$Script = Join-Path $PSScriptRoot 'manage-report-archives.ps1'
$TestRoot = Join-Path $env:TEMP ('steel-report-archive-test-' + [Guid]::NewGuid().ToString('N'))

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Get-TextSha256 {
  param([string]$Text)
  $Algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $Bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Text)
    return ([BitConverter]::ToString($Algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $Algorithm.Dispose()
  }
}

function Invoke-Tool {
  param([string[]]$Arguments)
  $PreviousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $Output = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $Script @Arguments 2>&1)
    $ExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $PreviousPreference
  }
  return [pscustomobject]@{ exitCode = $ExitCode; text = ($Output | Out-String).Trim() }
}

New-Item -ItemType Directory -Path $TestRoot | Out-Null
try {
  $EmptyState = Join-Path $TestRoot 'empty-state'
  $EmptyVerify = Invoke-Tool -Arguments @('-Mode','Verify','-StateRoot',$EmptyState)
  Assert-True ($EmptyVerify.exitCode -eq 0) "Empty archive verification failed: $($EmptyVerify.text)"
  $EmptyVerifyResult = $EmptyVerify.text | ConvertFrom-Json
  Assert-True (
    [int]$EmptyVerifyResult.archiveCount -eq 0 -and
    [int]$EmptyVerifyResult.inspectionCount -eq 0 -and
    [long]$EmptyVerifyResult.totalBytes -eq 0
  ) 'Empty archive verification statistics are invalid.'

  $SourceState = Join-Path $TestRoot 'source-state'
  $SourceArchiveRoot = Join-Path $SourceState 'reports\inspection'
  $InspectionId = 'INSP-TEST-001'
  $InspectionRoot = Join-Path $SourceArchiveRoot $InspectionId
  New-Item -ItemType Directory -Force -Path $InspectionRoot | Out-Null
  $Document = [ordered]@{
    schema = 'steel.inspection.report.v1'
    inspectionId = $InspectionId
    materialId = 'MAT-001'
    result = 'qualified'
    defects = @()
  }
  $DocumentHash = Get-TextSha256 -Text ($Document | ConvertTo-Json -Depth 100 -Compress)
  $ReportId = "RPT-$InspectionId-$($DocumentHash.Substring(0, 12))"
  $Archive = [ordered]@{
    schema = 'steel.inspection.report-archive.v1'
    reportId = $ReportId
    inspectionId = $InspectionId
    materialId = 'MAT-001'
    issuedAt = [DateTime]::UtcNow.ToString('o')
    issuedBy = 'test'
    documentSha256 = $DocumentHash
    document = $Document
  }
  $Archive | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $InspectionRoot "$ReportId.json") -Encoding UTF8

  $Verify = Invoke-Tool -Arguments @('-Mode','Verify','-StateRoot',$SourceState)
  Assert-True ($Verify.exitCode -eq 0) "Verify failed: $($Verify.text)"
  $VerifyResult = $Verify.text | ConvertFrom-Json
  Assert-True ([int]$VerifyResult.archiveCount -eq 1) 'Verify did not count the fixture archive.'

  $BackupOutput = Join-Path $TestRoot 'backups'
  $Backup = Invoke-Tool -Arguments @('-Mode','Backup','-StateRoot',$SourceState,'-OutputRoot',$BackupOutput,'-AllowOfflineBackupWithoutServiceValidation')
  Assert-True ($Backup.exitCode -eq 0) "Backup failed: $($Backup.text)"
  $BackupResult = $Backup.text | ConvertFrom-Json
  Assert-True ([int]$BackupResult.archiveCount -eq 1) 'Backup did not contain the fixture archive.'
  Assert-True ($BackupResult.serviceValidated -eq $false) 'Offline test backup unexpectedly claims Service validation.'

  $OverlapBackup = Invoke-Tool -Arguments @(
    '-Mode','Backup',
    '-StateRoot',$SourceState,
    '-OutputRoot',$SourceArchiveRoot,
    '-AllowOfflineBackupWithoutServiceValidation'
  )
  Assert-True (
    $OverlapBackup.exitCode -ne 0 -and $OverlapBackup.text -match 'must not overlap'
  ) 'Overlapping archive and backup roots were not rejected.'

  $TargetState = Join-Path $TestRoot 'target-state'
  $TargetArchiveRoot = Join-Path $TargetState 'reports\inspection'
  New-Item -ItemType Directory -Force -Path $TargetArchiveRoot | Out-Null
  Set-Content -LiteralPath (Join-Path $TargetArchiveRoot 'prior-marker.txt') -Value 'prior archive tree'
  $UnvalidatedRestore = Invoke-Tool -Arguments @(
    '-Mode','Restore',
    '-StateRoot',$TargetState,
    '-BackupDir',[string]$BackupResult.backupDirectory,
    '-ExpectedManifestSha256',[string]$BackupResult.manifestSha256,
    '-ServiceName',('SteelInspectionRuntime-Test-' + [Guid]::NewGuid().ToString('N')),
    '-ServicePort','61973',
    '-Confirm',("RESTORE REPORTS " + [string]$BackupResult.backupId)
  )
  Assert-True (
    $UnvalidatedRestore.exitCode -ne 0 -and $UnvalidatedRestore.text -match 'not validated by the authoritative Service'
  ) 'Production restore accepted an offline-unvalidated report archive backup.'

  $Restore = Invoke-Tool -Arguments @(
    '-Mode','Restore',
    '-StateRoot',$TargetState,
    '-BackupDir',[string]$BackupResult.backupDirectory,
    '-ExpectedManifestSha256',[string]$BackupResult.manifestSha256,
    '-AllowRestoreFromOfflineUnvalidatedBackup',
    '-ServiceName',('SteelInspectionRuntime-Test-' + [Guid]::NewGuid().ToString('N')),
    '-ServicePort','61974',
    '-Confirm',("RESTORE REPORTS " + [string]$BackupResult.backupId)
  )
  Assert-True ($Restore.exitCode -eq 0) "Restore failed: $($Restore.text)"
  $RestoreResult = $Restore.text | ConvertFrom-Json
  Assert-True (Test-Path -LiteralPath (Join-Path $TargetArchiveRoot "$InspectionId\$ReportId.json") -PathType Leaf) 'Restored archive is missing.'
  $Receipt = Get-Content -LiteralPath ([string]$RestoreResult.receiptPath) -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-True ($Receipt.priorArchiveRetained -eq $true) 'Restore receipt did not retain the prior archive tree.'
  Assert-True (Test-Path -LiteralPath (Join-Path ([string]$Receipt.priorArchivePath) 'prior-marker.txt') -PathType Leaf) 'Prior archive tree was not retained for rollback.'

  $TamperedDir = Join-Path $TestRoot 'tampered'
  Copy-Item -LiteralPath ([string]$BackupResult.backupDirectory) -Destination $TamperedDir -Recurse
  Add-Content -LiteralPath (Join-Path $TamperedDir "reports\$InspectionId\$ReportId.json") -Value 'tamper'
  $Tampered = Invoke-Tool -Arguments @(
    '-Mode','Restore',
    '-StateRoot',(Join-Path $TestRoot 'tampered-target'),
    '-BackupDir',$TamperedDir,
    '-ExpectedManifestSha256',[string]$BackupResult.manifestSha256,
    '-AllowRestoreFromOfflineUnvalidatedBackup',
    '-ServiceName',('SteelInspectionRuntime-Test-' + [Guid]::NewGuid().ToString('N')),
    '-ServicePort','61975',
    '-Confirm',("RESTORE REPORTS " + [string]$BackupResult.backupId)
  )
  Assert-True ($Tampered.exitCode -ne 0) 'Tampered report archive backup was not rejected.'

  [pscustomobject][ordered]@{
    schema = 'steel.report-archive-recovery-test.v1'
    code = 0
    checks = [ordered]@{
      emptyArchiveValidation = $true
      archiveValidation = $true
      immutableBackup = $true
      overlappingRootRejection = $true
      offlineUnvalidatedRestoreRejection = $true
      offlineRestore = $true
      priorArchiveRetention = $true
      payloadTamperRejection = $true
    }
  } | ConvertTo-Json -Depth 5
} finally {
  if (Test-Path -LiteralPath $TestRoot -PathType Container) {
    Remove-Item -LiteralPath $TestRoot -Recurse -Force
  }
}
