param(
  [ValidateSet("debug", "release")]
  [string]$Profile = "debug",
  [switch]$Locked
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Args = @(
  "build",
  "--manifest-path", (Join-Path $RepoRoot "app\pipeline-workers\Cargo.toml"),
  "--target-dir", (Join-Path $RepoRoot "target\pipeline-workers"),
  "--bins"
)
if ($Profile -eq "release") { $Args += "--release" }
if ($Locked) { $Args += "--locked" }
& cargo @Args
if ($LASTEXITCODE -ne 0) { throw "pipeline worker build failed with exit code $LASTEXITCODE" }
Write-Host "Image and defect workers built with $Profile profile."
