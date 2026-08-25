$script:SteelSbomGeneratorVersion = '1.0.0'
$script:SteelSbomSchema = 'steel.release-sbom.cyclonedx.v1'
$script:SteelExternalComponentsSchema = 'steel.release-external-components.v1'
$script:CycloneDxSpecVersion = '1.5'

function Read-JsonDictionary {
  param([Parameter(Mandatory = $true)][string]$Path)

  $Text = Get-Content -LiteralPath $Path -Raw -Encoding utf8
  if ([string]::IsNullOrWhiteSpace($Text)) {
    throw "JSON input is empty: $Path"
  }

  $ConvertCommand = Get-Command ConvertFrom-Json -ErrorAction Stop
  if ($ConvertCommand.Parameters.ContainsKey('AsHashtable')) {
    try {
      $ConvertParameters = @{ AsHashtable = $true; Depth = 100 }
      if ($ConvertCommand.Parameters.ContainsKey('DateKind')) {
        $ConvertParameters['DateKind'] = 'String'
      }
      return $Text | ConvertFrom-Json @ConvertParameters
    } catch {
      throw "JSON input is invalid: $Path ($($_.Exception.Message))"
    }
  }

  try {
    Add-Type -AssemblyName System.Web.Extensions -ErrorAction Stop
    $Serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $Serializer.MaxJsonLength = [int]::MaxValue
    $Serializer.RecursionLimit = 1024
    return $Serializer.DeserializeObject($Text)
  } catch {
    throw "JSON input is invalid: $Path ($($_.Exception.Message))"
  }
}

function Get-DictionaryValue {
  param(
    [Parameter(Mandatory = $true)]$Dictionary,
    [Parameter(Mandatory = $true)][string]$Key,
    [switch]$Required
  )

  if ($Dictionary -is [System.Collections.IDictionary]) {
    $HasKey = if ($null -ne $Dictionary.PSObject.Methods['ContainsKey']) {
      $Dictionary.ContainsKey($Key)
    } else {
      $Dictionary.Contains($Key)
    }
    if ($HasKey) { return $Dictionary[$Key] }
  }
  if ($Required) {
    throw "Required JSON field is missing: $Key"
  }
  return $null
}

function Assert-JsonObjectKeys {
  param(
    [Parameter(Mandatory = $true)]$Dictionary,
    [Parameter(Mandatory = $true)][string[]]$Allowed,
    [Parameter(Mandatory = $true)][string[]]$Required,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if ($Dictionary -isnot [System.Collections.IDictionary]) {
    throw "$Label must be a JSON object."
  }
  $Actual = @($Dictionary.Keys | ForEach-Object { [string]$_ })
  $Unexpected = @($Actual | Where-Object { $Allowed -cnotcontains $_ })
  $Missing = @($Required | Where-Object { $Actual -cnotcontains $_ })
  if ($Unexpected.Count -gt 0 -or $Missing.Count -gt 0) {
    throw "$Label fields are not the exact schema. missing=$($Missing -join ',') unexpected=$($Unexpected -join ',')"
  }
}

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)

  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-StringSha256Hex {
  param([Parameter(Mandatory = $true)][string]$Value)

  $Bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
  $Algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    return -join ($Algorithm.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') })
  } finally {
    $Algorithm.Dispose()
  }
}

function Convert-BytesToHex {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)

  return -join ($Bytes | ForEach-Object { $_.ToString('x2') })
}

