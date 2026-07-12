param(
  [string]$RepoRoot = "",
  [string]$ManifestPath = ""
)

$ErrorActionPreference = "Stop"

function Test-ExactStringSet {
  param(
    [object[]]$Actual,
    [string[]]$Expected
  )

  $ActualValues = @($Actual | ForEach-Object { [string]$_ } | Sort-Object -Unique)
  $ExpectedValues = @($Expected | Sort-Object -Unique)
  if ($ActualValues.Count -ne $ExpectedValues.Count) {
    return $false
  }
  return (Compare-Object -ReferenceObject $ExpectedValues -DifferenceObject $ActualValues).Count -eq 0
}

function Add-ContractCheck {
  param(
    [System.Collections.Generic.List[object]]$Checks,
    [string]$Id,
    [string]$Requirement,
    [bool]$Passed,
    [string[]]$Evidence,
    [string[]]$Missing = @()
  )

  $Checks.Add([ordered]@{
    id = $Id
    requirement = $Requirement
    passed = $Passed
    evidence = $Evidence
    missing = @($Missing)
  }) | Out-Null
}

function Get-MissingLiterals {
  param(
    [string]$Text,
    [string[]]$Literals
  )

  $Missing = [System.Collections.Generic.List[string]]::new()
  foreach ($Literal in $Literals) {
    if ($Text.IndexOf($Literal, [System.StringComparison]::Ordinal) -lt 0) {
      $Missing.Add($Literal) | Out-Null
    }
  }
  return @($Missing)
}

function Get-SourceBeforeTests {
  param([string]$Text)

  $Marker = [regex]::Match($Text, '(?m)^\s*#\[cfg\(test\)\]\s*$')
  if ($Marker.Success) {
    return $Text.Substring(0, $Marker.Index)
  }
  return $Text
}

function Read-RequiredText {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Missing architecture migration evidence: $Path"
  }
  return Get-Content -LiteralPath $Path -Raw
}

$TaskKinds = @(
  "capture-once",
  "algorithm-run",
  "steel-info",
  "steel-in",
  "steel-out",
  "trigger-event"
)
$TaskRoutes = @(
  "/api/production/tasks",
  "/api/production/tasks/steel-info",
  "/api/production/tasks/steel-in",
  "/api/production/tasks/steel-out",
  "/api/production/tasks/trigger-event"
)
$TriggerMappings = @(
  "steel-info=>/api/production/tasks/steel-info",
  "steel-in=>/api/production/tasks/steel-in",
  "steel-out=>/api/production/tasks/steel-out",
  "trigger-event=>/api/production/tasks/trigger-event"
)
$FrontendTaskRoutes = @(
  "/api/production/tasks",
  "/api/production/tasks/steel-info",
  "/api/production/tasks/steel-in",
  "/api/production/tasks/steel-out"
)
$ReadinessComponents = @("database", "taskWorker", "capture", "calibrationReconciliation", "storage", "trigger")
$AlarmApiRoutes = @(
  "GET /api/alarms",
  "POST /api/alarms/acknowledge",
  "POST /api/alarms/resolve"
)
$AlarmLifecycle = @("active", "acknowledged", "resolved")
$AlarmListStatuses = @("open", "active", "acknowledged", "resolved", "history", "all")
$CalibrationOperationMutationRoutes = @(
  "POST /api/calibration/apply-all",
  "POST /api/calibration/rollback"
)
$CalibrationRollbackEvidence = @("complete", "applyOperationId")

