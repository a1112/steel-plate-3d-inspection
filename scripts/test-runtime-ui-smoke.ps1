param(
  [string]$ClientOrigin = "http://127.0.0.1:1432/?app=terminal",
  [string]$OutputDir = "",
  [string]$BrowserPath = "",
  [int]$TimeoutSec = 30,
  [int]$ViewportWidth = 1882,
  [int]$ViewportHeight = 994,
  [switch]$ExpectBkv,
  [switch]$TerminalOnly,
  [switch]$HistoryOnly
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
const terminalOnly = process.env.STEEL_UI_SMOKE_TERMINAL_ONLY === '1';
const historyOnly = process.env.STEEL_UI_SMOKE_HISTORY_ONLY === '1';

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

  async function wheel(selector, { deltaX = 0, deltaY = 0, ctrlKey = false } = {}) {
    const selectorJson = JSON.stringify(selector);
    await waitForExpression(`!!document.querySelector(${selectorJson})`);
    const point = await evaluate(`(async () => {
      const target = document.querySelector(${selectorJson});
      const measure = () => {
        const bounds = target.getBoundingClientRect();
        const left = Math.max(0, bounds.left);
        const top = Math.max(0, bounds.top);
        const right = Math.min(window.innerWidth, bounds.right);
        const bottom = Math.min(window.innerHeight, bounds.bottom);
        return { bounds, left, top, right, bottom };
      };
      let visible = measure();
      if (visible.right - visible.left < 2 || visible.bottom - visible.top < 2) {
        target.scrollIntoView({ block: 'center', inline: 'center' });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        visible = measure();
      }
      const x = visible.left + (visible.right - visible.left) / 2;
      const y = visible.top + (visible.bottom - visible.top) / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        intersection: {
          left: visible.left,
          top: visible.top,
          right: visible.right,
          bottom: visible.bottom,
        },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        insideTarget: x >= visible.bounds.left && x <= visible.bounds.right
          && y >= visible.bounds.top && y <= visible.bounds.bottom,
        insideViewport: x >= 0 && x < window.innerWidth && y >= 0 && y < window.innerHeight,
        hitTarget: hit === target || target.contains(hit),
      };
    })()`);
    const intersectionWidth = point.intersection.right - point.intersection.left;
    const intersectionHeight = point.intersection.bottom - point.intersection.top;
    if (intersectionWidth < 2 || intersectionHeight < 2
      || !point.insideTarget || !point.insideViewport || !point.hitTarget) {
      throw new Error(`Wheel target is not visibly hittable: ${JSON.stringify(point)}`);
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX,
      deltaY,
      modifiers: ctrlKey ? 2 : 0,
    }, sessionId);
    return point;
  }

  return { sessionId, evaluate, waitForExpression, waitForText, navigate, screenshot, click, wheel };
}

