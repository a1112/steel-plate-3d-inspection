import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionRecoveryDialog } from './ConnectionRecoveryDialog';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ConnectionRecoveryDialog', () => {
  it('allows direct entry and retries with a manually configured address', () => {
    const onDismiss = vi.fn();
    const onRetry = vi.fn();
    render(
      <ConnectionRecoveryDialog
        error="Failed to fetch"
        initialConnection={{ mode: 'online', host: '127.0.0.1', port: 4873 }}
        theme="dark"
        onDismiss={onDismiss}
        onRetry={onRetry}
      />,
    );

    fireEvent.change(screen.getByLabelText('服务端 IP'), { target: { value: '192.168.10.25' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并重试' }));
    expect(onRetry).toHaveBeenCalledWith({ mode: 'online', host: '192.168.10.25', port: 4873 });

    fireEvent.click(screen.getByRole('button', { name: '直接进入' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('fills the preferred address returned by automatic discovery', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schema: 'steel.inspection-service-discovery.v1',
      code: 0,
      runtime: {
        service: 'steel-inspection-service',
        bindHost: '0.0.0.0',
        advertisedHost: '192.168.10.25',
        port: 4873,
        origin: 'http://192.168.10.25:4873',
        lanAccess: true,
        databaseEngine: 'postgres',
        databaseStatus: 'up',
        databaseFallbackActive: false,
        schemaVersion: 4,
      },
      preferred: {
        host: '192.168.10.25',
        port: 4873,
        origin: 'http://192.168.10.25:4873',
        scope: 'lan',
        preferred: true,
      },
      addresses: [{
        host: '192.168.10.25',
        port: 4873,
        origin: 'http://192.168.10.25:4873',
        scope: 'lan',
        preferred: true,
      }],
    }), { status: 200 })));

    render(
      <ConnectionRecoveryDialog
        error="Failed to fetch"
        initialConnection={{ mode: 'online', host: '127.0.0.1', port: 4873 }}
        theme="dark"
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '自动发现' }));

    await waitFor(() => expect(screen.getByLabelText('服务端 IP')).toHaveValue('192.168.10.25'));
    expect(screen.getByText('已发现并填写 192.168.10.25:4873')).toBeInTheDocument();
  });
});
