param(
  [int]$Port = 1432,
  [string]$HostName = "127.0.0.1",
  [string]$ClientRoot = "",
  [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"

function Resolve-DefaultClientRoot {
  $PackageClient = Join-Path $PSScriptRoot "client"
  if (Test-Path $PackageClient -PathType Container) {
    return (Resolve-Path $PackageClient).Path
  }

  $RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
  $RepoClient = Join-Path $RepoRoot "target\client\frontend-dist"
  if (Test-Path $RepoClient -PathType Container) {
    return (Resolve-Path $RepoClient).Path
  }

  return $RepoClient
}

function Get-ContentType {
  param([string]$Path)

  switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    ".html" { return "text/html; charset=utf-8" }
    ".js" { return "application/javascript; charset=utf-8" }
    ".mjs" { return "application/javascript; charset=utf-8" }
    ".css" { return "text/css; charset=utf-8" }
    ".json" { return "application/json; charset=utf-8" }
    ".svg" { return "image/svg+xml" }
    ".png" { return "image/png" }
    ".jpg" { return "image/jpeg" }
    ".jpeg" { return "image/jpeg" }
    ".ico" { return "image/x-icon" }
    ".wasm" { return "application/wasm" }
    default { return "application/octet-stream" }
  }
}

function Send-Text {
  param(
    [System.Net.HttpListenerResponse]$Response,
    [int]$StatusCode,
    [string]$Text
  )

  $Bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  $Response.StatusCode = $StatusCode
  $Response.ContentType = "text/plain; charset=utf-8"
  $Response.ContentLength64 = $Bytes.Length
  $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
}

if ([string]::IsNullOrWhiteSpace($ClientRoot)) {
  $ClientRoot = Resolve-DefaultClientRoot
}

if (-not (Test-Path $ClientRoot -PathType Container)) {
  throw "Missing client build directory: $ClientRoot. Run scripts/build-client.ps1 first."
}

$Root = (Resolve-Path $ClientRoot).Path
$IndexPath = Join-Path $Root "index.html"
if (-not (Test-Path $IndexPath -PathType Leaf)) {
  throw "Missing client index.html: $IndexPath"
}

$Prefix = "http://${HostName}:${Port}/"
$Listener = [System.Net.HttpListener]::new()
$Listener.Prefixes.Add($Prefix)
$Listener.Start()

Write-Host "Serving client from $Root"
Write-Host "Client URL: $Prefix"
Write-Host "Press Ctrl+C to stop."

if ($OpenBrowser) {
  Start-Process $Prefix | Out-Null
}

try {
  while ($Listener.IsListening) {
    $Context = $Listener.GetContext()
    $RequestPath = [System.Uri]::UnescapeDataString($Context.Request.Url.AbsolutePath.TrimStart("/"))
    $RequestPath = $RequestPath -replace "/", "\"
    if ([string]::IsNullOrWhiteSpace($RequestPath)) {
      $RequestPath = "index.html"
    }

    $Candidate = Join-Path $Root $RequestPath
    if (Test-Path $Candidate -PathType Container) {
      $Candidate = Join-Path $Candidate "index.html"
    }

    if (-not (Test-Path $Candidate -PathType Leaf)) {
      if ([System.IO.Path]::HasExtension($RequestPath)) {
        Send-Text $Context.Response 404 "Not found"
        $Context.Response.Close()
        continue
      }
      $Candidate = $IndexPath
    }

    $ResolvedCandidate = (Resolve-Path $Candidate).Path
    if (-not $ResolvedCandidate.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
      Send-Text $Context.Response 403 "Forbidden"
      $Context.Response.Close()
      continue
    }

    $Bytes = [System.IO.File]::ReadAllBytes($ResolvedCandidate)
    $Context.Response.StatusCode = 200
    $Context.Response.ContentType = Get-ContentType $ResolvedCandidate
    $Context.Response.ContentLength64 = $Bytes.Length
    $Context.Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
    $Context.Response.Close()
  }
} finally {
  if ($Listener.IsListening) {
    $Listener.Stop()
  }
  $Listener.Close()
}
