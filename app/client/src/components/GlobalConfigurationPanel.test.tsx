import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalConfigurationPanel } from './GlobalConfigurationPanel';

vi.mock('./RuntimeProfileManagementPanel', () => ({
  RuntimeProfileManagementPanel: () => (
    <div data-testid="runtime-profile-management">运行配置兼容编辑器</div>
  ),
}));

const activeSite = {
  id: 'bkv-default',
  displayName: 'BKV 六相机现场',
  deprecated: false,
  deprecationNotice: '',
  mode: 'bkv' as const,
  cameraCount: 6,
  active: true,
  pending: false,
  restartRequired: false,
  availability: {
    normal: 4,
    warning: 1,
    error: 0,
    blocking: 0,
    checkedAt: 1,
  },
};

const standbySite = {
  id: 'bkv-standby',
  displayName: 'BKV 备用现场',
  deprecated: false,
  deprecationNotice: '',
  mode: 'bkv' as const,
  cameraCount: 6,
  active: false,
  pending: false,
  restartRequired: false,
  availability: {
    normal: 5,
    warning: 0,
    error: 0,
    blocking: 0,
    checkedAt: 1,
  },
};

describe('GlobalConfigurationPanel', () => {
  const fetchMock = vi.fn();
  let blocking = false;
  let deprecatedStandby = false;
  let pendingSiteId: string | null = null;
  let restartRequired = false;

  const siteFor = (id: string) => {
    const source = id === activeSite.id ? activeSite : standbySite;
    return {
      ...source,
      id,
      displayName: id === source.id ? source.displayName : `${source.displayName} 副本`,
      pending: pendingSiteId === id,
      restartRequired,
      deprecated: deprecatedStandby && id === standbySite.id,
      deprecationNotice: deprecatedStandby && id === standbySite.id
        ? 'BKV online 已隔离并暂时停用'
        : '',
      availability: {
        ...source.availability,
        error: (blocking || deprecatedStandby) && id === standbySite.id ? 1 : 0,
        blocking: (blocking || deprecatedStandby) && id === standbySite.id ? 1 : 0,
      },
    };
  };

  beforeEach(() => {
    blocking = false;
    deprecatedStandby = false;
    pendingSiteId = null;
    restartRequired = false;
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('prompt', vi.fn());
    window.localStorage.setItem(
      'steel-inspection-admin-session',
      JSON.stringify({
        authenticated: true,
        token: 'admin-token',
        expiresAt: '2099-01-01T00:00:00Z',
        user: {
          id: 'admin',
          displayName: '系统管理员',
          role: 'administrator',
          permissions: ['admin.config'],
        },
      }),
    );
    fetchMock.mockImplementation(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes('/api/admin/site-configs/detail')) {
        const id = new URL(url).searchParams.get('id') ?? activeSite.id;
        const site = siteFor(id);
        return {
          ok: true,
          json: async () => ({
            schema: 'steel.site-config-detail.v1',
            site,
            document: {
              schema: 'steel.site-config.v1',
              id: site.id,
              displayName: site.displayName,
              mode: site.mode,
              runtimeProfile: 'runtime.json',
              connectionConfig: 'connection.json',
              captureConfig: 'capture.json',
            },
            report: {
              siteId: site.id,
              depth: 'default',
              checkedAt: 1,
              checks: (blocking || deprecatedStandby) && site.id === standbySite.id
                ? [{
                    id: deprecatedStandby ? 'site.deprecated' : 'storage.convertedRoot',
                    label: deprecatedStandby ? '配置生命周期' : '标准数据目录',
                    status: 'error',
                    message: deprecatedStandby ? site.deprecationNotice : '目录不可写',
                    blocking: true,
                  }]
                : [{
                    id: 'site.schema',
                    label: '现场配置结构',
                    status: 'normal',
                    message: '结构正常',
                    blocking: false,
                  }],
            },
          }),
        };
      }
      if (url.includes('/api/admin/site-configs/activate')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { id: string };
        pendingSiteId = body.id;
        restartRequired = true;
        return {
          ok: true,
          json: async () => ({
            activated: true,
            activeSiteId: activeSite.id,
            pendingSiteId,
            restartRequired,
          }),
        };
      }
      if (url.includes('/api/admin/site-configs/clone')) {
        return {
          ok: true,
          json: async () => ({ created: true }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          schema: 'steel.site-config-list.v1',
          activeSiteId: activeSite.id,
          pendingSiteId,
          restartRequired,
          sites: [siteFor(activeSite.id), siteFor(standbySite.id)],
        }),
      };
    });
  });

  it('selects the active configuration and renders its current mode', async () => {
    render(<GlobalConfigurationPanel canEdit />);

    const detail = await screen.findByTestId('site-config-detail');
    expect(within(detail).getByText(activeSite.displayName)).toBeInTheDocument();
    expect(within(detail).getByText('当前配置模式')).toBeInTheDocument();
    expect(within(detail).getByTestId('site-config-mode-setting').querySelector('strong'))
      .toHaveTextContent('BKV 模式');
    expect(within(detail).getByRole('combobox', { name: '设置配置模式' })).toHaveValue('bkv');
    expect(within(detail).getByRole('button', { name: '按此模式新建配置' })).toBeDisabled();
    expect(within(detail).queryByRole('combobox', { name: '运行模式' })).not.toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: '删除配置' })).toBeDisabled();
    expect(within(detail).getByRole('button', { name: '切换到此配置' })).toBeDisabled();
    expect(screen.getByText('运行中')).toBeInTheDocument();
  });

  it('prepares a new configuration when the desired mode changes', async () => {
    render(<GlobalConfigurationPanel canEdit />);
    const detail = await screen.findByTestId('site-config-detail');

    fireEvent.change(
      within(detail).getByRole('combobox', { name: '设置配置模式' }),
      { target: { value: 'direct-camera' } },
    );
    fireEvent.click(within(detail).getByRole('button', { name: '按此模式新建配置' }));

    const form = await screen.findByTestId('site-config-create-form');
    expect(within(form).getByRole('combobox', { name: '运行模式' })).toHaveValue('direct-camera');
    expect(within(form).getByRole('textbox', { name: '配置标识' })).toHaveValue(
      'bkv-default-direct-camera',
    );
    expect(screen.getByText('已选择相机直连模式，请确认新建配置并切换')).toBeInTheDocument();
  });

  it('allows mode selection only in the new configuration form', async () => {
    render(<GlobalConfigurationPanel canEdit />);
    await screen.findByTestId('site-config-detail');

    fireEvent.click(screen.getByRole('button', { name: '新建配置' }));

    const form = screen.getByTestId('site-config-create-form');
    expect(within(form).getByRole('combobox', { name: '运行模式' })).toBeEnabled();
    expect(within(form).getByRole('option', { name: 'BKV 模式' })).toBeInTheDocument();
    expect(within(form).getByRole('option', { name: '相机直连模式' })).toBeInTheDocument();
  });

  it('clones without sending an editable mode field', async () => {
    vi.mocked(window.prompt)
      .mockReturnValueOnce('bkv-copy')
      .mockReturnValueOnce('BKV 复制现场');
    render(<GlobalConfigurationPanel canEdit />);
    await screen.findByTestId('site-config-detail');

    fireEvent.click(screen.getByRole('button', { name: '复制配置' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/site-configs/clone'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
    const cloneCall = fetchMock.mock.calls.find(
      ([url]) => String(url).includes('/api/admin/site-configs/clone'),
    );
    const payload = JSON.parse(String(cloneCall?.[1]?.body ?? '{}'));
    expect(payload).toEqual({
      sourceId: activeSite.id,
      id: 'bkv-copy',
      displayName: 'BKV 复制现场',
    });
    expect(payload).not.toHaveProperty('mode');
  });

  it('prevents activation while a non-active configuration has blocking errors', async () => {
    blocking = true;
    render(<GlobalConfigurationPanel canEdit />);
    await screen.findByTestId('site-config-detail');

    fireEvent.click(screen.getByRole('button', { name: /BKV 备用现场/ }));

    const detail = await screen.findByTestId('site-config-detail');
    expect(await within(detail).findByText('目录不可写')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: '切换到此配置' })).toBeDisabled();
    expect(within(detail).getByText('存在阻断项，无法切换')).toBeInTheDocument();
  });

  it('marks a deprecated BKV online configuration and prevents activation', async () => {
    deprecatedStandby = true;
    render(<GlobalConfigurationPanel canEdit />);
    await screen.findByTestId('site-config-detail');

    fireEvent.click(screen.getByRole('button', { name: /BKV 备用现场/ }));

    const detail = await screen.findByTestId('site-config-detail');
    expect(await within(detail).findByText('BKV online 已隔离')).toBeInTheDocument();
    expect(within(detail).getAllByText('BKV online 已隔离并暂时停用')).toHaveLength(2);
    expect(within(detail).getByRole('button', { name: '切换到此配置' })).toBeDisabled();
    expect(screen.getAllByText('已弃用').length).toBeGreaterThan(0);
  });

  it('shows restart-required state and protects a pending configuration after activation', async () => {
    render(<GlobalConfigurationPanel canEdit />);
    await screen.findByTestId('site-config-detail');
    fireEvent.click(screen.getByRole('button', { name: /BKV 备用现场/ }));

    const detail = await screen.findByTestId('site-config-detail');
    fireEvent.click(within(detail).getByRole('button', { name: '切换到此配置' }));

    expect(await screen.findByText('已切换配置，需要重启服务后生效')).toBeInTheDocument();
    expect(screen.getAllByText('待重启').length).toBeGreaterThan(0);
    expect(within(detail).getByRole('button', { name: '删除配置' })).toBeDisabled();
  });

  it('keeps actions present in the independently scrollable workspace', async () => {
    const { container } = render(<GlobalConfigurationPanel canEdit />);
    const detail = await screen.findByTestId('site-config-detail');

    expect(container.querySelector('.site-config-workspace')).toBeInTheDocument();
    expect(container.querySelector('.site-config-list')).toBeInTheDocument();
    expect(container.querySelector('.site-config-detail-area')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: '删除配置' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: '切换到此配置' })).toBeInTheDocument();
  });
});
