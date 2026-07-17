param(
  [Parameter(Mandatory = $true)]
  [string]$SbomPath,
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [Parameter(Mandatory = $true)]
  [string]$ExternalComponentsPath,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9A-Fa-f]{64}$')]
  [string]$ExpectedExternalComponentsSha256,
  [ValidatePattern('^$|^[0-9A-Fa-f]{64}$')]
  [string]$ExpectedSbomSha256 = '',
  [string]$ExpectedCommit = '',
  [switch]$AllowDirtyWorktree
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'release-sbom-common.ps1')

$ResolvedSbom = (Resolve-Path -LiteralPath $SbomPath -ErrorAction Stop).Path
$SbomItem = Get-Item -LiteralPath $ResolvedSbom -Force
if (($SbomItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'SBOM input must not be a reparse point.'
}
if (-not [string]::IsNullOrWhiteSpace($ExpectedSbomSha256)) {
  $ExpectedSbomSha256 = $ExpectedSbomSha256.Trim().ToLowerInvariant()
  $ActualSbomSha256 = Get-Sha256Hex $ResolvedSbom
  if ($ActualSbomSha256 -cne $ExpectedSbomSha256) {
    throw "SBOM file hash mismatch. expected=$ExpectedSbomSha256 actual=$ActualSbomSha256"
  }
}

$Bom = Read-JsonDictionary $ResolvedSbom
$ExpectedTopLevel = @('$schema', 'bomFormat', 'specVersion', 'serialNumber', 'version', 'metadata', 'components', 'dependencies')
$ActualTopLevel = @($Bom.Keys | Sort-Object)
if (($ActualTopLevel -join "`n") -cne (@($ExpectedTopLevel | Sort-Object) -join "`n")) {
  throw "SBOM top-level fields are not the exact release schema: $($ActualTopLevel -join ',')"
}
if ([string](Get-DictionaryValue $Bom '$schema' -Required) -cne 'http://cyclonedx.org/schema/bom-1.5.schema.json' -or
    [string](Get-DictionaryValue $Bom 'bomFormat' -Required) -cne 'CycloneDX' -or
    [string](Get-DictionaryValue $Bom 'specVersion' -Required) -cne $script:CycloneDxSpecVersion -or
    [int](Get-DictionaryValue $Bom 'version' -Required) -ne 1) {
  throw 'SBOM does not declare the approved CycloneDX 1.5 format.'
}

$Metadata = Get-DictionaryValue $Bom 'metadata' -Required
if ($Metadata -isnot [System.Collections.IDictionary]) { throw 'SBOM metadata must be an object.' }
$ExpectedMetadataFields = @('timestamp', 'tools', 'component', 'properties')
$ActualMetadataFields = @($Metadata.Keys | Sort-Object)
if (($ActualMetadataFields -join "`n") -cne (@($ExpectedMetadataFields | Sort-Object) -join "`n")) {
  throw "SBOM metadata fields are not the exact release schema: $($ActualMetadataFields -join ',')"
}

$Tools = Get-DictionaryValue $Metadata 'tools' -Required
$ToolComponents = @(Get-DictionaryValue $Tools 'components' -Required)
if ($Tools -isnot [System.Collections.IDictionary] -or @($Tools.Keys).Count -ne 1 -or $ToolComponents.Count -ne 3) {
  throw 'SBOM must record exactly the generator, PowerShell, and Git tools.'
}
$ToolMap = @{}
foreach ($Tool in $ToolComponents) {
  if ($Tool -isnot [System.Collections.IDictionary]) { throw 'SBOM tool entry must be an object.' }
  $ToolName = [string](Get-DictionaryValue $Tool 'name' -Required)
  $ToolVersion = [string](Get-DictionaryValue $Tool 'version' -Required)
  if ([string]::IsNullOrWhiteSpace($ToolName) -or [string]::IsNullOrWhiteSpace($ToolVersion) -or $ToolMap.ContainsKey($ToolName)) {
    throw "SBOM tool identity is empty or duplicated: $ToolName"
  }
  if ([string](Get-DictionaryValue $Tool 'type' -Required) -cne 'application' -or @($Tool.Keys).Count -ne 3) {
    throw "SBOM tool entry has unexpected fields: $ToolName"
  }
  $ToolMap[$ToolName] = $ToolVersion
}
$ActualToolNames = (@($ToolMap.Keys | Sort-Object) -join "`n")
$ExpectedToolNames = (@('Git', 'PowerShell', 'generate-release-sbom.ps1') | Sort-Object) -join "`n"
if ($ActualToolNames -cne $ExpectedToolNames) {
  throw 'SBOM tool inventory is incomplete or unexpected.'
}
if ([string]$ToolMap['generate-release-sbom.ps1'] -cne $script:SteelSbomGeneratorVersion -or
    [string]$ToolMap['PowerShell'] -notmatch '^\d+\.\d+' -or
    [string]$ToolMap['Git'] -notmatch '^git version \S+') {
  throw 'SBOM tool versions are malformed or unsupported.'
}

$ModelArgs = @{
  RepoRoot = $RepoRoot
  ExternalComponentsPath = $ExternalComponentsPath
  ExpectedExternalComponentsSha256 = $ExpectedExternalComponentsSha256
  ExpectedCommit = $ExpectedCommit
  AllowDirtyWorktree = [bool]$AllowDirtyWorktree
}
$Expected = Get-ReleaseSbomExpectedModel @ModelArgs

if ((ConvertTo-CanonicalJson $ToolComponents) -cne (ConvertTo-CanonicalJson $Expected.tools)) {
  throw 'SBOM tool versions do not match the offline verification environment.'
}
if ([string](Get-DictionaryValue $Bom 'serialNumber' -Required) -cne [string]$Expected.serialNumber) {
  throw 'SBOM serialNumber is not deterministically bound to its commit and input hashes.'
}
if ([string](Get-DictionaryValue $Metadata 'timestamp' -Required) -cne [string]$Expected.timestamp) {
  throw 'SBOM timestamp is not the immutable source commit timestamp.'
}

$Comparisons = @(
  [ordered]@{ label = 'root component'; actual = (Get-DictionaryValue $Metadata 'component' -Required); expected = $Expected.rootComponent },
  [ordered]@{ label = 'metadata properties'; actual = @(Get-DictionaryValue $Metadata 'properties' -Required); expected = @($Expected.properties) },
  [ordered]@{ label = 'component inventory'; actual = @(Get-DictionaryValue $Bom 'components' -Required); expected = @($Expected.components) },
  [ordered]@{ label = 'dependency graph'; actual = @(Get-DictionaryValue $Bom 'dependencies' -Required); expected = @($Expected.dependencies) }
)
foreach ($Comparison in $Comparisons) {
  $ActualJson = ConvertTo-CanonicalJson $Comparison.actual
  $ExpectedJson = ConvertTo-CanonicalJson $Comparison.expected
  if ($ActualJson -cne $ExpectedJson) {
    throw "SBOM $($Comparison.label) does not match the offline lock/config inventory."
  }
}

[pscustomobject]@{
  schema = $script:SteelSbomSchema
  valid = $true
  path = $ResolvedSbom
  sha256 = Get-Sha256Hex $ResolvedSbom
  sourceCommit = [string]$Expected.commit
  dirty = [bool]$Expected.dirty
  componentCount = @($Expected.components).Count
  offline = $true
} | ConvertTo-Json -Depth 5
