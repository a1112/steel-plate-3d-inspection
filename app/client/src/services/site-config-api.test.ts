import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateSiteConfig,
  checkSiteConfig,
  cloneSiteConfig,
  createSiteConfig,
  deleteSiteConfig,
  fetchSiteConfig,
  fetchSiteConfigs,
  updateSiteConfig,
} from './site-config-api';

describe('site configuration admin API', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
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
  });

  it('lists and reads site configuration details with admin authentication', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          schema: 'steel.site-config-list.v1',
          activeSiteId: 'bkv-default',
          pendingSiteId: null,
          restartRequired: false,
          sites: [{
            id: 'bkv-default',
            displayName: 'BKV 六相机现场',
            mode: 'bkv',
            cameraCount: 6,
            active: true,
            pending: false,
            restartRequired: false,
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          schema: 'steel.site-config-detail.v1',
          site: {
            id: 'bkv-default',
            displayName: 'BKV 六相机现场',
            mode: 'bkv',
            cameraCount: 6,
            active: true,
            pending: false,
            restartRequired: false,
          },
          document: {
            schema: 'steel.site-config.v1',
            id: 'bkv-default',
            displayName: 'BKV 六相机现场',
            mode: 'bkv',
            runtimeProfile: 'runtime.json',
            connectionConfig: 'connection.json',
            captureConfig: 'capture.json',
          },
        }),
      });

    expect((await fetchSiteConfigs()).sites).toHaveLength(1);
    expect((await fetchSiteConfig('bkv-default')).document.mode).toBe('bkv');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:4873/api/admin/site-configs',
      'http://127.0.0.1:4873/api/admin/site-configs/detail?id=bkv-default',
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers).toEqual(
        expect.objectContaining({ Authorization: 'Bearer admin-token' }),
      );
    }
  });

  it('uses the protected mutation contracts for the full configuration workflow', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        site: {
          id: 'bkv-east',
          displayName: 'BKV 东线',
          mode: 'bkv',
          cameraCount: 6,
          active: false,
          pending: false,
          restartRequired: false,
        },
        report: {
          siteId: 'bkv-east',
          depth: 'default',
          checkedAt: 1,
          checks: [],
        },
        restartRequired: true,
        pendingSiteId: 'bkv-east',
      }),
    });

    await createSiteConfig({
      id: 'bkv-east',
      displayName: 'BKV 东线',
      mode: 'bkv',
    });
    await cloneSiteConfig('bkv-default', {
      id: 'bkv-west',
      displayName: 'BKV 西线',
    });
    await updateSiteConfig('bkv-east', { displayName: '东线' });
    await checkSiteConfig('bkv-east', 'default');
    await activateSiteConfig('bkv-east');
    await deleteSiteConfig('bkv-west');

    expect(fetchMock.mock.calls.map(([url, init]) => [
      String(url),
      init.method,
      init.body,
    ])).toEqual([
      [
        'http://127.0.0.1:4873/api/admin/site-configs',
        'POST',
        JSON.stringify({ id: 'bkv-east', displayName: 'BKV 东线', mode: 'bkv' }),
      ],
      [
        'http://127.0.0.1:4873/api/admin/site-configs/clone',
        'POST',
        JSON.stringify({
          sourceId: 'bkv-default',
          id: 'bkv-west',
          displayName: 'BKV 西线',
        }),
      ],
      [
        'http://127.0.0.1:4873/api/admin/site-configs',
        'PATCH',
        JSON.stringify({ id: 'bkv-east', displayName: '东线' }),
      ],
      [
        'http://127.0.0.1:4873/api/admin/site-configs/check',
        'POST',
        JSON.stringify({ id: 'bkv-east', depth: 'default' }),
      ],
      [
        'http://127.0.0.1:4873/api/admin/site-configs/activate',
        'POST',
        JSON.stringify({ id: 'bkv-east' }),
      ],
      [
        'http://127.0.0.1:4873/api/admin/site-configs?id=bkv-west',
        'DELETE',
        undefined,
      ],
    ]);
  });
});
