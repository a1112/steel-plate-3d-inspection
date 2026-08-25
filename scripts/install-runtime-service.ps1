param(
  # Backward-compatible CLI name. This is a read-only source package, never
  # the installed service payload after the versioned publication step.
  [Parameter(Mandatory = $true)]
  [string]$RuntimeRoot,
  [Parameter(Mandatory = $true)]
  [string]$SecretEnvFile,
  [Parameter(Mandatory = $true)]
  [string]$ArtifactAllowedRoots,
  [Parameter(Mandatory = $true)]
  [string]$AlgorithmAcceptanceReport,
  [Parameter(Mandatory = $true)]
  [string]$SickCaptureProfile,
  [Parameter(Mandatory = $true)]
  [string]$PythonExecutable,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9A-Fa-f]{40}$')]
  [string]$ExpectedFirstPartyThumbprint,
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string[]]$AllowedVendorSdkSignerThumbprints,
  [string]$InstallRoot = "",
  [string]$StateRoot = "",
  [string]$StorageRoot = "H:\",
  [string]$CameraStorageRoot = "H:\",
  [string]$TriggerHost = "127.0.0.1",
  [string]$TriggerSourceAllowlist = "127.0.0.1/32",
  [UInt64]$StorageMinFreeBytes = 21474836480,
  [double]$StorageMinFreePercent = 10,
  [ValidateRange(10, 7200)]
  [int]$AlgorithmProcessTimeoutSec = 1800,
  [switch]$Upgrade,
  [switch]$Start
)

$ErrorActionPreference = "Stop"
$ServiceName = "SteelInspectionRuntime"
$DisplayName = "Steel Inspection Runtime"