$ExpectedContract = [ordered]@{
  schema = "steel.architecture-migration.contract.v1"
  durableTasks = [ordered]@{
    persistent = $true
    kinds = $TaskKinds
    routes = $TaskRoutes
    fifo = $true
    restartRecovery = $true
  }
  dispatch = [ordered]@{
    triggerMappings = $TriggerMappings
    frontendTaskRoutes = $FrontendTaskRoutes
    preservesCallerRequestId = $true
    serviceUsesRequestIdForIdempotency = $true
  }
  readiness = [ordered]@{
    route = "/api/health/details"
    components = $ReadinessComponents
    storageEndpoint = "/api/storage/status"
    triggerEndpoint = "/api/trigger/status"
    triggerRequiredByDefault = $true
  }
  alarms = [ordered]@{
    persistent = $true
    apiRoutes = $AlarmApiRoutes
    lifecycle = $AlarmLifecycle
    listStatuses = $AlarmListStatuses
    defectIngestTransactional = $true
    frontendEntry = "AlarmCenter"
    serverOwnedActor = $true
  }
  calibrationOperations = [ordered]@{
    persistent = $true
    mutationRoutes = $CalibrationOperationMutationRoutes
    detailRoute = "GET /api/calibration/operations/detail"
    idempotencyKey = "operationId"
    interruptedStatus = "needs-reconciliation"
    reconciledStatus = "reconciled"
    automaticReplay = $false
    dryRunPersisted = $false
    persistentMutationFence = $true
    recoveryParentField = "parentOperationId"
    recoveryOutcome = "restored-to-staged-baseline"
    rollbackEvidence = $CalibrationRollbackEvidence
    providerRollbackTokenDurability = "cross-restart-file-only"
    providerRollbackFileFingerprint = "sha256+size"
    providerRollbackManifest = "atomic-write-ahead-v1"
    providerStagedPreviousFiles = $true
    providerRecoveryFence = $true
    realHardwareAcceptanceScript = "test-real-calibration-acceptance.ps1"
    realHardwareApplyRollbackRequiredForFullCoverage = $true
    realHardwareCrashRecoveryScript = "test-real-calibration-crash-recovery.ps1"
    realHardwareCrashRecoveryRequiredForFullCoverage = $true
    providerCrashFailpoint = "explicit-env-operation-phase-camera-bound-v1"
    realHardwareIntegrityGenerationScript = "test-real-calibration-integrity-generation.ps1"
    realHardwareIntegrityGenerationRequiredForFullCoverage = $true
    decisiveRollbackPreflightEvidence = @("attempted", "sideEffects")
    processCrashFaultInjectionSeparate = $true
    requiredCameraCount = 6
    uniqueCameraIps = $true
    uniqueExpectedSerials = $true
    uniqueSdkCalibrationPaths = $true
    arrayArtifactAsSdkCalibrationAllowed = $false
  }
  runtime = [ordered]@{
    formalCapture = "headless-cpp"
    qtRole = "diagnostic-only"
    qtFormalRuntime = $false
  }
}

$Checks = [System.Collections.Generic.List[object]]::new()

