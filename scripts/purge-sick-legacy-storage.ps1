param(
  [string]$Profile = "config\sites\sick-array-6\capture.json",
  [switch]$Apply
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

function Normalize-StoragePath([string]$Path) {
  return [System.IO.Path]::GetFullPath(
    [Environment]::ExpandEnvironmentVariables($Path)
  ).TrimEnd('\')
}

function Test-IsPathAncestor([string]$Ancestor, [string]$Path) {
  return $Path.StartsWith(
    $Ancestor + '\',
    [StringComparison]::OrdinalIgnoreCase
  )
}

$Config = Get-Content -LiteralPath $ProfilePath -Raw -Encoding UTF8 | ConvertFrom-Json
$StorageRoot = Normalize-StoragePath ([string]$Config.storageRoot)
$CameraRoots = @(
  $Config.cameras |
    Where-Object { $_.enabled -ne $false } |
    ForEach-Object { Normalize-StoragePath ([string]$_.storageRoot) } |
    Sort-Object -Unique
)
if ($CameraRoots.Count -eq 0) {
  throw "Capture profile has no enabled camera roots."
}
$ActiveRoots = @($StorageRoot) + $CameraRoots
$RebuildRoot = Normalize-StoragePath (Join-Path $StorageRoot "rebuild")

$AllowedLegacyRoots = @(
  $CameraRoots |
    ForEach-Object {
      Normalize-StoragePath (Join-Path ([System.IO.Path]::GetDirectoryName($_)) "steel-sick-data")
    } |
    Where-Object { $_ -ine $StorageRoot } |
    Sort-Object -Unique
)
$LegacyTargets = @(
  $AllowedLegacyRoots |
    Where-Object { Test-Path -LiteralPath $_ -PathType Container } |
    ForEach-Object { [pscustomobject]@{ kind = "legacy-root"; path = $_ } }
)

$ObsoleteTargets = @()
$OldJournalTargets = @()
$KeptJournal = $null
if (Test-Path -LiteralPath $RebuildRoot -PathType Container) {
  $ObsoleteTargets = @(
    Get-ChildItem -LiteralPath $RebuildRoot -Directory -Force |
      Where-Object {
        $_.Name -like "obsolete-camera-v1-*" -or
        $_.Name -like "obsolete-derived-v1-*"
      } |
      ForEach-Object {
        [pscustomobject]@{ kind = "obsolete-archive"; path = $_.FullName }
      }
  )

  $V3Journals = @(
    Get-ChildItem -LiteralPath $RebuildRoot -File -Filter "camera-storage-v3-*.json" -Force |
      Sort-Object LastWriteTimeUtc -Descending
  )
  $KeptJournal = @(
    $V3Journals | Where-Object {
      try {
        (Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json).state -eq "complete"
      } catch {
        $false
      }
    }
  ) | Select-Object -First 1
  $OldJournalTargets = @(
    Get-ChildItem -LiteralPath $RebuildRoot -File -Force |
      Where-Object {
        $_.Name -like "flow-storage-v2-*.json" -or
        ($_.Name -like "camera-storage-v3-*.json" -and
          ($null -eq $KeptJournal -or $_.FullName -ine $KeptJournal.FullName))
      } |
      ForEach-Object {
        [pscustomobject]@{ kind = "obsolete-journal"; path = $_.FullName }
      }
  )
}

$Targets = @($LegacyTargets) + @($ObsoleteTargets) + @($OldJournalTargets)
foreach ($Target in $Targets) {
  $Resolved = Normalize-StoragePath ([string]$Target.path)
  $Parent = Normalize-StoragePath ([System.IO.Path]::GetDirectoryName($Resolved))
  $Leaf = [System.IO.Path]::GetFileName($Resolved)
  $Allowed = switch ([string]$Target.kind) {
    "legacy-root" { $AllowedLegacyRoots -contains $Resolved }
    "obsolete-archive" {
      $Parent -ieq $RebuildRoot -and
      ($Leaf -like "obsolete-camera-v1-*" -or $Leaf -like "obsolete-derived-v1-*")
    }
    "obsolete-journal" {
      $Parent -ieq $RebuildRoot -and
      ($Leaf -like "flow-storage-v2-*.json" -or $Leaf -like "camera-storage-v3-*.json")
    }
    default { $false }
  }
  if (-not $Allowed) {
    throw "Refusing unapproved legacy target: $Resolved"
  }
  foreach ($ActiveRoot in $ActiveRoots) {
    if ($Resolved -ieq $ActiveRoot -or (Test-IsPathAncestor $Resolved $ActiveRoot)) {
      throw "Legacy target overlaps active storage: $Resolved -> $ActiveRoot"
    }
  }
  $Item = Get-Item -LiteralPath $Resolved -Force
  if ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw "Refusing reparse target: $Resolved"
  }
  $Target.path = $Resolved
}

if (-not $Apply) {
  [pscustomobject]@{
    mode = "dry-run"
    storageRoot = $StorageRoot
    activeCameraRoots = $CameraRoots
    keptJournal = if ($KeptJournal) { $KeptJournal.FullName } else { $null }
    targetCount = $Targets.Count
    targets = $Targets
  } | ConvertTo-Json -Depth 5
  exit 0
}

# Scan before deleting anything. Directory.Delete must never traverse a junction
# or directory symbolic link that could escape one of the exact roots validated
# above. File symlinks are deleted as files and cannot redirect tree traversal.
foreach ($Target in $Targets | Where-Object { Test-Path -LiteralPath $_.path -PathType Container }) {
  Write-Host "Validating legacy tree: $($Target.path)"
  $Reparse = Get-ChildItem -LiteralPath $Target.path -Directory -Recurse -Force -Attributes ReparsePoint |
    Select-Object -First 1
  if ($Reparse) {
    throw "Refusing legacy tree containing a reparse point: $($Reparse.FullName)"
  }
}

$Deleted = @()
foreach ($Target in $Targets) {
  Write-Host "Deleting $($Target.kind): $($Target.path)"
  if (Test-Path -LiteralPath $Target.path -PathType Container) {
    [System.IO.Directory]::Delete([string]$Target.path, $true)
  } elseif (Test-Path -LiteralPath $Target.path -PathType Leaf) {
    [System.IO.File]::Delete([string]$Target.path)
  }
  if (Test-Path -LiteralPath $Target.path) {
    throw "Legacy target still exists after deletion: $($Target.path)"
  }
  $Deleted += $Target
}

[pscustomobject]@{
  mode = "applied"
  storageRoot = $StorageRoot
  activeCameraRoots = $CameraRoots
  keptJournal = if ($KeptJournal) { $KeptJournal.FullName } else { $null }
  deletedCount = $Deleted.Count
  deleted = $Deleted
} | ConvertTo-Json -Depth 5
