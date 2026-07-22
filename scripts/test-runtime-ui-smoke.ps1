param(
  [string]$ClientOrigin = "http://127.0.0.1:1432/?app=terminal",
  [string]$OutputDir = "",
  [string]$BrowserPath = "",
  [int]$TimeoutSec = 30,
  [int]$ViewportWidth = 1882,
  [int]$ViewportHeight = 994,
  [switch]$ExpectBkv
)

$ErrorActionPreference = "Stop"
$ScriptRoot = (Resolve-Path $PSScriptRoot).Path
$SourceMode = Test-Path (Join-Path $ScriptRoot "package-runtime.ps1") -PathType Leaf
$RepoRoot = if ($SourceMode) {
  (Resolve-Path (Join-Path $ScriptRoot "..")).Path
} else {
  $ScriptRoot
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = if ($SourceMode) {
    Join-Path $RepoRoot "target\logs\ui-smoke"
  } else {
    Join-Path $RepoRoot "logs\ui-smoke"
  }
}

$RunId = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$RunDir = Join-Path $OutputDir $RunId
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
$ReportPath = Join-Path $RunDir "ui-smoke-report.json"

function Get-FreeLocalPort {
  $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), 0)
  try {
    $Listener.Start()
    return $Listener.LocalEndpoint.Port
  } finally {
    $Listener.Stop()
  }
}

function Resolve-BrowserExecutable {
  param([string]$ExplicitPath)

  if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
    if (Test-Path $ExplicitPath -PathType Leaf) {
      return (Resolve-Path $ExplicitPath).Path
    }
    throw "BrowserPath does not exist: $ExplicitPath"
  }

  $Candidates = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  )
  foreach ($Candidate in $Candidates) {
    if (Test-Path $Candidate -PathType Leaf) {
      return (Resolve-Path $Candidate).Path
    }
  }
  throw "No supported browser executable found. Pass -BrowserPath to msedge.exe or chrome.exe."
}

function Wait-DevTools {
  param(
    [int]$Port,
    [int]$TimeoutSeconds
  )

  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      $Response = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
      if ($Response.webSocketDebuggerUrl) {
        return $Response
      }
    } catch {
      Start-Sleep -Milliseconds 300
    }
  } while ((Get-Date) -lt $Deadline)
  throw "Browser DevTools endpoint did not become ready on port $Port."
}

function Remove-TempProfile {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path $Path)) {
    return
  }
  $FullPath = [System.IO.Path]::GetFullPath($Path)
  $TempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if (-not $FullPath.StartsWith($TempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove browser profile outside temp root: $FullPath"
  }
  Remove-Item -LiteralPath $FullPath -Recurse -Force -ErrorAction SilentlyContinue
}

$BrowserExe = Resolve-BrowserExecutable $BrowserPath
$DebugPort = Get-FreeLocalPort
$UserDataDir = Join-Path ([System.IO.Path]::GetTempPath()) ("steel-ui-smoke-{0}" -f $RunId)
New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
$NodePath = Join-Path $RunDir "ui-smoke-runner.mjs"

$NodeScript = @'
import fs from 'node:fs/promises';
import path from 'node:path';

const debugPort = Number(process.env.STEEL_UI_SMOKE_DEBUG_PORT || 0);
const clientOrigin = process.env.STEEL_UI_SMOKE_CLIENT_ORIGIN || 'http://127.0.0.1:1432/?app=terminal';
const reportPath = process.env.STEEL_UI_SMOKE_REPORT_PATH;
const screenshotDir = process.env.STEEL_UI_SMOKE_SCREENSHOT_DIR;
const timeoutMs = Number(process.env.STEEL_UI_SMOKE_TIMEOUT_MS || 30000);
const viewportWidth = Number(process.env.STEEL_UI_SMOKE_VIEWPORT_WIDTH || 1882);
const viewportHeight = Number(process.env.STEEL_UI_SMOKE_VIEWPORT_HEIGHT || 994);
const expectBkv = process.env.STEEL_UI_SMOKE_EXPECT_BKV === '1';