if (-not [string]::IsNullOrWhiteSpace($ManifestPath)) {
  $ResolvedManifest = (Resolve-Path -LiteralPath $ManifestPath).Path
  $Manifest = Get-Content -LiteralPath $ResolvedManifest -Raw | ConvertFrom-Json
  $Contract = $Manifest.migrationArchitecture
  $ContractPresent = $null -ne $Contract
  Add-ContractCheck $Checks "manifest-contract" "Runtime manifest carries the architecture migration contract." $ContractPresent @($ResolvedManifest)

  if ($ContractPresent) {
    $ShapeOk =
      [string]$Contract.schema -eq $ExpectedContract.schema -and
      $Contract.durableTasks.persistent -eq $true -and
      (Test-ExactStringSet @($Contract.durableTasks.kinds) $TaskKinds) -and
      (Test-ExactStringSet @($Contract.durableTasks.routes) $TaskRoutes) -and
      $Contract.durableTasks.fifo -eq $true -and
      $Contract.durableTasks.restartRecovery -eq $true -and
      (Test-ExactStringSet @($Contract.dispatch.triggerMappings) $TriggerMappings) -and
      (Test-ExactStringSet @($Contract.dispatch.frontendTaskRoutes) $FrontendTaskRoutes) -and
      $Contract.dispatch.preservesCallerRequestId -eq $true -and
      $Contract.dispatch.serviceUsesRequestIdForIdempotency -eq $true -and
      [string]$Contract.readiness.route -eq $ExpectedContract.readiness.route -and
      (Test-ExactStringSet @($Contract.readiness.components) $ReadinessComponents) -and
      [string]$Contract.readiness.storageEndpoint -eq $ExpectedContract.readiness.storageEndpoint -and
      [string]$Contract.readiness.triggerEndpoint -eq $ExpectedContract.readiness.triggerEndpoint -and
      $Contract.readiness.triggerRequiredByDefault -eq $true -and
      $Contract.alarms.persistent -eq $true -and
      (Test-ExactStringSet @($Contract.alarms.apiRoutes) $AlarmApiRoutes) -and
      (Test-ExactStringSet @($Contract.alarms.lifecycle) $AlarmLifecycle) -and
      (Test-ExactStringSet @($Contract.alarms.listStatuses) $AlarmListStatuses) -and
      $Contract.alarms.defectIngestTransactional -eq $true -and
      [string]$Contract.alarms.frontendEntry -eq "AlarmCenter" -and
      $Contract.alarms.serverOwnedActor -eq $true -and
      $Contract.calibrationOperations.persistent -eq $true -and
      (Test-ExactStringSet @($Contract.calibrationOperations.mutationRoutes) $CalibrationOperationMutationRoutes) -and
      [string]$Contract.calibrationOperations.detailRoute -eq "GET /api/calibration/operations/detail" -and
      [string]$Contract.calibrationOperations.idempotencyKey -eq "operationId" -and
      [string]$Contract.calibrationOperations.interruptedStatus -eq "needs-reconciliation" -and
      [string]$Contract.calibrationOperations.reconciledStatus -eq "reconciled" -and
      $Contract.calibrationOperations.automaticReplay -eq $false -and
      $Contract.calibrationOperations.dryRunPersisted -eq $false -and
      $Contract.calibrationOperations.persistentMutationFence -eq $true -and
      [string]$Contract.calibrationOperations.recoveryParentField -eq "parentOperationId" -and
      [string]$Contract.calibrationOperations.recoveryOutcome -eq "restored-to-staged-baseline" -and
      (Test-ExactStringSet @($Contract.calibrationOperations.rollbackEvidence) $CalibrationRollbackEvidence) -and
      [string]$Contract.calibrationOperations.providerRollbackTokenDurability -eq "cross-restart-file-only" -and
      [string]$Contract.calibrationOperations.providerRollbackFileFingerprint -eq "sha256+size" -and
      [string]$Contract.calibrationOperations.providerRollbackManifest -eq "atomic-write-ahead-v1" -and
      $Contract.calibrationOperations.providerStagedPreviousFiles -eq $true -and
      $Contract.calibrationOperations.providerRecoveryFence -eq $true -and
      [string]$Contract.calibrationOperations.realHardwareAcceptanceScript -eq "test-real-calibration-acceptance.ps1" -and
      $Contract.calibrationOperations.realHardwareApplyRollbackRequiredForFullCoverage -eq $true -and
      [string]$Contract.calibrationOperations.realHardwareCrashRecoveryScript -eq "test-real-calibration-crash-recovery.ps1" -and
      $Contract.calibrationOperations.realHardwareCrashRecoveryRequiredForFullCoverage -eq $true -and
      [string]$Contract.calibrationOperations.providerCrashFailpoint -eq "explicit-env-operation-phase-camera-bound-v1" -and
      [string]$Contract.calibrationOperations.realHardwareIntegrityGenerationScript -eq "test-real-calibration-integrity-generation.ps1" -and
      $Contract.calibrationOperations.realHardwareIntegrityGenerationRequiredForFullCoverage -eq $true -and
      (Test-ExactStringSet @($Contract.calibrationOperations.decisiveRollbackPreflightEvidence) @("attempted", "sideEffects")) -and
      $Contract.calibrationOperations.processCrashFaultInjectionSeparate -eq $true -and
      [int]$Contract.calibrationOperations.requiredCameraCount -eq 6 -and
      $Contract.calibrationOperations.uniqueCameraIps -eq $true -and
      $Contract.calibrationOperations.uniqueExpectedSerials -eq $true -and
      $Contract.calibrationOperations.uniqueSdkCalibrationPaths -eq $true -and
      $Contract.calibrationOperations.arrayArtifactAsSdkCalibrationAllowed -eq $false -and
      [string]$Contract.runtime.formalCapture -eq "headless-cpp" -and
      [string]$Contract.runtime.qtRole -eq "diagnostic-only" -and
      $Contract.runtime.qtFormalRuntime -eq $false
    Add-ContractCheck $Checks "manifest-shape" "Runtime migration contract has the exact durable-task, readiness, alarm, calibration-safety, and runtime boundaries." $ShapeOk @($ResolvedManifest)
  }

  $IsTargetManifest = -not [string]::IsNullOrWhiteSpace([string]$Manifest.captureHeadless)
  $CaptureRole = if ($IsTargetManifest) { [string]$Manifest.captureRole } else { [string]$Manifest.capture.role }
  $QtDeclared = if ($IsTargetManifest) {
    -not [string]::IsNullOrWhiteSpace([string]$Manifest.captureQt)
  } else {
    $null -ne $Manifest.captureQt
  }
  $QtRole = if ($IsTargetManifest) { [string]$Manifest.captureQtRole } else { [string]$Manifest.captureQt.role }
  $QtOwnsApi = if ($IsTargetManifest) { $Manifest.captureQtOwnsApi } else { $Manifest.captureQt.ownsApi }
  $QtFormalRuntime = if ($IsTargetManifest) { $Manifest.captureQtFormalRuntime } else { $Manifest.captureQt.formalRuntime }
  $RuntimeBoundaryOk =
    [string]$Manifest.formalCapture -eq "headless-cpp" -and
    $CaptureRole -eq "formal-sdk-owner" -and
    (-not $QtDeclared -or (
      $QtRole -eq "diagnostic-only" -and
      $QtOwnsApi -eq $false -and
      $QtFormalRuntime -eq $false
    ))
  Add-ContractCheck $Checks "manifest-runtime-boundary" "Headless C++ is the formal SDK owner and optional Qt is diagnostic-only." $RuntimeBoundaryOk @($ResolvedManifest)

  $Passed = @($Checks | Where-Object { $_.passed }).Count
  $Report = [ordered]@{
    schema = "steel.architecture-migration.audit.v1"
    code = if ($Passed -eq $Checks.Count) { 0 } else { 1 }
    mode = "manifest"
    contract = $ExpectedContract
    checks = $Checks
    summary = [ordered]@{
      passed = $Passed
      required = $Checks.Count
      failed = $Checks.Count - $Passed
    }
  }
  $Report | ConvertTo-Json -Depth 12
  if ($Report.code -ne 0) {
    throw "Runtime manifest does not satisfy the architecture migration contract: $ResolvedManifest"
  }
  return
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = Join-Path $PSScriptRoot ".."
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

$TaskPath = Join-Path $RepoRoot "app\service\src\production_tasks.rs"
$ServicePath = Join-Path $RepoRoot "app\service\src\main.rs"
$CalibrationOperationsPath = Join-Path $RepoRoot "app\service\src\calibration_operations.rs"
$DatabasePath = Join-Path $RepoRoot "app\service\src\db\mod.rs"
$EntityPath = Join-Path $RepoRoot "app\service\src\db\entities.rs"
$TriggerPath = Join-Path $RepoRoot "app\trigger\src\main.rs"
$InspectionApiPath = Join-Path $RepoRoot "app\client\src\services\inspection-api.ts"
$InspectionApiTestPath = Join-Path $RepoRoot "app\client\src\services\inspection-api.production.test.ts"
$AlarmApiPath = Join-Path $RepoRoot "app\client\src\services\alarm-api.ts"
$AlarmApiTestPath = Join-Path $RepoRoot "app\client\src\services\alarm-api.test.ts"
$AlarmCenterPath = Join-Path $RepoRoot "app\client\src\components\AlarmCenter.tsx"
$AlarmCenterTestPath = Join-Path $RepoRoot "app\client\src\components\AlarmCenter.test.tsx"
$AppPath = Join-Path $RepoRoot "app\client\src\App.tsx"
$CaptureApiPath = Join-Path $RepoRoot "app\client\src\lib\capture-api.ts"
$SystemStatusPath = Join-Path $RepoRoot "app\client\src\components\SystemStatusPage.tsx"
$CaptureDiagnosticPath = Join-Path $RepoRoot "app\client\src\components\CaptureDiagnosticOperations.tsx"
$BarSurfaceApiPath = Join-Path $RepoRoot "app\client\src\services\bar-surface-api.ts"
$BarSurfaceAppPath = Join-Path $RepoRoot "app\client\src\components\BarSurfaceApp.tsx"
$CaptureProviderPath = Join-Path $RepoRoot "app\capture\src\capture_service_app.cpp"
$PackageRuntimePath = Join-Path $RepoRoot "scripts\package-runtime.ps1"
$RealCalibrationAcceptancePath = Join-Path $RepoRoot "scripts\test-real-calibration-acceptance.ps1"
$RealCalibrationCrashRecoveryPath = Join-Path $RepoRoot "scripts\test-real-calibration-crash-recovery.ps1"
$RealCalibrationIntegrityGenerationPath = Join-Path $RepoRoot "scripts\test-real-calibration-integrity-generation.ps1"
$IntegratedFullPath = Join-Path $RepoRoot "scripts\test-integrated-capture-management-full.ps1"

$TaskText = Read-RequiredText $TaskPath
$TaskProductionText = Get-SourceBeforeTests $TaskText
$ServiceText = Read-RequiredText $ServicePath
$ServiceProductionText = Get-SourceBeforeTests $ServiceText
$CalibrationOperationsText = Read-RequiredText $CalibrationOperationsPath
$DatabaseText = Read-RequiredText $DatabasePath
$EntityText = Read-RequiredText $EntityPath
$TriggerText = Read-RequiredText $TriggerPath
$TriggerProductionText = Get-SourceBeforeTests $TriggerText
$InspectionApiText = Read-RequiredText $InspectionApiPath
$InspectionApiTestText = Read-RequiredText $InspectionApiTestPath
$AlarmApiText = Read-RequiredText $AlarmApiPath
$AlarmApiTestText = Read-RequiredText $AlarmApiTestPath
$AlarmCenterText = Read-RequiredText $AlarmCenterPath
$AlarmCenterTestText = Read-RequiredText $AlarmCenterTestPath
$AppText = Read-RequiredText $AppPath
$CaptureApiText = Read-RequiredText $CaptureApiPath
$SystemStatusText = Read-RequiredText $SystemStatusPath
$CaptureDiagnosticText = Read-RequiredText $CaptureDiagnosticPath
$BarSurfaceApiText = Read-RequiredText $BarSurfaceApiPath
$BarSurfaceAppText = Read-RequiredText $BarSurfaceAppPath
$CaptureProviderText = Read-RequiredText $CaptureProviderPath
$PackageRuntimeText = Read-RequiredText $PackageRuntimePath
$RealCalibrationAcceptanceText = Read-RequiredText $RealCalibrationAcceptancePath
$RealCalibrationCrashRecoveryText = Read-RequiredText $RealCalibrationCrashRecoveryPath
$RealCalibrationIntegrityGenerationText = Read-RequiredText $RealCalibrationIntegrityGenerationPath
$IntegratedFullText = Read-RequiredText $IntegratedFullPath

$DurableMissing = [System.Collections.Generic.List[string]]::new()
foreach ($Value in $TaskKinds + $TaskRoutes) {
  foreach ($Missing in @(Get-MissingLiterals $TaskProductionText @($Value))) {
    $DurableMissing.Add($Missing) | Out-Null
  }
}
foreach ($Missing in @(Get-MissingLiterals $TaskProductionText @(
  'execute_task',
  'write_production_capture_once_response',
  'write_production_algorithm_run_response',
  'production_event_payload',
  'write_production_event_response'
))) {
  $DurableMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $ServiceProductionText @(
  'production_tasks::enqueue_response',
  'production_tasks::enqueue_kind_response',
  'production_tasks::start_worker'
))) {
  $DurableMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $EntityText @('table_name = "production_task"'))) {
  $DurableMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $DatabaseText @(
  'insert_production_task',
  'claim_next_production_task',
  'order_by_asc(production_task::Column::CreatedAt)',
  'recover_incomplete_production_tasks',
  'idx_production_task_idempotency'
))) {
  $DurableMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $ServiceText @(
  'queued_production_event_routes_are_explicit_and_do_not_take_the_sync_lane',
  'queued_production_chain_reuses_session_and_claims_fifo_through_steel_out',
  'service_restart_marks_inflight_task_interrupted_without_replaying_it'
))) {
  $DurableMissing.Add($Missing) | Out-Null
}
Add-ContractCheck $Checks "durable-six-kind-tasks" "Rust persists, recovers, and FIFO-claims all six production task kinds through durable routes." ($DurableMissing.Count -eq 0) @($TaskPath, $ServicePath, $DatabasePath, $EntityPath) @($DurableMissing)

