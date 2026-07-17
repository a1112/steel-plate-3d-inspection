import { useEffect } from 'react';
import { getTauriWindowApi, type TauriWindowApi } from '../lib/tauri-window';

async function toggleBrowserFullscreen() {
  if (document.fullscreenElement) {
    await document.exitFullscreen?.();
    return;
  }
  await document.documentElement.requestFullscreen?.();
}

export function FullscreenShortcut({ windowApi = getTauriWindowApi() }: { windowApi?: TauriWindowApi }) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'F11' || event.repeat) return;
      event.preventDefault();
      if (windowApi.isAvailable) {
        void windowApi.isFullscreen()
          .then((fullscreen) => windowApi.setFullscreen(!fullscreen))
          .catch(() => {});
        return;
      }
      void toggleBrowserFullscreen().catch(() => {});
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [windowApi]);

  return null;
}
