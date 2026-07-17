import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TauriWindowApi } from '../lib/tauri-window';
import { FullscreenShortcut } from './FullscreenShortcut';

function createWindowApi() {
  let fullscreen = false;
  const api: TauriWindowApi = {
    isAvailable: true,
    close: vi.fn(async () => {}),
    isFullscreen: vi.fn(async () => fullscreen),
    minimize: vi.fn(async () => {}),
    setFullscreen: vi.fn(async (next: boolean) => { fullscreen = next; }),
    startDragging: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(async () => () => {}),
  };
  return api;
}

describe('FullscreenShortcut', () => {
  it('toggles native fullscreen with F11 and ignores repeated keys', async () => {
    const windowApi = createWindowApi();
    render(<FullscreenShortcut windowApi={windowApi} />);

    fireEvent.keyDown(window, { key: 'F11' });
    await waitFor(() => expect(windowApi.setFullscreen).toHaveBeenLastCalledWith(true));

    fireEvent.keyDown(window, { key: 'F11', repeat: true });
    expect(windowApi.setFullscreen).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'F11' });
    await waitFor(() => expect(windowApi.setFullscreen).toHaveBeenLastCalledWith(false));
  });

  it('does not handle unrelated keys', () => {
    const windowApi = createWindowApi();
    render(<FullscreenShortcut windowApi={windowApi} />);
    fireEvent.keyDown(window, { key: 'F10' });
    expect(windowApi.isFullscreen).not.toHaveBeenCalled();
  });
});
