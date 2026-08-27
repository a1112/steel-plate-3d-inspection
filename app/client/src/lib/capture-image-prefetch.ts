/**
 * Low-priority image prefetching for the two-level capture renditions.
 *
 * The visible canvases own their image requests. This module is deliberately
 * separate from that path: it only starts a small, cancellable queue for
 * images that are outside the current viewport. Requests are shared between
 * callers so a fast scroll or a record switch cannot create duplicate image
 * downloads.
 */

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_URLS = 48;
const DEFAULT_DELAY_MS = 160;
const MAX_REMEMBERED_URLS = 2048;
const MAX_REMEMBERED_IMAGES = 384;

type PrefetchJob = {
  cancelled: boolean;
  urls: string[];
};

type PendingRequest = {
  state: 'queued' | 'loading';
  jobs: Set<PrefetchJob>;
  image?: HTMLImageElement;
};

type IdleWindow = Window & typeof globalThis & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const rememberedUrls = new Map<string, true>();
const rememberedImages = new Map<string, HTMLImageElement>();
const pendingRequests = new Map<string, PendingRequest>();
const pendingQueue: string[] = [];
let activeRequestCount = 0;
let pumpTimer: number | null = null;
let pumpIdleHandle: number | null = null;

function idleWindow(): IdleWindow | null {
  return typeof window === 'undefined' ? null : window as IdleWindow;
}

export function rememberCaptureImage(url: string, image: HTMLImageElement) {
  if (!image.complete || image.naturalWidth <= 0) return;
  rememberedUrls.delete(url);
  rememberedUrls.set(url, true);
  while (rememberedUrls.size > MAX_REMEMBERED_URLS) {
    const oldest = rememberedUrls.keys().next().value;
    if (typeof oldest !== 'string') break;
    rememberedUrls.delete(oldest);
  }
  // Expanded-camera originals can be very large. The immutable HTTP cache is
  // enough for those; retain decoded Image objects only for strip thumbnails.
  if (/[?&]level=original(?:&|$)/.test(url)) return;
  rememberedImages.delete(url);
  rememberedImages.set(url, image);
  while (rememberedImages.size > MAX_REMEMBERED_IMAGES) {
    const oldest = rememberedImages.keys().next().value;
    if (typeof oldest !== 'string') break;
    rememberedImages.delete(oldest);
  }
}

/**
 * Return an already decoded capture image and refresh its LRU position.
 * Virtualized camera frames use this to repaint synchronously when they
 * re-enter the viewport instead of flashing an empty canvas first.
 */
export function getRememberedCaptureImage(url: string) {
  const image = rememberedImages.get(url);
  if (!image) return undefined;
  if (!image.complete || image.naturalWidth <= 0) {
    rememberedImages.delete(url);
    return undefined;
  }
  rememberedImages.delete(url);
  rememberedImages.set(url, image);
  return image;
}

export function hasRememberedCaptureImageUrl(url: string) {
  return rememberedUrls.has(url);
}

function removeJobFromRequest(url: string, job: PrefetchJob) {
  const request = pendingRequests.get(url);
  if (!request) return;
  request.jobs.delete(job);
  if (request.jobs.size > 0) return;
  pendingRequests.delete(url);
  if (request.state === 'loading' && request.image) {
    // Removing src releases a pending browser fetch. The callbacks still
    // guard against this request's removal from the map.
    request.image.onload = null;
    request.image.onerror = null;
    if (typeof request.image.removeAttribute === 'function') {
      request.image.removeAttribute('src');
    }
    activeRequestCount = Math.max(0, activeRequestCount - 1);
  }
}

function hasLiveJob(request: PendingRequest) {
  for (const job of request.jobs) {
    if (!job.cancelled) return true;
  }
  return false;
}

function schedulePump(delayMs = 0) {
  if (pumpTimer !== null || pumpIdleHandle !== null) return;
  const run = () => {
    pumpTimer = null;
    pumpIdleHandle = null;
    pumpQueue();
  };
  const host = idleWindow();
  if (delayMs > 0) {
    pumpTimer = window.setTimeout(run, delayMs);
  } else if (host?.requestIdleCallback) {
    pumpIdleHandle = host.requestIdleCallback(run, { timeout: 900 });
  } else if (typeof window !== 'undefined') {
    pumpTimer = window.setTimeout(run, 0);
  } else {
    queueMicrotask(run);
  }
}

