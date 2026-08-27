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

function Get-MissingWhitespaceInsensitiveLiterals {
  param(
    [string]$Text,
    [string[]]$Literals
  )

  $NormalizedText = [regex]::Replace($Text, '\s+', '')
  $Missing = [System.Collections.Generic.List[string]]::new()
  foreach ($Literal in $Literals) {
    $NormalizedLiteral = [regex]::Replace($Literal, '\s+', '')
    if ($NormalizedText.IndexOf($NormalizedLiteral, [System.StringComparison]::Ordinal) -lt 0) {
      $Missing.Add($Literal) | Out-Null
    }
  }
  return @($Missing)
}

function Get-SourceBeforeTests {
  param([string]$Text)

  $Marker = [regex]::Match(
    $Text,
    '(?m)^\s*#\[cfg\(test\)\]\s*\r?\n\s*mod\s+tests\s*\{'
  )
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
$TaskDependencyFields = @("chainId", "dependsOnTaskId", "dependencyPolicy", "blockedReason")
$TaskDependencyPolicies = @("require-success", "always-run")
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
$TriggerSecurityTransports = @("http", "tcp", "udp")
$ReadinessComponents = @("database", "taskWorker", "capture", "calibrationReconciliation", "storage", "trigger", "algorithm", "productionPolicy")
$AlarmApiRoutes = @(
  "GET /api/alarms",
  "POST /api/alarms/acknowledge",
  "POST /api/alarms/resolve"
)
$AlarmLifecycle = @("active", "acknowledged", "resolved")
$AlarmListStatuses = @("open", "active", "acknowledged", "resolved", "history", "all")
$ManagedHealthAlarmTypes = @(
  "supervisor-restart-budget-exhausted",
  "supervisor-status-invalid",
  "storage-capacity-warning",
  "storage-critical",
  "capture-unavailable",
  "task-worker-unavailable",
  "calibration-reconciliation-required",
  "trigger-unavailable",
  "algorithm-not-qualified",
  "production-policy-invalid"
)
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
    dependencyFields = $TaskDependencyFields
    dependencyPolicies = $TaskDependencyPolicies
    blockedStatus = "blocked"
    failurePropagation = $true
    safetyCriticalRequireSuccess = $true
    retryRequeuesDescendants = $true
  }
  dispatch = [ordered]@{
    triggerMappings = $TriggerMappings
    frontendTaskRoutes = $FrontendTaskRoutes
    preservesCallerRequestId = $true
    serviceUsesRequestIdForIdempotency = $true
  }
  triggerSecurity = [ordered]@{
    transports = $TriggerSecurityTransports
    authentication = "HMAC-SHA256"
    canonicalVersion = "steel-trigger-v1"
    timestampHeader = "X-Trigger-Timestamp"
    nonceHeader = "X-Trigger-Nonce"
    signatureHeader = "X-Trigger-Signature"
    operatorCredentialHeader = "X-Trigger-Operator-Token"
    networkEnvelope = $true
    replayProtection = $true
    sourceAllowlist = $true
    productionSecretMinBytes = 32
    productionOperatorTokenMinBytes = 32
    upstreamAndOperatorCredentialsSeparated = $true
    productionModeMutationDefault = $false
    manualOperationsPermission = "admin.services"
    wildcardCors = $false
    statusRedacted = $true
  }
  readiness = [ordered]@{
    route = "/api/health/details"
    components = $ReadinessComponents
    storageEndpoint = "/api/storage/status"
    triggerEndpoint = "/api/trigger/status"
    triggerRequiredByDefault = $true
    storageCapacityFields = @(
      "capacityBytes",
      "freeBytes",
      "freePercent",
      "recentWriteBytesPerSecond",
      "estimatedRemainingSeconds",
      "level",
      "warningFreeBytes",
      "warningFreePercent",
      "warningReason"
    )
    storageWatermarkFailClosed = $true
    newSessionAdmissionBlockedOnCriticalStorage = $true
    existingSessionCompletionAllowed = $true
  }
  alarms = [ordered]@{
    persistent = $true
    apiRoutes = $AlarmApiRoutes
    lifecycle = $AlarmLifecycle
    listStatuses = $AlarmListStatuses
    defectIngestTransactional = $true
    managedHealthSource = "system-health"
    managedHealthAlarmTypes = $ManagedHealthAlarmTypes
    episodeDeduplication = $true
    automaticRecoveryResolution = $true
    frontendEntry = "AlarmCenter"
    serverOwnedActor = $true
  }
  dataLifecycle = [ordered]@{
    persistentCleanupLedger = $true
    manifestSchema = "steel.record-artifact-cleanup.v1"
    allowedRootsRequired = $true
    fileFingerprint = "sha256+size"
    perFileProgress = $true
    databaseDeleteAfterFiles = $true
    atomicConfirmation = $true
    retryRoute = "POST /api/admin/records/cleanup/retry"
    retainedSession = $true
    sqliteOnlineSnapshot = "VACUUM INTO"
    mysqlServerSideBackup = $true
    backupManifestSchema = "steel.database-backup.v2"
    reportArchiveBackupManifestSchema = "steel.report-archive-backup.v1"
    reportArchiveAuthoritativeValidation = $true
    reportArchiveOfflineRestore = $true
    reportArchivePriorTreeRetention = $true
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
    requiredCameraCount = 8
    uniqueCameraIps = $true
    uniqueExpectedSerials = $true
    uniqueSdkCalibrationPaths = $true
    arrayArtifactAsSdkCalibrationAllowed = $false
  }
  runtime = [ordered]@{
    formalCapture = "headless-cpp"
    qtRemoved = $true
    windowsServiceSupervisor = $true
    windowsServiceName = "SteelInspectionRuntime"
    orderedChildren = @("image", "algorithm", "capture", "service", "trigger")
    gracefulStop = "CTRL_BREAK-then-timeout-terminate"
    restartBudget = "5-per-10-minutes"
    logRotation = "50MiB-5-generations"
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
      (Test-ExactStringSet @($Contract.durableTasks.dependencyFields) $TaskDependencyFields) -and
      (Test-ExactStringSet @($Contract.durableTasks.dependencyPolicies) $TaskDependencyPolicies) -and
      [string]$Contract.durableTasks.blockedStatus -eq "blocked" -and
      $Contract.durableTasks.failurePropagation -eq $true -and
      $Contract.durableTasks.safetyCriticalRequireSuccess -eq $true -and
      $Contract.durableTasks.retryRequeuesDescendants -eq $true -and
      (Test-ExactStringSet @($Contract.dispatch.triggerMappings) $TriggerMappings) -and
      (Test-ExactStringSet @($Contract.dispatch.frontendTaskRoutes) $FrontendTaskRoutes) -and
      $Contract.dispatch.preservesCallerRequestId -eq $true -and
      $Contract.dispatch.serviceUsesRequestIdForIdempotency -eq $true -and
      (Test-ExactStringSet @($Contract.triggerSecurity.transports) $TriggerSecurityTransports) -and
      [string]$Contract.triggerSecurity.authentication -eq "HMAC-SHA256" -and
      [string]$Contract.triggerSecurity.canonicalVersion -eq "steel-trigger-v1" -and
      [string]$Contract.triggerSecurity.timestampHeader -eq "X-Trigger-Timestamp" -and
      [string]$Contract.triggerSecurity.nonceHeader -eq "X-Trigger-Nonce" -and
      [string]$Contract.triggerSecurity.signatureHeader -eq "X-Trigger-Signature" -and
      [string]$Contract.triggerSecurity.operatorCredentialHeader -eq "X-Trigger-Operator-Token" -and
      $Contract.triggerSecurity.networkEnvelope -eq $true -and
      $Contract.triggerSecurity.replayProtection -eq $true -and
      $Contract.triggerSecurity.sourceAllowlist -eq $true -and
      [int]$Contract.triggerSecurity.productionSecretMinBytes -eq 32 -and
      [int]$Contract.triggerSecurity.productionOperatorTokenMinBytes -eq 32 -and
      $Contract.triggerSecurity.upstreamAndOperatorCredentialsSeparated -eq $true -and
      $Contract.triggerSecurity.productionModeMutationDefault -eq $false -and
      [string]$Contract.triggerSecurity.manualOperationsPermission -eq "admin.services" -and
      $Contract.triggerSecurity.wildcardCors -eq $false -and
      $Contract.triggerSecurity.statusRedacted -eq $true -and
      [string]$Contract.readiness.route -eq $ExpectedContract.readiness.route -and
      (Test-ExactStringSet @($Contract.readiness.components) $ReadinessComponents) -and
      [string]$Contract.readiness.storageEndpoint -eq $ExpectedContract.readiness.storageEndpoint -and
      [string]$Contract.readiness.triggerEndpoint -eq $ExpectedContract.readiness.triggerEndpoint -and
      $Contract.readiness.triggerRequiredByDefault -eq $true -and
      (Test-ExactStringSet @($Contract.readiness.storageCapacityFields) $ExpectedContract.readiness.storageCapacityFields) -and
      $Contract.readiness.storageWatermarkFailClosed -eq $true -and
      $Contract.readiness.newSessionAdmissionBlockedOnCriticalStorage -eq $true -and
      $Contract.readiness.existingSessionCompletionAllowed -eq $true -and
      $Contract.alarms.persistent -eq $true -and
      (Test-ExactStringSet @($Contract.alarms.apiRoutes) $AlarmApiRoutes) -and
      (Test-ExactStringSet @($Contract.alarms.lifecycle) $AlarmLifecycle) -and
      (Test-ExactStringSet @($Contract.alarms.listStatuses) $AlarmListStatuses) -and
      $Contract.alarms.defectIngestTransactional -eq $true -and
      [string]$Contract.alarms.managedHealthSource -eq "system-health" -and
      (Test-ExactStringSet @($Contract.alarms.managedHealthAlarmTypes) $ManagedHealthAlarmTypes) -and
      $Contract.alarms.episodeDeduplication -eq $true -and
      $Contract.alarms.automaticRecoveryResolution -eq $true -and
      [string]$Contract.alarms.frontendEntry -eq "AlarmCenter" -and
      $Contract.alarms.serverOwnedActor -eq $true -and
      $Contract.dataLifecycle.persistentCleanupLedger -eq $true -and
      [string]$Contract.dataLifecycle.manifestSchema -eq "steel.record-artifact-cleanup.v1" -and
      $Contract.dataLifecycle.allowedRootsRequired -eq $true -and
      [string]$Contract.dataLifecycle.fileFingerprint -eq "sha256+size" -and
      $Contract.dataLifecycle.perFileProgress -eq $true -and
      $Contract.dataLifecycle.databaseDeleteAfterFiles -eq $true -and
      $Contract.dataLifecycle.atomicConfirmation -eq $true -and
      [string]$Contract.dataLifecycle.retryRoute -eq "POST /api/admin/records/cleanup/retry" -and
      $Contract.dataLifecycle.retainedSession -eq $true -and
      [string]$Contract.dataLifecycle.sqliteOnlineSnapshot -eq "VACUUM INTO" -and
      $Contract.dataLifecycle.mysqlServerSideBackup -eq $true -and
      [string]$Contract.dataLifecycle.backupManifestSchema -eq "steel.database-backup.v2" -and
      [string]$Contract.dataLifecycle.reportArchiveBackupManifestSchema -eq "steel.report-archive-backup.v1" -and
      $Contract.dataLifecycle.reportArchiveAuthoritativeValidation -eq $true -and
      $Contract.dataLifecycle.reportArchiveOfflineRestore -eq $true -and
      $Contract.dataLifecycle.reportArchivePriorTreeRetention -eq $true -and
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
      [int]$Contract.calibrationOperations.requiredCameraCount -eq 8 -and
      $Contract.calibrationOperations.uniqueCameraIps -eq $true -and
      $Contract.calibrationOperations.uniqueExpectedSerials -eq $true -and
      $Contract.calibrationOperations.uniqueSdkCalibrationPaths -eq $true -and
      $Contract.calibrationOperations.arrayArtifactAsSdkCalibrationAllowed -eq $false -and
      [string]$Contract.runtime.formalCapture -eq "headless-cpp" -and
      $Contract.runtime.qtRemoved -eq $true -and
      $Contract.runtime.windowsServiceSupervisor -eq $true -and
      [string]$Contract.runtime.windowsServiceName -eq "SteelInspectionRuntime" -and
      (Test-ExactStringSet @($Contract.runtime.orderedChildren) @("image", "algorithm", "capture", "service", "trigger")) -and
      [string]$Contract.runtime.gracefulStop -eq "CTRL_BREAK-then-timeout-terminate" -and
      [string]$Contract.runtime.restartBudget -eq "5-per-10-minutes" -and
      [string]$Contract.runtime.logRotation -eq "50MiB-5-generations"
    Add-ContractCheck $Checks "manifest-shape" "Runtime migration contract has the exact durable-task, readiness, alarm, calibration-safety, and runtime boundaries." $ShapeOk @($ResolvedManifest)
  }

  $IsTargetManifest = -not [string]::IsNullOrWhiteSpace([string]$Manifest.captureHeadless)
  $CaptureRole = if ($IsTargetManifest) { [string]$Manifest.captureRole } else { [string]$Manifest.capture.role }
  $QtDeclared = if ($IsTargetManifest) {
    -not [string]::IsNullOrWhiteSpace([string]$Manifest.captureQt)
  } else {
    $null -ne $Manifest.captureQt
  }
  $RuntimeBoundaryOk =
    [string]$Manifest.formalCapture -eq "headless-cpp" -and
    $CaptureRole -eq "formal-sdk-owner" -and
    -not $QtDeclared
  Add-ContractCheck $Checks "manifest-runtime-boundary" "Headless C++ is the sole SDK owner and Qt is absent from the runtime manifest." $RuntimeBoundaryOk @($ResolvedManifest)

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
$ArtifactCleanupPath = Join-Path $RepoRoot "app\service\src\artifact_cleanup.rs"
$TriggerPath = Join-Path $RepoRoot "app\trigger\src\main.rs"
$TriggerCargoPath = Join-Path $RepoRoot "app\trigger\Cargo.toml"
$TriggerEnvPath = Join-Path $RepoRoot "config\env\trigger-gateway.env.example"
$HeadlessEnvPath = Join-Path $RepoRoot "config\env\headless-cpp.env.example"
$TriggerDemoPath = Join-Path $RepoRoot "scripts\trigger_demo.py"
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
$IntegratedManagementSmokePath = Join-Path $RepoRoot "scripts\test-integrated-management-smoke.ps1"
$RealCalibrationAcceptancePath = Join-Path $RepoRoot "scripts\test-real-calibration-acceptance.ps1"
$RealCalibrationCrashRecoveryPath = Join-Path $RepoRoot "scripts\test-real-calibration-crash-recovery.ps1"
$RealCalibrationIntegrityGenerationPath = Join-Path $RepoRoot "scripts\test-real-calibration-integrity-generation.ps1"
$IntegratedFullPath = Join-Path $RepoRoot "scripts\test-integrated-capture-management-full.ps1"
$DatabaseBackupPath = Join-Path $RepoRoot "scripts\backup-database.ps1"
$DatabaseRestorePath = Join-Path $RepoRoot "scripts\restore-database.ps1"
$DatabaseRecoveryCommonPath = Join-Path $RepoRoot "scripts\database-recovery-common.ps1"
$ReportArchiveRecoveryPath = Join-Path $RepoRoot "scripts\manage-report-archives.ps1"
$ReportArchiveRecoveryTestPath = Join-Path $RepoRoot "scripts\test-report-archive-recovery.ps1"
$RuntimeSupervisorPath = Join-Path $RepoRoot "app\capture\src\steel_runtime_supervisor_main.cpp"
$RuntimeServiceInstallPath = Join-Path $RepoRoot "scripts\install-runtime-service.ps1"
$RuntimeServiceUninstallPath = Join-Path $RepoRoot "scripts\uninstall-runtime-service.ps1"
$RuntimeSupervisorTestPath = Join-Path $RepoRoot "scripts\test-runtime-supervisor.ps1"

