param(
  [ValidateSet("debug", "release")]
  [string]$Profile = "debug",
  [switch]$Locked
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Args = @("build", "--manifest-path", (Join-Path $RepoRoot "app\tray\Cargo.toml"), "--target-dir", (Join-Path $RepoRoot "target\tray"))
if ($Profile -eq "release") { $Args += "--release" }
if ($Locked) { $Args += "--locked" }
& cargo @Args
if ($LASTEXITCODE -ne 0) { throw "tray build failed with exit code $LASTEXITCODE" }
Write-Host "Tray companion built with $Profile profile."