function finishRequest(url: string, succeeded: boolean) {
  const request = pendingRequests.get(url);
  if (!request || request.state !== 'loading') return;
  pendingRequests.delete(url);
  activeRequestCount = Math.max(0, activeRequestCount - 1);
  if (succeeded && request.image) {
    request.image.onload = null;
    request.image.onerror = null;
    rememberCaptureImage(url, request.image);
  }
  // A failed rendition is not remembered. It may become available after the
  // background full-flow generator commits the file, so a later viewport pass
  // is allowed to retry it.
  for (const job of request.jobs) {
    if (!job.cancelled) {
      // The job has no per-request callback; removing the completed URL from
      // its list is enough to let cancellation discard only outstanding work.
      job.urls = job.urls.filter((candidate) => candidate !== url);
    }
  }
  schedulePump();
}

function startRequest(url: string, request: PendingRequest) {
  if (!hasLiveJob(request)) {
    pendingRequests.delete(url);
    return;
  }
  request.state = 'loading';
  activeRequestCount += 1;
  const image = new Image();
  request.image = image;
  image.decoding = 'async';
  // Detached Image elements are not viewport-observable; using `loading=
  // lazy` here can prevent some WebViews from fetching them at all. The
  // fetchPriority hint and idle queue provide the intended low priority.
  image.fetchPriority = 'low';
  image.crossOrigin = 'anonymous';
  image.onload = () => finishRequest(url, true);
  image.onerror = () => finishRequest(url, false);
  image.src = url;
  // Cached images may not dispatch an event in a test double (or in an
  // unusual WebView implementation). Treat an already-complete successful
  // image as finished on the next microtask.
  if (image.complete && image.naturalWidth > 0) {
    queueMicrotask(() => finishRequest(url, true));
  }
}

function pumpQueue() {
  while (activeRequestCount < DEFAULT_MAX_CONCURRENT && pendingQueue.length > 0) {
    const url = pendingQueue.shift();
    if (!url) continue;
    const request = pendingRequests.get(url);
    if (!request || request.state !== 'queued') continue;
    if (!hasLiveJob(request)) {
      pendingRequests.delete(url);
      continue;
    }
    startRequest(url, request);
  }
  if (activeRequestCount < DEFAULT_MAX_CONCURRENT
    && pendingQueue.some((url) => pendingRequests.get(url)?.state === 'queued')) {
    schedulePump();
  }
}

export type CaptureImagePrefetchOptions = {
  /** Maximum number of distinct URLs accepted by this call. */
  maxUrls?: number;
  /** Delay before the idle queue is first allowed to start. */
  delayMs?: number;
};

/**
 * Enqueue low-priority capture rendition URLs and return a cancellation
 * function. URLs are deduplicated globally while they are queued or loading.
 */
export function prefetchCaptureImageUrls(
  urls: readonly string[],
  options: CaptureImagePrefetchOptions = {},
) {
  const maxUrls = Math.max(0, Math.min(DEFAULT_MAX_URLS, Math.floor(options.maxUrls ?? DEFAULT_MAX_URLS)));
  const uniqueUrls = [...new Set(urls.map((url) => url.trim()).filter(Boolean))]
    .filter((url) => !rememberedUrls.has(url))
    .slice(0, maxUrls);
  const job: PrefetchJob = { cancelled: false, urls: uniqueUrls };
  if (uniqueUrls.length === 0) return () => undefined;

  uniqueUrls.forEach((url) => {
    const existing = pendingRequests.get(url);
    if (existing) {
      existing.jobs.add(job);
      return;
    }
    pendingRequests.set(url, { state: 'queued', jobs: new Set([job]) });
    pendingQueue.push(url);
  });
  schedulePump(Math.max(0, Math.floor(options.delayMs ?? DEFAULT_DELAY_MS)));

  return () => {
    if (job.cancelled) return;
    job.cancelled = true;
    uniqueUrls.forEach((url) => removeJobFromRequest(url, job));
    schedulePump();
  };
}

/** Test-only reset hook; production code never calls this. */
export function resetCaptureImagePrefetchForTests() {
  for (const request of pendingRequests.values()) {
    if (request.image) {
      request.image.onload = null;
      request.image.onerror = null;
      if (typeof request.image.removeAttribute === 'function') {
        request.image.removeAttribute('src');
      }
    }
  }
  pendingRequests.clear();
  pendingQueue.length = 0;
  rememberedUrls.clear();
  rememberedImages.clear();
  activeRequestCount = 0;
  if (pumpTimer !== null && typeof window !== 'undefined') window.clearTimeout(pumpTimer);
  const host = idleWindow();
  if (pumpIdleHandle !== null) host?.cancelIdleCallback?.(pumpIdleHandle);
  pumpTimer = null;
  pumpIdleHandle = null;
}
