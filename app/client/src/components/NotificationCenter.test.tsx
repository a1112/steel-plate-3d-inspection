import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearNotifications, getNotificationsSnapshot } from '../state/notifications';
import { NotificationCenter } from './NotificationCenter';

describe('NotificationCenter', () => {
  beforeEach(() => clearNotifications());

  it('records action buttons while ignoring view tabs', () => {
    render(
      <>
        <button type="button">导入 fit_report</button>
        <div role="tablist"><button type="button" role="tab">3D</button></div>
        <NotificationCenter />
      </>,
    );

    fireEvent.click(screen.getByRole('button', { name: '导入 fit_report' }));
    expect(getNotificationsSnapshot()).toHaveLength(1);
    expect(screen.getByText('操作已触发')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '3D' }));
    expect(getNotificationsSnapshot()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '打开消息通知' }));
    expect(screen.getByRole('region', { name: '消息通知列表' })).toBeInTheDocument();
    expect(getNotificationsSnapshot()[0].read).toBe(true);
  });

  it('drags the notification system without opening it accidentally', () => {
    const { container } = render(<NotificationCenter />);
    const trigger = screen.getByRole('button', { name: '打开消息通知' });
    const root = container.querySelector('.app-notification-system');
    expect(root).not.toBeNull();

    const dispatchPointer = (type: string, clientX: number, clientY: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        pointerId: { value: 7 },
        button: { value: 0 },
        clientX: { value: clientX },
        clientY: { value: clientY },
      });
      fireEvent(trigger, event);
    };

    dispatchPointer('pointerdown', 900, 70);
    dispatchPointer('pointermove', 740, 190);
    expect(root).toHaveStyle({ left: '8px', top: '120px' });
    expect(root).toHaveAttribute('data-dragging', 'true');
    dispatchPointer('pointerup', 740, 190);
    fireEvent.click(trigger);

    expect(screen.queryByRole('region', { name: '消息通知列表' })).not.toBeInTheDocument();
    expect(root).not.toHaveAttribute('data-dragging');

    fireEvent.click(trigger);
    expect(screen.getByRole('region', { name: '消息通知列表' })).toBeInTheDocument();
  });
});
