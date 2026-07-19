import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

export type AppWindowKind = 'capture' | 'parameters' | 'bar-surface';

export type AppWindowResult = {
  opened: boolean;
  label: string;
  error?: string | null;
};

function hasTauriRuntime() {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  );
}

const windowDefinitions: Record<AppWindowKind, {
  browserName: string;
  title: string;
  url: string;
}> = {
  capture: {
    browserName: 'capture-management',
    title: '采集管理',
    url: '/#app=capture',
  },
  parameters: {
    browserName: 'parameter-management',
    title: '后台管理',
    url: '/#app=parameters',
  },
  'bar-surface': {
    browserName: 'bar-surface',
    title: '3D 重建工作台',
    url: '/#app=bar-surface',
  },
};

export async function openAppWindow(kind: AppWindowKind): Promise<AppWindowResult> {
  const definition = windowDefinitions[kind];
  if (hasTauriRuntime()) {
    const existing = await WebviewWindow.getByLabel(definition.browserName);
    if (existing) {
      await existing.show();
      await existing.setFocus();
      return { opened: true, label: definition.browserName };
    }

    const appWindow = new WebviewWindow(definition.browserName, {
      url: definition.url,
      title: definition.title,
      width: 1480,
      height: 900,
      minWidth: 1180,
      minHeight: 720,
      center: true,
      resizable: true,
      maximizable: true,
      minimizable: true,
      closable: true,
      decorations: false,
      shadow: true,
    });
    await new Promise<void>((resolve, reject) => {
      void appWindow.once('tauri://created', () => resolve());
      void appWindow.once('tauri://error', (event) => reject(new Error(String(event.payload))));
    });
    return { opened: true, label: definition.browserName };
  }

  window.open(definition.url, definition.browserName, 'popup,width=1480,height=900');
  return {
    opened: true,
    label: `browser-${definition.browserName}`,
  };
}

export const openCaptureManagementWindow = () => openAppWindow('capture');
export const openParameterManagementWindow = () => openAppWindow('parameters');
export const openBarSurfaceWindow = () => openAppWindow('bar-surface');
