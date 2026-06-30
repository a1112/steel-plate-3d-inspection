import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceStatus, SteelPlate } from '../data/inspection';
import { BrandHeader } from './BrandHeader';

const status: DeviceStatus = {
  receiverPorts: Array.from({ length: 8 }, (_, index) => ({ index: index + 1, ok: index !== 2 })),
  cameraPorts: Array.from({ length: 8 }, (_, index) => ({ index: index + 1, ok: index !== 2 })),
  encoder: 'sync',
  plc: 'normal',
  l2: 'normal',
  alarmCount: 1,
};

const plate: SteelPlate = {
  plateNo: '202606131900',
  widthMm: 3500,
  lengthMm: 12000,
  thicknessMm: 12,
  steelGrade: 'Q355B',
  detectedAt: '2026-06-13 19:00',
};

function renderHeader(overrides: Partial<ComponentProps<typeof BrandHeader>> = {}) {
  return render(
    <BrandHeader
      status={status}
      plate={plate}
      theme="dark"
      onSettingsOpen={vi.fn()}
      onDragMouseDown={vi.fn()}
      {...overrides}
    />,
  );
}

describe('BrandHeader', () => {
  it('does not render the removed partner brand mark in the window header', () => {
    const removedBrandText = '\u9996\u94a2\u96c6\u56e2';
    renderHeader();

    expect(screen.queryByText(removedBrandText)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(removedBrandText)).not.toBeInTheDocument();
  });

  it('shows camera detail information after clicking camera status', () => {
    const onDragMouseDown = vi.fn();
    renderHeader({ onDragMouseDown });

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

  it('opens system settings from the header settings button without starting titlebar drag', () => {
    const onSettingsOpen = vi.fn();
    const onDragMouseDown = vi.fn();
    renderHeader({ onSettingsOpen, onDragMouseDown });

    const settingsButton = screen.getByRole('button', { name: '打开系统设置' });
    fireEvent.mouseDown(settingsButton);
    fireEvent.click(settingsButton);

    expect(onDragMouseDown).not.toHaveBeenCalled();
    expect(onSettingsOpen).toHaveBeenCalledTimes(1);
  });

  it('shows receiver port detail information and switches detail panels', () => {
    const onDragMouseDown = vi.fn();
    renderHeader({ onDragMouseDown });

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
        <BrandHeader status={status} plate={plate} theme="dark" onSettingsOpen={vi.fn()} onDragMouseDown={vi.fn()} />
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

  it('does not render the old titlebar theme toggle', () => {
    renderHeader();

    expect(screen.queryByRole('button', { name: '切换主题' })).not.toBeInTheDocument();
  });
});