$TaskText = Read-RequiredText $TaskPath
$TaskProductionText = Get-SourceBeforeTests $TaskText
$ServiceText = Read-RequiredText $ServicePath
$ServiceProductionText = Get-SourceBeforeTests $ServiceText
$CalibrationOperationsText = Read-RequiredText $CalibrationOperationsPath
$DatabaseText = Read-RequiredText $DatabasePath
$EntityText = Read-RequiredText $EntityPath
$ArtifactCleanupText = Read-RequiredText $ArtifactCleanupPath
$TriggerText = Read-RequiredText $TriggerPath
$TriggerCargoText = Read-RequiredText $TriggerCargoPath
$TriggerEnvText = Read-RequiredText $TriggerEnvPath
$HeadlessEnvText = Read-RequiredText $HeadlessEnvPath
$TriggerDemoText = Read-RequiredText $TriggerDemoPath
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
$IntegratedManagementSmokeText = Read-RequiredText $IntegratedManagementSmokePath
$RealCalibrationAcceptanceText = Read-RequiredText $RealCalibrationAcceptancePath
$RealCalibrationCrashRecoveryText = Read-RequiredText $RealCalibrationCrashRecoveryPath
$RealCalibrationIntegrityGenerationText = Read-RequiredText $RealCalibrationIntegrityGenerationPath
$IntegratedFullText = Read-RequiredText $IntegratedFullPath
$DatabaseBackupText = Read-RequiredText $DatabaseBackupPath
$DatabaseRestoreText = Read-RequiredText $DatabaseRestorePath
$DatabaseRecoveryCommonText = Read-RequiredText $DatabaseRecoveryCommonPath
$ReportArchiveRecoveryText = Read-RequiredText $ReportArchiveRecoveryPath
$ReportArchiveRecoveryTestText = Read-RequiredText $ReportArchiveRecoveryTestPath
$RuntimeSupervisorText = Read-RequiredText $RuntimeSupervisorPath
$RuntimeServiceInstallText = Read-RequiredText $RuntimeServiceInstallPath
$RuntimeServiceUninstallText = Read-RequiredText $RuntimeServiceUninstallPath
$RuntimeSupervisorTestText = Read-RequiredText $RuntimeSupervisorTestPath

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
  'idx_production_task_idempotency',
  'production_task_dependency_state',
  'propagate_production_task_dependency_failure',
  'requeue_blocked_production_task_descendants',
  'idx_production_task_chain',
  'idx_production_task_dependency'
))) {
  $DurableMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $ServiceText @(
  'queued_production_event_routes_are_explicit_and_do_not_take_the_sync_lane',
  'queued_production_chain_reuses_session_and_claims_fifo_through_steel_out',
  'service_restart_marks_inflight_task_interrupted_without_replaying_it',
  'failed_chain_dependency_blocks_all_downstream_tasks_until_parent_retry',
  'safety_critical_tasks_reject_always_run_bypass',
  'one_session_cannot_fork_into_a_second_production_chain',
  'explicitly_safe_trigger_cleanup_can_run_after_terminal_dependency_failure'
))) {
  $DurableMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals ($TaskProductionText + $EntityText) @(
  'chainId',
  'dependsOnTaskId',
  'dependencyPolicy',
  'blockedReason',
  'require-success',
  'always-run',
  'blocked'
))) {
  $DurableMissing.Add($Missing) | Out-Null
}
Add-ContractCheck $Checks "durable-six-kind-tasks" "Rust persists, recovers, FIFO-claims, and dependency-gates all six production task kinds through durable routes." ($DurableMissing.Count -eq 0) @($TaskPath, $ServicePath, $DatabasePath, $EntityPath) @($DurableMissing)

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
foreach ($Missing in @(Get-MissingWhitespaceInsensitiveLiterals $TaskProductionText @(
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

$TriggerSecurityMissing = [System.Collections.Generic.List[string]]::new()
foreach ($Missing in @(Get-MissingLiterals $TriggerProductionText @(
  'HmacSha256',
  'steel-trigger-v1',
  'TRIGGER_SHARED_SECRET',
  'TRIGGER_OPERATOR_TOKEN',
  'TRIGGER_SOURCE_ALLOWLIST',
  'TRIGGER_AUTH_WINDOW_SECONDS',
  'TRIGGER_ALLOW_MODE_MUTATION',
  'trigger_replay_detected',
  'trigger_source_forbidden',
  'X-Trigger-Timestamp',
  'X-Trigger-Nonce',
  'X-Trigger-Signature',
  'X-Trigger-Operator-Token',
  'local_operator_only',
  'trigger_mode_locked',
  'inspectionServiceHealthy'
))) {
  $TriggerSecurityMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals ($TriggerText + $TriggerCargoText) @(
  'hmac = "0.12"',
  'sha2 = "0.10"',
  'production_http_responses_do_not_emit_wildcard_cors_and_disable_caching',
  'hmac_authentication_accepts_once_then_rejects_replay_and_stale_time',
  'tcp_and_udp_envelope_authenticates_only_the_canonical_payload'
))) {
  $TriggerSecurityMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals ($ServiceProductionText + $InspectionApiText) @(
  '("POST", "/api/trigger/mode")',
  '("POST", "/api/trigger/manual/steel-in")',
  'trigger.operator.forwarded',
  'TRIGGER_OPERATOR_TOKEN',
  'createAdminHeaders'
))) {
  $TriggerSecurityMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals ($TriggerEnvText + $TriggerDemoText) @(
  'STEEL_RUNTIME_PROFILE=production',
  'TRIGGER_SHARED_SECRET',
  'TRIGGER_OPERATOR_TOKEN',
  'TRIGGER_SOURCE_ALLOWLIST',
  'hashlib.sha256',
  'X-Trigger-Signature',
  'steel-trigger-v1'
))) {
  $TriggerSecurityMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals ($PackageRuntimeText + $IntegratedFullText) @(
  'test-trigger-gateway-security.ps1',
  'triggerSecurityTest',
  'production-trigger-security'
))) {
  $TriggerSecurityMissing.Add($Missing) | Out-Null
}
if ($TriggerProductionText -match [regex]::Escape('Access-Control-Allow-Origin: *')) {
  $TriggerSecurityMissing.Add('wildcard CORS remains in production trigger source') | Out-Null
}
Add-ContractCheck $Checks "production-trigger-security" "Production HTTP/TCP/UDP triggers require HMAC-SHA256 with timestamp and nonce replay protection, enforce a source allowlist, lock operator mutations behind local/admin boundaries, redact status, never emit wildcard CORS, and ship a live release gate." ($TriggerSecurityMissing.Count -eq 0) @($TriggerPath, $TriggerCargoPath, $TriggerEnvPath, $TriggerDemoPath, $ServicePath, $InspectionApiPath, $PackageRuntimePath, $IntegratedFullPath) @($TriggerSecurityMissing)

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
  'STEEL_TRIGGER_HEALTH_REQUIRED',
  'STEEL_STORAGE_MIN_FREE_BYTES',
  'STEEL_STORAGE_MIN_FREE_PERCENT',
  'storage_capacity_below_watermark',
  'storage_capacity_near_watermark',
  'storage_not_ready_for_new_session',
  'recentWriteBytesPerSecond',
  'estimatedRemainingSeconds',
  '"warningFreeBytes": warning_free_bytes',
  '"warningFreePercent": warning_free_percent'
))) {
  $ReadinessMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals ($CaptureProviderText + $HeadlessEnvText) @(
  'capacityAvailable',
  'capacityBytes',
  'freeBytes',
  'freePercent',
  'recentWriteBytesPerSecond',
  'STEEL_STORAGE_MIN_FREE_BYTES=21474836480',
  'STEEL_STORAGE_MIN_FREE_PERCENT=10'
))) {
  $ReadinessMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $ServiceText @(
  'layered_health_routes_are_explicit_and_get_only',
  'storage_health_rejects_missing_unwritable_or_non_accepting_storage_and_times_out',
  'storage_health_warns_before_the_hard_admission_watermark',
  'low_storage_blocks_only_new_session_admission_and_preserves_safe_completion',
  'trigger_health_defaults_required_supports_explicit_optional_and_never_leaks_origin',
  'trigger_health_timeout_is_bounded_and_required_trigger_gates_service_readiness'
))) {
  $ReadinessMissing.Add($Missing) | Out-Null
}
Add-ContractCheck $Checks "layered-readiness" "Rust readiness is layered across database, task worker, capture, persistent calibration reconciliation, capacity-watermarked storage, required trigger health, approved algorithm identity, and fail-closed production policy." ($ReadinessMissing.Count -eq 0) @($ServicePath, $CaptureProviderPath, $HeadlessEnvPath) @($ReadinessMissing)

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
  'reconcile_managed_alarm',
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
  'start_system_health_alarm_monitor',
  'system_health_alarm_specs',
  'supervisor_runtime_status',
  'steel.runtime-supervisor.status.v1',
  'supervisor-restart-budget-exhausted',
  'supervisor-status-invalid',
  'storage-capacity-warning',
  'storage-critical',
  'capture-unavailable',
  'task-worker-unavailable',
  'calibration-reconciliation-required',
  'trigger-unavailable',
  'algorithm-not-qualified',
  'production-policy-invalid',
  'system.health.alarm.created',
  'system.health.alarm.resolved',
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
  'managed_health_alarm_is_one_episode_until_recovery_and_reopens_with_a_new_id',
  'system_health_alarm_reconciliation_persists_and_auto_resolves_the_episode',
  'supervisor_restart_budget_status_is_validated_and_mapped_to_a_persistent_alarm',
  'without trusting or sending a client actor',
  'loads durable open alarms',
  'server-owned confirmation and resolution identities'
))) {
  $AlarmMissing.Add($Missing) | Out-Null
}
Add-ContractCheck $Checks "persistent-alarm-lifecycle" "Persistent defect and managed system-health alarms are episode-deduplicated, audited, listed as open/history, and move active to acknowledged to resolved in the Tauri alarm center; recovered health episodes close automatically and recur under a new ID." ($AlarmMissing.Count -eq 0) @($ServicePath, $DatabasePath, $EntityPath, $AlarmApiPath, $AlarmCenterPath, $AppPath) @($AlarmMissing)

