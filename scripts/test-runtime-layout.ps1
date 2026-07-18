param([string]$RuntimeRoot = "")

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
  if (Test-Path (Join-Path $PSScriptRoot "manifest.json") -PathType Leaf) {
    $RuntimeRoot = $PSScriptRoot
  } else {
    $RuntimeRoot = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) "target\runtime"
  }
}

$RuntimeRoot = (Resolve-Path $RuntimeRoot).Path
$ManifestPath = Join-Path $RuntimeRoot "manifest.json"

function Assert-PathExists {
  param(
    [string]$Path,
    [string]$Message,
    [ValidateSet("Any", "Leaf", "Container")]
    [string]$Type = "Any"
  )

  if ($Type -eq "Any") {
    if (-not (Test-Path $Path)) {
      throw $Message
    }
    return
  }

  if (-not (Test-Path $Path -PathType $Type)) {
    throw $Message
  }
}

function Assert-PowerShellScriptParses {
  param([string]$Path)

  Assert-PathExists $Path "Missing PowerShell script: $Path" "Leaf"
  $Tokens = $null
  $Errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$Tokens, [ref]$Errors) | Out-Null
  if ($Errors.Count -gt 0) {
    $Errors | Format-List | Out-String | Write-Host
    throw "PowerShell script has parse errors: $Path"
  }
}