function appUrl(app) {
  const url = new URL(clientOrigin);
  url.searchParams.set('app', app);
  return url.href;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWebSocket(url) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${url}`)), timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(ws);
    }, { once: true });
    ws.addEventListener('error', (event) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error connecting to ${url}: ${event.message || 'unknown'}`));
    }, { once: true });
  });
}

async function createCdpClient() {
  const version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((response) => response.json());
  const ws = await connectWebSocket(version.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const events = [];
  const waiters = [];

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        reject(new Error(`${message.error.message || 'CDP error'} (${message.method || message.id})`));
      } else {
        resolve(message.result || {});
      }
      return;
    }

    events.push(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter.predicate(message)) {
        waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });

  function send(method, params = {}, sessionId = undefined) {
    const id = nextId++;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(payload));
    });
  }

  function waitForEvent(predicate, timeout = timeoutMs) {
    const existing = events.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((item) => item.resolve === resolve);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
        reject(new Error('Timed out waiting for CDP event'));
      }, timeout);
      waiters.push({ predicate, resolve, reject, timer });
    });
  }

  async function close() {
    try {
      ws.close();
    } catch {
    }
  }

  return { send, waitForEvent, close };
}

async function createPage(cdp) {
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewportWidth,
    height: viewportHeight,
    deviceScaleFactor: 1,
    mobile: false,
  }, sessionId);

  async function evaluate(expression) {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
    }
    return result.result?.value;
  }

  async function waitForExpression(expression, timeout = timeoutMs) {
    const deadline = Date.now() + timeout;
    let lastValue = null;
    while (Date.now() < deadline) {
      lastValue = await evaluate(expression).catch(() => null);
      if (lastValue) {
        return lastValue;
      }
      await delay(250);
    }
    throw new Error(`Timed out waiting for expression: ${expression}; last=${String(lastValue)}`);
  }

  async function waitForText(requiredText, timeout = timeoutMs) {
    const required = Array.isArray(requiredText) ? requiredText : [requiredText];
    const deadline = Date.now() + timeout;
    let text = '';
    while (Date.now() < deadline) {
      text = await evaluate('document.body ? document.body.innerText : ""').catch(() => '');
      if (required.every((item) => text.includes(item))) {
        return text;
      }
      await delay(300);
    }
    throw new Error(`Timed out waiting for text: ${required.join(', ')}`);
  }

  async function navigate(url) {
    const loadPromise = cdp.waitForEvent((event) => event.sessionId === sessionId && event.method === 'Page.loadEventFired').catch(() => null);
    await cdp.send('Page.navigate', { url }, sessionId);
    await loadPromise;
    await waitForExpression('document.readyState === "complete"');
  }

  async function screenshot(name) {
    const captured = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    }, sessionId);
    const filePath = path.join(screenshotDir, `${name}.png`);
    await fs.writeFile(filePath, Buffer.from(captured.data, 'base64'));
    return filePath;
  }

  async function click(selector) {
    const selectorJson = JSON.stringify(selector);
    await waitForExpression(`!!document.querySelector(${selectorJson})`);
    await evaluate(`document.querySelector(${selectorJson}).click(); true`);
  }

  return { sessionId, evaluate, waitForExpression, waitForText, navigate, screenshot, click };
}

async function runPageCheck(page, check) {
  const startedAt = Date.now();
  const result = {
    id: check.id,
    url: check.url,
    ok: false,
    checks: [],
    screenshot: null,
    elapsedMs: 0,
    error: null,
  };

  try {
    await page.navigate(check.url);
    let text = await page.waitForText(check.requiredText);
    result.checks.push({ kind: 'text', required: check.requiredText, ok: true });

    if (check.clickSelector) {
      await page.click(check.clickSelector);
      text = await page.waitForText(check.afterClickText);
      result.checks.push({ kind: 'clickText', selector: check.clickSelector, required: check.afterClickText, ok: true });
    }

    for (const expression of check.requiredExpressions || []) {
      await page.waitForExpression(expression);
      result.checks.push({ kind: 'expression', expression, ok: true });
    }

    text = await page.evaluate('document.body ? document.body.innerText : ""');
    result.textSample = text.slice(0, 1200);
    result.screenshot = await page.screenshot(check.id);
    result.ok = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    try {
      result.screenshot = await page.screenshot(`${check.id}-failed`);
    } catch {
    }
  } finally {
    result.elapsedMs = Date.now() - startedAt;
  }

  return result;
}