$DataLifecycleMissing = [System.Collections.Generic.List[string]]::new()
foreach ($Missing in @(Get-MissingLiterals ($ArtifactCleanupText + $EntityText + $DatabaseText) @(
  'steel.record-artifact-cleanup.v1',
  'STEEL_ARTIFACT_ALLOWED_ROOTS',
  'sha256_file',
  'files_deleted',
  'bytes_deleted',
  'table_name = "record_cleanup"',
  'complete_record_cleanup',
  'connection.begin().await?',
  'idx_record_cleanup_status_updated'
))) {
  $DataLifecycleMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $ServiceProductionText @(
  '("GET", "/api/admin/records/cleanup")',
  '("POST", "/api/admin/records/cleanup/retry")',
  'execute_record_artifact_cleanup',
  'find_open_record_cleanup_for_record',
  'VACUUM INTO',
  'database_backup_requires_server_side_job'
))) {
  $DataLifecycleMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals ($DatabaseBackupText + $DatabaseRestoreText + $DatabaseRecoveryCommonText) @(
  'steel.database-backup.v2',
  '--single-transaction',
  '--defaults-extra-file',
  'Get-SteelFileSha256',
  'Get-FileHash',
  'RESTORE $Engine',
  'Get-NetTCPConnection'
))) {
  $DataLifecycleMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals ($ReportArchiveRecoveryText + $ReportArchiveRecoveryTestText) @(
  'steel.report-archive-backup.v1',
  'Assert-ServiceArchiveValidation',
  'AllowRestoreFromOfflineUnvalidatedBackup',
  'RESTORE REPORTS',
  'priorArchiveRetained',
  'payloadTamperRejection',
  'offlineUnvalidatedRestoreRejection'
))) {
  $DataLifecycleMissing.Add($Missing) | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $ServiceText @(
  'record_cleanup_deletes_frozen_artifacts_before_database_indexes_and_is_auditable',
  'failed_cleanup.status, "failed"',
  'cleanup.id, failed_cleanup.id'
))) {
  $DataLifecycleMissing.Add($Missing) | Out-Null
}
Add-ContractCheck $Checks "persistent-data-lifecycle" "Record cleanup persists an allowed-root and sha256+size manifest, resumes per-file deletion before atomic index confirmation, retains the production session, and ships verified database plus immutable report-archive backup/restore paths." ($DataLifecycleMissing.Count -eq 0) @($ArtifactCleanupPath, $DatabasePath, $EntityPath, $ServicePath, $DatabaseBackupPath, $DatabaseRestorePath, $DatabaseRecoveryCommonPath, $ReportArchiveRecoveryPath, $ReportArchiveRecoveryTestPath) @($DataLifecycleMissing)

