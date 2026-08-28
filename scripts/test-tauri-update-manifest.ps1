$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Generator = Join-Path $RepoRoot 'scripts\generate-tauri-update-manifest.ps1'
$FixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ("steel-update-manifest-" + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($FixtureRoot) | Out-Null

try {
  $SignaturePath = Join-Path $FixtureRoot 'client.nsis.zip.sig'
  $ManifestPath = Join-Path $FixtureRoot 'latest.json'
  [IO.File]::WriteAllText($SignaturePath, 'trusted-minisign-signature', [Text.UTF8Encoding]::new($false))
  $Report = & $Generator `
    -Version '1.5.0' `
    -BundleUrl 'https://github.com/a1112/steel-plate-3d-inspection/releases/download/v1.5.0/client.nsis.zip' `
    -SignaturePath $SignaturePath `
    -Notes '稳定性更新' `
    -OutputPath $ManifestPath `
    -PublishedAt '2026-08-28T08:00:00Z' | ConvertFrom-Json
  $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json

  if ($Report.code -ne 0 -or
      [string]$Manifest.version -cne '1.5.0' -or
      ([DateTimeOffset]$Manifest.pub_date).ToUniversalTime().ToString('o') -cne '2026-08-28T08:00:00.0000000+00:00' -or
      [string]$Manifest.platforms.'windows-x86_64'.signature -cne 'trusted-minisign-signature' -or
      [string]$Manifest.platforms.'windows-x86_64'.url -cne 'https://github.com/a1112/steel-plate-3d-inspection/releases/download/v1.5.0/client.nsis.zip') {
    throw 'Generated updater manifest does not match the signed Windows release contract.'
  }

  $RejectedHttp = $false
  try {
    & $Generator `
      -Version '1.5.0' `
      -BundleUrl 'http://example.test/client.nsis.zip' `
      -SignaturePath $SignaturePath `
      -OutputPath $ManifestPath | Out-Null
  } catch {
    $RejectedHttp = $true
  }
  if (-not $RejectedHttp) {
    throw 'Updater manifest generator accepted an insecure HTTP bundle URL.'
  }

  [ordered]@{
    code = 0
    signedManifest = 'passed'
    insecureTransportRejection = 'passed'
  } | ConvertTo-Json -Compress
} finally {
  if (Test-Path -LiteralPath $FixtureRoot) {
    Remove-Item -LiteralPath $FixtureRoot -Recurse -Force
  }
}
