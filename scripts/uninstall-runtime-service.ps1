[CmdletBinding()]
param(
  [string]$InstallRoot = "",
  [string]$StateRoot = "",
  [switch]$RemoveRuntimeEnvironment,
  [switch]$Purge,
  [string]$PurgeConfirmation = "",
  [ValidateRange(1, 600)]
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
$ServiceName = "SteelInspectionRuntime"
$RegistryPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
$DeploymentMutexName = 'Global\SteelInspectionRuntime-Deployment'

function ConvertTo-NormalizedAbsolutePath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $Expanded = [Environment]::ExpandEnvironmentVariables($Path).Trim()
  if ([string]::IsNullOrWhiteSpace($Expanded) -or -not [System.IO.Path]::IsPathRooted($Expanded)) {
    throw "$Label must be an absolute path."
  }
  $Normalized = [System.IO.Path]::GetFullPath($Expanded).TrimEnd('\', '/')
  $VolumeRoot = [System.IO.Path]::GetPathRoot($Normalized).TrimEnd('\', '/')
  if ([string]::IsNullOrWhiteSpace($Normalized) -or $Normalized.Equals($VolumeRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be a dedicated directory and must not be a volume root."
  }
  return $Normalized
}

function Test-PathEquals {
  param([string]$Left, [string]$Right)
  return $Left.Equals($Right, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-PathEqualsOrDescendsFrom {
  param([string]$Path, [string]$Root)
  return (Test-PathEquals -Left $Path -Right $Root) -or
    $Path.StartsWith($Root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-ManagedRootsDoNotOverlap {
  param([string]$InstallRoot, [string]$StateRoot)
  if ((Test-PathEqualsOrDescendsFrom -Path $InstallRoot -Root $StateRoot) -or
      (Test-PathEqualsOrDescendsFrom -Path $StateRoot -Root $InstallRoot)) {
    throw 'InstallRoot and StateRoot must be separate, non-overlapping managed directories.'
  }
}

function Get-ProtectedOperatingSystemRoots {
  $Protected = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($Candidate in @(
    [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles),
    [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86),
    [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData),
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)},
    $env:ProgramData,
    $env:SystemRoot
  )) {
    if (-not [string]::IsNullOrWhiteSpace([string]$Candidate) -and [System.IO.Path]::IsPathRooted([string]$Candidate)) {
      [void]$Protected.Add([System.IO.Path]::GetFullPath([string]$Candidate).TrimEnd('\', '/'))
    }
  }
  return @($Protected)
}

function Assert-ManagedRootIsNotProtected {
  param([string]$Path, [string]$Label)
  $Normalized = ConvertTo-NormalizedAbsolutePath -Path $Path -Label $Label
  foreach ($ProtectedRoot in @(Get-ProtectedOperatingSystemRoots)) {
    if (Test-PathEquals -Left $Normalized -Right $ProtectedRoot) {
      throw "$Label must not equal a protected ProgramFiles, ProgramData, or Windows root: $Normalized"
    }
  }
  return $Normalized
}

function Assert-NotReparsePoint {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $Item = Get-Item -LiteralPath $Path -Force
  if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing a path containing a reparse point: $($Item.FullName)"
  }
}

function Assert-NoReparseAncestors {
  param([string]$Path)
  $FullPath = [System.IO.Path]::GetFullPath($Path)
  $VolumeRootPath = [System.IO.Path]::GetPathRoot($FullPath)
  $VolumeRoot = $VolumeRootPath.TrimEnd('\', '/')
  $Cursor = $FullPath.TrimEnd('\', '/')
  while (-not [string]::IsNullOrWhiteSpace($Cursor)) {
    if (Test-PathEquals -Left $Cursor -Right $VolumeRoot) {
      Assert-NotReparsePoint -Path $VolumeRootPath
      break
    }
    Assert-NotReparsePoint -Path $Cursor
    $Parent = Split-Path -Parent $Cursor
    if ([string]::IsNullOrWhiteSpace($Parent) -or (Test-PathEquals -Left $Cursor -Right $Parent)) { break }
    $Cursor = $Parent.TrimEnd('\', '/')
  }
}

function Assert-ManagedRootShape {
  param([string]$Path, [string]$Label)
  Assert-NoReparseAncestors -Path $Path
  if ((Test-Path -LiteralPath $Path) -and -not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Label exists but is not a directory: $Path"
  }
}

function Assert-NoReparseTree {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "Expected a directory deletion target: $Path"
  }
  $Directories = [System.Collections.Generic.Queue[string]]::new()
  Assert-NotReparsePoint -Path $Path
  $Directories.Enqueue($Path)
  while ($Directories.Count -gt 0) {
    $Directory = $Directories.Dequeue()
    foreach ($Child in @(Get-ChildItem -LiteralPath $Directory -Force)) {
      Assert-NotReparsePoint -Path $Child.FullName
      if ($Child -is [System.IO.DirectoryInfo]) {
        $Directories.Enqueue($Child.FullName)
      }
    }
  }
}

function Assert-PathIsExactDirectChild {
  param(
    [string]$Root,
    [string]$Candidate,
    [string]$Label
  )
  $RootBoundary = ConvertTo-NormalizedAbsolutePath -Path $Root -Label "$Label root"
  $CandidateBoundary = ConvertTo-NormalizedAbsolutePath -Path $Candidate -Label $Label
  $Parent = [System.IO.Path]::GetDirectoryName($CandidateBoundary).TrimEnd('\', '/')
  if (-not (Test-PathEquals -Left $Parent -Right $RootBoundary)) {
    throw "$Label must be an exact direct child of $RootBoundary; refusing $CandidateBoundary"
  }
  return $CandidateBoundary
}

function Assert-PathDescendsFromExactRoot {
  param(
    [string]$Root,
    [string]$Candidate,
    [string]$Label
  )
  $RootBoundary = ConvertTo-NormalizedAbsolutePath -Path $Root -Label "$Label root"
  $CandidateBoundary = ConvertTo-NormalizedAbsolutePath -Path $Candidate -Label $Label
  if (-not $CandidateBoundary.StartsWith($RootBoundary + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be contained by the exact root $RootBoundary; refusing $CandidateBoundary"
  }
  return $CandidateBoundary
}

function Assert-CurrentReleasePath {
  param(
    [string]$InstallRoot,
    [string]$RuntimeRoot,
    [string]$ExpectedReleaseId = ""
  )
  $ReleasesRoot = Join-Path $InstallRoot 'releases'
  $ReleaseRoot = Assert-PathIsExactDirectChild -Root $ReleasesRoot -Candidate $RuntimeRoot -Label 'RuntimeRoot'
  $ReleaseId = Split-Path -Leaf $ReleaseRoot
  if ($ReleaseId.StartsWith('.incoming-', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The current release deletion target must not be an in-flight staging directory.'
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedReleaseId) -and
      -not $ReleaseId.Equals($ExpectedReleaseId, [System.StringComparison]::Ordinal)) {
    throw "RuntimeRoot leaf '$ReleaseId' does not match the recorded release id '$ExpectedReleaseId'."
  }
  return $ReleaseRoot
}

function Read-JsonFileFailClosed {
  param([string]$Path, [string]$Label)
  try {
    $Value = Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json
  } catch {
    throw "$Label is unreadable or truncated; refusing uninstall mutations: $($_.Exception.Message)"
  }
  if ($null -eq $Value) {
    throw "$Label is empty; refusing uninstall mutations."
  }
  return $Value
}

function Assert-DeploymentJournalTerminal {
  param(
    [string]$StateRoot,
    [string]$InstallRoot = ""
  )
  $JournalPath = Join-Path $StateRoot 'deployment\upgrade.json'
  Assert-NoReparseAncestors -Path $JournalPath
  if (-not (Test-Path -LiteralPath $JournalPath)) { return $null }
  if (-not (Test-Path -LiteralPath $JournalPath -PathType Leaf)) {
    throw "Deployment journal is not a regular file: $JournalPath"
  }
  $Journal = Read-JsonFileFailClosed -Path $JournalPath -Label 'Deployment upgrade journal'
  if ([string]$Journal.schema -cne 'steel.runtime-deployment-transaction.v1' -or
      [string]$Journal.serviceName -cne 'SteelInspectionRuntime' -or
      [string]$Journal.transactionId -notmatch '^[0-9a-f]{32}$') {
    throw 'Deployment upgrade journal identity is invalid; refusing uninstall mutations.'
  }
  if ([string]$Journal.phase -cnotin @('committed', 'rolled-back')) {
    throw "Deployment upgrade journal is non-terminal (phase='$([string]$Journal.phase)'); service and payload were not changed."
  }
  $HistoryRoot = Join-Path $StateRoot 'deployment\history'
  $RecordedHistoryPath = Assert-PathIsExactDirectChild -Root $HistoryRoot -Candidate ([string]$Journal.historyPath) -Label 'Journal history path'
  $ExpectedHistoryName = "$([string]$Journal.transactionId).json"
  if ((Split-Path -Leaf $RecordedHistoryPath) -cne $ExpectedHistoryName) {
    throw 'Deployment journal history path does not match its transaction id.'
  }
  $TransactionBackupRoot = Join-Path $StateRoot "deployment\backups\$([string]$Journal.transactionId)"
  foreach ($BackupPath in @(
    [string]$Journal.rollback.runtimeEnvironment.backupPath,
    [string]$Journal.rollback.activeDeployment.backupPath,
    [string]$Journal.database.backupPath
  )) {
    if (-not [string]::IsNullOrWhiteSpace($BackupPath)) {
      [void](Assert-PathDescendsFromExactRoot -Root $TransactionBackupRoot -Candidate $BackupPath -Label 'Journal backup path')
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($InstallRoot)) {
    $RecordedInstallRoot = ConvertTo-NormalizedAbsolutePath -Path ([string]$Journal.installRoot) -Label 'Journal InstallRoot'
    if (-not (Test-PathEquals -Left $RecordedInstallRoot -Right $InstallRoot)) {
      throw 'Deployment upgrade journal InstallRoot differs from the selected InstallRoot.'
    }
    if ($null -ne $Journal.target -and -not [string]::IsNullOrWhiteSpace([string]$Journal.target.releaseRoot)) {
      [void](Assert-CurrentReleasePath -InstallRoot $InstallRoot -RuntimeRoot ([string]$Journal.target.releaseRoot) -ExpectedReleaseId ([string]$Journal.target.releaseId))
    }
  }
  return $Journal
}

function Get-ValidatedActiveDeployment {
  param(
    [string]$StateRoot,
    [string]$InstallRoot = ""
  )
  $ActivePath = Join-Path $StateRoot 'deployment\active.json'
  Assert-NoReparseAncestors -Path $ActivePath
  if (-not (Test-Path -LiteralPath $ActivePath)) { return $null }
  if (-not (Test-Path -LiteralPath $ActivePath -PathType Leaf)) {
    throw "Active deployment record is not a regular file: $ActivePath"
  }
  $Active = Read-JsonFileFailClosed -Path $ActivePath -Label 'Active deployment record'
  if ([string]$Active.schema -cne 'steel.runtime-active-deployment.v1' -or
      [string]$Active.serviceName -cne 'SteelInspectionRuntime' -or
      [string]$Active.transactionId -notmatch '^[0-9a-f]{32}$' -or
      [string]$Active.releaseCommit -notmatch '^[0-9a-fA-F]{40,64}$' -or
      [string]$Active.releaseVersion -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw 'Active deployment record identity is invalid; refusing uninstall mutations.'
  }
  $RecordedStateRoot = ConvertTo-NormalizedAbsolutePath -Path ([string]$Active.stateRoot) -Label 'Active StateRoot'
  if (-not (Test-PathEquals -Left $RecordedStateRoot -Right $StateRoot)) {
    throw 'Active deployment StateRoot differs from the selected StateRoot.'
  }
  $ReleaseRoot = ConvertTo-NormalizedAbsolutePath -Path ([string]$Active.releaseRoot) -Label 'Active RuntimeRoot'
  $DerivedInstallRoot = Split-Path -Parent (Split-Path -Parent $ReleaseRoot)
  if (-not [string]::IsNullOrWhiteSpace($InstallRoot)) {
    [void](Assert-CurrentReleasePath -InstallRoot $InstallRoot -RuntimeRoot $ReleaseRoot -ExpectedReleaseId ([string]$Active.releaseId))
  } else {
    $DerivedInstallRoot = Assert-ManagedRootIsNotProtected -Path $DerivedInstallRoot -Label 'Derived InstallRoot'
    [void](Assert-CurrentReleasePath -InstallRoot $DerivedInstallRoot -RuntimeRoot $ReleaseRoot -ExpectedReleaseId ([string]$Active.releaseId))
  }
  return [pscustomobject]@{
    Record = $Active
    Path = $ActivePath
    InstallRoot = $DerivedInstallRoot
    RuntimeRoot = $ReleaseRoot
  }
}

function Get-QuotedServiceArgument {
  param([string]$ImagePath, [string]$Name)
  if ([string]::IsNullOrWhiteSpace($ImagePath)) { return $null }
  $Pattern = '(?:^|\s)--{0}\s+"([^"]+)"' -f [regex]::Escape($Name)
  $Matches = [regex]::Matches($ImagePath, $Pattern, [System.Text.RegularExpressions.RegexOptions]::CultureInvariant)
  if ($Matches.Count -eq 0) { return $null }
  if ($Matches.Count -ne 1) { throw "SCM ImagePath contains duplicate --$Name arguments." }
  return $Matches[0].Groups[1].Value
}

function Get-QuotedServiceExecutable {
  param([string]$ImagePath)
  if ([string]::IsNullOrWhiteSpace($ImagePath)) { return $null }
  $Match = [regex]::Match($ImagePath, '^\s*"([^"]+)"\s+--service(?:\s|$)', [System.Text.RegularExpressions.RegexOptions]::CultureInvariant)
  if (-not $Match.Success) { return $null }
  return $Match.Groups[1].Value
}

function Get-ServiceRegistrationSnapshot {
  param([string]$RegistryPath, [string]$ServiceName)
  $Service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  $Registry = Get-ItemProperty -LiteralPath $RegistryPath -ErrorAction SilentlyContinue
  $ImagePath = if ($null -ne $Registry) { [string]$Registry.ImagePath } else { '' }
  return [pscustomobject]@{
    ServiceExists = $null -ne $Service
    ServiceStatus = if ($null -ne $Service) { [string]$Service.Status } else { '' }
    RegistryExists = $null -ne $Registry
    ImagePath = $ImagePath
    ImageExecutable = Get-QuotedServiceExecutable -ImagePath $ImagePath
    InstallRoot = if ($null -ne $Registry) { [string]$Registry.SteelInstallRoot } else { '' }
    RuntimeRoot = if ($null -ne $Registry) { [string]$Registry.SteelRuntimeRoot } else { '' }
    StateRoot = if ($null -ne $Registry) { [string]$Registry.SteelStateRoot } else { '' }
    ReleaseId = if ($null -ne $Registry) { [string]$Registry.SteelReleaseId } else { '' }
    ImageRuntimeRoot = Get-QuotedServiceArgument -ImagePath $ImagePath -Name 'root'
    ImageStateRoot = Get-QuotedServiceArgument -ImagePath $ImagePath -Name 'state-root'
  }
}

function Get-DefaultInstallRoot {
  $ProgramFilesRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
  if ([string]::IsNullOrWhiteSpace($ProgramFilesRoot)) { $ProgramFilesRoot = $env:ProgramFiles }
  if ([string]::IsNullOrWhiteSpace($ProgramFilesRoot)) { throw 'Unable to determine Program Files.' }
  return Join-Path $ProgramFilesRoot 'SteelInspectionRuntime'
}

function Get-DefaultStateRoot {
  $ProgramDataRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
  if ([string]::IsNullOrWhiteSpace($ProgramDataRoot)) { $ProgramDataRoot = $env:ProgramData }
  if ([string]::IsNullOrWhiteSpace($ProgramDataRoot)) { throw 'Unable to determine ProgramData.' }
  return Join-Path $ProgramDataRoot 'SteelInspectionRuntime'
}

function Assert-Administrator {
  $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $Principal = [System.Security.Principal.WindowsPrincipal]::new($Identity)
  if (-not $Principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Runtime service uninstall must run from an elevated administrator session.'
  }
}

function Wait-ServiceStopped {
  param([string]$ServiceName, [int]$TimeoutSeconds)
  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ($true) {
    $Service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -eq $Service -or $Service.Status -eq 'Stopped') { return }
    if ([DateTime]::UtcNow -ge $Deadline) {
      throw "Timed out after $TimeoutSeconds seconds waiting for service $ServiceName to stop."
    }
    Start-Sleep -Milliseconds 250
  }
}

function Wait-ServiceAbsent {
  param([string]$ServiceName, [int]$TimeoutSeconds)
  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ((Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $Deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    throw "Timed out after $TimeoutSeconds seconds waiting for service $ServiceName to disappear from SCM."
  }
}

function Wait-ServiceRegistrationAbsent {
  param([string]$RegistryPath, [int]$TimeoutSeconds)
  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ((Test-Path -LiteralPath $RegistryPath) -and [DateTime]::UtcNow -lt $Deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path -LiteralPath $RegistryPath) {
    throw 'The service registry key remains after SCM deletion; no payload or state was removed.'
  }
}

function Get-RuntimePortBindings {
  $Bindings = [System.Collections.Generic.List[object]]::new()
  foreach ($Port in 4317, 4873, 4874, 4875, 4881, 4882, 4883) {
    foreach ($Connection in @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) {
      $Bindings.Add([pscustomobject]@{
        Protocol = 'TCP'
        Port = $Port
        Address = [string]$Connection.LocalAddress
        ProcessId = [int]$Connection.OwningProcess
      })
    }
    foreach ($Endpoint in @(Get-NetUDPEndpoint -LocalPort $Port -ErrorAction SilentlyContinue)) {
      $Bindings.Add([pscustomobject]@{
        Protocol = 'UDP'
        Port = $Port
        Address = [string]$Endpoint.LocalAddress
        ProcessId = [int]$Endpoint.OwningProcess
      })
    }
  }
  return @($Bindings)
}

function Wait-RuntimePortsReleased {
  param([int]$TimeoutSeconds)
  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $Bindings = @(Get-RuntimePortBindings)
  while ($Bindings.Count -gt 0 -and [DateTime]::UtcNow -lt $Deadline) {
    Start-Sleep -Milliseconds 250
    $Bindings = @(Get-RuntimePortBindings)
  }
  if ($Bindings.Count -gt 0) {
    $Summary = $Bindings | ForEach-Object { "$($_.Protocol)/$($_.Port) pid=$($_.ProcessId) address=$($_.Address)" }
    throw "Runtime ports were not released within $TimeoutSeconds seconds: $($Summary -join '; ')"
  }
}

function Get-PurgeConfirmationPhrase {
  param([string]$InstallRoot, [string]$StateRoot)
  return "PURGE SteelInspectionRuntime|INSTALL=$InstallRoot|STATE=$StateRoot"
}

function Assert-PurgeAuthorized {
  param(
    [string]$InstallRoot,
    [string]$StateRoot,
    [string]$Confirmation
  )
  $Expected = Get-PurgeConfirmationPhrase -InstallRoot $InstallRoot -StateRoot $StateRoot
  if ([string]::IsNullOrWhiteSpace($Confirmation) -or $Confirmation -cne $Expected) {
    throw "Purge deletes databases, logs, configuration, deployment history/backups, StateRoot-local keys, and business data. Re-run with -PurgeConfirmation '$Expected'."
  }
}

function Remove-EmptyManagedDirectory {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return }
  Assert-NotReparsePoint -Path $Path
  if (@(Get-ChildItem -LiteralPath $Path -Force).Count -eq 0) {
    Remove-Item -LiteralPath $Path -Force
  }
}

function Remove-CurrentReleasePayload {
  param([string]$InstallRoot, [string]$RuntimeRoot, [string]$ExpectedReleaseId = "")
  $InstallRoot = Assert-ManagedRootIsNotProtected -Path $InstallRoot -Label 'InstallRoot'
  $ReleasesRoot = Assert-PathIsExactDirectChild -Root $InstallRoot -Candidate (Join-Path $InstallRoot 'releases') -Label 'releases root'
  $ReleaseRoot = Assert-CurrentReleasePath -InstallRoot $InstallRoot -RuntimeRoot $RuntimeRoot -ExpectedReleaseId $ExpectedReleaseId
  Assert-NoReparseAncestors -Path $ReleaseRoot
  if (Test-Path -LiteralPath $ReleaseRoot) {
    Assert-NoReparseTree -Path $ReleaseRoot
    # The immediately preceding checks prove this is one exact direct child of
    # InstallRoot\releases; never enumerate paths in another shell for deletion.
    Remove-Item -LiteralPath $ReleaseRoot -Recurse -Force
  }
  Remove-EmptyManagedDirectory -Path $ReleasesRoot
  Remove-EmptyManagedDirectory -Path $InstallRoot
}

function Assert-ServiceAndRegistrationAbsent {
  param([string]$ServiceName, [string]$RegistryPath)
  if ((Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath $RegistryPath)) {
    throw 'SCM service and registry deletion must both complete before any payload or state deletion.'
  }
}

if ($RemoveRuntimeEnvironment -and $Purge) {
  throw '-RemoveRuntimeEnvironment and -Purge are mutually exclusive.'
}
if (-not $Purge -and -not [string]::IsNullOrWhiteSpace($PurgeConfirmation)) {
  throw '-PurgeConfirmation is only valid together with -Purge.'
}
if ($Purge -and
    (-not $PSBoundParameters.ContainsKey('InstallRoot') -or -not $PSBoundParameters.ContainsKey('StateRoot'))) {
  throw 'Purge requires explicit -InstallRoot and -StateRoot values; inferred roots are not accepted for destructive state cleanup.'
}

Assert-Administrator
$DeploymentMutex = [System.Threading.Mutex]::new($false, $DeploymentMutexName)
$DeploymentMutexAcquired = $false
try {
  try {
    $DeploymentMutexAcquired = $DeploymentMutex.WaitOne([TimeSpan]::FromSeconds([Math]::Min(30, $TimeoutSeconds)))
  } catch [System.Threading.AbandonedMutexException] {
    $DeploymentMutexAcquired = $true
  }
  if (-not $DeploymentMutexAcquired) {
    throw 'Another deployment transaction holds the global SteelInspectionRuntime deployment mutex.'
  }

  $Registration = Get-ServiceRegistrationSnapshot -RegistryPath $RegistryPath -ServiceName $ServiceName
  $SelectedStateRoot = if (-not [string]::IsNullOrWhiteSpace($StateRoot)) {
    $StateRoot
  } elseif (-not [string]::IsNullOrWhiteSpace($Registration.StateRoot)) {
    $Registration.StateRoot
  } elseif (-not [string]::IsNullOrWhiteSpace($Registration.ImageStateRoot)) {
    $Registration.ImageStateRoot
  } else {
    Get-DefaultStateRoot
  }
  $StateRoot = Assert-ManagedRootIsNotProtected -Path $SelectedStateRoot -Label 'StateRoot'
  Assert-ManagedRootShape -Path $StateRoot -Label 'StateRoot'

  foreach ($RegisteredState in @($Registration.StateRoot, $Registration.ImageStateRoot)) {
    if (-not [string]::IsNullOrWhiteSpace([string]$RegisteredState)) {
      $RegisteredStateRoot = ConvertTo-NormalizedAbsolutePath -Path ([string]$RegisteredState) -Label 'Registered StateRoot'
      if (-not (Test-PathEquals -Left $RegisteredStateRoot -Right $StateRoot)) {
        throw 'Explicit, registry, and SCM ImagePath StateRoot values do not converge.'
      }
    }
  }

  # Inspect active state before deriving InstallRoot. This metadata is retained
  # during a normal uninstall and is never rewritten to hide a partial cleanup.
  $Active = Get-ValidatedActiveDeployment -StateRoot $StateRoot
  $SelectedInstallRoot = if (-not [string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot
  } elseif (-not [string]::IsNullOrWhiteSpace($Registration.InstallRoot)) {
    $Registration.InstallRoot
  } elseif ($null -ne $Active) {
    $Active.InstallRoot
  } elseif (-not [string]::IsNullOrWhiteSpace($Registration.RuntimeRoot)) {
    Split-Path -Parent (Split-Path -Parent $Registration.RuntimeRoot)
  } elseif (-not [string]::IsNullOrWhiteSpace($Registration.ImageRuntimeRoot)) {
    Split-Path -Parent (Split-Path -Parent $Registration.ImageRuntimeRoot)
  } else {
    Get-DefaultInstallRoot
  }
  $InstallRoot = Assert-ManagedRootIsNotProtected -Path $SelectedInstallRoot -Label 'InstallRoot'
  Assert-ManagedRootsDoNotOverlap -InstallRoot $InstallRoot -StateRoot $StateRoot
  Assert-ManagedRootShape -Path $InstallRoot -Label 'InstallRoot'

  if (-not [string]::IsNullOrWhiteSpace($Registration.InstallRoot)) {
    $RegisteredInstallRoot = ConvertTo-NormalizedAbsolutePath -Path $Registration.InstallRoot -Label 'Registered InstallRoot'
    if (-not (Test-PathEquals -Left $RegisteredInstallRoot -Right $InstallRoot)) {
      throw 'Explicit and registered InstallRoot values do not converge.'
    }
  }
  if ($null -ne $Active) {
    $Active = Get-ValidatedActiveDeployment -StateRoot $StateRoot -InstallRoot $InstallRoot
  }

  # Only committed and rolled-back journals are terminal. In particular,
  # failed-safe and every pre-commit phase block even SCM mutation, ensuring a
  # non-terminal upgrade never loses its payload or rollback evidence.
  $DeploymentJournal = Assert-DeploymentJournalTerminal -StateRoot $StateRoot -InstallRoot $InstallRoot

  $RuntimeCandidates = @(
    if (-not [string]::IsNullOrWhiteSpace($Registration.RuntimeRoot)) { [string]$Registration.RuntimeRoot }
    if (-not [string]::IsNullOrWhiteSpace($Registration.ImageRuntimeRoot)) { [string]$Registration.ImageRuntimeRoot }
    if ($null -ne $Active) { [string]$Active.RuntimeRoot }
  )
  $RuntimeRoot = $null
  foreach ($Candidate in $RuntimeCandidates) {
    $ValidatedCandidate = Assert-CurrentReleasePath -InstallRoot $InstallRoot -RuntimeRoot $Candidate -ExpectedReleaseId $Registration.ReleaseId
    if ($null -eq $RuntimeRoot) {
      $RuntimeRoot = $ValidatedCandidate
    } elseif (-not (Test-PathEquals -Left $RuntimeRoot -Right $ValidatedCandidate)) {
      throw 'SCM, registry, and active deployment RuntimeRoot values do not converge.'
    }
  }
  if ($Registration.ServiceExists -and $null -eq $RuntimeRoot) {
    throw 'Installed service does not prove its exact versioned RuntimeRoot; no uninstall mutation was attempted.'
  }
  if ($null -ne $RuntimeRoot) {
    Assert-NoReparseAncestors -Path $RuntimeRoot
    Assert-NoReparseTree -Path $RuntimeRoot
  }
  if ($Registration.ServiceExists) {
    if ([string]::IsNullOrWhiteSpace($Registration.ImageExecutable) -or
        [string]::IsNullOrWhiteSpace($Registration.ImageRuntimeRoot) -or
        [string]::IsNullOrWhiteSpace($Registration.ImageStateRoot)) {
      throw 'SCM ImagePath does not prove the quoted supervisor, RuntimeRoot, and StateRoot contract.'
    }
    $RegisteredExecutable = ConvertTo-NormalizedAbsolutePath -Path $Registration.ImageExecutable -Label 'SCM supervisor executable'
    $ExpectedExecutable = [System.IO.Path]::GetFullPath((Join-Path $RuntimeRoot 'service\steel-runtime-supervisor.exe')).TrimEnd('\', '/')
    if (-not (Test-PathEquals -Left $RegisteredExecutable -Right $ExpectedExecutable)) {
      throw 'SCM ImagePath executable is not the supervisor inside the exact current RuntimeRoot.'
    }
  }

  $RuntimeEnvironmentPath = $null
  if ($RemoveRuntimeEnvironment) {
    $RuntimeEnvironmentPath = Assert-PathIsExactDirectChild -Root (Join-Path $StateRoot 'config') -Candidate (Join-Path $StateRoot 'config\runtime-service.env') -Label 'runtime-service.env'
    Assert-NoReparseAncestors -Path $RuntimeEnvironmentPath
  }

  if ($Purge) {
    $RegisteredRootProof = $Registration.RegistryExists -and
      -not [string]::IsNullOrWhiteSpace($Registration.InstallRoot) -and
      -not [string]::IsNullOrWhiteSpace($Registration.StateRoot)
    if (-not $RegisteredRootProof -and $null -eq $Active -and $null -eq $DeploymentJournal) {
      throw 'Purge requires active deployment, terminal journal, or exact registered InstallRoot/StateRoot evidence; explicit paths alone are insufficient.'
    }
    Assert-PurgeAuthorized -InstallRoot $InstallRoot -StateRoot $StateRoot -Confirmation $PurgeConfirmation
    Assert-NoReparseTree -Path $InstallRoot
    Assert-NoReparseTree -Path $StateRoot
  }

  $Service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($null -ne $Service) {
    if ($Service.Status -ne 'Stopped') {
      Stop-Service -Name $ServiceName -Force
      Wait-ServiceStopped -ServiceName $ServiceName -TimeoutSeconds $TimeoutSeconds
    }
    $DeleteOutput = & sc.exe delete $ServiceName 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to delete service from SCM: $($DeleteOutput -join ' ')"
    }
    Wait-ServiceAbsent -ServiceName $ServiceName -TimeoutSeconds $TimeoutSeconds
  }

  # sc.exe normally owns registry removal. An already-orphaned exact service key
  # is removed only after SCM proves that no service object remains.
  Wait-ServiceAbsent -ServiceName $ServiceName -TimeoutSeconds $TimeoutSeconds
  if (Test-Path -LiteralPath $RegistryPath) {
    Remove-Item -LiteralPath $RegistryPath -Recurse -Force
  }
  Wait-ServiceRegistrationAbsent -RegistryPath $RegistryPath -TimeoutSeconds $TimeoutSeconds
  Wait-RuntimePortsReleased -TimeoutSeconds $TimeoutSeconds
  Assert-ServiceAndRegistrationAbsent -ServiceName $ServiceName -RegistryPath $RegistryPath

  # Re-read the journal after service deletion and before filesystem deletion.
  # The deployment mutex prevents the installer from beginning another upgrade.
  [void](Assert-DeploymentJournalTerminal -StateRoot $StateRoot -InstallRoot $InstallRoot)
  $ActiveAfterServiceRemoval = Get-ValidatedActiveDeployment -StateRoot $StateRoot -InstallRoot $InstallRoot
  if (($null -eq $Active) -ne ($null -eq $ActiveAfterServiceRemoval)) {
    throw 'Active deployment evidence changed during uninstall; no payload or state was removed.'
  }
  if ($null -ne $Active -and
      (([string]$Active.Record.transactionId -cne [string]$ActiveAfterServiceRemoval.Record.transactionId) -or
       -not (Test-PathEquals -Left $Active.RuntimeRoot -Right $ActiveAfterServiceRemoval.RuntimeRoot))) {
    throw 'Active deployment identity changed during uninstall; no payload or state was removed.'
  }

  if ($Purge) {
    Assert-ServiceAndRegistrationAbsent -ServiceName $ServiceName -RegistryPath $RegistryPath
    Assert-ManagedRootIsNotProtected -Path $InstallRoot -Label 'InstallRoot' | Out-Null
    Assert-ManagedRootIsNotProtected -Path $StateRoot -Label 'StateRoot' | Out-Null
    Assert-ManagedRootsDoNotOverlap -InstallRoot $InstallRoot -StateRoot $StateRoot
    Assert-NoReparseAncestors -Path $InstallRoot
    Assert-NoReparseAncestors -Path $StateRoot
    Assert-NoReparseTree -Path $InstallRoot
    Assert-NoReparseTree -Path $StateRoot
    if (Test-Path -LiteralPath $InstallRoot) {
      Remove-Item -LiteralPath $InstallRoot -Recurse -Force
    }
    # This second recursive deletion is deliberately ordered after InstallRoot.
    # It is not, and must not be described as, a cross-resource atomic action.
    if (Test-Path -LiteralPath $StateRoot) {
      Remove-Item -LiteralPath $StateRoot -Recurse -Force
    }
    Write-Host 'Purge completed as ordered cleanup; it is not a cross-resource atomic transaction.'
    Write-Host 'External secret and acceptance-policy files outside InstallRoot/StateRoot were not deleted.'
  } else {
    if ($null -ne $RuntimeRoot) {
      Assert-ServiceAndRegistrationAbsent -ServiceName $ServiceName -RegistryPath $RegistryPath
      $ExpectedReleaseId = if ($null -ne $Active) { [string]$Active.Record.releaseId } else { [string]$Registration.ReleaseId }
      Remove-CurrentReleasePayload -InstallRoot $InstallRoot -RuntimeRoot $RuntimeRoot -ExpectedReleaseId $ExpectedReleaseId
      Write-Host "Removed the current rebuildable runtime payload: $RuntimeRoot"
    } else {
      Write-Host 'No exact current version directory was recorded; no payload directory was removed.'
    }

    if ($RemoveRuntimeEnvironment) {
      Assert-NoReparseAncestors -Path $RuntimeEnvironmentPath
      if (Test-Path -LiteralPath $RuntimeEnvironmentPath -PathType Leaf) {
        Remove-Item -LiteralPath $RuntimeEnvironmentPath -Force
      }
      Write-Host "Removed the explicitly requested generated environment file: $RuntimeEnvironmentPath"
    }
    Write-Host "Removed $ServiceName from SCM and confirmed its registry key and runtime ports are absent."
    Write-Host "Preserved StateRoot: $StateRoot"
    Write-Host 'Preserved active/previous/in-flight deployment records, upgrade journal, backups/history, database, logs, remaining configuration, policies, keys, and business data.'
    Write-Host "Preserved every non-current release under: $(Join-Path $InstallRoot 'releases')"
  }
} finally {
  if ($DeploymentMutexAcquired) {
    try { $DeploymentMutex.ReleaseMutex() } catch { }
  }
  $DeploymentMutex.Dispose()
}
