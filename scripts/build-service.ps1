param(
  [ValidateSet("debug", "release")]
  [string]$Profile = "debug"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Args = @("build", "--manifest-path", (Join-Path $RepoRoot "app\service\Cargo.toml"))

if ($Profile -eq "release") {
  $Args += "--release"
}

& cargo @Args
if ($LASTEXITCODE -ne 0) {
  throw "cargo failed with exit code $LASTEXITCODE"
}

Write-Host "Rust service built with $Profile profile."
