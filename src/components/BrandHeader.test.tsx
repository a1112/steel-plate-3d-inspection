import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceStatus } from '../data/inspection';
import { BrandHeader } from './BrandHeader';

const status: DeviceStatus = {
  receiverPorts: Array.from({ length: 8 }, (_, index) => ({ index: index + 1, ok: index !== 2 })),
  cameraPorts: Array.from({ length: 8 }, (_, index) => ({ index: index + 1, ok: index !== 2 })),
  encoder: 'sync',
  plc: 'normal',
  l2: 'normal',
  alarmCount: 1,
};

describe('BrandHeader', () => {
  it('does not render the removed partner brand mark in the window header', () => {
    const removedBrandText = '\u9996\u94a2\u96c6\u56e2';
    render(<BrandHeader status={status} theme="dark" onThemeToggle={vi.fn()} onDragMouseDown={vi.fn()} />);

    expect(screen.queryByText(removedBrandText)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(removedBrandText)).not.toBeInTheDocument();
  });

  it('shows camera detail information after clicking camera status', () => {
    const onDragMouseDown = vi.fn();
    render(<BrandHeader status={status} theme="dark" onThemeToggle={vi.fn()} onDragMouseDown={onDragMouseDown} />);

    const cameraStatusButton = screen.getByRole('button', { name: '相机状态，在线 7 路，异常 1 路' });
    fireEvent.mouseDown(cameraStatusButton);
    expect(onDragMouseDown).not.toHaveBeenCalled();

    fireEvent.click(cameraStatusButton);

    expect(screen.getByText('相机状态详细信息')).toBeInTheDocument();
    expect(screen.getByLabelText('在线相机 7')).toBeInTheDocument();
    expect(screen.getByLabelText('异常相机 1')).toBeInTheDocument();
    expect(screen.getByText('链路异常')).toBeInTheDocument();
    expect(screen.getByText('192.168.20.103')).toBeInTheDocument();
  });

  it('shows receiver port detail information and switches detail panels', () => {
    const onDragMouseDown = vi.fn();
    render(<BrandHeader status={status} theme="dark" onThemeToggle={vi.fn()} onDragMouseDown={onDragMouseDown} />);

    const receiverStatusButton = screen.getByRole('button', { name: '报级器网口，在线 7 路，异常 1 路' });
    fireEvent.mouseDown(receiverStatusButton);
    expect(onDragMouseDown).not.toHaveBeenCalled();

    fireEvent.click(receiverStatusButton);

    expect(screen.getByText('报级器网口详细信息')).toBeInTheDocument();
    expect(screen.getByLabelText('在线网口 7')).toBeInTheDocument();
    expect(screen.getByLabelText('异常网口 1')).toBeInTheDocument();
    expect(screen.getByText('连接异常')).toBeInTheDocument();
    expect(screen.getByText('192.168.10.83')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '相机状态，在线 7 路，异常 1 路' }));

    expect(screen.queryByText('报级器网口详细信息')).not.toBeInTheDocument();
    expect(screen.getByText('相机状态详细信息')).toBeInTheDocument();
  });

  it('closes open detail popovers when focus leaves, clicking outside, or pressing escape', () => {
    render(
      <>
        <button type="button">外部按钮</button>
        <BrandHeader status={status} theme="dark" onThemeToggle={vi.fn()} onDragMouseDown={vi.fn()} />
      </>,
    );

    const receiverStatusButton = screen.getByRole('button', { name: '报级器网口，在线 7 路，异常 1 路' });
    fireEvent.click(receiverStatusButton);
    expect(screen.getByText('报级器网口详细信息')).toBeInTheDocument();

    fireEvent.focusIn(screen.getByRole('button', { name: '外部按钮' }));
    expect(screen.queryByText('报级器网口详细信息')).not.toBeInTheDocument();

    fireEvent.click(receiverStatusButton);
    expect(screen.getByText('报级器网口详细信息')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('报级器网口详细信息')).not.toBeInTheDocument();

    fireEvent.click(receiverStatusButton);
    expect(screen.getByText('报级器网口详细信息')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('报级器网口详细信息')).not.toBeInTheDocument();

    fireEvent.click(receiverStatusButton);
    expect(screen.getByText('报级器网口详细信息')).toBeInTheDocument();

    fireEvent.blur(window);
    expect(screen.queryByText('报级器网口详细信息')).not.toBeInTheDocument();
  });
});
