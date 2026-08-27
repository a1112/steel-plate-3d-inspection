import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  prefetchCaptureImageUrls,
  resetCaptureImagePrefetchForTests,
} from './capture-image-prefetch';

class FakeImage {
  static instances: FakeImage[] = [];
  complete = false;
  naturalWidth = 0;
  decoding = '';
  loading = '';
  fetchPriority = '';
  crossOrigin: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url = '';

  constructor() {
    FakeImage.instances.push(this);
  }

  set src(value: string) {
    this.url = value;
  }

  removeAttribute(name: string) {
    if (name === 'src') this.url = '';
  }

  resolve() {
    this.complete = true;
    this.naturalWidth = 1;
    this.onload?.();
  }
}

describe('capture image prefetch queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeImage.instances = [];
    vi.stubGlobal('Image', FakeImage);
    resetCaptureImagePrefetchForTests();
  });

  afterEach(() => {
    resetCaptureImagePrefetchForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('deduplicates URLs, caps concurrent requests, and marks them low priority', async () => {
    const cancelFirst = prefetchCaptureImageUrls(['/a.jpg', '/b.jpg', '/a.jpg', '/c.jpg'], {
      delayMs: 0,
    });
    prefetchCaptureImageUrls(['/b.jpg', '/d.jpg'], { delayMs: 0 });

    await vi.advanceTimersByTimeAsync(0);
    expect(FakeImage.instances).toHaveLength(2);
    expect(FakeImage.instances.map((image) => image.url)).toEqual(['/a.jpg', '/b.jpg']);
    expect(FakeImage.instances.every((image) => image.fetchPriority === 'low')).toBe(true);
    expect(new Set(FakeImage.instances.map((image) => image.url)).size).toBe(2);

    FakeImage.instances[0].resolve();
    await vi.runAllTimersAsync();
    expect(FakeImage.instances).toHaveLength(3);
    expect(FakeImage.instances[2].url).toBe('/c.jpg');

    cancelFirst();
  });

  it('cancels delayed work before it can start a browser request', async () => {
    const cancel = prefetchCaptureImageUrls(['/never.jpg'], { delayMs: 250 });
    cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeImage.instances).toHaveLength(0);
  });
});
