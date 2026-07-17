import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearNotifications,
  getNotificationsSnapshot,
  hideNotificationToast,
  inferNotificationTone,
  markAllNotificationsRead,
  notify,
} from './notifications';

describe('notification store', () => {
  beforeEach(() => clearNotifications());

  it('records, deduplicates, reads and hides operation messages', () => {
    const id = notify({ title: '操作已触发', message: '导入 fit_report' });
    expect(notify({ title: '操作已触发', message: '导入 fit_report' })).toBe(id);
    expect(getNotificationsSnapshot()).toHaveLength(1);
    expect(getNotificationsSnapshot()[0]).toMatchObject({ read: false, toastVisible: true });

    markAllNotificationsRead();
    hideNotificationToast(id);
    expect(getNotificationsSnapshot()[0]).toMatchObject({ read: true, toastVisible: false });
  });

  it('infers result severity from existing page messages', () => {
    expect(inferNotificationTone('标定保存成功')).toBe('success');
    expect(inferNotificationTone('请先选择版本')).toBe('warning');
    expect(inferNotificationTone('3D 重建失败')).toBe('error');
  });
});
