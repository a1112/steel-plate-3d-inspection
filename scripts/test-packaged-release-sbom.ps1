param()

$ErrorActionPreference = 'Stop'
$Verifier = Join-Path $PSScriptRoot 'verify-packaged-release-sbom.ps1'
$TempBoundary = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$Root = Join-Path $TempBoundary ('steel-packaged-sbom-test-' + [guid]::NewGuid().ToString('N'))
$Commit = '1234567890abcdef1234567890abcdef12345678'

function Write-Json {
  param([string]$Path, $Value)
  $Parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $Parent | Out-Null
  [System.IO.File]::WriteAllText(
    $Path,
    (($Value | ConvertTo-Json -Depth 100) + "`n"),
    [System.Text.UTF8Encoding]::new($false)
  )
}

function Get-Hash {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TextHash {
  param([string]$Text)
  $Algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    return -join ($Algorithm.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') })
  } finally {
    $Algorithm.Dispose()
  }
}

function New-Property {
  param([string]$Name, [string]$Value)
  return [ordered]@{ name = $Name; value = $Value }
}

function Assert-Rejected {
  param([scriptblock]$Action)
  $Rejected = $false
  try { & $Action | Out-Null } catch { $Rejected = $true }
  if (-not $Rejected) { throw 'Tampered packaged SBOM fixture was not rejected.' }
}

try {
  $Evidence = Join-Path $Root 'build-evidence'
  $ToolDir = Join-Path $Evidence 'sbom-tools'
  $CaptureDir = Join-Path $Root 'capture-headless'
  $PrerequisiteDir = Join-Path $Root 'desktop-installer\prerequisites'
  New-Item -ItemType Directory -Force -Path $Evidence, $ToolDir, $CaptureDir, $PrerequisiteDir | Out-Null

  $SdkPath = Join-Path $CaptureDir 'nvt_lvm_sdk.dll'
  $VcPath = Join-Path $PrerequisiteDir 'VC_redist.x64.exe'
  [System.IO.File]::WriteAllText($SdkPath, 'fixture-camera-sdk', [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($VcPath, 'fixture-vc-runtime', [System.Text.UTF8Encoding]::new($false))

  $ExternalArtifacts = [ordered]@{
    'cpp-toolchain' = [ordered]@{ id = 'msvc'; name = 'MSVC Build Tools'; artifact = 'vs_buildtools.exe'; hash = Get-TextHash 'msvc'; version = '14.40'; type = 'application'; scope = 'build'; supplier = 'Microsoft Corporation' }
    'camera-sdk' = [ordered]@{ id = 'camera-sdk'; name = 'Fixture Camera SDK'; artifact = 'nvt_lvm_sdk.dll'; hash = Get-Hash $SdkPath; version = '5.4.3'; type = 'library'; scope = 'runtime'; supplier = 'Fixture Camera Vendor' }
    'vc-runtime' = [ordered]@{ id = 'vc-redist'; name = 'VC Runtime'; artifact = 'VC_redist.x64.exe'; hash = Get-Hash $VcPath; version = '14.40'; type = 'application'; scope = 'runtime'; supplier = 'Microsoft Corporation' }
    'webview2-runtime' = [ordered]@{ id = 'webview2'; name = 'WebView2 Runtime'; artifact = 'webview2.exe'; hash = Get-TextHash 'webview2'; version = '126.0'; type = 'framework'; scope = 'runtime'; supplier = 'Microsoft Corporation' }
    'wix-toolset' = [ordered]@{ id = 'wix'; name = 'WiX Toolset'; artifact = 'wix.zip'; hash = Get-TextHash 'wix'; version = '3.14.1'; type = 'application'; scope = 'build'; supplier = 'WiX Toolset Foundation' }
    'nsis' = [ordered]@{ id = 'nsis'; name = 'NSIS'; artifact = 'nsis.zip'; hash = Get-TextHash 'nsis'; version = '3.10'; type = 'application'; scope = 'build'; supplier = 'NSIS Contributors' }
  }
  $PolicyRows = @()
  foreach ($Category in @('cpp-toolchain', 'camera-sdk', 'vc-runtime', 'webview2-runtime', 'wix-toolset', 'nsis')) {
    $Item = $ExternalArtifacts[$Category]
    $PolicyRows += ,[ordered]@{
      id = [string]$Item.id
      category = $Category
      type = [string]$Item.type
      name = [string]$Item.name
      version = [string]$Item.version
      supplier = [string]$Item.supplier
      scope = [string]$Item.scope
      artifact = [string]$Item.artifact
      sha256 = [string]$Item.hash
      purl = "pkg:generic/$($Item.id)@$($Item.version)"
      licenses = @('LicenseRef-Fixture')
    }
  }
  $PolicyPath = Join-Path $Evidence 'external-components.json'
  Write-Json $PolicyPath ([ordered]@{
    schema = 'steel.release-external-components.v1'
    approved = $true
    components = $PolicyRows
  })
  $PolicyHash = Get-Hash $PolicyPath

  $BundleManifestPath = Join-Path $Evidence 'bundle-toolchain-manifest.json'
  Write-Json $BundleManifestPath ([ordered]@{
    components = @(
      [ordered]@{ id = 'wix'; version = '3.14.1' },
      [ordered]@{ id = 'nsis'; version = '3.10' },
      [ordered]@{ id = 'webview2-offline'; version = '126.0' }
    )
    files = @(
      [ordered]@{ component = 'wix'; path = 'wix/wix.zip'; sha256 = [string]$ExternalArtifacts['wix-toolset'].hash },
      [ordered]@{ component = 'nsis'; path = 'nsis/nsis.zip'; sha256 = [string]$ExternalArtifacts['nsis'].hash },
      [ordered]@{ component = 'webview2-offline'; path = 'webview2/webview2.exe'; sha256 = [string]$ExternalArtifacts['webview2-runtime'].hash }
    )
  })

  $LockDefinitions = @(
    [ordered]@{ id = 'npm-client'; source = 'app/client/package-lock.json'; evidence = 'build-evidence/client-package-lock.json' },
    [ordered]@{ id = 'cargo-tauri'; source = 'app/client/src-tauri/Cargo.lock'; evidence = 'build-evidence/tauri-Cargo.lock' },
    [ordered]@{ id = 'cargo-service'; source = 'app/service/Cargo.lock'; evidence = 'build-evidence/service-Cargo.lock' },
    [ordered]@{ id = 'cargo-trigger'; source = 'app/trigger/Cargo.lock'; evidence = 'build-evidence/trigger-Cargo.lock' },
    [ordered]@{ id = 'cargo-camera-worker'; source = 'app/camera-worker/Cargo.lock'; evidence = 'build-evidence/camera-worker-Cargo.lock' },
    [ordered]@{ id = 'cargo-result-contract'; source = 'app/result-contract/Cargo.lock'; evidence = 'build-evidence/result-contract-Cargo.lock' },
    [ordered]@{ id = 'cargo-pipeline-workers'; source = 'app/pipeline-workers/Cargo.lock'; evidence = 'build-evidence/pipeline-workers-Cargo.lock' },
    [ordered]@{ id = 'cargo-runtime-contract'; source = 'app/runtime-contract/Cargo.lock'; evidence = 'build-evidence/runtime-contract-Cargo.lock' },
    [ordered]@{ id = 'cargo-image-service'; source = 'app/image-service/Cargo.lock'; evidence = 'build-evidence/image-service-Cargo.lock' },
    [ordered]@{ id = 'cargo-algorithm-service'; source = 'app/algorithm-service/Cargo.lock'; evidence = 'build-evidence/algorithm-service-Cargo.lock' },
    [ordered]@{ id = 'cargo-server-monitor'; source = 'app/server-monitor/Cargo.lock'; evidence = 'build-evidence/server-monitor-Cargo.lock' },
    [ordered]@{ id = 'cargo-tray'; source = 'app/tray/Cargo.lock'; evidence = 'build-evidence/tray-Cargo.lock' }
  )
  $Locks = @()
  foreach ($Definition in $LockDefinitions) {
    $Path = Join-Path $Root (($Definition.evidence -replace '/', '\'))
    [System.IO.File]::WriteAllText($Path, "fixture-$($Definition.id)", [System.Text.UTF8Encoding]::new($false))
    $Locks += ,[ordered]@{
      id = [string]$Definition.id
      sourcePath = [string]$Definition.source
      evidencePath = [string]$Definition.evidence
      sha256 = Get-Hash $Path
    }
  }

  $ToolDefinitions = @(
    [ordered]@{ id = 'generate'; name = 'generate-release-sbom.ps1'; property = 'steel.tool.generate.sha256' },
    [ordered]@{ id = 'verify'; name = 'verify-release-sbom.ps1'; property = 'steel.tool.verify.sha256' },
    [ordered]@{ id = 'common'; name = 'release-sbom-common.ps1'; property = 'steel.tool.common.sha256' }
  )
  $Tools = @()
  foreach ($Definition in $ToolDefinitions) {
    $Source = Join-Path $PSScriptRoot ([string]$Definition.name)
    $Destination = Join-Path $ToolDir ([string]$Definition.name)
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
    $Tools += ,[ordered]@{
      id = [string]$Definition.id
      name = [string]$Definition.name
      path = "build-evidence/sbom-tools/$($Definition.name)"
      sha256 = Get-Hash $Destination
      metadataProperty = [string]$Definition.property
    }
  }

  $Timestamp = '2026-07-16T00:00:00.000Z'
  $Properties = @(
    (New-Property 'steel.sbom.schema' 'steel.release-sbom.cyclonedx.v1'),
    (New-Property 'steel.generator.version' '1.0.0'),
    (New-Property 'steel.source.gitCommit' $Commit),
    (New-Property 'steel.source.dirty' 'false'),
    (New-Property 'steel.source.commitTimestamp' $Timestamp)
  )
  foreach ($Lock in $Locks) {
    $Properties += ,(New-Property "steel.input.$($Lock.id).path" ([string]$Lock.sourcePath))
    $Properties += ,(New-Property "steel.input.$($Lock.id).sha256" ([string]$Lock.sha256))
  }
  $Properties += ,(New-Property 'steel.input.external-components.path' 'external:policy.json')
  $Properties += ,(New-Property 'steel.input.external-components.sha256' $PolicyHash)
  foreach ($Tool in $Tools) {
    $Properties += ,(New-Property ([string]$Tool.metadataProperty) ([string]$Tool.sha256))
  }
  $Properties += ,(New-Property 'steel.component.count.npm' '0')
  $Properties += ,(New-Property 'steel.component.count.cargo' '0')
  $Properties += ,(New-Property 'steel.component.count.external' '6')
  $Properties += ,(New-Property 'steel.component.count.total' '6')

  $Components = @()
  foreach ($Row in $PolicyRows) {
    $Components += ,[ordered]@{
      type = [string]$Row.type
      'bom-ref' = "external:$($Row.id)"
      supplier = [ordered]@{ name = [string]$Row.supplier }
      name = [string]$Row.name
      version = [string]$Row.version
      scope = 'required'
      hashes = @([ordered]@{ alg = 'SHA-256'; content = ([string]$Row.sha256).ToLowerInvariant() })
      purl = [string]$Row.purl
      properties = @(
        (New-Property 'steel.ecosystem' 'external'),
        (New-Property 'steel.external.category' ([string]$Row.category)),
        (New-Property 'steel.external.scope' ([string]$Row.scope)),
        (New-Property 'steel.external.artifact' ([string]$Row.artifact))
      )
    }
  }
  $Components = @($Components | Sort-Object { $_.'bom-ref' })
  $GitVersion = ((& git --version) | Out-String).Trim()
  $PowerShellVersion = $PSVersionTable.PSVersion.ToString()
  $InputHashes = @{}
  foreach ($Lock in $Locks) { $InputHashes[[string]$Lock.id] = [string]$Lock.sha256 }
  $InputHashes['external-components'] = $PolicyHash
  $InputSeed = (@($InputHashes.Keys | Sort-Object) | ForEach-Object { "$_`:$($InputHashes[$_])" }) -join '|'
  $ToolHashMap = @{}
  foreach ($Tool in $Tools) { $ToolHashMap[[string]$Tool.id] = [string]$Tool.sha256 }
  $Seed = @(
    $Commit, $InputSeed, "generator:$($ToolHashMap['generate'])", "verifier:$($ToolHashMap['verify'])",
    "common:$($ToolHashMap['common'])", "powershell:$PowerShellVersion", "git:$GitVersion",
    'schema:steel.release-sbom.cyclonedx.v1', 'generator-version:1.0.0'
  ) -join '|'
  $SerialHash = Get-TextHash $Seed
  $Uuid = $SerialHash.Substring(0, 32).ToCharArray()
  $Uuid[12] = '5'; $Uuid[16] = '8'; $Uuid = -join $Uuid
  $Serial = "urn:uuid:$($Uuid.Substring(0,8))-$($Uuid.Substring(8,4))-$($Uuid.Substring(12,4))-$($Uuid.Substring(16,4))-$($Uuid.Substring(20,12))"
  $RootRef = "application:fixture@1.2.3:$($Commit.Substring(0,12))"
  $SbomPath = Join-Path $Evidence 'steel-release-sbom.cdx.json'
  Write-Json $SbomPath ([ordered]@{
    '$schema' = 'http://cyclonedx.org/schema/bom-1.5.schema.json'
    bomFormat = 'CycloneDX'
    specVersion = '1.5'
    serialNumber = $Serial
    version = 1
    metadata = [ordered]@{
      timestamp = $Timestamp
      tools = [ordered]@{ components = @(
        [ordered]@{ type = 'application'; name = 'generate-release-sbom.ps1'; version = '1.0.0' },
        [ordered]@{ type = 'application'; name = 'PowerShell'; version = $PowerShellVersion },
        [ordered]@{ type = 'application'; name = 'Git'; version = $GitVersion }
      ) }
      component = [ordered]@{
        type = 'application'; 'bom-ref' = $RootRef; name = 'fixture'; version = '1.2.3'
        properties = @((New-Property 'steel.source.gitCommit' $Commit))
      }
      properties = $Properties
    }
    components = $Components
    dependencies = @([ordered]@{ ref = $RootRef; dependsOn = @($Components | ForEach-Object { [string]$_.'bom-ref' }) })
  })

  $ManifestPath = Join-Path $Root 'manifest.json'
  Write-Json $ManifestPath ([ordered]@{
    releaseVersion = '1.2.3'
    source = [ordered]@{ gitCommit = $Commit }
    capture = [ordered]@{ sdk = 'capture-headless/nvt_lvm_sdk.dll' }
    desktop = [ordered]@{ vcRuntimePrerequisite = 'desktop-installer/prerequisites/VC_redist.x64.exe' }
    build = [ordered]@{ bundleToolchain = [ordered]@{ path = 'build-evidence/bundle-toolchain-manifest.json' } }
    sbom = [ordered]@{
      schema = 'steel.release-sbom.cyclonedx.v1'; format = 'CycloneDX'; specVersion = '1.5'
      path = 'build-evidence/steel-release-sbom.cdx.json'; sha256 = Get-Hash $SbomPath
      sourceCommit = $Commit; dirty = $false; componentCount = 6; npmComponentCount = 0
      cargoComponentCount = 0; externalComponentCount = 6; metadataPropertyCount = 38
      dependencyLockCount = 12; toolCount = 3
      requiredExternalCategories = @('cpp-toolchain', 'camera-sdk', 'vc-runtime', 'webview2-runtime', 'wix-toolset', 'nsis')
      externalComponents = [ordered]@{
        path = 'build-evidence/external-components.json'; sha256 = $PolicyHash; sourceName = 'policy.json'
        schema = 'steel.release-external-components.v1'; approved = $true; componentCount = 6
      }
      dependencyLocks = $Locks
      tools = $Tools
    }
  })

  $ReportText = (& $Verifier -PackageDir $Root -ManifestPath $ManifestPath -ExpectedExternalComponentsSha256 $PolicyHash | Out-String)
  $Report = $ReportText | ConvertFrom-Json
  if ($Report.code -ne 0 -or [int]$Report.componentCount -ne 6 -or [int]$Report.categoryCount -ne 6) {
    throw 'Valid packaged formal SBOM fixture did not pass static verification.'
  }
  Add-Content -LiteralPath $SbomPath -Value ' ' -Encoding ASCII
  Assert-Rejected { & $Verifier -PackageDir $Root -ManifestPath $ManifestPath -ExpectedExternalComponentsSha256 $PolicyHash }

  [ordered]@{
    schema = 'steel.packaged-release-sbom-test.v1'
    code = 0
    formalPositive = 'passed'
    sbomTamperRejection = 'passed'
  } | ConvertTo-Json -Depth 4
} finally {
  $Resolved = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  if ($Resolved.StartsWith($TempBoundary + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -and
      [System.IO.Path]::GetFileName($Resolved).StartsWith('steel-packaged-sbom-test-', [System.StringComparison]::Ordinal)) {
    Remove-Item -LiteralPath $Resolved -Recurse -Force -ErrorAction SilentlyContinue
  }
}
