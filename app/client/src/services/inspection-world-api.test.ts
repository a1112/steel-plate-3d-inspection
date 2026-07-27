import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchInspectionWorldDefects,
  fetchInspectionWorldMeta,
  fetchInspectionWorldRecords,
  fetchInspectionWorldSurface,
  fetchInspectionWorldTile,
  type InspectionWorldRecords,
} from './inspection-world-api';

function bsmeshFixture() {
  const vertexCount = 2;
  const indexCount = 3;
  const byteLength = 40 + vertexCount * 3 * 4 + vertexCount * 2 * 4
    + vertexCount * 3 * 4 + indexCount * 4 + vertexCount * 2;
  const buffer = new ArrayBuffer(byteLength);
  const bytes = new Uint8Array(buffer);
  bytes.set(Array.from('BSMESH01', (value) => value.charCodeAt(0)), 0);
  const view = new DataView(buffer);
  [1, vertexCount, indexCount, 0x02 | 0x04, 2, 1, 6, 0]
    .forEach((value, index) => view.setUint32(8 + index * 4, value, true));
  let offset = 40;
  new Float32Array(buffer, offset, vertexCount * 3).set([0, 1, 0, 1, 1, 0]);
  offset += vertexCount * 3 * 4;
  new Float32Array(buffer, offset, vertexCount * 2).set([0, 0, 1, 0]);
  offset += vertexCount * 2 * 4;
  new Float32Array(buffer, offset, vertexCount * 3).set([0, 1, 1, 1, 0, 0]);
  offset += vertexCount * 3 * 4;
  new Uint32Array(buffer, offset, indexCount).set([0, 1, 0]);
  offset += indexCount * 4;
  new Uint8Array(buffer, offset, vertexCount).set([1, 1]);
  offset += vertexCount;
  new Uint8Array(buffer, offset, vertexCount).set([0, 0]);
  return buffer;
}

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

  it('loads a record-bound D3IMG surface mesh', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(bsmeshFixture(), {
      headers: { 'Content-Type': 'application/vnd.steel.bsmesh' },
    }));

    const surface = await fetchInspectionWorldSurface('1908293');
    const cached = await fetchInspectionWorldSurface('1908293');

    expect(surface.coordinateUnit).toBe('legacy-unknown');
    expect(surface.positions).toHaveLength(6);
    expect(surface.source).toBe('bkv-bsmesh');
    expect(cached).toBe(surface);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0][0]))
      .toContain('/api/inspection-world/surface?recordId=1908293&format=binary');
  });

  it('rejects an invalid world schema instead of rendering ambiguous data', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ schema: 'wrong', records: [] })));
    await expect(fetchInspectionWorldRecords()).rejects.toThrow('检测世界记录格式无效');
  });
});
