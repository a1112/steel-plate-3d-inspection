param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [Parameter(Mandatory = $true)]
  [string]$ExternalComponentsPath,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9A-Fa-f]{64}$')]
  [string]$ExpectedExternalComponentsSha256,
  [string]$OutputPath = '',
  [string]$ExpectedCommit = '',
  [switch]$AllowDirtyWorktree
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'release-sbom-common.ps1')

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $OutputPath = Join-Path $RepoRoot 'target\release\steel-release-sbom.cdx.json'
}
$OutputPath = [Environment]::ExpandEnvironmentVariables($OutputPath)
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$OutputParent = Split-Path -Parent $OutputPath
if ([string]::IsNullOrWhiteSpace($OutputParent)) {
  throw 'OutputPath must have a parent directory.'
}

$ModelArgs = @{
  RepoRoot = $RepoRoot
  ExternalComponentsPath = $ExternalComponentsPath
  ExpectedExternalComponentsSha256 = $ExpectedExternalComponentsSha256
  ExpectedCommit = $ExpectedCommit
  AllowDirtyWorktree = [bool]$AllowDirtyWorktree
}
$Model = Get-ReleaseSbomExpectedModel @ModelArgs

# Git canonicalizes macOS aliases such as /var to /private/var. Keep an output
# requested beneath the caller's repository path on that same canonical root so
# protected-input and Git-administration boundary checks cannot be bypassed by
# using the alternate spelling.
$RequestedRepoBoundary = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd('\', '/')
if ($OutputPath.StartsWith($RequestedRepoBoundary + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  $RelativeOutputPath = [System.IO.Path]::GetRelativePath($RequestedRepoBoundary, $OutputPath)
  $OutputPath = [System.IO.Path]::GetFullPath((Join-Path $Model.repoRoot $RelativeOutputPath))
  $OutputParent = Split-Path -Parent $OutputPath
}

$ProtectedInputs = @(
  (Resolve-Path -LiteralPath $ExternalComponentsPath -ErrorAction Stop).Path,
  (Resolve-RepositoryFile -RepoRoot $Model.repoRoot -RelativePath 'app/client/package-lock.json'),
  (Resolve-RepositoryFile -RepoRoot $Model.repoRoot -RelativePath 'app/client/src-tauri/Cargo.lock'),
  (Resolve-RepositoryFile -RepoRoot $Model.repoRoot -RelativePath 'app/service/Cargo.lock'),
  (Resolve-RepositoryFile -RepoRoot $Model.repoRoot -RelativePath 'app/trigger/Cargo.lock'),
  (Resolve-RepositoryFile -RepoRoot $Model.repoRoot -RelativePath 'app/camera-worker/Cargo.lock'),
  (Resolve-RepositoryFile -RepoRoot $Model.repoRoot -RelativePath 'app/result-contract/Cargo.lock'),
  (Resolve-RepositoryFile -RepoRoot $Model.repoRoot -RelativePath 'app/pipeline-workers/Cargo.lock'),
  (Resolve-RepositoryFile -RepoRoot $Model.repoRoot -RelativePath 'app/runtime-contract/Cargo.lock'),
  (Resolve-RepositoryFile -RepoRoot $Model.repoRoot -RelativePath 'app/image-service/Cargo.lock'),
  (Resolve-RepositoryFile -RepoRoot $Model.repoRoot -RelativePath 'app/algorithm-service/Cargo.lock'),
  (Resolve-RepositoryFile -RepoRoot $Model.repoRoot -RelativePath 'app/server-monitor/Cargo.lock'),
  (Resolve-RepositoryFile -RepoRoot $Model.repoRoot -RelativePath 'app/tray/Cargo.lock'),
  (Join-Path $PSScriptRoot 'generate-release-sbom.ps1'),
  (Join-Path $PSScriptRoot 'verify-release-sbom.ps1'),
  (Join-Path $PSScriptRoot 'release-sbom-common.ps1')
)
foreach ($ProtectedInput in $ProtectedInputs) {
  if ([System.IO.Path]::GetFullPath($ProtectedInput).Equals($OutputPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputPath must not overwrite an SBOM input or tool: $OutputPath"
  }
}
$GitDirectoryText = Invoke-GitRead -RepoRoot $Model.repoRoot -Arguments @('rev-parse', '--git-dir')
$GitDirectory = if ([System.IO.Path]::IsPathRooted($GitDirectoryText)) {
  [System.IO.Path]::GetFullPath($GitDirectoryText)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $Model.repoRoot $GitDirectoryText))
}
$GitBoundary = $GitDirectory.TrimEnd('\', '/')
if ($OutputPath.Equals($GitBoundary, [System.StringComparison]::OrdinalIgnoreCase) -or
    $OutputPath.StartsWith($GitBoundary + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputPath must not write inside Git administrative data.'
}
if (Test-Path -LiteralPath $OutputPath) {
  $ExistingOutput = Get-Item -LiteralPath $OutputPath -Force
  if (($ExistingOutput.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'OutputPath must not replace a reparse point.'
  }
}

$Bom = [ordered]@{
  '$schema' = 'http://cyclonedx.org/schema/bom-1.5.schema.json'
  bomFormat = 'CycloneDX'
  specVersion = $script:CycloneDxSpecVersion
  serialNumber = [string]$Model.serialNumber
  version = 1
  metadata = [ordered]@{
    timestamp = [string]$Model.timestamp
    tools = [ordered]@{
      components = $Model.tools
    }
    component = $Model.rootComponent
    properties = $Model.properties
  }
  components = $Model.components
  dependencies = $Model.dependencies
}

$Json = $Bom | ConvertTo-Json -Depth 100
if ([string]::IsNullOrWhiteSpace($Json)) { throw 'CycloneDX serialization produced empty output.' }
if (-not (Test-Path -LiteralPath $OutputParent -PathType Container)) {
  New-Item -ItemType Directory -Path $OutputParent -Force | Out-Null
}
$TemporaryPath = Join-Path $OutputParent ('.' + [System.IO.Path]::GetFileName($OutputPath) + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
  [System.IO.File]::WriteAllText($TemporaryPath, $Json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
  $Written = Read-JsonDictionary $TemporaryPath
  if ([string](Get-DictionaryValue $Written 'bomFormat' -Required) -cne 'CycloneDX') {
    throw 'Generated SBOM failed its serialization readback.'
  }
  Move-Item -LiteralPath $TemporaryPath -Destination $OutputPath -Force
} finally {
  Remove-Item -LiteralPath $TemporaryPath -Force -ErrorAction SilentlyContinue
}

[pscustomobject]@{
  schema = $script:SteelSbomSchema
  path = $OutputPath
  sha256 = Get-Sha256Hex $OutputPath
  sourceCommit = [string]$Model.commit
  dirty = [bool]$Model.dirty
  componentCount = @($Model.components).Count
  npmComponentCount = [int](@($Model.properties | Where-Object { $_.name -eq 'steel.component.count.npm' })[0].value)
  cargoComponentCount = [int](@($Model.properties | Where-Object { $_.name -eq 'steel.component.count.cargo' })[0].value)
  externalComponentCount = [int](@($Model.properties | Where-Object { $_.name -eq 'steel.component.count.external' })[0].value)
} | ConvertTo-Json -Depth 5
