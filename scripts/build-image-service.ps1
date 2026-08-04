param(
  [ValidateSet("debug", "release")]
  [string]$Profile = "debug",
  [switch]$Locked
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Args = @("build", "--manifest-path", (Join-Path $RepoRoot "app\image-service\Cargo.toml"), "--target-dir", (Join-Path $RepoRoot "target\image-service"))
if ($Profile -eq "release") { $Args += "--release" }
if ($Locked) { $Args += "--locked" }
& cargo @Args
if ($LASTEXITCODE -ne 0) { throw "image service build failed with exit code $LASTEXITCODE" }
Write-Host "Image service built with $Profile profile."
