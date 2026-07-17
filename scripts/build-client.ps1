param(
  [switch]$Tauri,
  [switch]$AllowUnsignedDesktopBundle,
  [string]$RustTarget = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ClientDir = Join-Path $RepoRoot "app\client"
$SigningConfigPath = ""

function Assert-NoUnreviewedTauriConfigInputs {
  if (-not [string]::IsNullOrWhiteSpace([string]$env:TAURI_CONFIG)) {
    throw "Formal Tauri build rejects the TAURI_CONFIG merge override."
  }
  $TauriConfigDir = Join-Path $ClientDir "src-tauri"
  $ConfigVariants = @(Get-ChildItem -LiteralPath $TauriConfigDir -File -Force | Where-Object {
    $_.Name -imatch '^tauri.*(?:\.conf\.json5?|\.toml)$' -and $_.Name -cne 'tauri.conf.json'
  })
  if ($ConfigVariants.Count -gt 0) {
    throw "Formal Tauri build rejects automatically merged platform/config variants: $($ConfigVariants.Name -join ', ')"
  }
  $AllowedTauriEnvironment = @(
    'TAURI_WINDOWS_CERTIFICATE_THUMBPRINT',
    'TAURI_WINDOWS_TIMESTAMP_URL',
    'TAURI_WINDOWS_TSP',
    'TAURI_WINDOWS_PUBLISHER'
  )
  $UnapprovedTauriEnvironment = @(Get-ChildItem Env: | Where-Object {
    $_.Name.ToUpperInvariant().StartsWith('TAURI_') -and
    $AllowedTauriEnvironment -cnotcontains $_.Name.ToUpperInvariant()
  })
  if ($UnapprovedTauriEnvironment.Count -gt 0) {
    throw "Formal Tauri build rejects unreviewed TAURI_* environment overrides: $($UnapprovedTauriEnvironment.Name -join ', ')"
  }
}

function Assert-NoUnreviewedRustBuildInputs {
  $ExactHighRiskNames = @(
    'RUSTFLAGS',
    'CARGO_ENCODED_RUSTFLAGS',
    'RUSTC',
    'RUSTC_BOOTSTRAP',
    'RUSTC_WRAPPER',
    'RUSTC_WORKSPACE_WRAPPER',
    'CARGO_BUILD_RUSTFLAGS',
    'CARGO_BUILD_RUSTC',
    'CARGO_BUILD_RUSTC_WRAPPER',
    'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER',
    'CARGO_BUILD_TARGET'
  )
  $HighRiskEnvironment = @(Get-ChildItem Env: | Where-Object {
    $Name = $_.Name.ToUpperInvariant()
    $ExactHighRiskNames -ccontains $Name -or
    $Name.StartsWith('CARGO_PROFILE_RELEASE_') -or
    $Name -match '^CARGO_TARGET_.+_(?:RUSTFLAGS|RUSTC|RUSTC_WRAPPER|LINKER)$'
  })
  if ($HighRiskEnvironment.Count -gt 0) {
    throw "Formal Rust build rejects inherited compiler/profile overrides: $($HighRiskEnvironment.Name -join ', ')"
  }

  $ApprovedCargoConfig = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot '.cargo\config.toml'))
  $UnapprovedCargoConfigs = @()
  $SearchDir = [System.IO.Path]::GetFullPath((Join-Path $ClientDir 'src-tauri'))
  while ($null -ne $SearchDir) {
    foreach ($Name in @('config.toml', 'config')) {
      $Candidate = [System.IO.Path]::GetFullPath((Join-Path $SearchDir ".cargo\$Name"))
      if ((Test-Path -LiteralPath $Candidate -PathType Leaf) -and
          -not $Candidate.Equals($ApprovedCargoConfig, [System.StringComparison]::OrdinalIgnoreCase)) {
        $UnapprovedCargoConfigs += $Candidate
      }
    }
    $Parent = [System.IO.Directory]::GetParent($SearchDir)
    $SearchDir = if ($null -eq $Parent) { $null } else { $Parent.FullName }
  }
  $CargoHome = if ([string]::IsNullOrWhiteSpace([string]$env:CARGO_HOME)) {
    Join-Path $HOME '.cargo'
  } else {
    [string]$env:CARGO_HOME
  }
  foreach ($Name in @('config.toml', 'config')) {
    $Candidate = [System.IO.Path]::GetFullPath((Join-Path $CargoHome $Name))
    if ((Test-Path -LiteralPath $Candidate -PathType Leaf) -and
        -not $Candidate.Equals($ApprovedCargoConfig, [System.StringComparison]::OrdinalIgnoreCase)) {
      $UnapprovedCargoConfigs += $Candidate
    }
  }
  $UnapprovedCargoConfigs = @($UnapprovedCargoConfigs | Sort-Object -Unique)
  if ($UnapprovedCargoConfigs.Count -gt 0) {
    throw "Formal Rust build rejects unreviewed Cargo config files: $($UnapprovedCargoConfigs -join ', ')"
  }
}

