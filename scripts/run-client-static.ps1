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

function Resolve-HostAddress {
  param([string]$Name)

  if ([string]::IsNullOrWhiteSpace($Name) -or $Name -eq "localhost") {
    return [System.Net.IPAddress]::Parse("127.0.0.1")
  }

  $Address = $null
  if ([System.Net.IPAddress]::TryParse($Name, [ref]$Address)) {
    return $Address
  }

  $Addresses = [System.Net.Dns]::GetHostAddresses($Name)
  $Loopback = $Addresses | Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork } | Select-Object -First 1
  if ($Loopback) {
    return $Loopback
  }

  throw "Could not resolve host address: $Name"
}

function Write-HttpResponse {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [int]$StatusCode,
    [string]$Reason,
    [string]$ContentType,
    [byte[]]$Body,
    [switch]$HeadOnly
  )

  $Headers = @(
    "HTTP/1.1 $StatusCode $Reason",
    "Content-Type: $ContentType",
    "Content-Length: $($Body.Length)",
    "Connection: close",
    "Cache-Control: no-cache",
    "Access-Control-Allow-Origin: *",
    "",
    ""
  ) -join "`r`n"

  $HeaderBytes = [System.Text.Encoding]::ASCII.GetBytes($Headers)
  $Stream.Write($HeaderBytes, 0, $HeaderBytes.Length)
  if (-not $HeadOnly -and $Body.Length -gt 0) {
    $Stream.Write($Body, 0, $Body.Length)
  }
}

function Send-Text {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [int]$StatusCode,
    [string]$Reason,
    [string]$Text,
    [switch]$HeadOnly
  )

  $Bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  Write-HttpResponse -Stream $Stream -StatusCode $StatusCode -Reason $Reason -ContentType "text/plain; charset=utf-8" -Body $Bytes -HeadOnly:$HeadOnly
}

function Resolve-RequestedFile {
  param(
    [string]$Root,
    [string]$IndexPath,
    [string]$RequestTarget
  )

  $PathOnly = ($RequestTarget -split "\?", 2)[0]
  $RequestPath = [System.Uri]::UnescapeDataString($PathOnly.TrimStart("/"))
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
      return @{ Status = 404; Path = $null }
    }
    $Candidate = $IndexPath
  }

  $ResolvedCandidate = (Resolve-Path $Candidate).Path
  $RootWithSeparator = $Root.TrimEnd("\") + "\"
  if ($ResolvedCandidate -ne $Root -and -not $ResolvedCandidate.StartsWith($RootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) {
    return @{ Status = 403; Path = $null }
  }

  return @{ Status = 200; Path = $ResolvedCandidate }
}

function Handle-Client {
  param(
    [System.Net.Sockets.TcpClient]$Client,
    [string]$Root,
    [string]$IndexPath
  )

  try {
    $Stream = $Client.GetStream()
    $Stream.ReadTimeout = 5000
    $Reader = [System.IO.StreamReader]::new($Stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
    $RequestLine = $Reader.ReadLine()
    if ([string]::IsNullOrWhiteSpace($RequestLine)) {
      return
    }

    do {
      $HeaderLine = $Reader.ReadLine()
    } while ($null -ne $HeaderLine -and $HeaderLine.Length -gt 0)

    $Parts = $RequestLine.Split(" ")
    if ($Parts.Length -lt 2) {
      Send-Text -Stream $Stream -StatusCode 400 -Reason "Bad Request" -Text "Bad request"
      return
    }

    $Method = $Parts[0].ToUpperInvariant()
    if ($Method -ne "GET" -and $Method -ne "HEAD") {
      Send-Text -Stream $Stream -StatusCode 405 -Reason "Method Not Allowed" -Text "Method not allowed"
      return
    }

    $Resolved = Resolve-RequestedFile -Root $Root -IndexPath $IndexPath -RequestTarget $Parts[1]
    if ($Resolved.Status -eq 403) {
      Send-Text -Stream $Stream -StatusCode 403 -Reason "Forbidden" -Text "Forbidden" -HeadOnly:($Method -eq "HEAD")
      return
    }
    if ($Resolved.Status -eq 404) {
      Send-Text -Stream $Stream -StatusCode 404 -Reason "Not Found" -Text "Not found" -HeadOnly:($Method -eq "HEAD")
      return
    }

    $Bytes = [System.IO.File]::ReadAllBytes([string]$Resolved.Path)
    Write-HttpResponse -Stream $Stream -StatusCode 200 -Reason "OK" -ContentType (Get-ContentType ([string]$Resolved.Path)) -Body $Bytes -HeadOnly:($Method -eq "HEAD")
  } finally {
    $Client.Dispose()
  }
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

$Address = Resolve-HostAddress $HostName
$Listener = [System.Net.Sockets.TcpListener]::new($Address, $Port)
$Listener.Start()
$ClientUrl = "http://${HostName}:${Port}/"

Write-Host "Serving client from $Root"
Write-Host "Client URL: $ClientUrl"
Write-Host "Press Ctrl+C to stop."

if ($OpenBrowser) {
  Start-Process $ClientUrl | Out-Null
}

try {
  while ($true) {
    $Client = $Listener.AcceptTcpClient()
    Handle-Client -Client $Client -Root $Root -IndexPath $IndexPath
  }
} finally {
  $Listener.Stop()
}
