param(
  [ValidateSet("debug", "release")]
  [string]$Profile = "debug",
  [switch]$Locked
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Args = @("build", "--manifest-path", (Join-Path $RepoRoot "app\algorithm-service\Cargo.toml"), "--target-dir", (Join-Path $RepoRoot "target\algorithm-service"))
if ($Profile -eq "release") { $Args += "--release" }
if ($Locked) { $Args += "--locked" }
& cargo @Args
if ($LASTEXITCODE -ne 0) { throw "algorithm service build failed with exit code $LASTEXITCODE" }
Write-Host "Algorithm service built with $Profile profile."
