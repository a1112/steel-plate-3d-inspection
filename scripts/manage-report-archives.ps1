param(
  [ValidateSet('Verify', 'Backup', 'Restore')]
  [string]$Mode = 'Verify',
  [string]$StateRoot = $env:STEEL_RUNTIME_STATE_ROOT,
  [string]$ArchiveRoot = '',
  [string]$OutputRoot = '',
  [string]$BackupDir = '',
  [string]$ExpectedManifestSha256 = '',
  [string]$ServiceOrigin = 'http://127.0.0.1:4873',
  [string]$AdminToken = '',
  [switch]$AllowOfflineBackupWithoutServiceValidation,
  [switch]$AllowRestoreFromOfflineUnvalidatedBackup,
  [string]$ServiceName = 'SteelInspectionRuntime',
  [int]$ServicePort = 4873,
  [string]$Confirm = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-PathWithin {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Child
  )
  $ParentPath = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  $ChildPath = [System.IO.Path]::GetFullPath($Child).TrimEnd('\', '/')
  return $ChildPath.Equals($ParentPath, [System.StringComparison]::OrdinalIgnoreCase) -or
    $ChildPath.StartsWith(
      $ParentPath + [System.IO.Path]::DirectorySeparatorChar,
      [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Get-InventoryStatistics {
  param([Parameter(Mandatory = $true)]$Inventory)
  $Items = @($Inventory)
  $TotalBytes = 0L
  foreach ($Item in $Items) {
    $TotalBytes += [long]$Item.bytes
  }
  return [pscustomobject][ordered]@{
    archiveCount = $Items.Count
    inspectionCount = @($Items | ForEach-Object inspectionId | Sort-Object -Unique).Count
    totalBytes = $TotalBytes
  }
}

function Write-DurableJson {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )
  $Parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $Parent | Out-Null
  $TemporaryPath = Join-Path $Parent ('.write-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $Json = $Value | ConvertTo-Json -Depth 100
  $Bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Json + [Environment]::NewLine)
  $Stream = [System.IO.FileStream]::new(
    $TemporaryPath,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None,
    4096,
    [System.IO.FileOptions]::WriteThrough
  )
  try {
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.Flush($true)
  } finally {
    $Stream.Dispose()
  }
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $TemporaryPath -Force
    throw "Refusing to overwrite existing file: $Path"
  }
  try {
    [System.IO.File]::Move($TemporaryPath, $Path)
  } catch {
    if (Test-Path -LiteralPath $TemporaryPath -PathType Leaf) {
      Remove-Item -LiteralPath $TemporaryPath -Force
    }
    throw
  }
}

function Assert-SafeIdentity {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ($Value -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$') {
    throw "$Label contains unsupported characters or length: $Value"
  }
}

function Get-ArchiveInventory {
  param([Parameter(Mandatory = $true)][string]$Root)

  $Root = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    return @()
  }
  $Items = [System.Collections.Generic.List[object]]::new()
  foreach ($File in @(Get-ChildItem -LiteralPath $Root -Recurse -File | Sort-Object FullName)) {
    $Relative = $File.FullName.Substring($Root.Length).TrimStart('\', '/').Replace('\', '/')
    $Segments = @($Relative -split '/')
    if ($Segments.Count -ne 2 -or $Segments[1] -cnotmatch '^(.+)\.json$') {
      throw "Unexpected report archive entry: $Relative"
    }
    $InspectionId = $Segments[0]
    $ReportId = [System.IO.Path]::GetFileNameWithoutExtension($Segments[1])
    Assert-SafeIdentity -Value $InspectionId -Label 'inspectionId'
    Assert-SafeIdentity -Value $ReportId -Label 'reportId'

    try {
      $Archive = Get-Content -LiteralPath $File.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
      throw "Report archive is not valid JSON: $Relative. $($_.Exception.Message)"
    }
    if ([string]$Archive.schema -cne 'steel.inspection.report-archive.v1' -or
        [string]$Archive.reportId -cne $ReportId -or
        [string]$Archive.inspectionId -cne $InspectionId -or
        $null -eq $Archive.document -or
        [string]$Archive.document.schema -cne 'steel.inspection.report.v1' -or
        [string]$Archive.document.inspectionId -cne $InspectionId -or
        [string]$Archive.document.materialId -cne [string]$Archive.materialId -or
        [string]$Archive.documentSha256 -cnotmatch '^[0-9a-f]{64}$') {
      throw "Report archive identity/schema validation failed: $Relative"
    }
    $ExpectedReportId = "RPT-$InspectionId-$(([string]$Archive.documentSha256).Substring(0, 12))"
    if ($ReportId -cne $ExpectedReportId) {
      throw "Report archive content-addressed identity validation failed: $Relative"
    }
    $Items.Add([pscustomobject][ordered]@{
      path = $Relative
      inspectionId = $InspectionId
      reportId = $ReportId
      bytes = [long]$File.Length
      sha256 = Get-Sha256 -Path $File.FullName
    })
  }
  return @($Items)
}

function Assert-InventoryEqual {
  param(
    [Parameter(Mandatory = $true)]$Expected,
    [Parameter(Mandatory = $true)]$Actual,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $ExpectedJson = @($Expected) | ConvertTo-Json -Depth 10 -Compress
  $ActualJson = @($Actual) | ConvertTo-Json -Depth 10 -Compress
  if ($ExpectedJson -cne $ActualJson) {
    throw "$Label inventory differs from the verified manifest/source snapshot."
  }
}

function Copy-ArchiveTree {
  param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$DestinationRoot,
    [Parameter(Mandatory = $true)]$Inventory
  )
  New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
  foreach ($Item in @($Inventory)) {
    $Source = Join-Path $SourceRoot ([string]$Item.path).Replace('/', '\')
    $Destination = Join-Path $DestinationRoot ([string]$Item.path).Replace('/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination
    if ((Get-Sha256 -Path $Destination) -cne [string]$Item.sha256) {
      throw "Copied report archive hash mismatch: $($Item.path)"
    }
  }
}

function Assert-ServiceStopped {
  $Service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($null -ne $Service -and $Service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
    throw "Windows service $ServiceName must be stopped before report archive restore."
  }
  $Listener = Get-NetTCPConnection -State Listen -LocalPort $ServicePort -ErrorAction SilentlyContinue
  if ($null -ne $Listener) {
    throw "Service port $ServicePort is still listening. Stop the runtime before report archive restore."
  }
}

function Assert-ServiceArchiveValidation {
  param([Parameter(Mandatory = $true)]$Inventory)
  if ($ServiceOrigin -cnotmatch '^http://127\.0\.0\.1:[1-9][0-9]{0,4}$') {
    throw 'ServiceOrigin must be an explicit loopback HTTP origin.'
  }
  if ([string]::IsNullOrWhiteSpace($AdminToken)) {
    throw 'AdminToken is required so the Service can validate every report archive with the authoritative Rust serializer.'
  }
  $Headers = @{ Authorization = "Bearer $AdminToken"; Accept = 'application/json' }
  foreach ($InspectionId in @($Inventory.inspectionId | Sort-Object -Unique)) {
    $EncodedInspectionId = [Uri]::EscapeDataString([string]$InspectionId)
    $Response = Invoke-RestMethod `
      -Uri "$($ServiceOrigin.TrimEnd('/'))/api/admin/records/reports?inspectionId=$EncodedInspectionId" `
      -Headers $Headers `
      -Method Get `
      -TimeoutSec 120 `
      -UseBasicParsing
    if ([int]$Response.code -ne 0) {
      throw "Service report archive validation failed for inspection $InspectionId."
    }
    $LocalIds = @($Inventory | Where-Object inspectionId -CEQ $InspectionId | ForEach-Object reportId | Sort-Object)
    $ServiceIds = @($Response.reports | ForEach-Object reportId | Sort-Object)
    if (($LocalIds | ConvertTo-Json -Compress) -cne ($ServiceIds | ConvertTo-Json -Compress)) {
      throw "Service report history differs from the local archive tree for inspection $InspectionId."
    }
  }
}

if ([string]::IsNullOrWhiteSpace($StateRoot)) {
  $StateRoot = Join-Path $env:ProgramData 'SteelInspectionRuntime'
}
$StateRoot = [System.IO.Path]::GetFullPath($StateRoot).TrimEnd('\', '/')
if ([string]::IsNullOrWhiteSpace($ArchiveRoot)) {
  $ArchiveRoot = Join-Path $StateRoot 'reports\inspection'
}
$ArchiveRoot = [System.IO.Path]::GetFullPath($ArchiveRoot).TrimEnd('\', '/')

$Mutex = [System.Threading.Mutex]::new($false, 'Global\SteelInspectionRuntime-Deployment')
$Acquired = $false
try {
  try { $Acquired = $Mutex.WaitOne([TimeSpan]::FromSeconds(30)) }
  catch [System.Threading.AbandonedMutexException] { $Acquired = $true }
  if (-not $Acquired) {
    throw 'Another SteelInspectionRuntime deployment, backup, restore, or uninstall transaction holds the global deployment mutex.'
  }

  if ($Mode -eq 'Verify') {
    $Inventory = @(Get-ArchiveInventory -Root $ArchiveRoot)
    $ServiceValidated = -not [string]::IsNullOrWhiteSpace($AdminToken)
    if ($ServiceValidated) {
      Assert-ServiceArchiveValidation -Inventory $Inventory
    }
    $Statistics = Get-InventoryStatistics -Inventory $Inventory
    [pscustomobject][ordered]@{
      schema = 'steel.report-archive-verification.v1'
      code = 0
      archiveRoot = $ArchiveRoot
      archiveCount = $Statistics.archiveCount
      inspectionCount = $Statistics.inspectionCount
      totalBytes = $Statistics.totalBytes
      serviceValidated = $ServiceValidated
      verifiedAtUtc = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json -Depth 5
    exit 0
  }

  if ($Mode -eq 'Backup') {
    if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
      $OutputRoot = Join-Path $StateRoot 'backups\report-archives'
    }
    $OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot).TrimEnd('\', '/')
    if ((Test-PathWithin -Parent $ArchiveRoot -Child $OutputRoot) -or
        (Test-PathWithin -Parent $OutputRoot -Child $ArchiveRoot)) {
      throw 'Backup output and report archive roots must not overlap in either direction.'
    }
    New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
    $BackupId = [Guid]::NewGuid().ToString('D')
    $Name = "report-archives-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmss.fffZ'))-$($BackupId.Substring(0, 8))"
    $Stage = Join-Path $OutputRoot ('.incomplete-' + $Name)
    $Final = Join-Path $OutputRoot $Name
    try {
      New-Item -ItemType Directory -Path $Stage | Out-Null
      $SourceInventory = @(Get-ArchiveInventory -Root $ArchiveRoot)
      $ServiceValidated = -not $AllowOfflineBackupWithoutServiceValidation
      if ($ServiceValidated) {
        Assert-ServiceArchiveValidation -Inventory $SourceInventory
      }
      $PayloadRoot = Join-Path $Stage 'reports'
      Copy-ArchiveTree -SourceRoot $ArchiveRoot -DestinationRoot $PayloadRoot -Inventory $SourceInventory
      $CopiedInventory = @(Get-ArchiveInventory -Root $PayloadRoot)
      Assert-InventoryEqual -Expected $SourceInventory -Actual $CopiedInventory -Label 'Copied report archive'
      $SourceAfterCopy = @(Get-ArchiveInventory -Root $ArchiveRoot)
      Assert-InventoryEqual -Expected $SourceInventory -Actual $SourceAfterCopy -Label 'Source report archive'
      $Statistics = Get-InventoryStatistics -Inventory $SourceInventory
      $Manifest = [ordered]@{
        schema = 'steel.report-archive-backup.v1'
        backupId = $BackupId
        createdAtUtc = [DateTime]::UtcNow.ToString('o')
        sourceArchiveRoot = $ArchiveRoot
        payloadRoot = 'reports'
        archiveCount = $Statistics.archiveCount
        inspectionCount = $Statistics.inspectionCount
        totalBytes = $Statistics.totalBytes
        serviceValidated = $ServiceValidated
        files = $SourceInventory
      }
      Write-DurableJson -Path (Join-Path $Stage 'manifest.json') -Value $Manifest
      [System.IO.Directory]::Move($Stage, $Final)
    } catch {
      if (Test-Path -LiteralPath $Stage -PathType Container) {
        Remove-Item -LiteralPath $Stage -Recurse -Force
      }
      throw
    }
    $ManifestPath = Join-Path $Final 'manifest.json'
    [pscustomobject][ordered]@{
      schema = 'steel.report-archive-backup-result.v1'
      code = 0
      backupId = $BackupId
      backupDirectory = $Final
      manifestPath = $ManifestPath
      manifestSha256 = Get-Sha256 -Path $ManifestPath
      archiveCount = $Statistics.archiveCount
      serviceValidated = $ServiceValidated
    } | ConvertTo-Json -Depth 5
    exit 0
  }

  if ([string]::IsNullOrWhiteSpace($BackupDir) -or -not (Test-Path -LiteralPath $BackupDir -PathType Container)) {
    throw 'Restore requires an existing -BackupDir.'
  }
  if ($ExpectedManifestSha256 -cnotmatch '^[0-9a-f]{64}$') {
    throw 'Restore requires a lowercase, independently retained -ExpectedManifestSha256.'
  }
  $BackupDir = [System.IO.Path]::GetFullPath($BackupDir).TrimEnd('\', '/')
  $ManifestPath = Join-Path $BackupDir 'manifest.json'
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw 'Report archive backup manifest is missing.'
  }
  if ((Get-Sha256 -Path $ManifestPath) -cne $ExpectedManifestSha256) {
    throw 'Report archive backup manifest differs from the independently retained SHA-256.'
  }
  $Manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $BackupGuid = [Guid]::Empty
  $CreatedAt = [DateTimeOffset]::MinValue
  if ([string]$Manifest.schema -cne 'steel.report-archive-backup.v1' -or
      -not [Guid]::TryParseExact([string]$Manifest.backupId, 'D', [ref]$BackupGuid) -or
      -not [DateTimeOffset]::TryParse([string]$Manifest.createdAtUtc, [ref]$CreatedAt) -or
      $CreatedAt.Offset -ne [TimeSpan]::Zero -or
      [string]$Manifest.payloadRoot -cne 'reports' -or
      $null -eq $Manifest.files) {
    throw 'Report archive backup manifest is invalid.'
  }
  if ($Manifest.serviceValidated -ne $true -and -not $AllowRestoreFromOfflineUnvalidatedBackup) {
    throw 'Report archive backup was not validated by the authoritative Service; production restore is refused.'
  }
  $PayloadRoot = Join-Path $BackupDir 'reports'
  $PayloadInventory = @(Get-ArchiveInventory -Root $PayloadRoot)
  Assert-InventoryEqual -Expected @($Manifest.files) -Actual $PayloadInventory -Label 'Backup payload'
  $PayloadStatistics = Get-InventoryStatistics -Inventory $PayloadInventory
  if ([long]$Manifest.archiveCount -ne $PayloadStatistics.archiveCount -or
      [long]$Manifest.inspectionCount -ne $PayloadStatistics.inspectionCount -or
      [long]$Manifest.totalBytes -ne $PayloadStatistics.totalBytes) {
    throw 'Report archive backup statistics differ from its payload.'
  }
  $ExpectedConfirm = "RESTORE REPORTS $($Manifest.backupId)"
  if ($Confirm -cne $ExpectedConfirm) {
    throw "Explicit confirmation required: -Confirm '$ExpectedConfirm'"
  }
  Assert-ServiceStopped

  if (-not (Test-PathWithin -Parent $StateRoot -Child $ArchiveRoot)) {
    throw 'Report archive restore root must remain within StateRoot so staging and rollback use one managed volume.'
  }
  if ([System.IO.Path]::GetPathRoot($StateRoot) -cne [System.IO.Path]::GetPathRoot($ArchiveRoot)) {
    throw 'Report archive restore root and StateRoot must be on the same volume.'
  }
  $Parent = Split-Path -Parent $ArchiveRoot
  New-Item -ItemType Directory -Force -Path $Parent | Out-Null
  $RestoreId = [Guid]::NewGuid().ToString('D')
  $Stage = Join-Path $Parent ('.report-restore-stage-' + $RestoreId)
  $RollbackRoot = Join-Path $StateRoot ("deployment\restore-backups\reports-$RestoreId")
  $PriorRoot = Join-Path $RollbackRoot 'inspection'
  $ReceiptPath = Join-Path $StateRoot ("deployment\restore-history\report-archives-$RestoreId.json")
  try {
    Copy-ArchiveTree -SourceRoot $PayloadRoot -DestinationRoot $Stage -Inventory $PayloadInventory
    Assert-InventoryEqual -Expected $PayloadInventory -Actual @(Get-ArchiveInventory -Root $Stage) -Label 'Staged restore'
    New-Item -ItemType Directory -Force -Path $RollbackRoot | Out-Null
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReceiptPath) | Out-Null
  } catch {
    if (Test-Path -LiteralPath $Stage -PathType Container) {
      Remove-Item -LiteralPath $Stage -Recurse -Force
    }
    throw
  }
  $HadPrior = Test-Path -LiteralPath $ArchiveRoot -PathType Container
  $PriorMoved = $false
  try {
    if ($HadPrior) {
      [System.IO.Directory]::Move($ArchiveRoot, $PriorRoot)
      $PriorMoved = $true
    }
    [System.IO.Directory]::Move($Stage, $ArchiveRoot)
    Assert-InventoryEqual -Expected $PayloadInventory -Actual @(Get-ArchiveInventory -Root $ArchiveRoot) -Label 'Restored report archive'
    Write-DurableJson -Path $ReceiptPath -Value ([ordered]@{
      schema = 'steel.report-archive-restore-receipt.v1'
      restoreId = $RestoreId
      backupId = [string]$Manifest.backupId
      manifestSha256 = $ExpectedManifestSha256
      archiveRoot = $ArchiveRoot
      archiveCount = $PayloadStatistics.archiveCount
      priorArchiveRetained = $HadPrior
      priorArchivePath = if ($HadPrior) { $PriorRoot } else { '' }
      completedAtUtc = [DateTime]::UtcNow.ToString('o')
    })
  } catch {
    $Failure = $_
    if (Test-Path -LiteralPath $ArchiveRoot -PathType Container) {
      $FailedRoot = Join-Path $RollbackRoot 'failed-restored-inspection'
      [System.IO.Directory]::Move($ArchiveRoot, $FailedRoot)
    }
    if ($PriorMoved -and (Test-Path -LiteralPath $PriorRoot -PathType Container)) {
      [System.IO.Directory]::Move($PriorRoot, $ArchiveRoot)
    }
    throw "Report archive restore failed and the prior archive was restored when available: $($Failure.Exception.Message)"
  }
  [pscustomobject][ordered]@{
    schema = 'steel.report-archive-restore-result.v1'
    code = 0
    restoreId = $RestoreId
    backupId = [string]$Manifest.backupId
    archiveCount = $PayloadStatistics.archiveCount
    receiptPath = $ReceiptPath
    serviceState = 'stopped'
  } | ConvertTo-Json -Depth 5
} finally {
  if ($Acquired) { try { $Mutex.ReleaseMutex() } catch { } }
  $Mutex.Dispose()
}
