import { Copy, Minus, Square, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getTauriWindowApi } from '../lib/tauri-window';

export function WindowControls() {
  const windowApi = useMemo(() => getTauriWindowApi(), []);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!windowApi.isAvailable) {
      return;
    }
    let disposed = false;
    let unlisten: undefined | (() => void);

    const sync = async () => {
      const maximized = await windowApi.isMaximized().catch(() => false);
      if (!disposed) {
        setIsMaximized(maximized);
      }
    };

    void (async () => {
      await sync();
      unlisten = await windowApi.onResized(sync);
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [windowApi]);

  const toggleMaximize = async () => {
    await windowApi.toggleMaximize().catch(() => {});
    setIsMaximized(await windowApi.isMaximized().catch(() => false));
  };

  return (
    <div className="window-controls" data-no-drag>
      <button type="button" title="最小化" onClick={() => void windowApi.minimize().catch(() => {})}>
        <Minus size={14} />
      </button>
      <button type="button" title={isMaximized ? '还原' : '最大化'} onClick={() => void toggleMaximize()}>
        {isMaximized ? <Copy size={13} /> : <Square size={13} />}
      </button>
      <button type="button" className="window-close" title="关闭" onClick={() => void windowApi.close().catch(() => {})}>
        <X size={15} />
      </button>
    </div>
  );
}
