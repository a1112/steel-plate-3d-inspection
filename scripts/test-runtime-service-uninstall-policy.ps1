[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ScriptPath = Join-Path $PSScriptRoot 'uninstall-runtime-service.ps1'
$Tokens = $null
$ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $ScriptPath,
  [ref]$Tokens,
  [ref]$ParseErrors
)
if ($ParseErrors.Count -gt 0) {
  throw "Uninstall script has PowerShell parse errors: $($ParseErrors.Message -join '; ')"
}

# Import function definitions without running the administrator-only uninstall
# body. These tests never access SCM, HKLM, Program Files, or ProgramData.
foreach ($FunctionAst in @($Ast.FindAll({
  param($Node)
  $Node -is [System.Management.Automation.Language.FunctionDefinitionAst]
}, $true))) {
  . ([scriptblock]::Create($FunctionAst.Extent.Text))
}

function Invoke-ExpectThrow {
  param([scriptblock]$Action, [string]$ExpectedText)
  try {
    & $Action
  } catch {
    if ([string]::IsNullOrWhiteSpace($ExpectedText) -or $_.Exception.Message.Contains($ExpectedText)) {
      return $true
    }
    throw "Expected error containing '$ExpectedText', got: $($_.Exception.Message)"
  }
  throw "Expected an error containing '$ExpectedText'."
}

function Write-FixtureJson {
  param([string]$Path, [object]$Value)
  $Parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $Parent -PathType Container)) {
    New-Item -ItemType Directory -Path $Parent | Out-Null
  }
  [System.IO.File]::WriteAllText(
    $Path,
    ($Value | ConvertTo-Json -Depth 20),
    [System.Text.UTF8Encoding]::new($false)
  )
}

$Checks = [ordered]@{
  ast = $ParseErrors.Count -eq 0
  staticPolicy = $false
  ordering = $false
  directReleaseBoundary = $false
  protectedRootGuard = $false
  overlapGuard = $false
  terminalJournal = $false
  journalPathBinding = $false
  nonTerminalJournal = $false
  corruptJournal = $false
  activeIdentity = $false
  serviceImageContract = $false
  purgeConfirmation = $false
  defaultPayloadScope = $false
}

$Text = [System.IO.File]::ReadAllText($ScriptPath)
$RequiredLiterals = @(
  'Global\SteelInspectionRuntime-Deployment',
  "@('committed', 'rolled-back')",
  'Deployment upgrade journal is non-terminal',
  'Assert-NoReparseAncestors',
  'Assert-NoReparseTree',
  'Assert-ManagedRootIsNotProtected',
  'Assert-CurrentReleasePath',
  'Wait-ServiceAbsent',
  'Wait-ServiceRegistrationAbsent',
  'Wait-RuntimePortsReleased',
  'Assert-ServiceAndRegistrationAbsent',
  'Purge requires explicit -InstallRoot and -StateRoot',
  'explicit paths alone are insufficient',
  'not a cross-resource atomic transaction',
  'config\runtime-service.env',
  'Preserved active/previous/in-flight deployment records',
  'Preserved every non-current release'
)
foreach ($Literal in $RequiredLiterals) {
  if (-not $Text.Contains($Literal)) {
    throw "Uninstall policy is missing required literal: $Literal"
  }
}
$Checks.staticPolicy = $true

$PreflightJournalOffset = $Text.IndexOf(
  '$DeploymentJournal = Assert-DeploymentJournalTerminal -StateRoot $StateRoot -InstallRoot $InstallRoot',
  [System.StringComparison]::Ordinal
)
$StopOffset = $Text.IndexOf('Stop-Service -Name $ServiceName -Force', $PreflightJournalOffset, [System.StringComparison]::Ordinal)
$ScmDeleteOffset = $Text.IndexOf('& sc.exe delete $ServiceName', $StopOffset, [System.StringComparison]::Ordinal)
$RegistryWaitOffset = $Text.IndexOf('Wait-ServiceRegistrationAbsent -RegistryPath $RegistryPath', $ScmDeleteOffset, [System.StringComparison]::Ordinal)
$AbsentGateOffset = $Text.IndexOf('Assert-ServiceAndRegistrationAbsent -ServiceName $ServiceName', $RegistryWaitOffset, [System.StringComparison]::Ordinal)
$DefaultDeleteOffset = $Text.IndexOf('Remove-CurrentReleasePayload -InstallRoot $InstallRoot', $AbsentGateOffset, [System.StringComparison]::Ordinal)
$PurgeDeleteOffset = $Text.IndexOf('Remove-Item -LiteralPath $InstallRoot -Recurse -Force', $AbsentGateOffset, [System.StringComparison]::Ordinal)
if ($PreflightJournalOffset -lt 0 -or $StopOffset -le $PreflightJournalOffset -or
    $ScmDeleteOffset -le $StopOffset -or $RegistryWaitOffset -le $ScmDeleteOffset -or
    $AbsentGateOffset -le $RegistryWaitOffset -or $DefaultDeleteOffset -le $AbsentGateOffset -or
    $PurgeDeleteOffset -le $AbsentGateOffset) {
  throw 'Journal, service-stop, SCM/registry deletion, absence gate, and filesystem deletion ordering is unsafe.'
}
$Checks.ordering = $true