$DispatchMissing = [System.Collections.Generic.List[string]]::new()
foreach ($Value in @(
  '/api/production/tasks/steel-info',
  '/api/production/tasks/steel-in',
  '/api/production/tasks/steel-out',
  '/api/production/tasks/trigger-event',
  'enrich_payload',
  'serde_json::from_str::<Value>(body.trim())',
  'entry("source".to_string())',
  'entry("mode".to_string())',
  'payload.to_string()'
)) {
  foreach ($Missing in @(Get-MissingLiterals $TriggerProductionText @($Value))) {
    $DispatchMissing.Add($Missing) | Out-Null
  }
}
foreach ($Missing in @(Get-MissingLiterals $TaskProductionText @(
  '"idempotencyKey", "idempotency_key", "requestId", "request_id"',
  'find_production_task_by_idempotency_key',
  'idempotency_conflict'
))) {
  $DispatchMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $InspectionApiText @(
  'function productionRequestId',
  "postProductionCommand('/api/production/tasks/steel-info'",
  "postProductionCommand('/api/production/tasks/steel-in'",
  "postProductionCommand('/api/production/tasks/steel-out'",
  "postProductionCommand('/api/production/tasks'",
  'requestId: productionRequestId',
  'idempotencyKey: requestId'
))) {
  $DispatchMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals ($TriggerText + $InspectionApiTestText) @(
  'routes_trigger_and_manual_paths_to_production_api',
  'caller idempotency',
  "requestId: 'IN-1'"
))) {
  $DispatchMissing.Add($Missing) | Out-Null
}
Add-ContractCheck $Checks "durable-dispatch-request-id" "Trigger and Tauri dispatch to durable task routes, preserve a caller requestId, and Rust applies it as the idempotency key." ($DispatchMissing.Count -eq 0) @($TriggerPath, $InspectionApiPath, $InspectionApiTestPath, $TaskPath) @($DispatchMissing)

