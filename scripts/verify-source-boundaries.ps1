param()

$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$Violations = [System.Collections.Generic.List[string]]::new()

function Assert-Path {
  param([string]$RelativePath)
  $Path = Join-Path $RepoRoot $RelativePath
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    $Violations.Add("missing required boundary file: $RelativePath")
  }
}

function Assert-NoPattern {
  param(
    [string]$RelativePath,
    [string]$Pattern,
    [string]$Message
  )
  $Path = Join-Path $RepoRoot $RelativePath
  if (-not (Test-Path -LiteralPath $Path)) {
    $Violations.Add("cannot check missing path: $RelativePath")
    return
  }
  $Matches = & rg -n --pcre2 $Pattern $Path
  if ($LASTEXITCODE -eq 0) {
    $Matches | ForEach-Object { Write-Host $_ }
    $Violations.Add($Message)
  } elseif ($LASTEXITCODE -gt 1) {
    throw "rg failed while checking $RelativePath"
  }
}

$ImageModules = @(
  'app/image-service/src/main.rs',
  'app/image-service/src/state.rs',
  'app/image-service/src/server.rs',
  'app/image-service/src/http.rs',
  'app/image-service/src/catalog.rs',
  'app/image-service/src/cache.rs',
  'app/image-service/src/image_codec.rs',
  'app/image-service/src/rendition.rs',
  'app/image-service/src/tile.rs'
)
$ImageModules | ForEach-Object { Assert-Path $_ }
Assert-Path 'docs/design/inspection-boundaries-responsive-thumbnail.md'

Assert-NoPattern `
  'app/image-service/src/main.rs' `
  'rusqlite|image::|TcpListener|serve_tile|serve_preview|read_http_request' `
  'image-service main.rs must remain bootstrap-only'
Assert-NoPattern `
  'app/image-service/src/rendition.rs' `
  'serve_tile|render_tile|TILE_SIZE|MAX_TILE_LEVEL' `
  'responsive rendition must remain independent of the legacy tile implementation'
Assert-NoPattern `
  'app/image-service/src/catalog.rs' `
  'image::|TcpListener|DynamicImage|FilterType' `
  'artifact catalog must not decode or transport images'
Assert-NoPattern `
  'app/image-service/src/server.rs' `
  'rusqlite|image::|ImageReader|FilterType' `
  'image server transport must not resolve catalog rows or process pixels'
Assert-NoPattern `
  'app/image-service/src' `
  '(?i)defect_detection|SickGenTLBackend|production_tasks|sea_orm|CamImageSource' `
  'media service must not acquire frames, run algorithms, or own production persistence'
Assert-NoPattern `
  'scripts/sick_flow_analysis_service.py' `
  'sick_capture\.(provider|gentl)|from\s+sick_capture\s+import\s+(provider|gentl)' `
  'pipeline worker must consume committed artifacts rather than provider or GenTL internals'
Assert-NoPattern `
  'app/client/src' `
  'SickGenTLBackend|build_and_write_flow|rusqlite|SELECT\s+.+\s+FROM\s+capture_file' `
  'desktop UI must not depend on camera, algorithm, source-database, or catalog internals'

if ($Violations.Count -gt 0) {
  $Violations | ForEach-Object { Write-Host $_ -ForegroundColor Red }
  throw "source boundary verification failed with $($Violations.Count) violation(s)"
}

Write-Warning 'Known migration debt: scripts/sick_capture/provider.py still contains legacy derived-artifact and playback imports. Do not add new derived processing there.'
Write-Host 'Source boundary verification passed.'
