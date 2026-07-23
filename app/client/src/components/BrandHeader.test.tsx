import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
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

function renderHeader(overrides: Partial<ComponentProps<typeof BrandHeader>> = {}) {
  return render(
    <BrandHeader
      status={status}
      theme="dark"
      activeNav="online"
      onNavChange={vi.fn()}
      onDragMouseDown={vi.fn()}
      {...overrides}
    />,
  );
}

describe('BrandHeader', () => {
  it('places the online analysis collapse control immediately before minimize', () => {
    const onToggle = vi.fn();
    renderHeader({ analysisCollapse: { collapsed: false, onToggle } });

    const collapse = screen.getByRole('button', { name: '收起缺陷分析区' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    expect(collapse.nextElementSibling).toBe(screen.getByTitle('最小化'));

    fireEvent.click(collapse);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('does not show an analysis collapse control without online analysis context', () => {
    renderHeader();

    expect(screen.queryByRole('button', { name: '收起缺陷分析区' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '展开缺陷分析区' })).not.toBeInTheDocument();
  });

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

  it('keeps configuration controls out of the business header and renders one notification entry', () => {
    renderHeader();

    expect(screen.queryByRole('button', { name: '打开系统设置' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '打开消息通知' })).toHaveLength(1);
  });

  it('shows receiver port monitor placeholder and switches detail panels when realtime network data is pending', () => {
    const onDragMouseDown = vi.fn();
    renderHeader({ onDragMouseDown });

    const receiverStatusButton = screen.getByTestId('receiver-status-button');
    fireEvent.mouseDown(receiverStatusButton);
    expect(onDragMouseDown).not.toHaveBeenCalled();

    fireEvent.click(receiverStatusButton);

    expect(document.querySelector('#receiver-detail-panel')).toBeInTheDocument();
    expect(document.body.textContent).toContain('network monitor pending');
    expect(document.body.textContent).toContain('0Mbps');
    expect(document.body.textContent).not.toContain('120Mbps');
    expect(screen.queryByRole('button', { name: /apply|limit|throttle/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('camera-status-button'));

    expect(document.querySelector('#receiver-detail-panel')).not.toBeInTheDocument();
    expect(document.querySelector('#camera-detail-panel')).toBeInTheDocument();
  });

  it('shows real-time upload and download rates from the network monitor without limit controls', () => {
    renderHeader({
      network: {
        code: 0,
        source: 'windows-get-netadapter',
        sampledAtMs: Date.parse('2026-07-08T12:00:00.000Z'),
        totalUploadMbps: 64,
        totalDownloadMbps: 512,
        totalBandwidthMbps: 1000,
        interfaces: [
          {
            index: 1,
            name: 'Ethernet 1',
            description: 'Intel I350 #1',
            status: 'Up',
            linkSpeed: '1 Gbps',
            linkSpeedBitsPerSecond: 1_000_000_000,
            receivedBytes: 1024,
            transmittedBytes: 2048,
            uploadMbps: 31.25,
            downloadMbps: 250,
            bandwidthMbps: 1000,
            online: true,
          },
        ],
      },
    });

    expect(screen.getByTitle('实时上传 64 Mbps / 下载 512 Mbps')).toBeInTheDocument();
    expect(screen.getByText('实时网速')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '报级器网口，在线 1 路，异常 0 路' }));

    expect(screen.getByText('Windows 网卡实时收发速率，只读监控')).toBeInTheDocument();
    expect(screen.getAllByText('实时上传').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('实时下载').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Ethernet 1')).toBeInTheDocument();
    expect(screen.getByText('Intel I350 #1')).toBeInTheDocument();
    expect(screen.getByLabelText('1 上传 31.3 Mbps')).toHaveTextContent('31.3Mbps');
    expect(screen.getByLabelText('1 下载 250 Mbps')).toHaveTextContent('250Mbps');
    expect(screen.getByLabelText('1 网口 利用率 25.0%')).toHaveTextContent('25.0%');
    expect(screen.queryByRole('button', { name: /应用|限速|限制/ })).not.toBeInTheDocument();
  });

  it('does not fall back to simulated receiver speeds when the realtime network monitor is offline', () => {
    renderHeader({
      network: {
        code: 1,
        source: 'windows-get-netadapter',
        sampledAtMs: Date.parse('2026-07-09T08:00:00.000Z'),
        totalUploadMbps: 0,
        totalDownloadMbps: 0,
        totalBandwidthMbps: 0,
        interfaces: [],
        error: 'network monitor offline',
      },
    });

    expect(screen.getByTitle('实时上传 0 Mbps / 下载 0 Mbps')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '报级器网口，在线 0 路，异常 1 路' }));

    expect(screen.getByText('网络监控')).toBeInTheDocument();
    expect(screen.getByText('network monitor offline')).toBeInTheDocument();
    expect(screen.getByLabelText('1 上传 0 Mbps')).toHaveTextContent('0Mbps');
    expect(screen.getByLabelText('1 下载 0 Mbps')).toHaveTextContent('0Mbps');
    expect(screen.queryByLabelText('1 上传 120 Mbps')).not.toBeInTheDocument();
  });

  it('prioritizes active hardware ports over idle online ports in the receiver network monitor', () => {
    const interfaces = [
      ...Array.from({ length: 8 }, (_, index) => ({
        index: index + 1,
        name: `SLOT 4 端口 ${index + 1}`,
        description: `Intel I350 idle #${index + 1}`,
        status: 'Up',
        linkSpeed: '1 Gbps',
        linkSpeedBitsPerSecond: 1_000_000_000,
        receivedBytes: 0,
        transmittedBytes: 0,
        packetsReceived: 0,
        packetsTransmitted: 0,
        uploadMbps: 0,
        downloadMbps: 0,
        bandwidthMbps: 1000,
        online: true,
      })),
      {
        index: 9,
        name: 'SLOT 6 端口 3',
        description: 'Intel I350 camera active',
        status: 'Up',
        linkSpeed: '1 Gbps',
        linkSpeedBitsPerSecond: 1_000_000_000,
        receivedBytes: 2_480_000_000,
        transmittedBytes: 16_000_000,
        packetsReceived: 1_610_000,
        packetsTransmitted: 190_000,
        uploadMbps: 0.5,
        downloadMbps: 24.5,
        bandwidthMbps: 1000,
        online: true,
      },
    ];

    renderHeader({
      network: {
        code: 0,
        source: 'windows-get-netadapter',
        sampledAtMs: Date.parse('2026-07-09T07:00:00.000Z'),
        totalUploadMbps: 0.5,
        totalDownloadMbps: 24.5,
        totalBandwidthMbps: 9000,
        interfaces,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: '报级器网口，在线 8 路，异常 0 路' }));

    expect(screen.getByText('SLOT 6 端口 3')).toBeInTheDocument();
    expect(screen.getByLabelText('1 下载 24.5 Mbps')).toHaveTextContent('24.5Mbps');
    expect(screen.queryByText('SLOT 4 端口 8')).not.toBeInTheDocument();
  });

  it('closes open detail popovers when focus leaves, clicking outside, or pressing escape', () => {
    render(
      <>
        <button type="button">outside</button>
        <BrandHeader status={status} theme="dark" activeNav="online" onNavChange={vi.fn()} onDragMouseDown={vi.fn()} />
      </>,
    );

    const receiverStatusButton = screen.getByTestId('receiver-status-button');
    fireEvent.click(receiverStatusButton);
    expect(document.querySelector('#receiver-detail-panel')).toBeInTheDocument();

    fireEvent.focusIn(screen.getByRole('button', { name: 'outside' }));
    expect(document.querySelector('#receiver-detail-panel')).not.toBeInTheDocument();

    fireEvent.click(receiverStatusButton);
    expect(document.querySelector('#receiver-detail-panel')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(document.querySelector('#receiver-detail-panel')).not.toBeInTheDocument();

    fireEvent.click(receiverStatusButton);
    expect(document.querySelector('#receiver-detail-panel')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('#receiver-detail-panel')).not.toBeInTheDocument();

    fireEvent.click(receiverStatusButton);
    expect(document.querySelector('#receiver-detail-panel')).toBeInTheDocument();

    fireEvent.blur(window);
    expect(document.querySelector('#receiver-detail-panel')).not.toBeInTheDocument();
  });

  it('does not render the old titlebar theme toggle', () => {
    renderHeader();

    expect(screen.queryByRole('button', { name: '切换主题' })).not.toBeInTheDocument();
  });

  it('renders service connection blocks when service status is provided', () => {
    renderHeader({
      services: {
        inspectionService: {
          name: 'Rust服务',
          state: 'warning',
          detail: 'SDK 未就绪',
          endpoint: 'http://127.0.0.1:8080',
        },
        captureService: {
          name: '采集服务',
          state: 'online',
          detail: '采集服务在线',
          endpoint: 'http://127.0.0.1:4873',
        },
        triggerGateway: {
          name: '触发网关',
          state: 'offline',
          detail: '网关离线',
          endpoint: 'http://127.0.0.1:18888',
        },
      },
    });

    expect(screen.getByText('Rust服务')).toBeInTheDocument();
    expect(screen.getByText('采集服务')).toBeInTheDocument();
    expect(screen.getByText('触发网关')).toBeInTheDocument();
    expect(screen.getByText('异常')).toBeInTheDocument();
    expect(screen.getByText('离线')).toBeInTheDocument();
    expect(screen.getAllByText('在线')[0]).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: '系统报警 1 项，服务异常 2 项' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '打开消息通知' })).toHaveLength(1);
  });

  it('renders navigation beside the app title without starting titlebar drag', () => {
    const onNavChange = vi.fn();
    const onDragMouseDown = vi.fn();
    renderHeader({ activeNav: 'online', onNavChange, onDragMouseDown });

    const reportButton = screen.getByRole('button', { name: '缺陷报表' });
    fireEvent.mouseDown(reportButton);
    fireEvent.click(reportButton);

    expect(onDragMouseDown).not.toHaveBeenCalled();
    expect(onNavChange).toHaveBeenCalledWith('report');
  });

  it('renders the embedded navigation before the system title', () => {
    const { container } = renderHeader();
    const titleMetaGroup = container.querySelector<HTMLElement>('.title-meta-group');

    expect(titleMetaGroup).not.toBeNull();
    const navigation = within(titleMetaGroup!).getByRole('navigation');
    const title = within(titleMetaGroup!).getByText('钢管3D表面检测系统');

    expect(navigation.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
