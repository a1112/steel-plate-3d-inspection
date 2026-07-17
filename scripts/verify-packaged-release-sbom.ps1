param(
  [Parameter(Mandatory = $true)][string]$PackageDir,
  [string]$ManifestPath = "",
  [string]$ExpectedExternalComponentsSha256 = "",
  [switch]$Engineering
)

$ErrorActionPreference = 'Stop'

function Assert-ExactKeys {
  param($Value, [string[]]$Expected, [string]$Label)
  if ($null -eq $Value -or $Value -is [string] -or $Value -is [System.Array]) {
    throw "$Label must be a JSON object."
  }
  $Actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $Required = @($Expected | Sort-Object)
  if ($Actual.Count -ne $Required.Count -or ($Actual -join "`n") -cne ($Required -join "`n")) {
    throw "$Label fields are not the exact release schema."
  }
}

function Assert-JsonInteger {
  param($Value, [string]$Label, [long]$Minimum = 0)
  $Integer = $Value -is [byte] -or $Value -is [sbyte] -or
    $Value -is [int16] -or $Value -is [uint16] -or
    $Value -is [int32] -or $Value -is [uint32] -or
    $Value -is [int64] -or $Value -is [uint64]
  if (-not $Integer -or [decimal]$Value -lt $Minimum -or [decimal]$Value -gt 2147483647) {
    throw "$Label must be a non-negative JSON integer."
  }
}

