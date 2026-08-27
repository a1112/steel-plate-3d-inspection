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
Assert-Path 'app/runtime-contract/src/lib.rs'
Assert-Path 'app/pipeline-workers/src/main.rs'
Assert-Path 'app/camera-worker/src/main.rs'
Assert-Path 'packages/contracts/schemas/steel.acquisition-manifest.v1.schema.json'
Assert-Path 'packages/contracts/schemas/steel.pipeline-task.v1.schema.json'
Assert-Path 'packages/contracts/schemas/steel.image-result.v1.schema.json'
Assert-Path 'packages/contracts/schemas/steel.defect-report.v1.schema.json'

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
  'scripts/sick_capture/provider.py' `
  'from\s+\.(alignment|measurement|defect_detection|surface|image_pipeline)\s+import|build_and_write_flow_(alignment|measurement|defect_detection|surface)|_schedule_flow_(alignment|defect_detection)|_alignment_worker|defect_detection_compute_pool' `
  'capture provider must not import or execute image geometry or defect algorithms'
Assert-NoPattern `
  'app/pipeline-workers' `
  '(?i)STEEL_BKV_|mysql|sea_orm|bkv' `
  'real-camera image and defect workers must not depend on the BKV adapter'
Assert-NoPattern `
  'app/camera-worker' `
  '(?i)STEEL_BKV_|mysql|sea_orm|defect_detection|image_pipeline' `
  'the formal camera host must only own the actual SICK capture provider'
Assert-NoPattern `
  'app/capture/src/steel_runtime_supervisor_main.cpp' `
  'capture-headless.+steel_capture_service|STEEL_CAPTURE_PROVIDER", L"headless-cpp' `
  'the formal Supervisor must not start the legacy LVM capture line'
Assert-NoPattern `
  'app/algorithm-service/src/main.rs' `
  '(?i)STEEL_SICK_|SickGenTLBackend|capture-origin|defect_detection|--role' `
  'the independent BKV adapter must not start or import the real-camera pipeline'
Assert-NoPattern `
  'app/algorithm-service/src/main.rs' `
  'STEEL_BAR_SURFACE_CORE_EXE|algorithmManifest|run_core_if_requested' `
  'the BKV adapter may import historical defect facts but must never execute defect inference'
Assert-NoPattern `
  'app/client/src' `
  'SickGenTLBackend|build_and_write_flow|rusqlite|SELECT\s+.+\s+FROM\s+capture_file' `
  'desktop UI must not depend on camera, algorithm, source-database, or catalog internals'

if ($Violations.Count -gt 0) {
  $Violations | ForEach-Object { Write-Host $_ -ForegroundColor Red }
  throw "source boundary verification failed with $($Violations.Count) violation(s)"
}

Write-Host 'Source boundary verification passed.'
