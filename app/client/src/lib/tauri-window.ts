import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

type UnlistenFn = () => void;

export type TauriWindowApi = {
  isAvailable: boolean;
  close: () => Promise<void>;
  isFullscreen: () => Promise<boolean>;
  minimize: () => Promise<void>;
  setTitle: (title: string) => Promise<void>;
  setFullscreen: (fullscreen: boolean) => Promise<void>;
  startDragging: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onResized: (handler: () => void | Promise<void>) => Promise<UnlistenFn>;
};

const unavailableWindowApi: TauriWindowApi = {
  isAvailable: false,
  close: async () => {},
  isFullscreen: async () => false,
  minimize: async () => {},
  setTitle: async () => {},
  setFullscreen: async () => {},
  startDragging: async () => {},
  toggleMaximize: async () => {},
  isMaximized: async () => false,
  onResized: async () => () => {},
};

export function getTauriWindowApi(): TauriWindowApi {
  if (!isTauri()) {
    return unavailableWindowApi;
  }

  const appWindow = getCurrentWindow();

  return {
    isAvailable: true,
    close: () => appWindow.close(),
    isFullscreen: () => appWindow.isFullscreen(),
    minimize: () => appWindow.minimize(),
    setTitle: (title) => appWindow.setTitle(title),
    setFullscreen: (fullscreen) => appWindow.setFullscreen(fullscreen),
    startDragging: () => appWindow.startDragging(),
    toggleMaximize: () => appWindow.toggleMaximize(),
    isMaximized: () => appWindow.isMaximized(),
    onResized: (handler) => appWindow.onResized(() => void handler()),
  };
}