$RuntimeSupervisorMissing = [System.Collections.Generic.List[string]]::new()
foreach ($Missing in @(Get-MissingLiterals ($RuntimeSupervisorText + $RuntimeServiceInstallText + $RuntimeServiceUninstallText + $RuntimeSupervisorTestText + $PackageRuntimeText + $IntegratedManagementSmokeText) @(
  'SteelInspectionRuntime',
  'SERVICE_WIN32_OWN_PROCESS',
  'SERVICE_CONTROL_STOP',
  'GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT',
  'TerminateProcess',
  'more than 5 restarts in 10 minutes',
  'steel.runtime-supervisor.status.v1',
  'restartBudgetExhausted',
  'MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH',
  '--test-restart-budget-status',
  'restart-budget-status-atomic=passed',
  '50ULL * 1024ULL * 1024ULL',
  'steel-runtime-supervisor.exe',
  'CaptureBuildRoot',
  'Formal release packaging must use the clean canonical target/capture build root.',
  'captureBuild',
  '$env:STEEL_RUNTIME_PROFILE = $RuntimeProfile',
  '$env:STEEL_ALGORITHM_MODE = $AlgorithmMode',
  '-RuntimeProfile", "development"',
  '-AlgorithmMode", "demo"',
  '-TcpPort", [string]$TriggerTcpPort',
  '-UdpPort", [string]$TriggerUdpPort',
  '$env:TRIGGER_TCP_PORT = [string]$TcpPort',
  '$env:TRIGGER_UDP_PORT = [string]$UdpPort',
  'steel-runtime-package-smoke',
  '$WorkingDirectory = $RunWorkDir',
  'workRoot = $RunWorkDir',
  'TRIGGER_SHARED_SECRET and TRIGGER_OPERATOR_TOKEN must be different values.',
  "'unrestricted'",
  'serviceInstallStartStop = "requires elevated field acceptance"'
))) {
  $RuntimeSupervisorMissing.Add($Missing) | Out-Null
}
Add-ContractCheck $Checks "windows-runtime-supervisor" "The runtime provides one Windows SCM supervisor with ordered application readiness, reverse stop plus Job Object process-tree cleanup, bounded restart, atomic restart-budget exhaustion state for persistent alarms, restart-time log generations, and fail-closed secret/config preflight; application-level drain and live log rotation remain separate field gates." ($RuntimeSupervisorMissing.Count -eq 0) @($RuntimeSupervisorPath, $RuntimeServiceInstallPath, $RuntimeServiceUninstallPath, $RuntimeSupervisorTestPath, $PackageRuntimePath, $IntegratedManagementSmokePath) @($RuntimeSupervisorMissing)