const standardChecks = [
  {
    id: 'terminal',
    url: appUrl('terminal'),
    requiredText: ['\u94a2\u7ba13D\u8868\u9762\u68c0\u6d4b\u7cfb\u7edf', '\u5728\u7ebf\u68c0\u6d4b', '\u91c7\u96c6\u7ba1\u7406', '3D \u91cd\u5efa'],
    clickSelector: '[data-testid="receiver-status-button"]',
    afterClickText: ['\u62a5\u7ea7\u5668\u7f51\u53e3\u8be6\u7ec6\u4fe1\u606f', '\u5b9e\u65f6\u4e0a\u4f20', '\u5b9e\u65f6\u4e0b\u8f7d', '\u5e26\u5bbd\u76d1\u63a7', 'Windows \u7f51\u5361\u5b9e\u65f6\u6536\u53d1\u901f\u7387'],
    requiredExpressions: [
      '(() => { const text = document.body ? document.body.innerText : ""; return text.includes("Windows \u7f51\u5361\u5b9e\u65f6\u6536\u53d1\u901f\u7387") && !text.includes("network monitor pending") && !text.includes("network monitor offline") && !text.includes("/api/system/network \u79bb\u7ebf") && !text.includes("\u672a\u53d1\u73b0\u7f51\u5361") && !text.includes("\u4f30\u7b97\u7f51\u901f"); })()',
    ],
  },
  {
    id: 'capture',
    url: appUrl('capture'),
    requiredText: ['\u91c7\u96c6\u7ba1\u7406', '\u72b6\u6001\u603b\u89c8', '\u914d\u7f6e\u4e2d\u5fc3', '\u65e5\u5fd7\u8bb0\u5f55', 'API \u7ba1\u7406'],
  },
  {
    id: 'bar-surface',
    url: appUrl('bar-surface'),
    requiredText: ['3D \u91cd\u5efa\u5de5\u4f5c\u53f0', '\u516d\u76f8\u673a', '3D', '\u5207\u9762'],
    requiredExpressions: [
      'document.querySelector("canvas") !== null || document.body.innerText.includes("3D \u91cd\u5efa\u5de5\u4f5c\u53f0")',
    ],
  },
];

const bkvChecks = [
  {
    id: 'bkv-unwrapped',
    url: appUrl('terminal'),
    requiredText: ['BKV \u79bb\u7ebf\u56de\u653e', '6/6 \u79bb\u7ebf\u6570\u636e', '\u771f\u5b9e\u76f8\u673a\u5728\u7ebf 0', '\u786c\u4ef6\u63a7\u5236\u5df2\u7981\u7528'],
    clickSelector: '.bkv-view-tabs button:nth-child(2)',
    afterClickText: ['JIT \u5e73\u94fa\u5c55\u5f00', '\u672a\u6807\u5b9a\u9884\u89c8'],
    requiredExpressions: [
      'document.querySelector("img.bkv-unwrapped")?.naturalWidth > 0',
      '![...document.querySelectorAll("button")].some((button) => button.innerText.trim() === "\u8fde\u63a5\u76f8\u673a")',
    ],
  },
  {
    id: 'bkv-cylinder',
    url: appUrl('terminal'),
    requiredText: ['BKV \u79bb\u7ebf\u56de\u653e', '6/6 \u79bb\u7ebf\u6570\u636e', '\u771f\u5b9e\u76f8\u673a\u5728\u7ebf 0', '\u786c\u4ef6\u63a7\u5236\u5df2\u7981\u7528'],
    clickSelector: '.bkv-view-tabs button:nth-child(3)',
    afterClickText: ['\u5706\u67f1 3D', '\u672a\u6807\u5b9a\u9884\u89c8'],
    requiredExpressions: [
      'document.querySelectorAll(".bkv-camera-grid img").length === 0 && document.querySelector(".bkv-visual-panel canvas") !== null',
      '![...document.querySelectorAll("button")].some((button) => button.innerText.trim() === "\u8fde\u63a5\u76f8\u673a")',
    ],
  },
];