$ReadinessMissing = [System.Collections.Generic.List[string]]::new()
foreach ($Missing in @(Get-MissingLiterals $ServiceProductionText @(
  '"/api/health/details"',
  'database_health_component',
  'task_worker_health_component',
  'capture_health_component',
  'capture_calibration_recovery_required',
  'calibration_reconciliation_health_component',
  'storage_health_component',
  'trigger_health_component',
  '"database": database',
  '"taskWorker": task_worker',
  '"capture": capture',
  '"calibrationReconciliation": calibration_reconciliation',
  '"storage": storage',
  '"trigger": trigger',
  '"/api/storage/status"',
  '"/api/trigger/status"',
  'STEEL_TRIGGER_HEALTH_REQUIRED'
))) {
  $ReadinessMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $ServiceText @(
  'layered_health_routes_are_explicit_and_get_only',
  'storage_health_rejects_missing_unwritable_or_non_accepting_storage_and_times_out',
  'trigger_health_defaults_required_supports_explicit_optional_and_never_leaks_origin',
  'trigger_health_timeout_is_bounded_and_required_trigger_gates_service_readiness'
))) {
  $ReadinessMissing.Add($Missing) | Out-Null
}
Add-ContractCheck $Checks "layered-readiness" "Rust readiness is layered across database, task worker, capture, persistent calibration reconciliation, storage, and required-by-default trigger health." ($ReadinessMissing.Count -eq 0) @($ServicePath) @($ReadinessMissing)

