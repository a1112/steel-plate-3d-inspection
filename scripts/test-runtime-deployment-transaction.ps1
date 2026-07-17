param()

$ErrorActionPreference = 'Stop'
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptRoot
$InstallerPath = Join-Path $ScriptRoot 'install-runtime-service.ps1'
$InstallerText = Get-Content -LiteralPath $InstallerPath -Raw -Encoding utf8
$Tokens = $null
$ParseErrors = $null
$InstallerAst = [System.Management.Automation.Language.Parser]::ParseFile(
  $InstallerPath,
  [ref]$Tokens,
  [ref]$ParseErrors
)
if ($ParseErrors.Count -gt 0) {
  throw "Installer has PowerShell parse errors: $($ParseErrors.Message -join '; ')"
}

$FunctionNames = @(
  'Get-RuntimeReleaseId',
  'Resolve-DeploymentChildPath',
  'Assert-PathWithinRoot',
  'Assert-SameVolumePaths',
  'Assert-ReleaseDestinationAvailable',
  'Get-RuntimeServiceBinaryPath',
  'Read-DeploymentJournal',
  'Get-DeploymentRecoveryDecision',
  'Write-DurableBytesAtomically',
  'Write-DurableJsonAtomically',
  'Set-DeploymentJournalPhase'
)
foreach ($FunctionName in $FunctionNames) {
  $Definition = @($InstallerAst.FindAll({
    param($Node)
    $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
      $Node.Name -ceq $FunctionName
  }, $true))
  if ($Definition.Count -ne 1) {
    throw "Expected one installer function named $FunctionName, found $($Definition.Count)."
  }
  Invoke-Expression $Definition[0].Extent.Text
}

$Checks = [System.Collections.Generic.List[object]]::new()
$Failures = [System.Collections.Generic.List[string]]::new()

function Add-Check {
  param(
    [string]$Name,
    [scriptblock]$Body
  )
  try {
    & $Body
    $Checks.Add([pscustomobject]@{ name = $Name; passed = $true })
  } catch {
    $Checks.Add([pscustomobject]@{ name = $Name; passed = $false; error = $_.Exception.Message })
    $Failures.Add("$Name`: $($_.Exception.Message)")
  }
}

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )
  if (-not $Condition) { throw $Message }
}

function Assert-Throws {
  param(
    [scriptblock]$Body,
    [string]$MessagePattern
  )
  try {
    & $Body
  } catch {
    if ([string]$_.Exception.Message -notmatch $MessagePattern) {
      throw "Unexpected error message '$($_.Exception.Message)'; expected /$MessagePattern/."
    }
    return
  }
  throw "Expected an exception matching /$MessagePattern/."
}

function New-ValidJournal {
  return [pscustomobject][ordered]@{
    schema = 'steel.runtime-deployment-transaction.v1'
    transactionId = ('a' * 32)
    serviceName = 'SteelInspectionRuntime'
    phase = 'prepared'
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    updatedAtUtc = [DateTime]::UtcNow.ToString('o')
    database = [pscustomobject]@{
      phase = 'not-started'
      migrationId = $null
      schemaVersionBefore = $null
      schemaVersionAfter = $null
      backupPath = $null
    }
    rollback = [pscustomobject]@{
      service = [pscustomobject]@{
        existed = $false
        wasRunning = $false
        scm = $null
        registry = $null
      }
      runtimeEnvironment = [pscustomobject]@{ existed = $false; backupPath = $null }
      activeDeployment = [pscustomobject]@{ existed = $false; backupPath = $null }
    }
    events = @()
  }
}