const checks = expectBkv ? bkvChecks : standardChecks;

await fs.mkdir(screenshotDir, { recursive: true });
const cdp = await createCdpClient();
const page = await createPage(cdp);
const pages = [];
try {
  for (const check of checks) {
    pages.push(await runPageCheck(page, check));
  }
} finally {
  await cdp.close();
}

const report = {
  schema: 'steel.runtime.ui-smoke.v1',
  code: pages.every((pageResult) => pageResult.ok) ? 0 : 1,
  checkedAt: new Date().toISOString(),
  clientOrigin,
  viewport: { width: viewportWidth, height: viewportHeight },
  pages,
  reportPath,
};
await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
if (report.code !== 0) {
  process.exit(1);
}
'@

Set-Content -LiteralPath $NodePath -Value $NodeScript -Encoding UTF8

$BrowserProcess = $null
try {
  $BrowserArgs = @(
    "--headless=new",
    "--remote-debugging-port=$DebugPort",
    "--user-data-dir=$UserDataDir",
    "--disable-gpu",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  )
  $BrowserProcess = Start-Process -FilePath $BrowserExe -ArgumentList $BrowserArgs -WindowStyle Hidden -PassThru
  $null = Wait-DevTools -Port $DebugPort -TimeoutSeconds $TimeoutSec

  $env:STEEL_UI_SMOKE_DEBUG_PORT = [string]$DebugPort
  $env:STEEL_UI_SMOKE_CLIENT_ORIGIN = $ClientOrigin
  $env:STEEL_UI_SMOKE_REPORT_PATH = $ReportPath
  $env:STEEL_UI_SMOKE_SCREENSHOT_DIR = $RunDir
  $env:STEEL_UI_SMOKE_TIMEOUT_MS = [string]($TimeoutSec * 1000)
  $env:STEEL_UI_SMOKE_VIEWPORT_WIDTH = [string]$ViewportWidth
  $env:STEEL_UI_SMOKE_VIEWPORT_HEIGHT = [string]$ViewportHeight
  $env:STEEL_UI_SMOKE_EXPECT_BKV = if ($ExpectBkv) { "1" } else { "0" }

  $Output = & node $NodePath 2>&1
  $ExitCode = $LASTEXITCODE
  $Output | ForEach-Object { [string]$_ }
  if ($ExitCode -ne 0) {
    throw "UI smoke failed with exit $ExitCode. Report: $ReportPath"
  }
} catch {
  if (-not (Test-Path $ReportPath -PathType Leaf)) {
    [ordered]@{
      schema = "steel.runtime.ui-smoke.v1"
      code = 1
      checkedAt = (Get-Date).ToString("o")
      clientOrigin = $ClientOrigin
      error = $_.Exception.Message
      reportPath = $ReportPath
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
  }
  Get-Content $ReportPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  exit 1
} finally {
  Remove-Item Env:\STEEL_UI_SMOKE_DEBUG_PORT -ErrorAction SilentlyContinue
  Remove-Item Env:\STEEL_UI_SMOKE_CLIENT_ORIGIN -ErrorAction SilentlyContinue
  Remove-Item Env:\STEEL_UI_SMOKE_REPORT_PATH -ErrorAction SilentlyContinue
  Remove-Item Env:\STEEL_UI_SMOKE_SCREENSHOT_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:\STEEL_UI_SMOKE_TIMEOUT_MS -ErrorAction SilentlyContinue
  Remove-Item Env:\STEEL_UI_SMOKE_VIEWPORT_WIDTH -ErrorAction SilentlyContinue
  Remove-Item Env:\STEEL_UI_SMOKE_VIEWPORT_HEIGHT -ErrorAction SilentlyContinue

  if ($BrowserProcess -and -not $BrowserProcess.HasExited) {
    Stop-Process -Id $BrowserProcess.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 300
  Remove-TempProfile $UserDataDir
}
