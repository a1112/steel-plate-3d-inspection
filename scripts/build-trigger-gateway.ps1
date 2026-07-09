param(
  [ValidateSet("debug", "release")]
  [string]$Profile = "debug"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Args = @(
  "build",
  "--manifest-path", (Join-Path $RepoRoot "app\trigger\Cargo.toml"),
  "--target-dir", (Join-Path $RepoRoot "target\trigger")
)

if ($Profile -eq "release") {
  $Args += "--release"
}

& cargo @Args
if ($LASTEXITCODE -ne 0) {
  throw "cargo failed with exit code $LASTEXITCODE"
}

Write-Host "Trigger gateway built with $Profile profile."
