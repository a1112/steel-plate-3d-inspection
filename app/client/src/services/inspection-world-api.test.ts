import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchInspectionWorldDefects,
  fetchInspectionWorldMeta,
  fetchInspectionWorldRecords,
  fetchInspectionWorldReconstructionParameters,
  fetchInspectionWorldSurface,
  fetchInspectionWorldTile,
  inspectionWorldFrameUrl,
  inspectionWorldRecordsMatchStatus,
  type InspectionWorldRecords,
} from './inspection-world-api';
import { bkvOnlineCroppedImageUrl } from './bkv-online-api';

describe('inspection world frame URLs', () => {
  it('encodes a defect ROI crop with the source frame request', () => {
    expect(inspectionWorldFrameUrl('1908500', 1, 18, {
      x: 1208,
      y: 848,
      width: 4,
      height: 11,
    })).toContain(
      'frame?recordId=1908500&cameraId=1&sequenceNo=18&cropX=1208&cropY=848&cropWidth=4&cropHeight=11',
    );
  });

  it('adds a defect ROI to the BKV online image endpoint', () => {
    expect(bkvOnlineCroppedImageUrl(
      '/api/bkv-online/image?camera=1&seq=1934011&index=13&kind=2d',
      { x: 1036, y: 826, width: 12, height: 23 },
    )).toContain(
      'camera=1&seq=1934011&index=13&kind=2d&cropX=1036&cropY=826&cropWidth=12&cropHeight=23',
    );
  });

  it('fails closed instead of returning a full inspection frame without a legal ROI', () => {
    expect(inspectionWorldFrameUrl('1908500', 1, 18)).toBe('');
    expect(inspectionWorldFrameUrl('1908500', 1, 18, null)).toBe('');
    expect(inspectionWorldFrameUrl('1908500', 1, 18, { x: 0, y: 0, width: 0, height: 20 })).toBe('');
    expect(inspectionWorldFrameUrl('1908500', 1, 18, { x: -1, y: 0, width: 20, height: 20 })).toBe('');
    expect(inspectionWorldFrameUrl('1908500', 1, 18, { x: 0, y: Number.NaN, width: 20, height: 20 })).toBe('');
  });

  it('fails closed instead of returning a full BKV frame without a legal ROI', () => {
    const source = '/api/bkv-online/image?camera=1&seq=1934011&index=13&kind=2d';
    expect(bkvOnlineCroppedImageUrl(source)).toBe('');
    expect(bkvOnlineCroppedImageUrl(source, null)).toBe('');
    expect(bkvOnlineCroppedImageUrl(source, { x: 0, y: 0, width: 12, height: 0 })).toBe('');
    expect(bkvOnlineCroppedImageUrl(source, { x: 0, y: -1, width: 12, height: 23 })).toBe('');
    expect(bkvOnlineCroppedImageUrl(source, { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 23 })).toBe('');
    expect(bkvOnlineCroppedImageUrl('/api/bkv-online/image-preview', { x: 0, y: 0, width: 12, height: 23 })).toBe('');
  });
});

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

  it('refreshes records when only the defect catalog revision changes', () => {
    const records: InspectionWorldRecords = {
      schema: 'steel.inspection-world.records.v1',
      provider: 'bkv',
      generation: 42,
      defectCatalogRevision: 'catalog-before',
      records: [],
    };

    expect(inspectionWorldRecordsMatchStatus(records, {
      schema: 'steel.inspection-world.records-status.v1',
      provider: 'bkv',
      ready: true,
      recordCount: 0,
      generation: 42,
      defectCatalogRevision: 'catalog-after',
    })).toBe(false);
    expect(inspectionWorldRecordsMatchStatus(records, {
      schema: 'steel.inspection-world.records-status.v1',
      provider: 'bkv',
      ready: true,
      recordCount: 0,
      generation: 42,
      defectCatalogRevision: 'catalog-before',
    })).toBe(true);
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
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schema: 'steel.inspection-world.meta.v1',
        provider: 'bkv',
        recordId: '1893700',
        sourceFrameCount: 126,
        sourceRevision: 'record-hash',
        cache: { state: 'on-demand', tileSize: 512, maxLevel: 3 },
        world: { width: 3870, height: 21504, tileSize: 512, maxLevel: 3, cameras: [] },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ schema: 'steel.inspection-world.defects.v1', provider: 'bkv', recordId: '1893700', defects: [] })));

    const records = await fetchInspectionWorldRecords(controller.signal);
    await fetchInspectionWorldMeta('1893700', controller.signal);
    await fetchInspectionWorldDefects('1893700', controller.signal);

    expect(records).toEqual(recordsPayload);
    const calls = vi.mocked(fetch).mock.calls;
    expect(String(calls[0][0])).toContain('/api/inspection-world/records');
    expect(String(calls[1][0])).toContain('/api/inspection-world/meta?recordId=1893700');
    expect(String(calls[2][0])).toContain('/api/inspection-world/defects?recordId=1893700');
    expect(calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer world-token' });
  });

  it('deduplicates concurrent metadata and defect requests for one record', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schema: 'steel.inspection-world.meta.v1',
        provider: 'bkv',
        recordId: '1893700',
        sourceFrameCount: 12,
        sourceRevision: 'record-hash',
        cache: { state: 'on-demand', tileSize: 512, maxLevel: 3 },
        world: { width: 512, height: 512, tileSize: 512, maxLevel: 3, cameras: [] },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schema: 'steel.inspection-world.defects.v1',
        provider: 'bkv',
        recordId: '1893700',
        defects: [],
      })));

    const [firstMeta, secondMeta] = await Promise.all([
      fetchInspectionWorldMeta('1893700'),
      fetchInspectionWorldMeta('1893700'),
    ]);
    const [firstDefects, secondDefects] = await Promise.all([
      fetchInspectionWorldDefects('1893700'),
      fetchInspectionWorldDefects('1893700'),
    ]);

    expect(firstMeta).toBe(secondMeta);
    expect(firstDefects).toBe(secondDefects);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('creates and explicitly revokes a requested tile blob URL', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new Blob(['tile'], { type: 'image/jpeg' })));
    const tile = await fetchInspectionWorldTile('1893700', {
      cameraId: 5,
      level: 2,
      x: 3,
      y: 4,
      revision: 'source-revision',
      format: 'jpeg',
    });

    expect(String(vi.mocked(fetch).mock.calls[0][0]))
      .toContain('recordId=1893700&revision=source-revision&cameraId=5&level=2&x=3&y=4&format=jpeg');
    expect(String(vi.mocked(fetch).mock.calls[0][0]))
      .toContain('layout=steel-world-tile-v3-512-l3');
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

    expect(surface.coordinateUnit).toBe('millimeter-normalized-radius');
    expect(surface.positions).toHaveLength(6);
    expect(surface.source).toBe('bkv-bsmesh');
    expect(cached).toBe(surface);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0][0]))
      .toContain('/api/inspection-world/surface?recordId=1908293&format=binary');
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ cache: 'no-cache' });
  });

  it('loads computed NPZ reconstruction parameters for the selected record', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      schema: 'steel.bkv-depth-reconstruction-parameters.v1',
      recordId: '1908500',
      input: {
        format: 'NPZ',
        depthArray: 'depth.npy',
        depthType: 'little-endian-float32',
        sourceFrameCount: 114,
        invalidDepthFloor: -999999,
      },
      sampling: {
        rows: 128,
        colsPerCamera: 32,
        cameraCount: 6,
        frameSelection: 'all-frames',
        rowSelection: 'evenly-spaced-across-ordered-frames',
        columnSelection: 'evenly-spaced',
      },
      reconstruction: {
        geometry: 'closed-cylinder',
        longitudinalExtent: 8,
        nominalRadius: 1,
        maximumRadialOffset: 0.28,
        cameraNormalization: 'valid-sample-median',
        coordinateUnit: 'legacy-unknown',
        calibrated: false,
      },
      display: {
        mode: 'camera-relative-residual',
        robustResidualP95: 41.689789,
        radialScale: 0.004318,
        unit: 'legacy-unknown',
      },
      output: {
        format: 'BSMESH01',
        vertexCount: 24576,
        validPointCount: 21882,
        indexCount: 120870,
        triangleCount: 40290,
        binaryBytes: 1319104,
      },
      cameras: [],
    })));

    const parameters = await fetchInspectionWorldReconstructionParameters('1908500');

    expect(parameters.output.vertexCount).toBe(24576);
    expect(parameters.display.robustResidualP95).toBe(41.689789);
    expect(String(vi.mocked(fetch).mock.calls[0][0]))
      .toContain('/api/inspection-world/reconstruction-parameters?recordId=1908500');
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ cache: 'no-cache' });
  });

  it('forces NPZ reconstruction and bypasses the browser surface cache', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schema: 'steel.bkv-depth-reconstruction-parameters.v1',
        recordId: 'force-1908500',
        input: {},
        sampling: {},
        reconstruction: {},
        display: {},
        output: { vertexCount: 2 },
        cameras: [],
      })))
      .mockResolvedValueOnce(new Response(bsmeshFixture(), {
        headers: { 'Content-Type': 'application/vnd.steel.bsmesh' },
      }));

    await fetchInspectionWorldReconstructionParameters('force-1908500', undefined, true);
    await fetchInspectionWorldSurface('force-1908500', undefined, true);

    const calls = vi.mocked(fetch).mock.calls;
    expect(String(calls[0][0])).toContain(
      '/api/inspection-world/reconstruction-parameters?recordId=force-1908500&rebuild=true',
    );
    expect(calls[0][1]).toMatchObject({ cache: 'no-store' });
    expect(String(calls[1][0])).toMatch(
      /surface\?recordId=force-1908500&format=binary&refresh=\d+/,
    );
    expect(calls[1][1]).toMatchObject({ cache: 'no-store' });
  });

  it('rejects an invalid world schema instead of rendering ambiguous data', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ schema: 'wrong', records: [] })));
    await expect(fetchInspectionWorldRecords()).rejects.toThrow('检测世界记录格式无效');
  });
});
