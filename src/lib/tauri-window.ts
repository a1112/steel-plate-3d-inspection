import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

type UnlistenFn = () => void;

export type TauriWindowApi = {
  isAvailable: boolean;
  close: () => Promise<void>;
  minimize: () => Promise<void>;
  startDragging: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onResized: (handler: () => void | Promise<void>) => Promise<UnlistenFn>;
};

const unavailableWindowApi: TauriWindowApi = {
  isAvailable: false,
  close: async () => {},
  minimize: async () => {},
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
    minimize: () => appWindow.minimize(),
    startDragging: () => appWindow.startDragging(),
    toggleMaximize: () => appWindow.toggleMaximize(),
    isMaximized: () => appWindow.isMaximized(),
    onResized: (handler) => appWindow.onResized(() => void handler()),
  };
}