function Resolve-PackageFile {
  param([string]$RelativePath, [string]$Label)
  if ([string]::IsNullOrWhiteSpace($RelativePath) -or
      $RelativePath.Contains('\') -or
      [System.IO.Path]::IsPathRooted($RelativePath) -or
      $RelativePath -match '(^/|/$|//|(^|/)\.\.?(/|$)|[:\x00-\x1f])') {
    throw "$Label is not a canonical package-relative path: $RelativePath"
  }
  $Root = [System.IO.Path]::GetFullPath($PackageDir).TrimEnd('\', '/')
  $Resolved = [System.IO.Path]::GetFullPath((Join-Path $Root ($RelativePath -replace '/', '\')))
  if (-not $Resolved.StartsWith($Root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not (Test-Path -LiteralPath $Resolved -PathType Leaf)) {
    throw "$Label escapes the package or is missing: $RelativePath"
  }
  if (((Get-Item -LiteralPath $Resolved -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label must not be a reparse point: $RelativePath"
  }
  return $Resolved
}

function Read-Json {
  param([string]$Path, [string]$Label)
  try {
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "$Label must be valid UTF-8 JSON: $Path"
  }
}

function Get-LowerSha256 {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-PropertyMap {
  param($Properties, [string]$Label)
  $Map = @{}
  foreach ($Property in @($Properties)) {
    Assert-ExactKeys $Property @('name', 'value') "$Label property"
    $Name = [string]$Property.name
    if ($Property.name -isnot [string] -or $Property.value -isnot [string] -or
        [string]::IsNullOrWhiteSpace($Name) -or $Map.ContainsKey($Name)) {
      throw "$Label property is empty or duplicated: $Name"
    }
    $Map[$Name] = [string]$Property.value
  }
  return $Map
}

$PackageDir = (Resolve-Path -LiteralPath $PackageDir -ErrorAction Stop).Path
if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
  $ManifestPath = Join-Path $PackageDir 'manifest.json'
}
$ManifestPath = (Resolve-Path -LiteralPath $ManifestPath -ErrorAction Stop).Path
$ManifestBoundary = [System.IO.Path]::GetFullPath($PackageDir).TrimEnd('\', '/')
if (-not $ManifestPath.StartsWith($ManifestBoundary + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'ManifestPath must stay inside PackageDir.'
}
$Manifest = Read-Json $ManifestPath 'Runtime manifest'
$Sbom = $Manifest.sbom
$SbomKeys = @(
  'schema', 'format', 'specVersion', 'path', 'sha256', 'sourceCommit', 'dirty',
  'componentCount', 'npmComponentCount', 'cargoComponentCount', 'externalComponentCount',
  'metadataPropertyCount', 'dependencyLockCount', 'toolCount', 'requiredExternalCategories',
  'externalComponents', 'dependencyLocks', 'tools'
)
Assert-ExactKeys $Sbom $SbomKeys 'Runtime manifest SBOM'
Assert-ExactKeys $Sbom.externalComponents @('path', 'sha256', 'sourceName', 'schema', 'approved', 'componentCount') 'Runtime manifest external-component evidence'

if ($Engineering) {
  if (-not [string]::IsNullOrEmpty([string]$Sbom.schema) -or
      -not [string]::IsNullOrEmpty([string]$Sbom.format) -or
      -not [string]::IsNullOrEmpty([string]$Sbom.specVersion) -or
      -not [string]::IsNullOrEmpty([string]$Sbom.path) -or
      -not [string]::IsNullOrEmpty([string]$Sbom.sha256) -or
      -not [string]::IsNullOrEmpty([string]$Sbom.sourceCommit) -or
      $null -ne $Sbom.dirty -or
      @($Sbom.requiredExternalCategories).Count -ne 0 -or
      @($Sbom.dependencyLocks).Count -ne 0 -or
      @($Sbom.tools).Count -ne 0 -or
      -not [string]::IsNullOrEmpty([string]$Sbom.externalComponents.path) -or
      -not [string]::IsNullOrEmpty([string]$Sbom.externalComponents.sha256) -or
      -not [string]::IsNullOrEmpty([string]$Sbom.externalComponents.sourceName) -or
      -not [string]::IsNullOrEmpty([string]$Sbom.externalComponents.schema) -or
      $null -ne $Sbom.externalComponents.approved) {
    throw 'Engineering package must not claim formal SBOM evidence.'
  }
  foreach ($Value in @(
    $Sbom.componentCount, $Sbom.npmComponentCount, $Sbom.cargoComponentCount,
    $Sbom.externalComponentCount, $Sbom.metadataPropertyCount, $Sbom.dependencyLockCount,
    $Sbom.toolCount, $Sbom.externalComponents.componentCount
  )) {
    Assert-JsonInteger $Value 'Engineering SBOM count'
    if ([int]$Value -ne 0) { throw 'Engineering package SBOM counts must be zero.' }
  }
  [ordered]@{
    schema = 'steel.packaged-release-sbom-verification.v1'
    code = 0
    packageClass = 'engineering'
    componentCount = 0
    externalComponentCount = 0
  } | ConvertTo-Json -Depth 4
  return
}

$ExpectedExternalComponentsSha256 = $ExpectedExternalComponentsSha256.Trim().ToLowerInvariant()
if ($ExpectedExternalComponentsSha256 -notmatch '^[0-9a-f]{64}$') {
  throw 'Formal SBOM verification requires an out-of-band ExpectedExternalComponentsSha256.'
}
foreach ($Field in @(
  'componentCount', 'npmComponentCount', 'cargoComponentCount', 'externalComponentCount',
  'metadataPropertyCount', 'dependencyLockCount', 'toolCount'
)) {
  Assert-JsonInteger $Sbom.$Field "SBOM $Field"
}
$RequiredCategories = @('cpp-toolchain', 'camera-sdk', 'vc-runtime', 'webview2-runtime', 'wix-toolset', 'nsis')
if ([string]$Sbom.schema -cne 'steel.release-sbom.cyclonedx.v1' -or
    [string]$Sbom.format -cne 'CycloneDX' -or
    [string]$Sbom.specVersion -cne '1.5' -or
    [string]$Sbom.path -cne 'build-evidence/steel-release-sbom.cdx.json' -or
    [string]$Sbom.sha256 -notmatch '^[0-9a-f]{64}$' -or
    [string]$Sbom.sourceCommit -cne [string]$Manifest.source.gitCommit -or
    $Sbom.dirty -isnot [bool] -or $Sbom.dirty -ne $false -or
    [int]$Sbom.componentCount -lt 6 -or
    [int]$Sbom.externalComponentCount -lt 6 -or
    [int]$Sbom.metadataPropertyCount -ne 22 -or
    [int]$Sbom.dependencyLockCount -ne 4 -or
    [int]$Sbom.toolCount -ne 3 -or
    $Sbom.requiredExternalCategories -isnot [System.Array] -or
    (@($Sbom.requiredExternalCategories) -join "`n") -cne ($RequiredCategories -join "`n") -or
    $Sbom.dependencyLocks -isnot [System.Array] -or
    $Sbom.tools -isnot [System.Array]) {
  throw 'Formal package SBOM manifest metadata is incomplete or inconsistent.'
}

$SbomPath = Resolve-PackageFile ([string]$Sbom.path) 'CycloneDX SBOM'
if ((Get-LowerSha256 $SbomPath) -cne [string]$Sbom.sha256) {
  throw 'Packaged CycloneDX SBOM SHA-256 does not match the manifest.'
}
$Bom = Read-Json $SbomPath 'CycloneDX SBOM'
Assert-ExactKeys $Bom @('$schema', 'bomFormat', 'specVersion', 'serialNumber', 'version', 'metadata', 'components', 'dependencies') 'CycloneDX SBOM'
if ($Bom.'$schema' -isnot [string] -or $Bom.bomFormat -isnot [string] -or
    $Bom.specVersion -isnot [string] -or $Bom.serialNumber -isnot [string] -or
    [string]$Bom.'$schema' -cne 'http://cyclonedx.org/schema/bom-1.5.schema.json' -or
    [string]$Bom.bomFormat -cne 'CycloneDX' -or
    [string]$Bom.specVersion -cne '1.5' -or
    $Bom.version -isnot [int] -or [int]$Bom.version -ne 1 -or
    [string]$Bom.serialNumber -notmatch '^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$') {
  throw 'Packaged SBOM does not declare deterministic CycloneDX 1.5.'
}
Assert-ExactKeys $Bom.metadata @('timestamp', 'tools', 'component', 'properties') 'CycloneDX metadata'
if ($Bom.metadata.timestamp -isnot [string] -or
    [string]$Bom.metadata.timestamp -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' -or
    $Bom.metadata.properties -isnot [System.Array]) {
  throw 'Packaged SBOM timestamp is not canonical UTC evidence.'
}
Assert-ExactKeys $Bom.metadata.tools @('components') 'CycloneDX tools'
$GeneratorTools = @($Bom.metadata.tools.components)
$GeneratorToolMap = @{}
foreach ($Tool in $GeneratorTools) {
  Assert-ExactKeys $Tool @('type', 'name', 'version') 'CycloneDX generator tool'
  $Name = [string]$Tool.name
  if ($Tool.type -isnot [string] -or $Tool.name -isnot [string] -or $Tool.version -isnot [string] -or
      [string]$Tool.type -cne 'application' -or [string]::IsNullOrWhiteSpace($Name) -or
      [string]::IsNullOrWhiteSpace([string]$Tool.version) -or $GeneratorToolMap.ContainsKey($Name)) {
    throw "CycloneDX generator tool is invalid or duplicated: $Name"
  }
  $GeneratorToolMap[$Name] = [string]$Tool.version
}
if ($Bom.metadata.tools.components -isnot [System.Array] -or $GeneratorTools.Count -ne 3 -or
    (@($GeneratorToolMap.Keys | Sort-Object) -join "`n") -cne ((@('Git', 'PowerShell', 'generate-release-sbom.ps1') | Sort-Object) -join "`n") -or
    [string]$GeneratorToolMap['generate-release-sbom.ps1'] -cne '1.0.0' -or
    [string]$GeneratorToolMap['PowerShell'] -notmatch '^\d+\.\d+' -or
    [string]$GeneratorToolMap['Git'] -notmatch '^git version \S+') {
  throw 'CycloneDX generator tool inventory is incomplete or malformed.'
}
$ExpectedGeneratorToolOrder = @('generate-release-sbom.ps1', 'PowerShell', 'Git')
if ((@($GeneratorTools | ForEach-Object { [string]$_.name }) -join "`n") -cne ($ExpectedGeneratorToolOrder -join "`n")) {
  throw 'CycloneDX generator tool order is not canonical.'
}

$MetadataProperties = @($Bom.metadata.properties)
$MetadataMap = Get-PropertyMap $MetadataProperties 'CycloneDX metadata'
$ExpectedMetadataNames = @(
  'steel.sbom.schema', 'steel.generator.version', 'steel.source.gitCommit', 'steel.source.dirty',
  'steel.source.commitTimestamp', 'steel.input.npm-client.path', 'steel.input.npm-client.sha256',
  'steel.input.cargo-tauri.path', 'steel.input.cargo-tauri.sha256', 'steel.input.cargo-service.path',
  'steel.input.cargo-service.sha256', 'steel.input.cargo-trigger.path', 'steel.input.cargo-trigger.sha256',
  'steel.input.external-components.path', 'steel.input.external-components.sha256',
  'steel.tool.generate.sha256', 'steel.tool.verify.sha256', 'steel.tool.common.sha256',
  'steel.component.count.npm', 'steel.component.count.cargo', 'steel.component.count.external',
  'steel.component.count.total'
)
if ($MetadataProperties.Count -ne [int]$Sbom.metadataPropertyCount -or
    (@($MetadataProperties | ForEach-Object { [string]$_.name }) -join "`n") -cne ($ExpectedMetadataNames -join "`n") -or
    [string]$MetadataMap['steel.sbom.schema'] -cne [string]$Sbom.schema -or
    [string]$MetadataMap['steel.generator.version'] -cne '1.0.0' -or
    [string]$MetadataMap['steel.source.gitCommit'] -cne [string]$Manifest.source.gitCommit -or
    [string]$MetadataMap['steel.source.dirty'] -cne 'false' -or
    [string]$MetadataMap['steel.source.commitTimestamp'] -cne [string]$Bom.metadata.timestamp) {
  throw 'CycloneDX metadata properties do not bind the clean source commit.'
}

$LockDefinitions = @(
  [ordered]@{ id = 'npm-client'; source = 'app/client/package-lock.json'; evidence = 'build-evidence/client-package-lock.json' },
  [ordered]@{ id = 'cargo-tauri'; source = 'app/client/src-tauri/Cargo.lock'; evidence = 'build-evidence/tauri-Cargo.lock' },
  [ordered]@{ id = 'cargo-service'; source = 'app/service/Cargo.lock'; evidence = 'build-evidence/service-Cargo.lock' },
  [ordered]@{ id = 'cargo-trigger'; source = 'app/trigger/Cargo.lock'; evidence = 'build-evidence/trigger-Cargo.lock' }
)
$Locks = @($Sbom.dependencyLocks)
if ($Locks.Count -ne 4) { throw 'SBOM must bind exactly four dependency locks.' }
if ((@($Locks | ForEach-Object { [string]$_.id }) -join "`n") -cne (@($LockDefinitions | ForEach-Object { [string]$_.id }) -join "`n")) {
  throw 'SBOM dependency lock evidence order is not canonical.'
}
foreach ($Definition in $LockDefinitions) {
  $Lock = @($Locks | Where-Object { [string]$_.id -ceq [string]$Definition.id })
  if ($Lock.Count -ne 1) { throw "Missing or duplicate SBOM lock: $($Definition.id)" }
  Assert-ExactKeys $Lock[0] @('id', 'sourcePath', 'evidencePath', 'sha256') 'SBOM dependency lock'
  if ($Lock[0].id -isnot [string] -or $Lock[0].sourcePath -isnot [string] -or
      $Lock[0].evidencePath -isnot [string] -or $Lock[0].sha256 -isnot [string] -or
      [string]$Lock[0].sourcePath -cne [string]$Definition.source -or
      [string]$Lock[0].evidencePath -cne [string]$Definition.evidence -or
      [string]$Lock[0].sha256 -notmatch '^[0-9a-f]{64}$') {
    throw "SBOM lock metadata is malformed: $($Definition.id)"
  }
  $LockPath = Resolve-PackageFile ([string]$Lock[0].evidencePath) "SBOM lock $($Definition.id)"
  if ((Get-LowerSha256 $LockPath) -cne [string]$Lock[0].sha256 -or
      [string]$MetadataMap["steel.input.$($Definition.id).path"] -cne [string]$Definition.source -or
      [string]$MetadataMap["steel.input.$($Definition.id).sha256"] -cne [string]$Lock[0].sha256) {
    throw "SBOM lock hash binding failed: $($Definition.id)"
  }
}

$ToolDefinitions = @(
  [ordered]@{ id = 'generate'; name = 'generate-release-sbom.ps1'; path = 'build-evidence/sbom-tools/generate-release-sbom.ps1'; property = 'steel.tool.generate.sha256' },
  [ordered]@{ id = 'verify'; name = 'verify-release-sbom.ps1'; path = 'build-evidence/sbom-tools/verify-release-sbom.ps1'; property = 'steel.tool.verify.sha256' },
  [ordered]@{ id = 'common'; name = 'release-sbom-common.ps1'; path = 'build-evidence/sbom-tools/release-sbom-common.ps1'; property = 'steel.tool.common.sha256' }
)
$Tools = @($Sbom.tools)
if ($Tools.Count -ne 3) { throw 'SBOM must bind exactly three source tool files.' }
if ((@($Tools | ForEach-Object { [string]$_.id }) -join "`n") -cne (@($ToolDefinitions | ForEach-Object { [string]$_.id }) -join "`n")) {
  throw 'SBOM tool evidence order is not canonical.'
}
foreach ($Definition in $ToolDefinitions) {
  $Tool = @($Tools | Where-Object { [string]$_.id -ceq [string]$Definition.id })
  if ($Tool.Count -ne 1) { throw "Missing or duplicate SBOM tool: $($Definition.id)" }
  Assert-ExactKeys $Tool[0] @('id', 'name', 'path', 'sha256', 'metadataProperty') 'SBOM tool evidence'
  if ($Tool[0].id -isnot [string] -or $Tool[0].name -isnot [string] -or
      $Tool[0].path -isnot [string] -or $Tool[0].sha256 -isnot [string] -or
      $Tool[0].metadataProperty -isnot [string] -or
      [string]$Tool[0].name -cne [string]$Definition.name -or
      [string]$Tool[0].path -cne [string]$Definition.path -or
      [string]$Tool[0].metadataProperty -cne [string]$Definition.property -or
      [string]$Tool[0].sha256 -notmatch '^[0-9a-f]{64}$') {
    throw "SBOM tool metadata is malformed: $($Definition.id)"
  }
  $ToolPath = Resolve-PackageFile ([string]$Tool[0].path) "SBOM tool $($Definition.id)"
  if ((Get-LowerSha256 $ToolPath) -cne [string]$Tool[0].sha256 -or
      [string]$MetadataMap[[string]$Definition.property] -cne [string]$Tool[0].sha256) {
    throw "SBOM tool hash binding failed: $($Definition.id)"
  }
}

$External = $Sbom.externalComponents
Assert-JsonInteger $External.componentCount 'External-component count'
if ($External.path -isnot [string] -or $External.sha256 -isnot [string] -or
    $External.sourceName -isnot [string] -or $External.schema -isnot [string] -or
    $External.approved -isnot [bool] -or
    [string]$External.path -cne 'build-evidence/external-components.json' -or
    [string]$External.sha256 -cne $ExpectedExternalComponentsSha256 -or
    [string]$External.schema -cne 'steel.release-external-components.v1' -or
    $External.approved -ne $true -or
    [int]$External.componentCount -ne [int]$Sbom.externalComponentCount -or
    [string]$External.sourceName -notmatch '^[^\\/:\x00-\x1f]+\.json$' -or
    [string]$MetadataMap['steel.input.external-components.path'] -cne "external:$([string]$External.sourceName)" -or
    [string]$MetadataMap['steel.input.external-components.sha256'] -cne $ExpectedExternalComponentsSha256) {
  throw 'SBOM external policy does not match the out-of-band approved hash.'
}
$ExternalPath = Resolve-PackageFile ([string]$External.path) 'External-component policy'
if ((Get-LowerSha256 $ExternalPath) -cne $ExpectedExternalComponentsSha256) {
  throw 'External-component policy evidence hash mismatch.'
}
$Policy = Read-Json $ExternalPath 'External-component policy'
$PolicyKeys = @($Policy.PSObject.Properties.Name)
if (@($PolicyKeys | Where-Object { $_ -cnotin @('$schema', 'schema', 'approved', 'components') }).Count -gt 0 -or
    $PolicyKeys -cnotcontains 'schema' -or $PolicyKeys -cnotcontains 'approved' -or
    $PolicyKeys -cnotcontains 'components' -or
    $Policy.schema -isnot [string] -or $Policy.approved -isnot [bool] -or
    $Policy.components -isnot [System.Array] -or
    [string]$Policy.schema -cne 'steel.release-external-components.v1' -or $Policy.approved -ne $true) {
  throw 'External-component policy schema or approval state is invalid.'
}
$Rows = @($Policy.components)
if ($Rows.Count -ne [int]$External.componentCount) {
  throw 'External-component policy count does not match the SBOM manifest.'
}
$Ids = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
$Categories = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach ($Row in $Rows) {
  $Allowed = @('id', 'category', 'type', 'name', 'version', 'supplier', 'scope', 'artifact', 'sha256', 'purl', 'licenses')
  $Required = @('id', 'category', 'type', 'name', 'version', 'supplier', 'scope', 'artifact', 'sha256', 'purl')
  $Keys = @($Row.PSObject.Properties.Name)
  if (@($Keys | Where-Object { $Allowed -cnotcontains $_ }).Count -gt 0 -or
      @($Required | Where-Object { $Keys -cnotcontains $_ }).Count -gt 0) {
    throw 'External-component entry fields are not the approved schema.'
  }
  $Id = [string]$Row.id
  $Category = [string]$Row.category
  $Identity = @([string]$Row.name, [string]$Row.version, [string]$Row.supplier, [string]$Row.artifact)
  if ($Row.id -isnot [string] -or $Row.category -isnot [string] -or
      $Row.type -isnot [string] -or $Row.name -isnot [string] -or
      $Row.version -isnot [string] -or $Row.supplier -isnot [string] -or
      $Row.scope -isnot [string] -or $Row.artifact -isnot [string] -or
      $Row.sha256 -isnot [string] -or $Row.purl -isnot [string] -or
      $Id -notmatch '^[a-z0-9][a-z0-9._-]*$' -or -not $Ids.Add($Id) -or
      $RequiredCategories -cnotcontains $Category -or
      [string]$Row.type -cnotin @('application', 'framework', 'library') -or
      [string]$Row.scope -cnotin @('build', 'runtime') -or
      [string]$Row.sha256 -notmatch '^[0-9A-Fa-f]{64}$' -or
      ([string]$Row.sha256).ToLowerInvariant() -ceq ('0' * 64) -or
      [string]$Row.purl -notmatch '^pkg:\S+$' -or
      @($Identity | Where-Object { [string]::IsNullOrWhiteSpace($_) -or $_ -match '(?i)todo|tbd|unknown|pending|required|replace' }).Count -gt 0) {
    throw "External-component identity is invalid: $Id"
  }
  if ($Keys -ccontains 'licenses') {
    if ($Row.licenses -isnot [System.Array] -or @($Row.licenses).Count -lt 1) {
      throw "External-component licenses must be a non-empty JSON array: $Id"
    }
    $LicenseSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($License in @($Row.licenses)) {
      if ($License -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$License) -or -not $LicenseSet.Add([string]$License)) {
        throw "External-component licenses must contain unique non-empty strings: $Id"
      }
    }
  }
  [void]$Categories.Add($Category)
}
if ((@($Categories | Sort-Object) -join "`n") -cne (@($RequiredCategories | Sort-Object) -join "`n")) {
  throw 'External-component policy does not cover all six required categories.'
}

$CameraSdkPath = Resolve-PackageFile ([string]$Manifest.capture.sdk) 'Packaged camera SDK'
$CameraSdkName = [System.IO.Path]::GetFileName($CameraSdkPath)
$CameraSdkHash = Get-LowerSha256 $CameraSdkPath
$CameraPolicyMatches = @($Rows | Where-Object {
  [string]$_.category -ceq 'camera-sdk' -and
  [System.IO.Path]::GetFileName([string]$_.artifact) -ceq $CameraSdkName -and
  ([string]$_.sha256).ToLowerInvariant() -ceq $CameraSdkHash
})
if ($CameraPolicyMatches.Count -ne 1) {
  throw 'Approved camera-sdk artifact name/hash does not uniquely match the packaged SDK DLL.'
}

$VcRuntimePath = Resolve-PackageFile ([string]$Manifest.desktop.vcRuntimePrerequisite) 'Packaged VC runtime'
$VcRuntimeName = [System.IO.Path]::GetFileName($VcRuntimePath)
$VcRuntimeHash = Get-LowerSha256 $VcRuntimePath
$VcPolicyMatches = @($Rows | Where-Object {
  [string]$_.category -ceq 'vc-runtime' -and
  [System.IO.Path]::GetFileName([string]$_.artifact) -ceq $VcRuntimeName -and
  ([string]$_.sha256).ToLowerInvariant() -ceq $VcRuntimeHash
})
if ($VcPolicyMatches.Count -ne 1) {
  throw 'Approved vc-runtime artifact name/hash does not uniquely match the packaged prerequisite.'
}

$BundleManifestPath = Resolve-PackageFile ([string]$Manifest.build.bundleToolchain.path) 'Bundle toolchain manifest'
$BundleManifest = Read-Json $BundleManifestPath 'Bundle toolchain manifest'
$BundleComponentMap = @{}
foreach ($Component in @($BundleManifest.components)) {
  $BundleComponentMap[[string]$Component.id] = [string]$Component.version
}
foreach ($Mapping in @(
  [ordered]@{ category = 'webview2-runtime'; component = 'webview2-offline' },
  [ordered]@{ category = 'wix-toolset'; component = 'wix' },
  [ordered]@{ category = 'nsis'; component = 'nsis' }
)) {
  if (-not $BundleComponentMap.ContainsKey([string]$Mapping.component)) {
    throw "Bundle toolchain evidence is missing component: $($Mapping.component)"
  }
  $Matches = @()
  foreach ($Row in @($Rows | Where-Object { [string]$_.category -ceq [string]$Mapping.category })) {
    $ArtifactName = [System.IO.Path]::GetFileName([string]$Row.artifact)
    $FileMatches = @($BundleManifest.files | Where-Object {
      [string]$_.component -ceq [string]$Mapping.component -and
      [System.IO.Path]::GetFileName([string]$_.path) -ceq $ArtifactName -and
      [string]$_.sha256 -ceq ([string]$Row.sha256).ToLowerInvariant()
    })
    if ([string]$Row.version -ceq [string]$BundleComponentMap[[string]$Mapping.component] -and $FileMatches.Count -eq 1) {
      $Matches += ,$Row
    }
  }
  if ($Matches.Count -ne 1) {
    throw "Approved $($Mapping.category) version/artifact/hash does not uniquely match bundle-toolchain evidence."
  }
}

$Components = @($Bom.components)
if ($Bom.components -isnot [System.Array] -or $Components.Count -ne [int]$Sbom.componentCount) {
  throw 'CycloneDX component count does not match the SBOM manifest.'
}
$ComponentRefOrder = @($Components | ForEach-Object { [string]$_.'bom-ref' })
if (($ComponentRefOrder -join "`n") -cne (@($ComponentRefOrder | Sort-Object) -join "`n")) {
  throw 'CycloneDX component inventory order is not canonical by bom-ref.'
}
$Refs = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
$ExternalComponents = @{}
foreach ($Component in $Components) {
  $Ref = [string]$Component.'bom-ref'
  if ([string]::IsNullOrWhiteSpace($Ref) -or -not $Refs.Add($Ref)) {
    throw "CycloneDX component reference is empty or duplicated: $Ref"
  }
  $ComponentProperties = Get-PropertyMap @($Component.properties) "CycloneDX component $Ref"
  if ([string]$ComponentProperties['steel.ecosystem'] -ceq 'external') {
    if (-not $Ref.StartsWith('external:', [System.StringComparison]::Ordinal) -or $ExternalComponents.ContainsKey($Ref)) {
      throw "CycloneDX external component reference is invalid: $Ref"
    }
    $ExternalComponents[$Ref] = [pscustomobject]@{ component = $Component; properties = $ComponentProperties }
  }
}
if ($ExternalComponents.Count -ne [int]$Sbom.externalComponentCount) {
  throw 'CycloneDX external count does not match the approved policy.'
}
foreach ($Row in $Rows) {
  $Ref = "external:$([string]$Row.id)"
  if (-not $ExternalComponents.ContainsKey($Ref)) {
    throw "CycloneDX is missing approved external component: $Ref"
  }
  $Entry = $ExternalComponents[$Ref]
  $Component = $Entry.component
  $Hashes = @($Component.hashes | Where-Object { [string]$_.alg -ceq 'SHA-256' })
  if ([string]$Component.type -cne [string]$Row.type -or
      [string]$Component.name -cne [string]$Row.name -or
      [string]$Component.version -cne [string]$Row.version -or
      [string]$Component.supplier.name -cne [string]$Row.supplier -or
      [string]$Component.purl -cne [string]$Row.purl -or
      $Hashes.Count -ne 1 -or
      [string]$Hashes[0].content -cne ([string]$Row.sha256).ToLowerInvariant() -or
      [string]$Entry.properties['steel.external.category'] -cne [string]$Row.category -or
      [string]$Entry.properties['steel.external.scope'] -cne [string]$Row.scope -or
      [string]$Entry.properties['steel.external.artifact'] -cne [string]$Row.artifact) {
    throw "CycloneDX external component does not match policy: $Ref"
  }
}

foreach ($CountProperty in @(
  'steel.component.count.npm', 'steel.component.count.cargo',
  'steel.component.count.external', 'steel.component.count.total'
)) {
  if ([string]$MetadataMap[$CountProperty] -notmatch '^(0|[1-9]\d*)$') {
    throw "CycloneDX count property is invalid: $CountProperty"
  }
}
if ([int]$MetadataMap['steel.component.count.npm'] -ne [int]$Sbom.npmComponentCount -or
    [int]$MetadataMap['steel.component.count.cargo'] -ne [int]$Sbom.cargoComponentCount -or
    [int]$MetadataMap['steel.component.count.external'] -ne [int]$Sbom.externalComponentCount -or
    [int]$MetadataMap['steel.component.count.total'] -ne [int]$Sbom.componentCount -or
    [int]$Sbom.npmComponentCount + [int]$Sbom.cargoComponentCount + [int]$Sbom.externalComponentCount -ne [int]$Sbom.componentCount) {
  throw 'CycloneDX component counts are inconsistent.'
}

Assert-ExactKeys $Bom.metadata.component @('type', 'bom-ref', 'name', 'version', 'properties') 'CycloneDX root component'
$RootProperties = Get-PropertyMap @($Bom.metadata.component.properties) 'CycloneDX root component'
if ([string]$Bom.metadata.component.type -cne 'application' -or
    [string]$Bom.metadata.component.version -cne [string]$Manifest.releaseVersion -or
    $RootProperties.Count -ne 1 -or
    [string]$RootProperties['steel.source.gitCommit'] -cne [string]$Manifest.source.gitCommit) {
  throw 'CycloneDX root component does not bind the release version and commit.'
}
$Dependencies = @($Bom.dependencies)
if ($Bom.dependencies -isnot [System.Array] -or $Dependencies.Count -ne 1) { throw 'CycloneDX must contain one release-root dependency entry.' }
Assert-ExactKeys $Dependencies[0] @('ref', 'dependsOn') 'CycloneDX root dependency'
if ([string]$Dependencies[0].ref -cne [string]$Bom.metadata.component.'bom-ref' -or
    $Dependencies[0].dependsOn -isnot [System.Array] -or
    (@($Dependencies[0].dependsOn) -join "`n") -cne (@($Refs | Sort-Object) -join "`n")) {
  throw 'CycloneDX dependency graph does not bind every component to the release root.'
}

$InputHashes = @{}
foreach ($Lock in $Locks) { $InputHashes[[string]$Lock.id] = [string]$Lock.sha256 }
$InputHashes['external-components'] = $ExpectedExternalComponentsSha256
$InputSeed = (@($InputHashes.Keys | Sort-Object) | ForEach-Object { "$_`:$($InputHashes[$_])" }) -join '|'
$ToolHashMap = @{}
foreach ($Tool in $Tools) { $ToolHashMap[[string]$Tool.id] = [string]$Tool.sha256 }
$Seed = @(
  [string]$Manifest.source.gitCommit,
  $InputSeed,
  "generator:$($ToolHashMap['generate'])",
  "verifier:$($ToolHashMap['verify'])",
  "common:$($ToolHashMap['common'])",
  "powershell:$([string]$GeneratorToolMap['PowerShell'])",
  "git:$([string]$GeneratorToolMap['Git'])",
  'schema:steel.release-sbom.cyclonedx.v1',
  'generator-version:1.0.0'
) -join '|'
$Algorithm = [System.Security.Cryptography.SHA256]::Create()
try {
  $SeedHash = -join ($Algorithm.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Seed)) | ForEach-Object { $_.ToString('x2') })
} finally {
  $Algorithm.Dispose()
}
$UuidChars = $SeedHash.Substring(0, 32).ToCharArray()
$UuidChars[12] = '5'
$UuidChars[16] = '8'
$Uuid = -join $UuidChars
$ExpectedSerial = "urn:uuid:$($Uuid.Substring(0,8))-$($Uuid.Substring(8,4))-$($Uuid.Substring(12,4))-$($Uuid.Substring(16,4))-$($Uuid.Substring(20,12))"
if ([string]$Bom.serialNumber -cne $ExpectedSerial) {
  throw 'CycloneDX serialNumber is not deterministically bound to commit, locks, policy, tools, and generator environment.'
}

[ordered]@{
  schema = 'steel.packaged-release-sbom-verification.v1'
  code = 0
  packageClass = 'formal-release'
  sourceCommit = [string]$Manifest.source.gitCommit
  sbomSha256 = [string]$Sbom.sha256
  componentCount = $Components.Count
  externalComponentCount = $ExternalComponents.Count
  categoryCount = $Categories.Count
  dependencyLockCount = $Locks.Count
  toolCount = $Tools.Count
  metadataPropertyCount = $MetadataProperties.Count
} | ConvertTo-Json -Depth 4
