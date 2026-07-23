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

async function runBkvNativeScrollChecks(page, result) {
  const viewportSelector = '[data-testid="inspection-world-viewport"]';
  const canvasSelector = '[data-testid="inspection-world-canvas"]';

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

  async function performWheel(id, options) {
    try {
      const point = await page.wheel(canvasSelector, options);
      result.checks.push({ kind: 'interaction', id, ok: true, value: point });
      return point;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.checks.push({ kind: 'interaction', id, ok: false, error: message.slice(0, 240) });
      throw error;
    }
  }

  await requireEventually('bkv-footer-more-entry-visible', `(() => {
    const more = document.querySelector('button[aria-label="\u66f4\u591a\u529f\u80fd"]');
    return more ? { expanded: more.getAttribute('aria-expanded') } : false;
  })()`);
  await page.click('button[aria-label="\u66f4\u591a\u529f\u80fd"]');
  await requireEventually('bkv-offline-replay-entry-enabled', `(() => {
    const item = document.querySelector('[role="menuitem"]');
    return item && item.textContent.includes('\u79bb\u7ebf\u56de\u653e')
      && !item.disabled && item.getAttribute('aria-current') === 'page'
      ? { label: item.textContent.trim(), active: true }
      : false;
  })()`);
  await page.click('[role="menuitem"]');

  async function requireTileFetchQuiescence() {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    try {
      while (Date.now() < deadline) {
        const beforeFrames = await page.evaluate(`(() => {
          const probe = window.__steelInspectionTileFetchProbe;
          return probe ? { total: probe.total, pending: probe.pending } : null;
        })()`);
        if (beforeFrames?.pending === 0) {
          const afterFrames = await page.evaluate(`(async () => {
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const probe = window.__steelInspectionTileFetchProbe;
            return probe ? { total: probe.total, pending: probe.pending } : null;
          })()`);
          await delay(250);
          const afterInterval = await page.evaluate(`(() => {
            const probe = window.__steelInspectionTileFetchProbe;
            return probe ? { total: probe.total, pending: probe.pending } : null;
          })()`);
          last = { beforeFrames, afterFrames, afterInterval };
          if (afterFrames?.pending === 0
            && afterInterval?.pending === 0
            && beforeFrames.total === afterFrames.total
            && afterFrames.total === afterInterval.total) {
            await page.evaluate(`(() => {
              window.__steelInspectionTileFetchProbe.quiescentTotal = ${afterInterval.total};
              return true;
            })()`);
            result.checks.push({
              kind: 'interaction',
              id: 'deep-scroll-tile-fetches-quiescent',
              ok: true,
              value: { total: afterInterval.total, pending: 0, stableFrames: 2, stableIntervalMs: 250 },
            });
            return afterInterval;
          }
        }
        await delay(100);
      }
      throw new Error(`tile fetches did not become quiescent; last=${JSON.stringify(last)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.checks.push({
        kind: 'interaction',
        id: 'deep-scroll-tile-fetches-quiescent',
        ok: false,
        error: message.slice(0, 240),
      });
      throw error;
    }
  }

  await requireEventually('tile-fetch-probe-installed', `(() => {
    let probe = window.__steelInspectionTileFetchProbe;
    if (!probe) {
      const originalFetch = window.fetch;
      probe = {
        total: 0,
        pending: 0,
        counts: Object.create(null),
        originalFetch,
        wrappedFetch: null,
      };
      probe.wrappedFetch = function (...args) {
        const input = args[0];
        const url = typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input?.url || String(input);
        if (!url.includes('/api/inspection-world/tile')) {
          return Reflect.apply(probe.originalFetch, this, args);
        }
        probe.total += 1;
        probe.pending += 1;
        probe.counts[url] = (probe.counts[url] || 0) + 1;
        let response;
        try {
          response = Reflect.apply(probe.originalFetch, this, args);
        } catch (error) {
          probe.pending -= 1;
          throw error;
        }
        return Promise.resolve(response).finally(() => {
          probe.pending -= 1;
        });
      };
      window.__steelInspectionTileFetchProbe = probe;
    }
    if (window.fetch !== probe.wrappedFetch) window.fetch = probe.wrappedFetch;
    return window.fetch === probe.wrappedFetch
      ? { installed: true, total: probe.total, pending: probe.pending }
      : false;
  })()`);

  const initial = await requireEventually('native-scroll-initial-fit', `(() => {
    const viewport = document.querySelector(${JSON.stringify(viewportSelector)});
    const canvas = document.querySelector(${JSON.stringify(canvasSelector)});
    const spacer = document.querySelector('[data-testid="inspection-world-scroll-space"]');
    const cameras = [...document.querySelectorAll('[data-testid="inspection-world-camera"]')];
    const fetchProbe = window.__steelInspectionTileFetchProbe;
    if (!viewport || !canvas || !spacer || cameras.length !== 6 || !fetchProbe || fetchProbe.pending !== 0) return false;
    const canvasBounds = canvas.getBoundingClientRect();
    const firstBounds = cameras[0].getBoundingClientRect();
    const lastBounds = cameras[cameras.length - 1].getBoundingClientRect();
    const scale = Number(canvas.getAttribute('data-view-scale'));
    const tileResources = performance.getEntriesByType('resource')
      .filter((entry) => entry.name.includes('/api/inspection-world/tile'));
    const value = {
      record: canvas.getAttribute('aria-label'),
      selectValue: document.querySelector('.bkv-toolbar select')?.value || '',
      scrollMode: viewport.getAttribute('data-scroll-mode'),
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      scrollWidth: viewport.scrollWidth,
      scrollHeight: viewport.scrollHeight,
      clientWidth: viewport.clientWidth,
      clientHeight: viewport.clientHeight,
      spacerWidth: spacer.getBoundingClientRect().width,
      spacerHeight: spacer.getBoundingClientRect().height,
      scale,
      viewY: Number(canvas.getAttribute('data-view-y')),
      tileRequestBaseline: tileResources.length,
      tileRequestUniqueBaseline: [...new Set(tileResources.map((entry) => entry.name))],
      tileFetchBaseline: fetchProbe.total,
      tileFetchUniqueBaseline: Object.keys(fetchProbe.counts),
      camerasFit: Math.abs(firstBounds.left - canvasBounds.left) <= 2
        && Math.abs(lastBounds.right - canvasBounds.right) <= 2
        && cameras.every((camera) => {
          const bounds = camera.getBoundingClientRect();
          return bounds.left >= canvasBounds.left - 2 && bounds.right <= canvasBounds.right + 2;
        }),
    };
    window.__steelInspectionWorldSmoke = { initial: value };
    return value.scrollMode === 'native'
      && value.scrollHeight > value.clientHeight
      && value.scrollLeft === 0
      && value.scrollTop === 0
      && value.scrollWidth <= value.clientWidth + 2
      && value.spacerWidth <= value.clientWidth + 2
      && value.scale > 0
      && value.viewY === 0
      && value.camerasFit
      ? value
      : false;
  })()`);

  await page.evaluate(`(() => {
    window.__steelInspectionWorldSmoke.plainWheel = { defaultPrevented: null };
    document.addEventListener('wheel', (event) => {
      window.__steelInspectionWorldSmoke.plainWheel.defaultPrevented = event.defaultPrevented;
    }, { once: true });
    return true;
  })()`);
  await performWheel('plain-wheel-visible-target', { deltaY: 640 });
  const plainWheel = await requireEventually('plain-wheel-scrolls-without-zoom', `(() => {
    const viewport = document.querySelector(${JSON.stringify(viewportSelector)});
    const canvas = document.querySelector(${JSON.stringify(canvasSelector)});
    const smoke = window.__steelInspectionWorldSmoke;
    if (!viewport || !canvas || !smoke) return false;
    const value = {
      scrollTop: viewport.scrollTop,
      viewY: Number(canvas.getAttribute('data-view-y')),
      scale: Number(canvas.getAttribute('data-view-scale')),
      defaultPrevented: smoke.plainWheel?.defaultPrevented,
    };
    smoke.plainWheel = value;
    return value.scrollTop > 0
      && value.viewY > smoke.initial.viewY
      && Math.abs(value.scale - smoke.initial.scale) < 0.000001
      && value.defaultPrevented === false
      ? value
      : false;
  })()`);

  await page.evaluate(`(() => {
    const viewport = document.querySelector(${JSON.stringify(viewportSelector)});
    window.__steelInspectionWorldSmoke.ctrlWheel = {
      defaultPrevented: null,
      pageScrollY: window.scrollY,
      viewportScrollTop: viewport?.scrollTop ?? -1,
      visualScale: window.visualViewport?.scale ?? 1,
    };
    document.addEventListener('wheel', (event) => {
      window.__steelInspectionWorldSmoke.ctrlWheel.defaultPrevented = event.defaultPrevented;
    }, { once: true });
    return true;
  })()`);
  await performWheel('ctrl-wheel-visible-target', { deltaY: -420, ctrlKey: true });
  const ctrlWheel = await requireEventually('ctrl-wheel-zooms-without-page-navigation', `(() => {
    const viewport = document.querySelector(${JSON.stringify(viewportSelector)});
    const canvas = document.querySelector(${JSON.stringify(canvasSelector)});
    const smoke = window.__steelInspectionWorldSmoke;
    if (!viewport || !canvas || !smoke) return false;
    const value = {
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      scale: Number(canvas.getAttribute('data-view-scale')),
      loadedTiles: Number(canvas.getAttribute('data-loaded-tiles')),
      defaultPrevented: smoke.ctrlWheel?.defaultPrevented,
      pageScrollY: window.scrollY,
      visualScale: window.visualViewport?.scale ?? 1,
    };
    return value.scale > smoke.plainWheel.scale
      && value.loadedTiles > 0
      && value.defaultPrevented === true
      && value.pageScrollY === smoke.ctrlWheel.pageScrollY
      && value.visualScale === smoke.ctrlWheel.visualScale
      ? value
      : false;
  })()`);

  await page.evaluate(`(() => {
    const viewport = document.querySelector(${JSON.stringify(viewportSelector)});
    if (!viewport) return false;
    window.__steelInspectionWorldSmoke.beforeDeepViewY = Number(
      document.querySelector(${JSON.stringify(canvasSelector)})?.getAttribute('data-view-y') || 0
    );
    viewport.scrollTop = Math.floor((viewport.scrollHeight - viewport.clientHeight) * 0.78);
    viewport.dispatchEvent(new Event('scroll'));
    return true;
  })()`);
  await requireEventually('deep-scroll-position-loaded', `(() => {
    const canvas = document.querySelector(${JSON.stringify(canvasSelector)});
    if (!canvas) return false;
    const viewY = Number(canvas.getAttribute('data-view-y'));
    const loadedTiles = Number(canvas.getAttribute('data-loaded-tiles'));
    return viewY > window.__steelInspectionWorldSmoke.beforeDeepViewY && loadedTiles > 0
      ? { viewY, loadedTiles }
      : false;
  })()`);
  await requireTileFetchQuiescence();
  const deepScroll = await requireEventually('deep-scroll-keeps-tile-work-bounded', `(() => {
    const viewport = document.querySelector(${JSON.stringify(viewportSelector)});
    const canvas = document.querySelector(${JSON.stringify(canvasSelector)});
    const status = document.querySelector('.inspection-world-tile-status')?.textContent || '';
    const visibleMatch = status.match(/(\\d+)\\s*\u4e2a\u53ef\u89c1\u74e6\u7247/);
    if (!viewport || !canvas || !visibleMatch) return false;
    const tileResources = performance.getEntriesByType('resource')
      .filter((entry) => entry.name.includes('/api/inspection-world/tile'));
    const fetchProbe = window.__steelInspectionTileFetchProbe;
    if (!fetchProbe) return false;
    const requestedTiles = fetchProbe.total - window.__steelInspectionWorldSmoke.initial.tileFetchBaseline;
    const baselineFetchNames = new Set(window.__steelInspectionWorldSmoke.initial.tileFetchUniqueBaseline);
    const uniqueRequestedTiles = Object.keys(fetchProbe.counts)
      .filter((name) => !baselineFetchNames.has(name)).length;
    const completedResourceTiles = tileResources.length
      - window.__steelInspectionWorldSmoke.initial.tileRequestBaseline;
    const uniqueResourceNames = new Set(tileResources.map((entry) => entry.name));
    const baselineResourceNames = new Set(window.__steelInspectionWorldSmoke.initial.tileRequestUniqueBaseline);
    const uniqueCompletedResourceTiles = [...uniqueResourceNames]
      .filter((name) => !baselineResourceNames.has(name)).length;
    const visibleTiles = Number(visibleMatch[1]);
    const cachedTiles = Number(canvas.getAttribute('data-cached-tiles'));
    const requestBudget = Math.min(64, Math.max(24, (visibleTiles + cachedTiles) * 2));
    const value = {
      scrollTop: viewport.scrollTop,
      viewY: Number(canvas.getAttribute('data-view-y')),
      visibleTiles,
      loadedTiles: Number(canvas.getAttribute('data-loaded-tiles')),
      cachedTiles,
      requestedTiles,
      uniqueRequestedTiles,
      pendingTiles: fetchProbe.pending,
      completedResourceTiles,
      uniqueCompletedResourceTiles,
      requestBudget,
    };
    return value.viewY > window.__steelInspectionWorldSmoke.beforeDeepViewY
      && value.visibleTiles > 0 && value.visibleTiles < 126
      && value.loadedTiles > 0 && value.loadedTiles < 126
      && value.cachedTiles > 0 && value.cachedTiles < 126
      && value.requestedTiles > 0 && value.requestedTiles <= value.requestBudget
      && value.pendingTiles === 0
      && fetchProbe.total === fetchProbe.quiescentTotal
      ? value
      : false;
  })()`);
  // Additive diagnostic artifact: steel.runtime.ui-smoke.v1 consumers ignore unknown fields.
  result.interactionScreenshots = [await page.screenshot('bkv-2d-deep-scroll')];

  await page.evaluate(`(() => {
    const select = document.querySelector('.bkv-toolbar select');
    if (!select) return false;
    const firstValue = window.__steelInspectionWorldSmoke.initial.selectValue;
    const next = [...select.options].find((option) => option.value !== firstValue);
    if (!next) return false;
    select.value = next.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const switched = await requireEventually('record-switch-restores-top-fit-width', `(() => {
    const viewport = document.querySelector(${JSON.stringify(viewportSelector)});
    const canvas = document.querySelector(${JSON.stringify(canvasSelector)});
    const spacer = document.querySelector('[data-testid="inspection-world-scroll-space"]');
    const cameras = [...document.querySelectorAll('[data-testid="inspection-world-camera"]')];
    if (!viewport || !canvas || !spacer || cameras.length !== 6) return false;
    const canvasBounds = canvas.getBoundingClientRect();
    const firstBounds = cameras[0].getBoundingClientRect();
    const lastBounds = cameras[cameras.length - 1].getBoundingClientRect();
    const value = {
      record: canvas.getAttribute('aria-label'),
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      scrollWidth: viewport.scrollWidth,
      clientWidth: viewport.clientWidth,
      spacerWidth: spacer.getBoundingClientRect().width,
      spacerHeight: spacer.getBoundingClientRect().height,
      scale: Number(canvas.getAttribute('data-view-scale')),
      viewY: Number(canvas.getAttribute('data-view-y')),
      loadedTiles: Number(canvas.getAttribute('data-loaded-tiles')),
      camerasFit: Math.abs(firstBounds.left - canvasBounds.left) <= 2
        && Math.abs(lastBounds.right - canvasBounds.right) <= 2,
    };
    return value.record !== window.__steelInspectionWorldSmoke.initial.record
      && value.scrollLeft === 0 && value.scrollTop === 0 && value.viewY === 0
      && value.scrollWidth <= value.clientWidth + 2
      && value.spacerWidth <= value.clientWidth + 2
      && value.spacerHeight > viewport.clientHeight
      && value.scale > 0 && value.loadedTiles > 0 && value.camerasFit
      ? value
      : false;
  })()`);

  await page.evaluate(`(() => {
    const select = document.querySelector('.bkv-toolbar select');
    if (!select) return false;
    select.value = window.__steelInspectionWorldSmoke.initial.selectValue;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await requireEventually('record-switch-restores-first-record', `(() => {
    const viewport = document.querySelector(${JSON.stringify(viewportSelector)});
    const canvas = document.querySelector(${JSON.stringify(canvasSelector)});
    return viewport && canvas
      && canvas.getAttribute('aria-label') === window.__steelInspectionWorldSmoke.initial.record
      && viewport.scrollLeft === 0 && viewport.scrollTop === 0
      && Number(canvas.getAttribute('data-view-y')) === 0
      && Number(canvas.getAttribute('data-loaded-tiles')) > 0
      ? { record: canvas.getAttribute('aria-label'), scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop }
      : false;
  })()`);

  return { initial, plainWheel, ctrlWheel, deepScroll, switched };
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
    id: 'bkv-2d-inspection-world',
    url: appUrl('terminal'),
    requiredText: ['BKV \u79bb\u7ebf\u56de\u653e', '6/6 \u79bb\u7ebf\u6570\u636e', '126 \u5e27\u68c0\u6d4b\u56fe\u50cf\u4e16\u754c', 'C1', 'C6', '\u771f\u5b9e\u76f8\u673a\u5728\u7ebf 0', '\u786c\u4ef6\u63a7\u5236\u5df2\u7981\u7528'],
    requiredExpressions: [
      'document.querySelectorAll("[data-testid=inspection-world-canvas]").length === 1',
      'document.querySelectorAll("[data-testid=inspection-world-camera]").length === 6',
      'Number(document.querySelector("[data-testid=inspection-world-canvas]")?.getAttribute("data-loaded-tiles")) > 0',
      'document.querySelector(".bkv-camera-strip") === null && document.querySelectorAll("[data-testid=bkv-camera-lane]").length === 0',
      '![...document.querySelectorAll("[data-testid=inspection-world-camera]")].some((lane) => lane.innerText.includes("C7"))',
      '(() => { const count = performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/api/inspection-world/tile")).length; return count > 0 && count < 126; })()',
      '(() => { const canvas = document.querySelector("[data-testid=inspection-world-canvas]"); if (!canvas) return false; const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data; for (let index = 0; index < data.length; index += 64) { const r = data[index], g = data[index + 1], b = data[index + 2]; if (r > 32 && Math.abs(r - g) < 6 && Math.abs(g - b) < 6) return true; } return false; })()',
      '![...document.querySelectorAll("button")].some((button) => button.innerText.trim() === "\u8fde\u63a5\u76f8\u673a")',
    ],
    runInteraction: runBkvNativeScrollChecks,
  },
  {
    id: 'bkv-defect-focus',
    url: appUrl('terminal'),
    requiredText: ['BKV \u79bb\u7ebf\u56de\u653e', '126 \u5e27\u68c0\u6d4b\u56fe\u50cf\u4e16\u754c', '\u8f67\u6298'],
    clickSelector: '.bkv-defect-list button',
    afterClickText: ['\u8f67\u6298', 'C1', 'C6'],
    requiredExpressions: [
      'Number(document.querySelector("[data-testid=inspection-world-canvas]")?.getAttribute("data-view-y")) > 10000',
      'document.querySelector("[data-testid=inspection-world-canvas]")?.getAttribute("data-locatable-defects") === "1"',
      'Number(document.querySelector("[data-testid=inspection-world-canvas]")?.getAttribute("data-loaded-tiles")) > 0',
      '(() => { const canvas = document.querySelector("[data-testid=inspection-world-canvas]"); if (!canvas) return false; const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data; for (let index = 0; index < data.length; index += 64) { const r = data[index], g = data[index + 1], b = data[index + 2]; if (r > 32 && Math.abs(r - g) < 6 && Math.abs(g - b) < 6) return true; } return false; })()',
    ],
  },
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
      'document.querySelector(".bkv-camera-strip") === null && document.querySelector(".bkv-visual-panel canvas") !== null',
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