$AlarmMissing = [System.Collections.Generic.List[string]]::new()
foreach ($Missing in @(Get-MissingLiterals $EntityText @('table_name = "production_alarm"'))) {
  $AlarmMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $DatabaseText @(
  'append_production_defect_with_alarm',
  'connection.begin().await?',
  'list_production_alarms',
  'production_alarm_counts',
  'acknowledge_production_alarm',
  'resolve_production_alarm',
  'Status.is_in(["active", "acknowledged"])',
  '"history" => query.filter',
  'Status.eq("active")',
  'Expr::value("acknowledged")',
  'Status.eq("acknowledged")',
  'Expr::value("resolved")',
  'CREATE TABLE IF NOT EXISTS production_alarm'
))) {
  $AlarmMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $ServiceProductionText @(
  '("GET", "/api/alarms")',
  '("POST", "/api/alarms/acknowledge")',
  '("POST", "/api/alarms/resolve")',
  '"open" | "active" | "acknowledged" | "resolved" | "history" | "all"',
  'alarm_acknowledgement_required',
  'append_production_defect_with_alarm',
  'append_audit_log'
))) {
  $AlarmMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $AlarmApiText @(
  "'active' | 'acknowledged' | 'resolved'",
  "'open' | AlarmLifecycleStatus | 'history' | 'all'",
  '/api/alarms?',
  '/api/alarms/${action}',
  'createAdminHeaders',
  'JSON.stringify({ alarmId, note })'
))) {
  $AlarmMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals ($AlarmCenterText + $AppText) @(
  'export function AlarmCenter',
  '<AlarmCenter />',
  "view === 'history' ? 'history'",
  "alarm.status === 'active' ? 'acknowledge'",
  "alarm.status === 'acknowledged' ? 'resolve'"
))) {
  $AlarmMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals ($ServiceText + $AlarmApiTestText + $AlarmCenterTestText) @(
  'severe_and_review_defect_ingest_create_one_idempotent_alarm',
  'alarm_transition_requires_acknowledgement_and_preserves_confirming_actor',
  'without trusting or sending a client actor',
  'loads durable open alarms',
  'server-owned confirmation and resolution identities'
))) {
  $AlarmMissing.Add($Missing) | Out-Null
}
Add-ContractCheck $Checks "persistent-alarm-lifecycle" "Persistent alarms are created transactionally, listed as open/history, and move active to acknowledged to resolved with server-owned audit identity in the Tauri alarm center." ($AlarmMissing.Count -eq 0) @($ServicePath, $DatabasePath, $EntityPath, $AlarmApiPath, $AlarmCenterPath, $AppPath) @($AlarmMissing)

