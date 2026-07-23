import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchInspectionWorldDefects,
  fetchInspectionWorldMeta,
  fetchInspectionWorldRecords,
  fetchInspectionWorldTile,
  type InspectionWorldRecords,
} from './inspection-world-api';

describe('inspection world API', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('steel-inspection-admin-session', JSON.stringify({ token: 'world-token', user: { id: 'admin' } }));
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:world-tile'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('loads records metadata and defects through the shared contract', async () => {
    const controller = new AbortController();
    const recordsPayload: InspectionWorldRecords = {
      schema: 'steel.inspection-world.records.v1',
      provider: 'bkv',
      ready: true,
      cameraCount: 6,
      batchId: 'legacy-1893700-1893710',
      records: [{
        recordId: '1893700',
        legacySeqNo: 1893700,
        steelId: 'STEEL-1893700',
        outerDiameterMm: 233.664,
        wallThicknessMm: 12.5,
        cameraCount: 6,
        sourceHash: 'record-hash',
        defectCount: 1,
      }],
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(recordsPayload)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ schema: 'steel.inspection-world.meta.v1', provider: 'bkv', recordId: '1893700', sourceFrameCount: 126, world: { width: 3870, height: 21504, tileSize: 512, maxLevel: 15, cameras: [] } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ schema: 'steel.inspection-world.defects.v1', provider: 'bkv', recordId: '1893700', defects: [] })));

    const records = await fetchInspectionWorldRecords(controller.signal);
    await fetchInspectionWorldMeta('1893700', controller.signal);
    await fetchInspectionWorldDefects('1893700', controller.signal);

    expect(records).toEqual(recordsPayload);
    const calls = vi.mocked(fetch).mock.calls;
    expect(String(calls[0][0])).toContain('/api/inspection-world/records');
    expect(String(calls[1][0])).toContain('/api/inspection-world/meta?recordId=1893700');
    expect(String(calls[2][0])).toContain('/api/inspection-world/defects?recordId=1893700');
    expect(calls[1][1]).toMatchObject({ signal: controller.signal });
    expect(calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer world-token' });
  });

  it('creates and explicitly revokes a requested tile blob URL', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new Blob(['tile'], { type: 'image/jpeg' })));
    const tile = await fetchInspectionWorldTile('1893700', {
      cameraId: 5,
      level: 2,
      x: 3,
      y: 4,
      format: 'jpeg',
    });

    expect(String(vi.mocked(fetch).mock.calls[0][0]))
      .toContain('recordId=1893700&cameraId=5&level=2&x=3&y=4&format=jpeg');
    expect(tile.url).toBe('blob:world-tile');
    tile.revoke();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:world-tile');
  });

  it('rejects an invalid world schema instead of rendering ambiguous data', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ schema: 'wrong', records: [] })));
    await expect(fetchInspectionWorldRecords()).rejects.toThrow('检测世界记录格式无效');
  });
});
