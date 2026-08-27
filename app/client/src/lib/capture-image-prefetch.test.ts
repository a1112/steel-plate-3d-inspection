import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getRememberedCaptureImage,
  hasRememberedCaptureImageUrl,
  prefetchCaptureImageUrls,
  rememberCaptureImage,
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

  it('retains the decoded image so a virtualized canvas can repaint without another request', async () => {
    prefetchCaptureImageUrls(['/already-loaded.jpg'], { delayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);

    const image = FakeImage.instances[0];
    image.resolve();
    await vi.runAllTimersAsync();

    expect(getRememberedCaptureImage('/already-loaded.jpg')).toBe(image);
    expect(hasRememberedCaptureImageUrl('/already-loaded.jpg')).toBe(true);
    expect(FakeImage.instances).toHaveLength(1);
  });

  it('accepts images decoded by a visible canvas and rejects incomplete images', () => {
    const ready = new FakeImage();
    ready.resolve();
    rememberCaptureImage('/visible.jpg', ready as unknown as HTMLImageElement);
    expect(getRememberedCaptureImage('/visible.jpg')).toBe(ready);

    const incomplete = new FakeImage();
    rememberCaptureImage('/incomplete.jpg', incomplete as unknown as HTMLImageElement);
    expect(getRememberedCaptureImage('/incomplete.jpg')).toBeUndefined();
    expect(hasRememberedCaptureImageUrl('/incomplete.jpg')).toBe(false);

    rememberCaptureImage(
      '/api/capture/render?path=frame.png&level=original',
      ready as unknown as HTMLImageElement,
    );
    expect(hasRememberedCaptureImageUrl('/api/capture/render?path=frame.png&level=original')).toBe(true);
    expect(getRememberedCaptureImage('/api/capture/render?path=frame.png&level=original')).toBeUndefined();
  });
});
