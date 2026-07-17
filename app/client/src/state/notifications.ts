export type NotificationTone = 'info' | 'success' | 'warning' | 'error';

export type AppNotification = {
  id: string;
  title: string;
  message: string;
  tone: NotificationTone;
  createdAt: number;
  read: boolean;
  toastVisible: boolean;
};

type NotificationInput = {
  title?: string;
  message: string;
  tone?: NotificationTone;
};

const MAX_NOTIFICATIONS = 80;
const listeners = new Set<() => void>();
let sequence = 0;
let notifications: AppNotification[] = [];

function emit() {
  listeners.forEach((listener) => listener());
}

export function subscribeNotifications(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNotificationsSnapshot() {
  return notifications;
}

export function notify(input: NotificationInput) {
  const message = input.message.trim();
  if (!message) {
    return '';
  }
  const now = Date.now();
  const tone = input.tone ?? 'info';
  const title = input.title?.trim() || (tone === 'error' ? '操作失败' : tone === 'success' ? '操作完成' : '系统消息');
  const duplicate = notifications.find(
    (item) => item.title === title && item.message === message && now - item.createdAt < 1200,
  );
  if (duplicate) {
    return duplicate.id;
  }
  const notification: AppNotification = {
    id: `notice-${now}-${sequence += 1}`,
    title,
    message,
    tone,
    createdAt: now,
    read: false,
    toastVisible: true,
  };
  notifications = [notification, ...notifications].slice(0, MAX_NOTIFICATIONS);
  emit();
  return notification.id;
}

export function hideNotificationToast(id: string) {
  notifications = notifications.map((item) => item.id === id ? { ...item, toastVisible: false } : item);
  emit();
}

export function removeNotification(id: string) {
  notifications = notifications.filter((item) => item.id !== id);
  emit();
}

export function markAllNotificationsRead() {
  if (notifications.every((item) => item.read)) {
    return;
  }
  notifications = notifications.map((item) => ({ ...item, read: true }));
  emit();
}

export function clearNotifications() {
  if (notifications.length === 0) {
    return;
  }
  notifications = [];
  emit();
}

export function inferNotificationTone(message: string): NotificationTone {
  if (/失败|错误|异常|不可用|超时|拒绝/.test(message)) {
    return 'error';
  }
  if (/警告|注意|未通过|请先|请选择|缺少|降级/.test(message)) {
    return 'warning';
  }
  if (/成功|完成|已保存|已导出|已切换|已刷新|均可达/.test(message)) {
    return 'success';
  }
  return 'info';
}
