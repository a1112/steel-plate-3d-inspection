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

function Assert-Condition {
  param(
    [bool]$Condition,
    [string]$Message
  )
  if (-not $Condition) {
    $Violations.Add($Message)
  }
}

function Assert-TextContains {
  param(
    [string]$RelativePath,
    [string[]]$RequiredText,
    [string]$Message
  )
  $Path = Join-Path $RepoRoot $RelativePath
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    $Violations.Add("cannot check missing path: $RelativePath")
    return
  }
  $Text = Get-Content -LiteralPath $Path -Raw -Encoding utf8
  foreach ($Needle in $RequiredText) {
    if (-not $Text.Contains($Needle)) {
      $Violations.Add("$Message missing '$Needle' in $RelativePath")
    }
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
Assert-Path 'packages/contracts/schemas/steel.reproduction-manifest.v1.schema.json'
Assert-Path 'packages/contracts/schemas/steel.algorithm-dataset.v1.schema.json'
Assert-Path 'packages/contracts/schemas/steel.defect-annotation.v1.schema.json'
Assert-Path 'packages/contracts/schemas/steel.algorithm-benchmark.v1.schema.json'
Assert-Path 'packages/contracts/schemas/steel.algorithm-dataset-validation.v1.schema.json'
Assert-Path 'scripts/validate_algorithm_dataset.py'
Assert-Path 'scripts/test_validate_algorithm_dataset.py'
Assert-Path 'scripts/test-algorithm-acceptance-report-contract.ps1'

Assert-TextContains `
  'scripts/release-sbom-common.ps1' `
  @('cargo-algorithm-service', 'cargo-server-monitor', 'cargo-tray') `
  'release SBOM must inventory every first-party Rust dependency lock'
Assert-TextContains `
  'scripts/generate-release-sbom.ps1' `
  @('app/algorithm-service/Cargo.lock', 'app/server-monitor/Cargo.lock') `
  'release SBOM output guard must protect every first-party Rust dependency lock'
Assert-TextContains `
  'scripts/verify-packaged-release-sbom.ps1' `
  @("dependencyLockCount -ne 12", "Locks.Count -ne 12", 'cargo-algorithm-service', 'cargo-server-monitor') `
  'packaged release SBOM verification must bind all twelve dependency locks'
Assert-TextContains `
  'scripts/verify-independent-architecture.ps1' `
  @('build-evidence/algorithm-service-Cargo.lock', 'build-evidence/server-monitor-Cargo.lock', 'build-evidence/tray-Cargo.lock', '-Raw -Encoding UTF8') `
  'formal package verification must bind every dependency lock and read reviewed JSON as UTF-8'
Assert-TextContains `
  'app/client/src/components/DefectAnalysisPage.tsx' `
  @('className="defect-annotation-panel"', 'annotationTypeId', 'annotationSeverity', 'annotationNote') `
  'defect analysis must expose structured operator annotation controls'
Assert-TextContains `
  'app/client/src/App.tsx' `
  @('defectType: defect.typeId', 'severity: defect.severity') `
  'operator annotation must persist the selected category and severity'

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

# Reproducibility A0: the formal package, interactive development registry and
# normative documents must agree on service identities and ports. This is a
# source contract only; it does not claim target-machine or hardware readiness.
try {
  $RegistryPath = Join-Path $RepoRoot 'config\service-registry.json'
  $Registry = Get-Content -LiteralPath $RegistryPath -Raw -Encoding utf8 | ConvertFrom-Json
  Assert-Condition ([string]$Registry.schema -ceq 'steel.service-registry.v1') 'service registry schema must be steel.service-registry.v1'
  $ExpectedServices = [ordered]@{
    inspection = 4873
    image = 4874
    'image-worker' = 4875
    'defect-worker' = 4876
    capture = 4317
    trigger = 4881
  }
  $Services = @($Registry.services)
  Assert-Condition ($Services.Count -eq $ExpectedServices.Count) 'interactive service registry must contain exactly six managed service entries'
  foreach ($Entry in $ExpectedServices.GetEnumerator()) {
    $Matches = @($Services | Where-Object { [string]$_.id -ceq [string]$Entry.Key })
    Assert-Condition ($Matches.Count -eq 1) "service registry must contain exactly one '$($Entry.Key)' entry"
    if ($Matches.Count -ne 1) { continue }
    $Service = $Matches[0]
    try {
      $Origin = [Uri]([string]$Service.defaultOrigin)
      Assert-Condition ($Origin.Scheme -ceq 'http' -and $Origin.Host -ceq '127.0.0.1' -and $Origin.Port -eq [int]$Entry.Value) "service '$($Entry.Key)' must use loopback HTTP port $($Entry.Value)"
    } catch {
      $Violations.Add("service '$($Entry.Key)' has an invalid defaultOrigin")
    }
    Assert-Condition ($null -ne $Service.process) "service '$($Entry.Key)' must declare an interactive process contract"
  }
  $RegistryText = Get-Content -LiteralPath $RegistryPath -Raw -Encoding utf8
  Assert-Condition ($RegistryText -notmatch 'STEEL_BKV_') 'actual-camera interactive registry must not inject BKV credentials or configuration'
  $Inspection = @($Services | Where-Object { [string]$_.id -ceq 'inspection' })[0]
  Assert-Condition ([string]$Inspection.process.environment.STEEL_CAPTURE_MANAGED_BY_SUPERVISOR -ceq '1') 'interactive inspection service must not own the capture child when the monitor is lifecycle owner'
  Assert-Condition ([string]$Inspection.process.environment.STEEL_RESULT_PROXY_ONLY -ceq '1') 'interactive inspection service must remain result-proxy-only'
  $Capture = @($Services | Where-Object { [string]$_.id -ceq 'capture' })[0]
  $CaptureArguments = @($Capture.process.arguments) -join "`n"
  Assert-Condition ($CaptureArguments -match 'sick_capture_service\.py' -and $CaptureArguments -match 'sick-array-6') 'interactive capture entry must be the explicit six-camera SICK development provider'
} catch {
  $Violations.Add("service registry topology check failed: $($_.Exception.Message)")
}

try {
  $AlgorithmConfigPath = Join-Path $RepoRoot 'config\algorithm\bar-surface-production.json'
  $AlgorithmConfig = Get-Content -LiteralPath $AlgorithmConfigPath -Raw -Encoding utf8 | ConvertFrom-Json
  Assert-Condition ([string]$AlgorithmConfig.schema -ceq 'steel.algorithm-config.v1') 'formal algorithm config schema is invalid'
  Assert-Condition ([int]$AlgorithmConfig.qualityGate.requiredCameraCount -eq 6) 'formal algorithm quality gate must require exactly the six configured SICK cameras'
  Assert-Condition ($AlgorithmConfig.qualityGate.requireCalibrationForEveryCamera -eq $true) 'formal algorithm quality gate must require calibration for every SICK camera'
  Assert-Condition ([int]$AlgorithmConfig.qualityGate.maximumSyntheticDefectCount -eq 0) 'formal algorithm quality gate must forbid synthetic defects'
} catch {
  $Violations.Add("formal algorithm config topology check failed: $($_.Exception.Message)")
}

$FormalExecutables = @(
  'steel-image-service.exe',
  'steel-image-worker.exe',
  'steel-defect-worker.exe',
  'steel-capture-service.exe',
  'steel-inspection-service.exe',
  'steel-trigger-gateway.exe'
)
Assert-TextContains `
  'app/capture/src/steel_runtime_supervisor_main.cpp' `
  $FormalExecutables `
  'formal SCM supervisor must own all six production child executables;'
Assert-TextContains `
  'scripts/package-runtime.ps1' `
  $FormalExecutables `
  'formal runtime package must contain all six production child executables;'
Assert-TextContains `
  'scripts/test-algorithm-acceptance-report.ps1' `
  @('datasetValidationSha256', 'modelSetRevision', 'modelSetSha256', 'reproductionManifestRevision', 'reproductionManifestSha256', 'evaluatedAt', 'model_set_not_production_approved', 'approval_precedes_evaluation') `
  'formal algorithm acceptance must bind the complete reproducibility evidence chain;'
Assert-TextContains `
  'scripts/install-runtime-service.ps1' `
  @('-ModelSetPath $DefectModelManifestPath', 'expectedCameras -ne 6', 'enabled -eq $true') `
  'formal installer must bind the actual production model set and exact six-camera SICK profile;'
Assert-TextContains `
  'docs/runtime-boundaries-v2.md' `
  @('one Supervisor and six managed children', 'steel-image-worker.exe', 'steel-defect-worker.exe', 'steel-image-worker-bkv.exe') `
  'normative runtime boundary is incomplete;'
Assert-TextContains `
  'docs/independent-architecture.md' `
  @('Historical compatibility note', 'Runtime Boundaries V2') `
  'legacy architecture document must defer to the formal runtime boundary;'
Assert-TextContains `
  'docs/release-deployment-and-operations.md' `
  @('Runtime-V2 migration note', 'pre-migration historical evidence', 'six-camera SICK GenTL') `
  'release operations must distinguish historical eight-camera evidence from the formal six-camera topology;'
Assert-TextContains `
  'docs/production-readiness-gap-and-closure-design.md' `
  @('Runtime-V2 migration note', 'pre-migration historical evidence', 'six-camera SICK GenTL') `
  'production-readiness history must defer to the formal six-camera topology;'
Assert-NoPattern `
  'docs/split-runtime-pipeline.md' `
  'steel-algorithm-service\s*:4875|4875\s*算法服务|图像服务、4875\s*算法服务' `
  'split runtime documentation must not restore the obsolete single algorithm service as the production chain'

if ($Violations.Count -gt 0) {
  $Violations | ForEach-Object { Write-Host $_ -ForegroundColor Red }
  throw "source boundary verification failed with $($Violations.Count) violation(s)"
}

Write-Host 'Source boundary verification passed.'
