import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAdminBkvImportJobs,
  fetchAdminRuntimeProfile,
  fetchRuntimeProfile,
  retryAdminBkvImportJob,
  saveAdminRuntimeProfile,
  startAdminBkvImportJob,
  validateAdminRuntimeProfile,
  type RuntimeProfileDocument,
} from './runtime-profile-api';

const profile: RuntimeProfileDocument = {
  schema: 'steel.runtime-profile.v1',
  id: 'bkv-6',
  displayName: 'BKV 六相机离线转换',
  provider: 'bkv',
  dataSource: 'converted-local',
  cameraConnection: 'none',
  cameraCount: 6,
  cameras: Array.from({ length: 6 }, (_, index) => ({
    id: `C${index + 1}`,
    displayOrder: index + 1,
    sourceCameraId: index + 1,
    role: `legacy-${index + 1}`,
    sourceDirectory: `camera-${index + 1}`,
  })),
  storage: {
    sourceRoot: 'legacy',
    convertedRoot: 'converted',
    catalogPath: 'converted/catalog.db',
    converterOrigin: 'http://127.0.0.1:4893',
  },
  capabilities: {
    directCamera: false,
    captureManagement: false,
    reconstruction: false,
    offlineReplay: true,
  },
};

describe('runtime profile admin API', () => {
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

  it('reads the public runtime profile without admin credentials', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        schema: 'steel.runtime-profile.public.v1',
        profileId: 'bkv-6',
        displayName: profile.displayName,
        provider: 'bkv',
        dataSource: 'converted-local',
        cameraConnection: 'none',
        cameraCount: 6,
        cameras: profile.cameras,
        configHash: 'active',
        capabilities: profile.capabilities,
      }),
    });

    const runtime = await fetchRuntimeProfile();

    expect(runtime.cameraCount).toBe(6);
    expect(runtime.cameras.map((camera) => camera.id)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4873/api/runtime-profile',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });

  it('reads, validates and saves the configured runtime profile with admin auth', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          activeProfile: {
            schema: 'steel.runtime-profile.public.v1',
            profileId: 'bkv-6',
            displayName: profile.displayName,
            provider: 'bkv',
            dataSource: 'converted-local',
            cameraConnection: 'none',
            cameraCount: 6,
            cameras: profile.cameras,
            configHash: 'active',
            capabilities: profile.capabilities,
          },
          savedProfile: profile,
          activeConfigHash: 'active',
          savedConfigHash: 'active',
          restartRequired: false,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          valid: true,
          profileId: 'bkv-6',
          activeConfigHash: 'active',
          savedConfigHash: 'saved',
          restartRequired: true,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          saved: true,
          profileId: 'bkv-6',
          activeConfigHash: 'active',
          savedConfigHash: 'saved',
          restartRequired: true,
        }),
      });

    const admin = await fetchAdminRuntimeProfile();
    const validation = await validateAdminRuntimeProfile(profile);
    const saved = await saveAdminRuntimeProfile(profile);

    expect(admin.savedProfile.cameraCount).toBe(6);
    expect(validation.restartRequired).toBe(true);
    expect(saved.saved).toBe(true);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers).toEqual(
        expect.objectContaining({ Authorization: 'Bearer admin-token' }),
      );
    }
    expect(fetchMock.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ profile }),
      }),
    );
  });

  it('lists, starts and retries converter jobs through protected routes', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          schema: 'steel.bkv-import-service.v1',
          ready: true,
          latestJob: { id: 'job-1', status: 'completed', totalRecords: 2 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ job_id: 'job-2', status: 'completed' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ job_id: 'job-1', status: 'completed' }),
      });

    expect((await fetchAdminBkvImportJobs()).latestJob?.id).toBe('job-1');
    expect((await startAdminBkvImportJob()).job_id).toBe('job-2');
    expect((await retryAdminBkvImportJob('job-1')).job_id).toBe('job-1');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:4873/api/admin/bkv-import/jobs',
      'http://127.0.0.1:4873/api/admin/bkv-import/jobs',
      'http://127.0.0.1:4873/api/admin/bkv-import/jobs/retry',
    ]);
  });
});
