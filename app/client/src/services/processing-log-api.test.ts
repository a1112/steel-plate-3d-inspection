import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCaptureProcessingLog } from './processing-log-api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchCaptureProcessingLog', () => {
  it('reads the real processing endpoint and keeps the newest flow first', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      schema: 'steel.capture-processing-log.v1',
      updatedAt: '1787922600000',
      total: 2,
      records: [
        { materialId: '4035', flowNo: 4035, updatedAt: 20 },
        { materialId: '4037', flowNo: 4037, updatedAt: 10 },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchCaptureProcessingLog(200);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4873/api/production/processing-log?limit=100',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
    expect(result.records.map((record) => record.materialId)).toEqual(['4037', '4035']);
  });
});