# This check reads only explicitly named source/configuration files. It never
# searches target/, package output, minified bundles, object files, or binaries.
$QtCapabilityMissing = [System.Collections.Generic.List[string]]::new()
foreach ($Missing in @(Get-MissingLiterals $CaptureApiText @(
  'export type CaptureImageKind = "depth" | "intensity" | "metadata" | "sdk-derived";',
  '"/api/calibration/apply-all"',
  '"/api/calibration/rollback"',
  'cameraCalibrations.length !== expectedCameras',
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
  'algorithm_value_bool(request, "autoActivate", true)',
  'write_production_calibration_capture_fit_response',
  'calibration_capture_data_dir',
  '"completeFrames"',
  '"metadataFrames"',
  '"dataDir"',
  'targetDetection',
  'correctionAccepted',
  'autoActivation'
))) {
  $QtCapabilityMissing.Add("Automatic calibration: $Missing") | Out-Null
}
foreach ($Missing in @(Get-MissingLiterals $ServiceProductionText @(
  '("GET", "/api/capture/latest")',
  '("POST", "/api/calibration/apply-all")',
  '("POST", "/api/calibration/rollback")',
  'validate_calibration_set_safety',
  'CALIBRATION_SET_CAMERA_COUNT: usize = 8',
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
  'formalCapture = "sick-gentl"',
  'role = "only-formal-camera-owner"'
))) {
  $QtCapabilityMissing.Add("Formal runtime: $Missing") | Out-Null
}
Add-ContractCheck $Checks "qt-capability-formal-chain" "Former Qt operations remain covered while the formal runtime is restricted to the actual SICK GenTL camera line; legacy capture and BKV compatibility cannot enter the production chain." ($QtCapabilityMissing.Count -eq 0) @($CaptureApiPath, $SystemStatusPath, $CaptureDiagnosticPath, $BarSurfaceApiPath, $BarSurfaceAppPath, $ServicePath, $CaptureProviderPath, $PackageRuntimePath) @($QtCapabilityMissing)

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
  'RUN REAL EIGHT CAMERA CALIBRATION APPLY AND ROLLBACK'
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