async function runUnifiedOnlineModeChecks(page, result) {
  async function requireEventually(id, expression) {
    try {
      const value = await page.waitForExpression(expression);
      result.checks.push({ kind: 'interaction', id, ok: true, value });
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.checks.push({
        kind: 'interaction',
        id,
        ok: false,
        error: message.startsWith('Timed out waiting for expression:')
          ? 'condition not met before interaction timeout'
          : message.slice(0, 240),
      });
      throw error;
    }
  }

  result.interactionScreenshots = [];

  const inspection = await requireEventually(
    'online-crop-stitch-horizontal-and-footer-entry',
    "(() => { const topLabels = [...document.querySelectorAll('.top-nav button')].map((button) => button.textContent.trim()); const footerButton = document.querySelector('.app-footer-online-workspace'); const viewport = document.querySelector('[data-testid=capture-stitch-viewport]'); const frameCount = Number(viewport?.dataset.frameCount || 0); const laneCount = document.querySelectorAll('.bar-camera-band').length; const frameCells = document.querySelectorAll('.bar-camera-frame').length; const paintedCanvases = [...document.querySelectorAll('.bar-camera-frame canvas')].filter((canvas) => canvas.width > 0 && canvas.height > 0).length; const value = { topLabels, footerLabel: footerButton?.textContent.trim(), footerPressed: footerButton?.getAttribute('aria-pressed'), frameCount, laneCount, frameCells, paintedCanvases, axis: viewport?.dataset.scrollAxis, scrollWidth: viewport?.scrollWidth, clientWidth: viewport?.clientWidth }; return topLabels.filter((label) => label === '\u5728\u7ebf\u76d1\u6d4b').length === 1 && !document.querySelector('.online-workspace-tabs') && footerButton?.textContent.includes('\u5b9e\u65f6/\u56de\u653e') && footerButton.getAttribute('aria-pressed') === 'false' && document.querySelector('.online-workspace') && !document.querySelector('.live-monitor-page') && viewport?.dataset.scrollAxis === 'x' && frameCount > 1 && laneCount === 6 && frameCells > laneCount && frameCells < frameCount * laneCount && paintedCanvases > 0 && viewport.scrollWidth > viewport.clientWidth ? value : false; })()",
  );
  result.interactionScreenshots.push(await page.screenshot('online-monitoring-inspection'));

  await page.evaluate("(() => { const viewport = document.querySelector('[data-testid=capture-stitch-viewport]'); viewport.scrollLeft = Math.min(viewport.scrollWidth - viewport.clientWidth, viewport.scrollWidth * 0.27); viewport.dispatchEvent(new Event('scroll')); return true; })()");
  await requireEventually(
    'crop-stitch-renders-content-bearing-cropped-frames',
    "(() => { const viewport = document.querySelector('[data-testid=capture-stitch-viewport]'); const canvases = [...document.querySelectorAll('.bar-camera-frame.has-production-image canvas')].filter((canvas) => canvas.width > 0 && canvas.height > 0); const readyCanvases = canvases.filter((canvas) => canvas.dataset.renderState === 'ready'); const loadingCanvases = canvases.filter((canvas) => !canvas.dataset.renderState || canvas.dataset.renderState === 'loading'); const errorCanvases = canvases.filter((canvas) => canvas.dataset.renderState === 'error'); const invalidEdgePolicies = canvases.filter((canvas) => !['source-roi', 'guarded-auto-crop'].includes(canvas.dataset.edgePolicy || '')); const brightCanvases = readyCanvases.filter((canvas) => { try { const context = canvas.getContext('2d'); const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; const stride = Math.max(4, Math.floor(pixels.length / 800 / 4) * 4); for (let offset = 0; offset < pixels.length; offset += stride) { if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 40) return true; } } catch {} return false; }); const start = Number(viewport?.dataset.visibleFrameStart || 0); const readyRatio = canvases.length > 0 ? readyCanvases.length / canvases.length : 0; return viewport && start > 0 && readyRatio >= 0.9 && errorCanvases.length === 0 && invalidEdgePolicies.length === 0 && brightCanvases.length >= 6 ? { scrollLeft: viewport.scrollLeft, visibleFrameStart: start, visibleFrameEnd: Number(viewport.dataset.visibleFrameEnd || 0), paintedCanvases: canvases.length, readyCanvases: readyCanvases.length, loadingCanvases: loadingCanvases.length, errorCanvases: errorCanvases.length, readyRatio, brightCanvases: brightCanvases.length, invalidEdgePolicies: invalidEdgePolicies.length } : false; })()",
  );
  result.interactionScreenshots.push(await page.screenshot('online-monitoring-inspection-content'));

  await page.evaluate("(() => { const viewport = document.querySelector('[data-testid=capture-stitch-viewport]'); viewport.scrollLeft = Math.max(1, viewport.scrollWidth - viewport.clientWidth); viewport.dispatchEvent(new Event('scroll')); return true; })()");
  await requireEventually(
    'crop-stitch-scrolls-to-later-virtual-frames',
    "(() => { const viewport = document.querySelector('[data-testid=capture-stitch-viewport]'); const start = Number(viewport?.dataset.visibleFrameStart || 0); return viewport && viewport.scrollLeft > 0 && start > 0 && document.querySelectorAll('.bar-camera-frame').length > 0 ? { scrollLeft: viewport.scrollLeft, visibleFrameStart: start, visibleFrameEnd: Number(viewport.dataset.visibleFrameEnd || 0) } : false; })()",
  );
  result.interactionScreenshots.push(await page.screenshot('online-monitoring-inspection-scrolled'));

  await page.click('.unfold-orientation-switch button:nth-child(2)');
  await requireEventually(
    'crop-stitch-switches-to-vertical-scroll',
    "(() => { const viewport = document.querySelector('[data-testid=capture-stitch-viewport]'); return viewport?.dataset.scrollAxis === 'y' && viewport.scrollHeight > viewport.clientHeight ? { axis: viewport.dataset.scrollAxis, scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight } : false; })()",
  );
  result.interactionScreenshots.push(await page.screenshot('online-monitoring-inspection-vertical'));
  await page.click('.unfold-orientation-switch button:first-child');

  const recordTarget = await page.evaluate("(() => { const rows = [...document.querySelectorAll('.records-table tbody tr')]; const candidates = rows.filter((row) => !row.classList.contains('selected') && row.children.length >= 4); const target = candidates.find((row) => row.children[1]?.textContent.trim() === '3837') || candidates.find((row) => row.textContent.includes('\u5df2\u5b8c\u6210')) || candidates[0]; if (!target) return null; const plateNo = target.children[1].textContent.trim(); target.click(); return plateNo; })()");
  if (recordTarget) {
    await requireEventually(
      'record-switch-rebinds-crop-stitch',
      `(() => { const plateNo = document.querySelector('.plate-info-list dd')?.textContent.trim(); const viewport = document.querySelector('[data-testid=capture-stitch-viewport]'); const frameCount = Number(viewport?.dataset.frameCount || 0); const contentAnchorFrame = Number(viewport?.dataset.contentAnchorFrame || 0); const visibleFrameStart = Number(viewport?.dataset.visibleFrameStart || 0); const visibleFrameEnd = Number(viewport?.dataset.visibleFrameEnd || 0); const canvases = [...document.querySelectorAll('.bar-camera-frame.has-production-image canvas')].filter((canvas) => canvas.width > 0 && canvas.height > 0); const readyCanvases = canvases.filter((canvas) => canvas.dataset.renderState === 'ready'); const errorCanvases = canvases.filter((canvas) => canvas.dataset.renderState === 'error'); const brightCanvases = readyCanvases.filter((canvas) => { try { const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; const stride = Math.max(4, Math.floor(pixels.length / 800 / 4) * 4); for (let offset = 0; offset < pixels.length; offset += stride) { if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 40) return true; } } catch {} return false; }); const brightCameraIds = [...new Set(brightCanvases.map((canvas) => canvas.closest('.bar-camera-frame')?.dataset.cameraId).filter(Boolean))]; const anchorVisible = visibleFrameStart <= contentAnchorFrame && visibleFrameEnd > contentAnchorFrame; return plateNo === ${JSON.stringify(recordTarget)} && frameCount > 1 && anchorVisible && brightCameraIds.length === 6 && errorCanvases.length === 0 ? { plateNo, frameCount, scrollLeft: viewport.scrollLeft, contentAnchorFrame, visibleFrameStart, visibleFrameEnd, readyCanvases: readyCanvases.length, brightCanvases: brightCanvases.length, brightCameraIds, errorCanvases: errorCanvases.length } : false; })()`,
    );
    result.interactionScreenshots.push(await page.screenshot('online-monitoring-record-switched'));
  }

  if (historyOnly) {
    return { inspection, historyOnly: true };
  }

  await page.click('.app-footer-online-workspace');
  const live = await requireEventually(
    'online-monitoring-camera-live-mode-valid-region-only',
    "(() => { const footerButton = document.querySelector('.app-footer-online-workspace'); const monitorTabs = [...document.querySelectorAll('.live-monitor-mode-tabs [role=tab]')]; const cards = [...document.querySelectorAll('.live-monitor-grid-card')]; const cardImages = cards.map((card) => [...card.querySelectorAll('img:not([aria-hidden=\"true\"])')].filter((image) => image.naturalWidth > 0 && image.naturalHeight > 0)); const visibleImages = cardImages.flat(); const urls = visibleImages.map((image) => image.currentSrc || image.src).filter((value) => value && value.includes('/api/stream/latest')); const parsedUrls = urls.map((value) => new URL(value, location.href)); const invalidUrls = parsedUrls.filter((url) => url.searchParams.get('region') !== 'valid' || url.searchParams.get('region') === 'raw'); const uniqueIps = [...new Set(parsedUrls.map((url) => url.searchParams.get('ip')).filter(Boolean))]; const hiddenPreloads = cards.reduce((total, card) => total + card.querySelectorAll('img[aria-hidden=\"true\"]').length, 0); const value = { footerLabel: footerButton?.textContent.trim(), monitorModes: monitorTabs.map((button) => ({ label: button.textContent.trim(), selected: button.getAttribute('aria-selected') })), cards: cards.length, visibleImages: visibleImages.length, hiddenPreloads, urls, uniqueIps, invalidUrls: invalidUrls.map((url) => url.href) }; return footerButton?.textContent.includes('\u8fd4\u56de\u68c0\u6d4b') && footerButton.getAttribute('aria-pressed') === 'true' && document.querySelector('.live-monitor-page') && monitorTabs.length === 2 && monitorTabs[0].textContent.includes('\u5b9e\u65f6') && monitorTabs[0].getAttribute('aria-selected') === 'true' && monitorTabs[1].textContent.includes('\u56de\u653e') && cards.length === 6 && cardImages.every((images) => images.length === 1) && visibleImages.length === 6 && urls.length === 6 && uniqueIps.length === 6 && invalidUrls.length === 0 ? value : false; })()",
  );
  result.interactionScreenshots.push(await page.screenshot('online-monitoring-camera-live'));

  await page.click('.live-monitor-mode-tabs button:nth-child(2)');
  const playback = await requireEventually(
    'online-monitoring-playback-mode-valid-roi-only',
    "(() => { const monitorTabs = [...document.querySelectorAll('.live-monitor-mode-tabs [role=tab]')]; const images = [...document.querySelectorAll('.capture-playback-grid img')]; const urls = images.map((image) => image.currentSrc || image.src).filter(Boolean); const invalidUrls = urls.filter((value) => { const url = new URL(value, location.href); return !url.pathname.endsWith('/api/capture/file') || url.searchParams.get('region') !== 'valid' || Number(url.searchParams.get('cropWidth')) <= 0 || Number(url.searchParams.get('cropHeight')) <= 0 || url.searchParams.get('region') === 'raw'; }); const value = { monitorModes: monitorTabs.map((button) => ({ label: button.textContent.trim(), selected: button.getAttribute('aria-selected') })), images: images.length, urls, invalidUrls }; return document.querySelector('.capture-playback') && monitorTabs.length === 2 && monitorTabs[1].textContent.includes('\u56de\u653e') && monitorTabs[1].getAttribute('aria-selected') === 'true' && images.length > 0 && invalidUrls.length === 0 ? value : false; })()",
  );
  result.interactionScreenshots.push(await page.screenshot('online-monitoring-playback'));

  await page.click('.live-monitor-mode-tabs button:first-child');
  await requireEventually(
    'returns-from-playback-to-camera-live',
    "(() => { const tabs = [...document.querySelectorAll('.live-monitor-mode-tabs [role=tab]')]; return tabs.length === 2 && tabs[0].getAttribute('aria-selected') === 'true' && document.querySelector('.live-monitor-camera-grid') ? { live: true, cards: document.querySelectorAll('.live-monitor-grid-card').length } : false; })()",
  );

  await page.click('.app-footer-online-workspace');
  await requireEventually(
    'returns-to-inspection-results-through-footer',
    "(() => { const topLabels = [...document.querySelectorAll('.top-nav button')].map((button) => button.textContent.trim()); const footerButton = document.querySelector('.app-footer-online-workspace'); return topLabels.filter((label) => label === '\u5728\u7ebf\u76d1\u6d4b').length === 1 && !document.querySelector('.online-workspace-tabs') && footerButton?.textContent.includes('\u5b9e\u65f6/\u56de\u653e') && footerButton.getAttribute('aria-pressed') === 'false' && document.querySelector('.online-workspace') && !document.querySelector('.live-monitor-page') ? { inspection: true, topLabels } : false; })()",
  );

  return { inspection, live, playback };
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

    if (check.closeClickSelector) {
      await page.click(check.closeClickSelector);
      result.checks.push({ kind: 'close', selector: check.closeClickSelector, ok: true });
    }

    if (check.runInteraction) {
      await check.runInteraction(page, result);
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
    requiredText: ['\u5317\u6ee1\u7279\u94a2\u5c0f\u68d2\u68c0\u6d4b\u7cfb\u7edf', '\u5728\u7ebf\u76d1\u6d4b', '\u5b9e\u65f6/\u56de\u653e', '\u7f3a\u9677\u62a5\u8868'],
    clickSelector: '[data-testid="receiver-status-button"]',
    closeClickSelector: '[data-testid="receiver-status-button"]',
    afterClickText: ['\u62a5\u7ea7\u5668\u7f51\u53e3\u8be6\u7ec6\u4fe1\u606f', '\u5b9e\u65f6\u4e0a\u4f20', '\u5b9e\u65f6\u4e0b\u8f7d', '\u5e26\u5bbd\u76d1\u63a7', 'Windows \u7f51\u5361\u5b9e\u65f6\u6536\u53d1\u901f\u7387'],
    requiredExpressions: [
      '(() => { const text = document.body ? document.body.innerText : ""; return text.includes("Windows \u7f51\u5361\u5b9e\u65f6\u6536\u53d1\u901f\u7387") && !text.includes("network monitor pending") && !text.includes("network monitor offline") && !text.includes("/api/system/network \u79bb\u7ebf") && !text.includes("\u672a\u53d1\u73b0\u7f51\u5361") && !text.includes("\u4f30\u7b97\u7f51\u901f"); })()',
      `(() => {
        const text = document.body?.innerText || '';
        return text.includes('\u76f8\u673a\u72b6\u6001')
          && text.includes('\u63a7\u5236')
          && text.includes('3/3')
          && (${historyOnly ? 'true' : 'false'} || (text.includes('6/6') && !text.includes('\u670d\u52a1\u5f02\u5e38')));
      })()`,
    ],
    runInteraction: runUnifiedOnlineModeChecks,
  },
  {
    id: 'capture',
    url: appUrl('capture'),
    requiredText: ['\u91c7\u96c6\u7ba1\u7406', '\u72b6\u6001\u603b\u89c8', '\u914d\u7f6e\u4e2d\u5fc3', '\u65e5\u5fd7\u8bb0\u5f55', 'API \u7ba1\u7406'],
    requiredExpressions: [
      `(() => {
        const text = document.body?.innerText || '';
        const cards = [...document.querySelectorAll('.capture-camera-card')];
        const sickReady = text.includes('\u5728\u7ebf\u76f8\u673a')
          && text.includes('6/6')
          && cards.length === 6
          && cards.every((card) => card.innerText.includes('Ranger3-60'))
          && cards.every((card) => !card.innerText.includes('192.168.107.100'))
          && text.includes('SICK GenTL Producer via Harvesters')
          && text.includes('GigE Vision / GenTL')
          && !text.includes('LVM/NVT 3D Camera SDK');
        const legacyReady = text.includes('8/8')
          && cards.length === 8
          && cards.every((card) => card.innerText.includes('LVM'))
          && !text.includes('capture service pending');
        return sickReady || legacyReady;
      })()`,
    ],
  },
  {
    id: 'bar-surface',
    url: appUrl('bar-surface'),
    requiredText: ['\u5317\u6ee1\u7279\u94a2\u5c0f\u68d2\u68c0\u6d4b\u7cfb\u7edf'],
    requiredExpressions: [
      `(() => {
        const text = document.body?.innerText || '';
        const unsupported = text.includes('\u5f53\u524d\u8fd0\u884c\u6a21\u5f0f\u4e0d\u652f\u63013D \u91cd\u5efa');
        const workbench = text.includes('3D \u91cd\u5efa\u5de5\u4f5c\u53f0') && text.includes('\u5207\u9762');
        const runtimeReady = text.includes('\u76f8\u673a\u72b6\u6001')
          && text.includes('6/6')
          && text.includes('\u63a7\u5236')
          && text.includes('3/3')
          && !text.includes('\u670d\u52a1\u5f02\u5e38');
        return runtimeReady && (unsupported || workbench);
      })()`,
    ],
  },
];