# This check reads only explicitly named source/configuration files. It never
# searches target/, package output, minified bundles, object files, or binaries.
$QtCapabilityMissing = [System.Collections.Generic.List[string]]::new()
foreach ($Missing in @(Get-MissingLiterals $CaptureApiText @(
  'export type CaptureImageKind = "depth" | "intensity" | "metadata" | "sdk-derived";',
  '"/api/calibration/apply-all"',
  '"/api/calibration/rollback"',
  'cameraCalibrations.length !== 6',
  '!item.expectedSn',
  '!item.rollbackPath',
  'uniqueExpectedSns',
  'uniqueCalibrationPaths',
  'atomic: true',
  'rollbackOnFailure: true'
))) {
  $QtCapabilityMissing.Add("Tauri API: $Missing") | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $SystemStatusText @(
  "case 'metadata'",
  "case 'sdk-derived'",
  'handleStopAllPreviews',
  'capture-metadata-preview',
  'previewStreamOptions.width',
  'previewStreamOptions.dataMode',
  'previewStreamOptions.fpsLimit',
  'previewStreamOptions.hs',
  'mergeCaptureLogEvents',
  'handleDisconnectAll',
  'failedEvidence'
))) {
  $QtCapabilityMissing.Add("Tauri UI: $Missing") | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $CaptureDiagnosticText @(
  'calibrationSetPayload',
  'expectedSn',
  'dryRun=true',
  'atomic: true',
  'rollbackOnFailure: true',
  'maintenanceRecordPath'
))) {
  $QtCapabilityMissing.Add("Tauri diagnostics: $Missing") | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals ($BarSurfaceApiText + $BarSurfaceAppText + $TaskProductionText + $ServiceProductionText) @(
  "operation: 'calibration-capture-fit'",
  '正在采集六相机标定帧',
  'write_production_calibration_capture_fit_response',
  'calibration_capture_data_dir',
  '"completeFrames"',
  '"metadataFrames"',
  '"dataDir"'
))) {
  $QtCapabilityMissing.Add("Automatic calibration: $Missing") | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $ServiceProductionText @(
  '("GET", "/api/capture/latest")',
  '("POST", "/api/calibration/apply-all")',
  '("POST", "/api/calibration/rollback")',
  'validate_calibration_set_safety',
  'CALIBRATION_SET_CAMERA_COUNT: usize = 6',
  'calibration_set_duplicate_serial',
  'calibration_set_duplicate_artifact',
  'calibration_set_durable_rollback_path_required',
  'CAMERA_CALIBRATION_SET_CONFIRMATION',
  'CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION'
))) {
  $QtCapabilityMissing.Add("Rust boundary: $Missing") | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $CaptureProviderText @(
  'path == "/api/calibration/apply-all"',
  'path == "/api/calibration/rollback"',
  'per-camera SDK calibration mapping cannot use array reconstruction XML',
  'each camera must use a distinct SDK calibration artifact',
  '"rollbackOnFailure"',
  'calibration-records.jsonl',
  'steel.capture.calibration-maintenance.v1',
  '\"rollbackTokenDurability\":\"cross-restart-file-only\"',
  '\"rollbackFileFingerprint\":\"sha256+size\"',
  '\"rollbackManifest\":\"atomic-write-ahead-v1\"',
  'stagedPreviousPath',
  'std::string disconnect_json',
  '\"results\":',
  'return "metadata";',
  'return "sdk-derived";'
))) {
  $QtCapabilityMissing.Add("C++ provider: $Missing") | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $PackageRuntimeText @(
  'formalCapture = "headless-cpp"',
  'role = "diagnostic-only"',
  'formalRuntime = $false',
  '$env:CAPTURE_QT_API_AUTOSTART = "0"'
))) {
  $QtCapabilityMissing.Add("Formal runtime: $Missing") | Out-Null
}
Add-ContractCheck $Checks "qt-capability-formal-chain" "Former Qt operations are covered by the formal Tauri-to-Rust-to-C++ chain: parameterized preview, real merged logs, per-camera batch evidence, capture-before-fit automatic calibration, four latest artifact kinds, safe six-camera calibration and durable rollback, and no formal Qt runtime dependency." ($QtCapabilityMissing.Count -eq 0) @($CaptureApiPath, $SystemStatusPath, $CaptureDiagnosticPath, $BarSurfaceApiPath, $BarSurfaceAppPath, $ServicePath, $CaptureProviderPath, $PackageRuntimePath) @($QtCapabilityMissing)