$SystemTemp = [System.IO.Path]::GetTempPath()
if (-not [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
    [System.Runtime.InteropServices.OSPlatform]::Windows) -and
    (Test-Path -LiteralPath '/bin/pwd' -PathType Leaf)) {
  Push-Location $SystemTemp
  try {
    $SystemTemp = ((& /bin/pwd -P) | Out-String).Trim()
  } finally {
    Pop-Location
  }
}
$TempRoot = Join-Path $SystemTemp ("steel-uninstall-policy-" + [Guid]::NewGuid().ToString('N'))
$TempBoundary = [System.IO.Path]::GetFullPath($TempRoot).TrimEnd('\', '/')
try {
  $Install = Join-Path $TempRoot 'ProgramFiles\SteelInspectionRuntime'
  $State = Join-Path $TempRoot 'ProgramData\SteelInspectionRuntime'
  $ReleaseId = '1.2.3-0123456789ab'
  $PreviousId = '1.2.2-abcdef012345'
  $Current = Join-Path $Install "releases\$ReleaseId"
  $Previous = Join-Path $Install "releases\$PreviousId"
  $Deployment = Join-Path $State 'deployment'
  New-Item -ItemType Directory -Path $Current | Out-Null
  New-Item -ItemType Directory -Path $Previous | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $State 'database') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $Current 'payload.bin'), 'current')
  [System.IO.File]::WriteAllText((Join-Path $Previous 'payload.bin'), 'previous')

  $Validated = Assert-CurrentReleasePath -InstallRoot $Install -RuntimeRoot $Current -ExpectedReleaseId $ReleaseId
  $NestedRejected = Invoke-ExpectThrow {
    Assert-CurrentReleasePath -InstallRoot $Install -RuntimeRoot (Join-Path $Current 'nested')
  } 'exact direct child'
  $IncomingRejected = Invoke-ExpectThrow {
    Assert-CurrentReleasePath -InstallRoot $Install -RuntimeRoot (Join-Path $Install 'releases\.incoming-deadbeef')
  } 'in-flight staging'
  $Checks.directReleaseBoundary = (Test-PathEquals -Left $Validated -Right $Current) -and $NestedRejected -and $IncomingRejected

  $ProtectedCandidate = @((Get-ProtectedOperatingSystemRoots) | Select-Object -First 1)
  if ($ProtectedCandidate.Count -eq 1) {
    $Checks.protectedRootGuard = Invoke-ExpectThrow {
      Assert-ManagedRootIsNotProtected -Path $ProtectedCandidate[0] -Label 'fixture root'
    } 'protected ProgramFiles, ProgramData, or Windows root'
  } else {
    throw 'The test host did not expose any protected operating-system root.'
  }
  $Checks.overlapGuard = Invoke-ExpectThrow {
    Assert-ManagedRootsDoNotOverlap -InstallRoot $Install -StateRoot (Join-Path $Install 'state')
  } 'non-overlapping'

  $JournalPath = Join-Path $Deployment 'upgrade.json'
  $Journal = [ordered]@{
    schema = 'steel.runtime-deployment-transaction.v1'
    transactionId = '0123456789abcdef0123456789abcdef'
    serviceName = 'SteelInspectionRuntime'
    phase = 'committed'
    installRoot = $Install
    historyPath = Join-Path $Deployment 'history\0123456789abcdef0123456789abcdef.json'
    target = [ordered]@{
      releaseId = $ReleaseId
      releaseRoot = $Current
    }
    database = [ordered]@{ backupPath = $null }
    rollback = [ordered]@{
      runtimeEnvironment = [ordered]@{ backupPath = $null }
      activeDeployment = [ordered]@{ backupPath = $null }
    }
  }
  Write-FixtureJson -Path $JournalPath -Value $Journal
  $ReadJournal = Assert-DeploymentJournalTerminal -StateRoot $State -InstallRoot $Install
  $Checks.terminalJournal = [string]$ReadJournal.phase -ceq 'committed'
  $ExpectedHistoryPath = $Journal.historyPath
  $Journal.historyPath = Join-Path $TempRoot 'copied-history.json'
  Write-FixtureJson -Path $JournalPath -Value $Journal
  $Checks.journalPathBinding = Invoke-ExpectThrow {
    Assert-DeploymentJournalTerminal -StateRoot $State -InstallRoot $Install
  } 'exact direct child'
  $Journal.historyPath = $ExpectedHistoryPath

  $NonTerminalRejected = $true
  foreach ($Phase in @('prepared', 'payload-published', 'service-stopped', 'scm-switched', 'failed-safe')) {
    $Journal.phase = $Phase
    Write-FixtureJson -Path $JournalPath -Value $Journal
    $NonTerminalRejected = $NonTerminalRejected -and (Invoke-ExpectThrow {
      Assert-DeploymentJournalTerminal -StateRoot $State -InstallRoot $Install
    } 'non-terminal')
  }
  $Checks.nonTerminalJournal = $NonTerminalRejected
  [System.IO.File]::WriteAllText($JournalPath, '{truncated')
  $Checks.corruptJournal = Invoke-ExpectThrow {
    Assert-DeploymentJournalTerminal -StateRoot $State -InstallRoot $Install
  } 'unreadable or truncated'
  $Journal.phase = 'rolled-back'
  Write-FixtureJson -Path $JournalPath -Value $Journal

  $ActivePath = Join-Path $Deployment 'active.json'
  $Active = [ordered]@{
    schema = 'steel.runtime-active-deployment.v1'
    releaseId = $ReleaseId
    releaseVersion = '1.2.3'
    releaseCommit = '0123456789abcdef0123456789abcdef01234567'
    releaseRoot = $Current
    stateRoot = $State
    serviceName = 'SteelInspectionRuntime'
    transactionId = 'abcdef0123456789abcdef0123456789'
  }
  Write-FixtureJson -Path $ActivePath -Value $Active
  $ActiveResult = Get-ValidatedActiveDeployment -StateRoot $State -InstallRoot $Install
  # Exercise identity mismatch by temporarily changing the state recorded in
  # the existing active deployment file.
  $Active.stateRoot = Join-Path $TempRoot 'wrong-state'
  Write-FixtureJson -Path $ActivePath -Value $Active
  $MismatchRejected = Invoke-ExpectThrow {
    Get-ValidatedActiveDeployment -StateRoot $State -InstallRoot $Install
  } 'differs from the selected StateRoot'
  $Active.stateRoot = $State
  Write-FixtureJson -Path $ActivePath -Value $Active
  $Checks.activeIdentity = (Test-PathEquals -Left $ActiveResult.RuntimeRoot -Right $Current) -and
    $MismatchRejected

  $Supervisor = Join-Path $Current 'service\steel-runtime-supervisor.exe'
  $ImagePath = "`"$Supervisor`" --service --root `"$Current`" --state-root `"$State`""
  $DuplicateRejected = Invoke-ExpectThrow {
    Get-QuotedServiceArgument -ImagePath ($ImagePath + " --root `"$Previous`"") -Name 'root'
  } 'duplicate --root'
  $Checks.serviceImageContract =
    (Test-PathEquals -Left (Get-QuotedServiceExecutable -ImagePath $ImagePath) -Right $Supervisor) -and
    (Test-PathEquals -Left (Get-QuotedServiceArgument -ImagePath $ImagePath -Name 'root') -Right $Current) -and
    (Test-PathEquals -Left (Get-QuotedServiceArgument -ImagePath $ImagePath -Name 'state-root') -Right $State) -and
    $DuplicateRejected

  $Phrase = Get-PurgeConfirmationPhrase -InstallRoot $Install -StateRoot $State
  Assert-PurgeAuthorized -InstallRoot $Install -StateRoot $State -Confirmation $Phrase
  $Checks.purgeConfirmation = Invoke-ExpectThrow {
    Assert-PurgeAuthorized -InstallRoot $Install -StateRoot $State -Confirmation 'PURGE SteelInspectionRuntime'
  } 'Purge deletes databases'

  Remove-CurrentReleasePayload -InstallRoot $Install -RuntimeRoot $Current -ExpectedReleaseId $ReleaseId
  $Checks.defaultPayloadScope = -not (Test-Path -LiteralPath $Current) -and
    (Test-Path -LiteralPath $Previous -PathType Container) -and
    (Test-Path -LiteralPath $State -PathType Container) -and
    (Test-Path -LiteralPath $ActivePath -PathType Leaf) -and
    (Test-Path -LiteralPath $JournalPath -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $State 'database') -PathType Container)
} finally {
  $ResolvedTemp = [System.IO.Path]::GetFullPath($TempRoot).TrimEnd('\', '/')
  $SystemTempBoundary = [System.IO.Path]::GetFullPath($SystemTemp).TrimEnd('\', '/')
  if (-not $ResolvedTemp.StartsWith($SystemTempBoundary + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not (Test-PathEquals -Left $ResolvedTemp -Right $TempBoundary)) {
    throw "Refusing test cleanup outside the exact temporary fixture root: $ResolvedTemp"
  }
  if (Test-Path -LiteralPath $ResolvedTemp) {
    Remove-Item -LiteralPath $ResolvedTemp -Recurse -Force
  }
}

$Failed = @($Checks.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object { $_.Key })
[pscustomobject]$Checks | ConvertTo-Json -Depth 5
if ($Failed.Count -gt 0) {
  throw "Runtime service uninstall policy checks failed: $($Failed -join ', ')"
}