$TestRoot = Join-Path $RepoRoot ("target\runtime-deployment-transaction-test-" + [Guid]::NewGuid().ToString('N'))
$ResolvedRepoRoot = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd('\', '/')
$ResolvedTestRoot = [System.IO.Path]::GetFullPath($TestRoot)
if (-not $ResolvedTestRoot.StartsWith($ResolvedRepoRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Test root escaped the repository: $ResolvedTestRoot"
}
New-Item -ItemType Directory -Path $TestRoot | Out-Null

try {
  Add-Check 'version-id-is-semver-plus-commit12' {
    $Commit = '0123456789abcdef0123456789abcdef01234567'
    $ReleaseId = Get-RuntimeReleaseId -ReleaseVersion '2.7.19' -ReleaseCommit $Commit
    Assert-True ($ReleaseId -ceq '2.7.19-0123456789ab') 'Release ID was not deterministic.'
    Assert-Throws { Get-RuntimeReleaseId -ReleaseVersion '2.7.19-rc.1' -ReleaseCommit $Commit } 'semantic version'
    Assert-Throws { Get-RuntimeReleaseId -ReleaseVersion '2.7.19' -ReleaseCommit 'deadbeef' } '40 to 64'
  }

  Add-Check 'deployment-path-boundaries' {
    $Releases = Join-Path $TestRoot 'install\releases'
    New-Item -ItemType Directory -Path $Releases -Force | Out-Null
    $Child = Resolve-DeploymentChildPath -Root $Releases -ChildName '2.7.19-0123456789ab'
    $Expected = Join-Path $Releases '2.7.19-0123456789ab'
    Assert-True ([System.IO.Path]::GetFullPath($Child) -ceq [System.IO.Path]::GetFullPath($Expected)) 'Safe child path was changed.'
    [void](Assert-PathWithinRoot -Root $Releases -Candidate (Join-Path $Child 'manifest.json'))
    Assert-SameVolumePaths -Left $Child -Right (Join-Path $Releases '.incoming-a')
    Assert-Throws { Resolve-DeploymentChildPath -Root $Releases -ChildName '..\escape' } 'unsafe|escapes'
    Assert-Throws { Assert-PathWithinRoot -Root $Releases -Candidate (Join-Path $TestRoot 'escape.json') } 'outside'
  }

  Add-Check 'existing-release-is-never-overwritten' {
    $ExistingRelease = Join-Path $TestRoot 'install\releases\2.7.19-0123456789ab'
    New-Item -ItemType Directory -Path $ExistingRelease -Force | Out-Null
    $Sentinel = Join-Path $ExistingRelease 'tampered-sentinel.txt'
    [System.IO.File]::WriteAllText($Sentinel, 'do-not-touch')
    Assert-Throws { Assert-ReleaseDestinationAvailable -Path $ExistingRelease } 'will not be overwritten or modified'
    Assert-True (([System.IO.File]::ReadAllText($Sentinel)) -ceq 'do-not-touch') 'Existing release contents were modified.'
  }

  Add-Check 'durable-journal-phase-and-readback' {
    $JournalPath = Join-Path $TestRoot 'upgrade.json'
    $Journal = New-ValidJournal
    Write-DurableJsonAtomically -Path $JournalPath -Value $Journal
    Set-DeploymentJournalPhase -Journal $Journal -Phase 'payload-published' -Path $JournalPath -Detail 'test'
    $ReadBack = Read-DeploymentJournal -Path $JournalPath
    Assert-True ([string]$ReadBack.phase -ceq 'payload-published') 'Journal phase was not persisted.'
    Assert-True (@($ReadBack.events).Count -eq 1) 'Journal phase event was not persisted.'
    Assert-True ((Get-DeploymentRecoveryDecision -Journal $ReadBack) -ceq 'recover-pre-migration') 'Valid pre-migration journal was not recoverable.'
  }

  Add-Check 'truncated-journal-is-failed-safe' {
    $TruncatedPath = Join-Path $TestRoot 'truncated-upgrade.json'
    [System.IO.File]::WriteAllText($TruncatedPath, '{"schema":"steel.runtime-deployment-transaction.v1"')
    Assert-Throws { Read-DeploymentJournal -Path $TruncatedPath } 'unreadable or truncated'
  }

  Add-Check 'recovery-decision-enforces-database-boundary' {
    $Incomplete = New-ValidJournal
    Assert-True ((Get-DeploymentRecoveryDecision -Journal $Incomplete) -ceq 'recover-pre-migration') 'Prepared transaction should recover.'

    $Committed = New-ValidJournal
    $Committed.phase = 'committed'
    Assert-True ((Get-DeploymentRecoveryDecision -Journal $Committed) -ceq 'none') 'Committed transaction should not recover.'

    $Migrated = New-ValidJournal
    $Migrated.database.phase = 'applying'
    Assert-True ((Get-DeploymentRecoveryDecision -Journal $Migrated) -ceq 'failed-safe') 'Non-pre-migration transaction must be failed-safe.'

    $UnknownPhase = New-ValidJournal
    $UnknownPhase.phase = 'mystery'
    Assert-True ((Get-DeploymentRecoveryDecision -Journal $UnknownPhase) -ceq 'failed-safe') 'Unknown journal phase must be failed-safe.'

    $Unproven = New-ValidJournal
    $Unproven.rollback.runtimeEnvironment.existed = $true
    $Unproven.rollback.runtimeEnvironment.backupPath = $null
    Assert-True ((Get-DeploymentRecoveryDecision -Journal $Unproven) -ceq 'failed-safe') 'Missing rollback backup must be failed-safe.'

    $ExistingService = New-ValidJournal
    $ExistingService.phase = 'scm-switched'
    $ExistingService.rollback.service.existed = $true
    $ExistingService.rollback.service.wasRunning = $true
    $ExistingService.rollback.service.scm = [pscustomobject]@{
      pathName = '"C:\old\steel-runtime-supervisor.exe" --service'
      startMode = 'Auto'
      startName = 'LocalSystem'
      displayName = 'Steel Inspection Runtime'
      description = 'old'
    }
    $ExistingService.rollback.service.registry = [pscustomobject]@{}
    Assert-True ((Get-DeploymentRecoveryDecision -Journal $ExistingService) -ceq 'recover-pre-migration') 'Complete prior SCM snapshot should recover.'
    $ExistingService.rollback.service.scm.pathName = ''
    Assert-True ((Get-DeploymentRecoveryDecision -Journal $ExistingService) -ceq 'failed-safe') 'Incomplete prior SCM snapshot must be failed-safe.'
  }

  Add-Check 'scm-binary-path-uses-version-directory' {
    $ReleaseRoot = Join-Path $TestRoot 'install\releases\2.7.19-0123456789ab'
    $StateRoot = Join-Path $TestRoot 'state'
    $BinaryPath = Get-RuntimeServiceBinaryPath -ReleaseRoot $ReleaseRoot -StateRoot $StateRoot
    Assert-True ($BinaryPath.IndexOf([System.IO.Path]::GetFullPath($ReleaseRoot), [System.StringComparison]::OrdinalIgnoreCase) -ge 0) 'BinaryPath does not contain the version directory.'
    Assert-True ($BinaryPath.IndexOf('--root', [System.StringComparison]::Ordinal) -ge 0) 'BinaryPath does not pass the version directory as --root.'
    Assert-True ($BinaryPath.IndexOf('.incoming-', [System.StringComparison]::OrdinalIgnoreCase) -lt 0) 'BinaryPath points at a staging directory.'
  }

  Add-Check 'installer-static-transaction-contract' {
    foreach ($RequiredToken in @(
      '[string]$InstallRoot = ""',
      '[Environment+SpecialFolder]::ProgramFiles',
      '$ReleasesRoot = Join-Path $InstallRoot ''releases''',
      "'Global\SteelInspectionRuntime-Deployment'",
      "'steel.runtime-deployment-transaction.v1'",
      "'steel.runtime-active-deployment.v1'",
      "phase = 'not-started'",
      'not a cross-resource atomic transaction',
      '[System.IO.FileOptions]::WriteThrough',
      '$Stream.Flush($true)',
      '[System.IO.File]::Replace($TemporaryPath, $Path, $ReplacementBackupPath, $true)',
      '[System.IO.Directory]::Move($IncomingReleaseRoot, $FinalReleaseRoot)',
      '$BinaryPath = Get-RuntimeServiceBinaryPath -ReleaseRoot $RuntimeRoot -StateRoot $StateRoot',
      'Assert-ReleaseDestinationAvailable -Path $FinalReleaseRoot',
      'Invoke-PreMigrationDeploymentRecovery',
      '$DeploymentHistoryDir',
      '$DeploymentBackupsDir',
      '$DatabaseContractValidator = Join-Path $SourcePackageRoot "verify-database-migration-contract.ps1"',
      "'steel.database-contract-verification.v1'",
      "mode -cne 'package'",
      'packages with a non-empty migration index are rejected',
      '$PreviousActiveDeployment.database.schemaVersion -ne [long]$DatabaseContractReport.schemaVersion',
      '$ValidatedPriorActiveBytes = [System.IO.File]::ReadAllBytes($ActiveDeploymentPath)',
      'targetSchemaVersion = [long]$DatabaseContractReport.schemaVersion',
      'SteelDatabaseMigrationIndexSha256'
    )) {
      if ($InstallerText.IndexOf($RequiredToken, [System.StringComparison]::Ordinal) -lt 0) {
        throw "Installer transaction contract is missing: $RequiredToken"
      }
    }
    $IntegrityAssertionLines = @($InstallerText -split "`r?`n" | Where-Object { $_ -match '^\s*Assert-ReleasePackageIntegrity\b' })
    foreach ($RootExpression in @('$SourcePackageRoot', '$IncomingReleaseRoot', '$FinalReleaseRoot')) {
      if (@($IntegrityAssertionLines | Where-Object { $_.IndexOf("-Root $RootExpression", [System.StringComparison]::Ordinal) -ge 0 }).Count -eq 0) {
        throw "Complete package integrity is not asserted for $RootExpression."
      }
    }
    $SourceIntegrityGate = $InstallerText.IndexOf(
      'Assert-ReleasePackageIntegrity -Manifest $PackageManifest -Root $SourcePackageRoot',
      [System.StringComparison]::Ordinal
    )
    $DatabaseValidatorInvocation = $InstallerText.IndexOf(
      '$DatabaseContractReportText = (& $DatabaseContractValidator',
      [System.StringComparison]::Ordinal
    )
    Assert-True ($SourceIntegrityGate -ge 0 -and $DatabaseValidatorInvocation -gt $SourceIntegrityGate) 'Package database validator must execute only after the source package catalog/signature gate.'
  }
} finally {
  $ResolvedCleanupRoot = [System.IO.Path]::GetFullPath($TestRoot)
  if (-not $ResolvedCleanupRoot.StartsWith($ResolvedRepoRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a test path outside the repository: $ResolvedCleanupRoot"
  }
  if (Test-Path -LiteralPath $ResolvedCleanupRoot) {
    Remove-Item -LiteralPath $ResolvedCleanupRoot -Recurse -Force
  }
}

$Result = [ordered]@{
  schema = 'steel.runtime-deployment-transaction-test.v1'
  code = if ($Failures.Count -eq 0) { 0 } else { 1 }
  checks = $Checks
  failures = $Failures
}
$Result | ConvertTo-Json -Depth 8
if ($Failures.Count -gt 0) { exit 1 }
