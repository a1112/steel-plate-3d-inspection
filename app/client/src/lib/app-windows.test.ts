import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAppWindow, resolveAppRoute } from './app-windows';

const tauri = vi.hoisted(() => {
  const getByLabel = vi.fn();
  const constructor = vi.fn();
  const instance = {
    once: vi.fn((event: string, callback: (event: { payload?: unknown }) => void) => {
      if (event === 'tauri://created') {
        callback({});
      }
      return Promise.resolve(() => undefined);
    }),
    show: vi.fn(),
    setFocus: vi.fn(),
  };
  return { getByLabel, constructor, instance };
});

vi.mock('@tauri-apps/api/webviewWindow', () => {
  class WebviewWindow {
    static getByLabel = tauri.getByLabel;

    constructor(label: string, options: unknown) {
      tauri.constructor(label, options);
      return tauri.instance;
    }
  }
  return { WebviewWindow };
});

describe('application tool navigation', () => {
  const assign = vi.fn();
  const open = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', {
      location: { assign },
      open,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['parameters', '/?app=parameters'],
    ['capture', '/?app=capture'],
    ['bar-surface', '/?app=bar-surface'],
  ] as const)('navigates browser %s tools in the current tab', async (kind, url) => {
    await openAppWindow(kind);

    expect(assign).toHaveBeenCalledWith(url);
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps Tauri tools in managed application windows', async () => {
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: {},
      location: { assign },
      open,
    });
    tauri.getByLabel.mockResolvedValue(null);

    await openAppWindow('parameters');

    expect(tauri.constructor).toHaveBeenCalledWith(
      'parameter-management',
      expect.objectContaining({ url: '/?app=parameters' }),
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it('keeps compatibility with legacy hash application links', () => {
    expect(resolveAppRoute('', '#app=capture')).toBe('capture');
    expect(resolveAppRoute('', '#app=parameters')).toBe('parameters');
    expect(resolveAppRoute('', '#app=bar-surface')).toBe('bar-surface');
    expect(resolveAppRoute('', '#app=monitor')).toBe('monitor');
  });
});