Push-Location $ClientDir
try {
  if ($Tauri) {
    $TauriArgs = @("run", "tauri", "--", "build", "--ci")
    if (-not $AllowUnsignedDesktopBundle) {
      Assert-NoUnreviewedTauriConfigInputs
      Assert-NoUnreviewedRustBuildInputs
    }
    if ([string]::IsNullOrWhiteSpace($RustTarget)) {
      if (-not $AllowUnsignedDesktopBundle) {
        throw "Formal Tauri bundling requires an explicit approved RustTarget."
      }
    } else {
      if ($RustTarget -notmatch '^[a-zA-Z0-9_]+(?:-[a-zA-Z0-9_]+)+$') {
        throw "RustTarget is not a valid explicit Rust target triple: $RustTarget"
      }
      if (-not [string]::IsNullOrWhiteSpace([string]$env:CARGO_BUILD_TARGET) -and
          [string]$env:CARGO_BUILD_TARGET -cne $RustTarget) {
        throw "CARGO_BUILD_TARGET conflicts with the explicit approved RustTarget."
      }
      $TauriArgs += @("--target", $RustTarget)
    }
    if ($AllowUnsignedDesktopBundle) {
      $TauriArgs += "--no-sign"
    } else {
      $CertificateThumbprint = [string]$env:TAURI_WINDOWS_CERTIFICATE_THUMBPRINT
      $TimestampUrl = [string]$env:TAURI_WINDOWS_TIMESTAMP_URL
      if ($CertificateThumbprint -notmatch '^[0-9A-Fa-f]{40}$') {
        throw "Formal Tauri bundling requires TAURI_WINDOWS_CERTIFICATE_THUMBPRINT as the 40-hex SHA-1 certificate thumbprint. Use -AllowUnsignedDesktopBundle only for a development bundle."
      }
      if ($TimestampUrl -notmatch '^https://') {
        throw "Formal Tauri bundling requires an HTTPS TAURI_WINDOWS_TIMESTAMP_URL."
      }
      $UseTsp = if ([string]::IsNullOrWhiteSpace([string]$env:TAURI_WINDOWS_TSP)) {
        $true
      } else {
        [string]$env:TAURI_WINDOWS_TSP -in @("1", "true", "TRUE")
      }
      $SigningConfig = @{
        bundle = @{
          windows = @{
            certificateThumbprint = $CertificateThumbprint.ToUpperInvariant()
            digestAlgorithm = "sha256"
            timestampUrl = $TimestampUrl
            tsp = $UseTsp
          }
        }
      } | ConvertTo-Json -Depth 4 -Compress
      $SigningConfigDir = Join-Path $RepoRoot "target\client"
      New-Item -ItemType Directory -Force -Path $SigningConfigDir | Out-Null
      $SigningConfigPath = Join-Path $SigningConfigDir ("tauri-signing-{0}.json" -f [guid]::NewGuid().ToString("N"))
      [System.IO.File]::WriteAllText(
        $SigningConfigPath,
        $SigningConfig,
        [System.Text.UTF8Encoding]::new($false)
      )
      $TauriArgs += @("--config", $SigningConfigPath)
    }
    $TauriArgs += @("--", "--locked")
    & npm.cmd @TauriArgs
    if ($LASTEXITCODE -ne 0) {
      throw "tauri build failed with exit code $LASTEXITCODE"
    }
  } else {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
      throw "npm build failed with exit code $LASTEXITCODE"
    }
  }
} finally {
  Pop-Location
  if (-not [string]::IsNullOrWhiteSpace($SigningConfigPath)) {
    Remove-Item -LiteralPath $SigningConfigPath -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "Client frontend built at target/client/frontend-dist."
