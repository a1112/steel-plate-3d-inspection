import { AlertTriangle, Bell, CheckCircle2, Info, Trash2, X, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import {
  clearNotifications,
  getNotificationsSnapshot,
  hideNotificationToast,
  markAllNotificationsRead,
  notify,
  removeNotification,
  subscribeNotifications,
  type AppNotification,
  type NotificationTone,
} from '../state/notifications';

const IGNORED_BUTTON_PATTERN = /^(上一页|下一页|首页|末页|关闭|最小化|最大化|还原|2D|3D|切面|贴图|Jet 高度|\+|−|刷新预览)$/i;
const ACTION_BUTTON_PATTERN = /保存|导入|导出|刷新|查询|重置|清理|删除|应用|连接|断开|采集|停止|启动|运行|重建|标定|激活|打开|下载|上传|确认|提交|创建|新建|检测|自检|同步|模拟|进钢|出钢|报警|校准|写入|读取|恢复|备份|归档|切换/;

function iconForTone(tone: NotificationTone) {
  if (tone === 'success') return CheckCircle2;
  if (tone === 'warning') return AlertTriangle;
  if (tone === 'error') return XCircle;
  return Info;
}

function buttonLabel(button: HTMLButtonElement) {
  return (
    button.dataset.notificationLabel
    || button.getAttribute('aria-label')
    || button.getAttribute('title')
    || button.innerText
    || button.textContent
    || ''
  ).replace(/\s+/g, ' ').trim().slice(0, 48);
}

function shouldNotifyButton(button: HTMLButtonElement, label: string) {
  if (!label || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
  if (button.dataset.notification === 'silent' || button.closest('[data-notification-root]')) return false;
  if (button.getAttribute('role') === 'tab' || button.closest('[role="tablist"]')) return false;
  if (button.closest('nav, .titlebar, .window-controls, .pagination, .records-pagination')) return false;
  if (IGNORED_BUTTON_PATTERN.test(label)) return false;
  return button.dataset.notification === 'action' || ACTION_BUTTON_PATTERN.test(label);
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function NotificationIcon({ tone, size = 16 }: { tone: NotificationTone; size?: number }) {
  const Icon = iconForTone(tone);
  return <Icon size={size} />;
}

function NotificationToast({ item }: { item: AppNotification }) {
  useEffect(() => {
    const timer = window.setTimeout(() => hideNotificationToast(item.id), item.tone === 'error' ? 7000 : 4500);
    return () => window.clearTimeout(timer);
  }, [item.id, item.tone]);

  return (
    <article className={`app-notification-toast is-${item.tone}`} role="status">
      <NotificationIcon tone={item.tone} size={18} />
      <div>
        <strong>{item.title}</strong>
        <span>{item.message}</span>
      </div>
      <button type="button" aria-label="关闭消息" data-notification="silent" onClick={() => hideNotificationToast(item.id)}>
        <X size={14} />
      </button>
    </article>
  );
}

export function NotificationCenter({ embedded = false }: { embedded?: boolean }) {
  const notifications = useSyncExternalStore(subscribeNotifications, getNotificationsSnapshot, getNotificationsSnapshot);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
    width: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const lastButtonNotice = useRef({ label: '', timestamp: 0 });
  const unreadCount = notifications.filter((item) => !item.read).length;
  const visibleToasts = useMemo(() => notifications.filter((item) => item.toastVisible).slice(0, 4), [notifications]);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest('button');
      if (!(button instanceof HTMLButtonElement)) return;
      const label = buttonLabel(button);
      if (!shouldNotifyButton(button, label)) return;
      const now = Date.now();
      if (lastButtonNotice.current.label === label && now - lastButtonNotice.current.timestamp < 800) return;
      lastButtonNotice.current = { label, timestamp: now };
      notify({ title: '操作已触发', message: label, tone: 'info' });
    };
    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, []);

  useEffect(() => {
    if (open) markAllNotificationsRead();
  }, [open]);

  useEffect(() => {
    if (!position) return;
    const keepInViewport = () => {
      const width = rootRef.current?.getBoundingClientRect().width || 380;
      setPosition((current) => current ? {
        left: Math.max(8, Math.min(current.left, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(current.top, window.innerHeight - 46)),
      } : null);
    };
    window.addEventListener('resize', keepInViewport);
    return () => window.removeEventListener('resize', keepInViewport);
  }, [position !== null]);

  const handleDragStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const root = rootRef.current;
    if (!root) return;
    const bounds = root.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: bounds.left,
      startTop: bounds.top,
      width: bounds.width,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleDragMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
    drag.moved = true;
    setDragging(true);
    setPosition({
      left: Math.max(8, Math.min(drag.startLeft + deltaX, window.innerWidth - drag.width - 8)),
      top: Math.max(8, Math.min(drag.startTop + deltaY, window.innerHeight - 46)),
    });
  };

  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    suppressClickRef.current = drag.moved;
    dragRef.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const toggleOpen = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setOpen((current) => !current);
  };

  return (
    <aside
      ref={rootRef}
      className={`app-notification-system ${embedded ? 'is-embedded' : ''} ${dragging ? 'is-dragging' : ''}`}
      data-notification-root
      data-no-drag
      data-dragging={dragging || undefined}
      style={!embedded && position ? { left: `${position.left}px`, top: `${position.top}px`, right: 'auto' } : undefined}
      onMouseDown={embedded ? (event) => event.stopPropagation() : undefined}
    >
      <div className="app-notification-toasts" aria-live="polite" aria-relevant="additions">
        {visibleToasts.map((item) => <NotificationToast key={item.id} item={item} />)}
      </div>
      {open ? (
        <section className="app-notification-panel" aria-label="消息通知列表">
          <header>
            <div>
              <span>消息中心</span>
              <strong>{notifications.length ? `${notifications.length} 条消息` : '暂无消息'}</strong>
            </div>
            <button type="button" aria-label="清空消息" data-notification="silent" disabled={!notifications.length} onClick={clearNotifications}>
              <Trash2 size={15} />
            </button>
          </header>
          <div className="app-notification-list">
            {notifications.length === 0 ? (
              <div className="app-notification-empty"><Bell size={24} /><span>控制操作与系统结果会显示在这里</span></div>
            ) : notifications.map((item) => (
              <article key={item.id} className={`app-notification-item is-${item.tone}`}>
                <NotificationIcon tone={item.tone} />
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.message}</span>
                  <time>{formatTime(item.createdAt)}</time>
                </div>
                <button type="button" aria-label={`删除消息 ${item.title}`} data-notification="silent" onClick={() => removeNotification(item.id)}>
                  <X size={13} />
                </button>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      <button
        type="button"
        className={`app-notification-trigger ${open ? 'is-open' : ''}`}
        aria-label={open ? '关闭消息通知' : '打开消息通知'}
        aria-expanded={open}
        data-notification="silent"
        title={embedded ? '消息通知' : '拖动调整位置，点击打开消息通知'}
        onPointerDown={embedded ? undefined : handleDragStart}
        onPointerMove={embedded ? undefined : handleDragMove}
        onPointerUp={embedded ? undefined : finishDrag}
        onPointerCancel={embedded ? undefined : finishDrag}
        onClick={toggleOpen}
      >
        <Bell size={19} />
        {unreadCount > 0 ? <span>{unreadCount > 99 ? '99+' : unreadCount}</span> : null}
      </button>
    </aside>
  );
}
