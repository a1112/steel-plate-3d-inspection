param(
  [string]$Profile = "config\sites\sick-array-6\capture.json",
  [string]$SharePrefix = "Steel",
  [switch]$Apply,
  [switch]$ReadWrite
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ProfilePath = if ([System.IO.Path]::IsPathRooted($Profile)) {
  [System.IO.Path]::GetFullPath($Profile)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $Profile))
}
if (-not (Test-Path -LiteralPath $ProfilePath -PathType Leaf)) {
  throw "Capture profile not found: $ProfilePath"
}

$Config = Get-Content -LiteralPath $ProfilePath -Raw -Encoding UTF8 | ConvertFrom-Json
$Cameras = @($Config.cameras | Where-Object { $_.enabled -ne $false })
if ($Cameras.Count -eq 0) {
  throw "Capture profile has no enabled cameras."
}

$Rows = foreach ($Camera in $Cameras) {
  $CameraId = [string]$Camera.id
  $Root = [System.IO.Path]::GetFullPath(
    [Environment]::ExpandEnvironmentVariables([string]$Camera.storageRoot)
  ).TrimEnd('\')
  if ([string]::IsNullOrWhiteSpace($CameraId) -or (Split-Path -Leaf $Root) -ne $CameraId) {
    throw "Camera root must end in its camera id: $CameraId -> $Root"
  }
  [pscustomobject]@{
    CameraId = $CameraId
    Root = $Root
    Share = "$SharePrefix-$CameraId"
    Unc = "\\$env:COMPUTERNAME\$SharePrefix-$CameraId"
  }
}

if (-not $Apply) {
  [pscustomobject]@{
    mode = "dry-run"
    computer = $env:COMPUTERNAME
    access = if ($ReadWrite) { "Change" } else { "Read" }
    shares = @($Rows)
  } | ConvertTo-Json -Depth 5
  exit 0
}

$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = [Security.Principal.WindowsPrincipal]$Identity
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Creating SMB shares requires an elevated PowerShell window."
}

$Everyone = ([Security.Principal.SecurityIdentifier]'S-1-1-0').Translate(
  [Security.Principal.NTAccount]
).Value
$ShareRight = if ($ReadWrite) { "Change" } else { "Read" }
$NtfsRight = if ($ReadWrite) {
  [Security.AccessControl.FileSystemRights]::Modify
} else {
  [Security.AccessControl.FileSystemRights]::ReadAndExecute
}

foreach ($Row in $Rows) {
  New-Item -ItemType Directory -Force -Path $Row.Root | Out-Null
  $Acl = Get-Acl -LiteralPath $Row.Root
  $Rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $Everyone,
    $NtfsRight,
    [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  $Acl.SetAccessRule($Rule)
  Set-Acl -LiteralPath $Row.Root -AclObject $Acl

  $Existing = Get-SmbShare -Name $Row.Share -ErrorAction SilentlyContinue
  if ($Existing -and [System.IO.Path]::GetFullPath($Existing.Path).TrimEnd('\') -ne $Row.Root) {
    throw "Share $($Row.Share) already targets another path: $($Existing.Path)"
  }
  if (-not $Existing) {
    $Arguments = @{
      Name = $Row.Share
      Path = $Row.Root
      Description = "SICK $($Row.CameraId) historical raw data"
      CachingMode = "None"
      FolderEnumerationMode = "AccessBased"
    }
    if ($ReadWrite) { $Arguments.ChangeAccess = $Everyone } else { $Arguments.ReadAccess = $Everyone }
    New-SmbShare @Arguments | Out-Null
  } else {
    Grant-SmbShareAccess -Name $Row.Share -AccountName $Everyone -AccessRight $ShareRight -Force | Out-Null
  }
}

Get-NetFirewallRule -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Direction -eq 'Inbound' -and
    ($_.Service -eq 'LanmanServer' -or $_.Name -like 'FPS-SMB-In-TCP*')
  } |
  Where-Object { $_.Profile -match 'Domain|Private|Any' } |
  Enable-NetFirewallRule

[pscustomobject]@{
  mode = "applied"
  computer = $env:COMPUTERNAME
  access = $ShareRight
  shares = @($Rows)
} | ConvertTo-Json -Depth 5