$CalibrationLedgerMissing = [System.Collections.Generic.List[string]]::new()
foreach ($Missing in @(Get-MissingLiterals $CalibrationOperationsText @(
  'parse_unique_json',
  'invalid_or_duplicate_calibration_operation_json',
  'normalized_request',
  'mutation_response_with_dispatch',
  'calibration_operation_id_conflict',
  'calibration_operation_in_progress',
  'needs-reconciliation',
  'provider_terminal_status',
  'capture_provider_automatic_rollback_incomplete',
  'capture_provider_manual_rollback_incomplete',
  'reconciliation_required_response',
  'mutation_requires_reconciliation_fence',
  'parentOperationId',
  'restored-to-staged-baseline',
  'provider_apply_operation_id'
))) {
  $CalibrationLedgerMissing.Add("Rust ledger: $Missing") | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $EntityText @(
  'table_name = "calibration_operation"',
  'provider_response_body',
  'dispatch_started_at',
  'parent_operation_id',
  'reconciliation_outcome',
  'reconciliation_id',
  'resolved_by',
  'resolved_at',
  'row_version'
))) {
  $CalibrationLedgerMissing.Add("Database entity: $Missing") | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $DatabaseText @(
  'CREATE TABLE IF NOT EXISTS calibration_operation',
  'insert_calibration_operation',
  'find_calibration_operation',
  'finish_calibration_operation',
  'recover_dispatching_calibration_operations',
  'list_unresolved_calibration_operations',
  'reconcile_calibration_operation',
  'idx_calibration_operation_status_updated'
))) {
  $CalibrationLedgerMissing.Add("Database operations: $Missing") | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $ServiceText @(
  'GET", "/api/calibration/operations/detail',
  'calibration_operations::apply_response',
  'calibration_operations::mutation_response',
  'calibration_operation_same_id_is_single_flight_while_dispatching',
  'calibration_operation_rejects_a_different_id_instead_of_queueing',
  'calibration_apply_rejects_duplicate_json_keys_before_provider_dispatch',
  'calibration_operation_ledger_replays_terminal_response_and_rejects_conflicts',
  'startup_recovery_marks_dispatching_calibration_operations_without_replay',
  'unresolved_calibration_operation_fences_device_writes_until_parent_bound_rollback',
  'rollback_parent_mismatch_keeps_reconciliation_fence_closed',
  'calibration_reconciliation_health_component'
))) {
  $CalibrationLedgerMissing.Add("Rust route/tests: $Missing") | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals ($CaptureApiText + $CaptureDiagnosticText) @(
  'readCaptureCalibrationOperationDetail',
  'CaptureAdminApiError',
  'calibration_reconciliation_required',
  'parentOperationId',
  'needsReconciliation',
  'reconciliationOutcome',
  'reconciliationId',
  'resolvedBy',
  'resolvedAt',
  'rowVersion'
))) {
  $CalibrationLedgerMissing.Add("Tauri reconciliation: $Missing") | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $CaptureProviderText @(
  '\"operationCorrelationId\":true',
  '\"rollbackTokenDurability\":\"cross-restart-file-only\"',
  '\"rollbackFileFingerprint\":\"sha256+size\"',
  '\"rollbackManifest\":\"atomic-write-ahead-v1\"',
  '\"rollbackRestartRecovery\":true',
  '\"rollbackInvalidManifestPolicy\":\"fail-closed\"',
  '\"rollbackRecoveryFence\":true',
  '\"rollbackRecoveryStatus\":423',
  'rollbackRecoverablePhases',
  'route_allowed_when_calibration_recovery_required',
  'pending_calibration_recovery_count_locked',
  'stagedPreviousPath',
  'write_durable_text_file',
  'json_pair("operationId"',
  'is_valid_operation_id',
  'calibration-records.jsonl'
))) {
  $CalibrationLedgerMissing.Add("C++ correlation: $Missing") | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $RealCalibrationAcceptanceText @(
  'steel.real-calibration.acceptance.v1'
  '/api/calibration/apply-all'
  '/api/calibration/rollback'
  '/api/calibration/operations/detail'
  'RUN REAL SIX CAMERA CALIBRATION APPLY AND ROLLBACK'
  '/api/capture/continuous-test'
  'calibrationReconciliation'
  'does not prove a process crash'
))) {
  $CalibrationLedgerMissing.Add("Real hardware acceptance: $Missing") | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $RealCalibrationCrashRecoveryText @(
  'steel.real-calibration.crash-recovery.v1'
  'ApplyCrash'
  'RollbackCrash'
  'calibrationCrashFailpointArmed'
  'expectedApplyOperationId'
  'parentOperationId'
  'reconciled'
))) {
  $CalibrationLedgerMissing.Add("Real crash recovery acceptance: $Missing") | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $RealCalibrationIntegrityGenerationText @(
  'steel.real-calibration.integrity-generation.v1'
  'staleGeneration'
  'stagedTamper'
  'sideEffects'
  'zeroWriteEvidence'
  'validationCapture'
))) {
  $CalibrationLedgerMissing.Add("Real integrity/generation acceptance: $Missing") | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $CaptureProviderText @(
  'explicit-env-operation-phase-camera-bound-v1'
  'CAPTURE_CALIBRATION_CRASH_CONFIRMATION'
  'CAPTURE_CALIBRATION_CRASH_OPERATION_ID'
  'CAPTURE_CALIBRATION_CRASH_PHASE'
  'CAPTURE_CALIBRATION_CRASH_CAMERA_INDEX'
))) {
  $CalibrationLedgerMissing.Add("C++ controlled crash failpoint: $Missing") | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $IntegratedFullText @(
  'real-calibration-apply-rollback'
  'real-calibration-crash-recovery'
  'real-calibration-integrity-generation'
  'RunCalibrationApplyRollback'
  'CalibrationSafetyConfirmation'
))) {
  $CalibrationLedgerMissing.Add("Full coverage gate: $Missing") | Out-Null
}
Add-ContractCheck $Checks "persistent-calibration-operation-ledger" "Real calibration apply/rollback uses a persistent operationId ledger with single-flight idempotency, a 423 device-mutation/readiness fence, nested parent-bound rollback reconciliation, decisive zero-write preflight evidence, C++ staged cross-restart rollback material, and explicit live-hardware apply/rollback, crash-recovery, integrity, and generation gates." ($CalibrationLedgerMissing.Count -eq 0) @($CalibrationOperationsPath, $DatabasePath, $EntityPath, $ServicePath, $CaptureApiPath, $CaptureDiagnosticPath, $CaptureProviderPath, $RealCalibrationAcceptancePath, $RealCalibrationCrashRecoveryPath, $RealCalibrationIntegrityGenerationPath, $IntegratedFullPath) @($CalibrationLedgerMissing)

$Passed = @($Checks | Where-Object { $_.passed }).Count
$Report = [ordered]@{
  schema = "steel.architecture-migration.audit.v1"
  code = if ($Passed -eq $Checks.Count) { 0 } else { 1 }
  mode = "source"
  repoRoot = $RepoRoot
  contract = $ExpectedContract
  checks = $Checks
  summary = [ordered]@{
    passed = $Passed
    required = $Checks.Count
    failed = $Checks.Count - $Passed
  }
}

$Report | ConvertTo-Json -Depth 12
if ($Report.code -ne 0) {
  $FailedIds = @($Checks | Where-Object { -not $_.passed } | ForEach-Object { $_.id }) -join ", "
  throw "Architecture migration contract failed: $FailedIds"
}
