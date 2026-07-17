param(
  [Parameter(Mandatory = $true)]
  [string]$ReleaseManifestPath,
  [Parameter(Mandatory = $true)]
  [string]$ScenarioId,
  [Parameter(Mandatory = $true)]
  [string]$SourceSystem,
  [Parameter(Mandatory = $true)]
  [string]$CommandOrProcedure,
  [Parameter(Mandatory = $true)]
  [string]$RawLogPath,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
  [string]$ObservedAt = "",
  [string]$RequestId = "",
  [string]$MaterialId = "",
  [string]$SessionId = "",
  [string]$InspectionId = "",
  [string]$Notes = ""
)

$ErrorActionPreference = "Stop"

function Resolve-ExistingFile {
  param([string]$Path, [string]$Name)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Name file is missing: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Write-Utf8JsonAtomically {
  param([string]$Path, [object]$Value)

  $FullPath = [System.IO.Path]::GetFullPath($Path)
  $Directory = Split-Path -Parent $FullPath
  if ([string]::IsNullOrWhiteSpace($Directory)) {
    throw "OutputPath must include a parent directory."
  }
  New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  $Temporary = Join-Path $Directory (".{0}.{1}.tmp" -f [System.IO.Path]::GetFileName($FullPath), [guid]::NewGuid().ToString("N"))
  try {
    $Json = $Value | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($Temporary, $Json, [System.Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $FullPath -PathType Leaf) {
      [System.IO.File]::Replace($Temporary, $FullPath, $null, $true)
    } else {
      [System.IO.File]::Move($Temporary, $FullPath)
    }
  } finally {
    if (Test-Path -LiteralPath $Temporary -PathType Leaf) {
      Remove-Item -LiteralPath $Temporary -Force
    }
  }
  return $FullPath
}

if ([string]::IsNullOrWhiteSpace($ScenarioId) -or $ScenarioId -notmatch "^[a-z0-9][a-z0-9-]{1,63}$") {
  throw "ScenarioId must be a stable lowercase kebab-case identifier."
}
if ([string]::IsNullOrWhiteSpace($SourceSystem)) {
  throw "SourceSystem is required."
}
if ([string]::IsNullOrWhiteSpace($CommandOrProcedure)) {
  throw "CommandOrProcedure is required."
}

$ReleaseManifestPath = Resolve-ExistingFile $ReleaseManifestPath "Release manifest"
$RawLogPath = Resolve-ExistingFile $RawLogPath "Raw log"
$Manifest = Get-Content -LiteralPath $ReleaseManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$Manifest.schema -ne "steel.runtime-package.v1" -or
    [string]::IsNullOrWhiteSpace([string]$Manifest.releaseVersion) -or
    [string]$Manifest.source.gitCommit -notmatch "^[0-9a-f]{40,64}$") {
  throw "Release manifest does not expose a valid runtime package identity."
}

$Observed = [DateTimeOffset]::Now
if (-not [string]::IsNullOrWhiteSpace($ObservedAt) -and
    -not [DateTimeOffset]::TryParse($ObservedAt, [ref]$Observed)) {
  throw "ObservedAt must be a valid ISO-8601 timestamp."
}

$Evidence = [ordered]@{
  schema = "steel.functional-scenario-evidence.v1"
  releaseVersion = [string]$Manifest.releaseVersion
  releaseCommit = [string]$Manifest.source.gitCommit
  releaseManifestSha256 = (Get-FileHash -LiteralPath $ReleaseManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  scenarioId = $ScenarioId
  observedAt = $Observed.ToString("o")
  result = "pass"
  source = [ordered]@{
    system = $SourceSystem
    command = $CommandOrProcedure
    rawLogPath = $RawLogPath
    rawLogSha256 = (Get-FileHash -LiteralPath $RawLogPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  observations = [ordered]@{
    requestId = $RequestId
    materialId = $MaterialId
    sessionId = $SessionId
    inspectionId = $InspectionId
    notes = $Notes
  }
}

$OutputPath = Write-Utf8JsonAtomically -Path $OutputPath -Value $Evidence
$Result = [ordered]@{
  schema = "steel.functional-scenario-evidence.reference.v1"
  path = $OutputPath
  sha256 = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
  scenarioId = $ScenarioId
  releaseVersion = [string]$Manifest.releaseVersion
  releaseCommit = [string]$Manifest.source.gitCommit
  rawLogPath = $RawLogPath
  rawLogSha256 = [string]$Evidence.source.rawLogSha256
}
$Result | ConvertTo-Json -Depth 6
