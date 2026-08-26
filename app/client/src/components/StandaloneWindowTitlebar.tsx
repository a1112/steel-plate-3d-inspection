import { Activity, Box, Camera, Database } from 'lucide-react';
import type { ElementType, MouseEvent } from 'react';
import { useMemo } from 'react';
import { canStartTitlebarDrag } from '../lib/titlebar-drag';
import { getTauriWindowApi } from '../lib/tauri-window';
import { WindowControls } from './WindowControls';
import { DEFAULT_SYSTEM_NAME } from '../lib/system-brand';

const titlebarIcons: Record<'capture' | 'parameters' | 'bar-surface' | 'monitor', ElementType> = {
  capture: Camera,
  parameters: Database,
  'bar-surface': Box,
  monitor: Activity,
};

export function StandaloneWindowTitlebar({
  kind,
  title,
  systemName = DEFAULT_SYSTEM_NAME,
}: {
  kind: 'capture' | 'parameters' | 'bar-surface' | 'monitor';
  title: string;
  systemName?: string;
}) {
  const windowApi = useMemo(() => getTauriWindowApi(), []);
  const Icon = titlebarIcons[kind];

  const handleMouseDown = async (event: MouseEvent<HTMLElement>) => {
    if (!windowApi.isAvailable || event.button !== 0 || !canStartTitlebarDrag(event.target)) {
      return;
    }
    try {
      if (event.detail === 2) {
        await windowApi.toggleMaximize();
      } else {
        await windowApi.startDragging();
      }
    } catch {
      // Browser preview has no native window API.
    }
  };

  return (
    <header className="standalone-window-titlebar" onMouseDown={(event) => void handleMouseDown(event)}>
      <div className="standalone-window-title">
        <Icon size={17} />
        <span>{systemName}</span>
        <strong>{title}</strong>
      </div>
      <WindowControls />
    </header>
  );
}
