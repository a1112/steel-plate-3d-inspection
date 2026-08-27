param(
  [string]$SupervisorPath = "",
  [string]$RuntimeRoot = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

if ([string]::IsNullOrWhiteSpace($SupervisorPath)) {
  if (-not [string]::IsNullOrWhiteSpace($RuntimeRoot)) {
    $SupervisorPath = Join-Path $RuntimeRoot "service\steel-runtime-supervisor.exe"
  } elseif (Test-Path (Join-Path $PSScriptRoot "service\steel-runtime-supervisor.exe") -PathType Leaf) {
    $SupervisorPath = Join-Path $PSScriptRoot "service\steel-runtime-supervisor.exe"
  } else {
    $BuildCandidates = @(
      (Join-Path $RepoRoot "app\capture\build\Release\steel_runtime_supervisor.exe"),
      (Join-Path $RepoRoot "target\capture\Release\steel_runtime_supervisor.exe")
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | ForEach-Object {
      Get-Item -LiteralPath $_
    } | Sort-Object LastWriteTimeUtc -Descending
    if ($BuildCandidates.Count -gt 0) {
      $SupervisorPath = $BuildCandidates[0].FullName
    } else {
      $SupervisorPath = Join-Path $RepoRoot "app\capture\build\Release\steel_runtime_supervisor.exe"
    }
  }
}

if (-not (Test-Path -LiteralPath $SupervisorPath -PathType Leaf)) {
  throw "Missing runtime supervisor: $SupervisorPath"
}

$TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("steel-runtime-supervisor-test-" + [Guid]::NewGuid().ToString("N"))
$TestStateRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("steel-runtime-state-test-" + [Guid]::NewGuid().ToString("N"))
$TestPolicyRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("steel-runtime-policy-test-" + [Guid]::NewGuid().ToString("N"))
$TestDataRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("steel-runtime-data-test-" + [Guid]::NewGuid().ToString("N"))
try {
  foreach ($Directory in @(
    "service",
    "scripts\sick_capture",
    "algorithm-core",
    "config\capture",
    "config\capture\calibrations\current-8-time-trigger",
    "config\algorithm"
  )) {
    New-Item -ItemType Directory -Force -Path (Join-Path $TestRoot $Directory) | Out-Null
  }
  foreach ($File in @(
    "service\steel-capture-service.exe",
    "service\steel-image-service.exe",
    "service\steel-image-worker.exe",
    "service\steel-defect-worker.exe",
    "service\steel-trigger-gateway.exe",
    "service\steel-inspection-service.exe",
    "algorithm-core\steel_bar_surface_core.exe",
    "scripts\sick_capture_service.py",
    "scripts\sick_flow_analysis_service.py"
  )) {
    New-Item -ItemType File -Force -Path (Join-Path $TestRoot $File) | Out-Null
  }
  [System.IO.File]::WriteAllText(
    (Join-Path $TestRoot "config\algorithm\bar-surface-production.json"),
    "{}",
    [System.Text.UTF8Encoding]::new($false)
  )
  foreach ($Directory in @(
    "config",
    "logs",
    "service",
    "capture-config\calibrations\current-8-time-trigger",
    "temp",
    "work\capture",
    "result-data",
    "algorithm-input",
    "work\image",
    "work\image-worker",
    "work\defect-worker",
    "work\trigger",
    "work\service"
  )) {
    New-Item -ItemType Directory -Force -Path (Join-Path $TestStateRoot $Directory) | Out-Null
  }
  foreach ($Directory in @(
      $TestPolicyRoot,
      (Join-Path $TestDataRoot 'artifacts'),
      (Join-Path $TestDataRoot 'capture'),
      (Join-Path $TestDataRoot 'reconstruction'),
      (Join-Path $TestStateRoot 'reports\inspection')
    )) {
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  }
  $PayloadCalibrationPath = Join-Path $TestRoot "config\capture\calibrations\current-8-time-trigger\ArrayCalibration.xml"
  $SickCaptureProfilePath = Join-Path $TestStateRoot "capture-config\production-sick-profile.json"
  $PythonExecutablePath = Join-Path $TestPolicyRoot "python.exe"
  New-Item -ItemType File -Force -Path $SickCaptureProfilePath, $PythonExecutablePath | Out-Null
  $CalibrationPath = Join-Path $TestStateRoot "capture-config\calibrations\current-8-time-trigger\ArrayCalibration.xml"
  $AcceptanceReportPath = Join-Path $TestPolicyRoot "algorithm-acceptance.json"
  $AlgorithmCorePath = Join-Path $TestRoot "algorithm-core\steel_bar_surface_core.exe"
  $ArtifactRoot = Join-Path $TestDataRoot "artifacts"
  [System.IO.File]::WriteAllText($PayloadCalibrationPath, '<Calibration/>', [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($CalibrationPath, '<Calibration/>', [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($AcceptanceReportPath, '{}', [System.Text.UTF8Encoding]::new($false))

  $SupervisorSource = Join-Path $RepoRoot "app\capture\src\steel_runtime_supervisor_main.cpp"
  $ServiceSource = Join-Path $RepoRoot "app\service\src\main.rs"
  $ProductionTasksSource = Join-Path $RepoRoot "app\service\src\production_tasks.rs"
  if ((Test-Path -LiteralPath $SupervisorSource -PathType Leaf) -and
      (Get-Item -LiteralPath $SupervisorSource).LastWriteTimeUtc -gt (Get-Item -LiteralPath $SupervisorPath).LastWriteTimeUtc) {
    throw "Runtime supervisor binary is older than its source; rebuild before running this test: $SupervisorPath"
  }
  $TriggerSource = Join-Path $RepoRoot "app\trigger\src\main.rs"
  $LifecycleContract = "not-available-in-packaged-runtime"
  if ((Test-Path -LiteralPath $SupervisorSource -PathType Leaf) -and
      (Test-Path -LiteralPath $TriggerSource -PathType Leaf) -and
      (Test-Path -LiteralPath $ServiceSource -PathType Leaf) -and
      (Test-Path -LiteralPath $ProductionTasksSource -PathType Leaf)) {
    $SupervisorText = [System.IO.File]::ReadAllText($SupervisorSource)
    $TriggerText = [System.IO.File]::ReadAllText($TriggerSource)
    $ServiceText = [System.IO.File]::ReadAllText($ServiceSource)
    $ProductionTasksText = [System.IO.File]::ReadAllText($ProductionTasksSource)
    foreach ($RequiredToken in @(
      "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
      "CREATE_SUSPENDED",
      "AssignProcessToJobObject",
      "PROC_THREAD_ATTRIBUTE_HANDLE_LIST",
      "application_ready",
      "is_public_environment_name",
      "STEEL_BKV_",
      "validate_production_environment",
      "validate_state_root",
      "g_state_root",
      'L"--state-root"',
      "wait_for_business_drain",
      "kDrainTimeoutMs = 60000",
      "kStopTimeoutMs = 30000",
      "wait_for_children_until",
      "finish_log_pumps",
      "CancelSynchronousIo",
      "forced termination after graceful timeout",
      '"/api/trigger/drain"',
      '"/api/runtime/drain"',
      "activeSession",
      "queueDepth",
      "activeTaskId",
      "inFlight",
      "RotatingLogWriter",
      "log_pump_main",
      "CreatePipe",
      "log_thread",
      "kLogRotateBytes = 50ULL * 1024ULL * 1024ULL",
      "kLogGenerations = 5",
      "runtime_supervisor_recovery_policy.h",
      "kManagedRecoveryPollMs = 2000",
      "kManagedRecoveryConfirmations = 2",
      "capture_requires_managed_restart",
      "capture 49007 restartRequired confirmed twice",
      "steel.runtime-supervisor.status.v1",
      "restartBudgetExhausted",
      "MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH",
      "restart_budget_recovered_after_stable_runtime",
      '\"ready\":true'
    )) {
      if (-not $SupervisorText.Contains($RequiredToken)) {
        throw "Supervisor lifecycle contract is missing: $RequiredToken"
      }
    }
    foreach ($RequiredToken in @(
      "RuntimeAdmissionGuard",
      'path == "/api/runtime/drain"',
      "runtime_admission",
      '"inFlight"',
      "production_command_lock.lock()",
      '"/api/production/steel-out"',
      '"/api/production/tasks/cancel"'
    )) {
      if (-not $ServiceText.Contains($RequiredToken)) {
        throw "Inspection service drain contract is missing: $RequiredToken"
      }
    }
    foreach ($RequiredToken in @(
      'runtime_is_draining(state) && kind != "steel-out"',
      '"error": "runtime_draining"'
    )) {
      if (-not $ProductionTasksText.Contains($RequiredToken)) {
        throw "Production task drain contract is missing: $RequiredToken"
      }
    }
    foreach ($RequiredToken in @(
      "bind_tcp_trigger_listener",
      "bind_udp_trigger_listener",
      '"gatewayReady"',
      "TriggerAdmissionGuard",
      "admit_trigger",
      "completion_target",
      '"/api/trigger/drain"',
      '"inFlight"'
    )) {
      if (-not $TriggerText.Contains($RequiredToken)) {
        throw "Trigger listener readiness contract is missing: $RequiredToken"
      }
    }
    $DrainFunctionOffset = $SupervisorText.IndexOf(
      "bool wait_for_business_drain",
      [StringComparison]::Ordinal)
    $TriggerDrainOffset = $SupervisorText.IndexOf(
      '"/api/trigger/drain"',
      $DrainFunctionOffset,
      [StringComparison]::Ordinal)
    $ServiceDrainOffset = $SupervisorText.IndexOf(
      '"/api/runtime/drain"',
      $DrainFunctionOffset,
      [StringComparison]::Ordinal)
    if ($DrainFunctionOffset -lt 0 -or $TriggerDrainOffset -lt 0 -or
        $ServiceDrainOffset -le $TriggerDrainOffset) {
      throw "Supervisor must close trigger admission before inspection service admission."
    }
    $RunDrainOffset = $SupervisorText.IndexOf(
      "wait_for_business_drain(requester, narrow",
      $ServiceDrainOffset,
      [StringComparison]::Ordinal)
    $FallbackOffset = $SupervisorText.IndexOf(
      "bounded CTRL_BREAK fallback",
      $RunDrainOffset,
      [StringComparison]::Ordinal)
    $StopAfterDrainOffset = $SupervisorText.IndexOf(
      "stop_children(children);",
      $RunDrainOffset,
      [StringComparison]::Ordinal)
    if ($RunDrainOffset -lt 0 -or $FallbackOffset -le $RunDrainOffset -or
        $StopAfterDrainOffset -le $FallbackOffset) {
      throw "Supervisor must attempt bounded business drain before CTRL_BREAK child shutdown."
    }
    $LifecycleContract = "passed"
  }

  $BusinessDrainOutput = @(& $SupervisorPath --test-business-drain 2>&1)
  $BusinessDrainExitCode = $LASTEXITCODE
  $BusinessDrainText = $BusinessDrainOutput -join "`n"
  if ($BusinessDrainExitCode -ne 0 -or
      -not $BusinessDrainText.Contains('business-drain-positive=passed') -or
      -not $BusinessDrainText.Contains('business-drain-timeout=passed')) {
    throw "Supervisor business drain positive/timeout self-test failed: $BusinessDrainText"
  }
  $LogRotationOutput = @(& $SupervisorPath --test-log-rotation --state-root $TestStateRoot 2>&1)
  $LogRotationExitCode = $LASTEXITCODE
  $LogRotationText = $LogRotationOutput -join "`n"
  if ($LogRotationExitCode -ne 0 -or
      -not $LogRotationText.Contains('log-below-threshold=passed') -or
      -not $LogRotationText.Contains('log-live-rotation=passed') -or
      -not $LogRotationText.Contains('log-generations=5')) {
    throw "Supervisor running log rotation self-test failed: $LogRotationText"
  }
  $ManagedRecoveryOutput = @(& $SupervisorPath --test-managed-recovery 2>&1)
  $ManagedRecoveryExitCode = $LASTEXITCODE
  $ManagedRecoveryText = $ManagedRecoveryOutput -join "`n"
  if ($ManagedRecoveryExitCode -ne 0 -or
      -not $ManagedRecoveryText.Contains('managed-recovery-49007=passed') -or
      -not $ManagedRecoveryText.Contains('managed-recovery-two-confirmations=passed') -or
      -not $ManagedRecoveryText.Contains('calibration-reconciliation-bypass=rejected')) {
    throw "Supervisor managed recovery self-test failed: $ManagedRecoveryText"
  }
  $RestartBudgetStatusOutput = @(& $SupervisorPath --test-restart-budget-status --state-root $TestStateRoot 2>&1)
  $RestartBudgetStatusExitCode = $LASTEXITCODE
  $RestartBudgetStatusText = $RestartBudgetStatusOutput -join "`n"
  if ($RestartBudgetStatusExitCode -ne 0 -or
      -not $RestartBudgetStatusText.Contains('restart-budget-status-atomic=passed') -or
      -not $RestartBudgetStatusText.Contains('restart-budget-exhausted-persistent=passed') -or
      -not $RestartBudgetStatusText.Contains('restart-budget-recovery=passed')) {
    throw "Supervisor restart-budget status self-test failed: $RestartBudgetStatusText"
  }

  $InstallPolicyContract = "not-available-in-packaged-runtime"
  $InstallScript = Join-Path $PSScriptRoot "install-runtime-service.ps1"
  $UninstallScript = Join-Path $PSScriptRoot "uninstall-runtime-service.ps1"
  if (-not (Test-Path -LiteralPath $InstallScript -PathType Leaf)) {
    $InstallScript = Join-Path $RepoRoot "scripts\install-runtime-service.ps1"
  }
  if (-not (Test-Path -LiteralPath $UninstallScript -PathType Leaf)) {
    $UninstallScript = Join-Path $RepoRoot "scripts\uninstall-runtime-service.ps1"
  }
  if ((Test-Path -LiteralPath $InstallScript -PathType Leaf) -and
      (Test-Path -LiteralPath $UninstallScript -PathType Leaf)) {
    foreach ($Script in @($InstallScript, $UninstallScript)) {
      $Tokens = $null
      $Errors = $null
      [System.Management.Automation.Language.Parser]::ParseFile(
        $Script,
        [ref]$Tokens,
        [ref]$Errors
      ) | Out-Null
      if ($Errors.Count -gt 0) {
        throw "Runtime service script has PowerShell parse errors: $Script"
      }
    }
    $InstallText = [System.IO.File]::ReadAllText($InstallScript)
    $UninstallText = [System.IO.File]::ReadAllText($UninstallScript)
    foreach ($RequiredToken in @(
      'SetAccessRuleProtection($true, $false)',
      'Assert-TrustedPathAcl',
      'Assert-TrustedAncestorChain',
      'GetAccessRules',
      'GetOwner',
      'Untrusted explicit or inherited ACE',
      'ReparsePoint',
      'Protect-ImmutableRuntimeTree',
      'Assert-ExistingStateTreeTrust',
      '$SourcePackageRoot = (Resolve-Path -LiteralPath $RuntimeRoot).Path',
      '$ReleasesRoot = Join-Path $InstallRoot',
      'Get-RuntimeReleaseId',
      'Get-RuntimeServiceBinaryPath',
      'Resolve-DeploymentChildPath',
      'Assert-SameVolumePaths',
      'Assert-ReleaseDestinationAvailable',
      '[System.IO.Directory]::Move($IncomingReleaseRoot, $FinalReleaseRoot)',
      'Test-FileCatalog -Path $Root -CatalogFilePath $CatalogPath -Detailed',
      "[string]`$Manifest.packageClass -cne 'formal-release'",
      "[string]`$Manifest.integrity.checksumAlgorithm -cne 'sha256'",
      "[string]`$Manifest.integrity.checksumInventory -cne 'checksums.sha256'",
      "[string]`$_ -ceq 'checksums.sha256'",
      "[string]`$_ -ceq 'release-integrity.cat'",
      'ExpectedFirstPartyThumbprint',
      'AllowedVendorSdkSignerThumbprints',
      'SecretEnvFile and AlgorithmAcceptanceReport must be outside the source package, InstallRoot, and StateRoot',
      'RuntimeRoot must be a dedicated package directory and must not be a volume root',
      'InstallRoot must be a non-root path that does not overlap the source package RuntimeRoot',
      'StateRoot must be a non-root path that does not overlap the source package or InstallRoot',
      'production-data trust domain and may intentionally overlap each other',
      'Deployment storage and artifact roots must not overlap protected runtime, state, secret, or acceptance paths',
      'non-placeholder stable semantic version',
      '[string]$PackageManifest.desktop.version -cne $ReleaseVersion',
      '[string]$PackageManifest.source.gitTag -cnotin @($ReleaseVersion, "v$ReleaseVersion")',
      'SteelReleaseVersion',
      'SteelReleaseCommit',
      'SteelReleaseId',
      'SteelInstallRoot',
      'SteelRuntimeRoot',
      'SteelStateRoot',
      'Assert-TrustedPathAcl -Path $Item.FullName -Mode PolicyReadOnly',
      'Assert-TrustedPathAcl -Path $Item.FullName -Mode Mutable -AllowInherited',
      'Global\SteelInspectionRuntime-Deployment',
      'Set-DeploymentJournalPhase',
      'Write-DurableBytesAtomically',
      'Write-DurableJsonAtomically',
      'not a cross-resource atomic transaction',
      'Get-ServiceRegistrySnapshot',
      'Restore-ExistingServiceConfiguration',
      'Write-FileAtomically',
      'PreviousRuntimeEnvBytes',
      'Set-BoundedServiceFailureActions',
      'SC_ACTION_NONE',
      'ChangeServiceConfig2W'
    )) {
      if (-not $InstallText.Contains($RequiredToken)) {
        throw "Runtime service installation policy contract is missing: $RequiredToken"
      }
    }
    if ($InstallText.Contains('restart/5000/restart/15000/restart/60000') -or
        $InstallText.Contains('restart/5000/restart/30000/none/0')) {
      throw 'Runtime service installation still contains an unbounded or invalid restart tail.'
    }
    if ($InstallText.Contains('FilesToSkip')) {
      throw 'Complete source, staging, and final release catalog verification must not use FilesToSkip.'
    }
    $ImmutableProtectionOffset = $InstallText.IndexOf('Protect-ImmutableRuntimeTree -Path $RuntimeRoot', [StringComparison]::Ordinal)
    foreach ($BoundaryToken in @(
      'RuntimeRoot must be a dedicated package directory and must not be a volume root',
      'InstallRoot must be a non-root path that does not overlap the source package RuntimeRoot',
      'StateRoot must be a non-root path that does not overlap the source package or InstallRoot',
      'SecretEnvFile and AlgorithmAcceptanceReport must be outside the source package, InstallRoot, and StateRoot',
      'Deployment storage and artifact roots must not overlap protected runtime, state, secret, or acceptance paths'
    )) {
      $BoundaryOffset = $InstallText.IndexOf($BoundaryToken, [StringComparison]::Ordinal)
      if ($BoundaryOffset -lt 0 -or $ImmutableProtectionOffset -lt 0 -or
          $BoundaryOffset -ge $ImmutableProtectionOffset) {
        throw "Runtime path boundary validation must precede immutable ACL changes: $BoundaryToken"
      }
    }
    $DeploymentOrder = @(
      'Assert-ReleasePackageIntegrity -Manifest $PackageManifest -Root $SourcePackageRoot',
      '$AcceptanceValidationJson = & $AlgorithmAcceptanceValidator',
      'Set-BoundedServiceFailureActions -Name $ServiceName -InitializeOnly',
      'Write-DurableBytesAtomically -Path $RuntimeEnvBackupPath',
      'Write-DurableJsonAtomically -Path $ScmBackupPath',
      "Set-DeploymentJournalPhase -Journal `$DeploymentJournal -Phase 'prepared'",
      'Assert-ReleasePackageIntegrity -Root $SourcePackageRoot -Manifest $PackageManifest',
      'New-Item -ItemType Directory -Path $IncomingReleaseRoot',
      'Copy-Item -LiteralPath $SourceItem.FullName -Destination $IncomingReleaseRoot -Recurse -Force',
      'Assert-ReleasePackageIntegrity -Root $IncomingReleaseRoot -Manifest $StagedManifest',
      'Protect-ImmutableRuntimeTree -Path $RuntimeRoot',
      'Assert-ReleasePackageIntegrity -Manifest $StagedManifest -Root $RuntimeRoot',
      '[System.IO.Directory]::Move($IncomingReleaseRoot, $FinalReleaseRoot)',
      'Assert-ReleasePackageIntegrity -Root $FinalReleaseRoot -Manifest $FinalManifest',
      '$RuntimeRoot = $FinalReleaseRoot',
      '$BinaryPath = Get-RuntimeServiceBinaryPath -ReleaseRoot $RuntimeRoot -StateRoot $StateRoot',
      '& $Supervisor --check --root $RuntimeRoot --state-root $StateRoot',
      'Stop-Service -Name $ServiceName -Force',
      "Invoke-ScChecked @('config'",
      "Invoke-ScChecked @('create'",
      'Write-DurableJsonAtomically -Path $ActiveDeploymentPath',
      "Set-DeploymentJournalPhase -Journal `$DeploymentJournal -Phase 'committed'",
      '$TransactionCommitted = $true'
    )
    $PreviousOffset = -1
    foreach ($DeploymentToken in $DeploymentOrder) {
      $Offset = $InstallText.IndexOf(
        $DeploymentToken,
        $PreviousOffset + 1,
        [StringComparison]::Ordinal)
      if ($Offset -lt 0) {
        throw "Versioned runtime deployment order is invalid at: $DeploymentToken"
      }
      $PreviousOffset = $Offset
    }
    $IntegrityValidationCalls = [regex]::Matches(
      $InstallText,
      '(?m)^\s*Assert-ReleasePackageIntegrity\b')
    if ($IntegrityValidationCalls.Count -lt 5) {
      throw 'Source, pre-copy source, staging pre/post-ACL, and final release integrity validations are all required.'
    }
    foreach ($DirectScmToken in @(
      '$SupervisorPath = Join-Path $ResolvedReleaseRoot',
      '--service --root `"$ResolvedReleaseRoot`" --state-root',
      "'binPath=', `$BinaryPath",
      'No mutable "current" link is used by SCM'
    )) {
      if (-not $InstallText.Contains($DirectScmToken)) {
        throw "SCM must point directly at the immutable version directory: $DirectScmToken"
      }
    }
    $StateAuditOffset = $InstallText.IndexOf('Assert-ExistingStateTreeTrust -Path $StateRoot', [StringComparison]::Ordinal)
    $StateSeedOffset = $InstallText.IndexOf('Copy-Item -LiteralPath $CaptureConfigTemplate', [StringComparison]::Ordinal)
    $StateEnvironmentWriteOffset = $InstallText.IndexOf('Write-FileAtomically -Path $RuntimeEnvFile', [StringComparison]::Ordinal)
    if ($StateAuditOffset -lt 0 -or $StateSeedOffset -le $StateAuditOffset -or
        $StateEnvironmentWriteOffset -le $StateAuditOffset) {
      throw 'Existing StateRoot trust audit must precede all mutable state seeding and environment writes.'
    }
    foreach ($RequiredToken in @(
      'Wait-ServiceAbsent',
      'Wait-RuntimePortsReleased',
      'Get-NetTCPConnection',
      'Get-NetUDPEndpoint',
      '4317, 4873, 4874, 4875, 4876, 4881, 4882, 4883',
      'SteelStateRoot',
      'config\runtime-service.env'
    )) {
      if (-not $UninstallText.Contains($RequiredToken)) {
        throw "Runtime service uninstallation policy contract is missing: $RequiredToken"
      }
    }
    $InstallPolicyContract = "passed"
  }

  $RuntimeEnv = Join-Path $TestStateRoot "config\runtime-service.env"
  $SecretEnv = Join-Path $TestPolicyRoot "runtime-secrets.env"
  $ValidRuntimeEnvironment = @(
    'STEEL_RUNTIME_PROFILE=production',
    'STEEL_ALGORITHM_MODE=production',
    'BAR_SURFACE_MOCK_DEFECT_COUNT=0',
    "STEEL_ALGORITHM_ACCEPTANCE_REPORT=$AcceptanceReportPath",
    "STEEL_ALGORITHM_CALIBRATION_PATH=$CalibrationPath",
    "STEEL_BAR_SURFACE_CORE_EXE=$AlgorithmCorePath",
    ('STEEL_RELEASE_COMMIT=' + ('a' * 40)),
    'INSPECTION_SERVICE_HOST=0.0.0.0',
    'INSPECTION_SERVICE_PORT=4873',
    'STEEL_CAPTURE_PROVIDER=external-api',
    "STEEL_SICK_CAPTURE_PROFILE=$SickCaptureProfilePath",
    "STEEL_PYTHON_EXECUTABLE=$PythonExecutablePath",
    'CAPTURE_SERVICE_ORIGIN=http://127.0.0.1:4317',
    'STEEL_CAPTURE_SERVICE_AUTOSTART=1',
    'STEEL_CAPTURE_RESTART_BUDGET=5',
    'STEEL_CAPTURE_RESTART_BACKOFF_MS=1000',
    'STEEL_CAPTURE_READY_TIMEOUT_MS=15000',
    "CAPTURE_STORAGE_ROOT=$(Join-Path $TestDataRoot 'capture')",
    "CAPTURE_CAMERA_STORAGE_ROOT=$(Join-Path $TestDataRoot 'capture')",
    "STEEL_BAR_CAPTURE_ROOT=$(Join-Path $TestDataRoot 'capture')",
    "STEEL_ALGORITHM_DATA_ROOT=$(Join-Path $TestDataRoot 'reconstruction')",
    'STEEL_ALGORITHM_PROCESS_TIMEOUT_SEC=1800',
    "STEEL_REPORT_ARCHIVE_ROOT=$(Join-Path $TestStateRoot 'reports\inspection')",
    'TRIGGER_GATEWAY_HOST=127.0.0.1',
    'TRIGGER_GATEWAY_PORT=4881',
    'TRIGGER_GATEWAY_ORIGIN=http://127.0.0.1:4881',
    'TRIGGER_SOURCE_ALLOWLIST=127.0.0.1/32',
    'TRIGGER_ALLOW_MODE_MUTATION=0',
    'STEEL_TRIGGER_HEALTH_REQUIRED=1',
    'STEEL_STORAGE_MIN_FREE_BYTES=1',
    'STEEL_STORAGE_MIN_FREE_PERCENT=1',
    "STEEL_ARTIFACT_ALLOWED_ROOTS=$ArtifactRoot"
  )
  [System.IO.File]::WriteAllLines($RuntimeEnv, $ValidRuntimeEnvironment, [System.Text.UTF8Encoding]::new($true))
  [System.IO.File]::WriteAllLines(
    $SecretEnv,
    @(
      ('TRIGGER_SHARED_SECRET=' + ('s' * 32)),
      ('TRIGGER_OPERATOR_TOKEN=' + ('t' * 32))
    ),
    [System.Text.UTF8Encoding]::new($false)
  )
  $PreviousSecretEnv = $env:STEEL_RUNTIME_SECRET_ENV_FILE
  $env:STEEL_RUNTIME_SECRET_ENV_FILE = $SecretEnv
  & $SupervisorPath --check --root $TestRoot --state-root $TestStateRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Supervisor rejected a valid production UTF-8 BOM runtime configuration."
  }
  foreach ($ForbiddenMutablePayloadPath in @(
    (Join-Path $TestRoot 'config\env\runtime-service.env'),
    (Join-Path $TestRoot 'logs'),
    (Join-Path $TestRoot 'config\service\steel-inspection.sqlite')
  )) {
    if (Test-Path -LiteralPath $ForbiddenMutablePayloadPath) {
      throw "Supervisor wrote mutable state into immutable payload: $ForbiddenMutablePayloadPath"
    }
  }

  [System.IO.File]::WriteAllText(
    $RuntimeEnv,
    "STEEL_RUNTIME_PROFILE=production`r`nSTEEL_RUNTIME_PROFILE=development`r`n",
    [System.Text.UTF8Encoding]::new($false)
  )
  $PreviousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $SupervisorPath --check --root $TestRoot --state-root $TestStateRoot 2>$null
  $DuplicateExitCode = $LASTEXITCODE
  $ErrorActionPreference = $PreviousErrorAction
  if ($DuplicateExitCode -eq 0) {
    throw "Supervisor accepted duplicate environment keys."
  }

  [System.IO.File]::WriteAllText($RuntimeEnv, "STEEL_RUNTIME_PROFILE=production`r`n", [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($SecretEnv, "STEEL_RUNTIME_PROFILE=development`r`n", [System.Text.UTF8Encoding]::new($false))
  $ErrorActionPreference = "Continue"
  & $SupervisorPath --check --root $TestRoot --state-root $TestStateRoot 2>$null
  $SecretPolicyExitCode = $LASTEXITCODE
  $ErrorActionPreference = $PreviousErrorAction
  if ($SecretPolicyExitCode -eq 0) {
    throw "Supervisor allowed a secret file to override public runtime policy."
  }

  [System.IO.File]::WriteAllLines(
    $SecretEnv,
    @(
      ('TRIGGER_SHARED_SECRET=' + ('s' * 32)),
      ('TRIGGER_OPERATOR_TOKEN=' + ('t' * 32))
    ),
    [System.Text.UTF8Encoding]::new($false)
  )
  $InvalidProductionEnvironment = @($ValidRuntimeEnvironment | ForEach-Object {
    if ($_ -ceq 'BAR_SURFACE_MOCK_DEFECT_COUNT=0') { 'BAR_SURFACE_MOCK_DEFECT_COUNT=1' } else { $_ }
  })
  [System.IO.File]::WriteAllLines($RuntimeEnv, $InvalidProductionEnvironment, [System.Text.UTF8Encoding]::new($false))
  $ErrorActionPreference = "Continue"
  & $SupervisorPath --check --root $TestRoot --state-root $TestStateRoot 2>$null
  $ProductionPolicyExitCode = $LASTEXITCODE
  $ErrorActionPreference = $PreviousErrorAction
  if ($ProductionPolicyExitCode -eq 0) {
    throw "Supervisor accepted a production environment with synthetic defect injection enabled."
  }

  [System.IO.File]::WriteAllLines($RuntimeEnv, $ValidRuntimeEnvironment, [System.Text.UTF8Encoding]::new($false))
  $ErrorActionPreference = "Continue"
  & $SupervisorPath --check --root $TestRoot --state-root $TestRoot 2>$null
  $OverlappingRootExitCode = $LASTEXITCODE
  $ErrorActionPreference = $PreviousErrorAction
  if ($OverlappingRootExitCode -eq 0) {
    throw "Supervisor accepted overlapping immutable payload and mutable state roots."
  }

  [System.IO.File]::WriteAllLines(
    $SecretEnv,
    @(
      ('TRIGGER_SHARED_SECRET=' + ('s' * 32)),
      ('TRIGGER_OPERATOR_TOKEN=' + ('t' * 32)),
      'STEEL_DATABASE_URL=sqlite://C:/outside-state.sqlite'
    ),
    [System.Text.UTF8Encoding]::new($false)
  )
  $ErrorActionPreference = "Continue"
  & $SupervisorPath --check --root $TestRoot --state-root $TestStateRoot 2>$null
  $ExternalSqliteExitCode = $LASTEXITCODE
  $ErrorActionPreference = $PreviousErrorAction
  if ($ExternalSqliteExitCode -eq 0) {
    throw "Supervisor accepted a SQLite override outside managed StateRoot."
  }

  Remove-Item -LiteralPath (Join-Path $TestRoot "service\steel-trigger-gateway.exe") -Force
  [System.IO.File]::WriteAllText(
    $RuntimeEnv,
    "STEEL_RUNTIME_PROFILE=production`r`n",
    [System.Text.UTF8Encoding]::new($false)
  )
  $ErrorActionPreference = "Continue"
  & $SupervisorPath --check --root $TestRoot --state-root $TestStateRoot 2>$null
  $IncompleteExitCode = $LASTEXITCODE
  $ErrorActionPreference = $PreviousErrorAction
  if ($IncompleteExitCode -eq 0) {
    throw "Supervisor accepted an incomplete runtime layout."
  }

  # The final probe is expected to fail; do not leak its native exit code to callers.
  $global:LASTEXITCODE = 0
  [ordered]@{
    code = 0
    schema = "steel.runtime-supervisor.test.v1"
    utf8BomConfiguration = "passed"
    immutablePayloadAndMutableStateSeparation = "passed"
    externalPolicyAndProductionDataSeparation = "passed"
    installerRuntimeEnvironment = "passed"
    businessDrainGate = "passed"
    runningLogRotation = "passed"
    managedCaptureRecovery = "passed"
    restartBudgetStatus = "passed"
    duplicateEnvironmentKey = "rejected"
    secretPolicyOverride = "rejected"
    invalidProductionPolicy = "rejected"
    overlappingPayloadAndStateRoots = "rejected"
    externalSQLiteOverride = "rejected"
    incompleteLayout = "rejected"
    jobObjectAndListenerContract = $LifecycleContract
    serviceInstallationPolicyContract = $InstallPolicyContract
    serviceInstallStartStop = "requires elevated field acceptance"
  } | ConvertTo-Json
} finally {
  if ($null -ne (Get-Variable -Name PreviousSecretEnv -ErrorAction SilentlyContinue)) {
    if ($null -eq $PreviousSecretEnv) {
      Remove-Item Env:STEEL_RUNTIME_SECRET_ENV_FILE -ErrorAction SilentlyContinue
    } else {
      $env:STEEL_RUNTIME_SECRET_ENV_FILE = $PreviousSecretEnv
    }
  }
  if (Test-Path -LiteralPath $TestRoot) {
    Remove-Item -LiteralPath $TestRoot -Recurse -Force
  }
  if (Test-Path -LiteralPath $TestStateRoot) {
    Remove-Item -LiteralPath $TestStateRoot -Recurse -Force
  }
  if (Test-Path -LiteralPath $TestPolicyRoot) {
    Remove-Item -LiteralPath $TestPolicyRoot -Recurse -Force
  }
  if (Test-Path -LiteralPath $TestDataRoot) {
    Remove-Item -LiteralPath $TestDataRoot -Recurse -Force
  }
}