const bkvChecks = [
  {
    id: 'bkv-unified-inspection-world',
    url: appUrl('terminal'),
    requiredText: ['BKV \u79bb\u7ebf\u56de\u653e', '6/6 \u79bb\u7ebf\u6570\u636e', '\u5728\u7ebf\u76d1\u6d4b', '\u68c0\u6d4b\u7ed3\u679c'],
    requiredExpressions: [
      'document.querySelectorAll(".online-workspace").length === 1',
      'document.querySelectorAll(".online-workspace-tabs [role=tab]").length === 2',
      'document.querySelector(".runtime-bkv-workspace") !== null',
      'document.querySelectorAll("[data-testid=inspection-world-canvas]").length === 1',
      'document.querySelectorAll("[data-testid=inspection-world-camera]").length === 6',
      'Number(document.querySelector("[data-testid=inspection-world-canvas]")?.getAttribute("data-loaded-tiles")) > 0',
      'document.querySelector(".bkv-app-shell") === null && document.querySelector(".bkv-view-tabs") === null && document.querySelector(".bkv-visual-panel") === null',
    ],
  },
];

const checks = expectBkv ? bkvChecks : terminalOnly ? standardChecks.slice(0, 1) : standardChecks;

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
  $env:STEEL_UI_SMOKE_TERMINAL_ONLY = if ($TerminalOnly) { "1" } else { "0" }
  $env:STEEL_UI_SMOKE_HISTORY_ONLY = if ($HistoryOnly) { "1" } else { "0" }

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
  Remove-Item Env:\STEEL_UI_SMOKE_EXPECT_BKV -ErrorAction SilentlyContinue
  Remove-Item Env:\STEEL_UI_SMOKE_TERMINAL_ONLY -ErrorAction SilentlyContinue
  Remove-Item Env:\STEEL_UI_SMOKE_HISTORY_ONLY -ErrorAction SilentlyContinue

  if ($BrowserProcess -and -not $BrowserProcess.HasExited) {
    Stop-Process -Id $BrowserProcess.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 300
  Remove-TempProfile $UserDataDir
}
