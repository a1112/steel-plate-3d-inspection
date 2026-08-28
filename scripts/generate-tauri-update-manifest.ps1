param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [Parameter(Mandatory = $true)]
  [string]$BundleUrl,
  [Parameter(Mandatory = $true)]
  [string]$SignaturePath,
  [string]$Notes = '',
  [string]$OutputPath = 'latest.json',
  [string]$PublishedAt = (Get-Date).ToUniversalTime().ToString('o')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
  throw "Version must be a valid SemVer value: $Version"
}

$BundleUri = [Uri]$BundleUrl
if (-not $BundleUri.IsAbsoluteUri -or $BundleUri.Scheme -cne 'https') {
  throw 'BundleUrl must be an absolute HTTPS URL.'
}
if (-not $BundleUri.AbsolutePath.EndsWith('.zip', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'BundleUrl must reference the signed Windows updater .zip artifact.'
}

$ResolvedSignaturePath = [IO.Path]::GetFullPath($SignaturePath)
if (-not (Test-Path -LiteralPath $ResolvedSignaturePath -PathType Leaf)) {
  throw "Updater signature file does not exist: $ResolvedSignaturePath"
}
$Signature = [IO.File]::ReadAllText($ResolvedSignaturePath).Trim()
if ([string]::IsNullOrWhiteSpace($Signature)) {
  throw 'Updater signature file is empty.'
}

$Published = [DateTimeOffset]::Parse($PublishedAt).ToUniversalTime().ToString('o')
$Manifest = [ordered]@{
  version = $Version
  notes = $Notes
  pub_date = $Published
  platforms = [ordered]@{
    'windows-x86_64' = [ordered]@{
      signature = $Signature
      url = $BundleUri.AbsoluteUri
    }
  }
}

$ResolvedOutputPath = [IO.Path]::GetFullPath($OutputPath)
$OutputDirectory = Split-Path -Parent $ResolvedOutputPath
if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
  [IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
}
[IO.File]::WriteAllText(
  $ResolvedOutputPath,
  ($Manifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine,
  [Text.UTF8Encoding]::new($false)
)

[ordered]@{
  code = 0
  outputPath = $ResolvedOutputPath
  version = $Version
  target = 'windows-x86_64'
  bundleUrl = $BundleUri.AbsoluteUri
} | ConvertTo-Json -Compress
