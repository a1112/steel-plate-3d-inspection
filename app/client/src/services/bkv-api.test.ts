import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bkvArtifactUrl,
  fetchBkvMaterial,
  fetchBkvMaterials,
  fetchBkvStatus,
  nextBkvReplay,
  resetBkvReplay,
} from './bkv-api';

describe('bkv api', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('steel-inspection-admin-session', JSON.stringify({
      token: 'bkv-token',
      user: { id: 'admin' },
    }));
    vi.stubGlobal('fetch', vi.fn());
  });

  it('treats a missing status endpoint as inactive without disturbing the normal app', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 404 }));
    await expect(fetchBkvStatus()).resolves.toBeNull();
  });

  it('loads status, materials and selected material with typed authenticated calls', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ provider: 'bkv', ready: true, materialCount: 11 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ provider: 'bkv', materials: [{ legacySeqNo: 1893700 }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ provider: 'bkv', material: { legacySeqNo: 1893703 } }), { status: 200 }));

    expect((await fetchBkvStatus())?.provider).toBe('bkv');
    expect((await fetchBkvMaterials())[0].legacySeqNo).toBe(1893700);
    expect((await fetchBkvMaterial(1893703)).legacySeqNo).toBe(1893703);
    expect(vi.mocked(fetch).mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer bkv-token' });
    expect(String(vi.mocked(fetch).mock.calls[2][0])).toContain('legacySeqNo=1893703');
  });

  it('builds encoded artifact URLs and sends next/reset replay mutations', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, provider: 'bkv', completed: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, provider: 'bkv' }), { status: 200 }));
    expect(bkvArtifactUrl('preview/一号/unwrapped height.png')).toContain('path=preview%2F%E4%B8%80%E5%8F%B7%2Funwrapped+height.png');
    await nextBkvReplay();
    await resetBkvReplay();
    expect(vi.mocked(fetch).mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining('/api/bkv/replay/next'),
      expect.stringContaining('/api/bkv/replay/reset'),
    ]);
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer bkv-token' }),
    });
  });
});