function Resolve-RuntimePath {
  param([string]$RelativePath)
  return Join-Path $RuntimeRoot ($RelativePath -replace "/", "\")
}

Assert-PathExists $ManifestPath "Missing runtime manifest: $ManifestPath" "Leaf"
$Manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json

if ([string]$Manifest.formalCapture -ne "headless-cpp") {
  throw "Runtime manifest must declare headless-cpp as the formal capture provider."
}

$CalibrationOperations = $Manifest.migrationArchitecture.calibrationOperations
$CalibrationMutationRoutes = @($CalibrationOperations.mutationRoutes)
if (
  $null -eq $CalibrationOperations -or
  $CalibrationOperations.persistent -ne $true -or
  $CalibrationMutationRoutes.Count -ne 2 -or
  $CalibrationMutationRoutes -notcontains "POST /api/calibration/apply-all" -or
  $CalibrationMutationRoutes -notcontains "POST /api/calibration/rollback" -or
  [string]$CalibrationOperations.detailRoute -ne "GET /api/calibration/operations/detail" -or
  [string]$CalibrationOperations.idempotencyKey -ne "operationId" -or
  [string]$CalibrationOperations.interruptedStatus -ne "needs-reconciliation" -or
  [string]$CalibrationOperations.reconciledStatus -ne "reconciled" -or
  $CalibrationOperations.automaticReplay -ne $false -or
  $CalibrationOperations.dryRunPersisted -ne $false -or
  $CalibrationOperations.persistentMutationFence -ne $true -or
  [string]$CalibrationOperations.recoveryParentField -ne "parentOperationId" -or
  [string]$CalibrationOperations.recoveryOutcome -ne "restored-to-staged-baseline" -or
  @($CalibrationOperations.rollbackEvidence).Count -ne 2 -or
  @($CalibrationOperations.rollbackEvidence) -notcontains "complete" -or
  @($CalibrationOperations.rollbackEvidence) -notcontains "applyOperationId" -or
  [string]$CalibrationOperations.providerRollbackTokenDurability -ne "cross-restart-file-only" -or
  [string]$CalibrationOperations.providerRollbackFileFingerprint -ne "sha256+size" -or
  [string]$CalibrationOperations.providerRollbackManifest -ne "atomic-write-ahead-v1" -or
  $CalibrationOperations.providerStagedPreviousFiles -ne $true -or
  $CalibrationOperations.providerRecoveryFence -ne $true -or
  [string]$CalibrationOperations.realHardwareAcceptanceScript -ne "test-real-calibration-acceptance.ps1" -or
  $CalibrationOperations.realHardwareApplyRollbackRequiredForFullCoverage -ne $true -or
  [string]$CalibrationOperations.realHardwareCrashRecoveryScript -ne "test-real-calibration-crash-recovery.ps1" -or
  $CalibrationOperations.realHardwareCrashRecoveryRequiredForFullCoverage -ne $true -or
  [string]$CalibrationOperations.providerCrashFailpoint -ne "explicit-env-operation-phase-camera-bound-v1" -or
  [string]$CalibrationOperations.realHardwareIntegrityGenerationScript -ne "test-real-calibration-integrity-generation.ps1" -or
  $CalibrationOperations.realHardwareIntegrityGenerationRequiredForFullCoverage -ne $true -or
  (@($CalibrationOperations.decisiveRollbackPreflightEvidence | Sort-Object) -join ",") -ne "attempted,sideEffects" -or
  $CalibrationOperations.processCrashFaultInjectionSeparate -ne $true -or
  [int]$CalibrationOperations.requiredCameraCount -ne 8 -or
  $CalibrationOperations.uniqueCameraIps -ne $true -or
  $CalibrationOperations.uniqueExpectedSerials -ne $true -or
  $CalibrationOperations.uniqueSdkCalibrationPaths -ne $true -or
  $CalibrationOperations.arrayArtifactAsSdkCalibrationAllowed -ne $false
) {
  throw "Runtime manifest is missing the persistent calibration ledger or eight-camera calibration safety contract."
}

$IsTargetRuntimeManifest = -not [string]::IsNullOrWhiteSpace([string]$Manifest.captureHeadless)

$DeclaredWindowsServiceName = if ($IsTargetRuntimeManifest) {
  [string]$Manifest.windowsServiceName
} else {
  [string]$Manifest.service.windowsServiceName
}
if ($DeclaredWindowsServiceName -ne "SteelInspectionRuntime") {
  throw "Runtime manifest must declare the fixed SteelInspectionRuntime service name."
}

if ($IsTargetRuntimeManifest) {
  $RequiredFiles = [ordered]@{
    captureHeadless = $Manifest.captureHeadless
    service = $Manifest.service
    triggerGateway = $Manifest.triggerGateway
    serviceTriggerGateway = $Manifest.serviceTriggerGateway
    supervisor = $Manifest.supervisor
    client = $Manifest.client
    clientStatic = $Manifest.clientStatic
    integrated = $Manifest.integrated
    integratedFullAcceptanceTest = $Manifest.integratedFullAcceptanceTest
    integratedAcceptanceAuditTest = $Manifest.integratedAcceptanceAuditTest
    migrationArchitectureTest = $Manifest.migrationArchitectureTest
    integratedSmokeTest = $Manifest.integratedSmokeTest
    triggerSecurityTest = $Manifest.triggerSecurityTest
    integratedReadyTest = $Manifest.integratedReadyTest
    runtimeAcceptanceTest = $Manifest.runtimeAcceptanceTest
    runtimeLayoutTest = $Manifest.runtimeLayoutTest
    runtimeSupervisorTest = $Manifest.runtimeSupervisorTest
    installRuntimeService = $Manifest.installRuntimeService
    uninstallRuntimeService = $Manifest.uninstallRuntimeService
    runtimeUiSmokeTest = $Manifest.runtimeUiSmokeTest
    realHardwareAcceptanceTest = $Manifest.realHardwareAcceptanceTest
    realCalibrationAcceptanceTest = $Manifest.realCalibrationAcceptanceTest
    realCalibrationCrashRecoveryTest = $Manifest.realCalibrationCrashRecoveryTest
    realCalibrationIntegrityGenerationTest = $Manifest.realCalibrationIntegrityGenerationTest
    productionStabilityTest = $Manifest.productionStabilityTest
    productionStabilityWorkRootContractTest = $Manifest.productionStabilityWorkRootContractTest
    barSurfaceE2ETest = $Manifest.barSurfaceE2ETest
    algorithmCore = $Manifest.algorithmCore
    algorithmConfig = $Manifest.algorithmConfig
    algorithmAcceptanceTemplate = $Manifest.algorithmAcceptanceTemplate
    algorithmAcceptanceTest = $Manifest.algorithmAcceptanceTest
    functionalGoLivePlanTemplate = $Manifest.functionalGoLivePlanTemplate
    plcL2FunctionalAcceptanceTemplate = $Manifest.plcL2FunctionalAcceptanceTemplate
    targetMachineFunctionalAcceptanceTemplate = $Manifest.targetMachineFunctionalAcceptanceTemplate
    functionalScenarioEvidenceTemplate = $Manifest.functionalScenarioEvidenceTemplate
    functionalGoLiveReadinessTest = $Manifest.functionalGoLiveReadinessTest
    functionalScenarioEvidenceGenerator = $Manifest.functionalScenarioEvidenceGenerator
    functionalAcceptanceWorkspaceInitializer = $Manifest.functionalAcceptanceWorkspaceInitializer
    functionalAcceptanceWorkspaceContractTest = $Manifest.functionalAcceptanceWorkspaceContractTest
    functionalScenarioEvidenceAttacher = $Manifest.functionalScenarioEvidenceAttacher
    functionalScenarioAttachmentContractTest = $Manifest.functionalScenarioAttachmentContractTest
    algorithmTraceabilityTest = $Manifest.algorithmTraceabilityTest
    databaseContractVerify = $Manifest.databaseContractVerify
    databaseContractTest = $Manifest.databaseContractTest
    databaseRecoveryCommon = $Manifest.databaseRecoveryCommon
  }

  if ($Manifest.dlls.captureSdk) {
    $RequiredFiles.captureSdkDll = $Manifest.dlls.captureSdk
  }
} else {
  $RequiredFiles = [ordered]@{
    captureHeadless = $Manifest.capture.path
    service = $Manifest.service.path
    triggerGateway = $Manifest.service.triggerGateway
    supervisor = $Manifest.service.supervisor
    client = $Manifest.client.path
    clientStatic = $Manifest.scripts.clientStatic
    integrated = $Manifest.scripts.integrated
    integratedFullAcceptanceTest = $Manifest.scripts.integratedFullAcceptanceTest
    integratedAcceptanceAuditTest = $Manifest.scripts.integratedAcceptanceAuditTest
    migrationArchitectureTest = $Manifest.scripts.migrationArchitectureTest
    integratedSmokeTest = $Manifest.scripts.integratedSmokeTest
    triggerSecurityTest = $Manifest.scripts.triggerSecurityTest
    integratedReadyTest = $Manifest.scripts.integratedReadyTest
    runtimeAcceptanceTest = $Manifest.scripts.runtimeAcceptanceTest
    runtimeLayoutTest = $Manifest.scripts.runtimeLayoutTest
    runtimePackageVerify = $Manifest.scripts.runtimePackageVerify
    runtimeSupervisorTest = $Manifest.scripts.runtimeSupervisorTest
    installRuntimeService = $Manifest.scripts.installRuntimeService
    uninstallRuntimeService = $Manifest.scripts.uninstallRuntimeService
    runtimeUiSmokeTest = $Manifest.scripts.runtimeUiSmokeTest
    realHardwareAcceptanceTest = $Manifest.scripts.realHardwareAcceptanceTest
    realCalibrationAcceptanceTest = $Manifest.scripts.realCalibrationAcceptanceTest
    realCalibrationCrashRecoveryTest = $Manifest.scripts.realCalibrationCrashRecoveryTest
    realCalibrationIntegrityGenerationTest = $Manifest.scripts.realCalibrationIntegrityGenerationTest
    productionStabilityTest = $Manifest.scripts.productionStabilityTest
    productionStabilityWorkRootContractTest = $Manifest.scripts.productionStabilityWorkRootContractTest
    barSurfaceE2ETest = $Manifest.scripts.barSurfaceE2ETest
    stop = $Manifest.scripts.stop
    captureSdkDll = $Manifest.capture.sdk
    algorithmCore = $Manifest.algorithm.core
    algorithmConfig = $Manifest.config.algorithm
    algorithmAcceptanceTemplate = $Manifest.config.algorithmAcceptanceTemplate
    algorithmAcceptanceTest = $Manifest.scripts.algorithmAcceptanceTest
    functionalGoLivePlanTemplate = $Manifest.config.functionalGoLivePlanTemplate
    plcL2FunctionalAcceptanceTemplate = $Manifest.config.plcL2FunctionalAcceptanceTemplate
    targetMachineFunctionalAcceptanceTemplate = $Manifest.config.targetMachineFunctionalAcceptanceTemplate
    functionalScenarioEvidenceTemplate = $Manifest.config.functionalScenarioEvidenceTemplate
    functionalGoLiveReadinessTest = $Manifest.scripts.functionalGoLiveReadinessTest
    functionalScenarioEvidenceGenerator = $Manifest.scripts.functionalScenarioEvidenceGenerator
    functionalAcceptanceWorkspaceInitializer = $Manifest.scripts.functionalAcceptanceWorkspaceInitializer
    functionalAcceptanceWorkspaceContractTest = $Manifest.scripts.functionalAcceptanceWorkspaceContractTest
    functionalScenarioEvidenceAttacher = $Manifest.scripts.functionalScenarioEvidenceAttacher
    functionalScenarioAttachmentContractTest = $Manifest.scripts.functionalScenarioAttachmentContractTest
    algorithmTraceabilityTest = $Manifest.scripts.algorithmTraceabilityTest
    databaseContractVerify = $Manifest.scripts.databaseContractVerify
    databaseContractTest = $Manifest.scripts.databaseContractTest
    databaseRecoveryCommon = $Manifest.scripts.databaseRecoveryCommon
    releaseSbomStaticVerify = $Manifest.scripts.releaseSbomStaticVerify
  }
}

foreach ($Entry in $RequiredFiles.GetEnumerator()) {
  if ([string]::IsNullOrWhiteSpace([string]$Entry.Value)) {
    throw "Runtime manifest missing $($Entry.Key)"
  }
  Assert-PathExists (Resolve-RuntimePath ([string]$Entry.Value)) "Runtime manifest points to missing $($Entry.Key): $($Entry.Value)" "Leaf"
}

$MigrationArchitectureTestPath = Resolve-RuntimePath ([string]$RequiredFiles.migrationArchitectureTest)
$MigrationArchitectureReportText = (& $MigrationArchitectureTestPath -ManifestPath $ManifestPath | Out-String)
$MigrationArchitectureReport = $MigrationArchitectureReportText | ConvertFrom-Json
if ($MigrationArchitectureReport.code -ne 0) {
  throw "Runtime manifest failed the architecture migration contract."
}

$ScriptNames = if ($IsTargetRuntimeManifest) {
  @(
    "run-capture-headless.ps1",
    "run-service-headless.ps1",
    "run-service-simulated.ps1",
    "run-trigger-gateway.ps1",
    "run-integrated-capture-management.ps1",
    "run-client-static.ps1",
    "stop-runtime.ps1",
    "test-integrated-management-smoke.ps1",
    "test-trigger-gateway-security.ps1",
    "test-integrated-runtime-ready.ps1",
    "test-integrated-capture-management-full.ps1",
    "test-integrated-acceptance-audit.ps1",
    "test-architecture-migration-contract.ps1",
    "test-runtime-acceptance.ps1",
    "test-real-hardware-acceptance.ps1",
    "test-real-calibration-acceptance.ps1",
    "test-real-calibration-crash-recovery.ps1",
    "test-real-calibration-integrity-generation.ps1",
    "test-production-stability.ps1",
    "test-production-stability-workroot-contract.ps1",
    "test-runtime-ui-smoke.ps1",
    "scripts\test-bar-surface-e2e.ps1",
    "test-runtime-layout.ps1",
    "test-runtime-supervisor.ps1",
    "test-algorithm-acceptance-report.ps1",
    "test-functional-go-live-readiness.ps1",
    "new-functional-scenario-evidence.ps1",
    "new-functional-acceptance-workspace.ps1",
    "test-functional-acceptance-workspace-contract.ps1",
    "add-functional-scenario-evidence.ps1",
    "test-functional-scenario-attachment-contract.ps1",
    "verify-database-migration-contract.ps1",
    "test-database-migration-contract.ps1",
    "database-recovery-common.ps1",
    "manage-report-archives.ps1",
    "test-report-archive-recovery.ps1",
    "install-runtime-service.ps1",
    "uninstall-runtime-service.ps1"
  )
} else {
  @(
    "run-capture-headless.ps1",
    "run-service-external.ps1",
    "run-service-managed.ps1",
    "run-service-simulated.ps1",
    "run-trigger-gateway.ps1",
    "run-integrated-capture-management.ps1",
    "run-client-static.ps1",
    "stop-runtime.ps1",
    "test-integrated-management-smoke.ps1",
    "test-trigger-gateway-security.ps1",
    "test-integrated-runtime-ready.ps1",
    "test-integrated-capture-management-full.ps1",
    "test-integrated-acceptance-audit.ps1",
    "test-architecture-migration-contract.ps1",
    "test-runtime-acceptance.ps1",
    "test-real-hardware-acceptance.ps1",
    "test-real-calibration-acceptance.ps1",
    "test-real-calibration-crash-recovery.ps1",
    "test-real-calibration-integrity-generation.ps1",
    "test-production-stability.ps1",
    "test-production-stability-workroot-contract.ps1",
    "test-runtime-ui-smoke.ps1",
    "scripts\test-bar-surface-e2e.ps1",
    "test-runtime-layout.ps1",
    "verify-independent-architecture.ps1",
    "verify-runtime-package.ps1",
    "verify-packaged-release-sbom.ps1",
    "test-runtime-supervisor.ps1",
    "test-algorithm-acceptance-report.ps1",
    "test-functional-go-live-readiness.ps1",
    "new-functional-scenario-evidence.ps1",
    "new-functional-acceptance-workspace.ps1",
    "test-functional-acceptance-workspace-contract.ps1",
    "add-functional-scenario-evidence.ps1",
    "test-functional-scenario-attachment-contract.ps1",
    "verify-database-migration-contract.ps1",
    "test-database-migration-contract.ps1",
    "database-recovery-common.ps1",
    "manage-report-archives.ps1",
    "test-report-archive-recovery.ps1",
    "install-runtime-service.ps1",
    "uninstall-runtime-service.ps1"
  )
}
foreach ($ScriptName in $ScriptNames) {
  Assert-PowerShellScriptParses (Join-Path $RuntimeRoot $ScriptName)
}

$DatabaseContractVerifierPath = Resolve-RuntimePath ([string]$RequiredFiles.databaseContractVerify)
$DatabaseContractReportText = (& $DatabaseContractVerifierPath `
  -PackageRoot $RuntimeRoot `
  -ManifestPath $ManifestPath | Out-String)
$DatabaseContractReport = $DatabaseContractReportText | ConvertFrom-Json
if ($DatabaseContractReport.code -ne 0 -or
    [string]$DatabaseContractReport.schema -cne 'steel.database-contract-verification.v1' -or
    [long]$DatabaseContractReport.schemaVersion -ne 1) {
  throw "Runtime package failed the database migration contract."
}
$AlgorithmTraceabilityTest = Join-Path $RuntimeRoot "scripts\test_algorithm_traceability.py"
& python -B $AlgorithmTraceabilityTest
if ($LASTEXITCODE -ne 0) {
  throw "Packaged algorithm traceability test failed."
}

$CaptureConfigRoot = Join-Path $RuntimeRoot "config\capture"
$CalibrationAcceptancePlanExample = Join-Path $CaptureConfigRoot "calibration-acceptance-plan.example.json"
Assert-PathExists $CalibrationAcceptancePlanExample "Runtime is missing the reviewed eight-camera calibration acceptance plan template." "Leaf"
$CaptureProfileName = "current-8-time-trigger"
$CaptureProfilePath = Join-Path $CaptureConfigRoot "profiles\$CaptureProfileName\profile.json"
$CaptureActiveProfilePath = Join-Path $CaptureConfigRoot "active-profile.txt"
$CaptureCalibrationPath = Join-Path $CaptureConfigRoot "calibrations\$CaptureProfileName\ArrayCalibration.xml"

Assert-PathExists $CaptureProfilePath "Runtime capture config is missing $CaptureProfileName profile." "Leaf"
Assert-PathExists $CaptureActiveProfilePath "Runtime capture config is missing active-profile.txt." "Leaf"
Assert-PathExists $CaptureCalibrationPath "Runtime capture config is missing corrected array calibration XML." "Leaf"
Assert-PathExists (Join-Path $RuntimeRoot "scripts\bar_surface_reconstruct.py") "Runtime package is missing bar surface reconstruction script." "Leaf"
Assert-PathExists (Join-Path $RuntimeRoot "scripts\fit_array_calibration_cross_section.py") "Runtime package is missing calibration fit script." "Leaf"
Assert-PathExists (Join-Path $RuntimeRoot "algorithm-core\steel_bar_surface_core.exe") "Runtime package is missing bar surface C++ core executable." "Leaf"

$ActiveProfile = (Get-Content $CaptureActiveProfilePath -Raw).Trim()
if ($ActiveProfile -ne $CaptureProfileName) {
  throw "Runtime capture active profile must be $CaptureProfileName, got $ActiveProfile"
}

$CaptureProfile = Get-Content $CaptureProfilePath -Raw | ConvertFrom-Json
if ($CaptureProfile.loadCameraParams -ne $false) {
  throw "Runtime capture profile must default to built-in camera parameters; loadCameraParams should be false."
}
if ($CaptureProfile.changeStorage -ne $false) {
  throw "Runtime capture profile must not overwrite the provider storage root on startup."
}
if (@($CaptureProfile.cameras).Count -ne 8) {
  throw "Runtime capture profile must describe eight cameras."
}

$StopScript = Join-Path $RuntimeRoot "stop-runtime.ps1"
$StopText = Get-Content $StopScript -Raw
foreach ($RequiredText in @("Get-NetTCPConnection", "netstat -ano", "1432", ".Id -gt 4", '-ne $PID')) {
  if ($StopText -notmatch [regex]::Escape($RequiredText)) {
    throw "stop-runtime.ps1 must stop static-client listeners by port using $RequiredText"
  }
}

$IntegratedText = Get-Content (Join-Path $RuntimeRoot "run-integrated-capture-management.ps1") -Raw
foreach ($RequiredText in @("/health", "/api/production/status", "/api/trigger/status", "run-client-static.ps1", "StopExisting", "stop-runtime.ps1", "Wait-HttpHtml", "Client ready", "Assert-CaptureProviderMatches", "storageRoot", "configRoot")) {
  if ($IntegratedText -notmatch [regex]::Escape($RequiredText)) {
    throw "run-integrated-capture-management.ps1 must wait for or invoke $RequiredText"
  }
}

foreach ($CaptureScriptName in @("run-capture-headless.ps1", "run-integrated-capture-management.ps1")) {
  $CaptureScript = Join-Path $RuntimeRoot $CaptureScriptName
  if (-not (Test-Path $CaptureScript -PathType Leaf)) {
    continue
  }
  $CaptureText = Get-Content $CaptureScript -Raw
  if ($CaptureText -match [regex]::Escape("H:\steel-capture-data")) {
    throw "$CaptureScriptName must default to H:\ so production frames land under H:\camera1..camera8, not H:\steel-capture-data."
  }
  $RequiredStorageTexts = if ($CaptureScriptName -eq "run-integrated-capture-management.ps1") {
    @('[string]$StorageRoot = "H:\"', '[string]$CameraStorageRoot = "H:\"', "-CameraStorageRoot")
  } else {
    @('[string]$StorageRoot = "H:\"', '[string]$CameraStorageRoot = "H:\"', '$env:CAPTURE_CAMERA_STORAGE_ROOT = $CameraStorageRoot')
  }
  foreach ($RequiredText in $RequiredStorageTexts) {
    if ($CaptureText -notmatch [regex]::Escape($RequiredText)) {
      throw "$CaptureScriptName must keep the H:\ production storage default via $RequiredText"
    }
  }
}

$SmokeText = Get-Content (Join-Path $RuntimeRoot "test-integrated-management-smoke.ps1") -Raw
foreach ($RequiredText in @("/api/production/tasks/steel-info", "/api/production/tasks/steel-in", "/api/production/tasks/steel-out", "/api/production/tasks", "/api/production/tasks/detail", "/api/trigger/manual/steel-in", "recordWrittenBeforeCapture", "/api/system/network", "totalUploadMbps", "totalDownloadMbps", "totalBandwidthMbps", "uploadMbps", "downloadMbps", "rateFields", "/api/production/capture-once", "captureGuard", "captureOnce", "captureFileRows", "durableTasks", "chainId", "dependsOnTaskId", "dependencyPolicy", "require-success", "dependencyOrder", "requestId", "RunId", 'runs\$RunId\work', "steel-runtime-package-smoke", "-ConfigRoot", '[string]$WorkRoot', "Write-SmokeReport", "reportPath", "startedProcesses", "startedListeners")) {
  if ($SmokeText -notmatch [regex]::Escape($RequiredText)) {
    throw "test-integrated-management-smoke.ps1 must verify $RequiredText"
  }
}

$TriggerSecurityText = Get-Content (Join-Path $RuntimeRoot "test-trigger-gateway-security.ps1") -Raw
foreach ($RequiredText in @("STEEL_RUNTIME_PROFILE", "production", "TRIGGER_SHARED_SECRET", "TRIGGER_OPERATOR_TOKEN", "TRIGGER_SOURCE_ALLOWLIST", "HMACSHA256", "steel-trigger-v1", "X-Trigger-Timestamp", "X-Trigger-Nonce", "X-Trigger-Signature", "X-Trigger-Operator-Token", "trigger_replay_detected", "trigger_operator_auth_required", "trigger_mode_locked", "Access-Control-Allow-Origin", "missingSecretFailClosed", "operatorCredentialSeparated", 'transports = @("http", "tcp", "udp")', "statusRedacted", "trigger-security-report.json")) {
  if ($TriggerSecurityText -notmatch [regex]::Escape($RequiredText)) {
    throw "test-trigger-gateway-security.ps1 must verify $RequiredText"
  }
}

$TriggerRunText = Get-Content (Join-Path $RuntimeRoot "run-trigger-gateway.ps1") -Raw
foreach ($RequiredText in @('[string]$RuntimeProfile = "production"', "STEEL_RUNTIME_PROFILE", "TRIGGER_SOURCE_ALLOWLIST", "TRIGGER_ALLOW_MODE_MUTATION")) {
  if ($TriggerRunText -notmatch [regex]::Escape($RequiredText)) {
    throw "run-trigger-gateway.ps1 must enforce the production trigger boundary via $RequiredText"
  }
}

foreach ($ServiceScriptName in @("run-service-simulated.ps1", "run-service-external.ps1", "run-service-managed.ps1")) {
  $ServiceScript = Join-Path $RuntimeRoot $ServiceScriptName
  if (-not (Test-Path $ServiceScript -PathType Leaf)) {
    continue
  }
  $ServiceText = Get-Content $ServiceScript -Raw
  foreach ($RequiredText in @('[string]$ConfigRoot', '$env:STEEL_SERVICE_CONFIG_DIR = $ConfigRoot')) {
    if ($ServiceText -notmatch [regex]::Escape($RequiredText)) {
      throw "$ServiceScriptName must support isolated service config roots via $RequiredText"
    }
  }
  foreach ($RequiredText in @('$env:STEEL_WORKSPACE_ROOT = $Root', '$env:STEEL_BAR_SURFACE_CORE_EXE = Join-Path $Root "algorithm-core\steel_bar_surface_core.exe"')) {
    if ($ServiceText -notmatch [regex]::Escape($RequiredText)) {
      throw "$ServiceScriptName must expose packaged algorithm assets via $RequiredText"
    }
  }
}

$ReadyText = Get-Content (Join-Path $RuntimeRoot "test-integrated-runtime-ready.ps1") -Raw
foreach ($RequiredText in @("/health", "/api/health/details", "/api/production/status", "/api/system/network", "database", "taskWorker", "capture", "calibrationReconciliation", "storage", "trigger", "trigger.required", "totalUploadMbps", "totalDownloadMbps", "totalBandwidthMbps", "uploadMbps", "downloadMbps", "bandwidthMbps", "/api/trigger/status", "?app=terminal")) {
  if ($ReadyText -notmatch [regex]::Escape($RequiredText)) {
    throw "test-integrated-runtime-ready.ps1 must verify $RequiredText"
  }
}

$IntegratedFullText = Get-Content (Join-Path $RuntimeRoot "test-integrated-capture-management-full.ps1") -Raw
foreach ($RequiredText in @(
  "steel.integrated-capture-management.acceptance.v1",
  "test-runtime-layout.ps1",
  "test-integrated-runtime-ready.ps1",
  "test-trigger-gateway-security.ps1",
  "test-real-hardware-acceptance.ps1",
  "test-real-calibration-acceptance.ps1",
  "test-runtime-ui-smoke.ps1",
  "test-bar-surface-e2e.ps1",
  "test-production-stability.ps1",
  "RunCapture",
  "RunCalibrationApplyRollback",
  "CalibrationSafetyConfirmation",
  "ApplyCrashRecoveryReportPath",
  "RollbackCrashRecoveryReportPath",
  "CalibrationIntegrityGenerationReportPath",
  "ReleaseIdentity",
  "manifestSha256",
  "RunBarSurface",
  "RunShortStability",
  "StabilityDurationSec",
  "StabilityIntervalSec",
  "StabilityRunAlgorithmEvery",
  "StabilityUseTriggerGateway",
  "RequireFullCoverage",
  "coverage",
  "full =",
  "covered =",
  "required =",
  "uncovered",
  "trigger-gateway-route",
  "production-trigger-security",
  "real-calibration-apply-rollback",
  "real-calibration-crash-recovery",
  "real-calibration-integrity-generation",
  "bar-surface-e2e",
  "integrated-capture-management",
  "reportPath"
)) {
  if ($IntegratedFullText -notmatch [regex]::Escape($RequiredText)) {
    throw "test-integrated-capture-management-full.ps1 must orchestrate $RequiredText"
  }
}

$IntegratedAuditText = Get-Content (Join-Path $RuntimeRoot "test-integrated-acceptance-audit.ps1") -Raw
foreach ($RequiredText in @(
  "steel.integrated-capture-management.acceptance-audit.v1",
  "ICM-01",
  "ICM-23",
  "ICM-24",
  'RequiredCount = 24',
  "test-architecture-migration-contract.ps1",
  "integratedReportPath",
  "tenMinuteReportPath",
  "acceptance-audit",
  "MinEnduranceCycles",
  "estimated-speed fallback",
  "calibrated-3d",
  "sdkDerived",
  "trigger-gateway-route",
  "trigger-security",
  "HMAC-SHA256",
  "verify-independent-architecture.ps1"
  "steel.real-calibration.acceptance.v1"
  "steel.real-calibration.crash-recovery.v1"
  "steel.real-calibration.integrity-generation.v1"
)) {
  if ($IntegratedAuditText -notmatch [regex]::Escape($RequiredText)) {
    throw "test-integrated-acceptance-audit.ps1 must verify $RequiredText"
  }
}

$IntegratedAcceptanceDoc = Join-Path $RuntimeRoot "docs\integrated-capture-management-acceptance.md"
$ReleaseOperationsDoc = Join-Path $RuntimeRoot "docs\release-deployment-and-operations.md"
$ReadinessClosureDoc = Join-Path $RuntimeRoot "docs\production-readiness-gap-and-closure-design.md"
$AtomicUpgradeDoc = Join-Path $RuntimeRoot "docs\atomic-upgrade-and-database-migration-design.md"
$ScriptRunbook = Join-Path $RuntimeRoot "scripts\README.md"
Assert-PathExists $ReleaseOperationsDoc "Runtime is missing the release deployment and operations runbook." "Leaf"
Assert-PathExists $ReadinessClosureDoc "Runtime is missing the production readiness closure design." "Leaf"
Assert-PathExists $AtomicUpgradeDoc "Runtime is missing the atomic upgrade and database migration design." "Leaf"
Assert-PathExists $ScriptRunbook "Runtime is missing the script usage runbook at scripts/README.md." "Leaf"
Assert-PathExists $IntegratedAcceptanceDoc "Missing integrated capture management acceptance matrix: $IntegratedAcceptanceDoc" "Leaf"
$AtomicUpgradeDocText = Get-Content $AtomicUpgradeDoc -Raw
foreach ($RequiredText in @(
  "Global\SteelInspectionRuntime-Deployment",
  "steel.database-backup.v2",
  "failed-safe",
  "P0 No-Go"
)) {
  if ($AtomicUpgradeDocText -notmatch [regex]::Escape($RequiredText)) {
    throw "atomic-upgrade-and-database-migration-design.md must document $RequiredText"
  }
}
$IntegratedAcceptanceDocText = Get-Content $IntegratedAcceptanceDoc -Raw
foreach ($RequiredText in @(
  "Integrated Capture Management Acceptance Matrix",
  "RequireFullCoverage",
  "coverage.full",
  "coverage.covered",
  "coverage.required",
  "ICM-01",
  "ICM-23",
  "ICM-24",
  "summary.passed=24",
  "test-architecture-migration-contract.ps1",
  "H:\camera1",
  "integrated-capture-management-20260709-121522-831.json",
  "BAR-STABILITY-20260709-121618-010",
  "BAR-STABILITY-20260709-114929-127",
  "production-stability-20260709-114934-134.json",
  "estimated-speed fallback",
  "calibrated-3d"
)) {
  if ($IntegratedAcceptanceDocText -notmatch [regex]::Escape($RequiredText)) {
    throw "integrated-capture-management-acceptance.md must document $RequiredText"
  }
}

$UiSmokeText = Get-Content (Join-Path $RuntimeRoot "test-runtime-ui-smoke.ps1") -Raw
foreach ($RequiredText in @(
  "steel.runtime.ui-smoke.v1",
  "Target.createTarget",
  "Page.captureScreenshot",
  "receiver-status-button",
  "\u5b9e\u65f6\u4e0a\u4f20",
  "\u5b9e\u65f6\u4e0b\u8f7d",
  "\u5e26\u5bbd\u76d1\u63a7",
  "Windows \u7f51\u5361\u5b9e\u65f6\u6536\u53d1\u901f\u7387",
  "network monitor pending",
  "network monitor offline",
  "\u4f30\u7b97\u7f51\u901f",
  "terminal",
  "capture",
  "bar-surface",
  "ui-smoke-report.json",
  "msedge.exe",
  "chrome.exe"
)) {
  if ($UiSmokeText -notmatch [regex]::Escape($RequiredText)) {
    throw "test-runtime-ui-smoke.ps1 must verify $RequiredText"
  }
}

$AcceptanceText = Get-Content (Join-Path $RuntimeRoot "test-runtime-acceptance.ps1") -Raw
foreach ($RequiredText in @("test-runtime-layout.ps1", "test-integrated-management-smoke.ps1", "test-trigger-gateway-security.ps1", "TriggerSecuritySummary", "missingSecretFailClosed", "operatorCredentialSeparated", "replayRejected.http", "replayRejected.tcp", "replayRejected.udp", "modeMutationLocked", "wildcardCors", "statusRedacted", "Stop-AcceptancePorts", "Get-NetTCPConnection", "netstat -ano", "SteelInspectionRuntimeAcceptance", "Assert-SmokeResult", "Read-JsonFromOutput", "reportPath", "service.network", "network =", "totalUploadMbps", "totalDownloadMbps", "totalBandwidthMbps", "rateFields", "captureGuard", "captureOnce", "captureFileRows")) {
  if ($AcceptanceText -notmatch [regex]::Escape($RequiredText)) {
    throw "test-runtime-acceptance.ps1 must run $RequiredText"
  }
}

$RealHardwareText = Get-Content (Join-Path $RuntimeRoot "test-real-hardware-acceptance.ps1") -Raw
foreach ($RequiredText in @("/api/production/capture-once", "/api/system/network", "totalUploadMbps", "totalDownloadMbps", "totalBandwidthMbps", "uploadMbps", "downloadMbps", "H:\camera", "saveSdkDerived", "productionLayout", "productionSummary", "summaryOutput", "latestInspection", "steel.production.summary.v1", "captureFiles")) {
  if ($RealHardwareText -notmatch [regex]::Escape($RequiredText)) {
    throw "test-real-hardware-acceptance.ps1 must verify $RequiredText"
  }
}

$RealCalibrationText = Get-Content (Join-Path $RuntimeRoot "test-real-calibration-acceptance.ps1") -Raw
foreach ($RequiredText in @("steel.real-calibration.acceptance.v1", "/api/calibration/apply-all", "/api/calibration/rollback", "/api/calibration/operations/detail", "APPLY CAMERA CALIBRATION SET", "ROLLBACK CAMERA CALIBRATION", "PERSIST CAMERA PARAMETERS", "/api/capture/continuous-test", "calibrationReconciliation", "does not prove a process crash")) {
  if ($RealCalibrationText -notmatch [regex]::Escape($RequiredText)) {
    throw "test-real-calibration-acceptance.ps1 must verify $RequiredText"
  }
}

$RealCalibrationCrashText = Get-Content (Join-Path $RuntimeRoot "test-real-calibration-crash-recovery.ps1") -Raw
foreach ($RequiredText in @("steel.real-calibration.crash-recovery.v1", "ApplyCrash", "RollbackCrash", "calibrationCrashFailpointArmed", "needs-reconciliation", "expectedApplyOperationId", "parentOperationId", "reconciled", "/api/capture/continuous-test")) {
  if ($RealCalibrationCrashText -notmatch [regex]::Escape($RequiredText)) {
    throw "test-real-calibration-crash-recovery.ps1 must verify $RequiredText"
  }
}

$RealCalibrationIntegrityText = Get-Content (Join-Path $RuntimeRoot "test-real-calibration-integrity-generation.ps1") -Raw
foreach ($RequiredText in @("steel.real-calibration.integrity-generation.v1", "sideEffects", "zeroWriteEvidence", "staleGeneration", "stagedTamper", "recovery", "/api/capture/continuous-test")) {
  if ($RealCalibrationIntegrityText -notmatch [regex]::Escape($RequiredText)) {
    throw "test-real-calibration-integrity-generation.ps1 must verify $RequiredText"
  }
}

$ProductionStabilityText = Get-Content (Join-Path $RuntimeRoot "test-production-stability.ps1") -Raw
foreach ($RequiredText in @("/api/production/steel-in", "/api/production/capture-once", "/api/production/steel-out", "/api/production/algorithm/run", "/api/system/network", "/api/trigger/manual/steel-in", "/api/trigger/capture-once", "UseTriggerGateway", "triggerRoute", "totalUploadMbps", "totalDownloadMbps", "totalBandwidthMbps", "uploadMbps", "downloadMbps", "steel.production.stability.v1", "steel.production.summary.v1", "H:\", "RunAlgorithmEvery", "activeSession", "sdkDerived", "HardwareCaptureConfigurationRequired", "not-applicable-simulated-provider", "simulated-uri-ledger", 'simulated://$MaterialId/*', '[string]$WorkRoot', '[string]$ReleaseManifestPath', "manifestSha256", "steel-runtime-package-stability", "queueDepthAvailable", "activeTaskId", "admission.inFlight", "identityBinding", "identityIsolation", "finalConvergence", "Resolve-ProductionSummaryPath", "ProviderSummaryOutput", "Join-Path `$WorkRoot `$ProviderSummaryOutput")) {
  if ($ProductionStabilityText -notmatch [regex]::Escape($RequiredText)) {
    throw "test-production-stability.ps1 must verify $RequiredText"
  }
}

$ProductionStabilityWorkRootContractText = Get-Content (Join-Path $RuntimeRoot "test-production-stability-workroot-contract.ps1") -Raw
foreach ($RequiredText in @(
  "steel.production-stability-workroot.contract-test.v1",
  "KeepRunning smoke launcher did not return",
  "startedProcesses",
  "startedListeners",
  "relative provider.summaryOutput",
  "summary-contained-in-workroot",
  "production-cycle-converged",
  "Stop-ContractProcesses"
)) {
  if ($ProductionStabilityWorkRootContractText -notmatch [regex]::Escape($RequiredText)) {
    throw "test-production-stability-workroot-contract.ps1 must contain $RequiredText"
  }
}

$FunctionalGoLiveText = Get-Content (Join-Path $RuntimeRoot "test-functional-go-live-readiness.ps1") -Raw
foreach ($RequiredText in @(
  "steel.functional-go-live-plan.v1",
  "steel.functional-go-live-readiness.v1",
  "steel.algorithm-acceptance.audit.v1",
  "steel.integrated-capture-management.acceptance.v1",
  "steel.plc-l2-functional-acceptance.v1",
  "steel.production.stability.v1",
  "steel.target-machine-functional-acceptance.v1",
  "requiredIntegratedCoverage",
  "minimumSoakSeconds",
  "manifestSha256",
  "release identity does not match",
  "evidence SHA-256 mismatch",
  "steel.functional-scenario-evidence.v1",
  "different scenarioId",
  "observedAt was outside",
  "source metadata is incomplete",
  "raw log SHA-256 mismatch",
  "raw log file is missing",
  "startedAt/finishedAt",
  "approval time is required",
  "approval time cannot precede",
  "simulated provider cannot satisfy",
  "identityBinding",
  "excludedFromDecision",
  '"security", "signing", "supply-chain"'
)) {
  if ($FunctionalGoLiveText -notmatch [regex]::Escape($RequiredText)) {
    throw "test-functional-go-live-readiness.ps1 must verify $RequiredText"
  }
}

$FunctionalEvidenceGeneratorText = Get-Content (Join-Path $RuntimeRoot "new-functional-scenario-evidence.ps1") -Raw
foreach ($RequiredText in @(
  "steel.functional-scenario-evidence.v1",
  "steel.functional-scenario-evidence.reference.v1",
  "releaseManifestSha256",
  "rawLogSha256",
  "Write-Utf8JsonAtomically",
  "Get-FileHash"
)) {
  if ($FunctionalEvidenceGeneratorText -notmatch [regex]::Escape($RequiredText)) {
    throw "new-functional-scenario-evidence.ps1 must contain $RequiredText"
  }
}

$FunctionalWorkspaceInitializerText = Get-Content (Join-Path $RuntimeRoot "new-functional-acceptance-workspace.ps1") -Raw
foreach ($RequiredText in @(
  "steel.functional-acceptance-workspace.v1",
  "steel.functional-acceptance-workspace.reference.v1",
  "steel.functional-go-live-plan.v1",
  "steel.plc-l2-functional-acceptance.v1",
  "steel.target-machine-functional-acceptance.v1",
  "MinimumSoakSeconds cannot be below",
  "initializer never overwrites or deletes acceptance evidence",
  "Write-Utf8JsonAtomically"
)) {
  if ($FunctionalWorkspaceInitializerText -notmatch [regex]::Escape($RequiredText)) {
    throw "new-functional-acceptance-workspace.ps1 must contain $RequiredText"
  }
}

$FunctionalScenarioAttacherText = Get-Content (Join-Path $RuntimeRoot "add-functional-scenario-evidence.ps1") -Raw
foreach ($RequiredText in @(
  "steel.functional-scenario-attachment.v1",
  "already approved and is frozen",
  "cannot be attached twice",
  "must fall inside the scenario report execution window",
  "must stay inside",
  "changed while evidence was being generated",
  "Write-Utf8JsonAtomically",
  "new-functional-scenario-evidence.ps1"
)) {
  if ($FunctionalScenarioAttacherText -notmatch [regex]::Escape($RequiredText)) {
    throw "add-functional-scenario-evidence.ps1 must contain $RequiredText"
  }
}

$BarSurfaceText = Get-Content (Join-Path $RuntimeRoot "scripts\test-bar-surface-e2e.ps1") -Raw
foreach ($RequiredText in @("/api/production/algorithm/run", "/api/algorithm/bar-surface/latest", "captureSummary", "steel.production.summary.v1", "coreOutputBytes", "sdkDerived", "contourCrop")) {
  if ($BarSurfaceText -notmatch [regex]::Escape($RequiredText)) {
    throw "test-bar-surface-e2e.ps1 must verify $RequiredText"
  }
}

$BarSurfaceAlgorithmText = Get-Content (Join-Path $RuntimeRoot "scripts\bar_surface_reconstruct.py") -Raw
foreach ($RequiredText in @(
  '("camera1", "192.168.101.100", "3G506601BE09220")',
  '("camera2", "192.168.102.100", "3G506501CA09164")',
  '("camera3", "192.168.103.100", "3G506401RE08999")',
  '("camera4", "192.168.104.100", "YF-0270")',
  '("camera5", "192.168.105.100", "3G506601BE09221")',
  '("camera6", "192.168.106.100", "3G506501CA09163")',
  '("camera7", "192.168.107.100", "3G506401RE08995")',
  '("camera8", "192.168.108.100", "YF-0269")',
  'metadata_text(frame.metadata, "sn", "serial", "cameraSn")',
  'metadata_text(frame.metadata, "ip", "cameraIp")'
)) {
  if ($BarSurfaceAlgorithmText -notmatch [regex]::Escape($RequiredText)) {
    throw "bar_surface_reconstruct.py must preserve current eight-camera metadata/calibration mapping via $RequiredText"
  }
}

$Summary = [ordered]@{
  code = 0
  runtimeRoot = $RuntimeRoot
  manifest = $ManifestPath
  requiredFiles = $RequiredFiles.Count
  scripts = $ScriptNames.Count
  qtRemoved = $true
  client = Resolve-RuntimePath ([string]$RequiredFiles.client)
}

$Summary | ConvertTo-Json -Depth 4
