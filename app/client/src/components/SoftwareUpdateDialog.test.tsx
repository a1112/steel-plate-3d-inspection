import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkSoftwareUpdate,
  installSoftwareUpdate,
  readSoftwareUpdateStatus,
} from '../lib/software-update';
import { SoftwareUpdateDialog } from './SoftwareUpdateDialog';

vi.mock('../lib/software-update', () => ({
  readSoftwareUpdateStatus: vi.fn(),
  checkSoftwareUpdate: vi.fn(),
  installSoftwareUpdate: vi.fn(),
  formatSoftwareUpdateError: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

describe('SoftwareUpdateDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readSoftwareUpdateStatus).mockResolvedValue({
      currentVersion: '1.4.0',
      configured: true,
      channel: 'stable',
      reason: null,
    });
    vi.mocked(checkSoftwareUpdate).mockResolvedValue({
      currentVersion: '1.4.0',
      available: true,
      version: '1.5.0',
      date: '2026-08-28T08:00:00Z',
      notes: '提升缺陷检测稳定性。',
    });
  });

  it('checks the signed stable channel and installs an available version with progress', async () => {
    vi.mocked(installSoftwareUpdate).mockImplementation(async (onEvent) => {
      onEvent({ event: 'started', data: { contentLength: 1_000 } });
      onEvent({ event: 'progress', data: { chunkLength: 400, downloaded: 400 } });
      onEvent({ event: 'progress', data: { chunkLength: 600, downloaded: 1_000 } });
      onEvent({ event: 'downloaded' });
      onEvent({ event: 'installing' });
    });

    render(<SoftwareUpdateDialog onClose={vi.fn()} />);

    expect(await screen.findByText('发现新版本 1.5.0')).toBeInTheDocument();
    expect(screen.getByText('v1.4.0')).toBeInTheDocument();
    expect(screen.getByText('v1.5.0')).toBeInTheDocument();
    expect(screen.getByText('提升缺陷检测稳定性。')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '下载并安装' }));

    await waitFor(() => expect(installSoftwareUpdate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('更新已安装，应用即将重新启动')).toBeInTheDocument();
  });

  it('shows a safe configuration message when the build has no update public key', async () => {
    vi.mocked(readSoftwareUpdateStatus).mockResolvedValue({
      currentVersion: '1.4.0',
      configured: false,
      channel: 'stable',
      reason: '正式构建尚未绑定签名更新公钥',
    });

    render(<SoftwareUpdateDialog onClose={vi.fn()} />);

    expect(await screen.findByText('正式构建尚未绑定签名更新公钥')).toBeInTheDocument();
    expect(checkSoftwareUpdate).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '下载并安装' })).not.toBeInTheDocument();
    expect(screen.getByText(/更新包必须通过内置公钥签名校验/)).toBeInTheDocument();
  });
});