function Convert-SriToCycloneDxHash {
  param(
    [Parameter(Mandatory = $true)][string]$Integrity,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $Candidates = @($Integrity -split '\s+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  foreach ($Preferred in @('sha512', 'sha384', 'sha256', 'sha1')) {
    $Candidate = @($Candidates | Where-Object { $_ -match "^$Preferred-[A-Za-z0-9+/=]+$" } | Select-Object -First 1)
    if ($Candidate.Count -eq 0) { continue }
    $Parts = [string]$Candidate[0] -split '-', 2
    try {
      $Digest = [Convert]::FromBase64String($Parts[1])
    } catch {
      throw "npm integrity is not valid base64 for $Label"
    }
    $ExpectedLength = @{
      sha512 = 64
      sha384 = 48
      sha256 = 32
      sha1 = 20
    }[$Preferred]
    if ($Digest.Length -ne $ExpectedLength) {
      throw "npm integrity has the wrong digest length for $Label"
    }
    $CycloneAlgorithm = @{
      sha512 = 'SHA-512'
      sha384 = 'SHA-384'
      sha256 = 'SHA-256'
      sha1 = 'SHA-1'
    }[$Preferred]
    return [ordered]@{
      alg = $CycloneAlgorithm
      content = Convert-BytesToHex $Digest
    }
  }
  throw "npm package has no supported locked integrity digest: $Label"
}

function ConvertTo-PurlName {
  param([Parameter(Mandatory = $true)][string]$Name)

  return [Uri]::EscapeDataString($Name).Replace('%2F', '/').Replace('%2f', '/')
}

function Get-NpmPackageNameFromPath {
  param([Parameter(Mandatory = $true)][string]$PackagePath)

  $Normalized = $PackagePath.Replace('\', '/')
  $Marker = 'node_modules/'
  $Index = $Normalized.LastIndexOf($Marker, [System.StringComparison]::Ordinal)
  if ($Index -lt 0) {
    throw "Unsupported npm lock package path: $PackagePath"
  }
  $Name = $Normalized.Substring($Index + $Marker.Length)
  if ([string]::IsNullOrWhiteSpace($Name) -or $Name.Contains('/node_modules/')) {
    throw "Cannot derive npm package name from lock path: $PackagePath"
  }
  return $Name
}

function Get-NpmInventory {
  param([Parameter(Mandatory = $true)][string]$LockPath)

  $Lock = Read-JsonDictionary $LockPath
  $LockfileVersion = [int](Get-DictionaryValue $Lock 'lockfileVersion' -Required)
  if ($LockfileVersion -notin @(2, 3)) {
    throw "Unsupported npm lockfileVersion=$LockfileVersion; only lockfile v2/v3 is accepted."
  }
  $Packages = Get-DictionaryValue $Lock 'packages' -Required
  if ($Packages -isnot [System.Collections.IDictionary]) {
    throw 'npm lock packages field must be an object.'
  }
  $HasRootPackage = if ($null -ne $Packages.PSObject.Methods['ContainsKey']) {
    $Packages.ContainsKey('')
  } else {
    $Packages.Contains('')
  }
  if (-not $HasRootPackage) {
    throw 'npm lock must contain the root packages entry.'
  }
  $RootPackage = $Packages['']
  $RootName = [string](Get-DictionaryValue $RootPackage 'name' -Required)
  $RootVersion = [string](Get-DictionaryValue $RootPackage 'version' -Required)
  if ($RootName -notmatch '^[A-Za-z0-9@._/-]+$' -or [string]::IsNullOrWhiteSpace($RootVersion)) {
    throw 'npm root package identity is invalid.'
  }

  $Aggregated = @{}
  foreach ($PackagePath in @($Packages.Keys | Sort-Object)) {
    if ([string]$PackagePath -eq '') { continue }
    $Entry = $Packages[$PackagePath]
    if ($Entry -isnot [System.Collections.IDictionary]) {
      throw "npm lock package entry is not an object: $PackagePath"
    }
    $Name = Get-NpmPackageNameFromPath ([string]$PackagePath)
    $Version = [string](Get-DictionaryValue $Entry 'version' -Required)
    $Integrity = [string](Get-DictionaryValue $Entry 'integrity' -Required)
    if ([string]::IsNullOrWhiteSpace($Version)) {
      throw "npm package version is empty: $PackagePath"
    }
    $Hash = Convert-SriToCycloneDxHash -Integrity $Integrity -Label $PackagePath
    $Key = "$Name|$Version|$($Hash.alg)|$($Hash.content)"
    if (-not $Aggregated.ContainsKey($Key)) {
      $Aggregated[$Key] = [ordered]@{
        name = $Name
        version = $Version
        hash = $Hash
        origins = New-Object System.Collections.Generic.List[string]
        developmentOnly = $true
        license = ''
      }
    }
    $Record = $Aggregated[$Key]
    $Record.origins.Add(([string]$PackagePath).Replace('\', '/'))
    $DevValue = Get-DictionaryValue $Entry 'dev'
    if ($DevValue -ne $true) { $Record.developmentOnly = $false }
    $License = [string](Get-DictionaryValue $Entry 'license')
    if (-not [string]::IsNullOrWhiteSpace($License)) {
      if (-not [string]::IsNullOrWhiteSpace([string]$Record.license) -and [string]$Record.license -cne $License) {
        throw "npm package has conflicting license evidence: $Name@$Version"
      }
      $Record.license = $License
    }
  }

  $Components = @()
  foreach ($Record in @($Aggregated.Values | Sort-Object { $_.name }, { $_.version }, { $_.hash.content })) {
    $FullName = [string]$Record.name
    $Group = ''
    $SimpleName = $FullName
    if ($FullName.StartsWith('@') -and $FullName.Contains('/')) {
      $Slash = $FullName.IndexOf('/')
      $Group = $FullName.Substring(0, $Slash)
      $SimpleName = $FullName.Substring($Slash + 1)
    }
    $Purl = "pkg:npm/$(ConvertTo-PurlName $FullName)@$($Record.version)"
    $Properties = @(
      [ordered]@{ name = 'steel.ecosystem'; value = 'npm' },
      [ordered]@{ name = 'steel.lock.origins'; value = (@($Record.origins | Sort-Object -Unique) -join ',') },
      [ordered]@{ name = 'steel.npm.developmentOnly'; value = ([string][bool]$Record.developmentOnly).ToLowerInvariant() }
    )
    $Component = [ordered]@{
      type = 'library'
      'bom-ref' = $Purl
      name = $SimpleName
      version = [string]$Record.version
      scope = 'required'
      hashes = @($Record.hash)
      purl = $Purl
      properties = $Properties
    }
    if (-not [string]::IsNullOrWhiteSpace($Group)) { $Component['group'] = $Group }
    if (-not [string]::IsNullOrWhiteSpace([string]$Record.license)) {
      $Component['licenses'] = @([ordered]@{ expression = [string]$Record.license })
    }
    $Components += ,$Component
  }

  return [ordered]@{
    rootName = $RootName
    rootVersion = $RootVersion
    lockfileVersion = $LockfileVersion
    components = $Components
  }
}

function Unescape-BasicTomlString {
  param([Parameter(Mandatory = $true)][string]$Value)

  try {
    return [System.Text.RegularExpressions.Regex]::Unescape($Value)
  } catch {
    throw "Unsupported TOML string escape: $Value"
  }
}

function Get-CargoInventory {
  param(
    [Parameter(Mandatory = $true)][string]$LockPath,
    [Parameter(Mandatory = $true)][string]$Origin
  )

  $Text = Get-Content -LiteralPath $LockPath -Raw -Encoding utf8
  if ($Text -notmatch '(?m)^version\s*=\s*(3|4)\s*$') {
    throw "Cargo lock must declare supported format version 3 or 4: $Origin"
  }
  $Blocks = [regex]::Split($Text, '(?m)^\[\[package\]\]\s*$')
  if ($Blocks.Count -lt 2) {
    throw "Cargo lock has no package entries: $Origin"
  }
  $Records = @()
  foreach ($Block in @($Blocks | Select-Object -Skip 1)) {
    $NameMatch = [regex]::Match($Block, '(?m)^name\s*=\s*"((?:\\.|[^"])*)"\s*$')
    $VersionMatch = [regex]::Match($Block, '(?m)^version\s*=\s*"((?:\\.|[^"])*)"\s*$')
    if (-not $NameMatch.Success -or -not $VersionMatch.Success) {
      throw "Cargo package identity is malformed in $Origin"
    }
    $Name = Unescape-BasicTomlString $NameMatch.Groups[1].Value
    $Version = Unescape-BasicTomlString $VersionMatch.Groups[1].Value
    if ($Name -notmatch '^[A-Za-z0-9_.+-]+$' -or [string]::IsNullOrWhiteSpace($Version)) {
      throw "Cargo package identity is unsupported in ${Origin}: $Name@$Version"
    }
    $SourceMatch = [regex]::Match($Block, '(?m)^source\s*=\s*"((?:\\.|[^"])*)"\s*$')
    $ChecksumMatch = [regex]::Match($Block, '(?m)^checksum\s*=\s*"([0-9a-fA-F]+)"\s*$')
    $Source = if ($SourceMatch.Success) { Unescape-BasicTomlString $SourceMatch.Groups[1].Value } else { 'workspace' }
    $Checksum = if ($ChecksumMatch.Success) { $ChecksumMatch.Groups[1].Value.ToLowerInvariant() } else { '' }
    if ($Source.StartsWith('registry+', [System.StringComparison]::Ordinal) -and $Checksum -notmatch '^[0-9a-f]{64}$') {
      throw "Registry Cargo package is missing a SHA-256 checksum: $Name@$Version ($Origin)"
    }
    if ($Source -ne 'workspace' -and -not $Source.StartsWith('registry+', [System.StringComparison]::Ordinal) -and -not $Source.StartsWith('git+', [System.StringComparison]::Ordinal)) {
      throw "Cargo package uses an unsupported source: $Name@$Version ($Source)"
    }
    if ($Source.StartsWith('git+', [System.StringComparison]::Ordinal) -and $Source -notmatch '#[0-9a-fA-F]{7,64}$') {
      throw "Git Cargo dependency is not pinned to a commit: $Name@$Version"
    }
    $Records += ,[ordered]@{
      name = $Name
      version = $Version
      source = $Source
      checksum = $Checksum
      origin = $Origin
    }
  }
  return $Records
}

function Merge-CargoInventories {
  param([Parameter(Mandatory = $true)][object[]]$Records)

  $Aggregated = @{}
  foreach ($Record in $Records) {
    $Key = "$($Record.name)|$($Record.version)|$($Record.source)|$($Record.checksum)"
    if (-not $Aggregated.ContainsKey($Key)) {
      $Aggregated[$Key] = [ordered]@{
        name = [string]$Record.name
        version = [string]$Record.version
        source = [string]$Record.source
        checksum = [string]$Record.checksum
        origins = New-Object System.Collections.Generic.List[string]
      }
    }
    $Aggregated[$Key].origins.Add([string]$Record.origin)
  }

  $Components = @()
  foreach ($Record in @($Aggregated.Values | Sort-Object { $_.name }, { $_.version }, { $_.source })) {
    $SourceKey = Get-StringSha256Hex ([string]$Record.source)
    $Purl = "pkg:cargo/$(ConvertTo-PurlName ([string]$Record.name))@$($Record.version)"
    $BomRef = "cargo:$($Record.name)@$($Record.version):$($SourceKey.Substring(0, 12))"
    $Properties = @(
      [ordered]@{ name = 'steel.ecosystem'; value = 'cargo' },
      [ordered]@{ name = 'steel.cargo.source'; value = [string]$Record.source },
      [ordered]@{ name = 'steel.lock.origins'; value = (@($Record.origins | Sort-Object -Unique) -join ',') }
    )
    $Component = [ordered]@{
      type = 'library'
      'bom-ref' = $BomRef
      name = [string]$Record.name
      version = [string]$Record.version
      scope = 'required'
      purl = $Purl
      properties = $Properties
    }
    if ([string]$Record.checksum -match '^[0-9a-f]{64}$') {
      $Component['hashes'] = @([ordered]@{ alg = 'SHA-256'; content = [string]$Record.checksum })
    }
    $Components += ,$Component
  }
  return $Components
}

function Get-ExternalInventory {
  param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256
  )

  $ExpectedSha256 = $ExpectedSha256.Trim().ToLowerInvariant()
  if ($ExpectedSha256 -notmatch '^[0-9a-f]{64}$') {
    throw 'ExpectedExternalComponentsSha256 must contain exactly 64 hexadecimal characters.'
  }
  $ActualSha256 = Get-Sha256Hex $ConfigPath
  if ($ActualSha256 -cne $ExpectedSha256) {
    throw "External-component policy hash mismatch. expected=$ExpectedSha256 actual=$ActualSha256"
  }
  $Config = Read-JsonDictionary $ConfigPath
  Assert-JsonObjectKeys `
    -Dictionary $Config `
    -Allowed @('$schema', 'schema', 'approved', 'components') `
    -Required @('schema', 'approved', 'components') `
    -Label 'External-component policy'
  if ([string](Get-DictionaryValue $Config 'schema' -Required) -cne $script:SteelExternalComponentsSchema) {
    throw "External-component policy schema must be $script:SteelExternalComponentsSchema"
  }
  if ((Get-DictionaryValue $Config 'approved' -Required) -ne $true) {
    throw 'External-component policy must be explicitly approved=true.'
  }
  $Rows = @(Get-DictionaryValue $Config 'components' -Required)
  if ($Rows.Count -lt 6) {
    throw 'External-component policy must declare every required external category.'
  }
  $RequiredCategories = @('cpp-toolchain', 'camera-sdk', 'vc-runtime', 'webview2-runtime', 'wix-toolset', 'nsis')
  $AllowedTypes = @('application', 'framework', 'library')
  $AllowedScopes = @('build', 'runtime')
  $SeenIds = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
  $SeenRefs = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
  $CategoryCounts = @{}
  $Components = @()
  foreach ($Row in $Rows) {
    if ($Row -isnot [System.Collections.IDictionary]) { throw 'External component entry must be a JSON object.' }
    Assert-JsonObjectKeys `
      -Dictionary $Row `
      -Allowed @('id', 'category', 'type', 'name', 'version', 'supplier', 'scope', 'artifact', 'sha256', 'purl', 'licenses') `
      -Required @('id', 'category', 'type', 'name', 'version', 'supplier', 'scope', 'artifact', 'sha256', 'purl') `
      -Label 'External component entry'
    $Id = [string](Get-DictionaryValue $Row 'id' -Required)
    $Category = [string](Get-DictionaryValue $Row 'category' -Required)
    $Type = [string](Get-DictionaryValue $Row 'type' -Required)
    $Name = [string](Get-DictionaryValue $Row 'name' -Required)
    $Version = [string](Get-DictionaryValue $Row 'version' -Required)
    $Supplier = [string](Get-DictionaryValue $Row 'supplier' -Required)
    $Scope = [string](Get-DictionaryValue $Row 'scope' -Required)
    $Artifact = [string](Get-DictionaryValue $Row 'artifact' -Required)
    $Sha256 = ([string](Get-DictionaryValue $Row 'sha256' -Required)).ToLowerInvariant()
    $Purl = [string](Get-DictionaryValue $Row 'purl' -Required)
    if ($Id -notmatch '^[a-z0-9][a-z0-9._-]*$' -or -not $SeenIds.Add($Id)) {
      throw "External component id is invalid or duplicated: $Id"
    }
    if ($RequiredCategories -cnotcontains $Category) { throw "Unsupported external component category: $Category" }
    if ($AllowedTypes -cnotcontains $Type) { throw "Unsupported CycloneDX external component type: $Type" }
    if ($AllowedScopes -cnotcontains $Scope) { throw "Unsupported external component scope: $Scope" }
    $IdentityValues = @($Name, $Supplier, $Artifact, $Purl)
    if ([string]::IsNullOrWhiteSpace($Name) -or [string]::IsNullOrWhiteSpace($Supplier) -or [string]::IsNullOrWhiteSpace($Artifact) -or
        @($IdentityValues | Where-Object { [string]$_ -match '(?i)todo|tbd|unknown|pending|required|replace' }).Count -gt 0) {
      throw "External component identity is incomplete: $Id"
    }
    if ([string]::IsNullOrWhiteSpace($Version) -or $Version -match '(?i)todo|tbd|unknown|pending|required|replace') {
      throw "External component version is unresolved: $Id"
    }
    if ($Sha256 -notmatch '^[0-9a-f]{64}$' -or $Sha256 -eq ('0' * 64)) {
      throw "External component SHA-256 is invalid or unresolved: $Id"
    }
    if ($Purl -notmatch '^pkg:[^\s]+$') { throw "External component purl is invalid: $Id" }
    $BomRef = "external:$Id"
    if (-not $SeenRefs.Add($BomRef)) { throw "External component bom-ref is duplicated: $BomRef" }
    if (-not $CategoryCounts.ContainsKey($Category)) { $CategoryCounts[$Category] = 0 }
    $CategoryCounts[$Category]++
    $Properties = @(
      [ordered]@{ name = 'steel.ecosystem'; value = 'external' },
      [ordered]@{ name = 'steel.external.category'; value = $Category },
      [ordered]@{ name = 'steel.external.scope'; value = $Scope },
      [ordered]@{ name = 'steel.external.artifact'; value = $Artifact }
    )
    $Component = [ordered]@{
      type = $Type
      'bom-ref' = $BomRef
      supplier = [ordered]@{ name = $Supplier }
      name = $Name
      version = $Version
      scope = 'required'
      hashes = @([ordered]@{ alg = 'SHA-256'; content = $Sha256 })
      purl = $Purl
      properties = $Properties
    }
    $Licenses = @(Get-DictionaryValue $Row 'licenses')
    if ($Licenses.Count -gt 0) {
      $Expressions = @()
      foreach ($License in $Licenses) {
        $LicenseText = [string]$License
        if ([string]::IsNullOrWhiteSpace($LicenseText)) { throw "External component has an empty license: $Id" }
        $Expressions += ,[ordered]@{ expression = $LicenseText }
      }
      $Component['licenses'] = $Expressions
    }
    $Components += ,$Component
  }
  foreach ($Category in $RequiredCategories) {
    if (-not $CategoryCounts.ContainsKey($Category) -or [int]$CategoryCounts[$Category] -lt 1) {
      throw "Required external component category is missing: $Category"
    }
  }
  return [ordered]@{
    sha256 = $ActualSha256
    components = @($Components | Sort-Object { $_.'bom-ref' })
  }
}

function Resolve-RepositoryFile {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$RelativePath
  )

  if ([System.IO.Path]::IsPathRooted($RelativePath) -or $RelativePath.Contains('..')) {
    throw "Repository input path must be a fixed relative path: $RelativePath"
  }
  $RepoBoundary = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd('\', '/')
  $Candidate = [System.IO.Path]::GetFullPath((Join-Path $RepoBoundary $RelativePath))
  if (-not $Candidate.StartsWith($RepoBoundary + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Repository input escapes the repository root: $RelativePath"
  }
  if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
    throw "Required repository input is missing: $RelativePath"
  }
  $Item = Get-Item -LiteralPath $Candidate -Force
  if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Repository input must not be a reparse point: $RelativePath"
  }
  return $Item.FullName
}

function Invoke-GitRead {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $Output = @(& git -C $RepoRoot @Arguments 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "git command failed: git -C $RepoRoot $($Arguments -join ' ') ($($Output -join ' '))"
  }
  return (($Output | Out-String).Trim())
}

function ConvertTo-StableUuidUrn {
  param([Parameter(Mandatory = $true)][string]$Hex)

  if ($Hex -notmatch '^[0-9a-f]{64}$') { throw 'Stable UUID seed must be a SHA-256 hex digest.' }
  $UuidHex = $Hex.Substring(0, 32).ToCharArray()
  $UuidHex[12] = '5'
  $UuidHex[16] = '8'
  $Value = -join $UuidHex
  return "urn:uuid:$($Value.Substring(0,8))-$($Value.Substring(8,4))-$($Value.Substring(12,4))-$($Value.Substring(16,4))-$($Value.Substring(20,12))"
}

function ConvertTo-CanonicalJson {
  param([Parameter(Mandatory = $true)]$Value)

  function ConvertTo-CanonicalValue {
    param($InputValue)

    if ($InputValue -is [System.Collections.IDictionary]) {
      $Ordered = [ordered]@{}
      foreach ($Key in @($InputValue.Keys | ForEach-Object { [string]$_ } | Sort-Object)) {
        $Ordered[$Key] = ConvertTo-CanonicalValue $InputValue[$Key]
      }
      return $Ordered
    }
    if ($InputValue -is [System.Collections.IEnumerable] -and $InputValue -isnot [string]) {
      $Items = @()
      foreach ($Item in $InputValue) {
        $Items += ,(ConvertTo-CanonicalValue $Item)
      }
      Write-Output -NoEnumerate $Items
      return
    }
    return $InputValue
  }

  $Canonical = ConvertTo-CanonicalValue $Value
  return ($Canonical | ConvertTo-Json -Depth 100 -Compress)
}

function Get-ReleaseSbomExpectedModel {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$ExternalComponentsPath,
    [Parameter(Mandatory = $true)][string]$ExpectedExternalComponentsSha256,
    [string]$ExpectedCommit = '',
    [switch]$AllowDirtyWorktree
  )

  $ResolvedRepo = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path.TrimEnd('\', '/')
  $GitRoot = Invoke-GitRead -RepoRoot $ResolvedRepo -Arguments @('rev-parse', '--show-toplevel')
  $GitRoot = [System.IO.Path]::GetFullPath($GitRoot).TrimEnd('\', '/')
  if (-not $GitRoot.Equals($ResolvedRepo, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "RepoRoot must be the exact Git worktree root: $ResolvedRepo"
  }
  $Commit = (Invoke-GitRead -RepoRoot $ResolvedRepo -Arguments @('rev-parse', 'HEAD')).ToLowerInvariant()
  if ($Commit -notmatch '^[0-9a-f]{40,64}$') { throw 'Git HEAD is not an exact commit.' }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedCommit)) {
    $ExpectedCommit = $ExpectedCommit.Trim().ToLowerInvariant()
    if ($ExpectedCommit -notmatch '^[0-9a-f]{40,64}$' -or $ExpectedCommit -cne $Commit) {
      throw "Source commit mismatch. expected=$ExpectedCommit actual=$Commit"
    }
  }
  $StatusText = Invoke-GitRead -RepoRoot $ResolvedRepo -Arguments @('status', '--porcelain=v1', '--untracked-files=all')
  $Status = @($StatusText -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  $Dirty = $Status.Count -gt 0
  if ($Dirty -and -not $AllowDirtyWorktree) {
    throw 'SBOM generation/verification requires a clean worktree. Use -AllowDirtyWorktree only for engineering evidence.'
  }
  $CommitTimestampText = Invoke-GitRead -RepoRoot $ResolvedRepo -Arguments @('show', '-s', '--format=%cI', $Commit)
  try {
    $CommitTimestamp = [DateTimeOffset]::Parse($CommitTimestampText).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  } catch {
    throw "Git commit timestamp is invalid: $CommitTimestampText"
  }

  $InputDefinitions = @(
    [ordered]@{ id = 'npm-client'; path = 'app/client/package-lock.json'; kind = 'npm' },
    [ordered]@{ id = 'cargo-tauri'; path = 'app/client/src-tauri/Cargo.lock'; kind = 'cargo' },
    [ordered]@{ id = 'cargo-service'; path = 'app/service/Cargo.lock'; kind = 'cargo' },
    [ordered]@{ id = 'cargo-trigger'; path = 'app/trigger/Cargo.lock'; kind = 'cargo' },
    [ordered]@{ id = 'cargo-camera-worker'; path = 'app/camera-worker/Cargo.lock'; kind = 'cargo' },
    [ordered]@{ id = 'cargo-result-contract'; path = 'app/result-contract/Cargo.lock'; kind = 'cargo' },
    [ordered]@{ id = 'cargo-pipeline-workers'; path = 'app/pipeline-workers/Cargo.lock'; kind = 'cargo' },
    [ordered]@{ id = 'cargo-runtime-contract'; path = 'app/runtime-contract/Cargo.lock'; kind = 'cargo' },
    [ordered]@{ id = 'cargo-image-service'; path = 'app/image-service/Cargo.lock'; kind = 'cargo' },
    [ordered]@{ id = 'cargo-tray'; path = 'app/tray/Cargo.lock'; kind = 'cargo' }
  )
  $InputEvidence = @()
  $CargoRecords = @()
  $NpmInventory = $null
  foreach ($Definition in $InputDefinitions) {
    $Path = Resolve-RepositoryFile -RepoRoot $ResolvedRepo -RelativePath ([string]$Definition.path)
    $InputEvidence += ,[ordered]@{
      id = [string]$Definition.id
      path = [string]$Definition.path
      sha256 = Get-Sha256Hex $Path
    }
    if ([string]$Definition.kind -eq 'npm') {
      $NpmInventory = Get-NpmInventory $Path
    } else {
      $CargoRecords += @(Get-CargoInventory -LockPath $Path -Origin ([string]$Definition.id))
    }
  }
  if ($null -eq $NpmInventory) { throw 'npm inventory was not produced.' }

  $ResolvedExternal = (Resolve-Path -LiteralPath $ExternalComponentsPath -ErrorAction Stop).Path
  $ExternalItem = Get-Item -LiteralPath $ResolvedExternal -Force
  if (($ExternalItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'External-component policy must not be a reparse point.'
  }
  $ExternalInventory = Get-ExternalInventory -ConfigPath $ResolvedExternal -ExpectedSha256 $ExpectedExternalComponentsSha256
  $InputEvidence += ,[ordered]@{
    id = 'external-components'
    path = "external:$([System.IO.Path]::GetFileName($ResolvedExternal))"
    sha256 = [string]$ExternalInventory.sha256
  }

  $CargoComponents = @(Merge-CargoInventories -Records $CargoRecords)
  $Components = @($NpmInventory.components) + $CargoComponents + @($ExternalInventory.components)
  $Components = @($Components | Sort-Object { $_.'bom-ref' })
  $SeenComponentRefs = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
  foreach ($Component in $Components) {
    if (-not $SeenComponentRefs.Add([string]$Component.'bom-ref')) {
      throw "Generated component bom-ref is duplicated: $($Component.'bom-ref')"
    }
  }

  $GeneratorPath = Join-Path $PSScriptRoot 'generate-release-sbom.ps1'
  $VerifierPath = Join-Path $PSScriptRoot 'verify-release-sbom.ps1'
  $CommonPath = Join-Path $PSScriptRoot 'release-sbom-common.ps1'
  foreach ($ToolPath in @($GeneratorPath, $VerifierPath, $CommonPath)) {
    if (-not (Test-Path -LiteralPath $ToolPath -PathType Leaf)) { throw "SBOM tool file is missing: $ToolPath" }
  }

  $GitVersionOutput = @(& git --version 2>&1)
  if ($LASTEXITCODE -ne 0 -or $GitVersionOutput.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$GitVersionOutput[0])) {
    throw 'Cannot record the Git tool version.'
  }
  $PowerShellVersion = $PSVersionTable.PSVersion.ToString()
  if ([string]::IsNullOrWhiteSpace($PowerShellVersion)) {
    throw 'Cannot record the PowerShell tool version.'
  }
  $Tools = @(
    [ordered]@{
      type = 'application'
      name = 'generate-release-sbom.ps1'
      version = $script:SteelSbomGeneratorVersion
    },
    [ordered]@{
      type = 'application'
      name = 'PowerShell'
      version = $PowerShellVersion
    },
    [ordered]@{
      type = 'application'
      name = 'Git'
      version = [string]$GitVersionOutput[0]
    }
  )

  $GeneratorSha256 = Get-Sha256Hex $GeneratorPath
  $VerifierSha256 = Get-Sha256Hex $VerifierPath
  $CommonSha256 = Get-Sha256Hex $CommonPath

  $RootRef = "application:$($NpmInventory.rootName)@$($NpmInventory.rootVersion):$($Commit.Substring(0, 12))"
  $InputProperties = @($InputEvidence | ForEach-Object {
    [ordered]@{ name = "steel.input.$($_.id).path"; value = [string]$_.path },
    [ordered]@{ name = "steel.input.$($_.id).sha256"; value = [string]$_.sha256 }
  })
  $Properties = @(
    [ordered]@{ name = 'steel.sbom.schema'; value = $script:SteelSbomSchema },
    [ordered]@{ name = 'steel.generator.version'; value = $script:SteelSbomGeneratorVersion },
    [ordered]@{ name = 'steel.source.gitCommit'; value = $Commit },
    [ordered]@{ name = 'steel.source.dirty'; value = ([string][bool]$Dirty).ToLowerInvariant() },
    [ordered]@{ name = 'steel.source.commitTimestamp'; value = $CommitTimestamp }
  ) + $InputProperties + @(
    [ordered]@{ name = 'steel.tool.generate.sha256'; value = $GeneratorSha256 },
    [ordered]@{ name = 'steel.tool.verify.sha256'; value = $VerifierSha256 },
    [ordered]@{ name = 'steel.tool.common.sha256'; value = $CommonSha256 },
    [ordered]@{ name = 'steel.component.count.npm'; value = ([string](@($NpmInventory.components).Count)) },
    [ordered]@{ name = 'steel.component.count.cargo'; value = ([string]$CargoComponents.Count) },
    [ordered]@{ name = 'steel.component.count.external'; value = ([string](@($ExternalInventory.components).Count)) },
    [ordered]@{ name = 'steel.component.count.total'; value = ([string]$Components.Count) }
  )
  $SeedParts = @(
    $Commit,
    ((@($InputEvidence | Sort-Object { $_.id }) | ForEach-Object { "$($_.id):$($_.sha256)" }) -join '|'),
    "generator:$GeneratorSha256",
    "verifier:$VerifierSha256",
    "common:$CommonSha256",
    "powershell:$PowerShellVersion",
    "git:$([string]$GitVersionOutput[0])",
    "schema:$script:SteelSbomSchema",
    "generator-version:$script:SteelSbomGeneratorVersion"
  )
  $Seed = $SeedParts -join '|'
  $Serial = ConvertTo-StableUuidUrn (Get-StringSha256Hex $Seed)
  $RootComponent = [ordered]@{
    type = 'application'
    'bom-ref' = $RootRef
    name = [string]$NpmInventory.rootName
    version = [string]$NpmInventory.rootVersion
    properties = @(
      [ordered]@{ name = 'steel.source.gitCommit'; value = $Commit }
    )
  }
  $Dependencies = @([ordered]@{
    ref = $RootRef
    dependsOn = @($Components | ForEach-Object { [string]$_.'bom-ref' } | Sort-Object)
  })
  return [ordered]@{
    repoRoot = $ResolvedRepo
    commit = $Commit
    dirty = $Dirty
    timestamp = $CommitTimestamp
    serialNumber = $Serial
    rootComponent = $RootComponent
    tools = $Tools
    properties = $Properties
    components = $Components
    dependencies = $Dependencies
  }
}
