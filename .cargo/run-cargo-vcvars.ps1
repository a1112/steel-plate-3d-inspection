# Helper: invoke cargo with the MSVC (vcvars64) environment loaded.
#
# vcvars64.bat fails when PATH contains entries with unescaped parentheses
# such as "C:\Program Files (x86)\NVIDIA Corporation\...". We reset PATH to a
# minimal safe value inside the cmd child before loading vcvars, which then
# rebuilds the full MSVC environment.
#
# Usage (from PowerShell):
#   ./.cargo/run-cargo-vcvars.ps1 build --locked --manifest-path app/service/Cargo.toml
#   ./.cargo/run-cargo-vcvars.ps1 run  -- ...
param(
    [Parameter(Position = 0)]
    [string]$CargoArgs = ''
)

if (-not $CargoArgs) {
    Write-Error 'Usage: run-cargo-vcvars.ps1 "<cargo args>"  (e.g. "build --locked --manifest-path app/service/Cargo.toml")'
    exit 2
}

$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) {
    Write-Error "vcvars64.bat not found at $vcvars"
    exit 3
}

# Ensure cargo bin is reachable inside the cmd child even after PATH reset.
$cargoHome = $env:CARGO_HOME
if (-not $cargoHome) { $cargoHome = "$env:USERPROFILE\.cargo" }
$cargoBin = Join-Path $cargoHome 'bin'

# Reset PATH to a minimal safe set, prepend cargo bin, then load vcvars.
$safePath = "$cargoBin;C:\Windows\System32;C:\Windows\System32\Wbem"
$cmdLine = "set `"PATH=$safePath`" && call `"$vcvars`" && cargo $CargoArgs"

# Execute via cmd /c and propagate the exit code.
& cmd.exe /c $cmdLine
exit $LASTEXITCODE