function Test-PathsOverlap {
  param(
    [string]$Left,
    [string]$Right
  )
  $LeftBoundary = [System.IO.Path]::GetFullPath($Left).TrimEnd('\', '/')
  $RightBoundary = [System.IO.Path]::GetFullPath($Right).TrimEnd('\', '/')
  return $LeftBoundary.Equals($RightBoundary, [System.StringComparison]::OrdinalIgnoreCase) -or
    $LeftBoundary.StartsWith($RightBoundary + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or
    $RightBoundary.StartsWith($LeftBoundary + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

$SourcePackageRoot = (Resolve-Path -LiteralPath $RuntimeRoot).Path
$SourcePackageRootBoundary = $SourcePackageRoot.TrimEnd('\', '/')
if ($SourcePackageRootBoundary -eq [System.IO.Path]::GetPathRoot($SourcePackageRoot).TrimEnd('\', '/')) {
  throw "RuntimeRoot must be a dedicated package directory and must not be a volume root."
}
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $ProgramFilesRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
  if ([string]::IsNullOrWhiteSpace($ProgramFilesRoot)) { $ProgramFilesRoot = $env:ProgramFiles }
  if ([string]::IsNullOrWhiteSpace($ProgramFilesRoot)) {
    throw 'Unable to determine Program Files; pass an explicit absolute InstallRoot.'
  }
  $InstallRoot = Join-Path $ProgramFilesRoot "SteelInspectionRuntime"
} else {
  $InstallRoot = [Environment]::ExpandEnvironmentVariables($InstallRoot)
}
if ([string]::IsNullOrWhiteSpace($InstallRoot) -or -not [System.IO.Path]::IsPathRooted($InstallRoot)) {
  throw "InstallRoot must be an absolute path."
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\', '/')
if ($InstallRoot -eq [System.IO.Path]::GetPathRoot($InstallRoot).TrimEnd('\', '/') -or
    (Test-PathsOverlap -Left $InstallRoot -Right $SourcePackageRoot)) {
  throw "InstallRoot must be a non-root path that does not overlap the source package RuntimeRoot."
}
$ReleasesRoot = Join-Path $InstallRoot 'releases'
$SecretEnvFile = (Resolve-Path -LiteralPath $SecretEnvFile).Path
$AlgorithmAcceptanceReport = (Resolve-Path -LiteralPath $AlgorithmAcceptanceReport).Path
$SickCaptureProfile = (Resolve-Path -LiteralPath $SickCaptureProfile).Path
$PythonExecutable = (Resolve-Path -LiteralPath $PythonExecutable).Path
$ExpectedFirstPartyThumbprint = $ExpectedFirstPartyThumbprint.ToUpperInvariant()
$NormalizedVendorSignerThumbprints = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach ($Thumbprint in $AllowedVendorSdkSignerThumbprints) {
  $NormalizedThumbprint = ([string]$Thumbprint).Trim().ToUpperInvariant()
  if ($NormalizedThumbprint -notmatch '^[0-9A-F]{40}$') {
    throw "Every allowed vendor SDK signer thumbprint must contain exactly 40 hexadecimal characters."
  }
  [void]$NormalizedVendorSignerThumbprints.Add($NormalizedThumbprint)
}
if ($NormalizedVendorSignerThumbprints.Count -eq 0) {
  throw "At least one out-of-band vendor SDK signer thumbprint is required."
}
if ([string]::IsNullOrWhiteSpace($StateRoot)) {
  $ProgramDataRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
  if ([string]::IsNullOrWhiteSpace($ProgramDataRoot)) { $ProgramDataRoot = $env:ProgramData }
  $StateRoot = Join-Path $ProgramDataRoot "SteelInspectionRuntime"
} else {
  $StateRoot = [Environment]::ExpandEnvironmentVariables($StateRoot)
}
if ([string]::IsNullOrWhiteSpace($StateRoot) -or -not [System.IO.Path]::IsPathRooted($StateRoot)) {
  throw "StateRoot must be an absolute path."
}
$StateRoot = [System.IO.Path]::GetFullPath($StateRoot).TrimEnd('\', '/')
if ($StateRoot -eq [System.IO.Path]::GetPathRoot($StateRoot).TrimEnd('\', '/') -or
    (Test-PathsOverlap -Left $StateRoot -Right $SourcePackageRoot) -or
    (Test-PathsOverlap -Left $StateRoot -Right $InstallRoot)) {
  throw "StateRoot must be a non-root path that does not overlap the source package or InstallRoot."
}
foreach ($ExternalPolicyPath in @($SecretEnvFile, $AlgorithmAcceptanceReport, $SickCaptureProfile, $PythonExecutable)) {
  if ($ExternalPolicyPath.Equals($SourcePackageRootBoundary, [System.StringComparison]::OrdinalIgnoreCase) -or
      $ExternalPolicyPath.StartsWith($SourcePackageRootBoundary + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or
      $ExternalPolicyPath.Equals($InstallRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
      $ExternalPolicyPath.StartsWith($InstallRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or
      $ExternalPolicyPath.Equals($StateRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
      $ExternalPolicyPath.StartsWith($StateRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "SecretEnvFile, AlgorithmAcceptanceReport, SickCaptureProfile, and PythonExecutable must be outside the source package, InstallRoot, and StateRoot: $ExternalPolicyPath"
  }
}
$RuntimeRoot = $SourcePackageRoot
$Supervisor = Join-Path $SourcePackageRoot "service\steel-runtime-supervisor.exe"
$AlgorithmConfig = Join-Path $SourcePackageRoot "config\algorithm\bar-surface-production.json"
$CaptureConfigTemplate = Join-Path $SourcePackageRoot "config\capture"
$StateConfigDir = Join-Path $StateRoot "config"
$RuntimeEnvFile = Join-Path $StateConfigDir "runtime-service.env"
$StateServiceDir = Join-Path $StateRoot "service"
$StateCaptureConfigDir = Join-Path $StateRoot "capture-config"
$InstalledSickCaptureProfile = Join-Path $StateCaptureConfigDir "production-sick-profile.json"
$StateLogsDir = Join-Path $StateRoot "logs"
$StateDeploymentDir = Join-Path $StateRoot "deployment"
$ReportArchiveRoot = Join-Path $StateRoot "reports\inspection"
$DeploymentJournalPath = Join-Path $StateDeploymentDir "upgrade.json"
$ActiveDeploymentPath = Join-Path $StateDeploymentDir "active.json"
$DeploymentHistoryDir = Join-Path $StateDeploymentDir "history"
$DeploymentBackupsDir = Join-Path $StateDeploymentDir "backups"
$AlgorithmCalibrationTemplate = Join-Path $CaptureConfigTemplate "calibrations\current-8-time-trigger\ArrayCalibration.xml"
$AlgorithmCalibration = Join-Path $StateCaptureConfigDir "calibrations\current-8-time-trigger\ArrayCalibration.xml"
$AlgorithmScript = Join-Path $SourcePackageRoot "scripts\bar_surface_reconstruct.py"
$SickCaptureScript = Join-Path $SourcePackageRoot "scripts\sick_capture_service.py"
$SickAlgorithmScript = Join-Path $SourcePackageRoot "scripts\sick_flow_analysis_service.py"
$SickCapturePackage = Join-Path $SourcePackageRoot "scripts\sick_capture"
$AlgorithmCore = Join-Path $SourcePackageRoot "algorithm-core\steel_bar_surface_core.exe"
$AlgorithmAcceptanceValidator = Join-Path $SourcePackageRoot "test-algorithm-acceptance-report.ps1"
$DatabaseContractValidator = Join-Path $SourcePackageRoot "verify-database-migration-contract.ps1"
$PackageManifestPath = Join-Path $SourcePackageRoot "manifest.json"
$IntegrityCatalogPath = Join-Path $SourcePackageRoot "release-integrity.cat"
$AllowedSecretNames = @(
  'TRIGGER_SHARED_SECRET',
  'TRIGGER_OPERATOR_TOKEN',
  'STEEL_DATABASE_URL',
  'STEEL_BOOTSTRAP_ADMIN_PASSWORD'
)
$SystemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$AdministratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$TrustedInstallerSid = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$TrustedRuntimeOwnerSids = @($SystemSid.Value, $AdministratorsSid.Value)
$TrustedAncestorOwnerSids = @($SystemSid.Value, $AdministratorsSid.Value, $TrustedInstallerSid)
$ServiceRegistryValueNames = @(
  'DelayedAutoStart',
  'Environment',
  'FailureActions',
  'FailureActionsOnNonCrashFailures',
  'ServiceSidType',
  'SteelReleaseVersion',
  'SteelReleaseCommit',
  'SteelReleaseId',
  'SteelDatabaseSchemaVersion',
  'SteelDatabaseContractSha256',
  'SteelDatabaseMigrationIndexSha256',
  'SteelInstallRoot',
  'SteelRuntimeRoot',
  'SteelStateRoot'
)

function Invoke-ScChecked {
  param([string[]]$Arguments)
  $Output = & sc.exe @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "sc.exe $($Arguments[0]) failed: $($Output -join ' ')"
  }
  return $Output
}

function Set-BoundedServiceFailureActions {
  param(
    [string]$Name,
    [switch]$InitializeOnly
  )
  if ($null -eq ('SteelRuntimeServiceNative' -as [type])) {
    $NativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class SteelRuntimeServiceNative
{
    private const uint SC_MANAGER_CONNECT = 0x0001;
    private const uint SERVICE_CHANGE_CONFIG = 0x0002;
    private const uint SERVICE_CONFIG_FAILURE_ACTIONS = 2;
    private const int SC_ACTION_NONE = 0;
    private const int SC_ACTION_RESTART = 1;

    [StructLayout(LayoutKind.Sequential)]
    private struct SC_ACTION
    {
        public int Type;
        public uint Delay;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SERVICE_FAILURE_ACTIONS
    {
        public uint ResetPeriod;
        public IntPtr RebootMessage;
        public IntPtr Command;
        public uint ActionCount;
        public IntPtr Actions;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenSCManagerW(string machineName, string databaseName, uint desiredAccess);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenServiceW(IntPtr serviceManager, string serviceName, uint desiredAccess);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ChangeServiceConfig2W(
        IntPtr service,
        uint informationLevel,
        ref SERVICE_FAILURE_ACTIONS information);

    [DllImport("advapi32.dll")]
    private static extern bool CloseServiceHandle(IntPtr handle);

    public static void ConfigureBoundedFailureActions(string serviceName)
    {
        IntPtr manager = OpenSCManagerW(null, null, SC_MANAGER_CONNECT);
        if (manager == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenSCManagerW failed");
        IntPtr service = IntPtr.Zero;
        IntPtr actionBuffer = IntPtr.Zero;
        try
        {
            service = OpenServiceW(manager, serviceName, SERVICE_CHANGE_CONFIG);
            if (service == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenServiceW failed");

            SC_ACTION[] actions = new SC_ACTION[]
            {
                new SC_ACTION { Type = SC_ACTION_RESTART, Delay = 5000 },
                new SC_ACTION { Type = SC_ACTION_RESTART, Delay = 30000 },
                new SC_ACTION { Type = SC_ACTION_NONE, Delay = 0 }
            };
            int actionSize = Marshal.SizeOf(typeof(SC_ACTION));
            actionBuffer = Marshal.AllocHGlobal(actionSize * actions.Length);
            for (int index = 0; index < actions.Length; ++index)
                Marshal.StructureToPtr(actions[index], IntPtr.Add(actionBuffer, index * actionSize), false);

            SERVICE_FAILURE_ACTIONS failureActions = new SERVICE_FAILURE_ACTIONS
            {
                ResetPeriod = 86400,
                RebootMessage = IntPtr.Zero,
                Command = IntPtr.Zero,
                ActionCount = (uint)actions.Length,
                Actions = actionBuffer
            };
            if (!ChangeServiceConfig2W(service, SERVICE_CONFIG_FAILURE_ACTIONS, ref failureActions))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "ChangeServiceConfig2W failed");
        }
        finally
        {
            if (actionBuffer != IntPtr.Zero) Marshal.FreeHGlobal(actionBuffer);
            if (service != IntPtr.Zero) CloseServiceHandle(service);
            CloseServiceHandle(manager);
        }
    }
}
'@
    Add-Type -TypeDefinition $NativeSource -Language CSharp
  }
  if ($InitializeOnly) { return }
  [SteelRuntimeServiceNative]::ConfigureBoundedFailureActions($Name)
}

function Assert-PortFree {
  param([int]$Port)
  $TcpListener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  $UdpListener = Get-NetUDPEndpoint -LocalPort $Port -ErrorAction SilentlyContinue
  if ($TcpListener -or $UdpListener) {
    $Protocols = @()
    if ($TcpListener) { $Protocols += 'TCP' }
    if ($UdpListener) { $Protocols += 'UDP' }
    throw "Port $Port is already bound ($($Protocols -join '/')). Stop the existing runtime before service installation."
  }
}

function Assert-Administrator {
  $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $Principal = [System.Security.Principal.WindowsPrincipal]::new($Identity)
  if (-not $Principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Installing or upgrading the LocalSystem runtime service requires an elevated Administrator PowerShell session.'
  }
}

function Get-IdentitySidValue {
  param([System.Security.Principal.IdentityReference]$Identity)
  try {
    return $Identity.Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    throw "Unable to resolve ACL identity '$($Identity.Value)' to a SID."
  }
}

function Assert-NotReparsePoint {
  param([string]$Path)
  $Item = Get-Item -LiteralPath $Path -Force
  if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Reparse points are forbidden in the LocalSystem runtime trust boundary: $($Item.FullName)"
  }
}

function Get-PathAcl {
  param([string]$Path)
  try {
    return Get-Acl -LiteralPath $Path
  } catch {
    throw "Unable to read ACL for '$Path': $($_.Exception.Message)"
  }
}

function Set-TrustedPathAcl {
  param(
    [string]$Path,
    [ValidateSet('Immutable', 'Mutable', 'PolicyReadOnly')]
    [string]$Mode = 'Mutable'
  )
  Assert-NotReparsePoint -Path $Path
  $Item = Get-Item -LiteralPath $Path -Force
  $IsDirectory = $Item -is [System.IO.DirectoryInfo]
  $Acl = if ($IsDirectory) {
    [System.Security.AccessControl.DirectorySecurity]::new()
  } else {
    [System.Security.AccessControl.FileSecurity]::new()
  }
  $Acl.SetAccessRuleProtection($true, $false)
  $Acl.SetOwner($AdministratorsSid)
  $InheritanceFlags = if ($IsDirectory) {
    [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    [System.Security.AccessControl.InheritanceFlags]::None
  }
  $PropagationFlags = [System.Security.AccessControl.PropagationFlags]::None
  $SystemRights = if ($Mode -eq 'Mutable') {
    [System.Security.AccessControl.FileSystemRights]::FullControl
  } else {
    [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
  }
  $AdministratorRights = if ($Mode -eq 'Immutable') {
    [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
  } else {
    [System.Security.AccessControl.FileSystemRights]::FullControl
  }
  $SystemRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $SystemSid,
    $SystemRights,
    $InheritanceFlags,
    $PropagationFlags,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $AdministratorRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $AdministratorsSid,
    $AdministratorRights,
    $InheritanceFlags,
    $PropagationFlags,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$Acl.AddAccessRule($SystemRule)
  [void]$Acl.AddAccessRule($AdministratorRule)
  try {
    Set-Acl -LiteralPath $Item.FullName -AclObject $Acl
  } catch {
    throw "Unable to protect ACL for '$($Item.FullName)': $($_.Exception.Message)"
  }
}

function Assert-TrustedPathAcl {
  param(
    [string]$Path,
    [ValidateSet('Immutable', 'Mutable', 'PolicyReadOnly')]
    [string]$Mode = 'Mutable',
    [string[]]$AllowedOwnerSids = $TrustedRuntimeOwnerSids,
    [switch]$AllowInherited
  )
  Assert-NotReparsePoint -Path $Path
  $Acl = Get-PathAcl -Path $Path
  $OwnerSid = Get-IdentitySidValue -Identity ($Acl.GetOwner([System.Security.Principal.SecurityIdentifier]))
  if ($AllowedOwnerSids -cnotcontains $OwnerSid) {
    throw "Untrusted owner '$OwnerSid' on LocalSystem runtime path: $Path"
  }
  if (-not $AllowInherited -and -not $Acl.AreAccessRulesProtected) {
    throw "ACL inheritance remains enabled on LocalSystem runtime path: $Path"
  }

  $MutationMask = [Int64]0
  foreach ($Right in @(
    [System.Security.AccessControl.FileSystemRights]::WriteData,
    [System.Security.AccessControl.FileSystemRights]::AppendData,
    [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes,
    [System.Security.AccessControl.FileSystemRights]::WriteAttributes,
    [System.Security.AccessControl.FileSystemRights]::Delete,
    [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
    [System.Security.AccessControl.FileSystemRights]::ChangePermissions,
    [System.Security.AccessControl.FileSystemRights]::TakeOwnership
  )) {
    $MutationMask = $MutationMask -bor [Int64]$Right
  }
  $TrustedWriteSids = @($SystemSid.Value, $AdministratorsSid.Value)
  $SystemRights = [Int64]0
  $AdministratorRights = [Int64]0
  foreach ($Rule in $Acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    $Sid = $Rule.IdentityReference.Value
    $Rights = [Int64]$Rule.FileSystemRights
    if ($Rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) {
      throw "Deny ACE '$Sid' is forbidden in the runtime trust boundary: $Path"
    }
    if ($Rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
      if ($TrustedWriteSids -cnotcontains $Sid) {
        throw "Untrusted explicit or inherited ACE '$Sid' on runtime trust-boundary path: $Path"
      }
      if ($Sid -ceq $SystemSid.Value) { $SystemRights = $SystemRights -bor $Rights }
      if ($Sid -ceq $AdministratorsSid.Value) { $AdministratorRights = $AdministratorRights -bor $Rights }
    }
  }
  $ReadExecute = [Int64][System.Security.AccessControl.FileSystemRights]::ReadAndExecute
  $FullControl = [Int64][System.Security.AccessControl.FileSystemRights]::FullControl
  if (($SystemRights -band $ReadExecute) -ne $ReadExecute -or
      ($AdministratorRights -band $ReadExecute) -ne $ReadExecute) {
    throw "Required SYSTEM and Administrators read/execute rights are missing: $Path"
  }
  if ($Mode -eq 'Immutable') {
    if (($SystemRights -band $MutationMask) -ne 0 -or ($AdministratorRights -band $MutationMask) -ne 0) {
      throw "Immutable runtime payload has a writable SYSTEM or Administrators ACE: $Path"
    }
  } elseif ($Mode -eq 'Mutable') {
    if (($SystemRights -band $FullControl) -ne $FullControl -or
        ($AdministratorRights -band $FullControl) -ne $FullControl) {
      throw "Mutable state requires SYSTEM and Administrators full control: $Path"
    }
  } elseif ($Mode -eq 'PolicyReadOnly' -and
            (($AdministratorRights -band $FullControl) -ne $FullControl -or
             ($SystemRights -band $MutationMask) -ne 0)) {
    throw "Read-only policy files require SYSTEM read and Administrators full control: $Path"
  }
}

function Assert-TrustedAncestorChain {
  param(
    [string]$Path,
    [switch]$IncludeSelf
  )
  $Item = Get-Item -LiteralPath $Path -Force
  $Current = if ($IncludeSelf -and $Item -is [System.IO.DirectoryInfo]) {
    $Item
  } elseif ($Item -is [System.IO.DirectoryInfo]) {
    $Item.Parent
  } else {
    $Item.Directory
  }
  $SubstitutionMask = [Int64][System.Security.AccessControl.FileSystemRights]::Delete -bor
    [Int64][System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Int64][System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Int64][System.Security.AccessControl.FileSystemRights]::TakeOwnership
  while ($null -ne $Current) {
    Assert-NotReparsePoint -Path $Current.FullName
    $Acl = Get-PathAcl -Path $Current.FullName
    $OwnerSid = Get-IdentitySidValue -Identity ($Acl.GetOwner([System.Security.Principal.SecurityIdentifier]))
    if ($TrustedAncestorOwnerSids -cnotcontains $OwnerSid) {
      throw "Untrusted owner '$OwnerSid' on ancestor of a LocalSystem runtime path: $($Current.FullName)"
    }
    foreach ($Rule in $Acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      $Sid = $Rule.IdentityReference.Value
      $InheritOnly = ($Rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0
      if ($Rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
          -not $InheritOnly -and
          $TrustedAncestorOwnerSids -cnotcontains $Sid -and
          ([Int64]$Rule.FileSystemRights -band $SubstitutionMask) -ne 0) {
        throw "Untrusted replace/delete ACE '$Sid' on ancestor of a LocalSystem runtime path: $($Current.FullName)"
      }
    }
    $Current = $Current.Parent
  }
}

function Protect-ImmutableRuntimeTree {
  param([string]$Path)
  $Items = [System.Collections.Generic.List[System.IO.FileSystemInfo]]::new()
  $Directories = [System.Collections.Generic.Queue[System.IO.DirectoryInfo]]::new()
  $Root = Get-Item -LiteralPath $Path -Force
  Assert-NotReparsePoint -Path $Root.FullName
  Set-TrustedPathAcl -Path $Root.FullName -Mode Immutable
  Assert-TrustedAncestorChain -Path $Path
  $Items.Add($Root)
  $Directories.Enqueue($Root)
  while ($Directories.Count -gt 0) {
    $Directory = $Directories.Dequeue()
    foreach ($Child in Get-ChildItem -LiteralPath $Directory.FullName -Force) {
      Assert-NotReparsePoint -Path $Child.FullName
      Set-TrustedPathAcl -Path $Child.FullName -Mode Immutable
      $Items.Add($Child)
      if ($Child -is [System.IO.DirectoryInfo]) {
        $Directories.Enqueue($Child)
      }
    }
  }
  foreach ($Item in $Items) { Assert-TrustedPathAcl -Path $Item.FullName -Mode Immutable }
  Assert-TrustedAncestorChain -Path $Path
}

function Get-TrustBoundaryItems {
  param([string]$Path)
  $Items = [System.Collections.Generic.List[System.IO.FileSystemInfo]]::new()
  $Directories = [System.Collections.Generic.Queue[System.IO.DirectoryInfo]]::new()
  $Root = Get-Item -LiteralPath $Path -Force
  Assert-NotReparsePoint -Path $Root.FullName
  $Items.Add($Root)
  $Directories.Enqueue($Root)
  while ($Directories.Count -gt 0) {
    $Directory = $Directories.Dequeue()
    foreach ($Child in Get-ChildItem -LiteralPath $Directory.FullName -Force) {
      Assert-NotReparsePoint -Path $Child.FullName
      $Items.Add($Child)
      if ($Child -is [System.IO.DirectoryInfo]) { $Directories.Enqueue($Child) }
    }
  }
  return $Items
}

function Get-RuntimeReleaseId {
  param(
    [string]$ReleaseVersion,
    [string]$ReleaseCommit
  )
  if ($ReleaseVersion -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw "ReleaseVersion is not a stable three-component semantic version: $ReleaseVersion"
  }
  if ($ReleaseCommit -notmatch '^[0-9a-fA-F]{40,64}$') {
    throw "ReleaseCommit must contain 40 to 64 hexadecimal characters."
  }
  return "$ReleaseVersion-$($ReleaseCommit.Substring(0, 12).ToLowerInvariant())"
}

function Resolve-DeploymentChildPath {
  param(
    [string]$Root,
    [string]$ChildName
  )
  if ([string]::IsNullOrWhiteSpace($ChildName) -or
      $ChildName -in @('.', '..') -or
      $ChildName.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
      $ChildName.Contains('\') -or $ChildName.Contains('/')) {
    throw "Deployment child name is unsafe: $ChildName"
  }
  $RootBoundary = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  if ($RootBoundary -eq [System.IO.Path]::GetPathRoot($RootBoundary).TrimEnd('\', '/')) {
    throw "Deployment root must not be a volume root."
  }
  $Candidate = [System.IO.Path]::GetFullPath((Join-Path $RootBoundary $ChildName))
  if (-not $Candidate.StartsWith($RootBoundary + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Deployment path escapes its releases root: $Candidate"
  }
  return $Candidate
}

function Assert-PathWithinRoot {
  param(
    [string]$Root,
    [string]$Candidate
  )
  $RootBoundary = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $CandidateFullPath = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\', '/')
  if (-not $CandidateFullPath.StartsWith($RootBoundary + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is outside its trusted root: $CandidateFullPath"
  }
  return $CandidateFullPath
}

function Assert-SameVolumePaths {
  param(
    [string]$Left,
    [string]$Right
  )
  $LeftRoot = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Left))
  $RightRoot = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Right))
  if (-not $LeftRoot.Equals($RightRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Staging and final release paths must be on the same volume."
  }
}

function Assert-ReleaseDestinationAvailable {
  param([string]$Path)
  if (Test-Path -LiteralPath $Path) {
    throw "Immutable release destination already exists and will not be overwritten or modified: $Path"
  }
}

function Assert-NoReparseTree {
  param([string]$Path)
  foreach ($Item in @(Get-TrustBoundaryItems -Path $Path)) {
    Assert-NotReparsePoint -Path $Item.FullName
  }
}

function Get-RuntimeServiceBinaryPath {
  param(
    [string]$ReleaseRoot,
    [string]$StateRoot
  )
  $ResolvedReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\', '/')
  $ResolvedStateRoot = [System.IO.Path]::GetFullPath($StateRoot).TrimEnd('\', '/')
  $SupervisorPath = Join-Path $ResolvedReleaseRoot 'service\steel-runtime-supervisor.exe'
  return "`"$SupervisorPath`" --service --root `"$ResolvedReleaseRoot`" --state-root `"$ResolvedStateRoot`""
}

function Read-DeploymentJournal {
  param([string]$Path)
  try {
    $Journal = Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json
  } catch {
    throw "Deployment journal is unreadable or truncated; refusing automatic recovery: $($_.Exception.Message)"
  }
  if ($null -eq $Journal) {
    throw "Deployment journal is empty; refusing automatic recovery."
  }
  return $Journal
}

function Get-DeploymentRecoveryDecision {
  param([object]$Journal)
  $KnownPhases = @(
    'prepared',
    'payload-published',
    'preflight-passed',
    'service-stop-pending',
    'service-stopped',
    'scm-switch-pending',
    'scm-switched',
    'service-start-pending',
    'service-started',
    'service-configured',
    'committed',
    'rolled-back',
    'failed-safe'
  )
  if ($null -eq $Journal -or
      [string]$Journal.schema -cne 'steel.runtime-deployment-transaction.v1' -or
      [string]$Journal.transactionId -notmatch '^[0-9a-f]{32}$' -or
      [string]$Journal.serviceName -cne 'SteelInspectionRuntime' -or
      [string]$Journal.phase -cnotin $KnownPhases) {
    return 'failed-safe'
  }
  if ([string]$Journal.phase -in @('committed', 'rolled-back')) {
    return 'none'
  }
  if ([string]$Journal.phase -ceq 'failed-safe') {
    return 'failed-safe'
  }
  if ($null -eq $Journal.database -or [string]$Journal.database.phase -cne 'not-started') {
    return 'failed-safe'
  }
  if ($null -eq $Journal.rollback -or
      $null -eq $Journal.rollback.service -or
      $null -eq $Journal.rollback.runtimeEnvironment -or
      $null -eq $Journal.rollback.activeDeployment) {
    return 'failed-safe'
  }
  $OldServiceExisted = $Journal.rollback.service.existed
  if ($OldServiceExisted -isnot [bool] -or $Journal.rollback.service.wasRunning -isnot [bool]) {
    return 'failed-safe'
  }
  if ($OldServiceExisted -and
      ($null -eq $Journal.rollback.service.scm -or $null -eq $Journal.rollback.service.registry)) {
    return 'failed-safe'
  }
  if ($OldServiceExisted) {
    $OldScm = $Journal.rollback.service.scm
    if ([string]::IsNullOrWhiteSpace([string]$OldScm.pathName) -or
        [string]$OldScm.startMode -cnotin @('Auto', 'Manual', 'Disabled') -or
        [string]$OldScm.startName -notin @('LocalSystem', 'NT AUTHORITY\SYSTEM') -or
        [string]::IsNullOrWhiteSpace([string]$OldScm.displayName)) {
      return 'failed-safe'
    }
  }
  foreach ($FileSnapshot in @($Journal.rollback.runtimeEnvironment, $Journal.rollback.activeDeployment)) {
    if ($FileSnapshot.existed -isnot [bool] -or
        ($FileSnapshot.existed -and [string]::IsNullOrWhiteSpace([string]$FileSnapshot.backupPath))) {
      return 'failed-safe'
    }
  }
  return 'recover-pre-migration'
}

function ConvertTo-SerializableRegistrySnapshot {
  param([hashtable]$Snapshot)
  $Serializable = [ordered]@{}
  foreach ($Name in @($Snapshot.Keys | Sort-Object)) {
    $Serializable[$Name] = [ordered]@{
      kind = [string]$Snapshot[$Name].Kind
      value = $Snapshot[$Name].Value
    }
  }
  return $Serializable
}

function ConvertFrom-SerializableRegistrySnapshot {
  param([object]$Snapshot)
  $Restored = @{}
  if ($null -eq $Snapshot) { return $Restored }
  foreach ($Property in $Snapshot.PSObject.Properties) {
    $Kind = [string]$Property.Value.kind
    $Value = $Property.Value.value
    $TypedValue = switch ($Kind) {
      'Binary' { [byte[]]@($Value | ForEach-Object { [byte]$_ }) }
      'MultiString' { [string[]]@($Value | ForEach-Object { [string]$_ }) }
      'DWord' { [int]$Value }
      'QWord' { [long]$Value }
      default { $Value }
    }
    $Restored[$Property.Name] = [pscustomobject]@{ Kind = $Kind; Value = $TypedValue }
  }
  return $Restored
}

function Assert-ExistingStateTreeTrust {
  param([string]$Path)
  $Root = Get-Item -LiteralPath $Path -Force
  Assert-NotReparsePoint -Path $Root.FullName
  Assert-TrustedPathAcl -Path $Root.FullName -Mode Mutable
  Assert-TrustedAncestorChain -Path $Root.FullName
  $Items = @(Get-TrustBoundaryItems -Path $Path)
  $RuntimeEnvDirectory = [System.IO.Path]::GetDirectoryName($RuntimeEnvFile)
  $RuntimeEnvAtomicNamePattern = '^\.' + [regex]::Escape([System.IO.Path]::GetFileName($RuntimeEnvFile)) + '\.[0-9a-f]{32}\.(?:tmp|replace\.bak)$'
  foreach ($Item in $Items) {
    if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals($Item.FullName, $Root.FullName)) {
      if ([System.StringComparer]::OrdinalIgnoreCase.Equals($Item.FullName, $RuntimeEnvFile)) {
        Assert-TrustedPathAcl -Path $Item.FullName -Mode PolicyReadOnly
      } elseif ($Item -is [System.IO.FileInfo] -and
                [System.StringComparer]::OrdinalIgnoreCase.Equals($Item.DirectoryName, $RuntimeEnvDirectory) -and
                $Item.Name -match $RuntimeEnvAtomicNamePattern) {
        try {
          Assert-TrustedPathAcl -Path $Item.FullName -Mode PolicyReadOnly
        } catch {
          # A crash can occur before the pre-rename ACL transition. Mutable still
          # means only SYSTEM and Administrators may write within this state root.
          Assert-TrustedPathAcl -Path $Item.FullName -Mode Mutable -AllowInherited
        }
      } else {
        Assert-TrustedPathAcl -Path $Item.FullName -Mode Mutable -AllowInherited
      }
    }
  }
}

function Protect-MutableStateTree {
  param([string]$Path)
  $Root = Get-Item -LiteralPath $Path -Force
  Set-TrustedPathAcl -Path $Root.FullName -Mode Mutable
  foreach ($Item in @(Get-TrustBoundaryItems -Path $Path)) {
    Set-TrustedPathAcl -Path $Item.FullName -Mode Mutable
  }
  foreach ($Item in @(Get-TrustBoundaryItems -Path $Path)) {
    Assert-TrustedPathAcl -Path $Item.FullName -Mode Mutable
  }
  Assert-TrustedAncestorChain -Path $Path
}

function Protect-ExternalPolicyFile {
  param([string]$Path)
  Set-TrustedPathAcl -Path $Path -Mode PolicyReadOnly
  Assert-TrustedPathAcl -Path $Path -Mode PolicyReadOnly
  Assert-TrustedAncestorChain -Path $Path
}

function Get-ServiceRegistrySnapshot {
  param([string]$Path)
  $Snapshot = @{}
  $Key = Get-Item -LiteralPath $Path
  foreach ($Name in $ServiceRegistryValueNames) {
    if ($Key.GetValueNames() -ccontains $Name) {
      $Snapshot[$Name] = [pscustomobject]@{
        Kind = $Key.GetValueKind($Name).ToString()
        Value = $Key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      }
    }
  }
  return $Snapshot
}

function Restore-ServiceRegistrySnapshot {
  param(
    [string]$Path,
    [hashtable]$Snapshot
  )
  foreach ($Name in $ServiceRegistryValueNames) {
    if ($Snapshot.ContainsKey($Name)) {
      $Entry = $Snapshot[$Name]
      New-ItemProperty -LiteralPath $Path -Name $Name -PropertyType $Entry.Kind -Value $Entry.Value -Force | Out-Null
    } else {
      Remove-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction SilentlyContinue
    }
  }
}

function Restore-ExistingServiceConfiguration {
  param(
    [object]$Configuration,
    [hashtable]$RegistrySnapshot,
    [string]$RegistryPath
  )
  $StartMode = switch ([string]$Configuration.StartMode) {
    'Auto' {
      if ($RegistrySnapshot.ContainsKey('DelayedAutoStart') -and [int]$RegistrySnapshot['DelayedAutoStart'].Value -eq 1) {
        'delayed-auto'
      } else {
        'auto'
      }
    }
    'Manual' { 'demand' }
    'Disabled' { 'disabled' }
    default { throw "Cannot restore unsupported service start mode: $($Configuration.StartMode)" }
  }
  Invoke-ScChecked @(
    'config', $ServiceName,
    'binPath=', [string]$Configuration.PathName,
    'start=', $StartMode,
    'obj=', 'LocalSystem',
    'DisplayName=', [string]$Configuration.DisplayName
  ) | Out-Null
  Invoke-ScChecked @('description', $ServiceName, [string]$Configuration.Description) | Out-Null
  $PreviousSidType = if ($RegistrySnapshot.ContainsKey('ServiceSidType')) {
    [int]$RegistrySnapshot['ServiceSidType'].Value
  } else {
    0
  }
  $SidType = switch ($PreviousSidType) {
    0 { 'none' }
    1 { 'unrestricted' }
    3 { 'restricted' }
    default { throw "Cannot restore unsupported service SID type: $PreviousSidType" }
  }
  Invoke-ScChecked @('sidtype', $ServiceName, $SidType) | Out-Null
  $PreviousFailureFlag = if ($RegistrySnapshot.ContainsKey('FailureActionsOnNonCrashFailures')) {
    [int]$RegistrySnapshot['FailureActionsOnNonCrashFailures'].Value
  } else {
    0
  }
  Invoke-ScChecked @('failureflag', $ServiceName, [string]$PreviousFailureFlag) | Out-Null
  Restore-ServiceRegistrySnapshot -Path $RegistryPath -Snapshot $RegistrySnapshot
}

function Write-FileAtomically {
  param(
    [string]$Path,
    [string[]]$Lines
  )
  $Text = ($Lines -join [Environment]::NewLine) + [Environment]::NewLine
  Write-DurableBytesAtomically -Path $Path -Bytes ([System.Text.UTF8Encoding]::new($false).GetBytes($Text)) -AclMode PolicyReadOnly
}

function Write-DurableBytesAtomically {
  param(
    [string]$Path,
    [byte[]]$Bytes,
    [ValidateSet('', 'Mutable', 'PolicyReadOnly')]
    [string]$AclMode = ''
  )
  $Directory = Split-Path -Parent $Path
  $TemporaryPath = Join-Path $Directory ('.' + [System.IO.Path]::GetFileName($Path) + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $ReplacementBackupPath = $null
  try {
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
    if (-not [string]::IsNullOrWhiteSpace($AclMode)) {
      Set-TrustedPathAcl -Path $TemporaryPath -Mode $AclMode
      Assert-TrustedPathAcl -Path $TemporaryPath -Mode $AclMode
    }
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      $ReplacementBackupPath = Join-Path $Directory ('.' + [System.IO.Path]::GetFileName($Path) + '.' + [Guid]::NewGuid().ToString('N') + '.replace.bak')
      [System.IO.File]::Replace($TemporaryPath, $Path, $ReplacementBackupPath, $true)
    } else {
      [System.IO.File]::Move($TemporaryPath, $Path)
    }
    $PersistedBytes = [System.IO.File]::ReadAllBytes($Path)
    if ($PersistedBytes.Length -ne $Bytes.Length) {
      throw "Durable file read-back length mismatch: $Path"
    }
    for ($Index = 0; $Index -lt $Bytes.Length; $Index++) {
      if ($PersistedBytes[$Index] -ne $Bytes[$Index]) {
        throw "Durable file read-back content mismatch: $Path"
      }
    }
    if ($null -ne $ReplacementBackupPath -and (Test-Path -LiteralPath $ReplacementBackupPath -PathType Leaf)) {
      Remove-Item -LiteralPath $ReplacementBackupPath -Force
      $ReplacementBackupPath = $null
    }
  } finally {
    if (Test-Path -LiteralPath $TemporaryPath) {
      Remove-Item -LiteralPath $TemporaryPath -Force
    }
  }
}

function Write-DurableJsonAtomically {
  param(
    [string]$Path,
    [object]$Value
  )
  $Json = $Value | ConvertTo-Json -Depth 32
  $Bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Json + [Environment]::NewLine)
  Write-DurableBytesAtomically -Path $Path -Bytes $Bytes
  try {
    $ReadBack = Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json
  } catch {
    throw "Durable JSON read-back failed for '$Path': $($_.Exception.Message)"
  }
  if ($null -eq $ReadBack) {
    throw "Durable JSON read-back returned null: $Path"
  }
}

function Set-DeploymentJournalPhase {
  param(
    [object]$Journal,
    [string]$Phase,
    [string]$Path,
    [string]$Detail = ''
  )
  $AllowedPhases = @(
    'prepared', 'payload-published', 'preflight-passed', 'service-stop-pending',
    'service-stopped', 'scm-switch-pending', 'scm-switched', 'service-start-pending',
    'service-started', 'service-configured', 'committed', 'rolled-back', 'failed-safe'
  )
  if ($Phase -cnotin $AllowedPhases) {
    throw "Unknown deployment transaction phase: $Phase"
  }
  $Timestamp = [DateTime]::UtcNow.ToString('o')
  $Journal.phase = $Phase
  $Journal.updatedAtUtc = $Timestamp
  $Journal.events = @($Journal.events) + @([pscustomobject]@{
    phase = $Phase
    atUtc = $Timestamp
    detail = $Detail
  })
  Write-DurableJsonAtomically -Path $Path -Value $Journal
}

function Write-DeploymentHistory {
  param(
    [object]$Journal,
    [string]$HistoryRoot
  )
  $HistoryPath = if (-not [string]::IsNullOrWhiteSpace([string]$Journal.historyPath)) {
    Assert-PathWithinRoot -Root $HistoryRoot -Candidate ([string]$Journal.historyPath)
  } else {
    $Timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss.fffffffZ')
    Join-Path $HistoryRoot "$Timestamp-$([string]$Journal.transactionId).json"
  }
  Write-DurableJsonAtomically -Path $HistoryPath -Value $Journal
}

function Restore-DurableFileSnapshot {
  param(
    [object]$Snapshot,
    [string]$DestinationPath,
    [string]$BackupsRoot,
    [ValidateSet('', 'Mutable', 'PolicyReadOnly')]
    [string]$AclMode = ''
  )
  if ($Snapshot.existed -eq $true) {
    $BackupPath = Assert-PathWithinRoot -Root $BackupsRoot -Candidate ([string]$Snapshot.backupPath)
    if (-not (Test-Path -LiteralPath $BackupPath -PathType Leaf)) {
      throw "Required deployment recovery backup is missing: $BackupPath"
    }
    Write-DurableBytesAtomically -Path $DestinationPath -Bytes ([System.IO.File]::ReadAllBytes($BackupPath)) -AclMode $AclMode
  } elseif (Test-Path -LiteralPath $DestinationPath -PathType Leaf) {
    Remove-Item -LiteralPath $DestinationPath -Force
  }
}

function Invoke-PreMigrationDeploymentRecovery {
  param(
    [object]$Journal,
    [string]$JournalPath,
    [string]$HistoryRoot,
    [string]$BackupsRoot,
    [string]$RuntimeEnvironmentPath,
    [string]$ActivePath,
    [string]$RegistryPath
  )
  if ((Get-DeploymentRecoveryDecision -Journal $Journal) -cne 'recover-pre-migration') {
    throw "Deployment journal does not prove that pre-migration recovery is safe."
  }

  $OldService = $Journal.rollback.service
  $CurrentService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($OldService.existed -eq $true) {
    if (-not $CurrentService) {
      throw "Cannot recover the previous SCM configuration because the service is missing."
    }
    $RegistrySnapshot = ConvertFrom-SerializableRegistrySnapshot -Snapshot $OldService.registry
  }
  foreach ($FileSnapshot in @($Journal.rollback.runtimeEnvironment, $Journal.rollback.activeDeployment)) {
    if ($FileSnapshot.existed -eq $true) {
      $RequiredBackupPath = Assert-PathWithinRoot -Root $BackupsRoot -Candidate ([string]$FileSnapshot.backupPath)
      if (-not (Test-Path -LiteralPath $RequiredBackupPath -PathType Leaf)) {
        throw "Required deployment recovery backup is missing: $RequiredBackupPath"
      }
      Assert-NotReparsePoint -Path $RequiredBackupPath
    }
  }

  Restore-DurableFileSnapshot -Snapshot $Journal.rollback.runtimeEnvironment -DestinationPath $RuntimeEnvironmentPath -BackupsRoot $BackupsRoot -AclMode PolicyReadOnly
  Restore-DurableFileSnapshot -Snapshot $Journal.rollback.activeDeployment -DestinationPath $ActivePath -BackupsRoot $BackupsRoot

  if ($OldService.existed -eq $true) {
    if ($CurrentService -and $CurrentService.Status -ne 'Stopped') {
      Stop-Service -Name $ServiceName -Force
      (Get-Service -Name $ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(120))
    }
    $Configuration = [pscustomobject]@{
      PathName = [string]$OldService.scm.pathName
      StartMode = [string]$OldService.scm.startMode
      StartName = [string]$OldService.scm.startName
      DisplayName = [string]$OldService.scm.displayName
      Description = [string]$OldService.scm.description
    }
    Restore-ExistingServiceConfiguration -Configuration $Configuration -RegistrySnapshot $RegistrySnapshot -RegistryPath $RegistryPath
    if ($OldService.wasRunning -eq $true) {
      Start-Service -Name $ServiceName
      (Get-Service -Name $ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(120))
    }
  } elseif ([string]$Journal.phase -in @('scm-switch-pending', 'scm-switched', 'service-start-pending', 'service-started', 'service-configured')) {
    if ($CurrentService -and $CurrentService.Status -ne 'Stopped') {
      Stop-Service -Name $ServiceName -Force
      (Get-Service -Name $ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(120))
    }
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
      Invoke-ScChecked @('delete', $ServiceName) | Out-Null
      Wait-ServiceAbsent
    }
  }

  if (Test-Path -LiteralPath $RuntimeEnvironmentPath -PathType Leaf) {
    Set-TrustedPathAcl -Path $RuntimeEnvironmentPath -Mode PolicyReadOnly
    Assert-TrustedPathAcl -Path $RuntimeEnvironmentPath -Mode PolicyReadOnly
  }
  Set-DeploymentJournalPhase -Journal $Journal -Phase 'rolled-back' -Path $JournalPath -Detail 'Recovered the prior SCM, environment, active deployment, and running state before any database migration.'
  Write-DeploymentHistory -Journal $Journal -HistoryRoot $HistoryRoot
}

function Wait-ServiceAbsent {
  param([int]$TimeoutSeconds = 120)
  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ((Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $Deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    throw "Timed out waiting for service $ServiceName to be deleted."
  }
}

function Assert-ReleasePackageIntegrity {
  param(
    [string]$Root,
    [object]$Manifest,
    [string]$FirstPartyThumbprint,
    [System.Collections.Generic.HashSet[string]]$VendorSignerThumbprints
  )

  $Root = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $CatalogPath = Join-Path $Root 'release-integrity.cat'

  $DeclaredChecksumExcludes = @($Manifest.integrity.checksumExcludes)
  $ChecksumExcludesAreExact =
    $DeclaredChecksumExcludes.Count -eq 2 -and
    @($DeclaredChecksumExcludes | Where-Object { [string]$_ -ceq 'checksums.sha256' }).Count -eq 1 -and
    @($DeclaredChecksumExcludes | Where-Object { [string]$_ -ceq 'release-integrity.cat' }).Count -eq 1
  if ([string]$Manifest.packageClass -cne 'formal-release' -or
      $Manifest.build.desktopBundleIncluded -ne $true -or
      $Manifest.build.performed -ne $true -or
      [string]$Manifest.build.provenance -cne 'built-in-this-invocation' -or
      [string]$Manifest.build.sourceCommit -cne [string]$Manifest.source.gitCommit -or
      [string]$Manifest.integrity.checksumAlgorithm -cne 'sha256' -or
      [string]$Manifest.integrity.checksumInventory -cne 'checksums.sha256' -or
      -not $ChecksumExcludesAreExact -or
      [string]$Manifest.integrity.algorithm -cne 'windows-file-catalog-sha256' -or
      [string]$Manifest.integrity.catalog -cne 'release-integrity.cat' -or
      [int]$Manifest.integrity.catalogVersion -ne 2 -or
      $Manifest.integrity.timestampRequired -ne $true) {
    throw 'Windows service installation requires a formal desktop-inclusive package with a signed SHA-256 file catalog.'
  }
  if (-not (Test-Path -LiteralPath $CatalogPath -PathType Leaf)) {
    throw "Missing signed release package catalog: $CatalogPath"
  }
  $CatalogSignature = Get-AuthenticodeSignature -LiteralPath $CatalogPath
  if ($CatalogSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
      $null -eq $CatalogSignature.TimeStamperCertificate) {
    throw "Release package catalog signature or trusted timestamp is invalid: $($CatalogSignature.Status)"
  }
  $ExpectedRuntimePaths = @(
    'service/steel-capture-service.exe',
    'service/steel-runtime-supervisor.exe',
    'service/steel-inspection-service.exe',
    'service/steel-trigger-gateway.exe',
    'service/steel-image-service.exe',
    'service/steel-image-worker.exe',
    'service/steel-defect-worker.exe',
    'service/steel-inspection-tray.exe',
    'algorithm-core/steel_bar_surface_core.exe'
  )
  $RuntimeEvidence = @($Manifest.service.signatures)
  if ($RuntimeEvidence.Count -ne $ExpectedRuntimePaths.Count) {
    throw 'Formal package runtime signature evidence is incomplete.'
  }
  foreach ($RelativePath in $ExpectedRuntimePaths) {
    if (@($RuntimeEvidence | Where-Object { [string]$_.path -ceq $RelativePath }).Count -ne 1) {
      throw "Formal package runtime signature evidence is missing or duplicated: $RelativePath"
    }
    $ArtifactPath = [System.IO.Path]::GetFullPath((Join-Path $Root ($RelativePath -replace '/', '\')))
    if (-not $ArtifactPath.StartsWith($Root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $ArtifactPath -PathType Leaf)) {
      throw "Signed runtime artifact is missing or outside RuntimeRoot: $RelativePath"
    }
    $Signature = Get-AuthenticodeSignature -LiteralPath $ArtifactPath
    if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
        $null -eq $Signature.TimeStamperCertificate) {
      throw "Runtime artifact signature or trusted timestamp is invalid: $RelativePath ($($Signature.Status))"
    }
    $ArtifactSignerThumbprint = ([string]$Signature.SignerCertificate.Thumbprint).ToUpperInvariant()
    if ($ArtifactSignerThumbprint -cne $FirstPartyThumbprint) {
      throw "First-party runtime signer does not match ExpectedFirstPartyThumbprint: $RelativePath"
    }
  }
  if (([string]$CatalogSignature.SignerCertificate.Thumbprint).ToUpperInvariant() -cne $FirstPartyThumbprint) {
    throw 'Release integrity catalog signer does not match ExpectedFirstPartyThumbprint.'
  }
  $CatalogValidation = Test-FileCatalog -Path $Root -CatalogFilePath $CatalogPath -Detailed
  if ([string]$CatalogValidation.Status -ne 'Valid' -or [string]$CatalogValidation.HashAlgorithm -ne 'SHA256') {
    throw "Release integrity catalog does not match the complete runtime package: $($CatalogValidation.Status)"
  }
}

if (-not (Test-Path -LiteralPath $Supervisor -PathType Leaf)) {
  throw "Missing runtime supervisor: $Supervisor"
}
foreach ($RequiredFile in @($AlgorithmConfig, $AlgorithmCalibrationTemplate, $AlgorithmScript, $SickCaptureScript, $SickAlgorithmScript, $AlgorithmCore, $AlgorithmAcceptanceValidator, $DatabaseContractValidator, $PackageManifestPath, $IntegrityCatalogPath, $SickCaptureProfile, $PythonExecutable)) {
  if (-not (Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
    throw "Missing immutable runtime release dependency: $RequiredFile"
  }
}
if (-not (Test-Path -LiteralPath $SickCapturePackage -PathType Container)) {
  throw "Missing packaged SICK capture Python package: $SickCapturePackage"
}
$SickProfilePayload = Get-Content -LiteralPath $SickCaptureProfile -Raw -Encoding utf8 | ConvertFrom-Json
if ([string]$SickProfilePayload.schema -cnotin @('steel.capture.profile.v1', 'steel.capture.profile.v2') -or
    [string]$SickProfilePayload.driverMode -cne 'sick-gentl' -or
    [int]$SickProfilePayload.expectedCameras -le 0) {
  throw 'SickCaptureProfile must describe a non-empty steel.capture.profile SICK GenTL camera set.'
}
if ($SickProfilePayload.captureDefaults.defectDetectionEnabled -ne $true) {
  throw 'The formal real-camera profile must enable defect detection.'
}
$RequiredSickProfileFiles = @(
  [string]$SickProfilePayload.sick.ctiPath,
  [string]$SickProfilePayload.captureDefaults.arrayCalibrationPath,
  [string]$SickProfilePayload.captureDefaults.defectModelManifestPath,
  [string]$SickProfilePayload.captureDefaults.defectModel2dPath,
  [string]$SickProfilePayload.captureDefaults.defectModel3dPath,
  [string]$SickProfilePayload.captureDefaults.defectClassifier2dPath,
  [string]$SickProfilePayload.captureDefaults.defectClassifier3dPath
)
foreach ($ProfileFile in $RequiredSickProfileFiles) {
  if ([string]::IsNullOrWhiteSpace($ProfileFile) -or
      -not [System.IO.Path]::IsPathRooted($ProfileFile) -or
      -not (Test-Path -LiteralPath $ProfileFile -PathType Leaf)) {
    throw "Every formal SICK CTI, calibration, and defect-model path must be an existing absolute file: $ProfileFile"
  }
}
$SickCtiPath = [string]$SickProfilePayload.sick.ctiPath
$SickCtiSignature = Get-AuthenticodeSignature -LiteralPath $SickCtiPath
if ($SickCtiSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
    $null -eq $SickCtiSignature.SignerCertificate -or
    -not $NormalizedVendorSignerThumbprints.Contains(([string]$SickCtiSignature.SignerCertificate.Thumbprint).ToUpperInvariant())) {
  throw 'The formal SICK GenTL CTI must have a valid Authenticode signature from the out-of-band vendor signer allowlist.'
}
foreach ($Camera in @($SickProfilePayload.cameras)) {
  $CameraStorage = [string]$Camera.storageRoot
  if ([string]::IsNullOrWhiteSpace($CameraStorage) -or
      -not [System.IO.Path]::IsPathRooted($CameraStorage) -or
      -not (Test-Path -LiteralPath $CameraStorage -PathType Container)) {
    throw "Every formal SICK camera storageRoot must be an existing absolute directory: $CameraStorage"
  }
}
$PreviousPythonPath = $env:PYTHONPATH
try {
  $env:PYTHONPATH = Join-Path $SourcePackageRoot 'scripts'
  & $PythonExecutable -c 'import sys, harvesters, numpy, PIL, onnxruntime; from sick_capture.profile import load_profile; load_profile(sys.argv[1])' $SickCaptureProfile 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw 'PythonExecutable does not provide the required SICK capture and defect runtime modules.'
  }
} finally {
  if ($null -eq $PreviousPythonPath) { Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue } else { $env:PYTHONPATH = $PreviousPythonPath }
}
if ($StorageMinFreePercent -le 0 -or $StorageMinFreePercent -gt 100) {
  throw "StorageMinFreePercent must be within (0, 100]."
}
if ([string]::IsNullOrWhiteSpace($ArtifactAllowedRoots)) {
  throw "ArtifactAllowedRoots is required."
}
$NormalizedStorageRoots = @()
foreach ($StoragePath in @($StorageRoot, $CameraStorageRoot)) {
  $ExpandedStoragePath = [Environment]::ExpandEnvironmentVariables($StoragePath)
  if ([string]::IsNullOrWhiteSpace($ExpandedStoragePath) -or -not [System.IO.Path]::IsPathRooted($ExpandedStoragePath)) {
    throw "Storage roots must be absolute non-empty paths: $StoragePath"
  }
  $NormalizedStoragePath = [System.IO.Path]::GetFullPath($ExpandedStoragePath)
  if (-not (Test-Path -LiteralPath $NormalizedStoragePath -PathType Container)) {
    throw "Storage root must already exist: $ExpandedStoragePath"
  }
  $NormalizedStorageRoots += $NormalizedStoragePath
}
$StorageRoot = $NormalizedStorageRoots[0]
$CameraStorageRoot = $NormalizedStorageRoots[1]
$AlgorithmDataRoot = [System.IO.Path]::GetFullPath((Join-Path $StorageRoot 'reconstruction')).TrimEnd('\', '/')
$NormalizedArtifactRoots = @()
foreach ($Root in [Environment]::ExpandEnvironmentVariables($ArtifactAllowedRoots).Split(';')) {
  if ([string]::IsNullOrWhiteSpace($Root) -or -not [System.IO.Path]::IsPathRooted($Root)) {
    throw "Every artifact allowed root must be an absolute non-empty path."
  }
  $Full = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  if ($Full -eq [System.IO.Path]::GetPathRoot($Full).TrimEnd('\', '/')) {
    throw "Drive roots are forbidden in ArtifactAllowedRoots: $Root"
  }
  if (-not (Test-Path -LiteralPath $Full -PathType Container) -and
      -not $Full.Equals($AlgorithmDataRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Artifact allowed root must already exist: $Full"
  }
  $NormalizedArtifactRoots += $Full
}
$AlgorithmRootAllowed = $NormalizedArtifactRoots | Where-Object {
  $AlgorithmDataRoot.Equals($_, [System.StringComparison]::OrdinalIgnoreCase) -or
    $AlgorithmDataRoot.StartsWith($_ + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}
if (-not $AlgorithmRootAllowed) {
  $NormalizedArtifactRoots += $AlgorithmDataRoot
}
$ArtifactAllowedRoots = $NormalizedArtifactRoots -join ';'
$DeploymentWriteRoots = @($StorageRoot, $CameraStorageRoot, $AlgorithmDataRoot) + $NormalizedArtifactRoots
# Capture storage, camera storage, and artifact roots are one LocalSystem-managed
# production-data trust domain and may intentionally overlap each other. They
# must remain disjoint from package, state, secret, and acceptance-policy paths.
$ProtectedControlPaths = @(
  [pscustomobject]@{ Name = 'SourcePackageRoot'; Path = $SourcePackageRoot },
  [pscustomobject]@{ Name = 'InstallRoot'; Path = $InstallRoot },
  [pscustomobject]@{ Name = 'StateRoot'; Path = $StateRoot },
  [pscustomobject]@{ Name = 'SecretEnvFile'; Path = $SecretEnvFile },
  [pscustomobject]@{ Name = 'AlgorithmAcceptanceReport'; Path = $AlgorithmAcceptanceReport }
)
foreach ($DeploymentWriteRoot in $DeploymentWriteRoots) {
  foreach ($ProtectedControlPath in $ProtectedControlPaths) {
    if (Test-PathsOverlap -Left $ProtectedControlPath.Path -Right $DeploymentWriteRoot) {
      throw "Deployment storage and artifact roots must not overlap protected runtime, state, secret, or acceptance paths: $DeploymentWriteRoot overlaps $($ProtectedControlPath.Name)=$($ProtectedControlPath.Path)"
    }
  }
}
if (Test-Path -LiteralPath $AlgorithmDataRoot) {
  if (-not (Test-Path -LiteralPath $AlgorithmDataRoot -PathType Container)) {
    throw "Algorithm data root exists but is not a directory: $AlgorithmDataRoot"
  }
} else {
  New-Item -ItemType Directory -Path $AlgorithmDataRoot | Out-Null
}
Set-TrustedPathAcl -Path $AlgorithmDataRoot -Mode Mutable
Assert-TrustedPathAcl -Path $AlgorithmDataRoot -Mode Mutable

Assert-Administrator
$DeploymentMutex = [System.Threading.Mutex]::new($false, 'Global\SteelInspectionRuntime-Deployment')
$DeploymentMutexAcquired = $false
try {
  try {
    $DeploymentMutexAcquired = $DeploymentMutex.WaitOne([TimeSpan]::FromSeconds(30))
  } catch [System.Threading.AbandonedMutexException] {
    $DeploymentMutexAcquired = $true
  }
  if (-not $DeploymentMutexAcquired) {
    throw 'Another SteelInspectionRuntime deployment transaction holds the global deployment mutex.'
  }

Assert-NoReparseTree -Path $SourcePackageRoot
$PackageManifest = Get-Content -LiteralPath $PackageManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
if ([string]$PackageManifest.schema -ne 'steel.runtime-package.v1' -or
    $PackageManifest.source.dirty -ne $false -or
    [string]$PackageManifest.build.captureConfiguration -cne 'Release' -or
    [string]$PackageManifest.build.rustProfile -cne 'release') {
  throw "Windows service installation requires a clean Release steel.runtime-package.v1 package."
}
$ReleaseCommit = [string]$PackageManifest.source.gitCommit
if ($ReleaseCommit -notmatch '^[0-9a-fA-F]{40,64}$') {
  throw "Runtime package manifest is missing an exact release commit."
}
$ReleaseCommit = $ReleaseCommit.ToLowerInvariant()
$ReleaseVersion = [string]$PackageManifest.releaseVersion
$SemVerPattern = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
if ($ReleaseVersion -notmatch $SemVerPattern -or
    ([int]$Matches[1] -eq 0 -and [int]$Matches[2] -eq 1 -and [int]$Matches[3] -eq 0) -or
    [string]$PackageManifest.desktop.version -cne $ReleaseVersion -or
    [string]$PackageManifest.source.gitTag -cnotin @($ReleaseVersion, "v$ReleaseVersion")) {
  throw "Runtime package releaseVersion must be a non-placeholder stable semantic version bound to desktop.version and its exact Git tag."
}
Assert-ReleasePackageIntegrity -Manifest $PackageManifest -Root $SourcePackageRoot -FirstPartyThumbprint $ExpectedFirstPartyThumbprint -VendorSignerThumbprints $NormalizedVendorSignerThumbprints
$DatabaseContractReportText = (& $DatabaseContractValidator `
  -PackageRoot $SourcePackageRoot `
  -ManifestPath $PackageManifestPath | Out-String)
try {
  $DatabaseContractReport = $DatabaseContractReportText | ConvertFrom-Json
} catch {
  throw 'The catalog-verified database contract validator did not return valid JSON.'
}
if ([string]$DatabaseContractReport.schema -cne 'steel.database-contract-verification.v1' -or
    [int]$DatabaseContractReport.code -ne 0 -or
    [string]$DatabaseContractReport.mode -cne 'package' -or
    [long]$DatabaseContractReport.schemaVersion -ne [long]$PackageManifest.database.schemaVersion -or
    [string]$DatabaseContractReport.contractSha256 -cne [string]$PackageManifest.database.contractSha256 -or
    [string]$DatabaseContractReport.migrationIndexSha256 -cne [string]$PackageManifest.database.migrationIndexSha256 -or
    @($DatabaseContractReport.engines).Count -ne 2 -or
    [string]$DatabaseContractReport.engines[0] -cne 'sqlite' -or
    [string]$DatabaseContractReport.engines[1] -cne 'mysql') {
  throw 'The catalog-verified database contract does not match manifest.json.'
}
if ([int]$DatabaseContractReport.migrationCount -ne 0) {
  throw 'This installer does not yet execute database migrations; packages with a non-empty migration index are rejected before any deployment state is changed.'
}

if (Test-Path -LiteralPath $InstallRoot) {
  if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) {
    throw "InstallRoot exists but is not a directory: $InstallRoot"
  }
  Assert-NotReparsePoint -Path $InstallRoot
  Assert-TrustedPathAcl -Path $InstallRoot -Mode Mutable
} else {
  $InstallParent = Split-Path -Parent $InstallRoot
  if (-not (Test-Path -LiteralPath $InstallParent -PathType Container)) {
    throw "InstallRoot parent must already exist and be administrator-managed: $InstallParent"
  }
  Assert-NotReparsePoint -Path $InstallParent
  Assert-TrustedAncestorChain -Path $InstallParent -IncludeSelf
  New-Item -ItemType Directory -Path $InstallRoot | Out-Null
  Set-TrustedPathAcl -Path $InstallRoot -Mode Mutable
  Assert-TrustedPathAcl -Path $InstallRoot -Mode Mutable
}
if (Test-Path -LiteralPath $ReleasesRoot) {
  if (-not (Test-Path -LiteralPath $ReleasesRoot -PathType Container)) {
    throw "ReleasesRoot exists but is not a directory: $ReleasesRoot"
  }
  Assert-NotReparsePoint -Path $ReleasesRoot
  Assert-TrustedPathAcl -Path $ReleasesRoot -Mode Mutable
} else {
  New-Item -ItemType Directory -Path $ReleasesRoot | Out-Null
  Set-TrustedPathAcl -Path $ReleasesRoot -Mode Mutable
  Assert-TrustedPathAcl -Path $ReleasesRoot -Mode Mutable
}
Assert-TrustedAncestorChain -Path $ReleasesRoot -IncludeSelf

$StateRootExisted = Test-Path -LiteralPath $StateRoot
if ($StateRootExisted) {
  if (-not (Test-Path -LiteralPath $StateRoot -PathType Container)) {
    throw "StateRoot exists but is not a directory: $StateRoot"
  }
  Assert-ExistingStateTreeTrust -Path $StateRoot
} else {
  $StateParent = Split-Path -Parent $StateRoot
  if (-not (Test-Path -LiteralPath $StateParent -PathType Container)) {
    throw "StateRoot parent must already exist and be administrator-managed: $StateParent"
  }
  Assert-NotReparsePoint -Path $StateParent
  Assert-TrustedAncestorChain -Path $StateParent -IncludeSelf
  New-Item -ItemType Directory -Path $StateRoot | Out-Null
  Set-TrustedPathAcl -Path $StateRoot -Mode Mutable
  Assert-TrustedPathAcl -Path $StateRoot -Mode Mutable
  Assert-TrustedAncestorChain -Path $StateRoot
}

$RequiredStateDirectories = @(
  $StateConfigDir,
  $StateServiceDir,
  $StateLogsDir,
  $StateDeploymentDir,
  $DeploymentHistoryDir,
  $DeploymentBackupsDir,
  (Join-Path $StateRoot 'temp'),
  (Join-Path $StateRoot 'work'),
  (Join-Path $StateRoot 'work\capture'),
  (Join-Path $StateRoot 'work\trigger'),
  (Join-Path $StateRoot 'work\service'),
  (Join-Path $StateRoot 'work\image'),
  (Join-Path $StateRoot 'work\image-worker'),
  (Join-Path $StateRoot 'work\defect-worker'),
  (Join-Path $StateRoot 'result-data'),
  (Join-Path $StateRoot 'algorithm-input')
)
foreach ($Directory in $RequiredStateDirectories) {
  if (Test-Path -LiteralPath $Directory) {
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
      throw "Mutable runtime state path is not a directory: $Directory"
    }
  } else {
    New-Item -ItemType Directory -Path $Directory | Out-Null
    Set-TrustedPathAcl -Path $Directory -Mode Mutable
    Assert-TrustedPathAcl -Path $Directory -Mode Mutable
  }
}
$CaptureConfigSeeded = $false
if (-not (Test-Path -LiteralPath $StateCaptureConfigDir)) {
  Copy-Item -LiteralPath $CaptureConfigTemplate -Destination $StateCaptureConfigDir -Recurse
  $CaptureConfigSeeded = $true
} elseif (-not (Test-Path -LiteralPath $StateCaptureConfigDir -PathType Container)) {
  throw "Mutable capture config path is not a directory: $StateCaptureConfigDir"
}
if (-not $StateRootExisted) {
  Protect-MutableStateTree -Path $StateRoot
} elseif ($CaptureConfigSeeded) {
  Protect-MutableStateTree -Path $StateCaptureConfigDir
}
Assert-ExistingStateTreeTrust -Path $StateRoot
if (-not (Test-Path -LiteralPath $AlgorithmCalibration -PathType Leaf)) {
  throw "Mutable StateRoot is missing the qualified production calibration: $AlgorithmCalibration"
}
if (Test-Path -LiteralPath $InstalledSickCaptureProfile -PathType Leaf) {
  Set-TrustedPathAcl -Path $InstalledSickCaptureProfile -Mode Mutable
}
Copy-Item -LiteralPath $SickCaptureProfile -Destination $InstalledSickCaptureProfile -Force
Set-TrustedPathAcl -Path $InstalledSickCaptureProfile -Mode PolicyReadOnly
Assert-TrustedPathAcl -Path $InstalledSickCaptureProfile -Mode PolicyReadOnly
$RuntimeEnvAtomicNamePattern = '^\.' + [regex]::Escape([System.IO.Path]::GetFileName($RuntimeEnvFile)) + '\.[0-9a-f]{32}\.(?:tmp|replace\.bak)$'
foreach ($AtomicArtifact in @(Get-ChildItem -LiteralPath $StateConfigDir -File -Force | Where-Object { $_.Name -match $RuntimeEnvAtomicNamePattern })) {
  Assert-NotReparsePoint -Path $AtomicArtifact.FullName
  Remove-Item -LiteralPath $AtomicArtifact.FullName -Force
}

$RegistryPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
$ServiceBeforeRecovery = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($ServiceBeforeRecovery) {
  $RegisteredServiceState = Get-ItemProperty -LiteralPath $RegistryPath -ErrorAction Stop
  $RegisteredStateRoot = [string]$RegisteredServiceState.SteelStateRoot
  if (-not [string]::IsNullOrWhiteSpace($RegisteredStateRoot)) {
    $RegisteredStateRoot = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($RegisteredStateRoot)).TrimEnd('\', '/')
    if (-not $RegisteredStateRoot.Equals($StateRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "StateRoot differs from the service's registered deployment state. Retry with StateRoot '$RegisteredStateRoot'."
    }
  } else {
    $ServiceConfigurationBeforeRecovery = Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceName'"
    $ExpectedStateArgument = "--state-root `"$StateRoot`""
    if ($null -eq $ServiceConfigurationBeforeRecovery -or
        ([string]$ServiceConfigurationBeforeRecovery.PathName).IndexOf($ExpectedStateArgument, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
      throw 'The existing service does not prove which StateRoot owns its deployment journal; refusing deployment.'
    }
  }
  $RegisteredInstallRoot = [string]$RegisteredServiceState.SteelInstallRoot
  if (-not [string]::IsNullOrWhiteSpace($RegisteredInstallRoot)) {
    $RegisteredInstallRoot = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($RegisteredInstallRoot)).TrimEnd('\', '/')
    if (-not $RegisteredInstallRoot.Equals($InstallRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "InstallRoot differs from the registered versioned deployment root. Retry with InstallRoot '$RegisteredInstallRoot'."
    }
  }
}
if (Test-Path -LiteralPath $DeploymentJournalPath -PathType Leaf) {
  # This phase only supports recovery before database migration. A later DB
  # migration implementation must extend the journal/recovery contract first.
  $PreviousJournal = Read-DeploymentJournal -Path $DeploymentJournalPath
  $RecoveryDecision = Get-DeploymentRecoveryDecision -Journal $PreviousJournal
  if ($RecoveryDecision -ceq 'recover-pre-migration') {
    try {
      Invoke-PreMigrationDeploymentRecovery `
        -Journal $PreviousJournal `
        -JournalPath $DeploymentJournalPath `
        -HistoryRoot $DeploymentHistoryDir `
        -BackupsRoot $DeploymentBackupsDir `
        -RuntimeEnvironmentPath $RuntimeEnvFile `
        -ActivePath $ActiveDeploymentPath `
        -RegistryPath $RegistryPath
    } catch {
      $RecoveryError = $_
      try {
        Set-DeploymentJournalPhase -Journal $PreviousJournal -Phase 'failed-safe' -Path $DeploymentJournalPath -Detail "Automatic recovery failed: $($RecoveryError.Exception.Message)"
        Write-DeploymentHistory -Journal $PreviousJournal -HistoryRoot $DeploymentHistoryDir
      } catch {
        # Preserve the original recovery error; a malformed/unwritable journal is itself failed-safe.
      }
      throw "An incomplete deployment was detected, but the prior service state could not be safely restored: $($RecoveryError.Exception.Message)"
    }
  } elseif ($RecoveryDecision -ceq 'failed-safe') {
    if ([string]$PreviousJournal.schema -ceq 'steel.runtime-deployment-transaction.v1' -and
        [string]$PreviousJournal.transactionId -match '^[0-9a-f]{32}$' -and
        $PreviousJournal.PSObject.Properties.Name -ccontains 'events' -and
        [string]$PreviousJournal.phase -notin @('committed', 'rolled-back', 'failed-safe')) {
      try {
        Set-DeploymentJournalPhase -Journal $PreviousJournal -Phase 'failed-safe' -Path $DeploymentJournalPath -Detail 'Automatic rollback was refused because the journal did not prove a pre-migration state with complete rollback inputs.'
        Write-DeploymentHistory -Journal $PreviousJournal -HistoryRoot $DeploymentHistoryDir
      } catch {
        # Preserve and report the original fail-safe condition even if audit persistence also fails.
      }
    }
    throw 'An incomplete deployment journal cannot prove that the database is still pre-migration or that rollback inputs are complete. No SCM, environment, registry, or service-state change was attempted.'
  } elseif ([string]$PreviousJournal.phase -in @('committed', 'rolled-back') -and
            -not [string]::IsNullOrWhiteSpace([string]$PreviousJournal.historyPath)) {
    $ExpectedHistoryPath = Assert-PathWithinRoot -Root $DeploymentHistoryDir -Candidate ([string]$PreviousJournal.historyPath)
    if (-not (Test-Path -LiteralPath $ExpectedHistoryPath -PathType Leaf)) {
      Write-DeploymentHistory -Journal $PreviousJournal -HistoryRoot $DeploymentHistoryDir
    }
  }
}

$Existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($Existing -and -not $Upgrade) {
  throw "Service $ServiceName already exists. Use -Upgrade for an intentional versioned deployment."
}
$ValidatedPriorActiveBytes = $null
$PreviousActiveDeployment = $null
$PriorActiveDeploymentExists = Test-Path -LiteralPath $ActiveDeploymentPath -PathType Leaf
if ($Existing -and -not $PriorActiveDeploymentExists) {
  throw 'An existing service has no active deployment receipt; database schema compatibility cannot be proven before upgrade.'
}
if ($PriorActiveDeploymentExists) {
  try {
    $ValidatedPriorActiveBytes = [System.IO.File]::ReadAllBytes($ActiveDeploymentPath)
    $PreviousActiveDeployment = ([System.Text.UTF8Encoding]::new($false).GetString($ValidatedPriorActiveBytes) | ConvertFrom-Json)
  } catch {
    throw 'The prior active deployment receipt is not valid JSON; database schema compatibility cannot be proven before deployment.'
  }
  if ([string]$PreviousActiveDeployment.schema -cne 'steel.runtime-active-deployment.v1' -or
      $PreviousActiveDeployment.PSObject.Properties.Name -cnotcontains 'database' -or
      $null -eq $PreviousActiveDeployment.database -or
      $PreviousActiveDeployment.database.PSObject.Properties.Name -cnotcontains 'schemaVersion' -or
      [long]$PreviousActiveDeployment.database.schemaVersion -ne [long]$DatabaseContractReport.schemaVersion) {
    throw 'The prior active deployment receipt does not prove the same database schema version required by this migration-free installer.'
  }
}

Protect-ExternalPolicyFile -Path $SecretEnvFile
if ([System.StringComparer]::OrdinalIgnoreCase.Equals($AlgorithmAcceptanceReport, $SecretEnvFile) -eq $false) {
  Protect-ExternalPolicyFile -Path $AlgorithmAcceptanceReport
}
$SecretNames = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::Ordinal)
foreach ($Line in Get-Content -LiteralPath $SecretEnvFile -Encoding utf8) {
  $Text = $Line.Trim()
  if (-not $Text -or $Text.StartsWith('#')) { continue }
  if ($Text -notmatch '^([A-Za-z0-9_]+)=(.*)$') {
    throw "Malformed secret environment line; expected KEY=VALUE."
  }
  if ($SecretNames.ContainsKey($Matches[1])) {
    throw "Duplicate secret environment key: $($Matches[1])"
  }
  if ($AllowedSecretNames -cnotcontains $Matches[1] -and $Matches[1] -notlike 'STEEL_BKV_*') {
    throw "Secret environment key is not allowed: $($Matches[1])"
  }
  $SecretNames[$Matches[1]] = $Matches[2].Trim()
}
$AcceptanceValidationJson = & $AlgorithmAcceptanceValidator -ReportPath $AlgorithmAcceptanceReport -ConfigPath $AlgorithmConfig -CalibrationPath $AlgorithmCalibration -ScriptPath $AlgorithmScript -CorePath $AlgorithmCore -ReleaseCommit $ReleaseCommit
$AcceptanceValidation = $AcceptanceValidationJson | ConvertFrom-Json
if ([string]$AcceptanceValidation.schema -cne 'steel.algorithm-acceptance.audit.v1' -or [int]$AcceptanceValidation.code -ne 0) {
  throw "Algorithm acceptance validator did not return a passing steel.algorithm-acceptance.audit.v1 result."
}
foreach ($RequiredSecret in @('TRIGGER_SHARED_SECRET', 'TRIGGER_OPERATOR_TOKEN')) {
  if (-not $SecretNames.ContainsKey($RequiredSecret)) {
    throw "Secret environment file must define $RequiredSecret."
  }
  $SecretValue = [string]$SecretNames[$RequiredSecret]
  if ($SecretValue.Length -lt 32 -or [Text.Encoding]::UTF8.GetByteCount($SecretValue) -lt 32) {
    throw "$RequiredSecret must contain at least 32 characters and 32 UTF-8 bytes after trimming."
  }
}
if ($SecretNames['TRIGGER_SHARED_SECRET'] -ceq $SecretNames['TRIGGER_OPERATOR_TOKEN']) {
  throw "TRIGGER_SHARED_SECRET and TRIGGER_OPERATOR_TOKEN must be different values."
}
if ($SecretNames.ContainsKey('STEEL_DATABASE_URL') -and
    [string]$SecretNames['STEEL_DATABASE_URL'] -match '^sqlite(?::|$)') {
  throw "STEEL_DATABASE_URL must not override managed SQLite; omit it so SQLite remains under StateRoot, or use an external database."
}
Set-BoundedServiceFailureActions -Name $ServiceName -InitializeOnly

$RuntimeEnvPreviouslyExisted = Test-Path -LiteralPath $RuntimeEnvFile -PathType Leaf
$PreviousRuntimeEnvBytes = if ($RuntimeEnvPreviouslyExisted) {
  [System.IO.File]::ReadAllBytes($RuntimeEnvFile)
} else {
  $null
}
$ActiveDeploymentPreviouslyExisted = Test-Path -LiteralPath $ActiveDeploymentPath -PathType Leaf
$PreviousActiveDeploymentBytes = if ($ActiveDeploymentPreviouslyExisted) {
  if ($null -ne $ValidatedPriorActiveBytes) {
    $ValidatedPriorActiveBytes
  } else {
    [System.IO.File]::ReadAllBytes($ActiveDeploymentPath)
  }
} else {
  $null
}
$ExistingConfiguration = $null
$ExistingRegistrySnapshot = @{}
$ServiceWasRunning = $false
if ($Existing) {
  $ExistingConfiguration = Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceName'"
  if ($null -eq $ExistingConfiguration) {
    throw "Unable to snapshot existing service configuration before upgrade."
  }
  if ([string]$ExistingConfiguration.StartName -notin @('LocalSystem', 'NT AUTHORITY\SYSTEM')) {
    throw "Refusing to upgrade a service with an unexpected account: $($ExistingConfiguration.StartName)"
  }
  $ExistingRegistrySnapshot = Get-ServiceRegistrySnapshot -Path $RegistryPath
  $ServiceWasRunning = (Get-Service -Name $ServiceName).Status -ne 'Stopped'
}
$ShouldStart = [bool]$Start -or $ServiceWasRunning
$TransactionId = [Guid]::NewGuid().ToString('N')
$ReleaseId = Get-RuntimeReleaseId -ReleaseVersion $ReleaseVersion -ReleaseCommit $ReleaseCommit
$IncomingReleaseRoot = Resolve-DeploymentChildPath -Root $ReleasesRoot -ChildName ".incoming-$TransactionId"
$FinalReleaseRoot = Resolve-DeploymentChildPath -Root $ReleasesRoot -ChildName $ReleaseId
Assert-SameVolumePaths -Left $IncomingReleaseRoot -Right $FinalReleaseRoot
Assert-ReleaseDestinationAvailable -Path $IncomingReleaseRoot
Assert-ReleaseDestinationAvailable -Path $FinalReleaseRoot
$TransactionBackupRoot = Resolve-DeploymentChildPath -Root $DeploymentBackupsDir -ChildName $TransactionId
$TransactionHistoryPath = Resolve-DeploymentChildPath -Root $DeploymentHistoryDir -ChildName "$TransactionId.json"
$RuntimeEnvBackupPath = Join-Path $TransactionBackupRoot 'runtime-service.env.bin'
$ActiveDeploymentBackupPath = Join-Path $TransactionBackupRoot 'active.json.bin'
$ScmBackupPath = Join-Path $TransactionBackupRoot 'scm.json'
$RegistryBackupPath = Join-Path $TransactionBackupRoot 'registry.json'
$ServiceMutationStarted = $false
$ServiceCreated = $false
$TransactionCommitted = $false
$DeploymentJournal = $null

try {
  New-Item -ItemType Directory -Path $TransactionBackupRoot | Out-Null
  Set-TrustedPathAcl -Path $TransactionBackupRoot -Mode Mutable
  Assert-TrustedPathAcl -Path $TransactionBackupRoot -Mode Mutable
  if ($RuntimeEnvPreviouslyExisted) {
    Write-DurableBytesAtomically -Path $RuntimeEnvBackupPath -Bytes $PreviousRuntimeEnvBytes
  }
  if ($ActiveDeploymentPreviouslyExisted) {
    Write-DurableBytesAtomically -Path $ActiveDeploymentBackupPath -Bytes $PreviousActiveDeploymentBytes
  }
  $ServiceRollback = [ordered]@{
    existed = [bool]$Existing
    wasRunning = $ServiceWasRunning
    scm = if ($Existing) {
      [ordered]@{
        pathName = [string]$ExistingConfiguration.PathName
        startMode = [string]$ExistingConfiguration.StartMode
        startName = [string]$ExistingConfiguration.StartName
        displayName = [string]$ExistingConfiguration.DisplayName
        description = [string]$ExistingConfiguration.Description
      }
    } else { $null }
    registry = if ($Existing) { ConvertTo-SerializableRegistrySnapshot -Snapshot $ExistingRegistrySnapshot } else { $null }
  }
  if ($Existing) {
    Write-DurableJsonAtomically -Path $ScmBackupPath -Value $ServiceRollback.scm
    Write-DurableJsonAtomically -Path $RegistryBackupPath -Value $ServiceRollback.registry
  }
  $DeploymentJournal = [pscustomobject][ordered]@{
    schema = 'steel.runtime-deployment-transaction.v1'
    transactionId = $TransactionId
    serviceName = $ServiceName
    phase = 'prepared'
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    updatedAtUtc = [DateTime]::UtcNow.ToString('o')
    historyPath = $TransactionHistoryPath
    coordination = 'global-mutex-and-durable-journal; not a cross-resource atomic transaction'
    sourcePackageRoot = $SourcePackageRoot
    installRoot = $InstallRoot
    target = [ordered]@{
      releaseId = $ReleaseId
      releaseVersion = $ReleaseVersion
      releaseCommit = $ReleaseCommit
      incomingRoot = $IncomingReleaseRoot
      releaseRoot = $FinalReleaseRoot
    }
    database = [ordered]@{
      phase = 'not-started'
      migrationId = $null
      schemaVersionBefore = $null
      schemaVersionAfter = $null
      backupPath = $null
      contractSchema = [string]$PackageManifest.database.contractSchema
      contractSha256 = [string]$DatabaseContractReport.contractSha256
      migrationIndexSha256 = [string]$DatabaseContractReport.migrationIndexSha256
      targetSchemaVersion = [long]$DatabaseContractReport.schemaVersion
      migrationCount = [int]$DatabaseContractReport.migrationCount
    }
    rollback = [ordered]@{
      service = $ServiceRollback
      runtimeEnvironment = [ordered]@{
        existed = $RuntimeEnvPreviouslyExisted
        backupPath = if ($RuntimeEnvPreviouslyExisted) { $RuntimeEnvBackupPath } else { $null }
      }
      activeDeployment = [ordered]@{
        existed = $ActiveDeploymentPreviouslyExisted
        backupPath = if ($ActiveDeploymentPreviouslyExisted) { $ActiveDeploymentBackupPath } else { $null }
      }
    }
    events = @()
  }
  Set-DeploymentJournalPhase -Journal $DeploymentJournal -Phase 'prepared' -Path $DeploymentJournalPath -Detail 'Rollback inputs were durably captured before payload or service mutation.'

  Assert-NoReparseTree -Path $SourcePackageRoot
  Assert-ReleasePackageIntegrity -Root $SourcePackageRoot -Manifest $PackageManifest -FirstPartyThumbprint $ExpectedFirstPartyThumbprint -VendorSignerThumbprints $NormalizedVendorSignerThumbprints
  New-Item -ItemType Directory -Path $IncomingReleaseRoot | Out-Null
  foreach ($SourceItem in Get-ChildItem -LiteralPath $SourcePackageRoot -Force) {
    Copy-Item -LiteralPath $SourceItem.FullName -Destination $IncomingReleaseRoot -Recurse -Force
  }
  Assert-NoReparseTree -Path $IncomingReleaseRoot
  $StagedManifestPath = Join-Path $IncomingReleaseRoot 'manifest.json'
  $StagedManifest = Get-Content -LiteralPath $StagedManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
  if ([string]$StagedManifest.releaseVersion -cne $ReleaseVersion -or
      ([string]$StagedManifest.source.gitCommit).ToLowerInvariant() -cne $ReleaseCommit) {
    throw 'Staged release identity differs from the verified source package.'
  }
  Assert-ReleasePackageIntegrity -Root $IncomingReleaseRoot -Manifest $StagedManifest -FirstPartyThumbprint $ExpectedFirstPartyThumbprint -VendorSignerThumbprints $NormalizedVendorSignerThumbprints
  $RuntimeRoot = $IncomingReleaseRoot
  Protect-ImmutableRuntimeTree -Path $RuntimeRoot
  Assert-ReleasePackageIntegrity -Manifest $StagedManifest -Root $RuntimeRoot -FirstPartyThumbprint $ExpectedFirstPartyThumbprint -VendorSignerThumbprints $NormalizedVendorSignerThumbprints
  Assert-ReleaseDestinationAvailable -Path $FinalReleaseRoot
  # Both paths are direct children of ReleasesRoot, so Directory.Move is an
  # on-volume metadata rename. No mutable "current" link is used by SCM.
  [System.IO.Directory]::Move($IncomingReleaseRoot, $FinalReleaseRoot)
  Assert-NoReparseTree -Path $FinalReleaseRoot
  $FinalManifest = Get-Content -LiteralPath (Join-Path $FinalReleaseRoot 'manifest.json') -Raw -Encoding utf8 | ConvertFrom-Json
  if ([string]$FinalManifest.releaseVersion -cne $ReleaseVersion -or
      ([string]$FinalManifest.source.gitCommit).ToLowerInvariant() -cne $ReleaseCommit) {
    throw 'Published release identity differs from the verified source package.'
  }
  Assert-ReleasePackageIntegrity -Root $FinalReleaseRoot -Manifest $FinalManifest -FirstPartyThumbprint $ExpectedFirstPartyThumbprint -VendorSignerThumbprints $NormalizedVendorSignerThumbprints

  $RuntimeRoot = $FinalReleaseRoot
  $Supervisor = Join-Path $RuntimeRoot 'service\steel-runtime-supervisor.exe'
  $AlgorithmConfig = Join-Path $RuntimeRoot 'config\algorithm\bar-surface-production.json'
  $CaptureConfigTemplate = Join-Path $RuntimeRoot 'config\capture'
  $AlgorithmScript = Join-Path $RuntimeRoot 'scripts\bar_surface_reconstruct.py'
  $SickCaptureScript = Join-Path $RuntimeRoot 'scripts\sick_capture_service.py'
  $SickAlgorithmScript = Join-Path $RuntimeRoot 'scripts\sick_flow_analysis_service.py'
  $SickCapturePackage = Join-Path $RuntimeRoot 'scripts\sick_capture'
  $AlgorithmCore = Join-Path $RuntimeRoot 'algorithm-core\steel_bar_surface_core.exe'
  $AlgorithmAcceptanceValidator = Join-Path $RuntimeRoot 'test-algorithm-acceptance-report.ps1'
  $PackageManifestPath = Join-Path $RuntimeRoot 'manifest.json'
  $IntegrityCatalogPath = Join-Path $RuntimeRoot 'release-integrity.cat'
  Set-DeploymentJournalPhase -Journal $DeploymentJournal -Phase 'payload-published' -Path $DeploymentJournalPath -Detail 'The verified staging directory was renamed on-volume to its immutable version directory and verified again.'

$RuntimeEnvironment = @(
  "STEEL_RUNTIME_PROFILE=production",
  "STEEL_ALGORITHM_MODE=production",
  "BAR_SURFACE_MOCK_DEFECT_COUNT=0",
  "STEEL_ALGORITHM_ACCEPTANCE_REPORT=$AlgorithmAcceptanceReport",
  "STEEL_ALGORITHM_CALIBRATION_PATH=$AlgorithmCalibration",
  "STEEL_BAR_SURFACE_CORE_EXE=$AlgorithmCore",
  "STEEL_RELEASE_COMMIT=$ReleaseCommit",
  "INSPECTION_SERVICE_HOST=0.0.0.0",
  "INSPECTION_SERVICE_PORT=4873",
  "STEEL_WEB_ROOT=$RuntimeRoot\client",
  "STEEL_RESULT_ROOT=$StateRoot\result-data",
  "STEEL_RESULT_PROXY_ONLY=1",
  "STEEL_CAPTURE_MANAGED_BY_SUPERVISOR=1",
  "STEEL_IMAGE_SERVICE_PORT=4874",
  "STEEL_IMAGE_WORKER_PORT=4875",
  "STEEL_DEFECT_WORKER_PORT=4876",
  "STEEL_IMAGE_WORKER_ORIGIN=http://127.0.0.1:4875",
  "STEEL_DEFECT_WORKER_ORIGIN=http://127.0.0.1:4876",
  "STEEL_SICK_CAPTURE_PROFILE=$InstalledSickCaptureProfile",
  "STEEL_PYTHON_EXECUTABLE=$PythonExecutable",
  "STEEL_ALGORITHM_INPUT_ROOTS=$StateRoot\algorithm-input",
  "STEEL_CAPTURE_PROVIDER=external-api",
  "CAPTURE_SERVICE_ORIGIN=http://127.0.0.1:4317",
  "STEEL_CAPTURE_SERVICE_AUTOSTART=1",
  "STEEL_CAPTURE_RESTART_BUDGET=5",
  "STEEL_CAPTURE_RESTART_BACKOFF_MS=1000",
  "STEEL_CAPTURE_READY_TIMEOUT_MS=15000",
  "CAPTURE_STORAGE_ROOT=$StorageRoot",
  "CAPTURE_CAMERA_STORAGE_ROOT=$CameraStorageRoot",
  "STEEL_BAR_CAPTURE_ROOT=$CameraStorageRoot",
  "STEEL_ALGORITHM_DATA_ROOT=$AlgorithmDataRoot",
  "STEEL_ALGORITHM_PROCESS_TIMEOUT_SEC=$AlgorithmProcessTimeoutSec",
  "STEEL_REPORT_ARCHIVE_ROOT=$ReportArchiveRoot",
  "TRIGGER_GATEWAY_HOST=$TriggerHost",
  "TRIGGER_GATEWAY_PORT=4881",
  "TRIGGER_GATEWAY_ORIGIN=http://127.0.0.1:4881",
  "TRIGGER_SOURCE_ALLOWLIST=$TriggerSourceAllowlist",
  "TRIGGER_ALLOW_MODE_MUTATION=0",
  "STEEL_TRIGGER_HEALTH_REQUIRED=1",
  "STEEL_STORAGE_MIN_FREE_BYTES=$StorageMinFreeBytes",
  "STEEL_STORAGE_MIN_FREE_PERCENT=$StorageMinFreePercent",
  "STEEL_ARTIFACT_ALLOWED_ROOTS=$ArtifactAllowedRoots"
)
$BinaryPath = Get-RuntimeServiceBinaryPath -ReleaseRoot $RuntimeRoot -StateRoot $StateRoot
  Write-FileAtomically -Path $RuntimeEnvFile -Lines $RuntimeEnvironment
  Set-TrustedPathAcl -Path $RuntimeEnvFile -Mode PolicyReadOnly
  Assert-TrustedPathAcl -Path $RuntimeEnvFile -Mode PolicyReadOnly

  $PreviousSecretEnvironment = $env:STEEL_RUNTIME_SECRET_ENV_FILE
  $PreviousStateEnvironment = $env:STEEL_RUNTIME_STATE_ROOT
  try {
    $env:STEEL_RUNTIME_SECRET_ENV_FILE = $SecretEnvFile
    $env:STEEL_RUNTIME_STATE_ROOT = $StateRoot
    & $Supervisor --check --root $RuntimeRoot --state-root $StateRoot
    if ($LASTEXITCODE -ne 0) { throw "Runtime supervisor preflight failed." }
  } finally {
    if ($null -eq $PreviousSecretEnvironment) {
      Remove-Item Env:STEEL_RUNTIME_SECRET_ENV_FILE -ErrorAction SilentlyContinue
    } else {
      $env:STEEL_RUNTIME_SECRET_ENV_FILE = $PreviousSecretEnvironment
    }
    if ($null -eq $PreviousStateEnvironment) {
      Remove-Item Env:STEEL_RUNTIME_STATE_ROOT -ErrorAction SilentlyContinue
    } else {
      $env:STEEL_RUNTIME_STATE_ROOT = $PreviousStateEnvironment
    }
  }
  Set-DeploymentJournalPhase -Journal $DeploymentJournal -Phase 'preflight-passed' -Path $DeploymentJournalPath -Detail 'Acceptance validation and the versioned supervisor preflight passed.'

  Set-DeploymentJournalPhase -Journal $DeploymentJournal -Phase 'service-stop-pending' -Path $DeploymentJournalPath -Detail 'The next mutation may stop the prior service; rollback snapshots are durable.'
  if ($Existing) {
    $ServiceMutationStarted = $true
    $CurrentService = Get-Service -Name $ServiceName
    if ($CurrentService.Status -ne 'Stopped') {
      Stop-Service -Name $ServiceName -Force
      (Get-Service -Name $ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(120))
    }
  } else {
    foreach ($Port in 4317, 4873, 4874, 4875, 4876, 4881, 4882, 4883) { Assert-PortFree -Port $Port }
    $ServiceMutationStarted = $true
  }
  Set-DeploymentJournalPhase -Journal $DeploymentJournal -Phase 'service-stopped' -Path $DeploymentJournalPath -Detail 'The prior service is stopped, or no prior service existed.'

  Set-DeploymentJournalPhase -Journal $DeploymentJournal -Phase 'scm-switch-pending' -Path $DeploymentJournalPath -Detail 'The next mutation may point SCM at the immutable version directory.'
  if ($Existing) {
    Invoke-ScChecked @('config', $ServiceName, 'binPath=', $BinaryPath, 'start=', 'delayed-auto', 'obj=', 'LocalSystem', 'DisplayName=', $DisplayName) | Out-Null
  } else {
    Invoke-ScChecked @('create', $ServiceName, 'binPath=', $BinaryPath, 'start=', 'delayed-auto', 'obj=', 'LocalSystem', 'DisplayName=', $DisplayName) | Out-Null
    $ServiceCreated = $true
  }
  Invoke-ScChecked @('description', $ServiceName, 'Supervises capture, trigger, and inspection services with readiness checks and bounded restart.') | Out-Null
  Invoke-ScChecked @('sidtype', $ServiceName, 'unrestricted') | Out-Null
  New-ItemProperty -LiteralPath $RegistryPath -Name Environment -PropertyType MultiString -Value @(
    "STEEL_RUNTIME_SECRET_ENV_FILE=$SecretEnvFile",
    "STEEL_RUNTIME_STATE_ROOT=$StateRoot"
  ) -Force | Out-Null
  New-ItemProperty -LiteralPath $RegistryPath -Name SteelReleaseVersion -PropertyType String -Value $ReleaseVersion -Force | Out-Null
  New-ItemProperty -LiteralPath $RegistryPath -Name SteelReleaseCommit -PropertyType String -Value $ReleaseCommit -Force | Out-Null
  New-ItemProperty -LiteralPath $RegistryPath -Name SteelReleaseId -PropertyType String -Value $ReleaseId -Force | Out-Null
  New-ItemProperty -LiteralPath $RegistryPath -Name SteelDatabaseSchemaVersion -PropertyType DWord -Value ([int]$DatabaseContractReport.schemaVersion) -Force | Out-Null
  New-ItemProperty -LiteralPath $RegistryPath -Name SteelDatabaseContractSha256 -PropertyType String -Value ([string]$DatabaseContractReport.contractSha256) -Force | Out-Null
  New-ItemProperty -LiteralPath $RegistryPath -Name SteelDatabaseMigrationIndexSha256 -PropertyType String -Value ([string]$DatabaseContractReport.migrationIndexSha256) -Force | Out-Null
  New-ItemProperty -LiteralPath $RegistryPath -Name SteelInstallRoot -PropertyType String -Value $InstallRoot -Force | Out-Null
  New-ItemProperty -LiteralPath $RegistryPath -Name SteelRuntimeRoot -PropertyType String -Value $RuntimeRoot -Force | Out-Null
  New-ItemProperty -LiteralPath $RegistryPath -Name SteelStateRoot -PropertyType String -Value $StateRoot -Force | Out-Null
  Set-DeploymentJournalPhase -Journal $DeploymentJournal -Phase 'scm-switched' -Path $DeploymentJournalPath -Detail 'SCM and service registry metadata point directly at the immutable version directory.'

  if ($ShouldStart) {
    Set-DeploymentJournalPhase -Journal $DeploymentJournal -Phase 'service-start-pending' -Path $DeploymentJournalPath -Detail 'The next mutation may start the new version.'
    Start-Service -Name $ServiceName
    (Get-Service -Name $ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(120))
    Set-DeploymentJournalPhase -Journal $DeploymentJournal -Phase 'service-started' -Path $DeploymentJournalPath -Detail 'SCM reports the new version as running.'
  } else {
    Set-DeploymentJournalPhase -Journal $DeploymentJournal -Phase 'service-configured' -Path $DeploymentJournalPath -Detail 'The new version is configured and intentionally remains stopped.'
  }

  Invoke-ScChecked @('failureflag', $ServiceName, '1') | Out-Null
  # The final no-op is intentionally repeated by SCM after two attempts, preventing an infinite restart loop.
  Set-BoundedServiceFailureActions -Name $ServiceName
  $ActiveDeployment = [pscustomobject][ordered]@{
    schema = 'steel.runtime-active-deployment.v1'
    releaseId = $ReleaseId
    releaseVersion = $ReleaseVersion
    releaseCommit = $ReleaseCommit
    releaseRoot = $RuntimeRoot
    stateRoot = $StateRoot
    serviceName = $ServiceName
    transactionId = $TransactionId
    activatedAtUtc = [DateTime]::UtcNow.ToString('o')
    serviceRunning = $ShouldStart
    database = [ordered]@{
      schemaVersion = [long]$DatabaseContractReport.schemaVersion
      contractSha256 = [string]$DatabaseContractReport.contractSha256
      migrationIndexSha256 = [string]$DatabaseContractReport.migrationIndexSha256
      migrationCount = [int]$DatabaseContractReport.migrationCount
      phase = 'not-started'
    }
  }
  Write-DurableJsonAtomically -Path $ActiveDeploymentPath -Value $ActiveDeployment
  Set-DeploymentJournalPhase -Journal $DeploymentJournal -Phase 'committed' -Path $DeploymentJournalPath -Detail 'The active deployment record, SCM configuration, environment, registry metadata, and requested running state are committed.'
  Write-DeploymentHistory -Journal $DeploymentJournal -HistoryRoot $DeploymentHistoryDir
  $TransactionCommitted = $true
} catch {
  $InstallationError = $_
  $RollbackErrors = [System.Collections.Generic.List[string]]::new()
  try {
    if ($RuntimeEnvPreviouslyExisted) {
      Write-DurableBytesAtomically -Path $RuntimeEnvFile -Bytes $PreviousRuntimeEnvBytes -AclMode PolicyReadOnly
      Set-TrustedPathAcl -Path $RuntimeEnvFile -Mode PolicyReadOnly
      Assert-TrustedPathAcl -Path $RuntimeEnvFile -Mode PolicyReadOnly
    } elseif (Test-Path -LiteralPath $RuntimeEnvFile -PathType Leaf) {
      Remove-Item -LiteralPath $RuntimeEnvFile -Force
    }
  } catch {
    $RollbackErrors.Add("runtime environment restore failed: $($_.Exception.Message)")
  }
  try {
    if ($ActiveDeploymentPreviouslyExisted) {
      Write-DurableBytesAtomically -Path $ActiveDeploymentPath -Bytes $PreviousActiveDeploymentBytes
    } elseif (Test-Path -LiteralPath $ActiveDeploymentPath -PathType Leaf) {
      Remove-Item -LiteralPath $ActiveDeploymentPath -Force
    }
  } catch {
    $RollbackErrors.Add("active deployment restore failed: $($_.Exception.Message)")
  }

  if ($ServiceMutationStarted) {
    if ($ServiceCreated) {
      try {
        $CreatedService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($CreatedService -and $CreatedService.Status -ne 'Stopped') {
          Stop-Service -Name $ServiceName -Force
          (Get-Service -Name $ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(120))
        }
        if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
          Invoke-ScChecked @('delete', $ServiceName) | Out-Null
          Wait-ServiceAbsent
        }
      } catch {
        $RollbackErrors.Add("new service removal failed: $($_.Exception.Message)")
      }
    } elseif ($Existing) {
      try {
        $CurrentService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($CurrentService -and $CurrentService.Status -ne 'Stopped') {
          Stop-Service -Name $ServiceName -Force
          (Get-Service -Name $ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(120))
        }
        Restore-ExistingServiceConfiguration -Configuration $ExistingConfiguration -RegistrySnapshot $ExistingRegistrySnapshot -RegistryPath $RegistryPath
        if ($ServiceWasRunning) {
          Start-Service -Name $ServiceName
          (Get-Service -Name $ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(120))
        }
      } catch {
        $RollbackErrors.Add("existing service restore failed: $($_.Exception.Message)")
      }
    }
  }

  if ($null -ne $DeploymentJournal) {
    try {
      $RollbackPhase = if ($RollbackErrors.Count -eq 0) { 'rolled-back' } else { 'failed-safe' }
      $RollbackDetail = if ($RollbackErrors.Count -eq 0) {
        'In-process rollback restored the prior SCM, environment, active deployment, registry metadata, and running state before database migration.'
      } else {
        "In-process rollback could not prove full restoration: $($RollbackErrors -join '; ')"
      }
      Set-DeploymentJournalPhase -Journal $DeploymentJournal -Phase $RollbackPhase -Path $DeploymentJournalPath -Detail $RollbackDetail
      Write-DeploymentHistory -Journal $DeploymentJournal -HistoryRoot $DeploymentHistoryDir
    } catch {
      $RollbackErrors.Add("deployment journal finalization failed: $($_.Exception.Message)")
    }
  }

  $RollbackSuffix = if ($RollbackErrors.Count -gt 0) {
    " Rollback errors: $($RollbackErrors -join '; ')"
  } else {
    ' Rollback completed.'
  }
  throw "Runtime service installation/upgrade failed: $($InstallationError.Exception.Message).$RollbackSuffix"
}

if (-not $TransactionCommitted) {
  throw 'Runtime service transaction ended without a committed state.'
}
Get-Service -Name $ServiceName | Select-Object Name, DisplayName, Status, StartType
Write-Host "Installed $ServiceName release $ReleaseVersion ($ReleaseCommit). Immutable payload: $RuntimeRoot"
Write-Host "Source package: $SourcePackageRoot. Install root: $InstallRoot"
Write-Host "Mutable state: $StateRoot. Logs: $StateLogsDir"
} finally {
  if ($DeploymentMutexAcquired) {
    try { $DeploymentMutex.ReleaseMutex() } catch { }
  }
  $DeploymentMutex.Dispose()
}
