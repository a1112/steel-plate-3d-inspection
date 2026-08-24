import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  readCaptureSnapshot,
  type BkvCaptureHealth,
  type CaptureHealth,
  type PhysicalCaptureHealth,
} from '../lib/capture-api';
import { getMockInspectionSnapshot } from '../data/inspection';
import {
  captureProductionOnce,
  fetchInspectionReportArchive,
  fetchInspectionReportArchives,
  fetchInspectionSnapshot,
  fetchProductionDefectHistory,
  formatProductionDateTime,
  formatProductionRecordTime,
  fetchBkvStatus,
  fetchBkvArtifact,
  parseBkvArtifact,
  fetchServiceHealthDetails,
  issueInspectionReportArchive,
  startProductionSteelIn,
  stopProductionSteelOut,
  triggerGatewayManualSteelIn,
  writeProductionSteelInfo,
  reviewProductionDefect,
} from './inspection-api';
import type {
  BkvArtifact,
  BkvProductionCommandResult,
  BkvStatus,
  ProductionCommandResult,
} from './inspection-api';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('persistent production command client', () => {
  it('keeps BKV replay and physical capture contracts discriminated', () => {
    const bkvHealth: BkvCaptureHealth = {
      service: 'steel-inspection-service',
      time: '2026-07-21T00:00:00Z',
      provider: 'bkv',
      status: 'bkv-offline',
      sdkRequired: false,
      sdkReady: null,
      connected: false,
      cameraCount: 6,
      channels: Array.from({ length: 6 }, (_, offset) => ({
        index: offset + 1,
        status: 'offline' as const,
        source: 'bkv' as const,
      })),
    };
    const physicalHealth: PhysicalCaptureHealth = {
      service: 'steel-capture-service',
      time: '2026-07-21T00:00:00Z',
      provider: 'headless-cpp',
      sdkReady: true,
      sdkCode: 0,
      connected: true,
      ip: '192.168.101.100',
    };
    expectTypeOf(bkvHealth).toMatchTypeOf<CaptureHealth>();
    expectTypeOf(physicalHealth).toMatchTypeOf<CaptureHealth>();
    expect(bkvHealth.channels).toHaveLength(6);
    expect(bkvHealth.channels.every((channel) => channel.status === 'offline')).toBe(true);
  });

  it('reads typed BKV batch and replay state', async () => {
    const payload: BkvStatus = {
      code: 0,
      active: true,
      provider: 'bkv',
      source: 'bkv',
      sourceBadge: 'BKV 离线回放',
      offline: true,
      activeBatch: { batchId: 'batch-001', contentId: 'a'.repeat(64) },
      batch: {
        batchId: 'batch-001',
        contentId: 'a'.repeat(64),
        status: 'ready',
        counts: { inspections: 11 },
      },
      replay: {
        index: 3,
        total: 11,
        status: 'replaying',
        version: 3,
        legacySeqNo: 1_893_702,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
    vi.stubGlobal('fetch', fetchMock);

    const status = await fetchBkvStatus();

    expect(status).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4873/api/bkv/status',
      { headers: { Accept: 'application/json' }, signal: undefined },
    );
  });

  it('accepts only ready or explicitly reviewed partial BKV batches', async () => {
    const base = {
      code: 0, active: true, provider: 'bkv', source: 'bkv',
      sourceBadge: 'BKV 离线回放', offline: true,
      activeBatch: { batchId: 'batch-001', contentId: 'a'.repeat(64) },
      replay: { index: 1, total: 11, status: 'replaying', version: 1, legacySeqNo: 1_893_700 },
    };
    const reviewedPartial = {
      ...base,
      batch: {
        batchId: 'batch-001', contentId: 'a'.repeat(64), status: 'partial',
        operatorReviewedPartial: true,
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(reviewedPartial)));
    await expect(fetchBkvStatus()).resolves.toMatchObject({
      batch: { status: 'partial', operatorReviewedPartial: true },
    });

    for (const batch of [
      { ...reviewedPartial.batch, operatorReviewedPartial: false },
      { ...reviewedPartial.batch, operatorReviewedPartial: undefined },
      { ...reviewedPartial.batch, status: 'failed', operatorReviewedPartial: true },
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...base, batch })));
      await expect(fetchBkvStatus()).rejects.toThrow(/BKV/i);
    }
  });

  it('normalizes only authenticated service URLs while retaining safe BKV artifact refs', async () => {
    const fixture = getMockInspectionSnapshot();
    const depthArtifact: BkvArtifact = {
      artifactRef: 'bkv://batch-001/artifacts/camera1/1893700/3d/0000.d3img',
      relativePath: 'artifacts/camera1/1893700/3d/0000.d3img',
      url: '/api/production/file?path=bkv%3A%2F%2Fbatch-001%2Fartifacts%2Fcamera1%2F1893700%2F3d%2F0000.d3img',
      authenticated: true,
      source: 'bkv',
      sourceBadge: 'BKV 离线回放',
      offline: true,
      sha256: 'b'.repeat(64),
      size: 84,
      cameraNumber: 1,
      legacySeqNo: 1_893_700,
      kind: '3d',
      depthDecode: {
        status: 'unsupported',
        reason: 'no_evidenced_decoder',
        probeSchema: 'steel.bkv-d3img-probe.v1',
        parserVersion: 'bkv-d3img-probe/1',
        originalSha256: 'b'.repeat(64),
        decoderAvailable: false,
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      ...fixture,
      provider: 'bkv',
      source: 'bkv',
      sourceBadge: 'BKV 离线回放',
      offline: true,
      batchId: 'batch-001',
      contentId: 'a'.repeat(64),
      legacySeqNo: 1_893_700,
      records: fixture.records.slice(0, 1),
      captureImages: [{
        ...depthArtifact,
        id: 'legacy-slot-must-not-be-used',
        cameraId: 'bkv-camera-1',
        cameraIp: '',
        dataName: '0000.d3img',
        sequenceNo: 1_893_700,
        fileType: '3d',
        createdAt: '2026-07-21T00:00:00Z',
      }],
      inspections: fixture.inspections.slice(0, 1).map((inspection) => ({
        ...inspection,
        bkvArtifacts: [depthArtifact],
        captureImages: [{
          ...depthArtifact,
          id: 'nested-legacy-slot-must-not-be-used',
          cameraId: 'bkv-camera-1',
          cameraIp: '',
          dataName: '0000.d3img',
          sequenceNo: 1_893_700,
          fileType: '3d',
          createdAt: '2026-07-21T00:00:00Z',
        }],
      })),
      bkvArtifacts: [depthArtifact],
    })));

    const snapshot = await fetchInspectionSnapshot();

    if (snapshot.provider !== 'bkv') {
      throw new Error('expected BKV snapshot');
    }
    expect(snapshot.source).toBe('bkv');
    expect(snapshot.provider).toBe('bkv');
    expect(snapshot.captureImages).toEqual([]);
    expect(snapshot.inspections).toHaveLength(1);
    expect(snapshot.inspections.every((inspection) => inspection.captureImages?.length === 0)).toBe(true);
    expect(snapshot.inspections.every((inspection) => inspection.bkvArtifacts.length === 1)).toBe(true);
    expect(snapshot.bkvArtifacts?.[0]).toMatchObject({
      artifactRef: depthArtifact.artifactRef,
      url: `http://127.0.0.1:4873${depthArtifact.url}`,
      depthDecode: {
        status: 'unsupported',
        reason: 'no_evidenced_decoder',
        probeSchema: 'steel.bkv-d3img-probe.v1',
        parserVersion: 'bkv-d3img-probe/1',
        originalSha256: 'b'.repeat(64),
        decoderAvailable: false,
      },
    });
  });

  it('rejects malformed BKV status identities and contradictory replay states', async () => {
    const valid = {
      code: 0, active: true, provider: 'bkv', source: 'bkv',
      sourceBadge: 'BKV 离线回放', offline: true,
      activeBatch: { batchId: 'batch-001', contentId: 'a'.repeat(64) },
      batch: { batchId: 'batch-001', contentId: 'a'.repeat(64), status: 'ready' },
      replay: { index: 3, total: 11, status: 'replaying', version: 3, legacySeqNo: 1_893_702 },
    };
    for (const malformed of [
      { ...valid, activeBatch: { ...valid.activeBatch, contentId: 'not-a-sha' } },
      { ...valid, batch: { ...valid.batch, batchId: 'other-batch' } },
      { ...valid, replay: { ...valid.replay, status: 'ready' } },
      { ...valid, replay: { ...valid.replay, legacySeqNo: 1_893_700 } },
      { ...valid, replay: { ...valid.replay, version: 2 } },
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(malformed)));
      await expect(fetchBkvStatus()).rejects.toThrow(/BKV/i);
    }
  });

  it('hydrates readCaptureSnapshot as six offline BKV channels from runtime responses', async () => {
    const channels = Array.from({ length: 6 }, (_, offset) => ({
      index: offset + 1,
      status: 'offline',
      source: 'bkv',
    }));
    const fetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/capture/health')) {
        return Promise.resolve(jsonResponse({
          service: 'steel-inspection-service',
          time: '2026-07-21T00:00:00Z',
          provider: 'bkv',
          status: 'bkv-offline',
          sdkRequired: false,
          sdkReady: null,
          connected: false,
          cameraCount: 6,
          channels,
          batchId: 'batch-001',
          contentId: 'a'.repeat(64),
          replay: { index: 3, total: 11, status: 'replaying', version: 3, legacySeqNo: 1_893_702 },
        }));
      }
      if (url.endsWith('/api/cameras')) {
        return Promise.resolve(jsonResponse({
          provider: 'bkv',
          cameras: channels.map((channel) => ({
            ip: `bkv://camera-${channel.index}`,
            model: 'BKV legacy offline channel',
            sn: `BKV-${channel.index}`,
            source: 'bkv',
          })),
        }));
      }
      if (url.endsWith('/api/camera/status')) {
        return Promise.resolve(jsonResponse({
          provider: 'bkv',
          connected: false,
          deviceId: -1,
          ip: 'bkv://camera-1',
          acquisitionState: 'offline',
          sdkStatus: 'not-required',
        }));
      }
      if (url.endsWith('/api/camera/statuses')) {
        return Promise.resolve(jsonResponse({
          provider: 'bkv',
          statuses: channels.map((channel) => ({
            connected: false,
            deviceId: -1,
            ip: `bkv://camera-${channel.index}`,
            acquisitionState: 'offline',
            sdkStatus: 'not-required',
          })),
        }));
      }
      if (url.endsWith('/api/capture/logs')) {
        return Promise.resolve(jsonResponse({ events: [] }));
      }
      if (url.endsWith('/api/config')) {
        return Promise.resolve(jsonResponse({ capture: { provider: 'bkv', cameras: [] } }));
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected route' }, 404));
    });
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await readCaptureSnapshot();

    expect(snapshot.health?.provider).toBe('bkv');
    expect(snapshot.health?.provider === 'bkv' ? snapshot.health.replay?.index : null).toBe(3);
    expect(snapshot.statuses).toHaveLength(6);
    expect(snapshot.statuses.map((status) => status.ip)).toEqual(
      Array.from({ length: 6 }, (_, offset) => `bkv://camera-${offset + 1}`),
    );
    expect(snapshot.statuses.every((status) => (
      !status.connected && status.acquisitionState === 'offline'
    ))).toBe(true);
  });

  it('uses the external provider camera topology when admin config is unavailable', async () => {
    const providerCameras = [
      {
        cameraIndex: 1,
        cameraId: 'C1',
        ip: '192.168.101.144',
        model: 'RulerX',
        sn: '25440062',
        role: 'top',
        storageRoot: 'D:\\steel-sick-data\\C1',
        driverId: 'sick-gentl-harvesters',
        connected: true,
      },
      {
        cameraIndex: 2,
        cameraId: 'C2',
        ip: '192.168.102.206',
        model: 'RulerX',
        sn: '25440063',
        role: 'side',
        storageRoot: 'D:\\steel-sick-data\\C2',
        driverId: 'sick-gentl-harvesters',
        connected: true,
      },
    ];
    const statuses = providerCameras.map((camera) => ({
      ...camera,
      deviceId: camera.cameraIndex,
      connected: true,
      acquisitionState: 'acquiring',
      continuousAcquiring: true,
      continuousFps: 7.2,
      continuousFrameCount: 25,
    }));
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/config')) return Promise.resolve(jsonResponse({ error: 'admin token required' }, 401));
      if (url.endsWith('/api/capture/health')) {
        return Promise.resolve(jsonResponse({
          service: 'steel_sick_capture_sidecar',
          time: '2026-08-21T00:00:00Z',
          provider: 'external-api',
          sdkReady: true,
          sdkCode: 0,
          connected: true,
          ip: providerCameras[0].ip,
          cameraCount: 2,
          driverId: 'sick-gentl-harvesters',
        }));
      }
      if (url.endsWith('/api/cameras')) return Promise.resolve(jsonResponse({ cameras: providerCameras }));
      if (url.endsWith('/api/camera/status')) return Promise.resolve(jsonResponse(statuses[0]));
      if (url.endsWith('/api/camera/statuses')) return Promise.resolve(jsonResponse({ statuses }));
      if (url.endsWith('/api/capture/logs')) return Promise.resolve(jsonResponse({ events: [] }));
      return Promise.resolve(jsonResponse({ error: 'unexpected route' }, 404));
    }));

    const snapshot = await readCaptureSnapshot();

    expect(snapshot.config.cameras).toHaveLength(2);
    expect(snapshot.config.cameras.map((camera) => camera.ip)).toEqual(
      providerCameras.map((camera) => camera.ip),
    );
    expect(snapshot.config.cameras[0]).toMatchObject({
      id: 'C1',
      name: 'C1',
      role: 'top',
      outputPath: 'D:\\steel-sick-data\\C1',
    });
    expect(snapshot.statuses).toHaveLength(2);
    expect(snapshot.statuses[0]).toMatchObject({
      name: 'C1',
      connected: true,
      acquisitionState: 'acquiring',
      continuousAcquiring: true,
    });
  });

  it('types BKV capture evidence without exposing local paths', () => {
    const result: BkvProductionCommandResult = {
      code: 0,
      provider: 'bkv',
      source: 'bkv',
      sourceBadge: 'BKV 离线回放',
      offline: true,
      cameraCount: 6,
      batchId: 'batch-001',
      contentId: 'a'.repeat(64),
      legacySeqNo: 1_893_700,
      replay: { previousIndex: 0, index: 1, total: 11, status: 'replaying', version: 1 },
      artifacts: [],
    };
    expectTypeOf(result).toMatchTypeOf<ProductionCommandResult>();
    expect(result).not.toHaveProperty('localPath');
  });

  it('rejects forged d3img decode evidence that is not bound to the artifact hash', () => {
    expect(() => parseBkvArtifact({
      artifactRef: 'bkv://batch-001/artifacts/camera1/1893700/3d/0000.d3img',
      relativePath: 'artifacts/camera1/1893700/3d/0000.d3img',
      url: '/api/production/file?path=bkv%3A%2F%2Fbatch-001%2Fartifacts%2Fcamera1%2F1893700%2F3d%2F0000.d3img', authenticated: true,
      source: 'bkv', sourceBadge: 'BKV 离线回放', offline: true,
      sha256: 'a'.repeat(64), size: 12, cameraNumber: 1,
      legacySeqNo: 1_893_700, kind: '3d',
      depthDecode: {
        status: 'unsupported', reason: 'no_evidenced_decoder',
        probeSchema: 'steel.bkv-d3img-probe.v1', parserVersion: 'bkv-d3img-probe/1',
        originalSha256: 'b'.repeat(64), decoderAvailable: false,
      },
    })).toThrow(/decode evidence/i);
  });

  it('preserves manifest-authored unsupported and invalid d3img reasons', () => {
    const base = {
      artifactRef: 'bkv://batch-001/artifacts/camera1/1893700/3d/0000.d3img',
      relativePath: 'artifacts/camera1/1893700/3d/0000.d3img',
      url: '/api/production/file?path=bkv%3A%2F%2Fbatch-001%2Fartifacts%2Fcamera1%2F1893700%2F3d%2F0000.d3img',
      authenticated: true, source: 'bkv', sourceBadge: 'BKV 离线回放', offline: true,
      sha256: 'a'.repeat(64), size: 12, cameraNumber: 1,
      legacySeqNo: 1_893_700, kind: '3d',
    };
    for (const depthDecode of [
      {
        status: 'unsupported', reason: 'legacy_probe_unavailable',
        probeSchema: 'steel.bkv-d3img-probe.v1', parserVersion: 'bkv-d3img-probe/1',
        originalSha256: 'a'.repeat(64), decoderAvailable: false,
      },
      {
        status: 'invalid', reason: 'truncated_depth_header',
        probeSchema: 'steel.bkv-d3img-probe.v1', parserVersion: 'bkv-d3img-probe/1',
        originalSha256: 'a'.repeat(64), decoderAvailable: false,
      },
    ]) {
      expect(parseBkvArtifact({ ...base, depthDecode }).depthDecode?.reason)
        .toBe(depthDecode.reason);
    }
  });

  it('reads BKV artifact URLs with the authenticated records session', async () => {
    window.localStorage.setItem(
      'steel-inspection-admin-session',
      JSON.stringify({
        authenticated: true,
        token: 'records-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
        user: { id: 'operator-1', permissions: ['admin.records'] },
      }),
    );
    const artifact = {
      artifactRef: 'bkv://batch-001/artifacts/camera1/1893700/2d/0000.jpg',
      relativePath: 'artifacts/camera1/1893700/2d/0000.jpg',
      url: '/api/production/file?path=bkv%3A%2F%2Fbatch-001%2Fartifacts%2Fcamera1%2F1893700%2F2d%2F0000.jpg',
      authenticated: true,
      source: 'bkv',
      sourceBadge: 'BKV 离线回放',
      offline: true,
      sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
      size: 4,
      cameraNumber: 1,
      legacySeqNo: 1_893_700,
      kind: '2d',
      depthDecode: null,
    } satisfies BkvArtifact;
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const blob = await fetchBkvArtifact(artifact);

    expect(blob.size).toBe(4);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:4873/api/production/file?path=${encodeURIComponent(artifact.artifactRef)}`,
      {
        headers: expect.objectContaining({
          Accept: 'application/octet-stream',
          Authorization: 'Bearer records-token',
        }),
        signal: undefined,
      },
    );
  });

  it('rejects same-size BKV hash mismatches and HTML success bodies', async () => {
    const artifact = {
      artifactRef: 'bkv://batch-001/artifacts/camera1/1893700/2d/0000.jpg',
      relativePath: 'artifacts/camera1/1893700/2d/0000.jpg',
      url: '/api/production/file?path=bkv%3A%2F%2Fbatch-001%2Fartifacts%2Fcamera1%2F1893700%2F2d%2F0000.jpg', authenticated: true,
      source: 'bkv', sourceBadge: 'BKV 离线回放', offline: true,
      sha256: '0'.repeat(64), size: 4, cameraNumber: 1,
      legacySeqNo: 1_893_700, kind: '2d', depthDecode: null,
    } satisfies BkvArtifact;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200, headers: { 'Content-Type': 'image/jpeg' },
    })));
    await expect(fetchBkvArtifact(artifact)).rejects.toThrow(/hash mismatch/i);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<h1>proxy error</h1>', {
      status: 200, headers: { 'Content-Type': 'text/html' },
    })));
    await expect(fetchBkvArtifact({ ...artifact, size: 20 })).rejects.toThrow(/content type/i);
  });

  it('issues and queries immutable inspection report archives through the admin API', async () => {
    window.localStorage.setItem(
      'steel-inspection-admin-session',
      JSON.stringify({
        authenticated: true,
        token: 'report-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
        user: { id: 'operator-1', displayName: 'Operator', role: 'operator', permissions: ['admin.records'] },
      }),
    );
    const issued = {
      code: 0,
      created: true,
      reportId: 'RPT-INS-1-abc123',
      archivePath: 'reports/INS-1/RPT-INS-1-abc123.json',
      archive: {
        schema: 'steel.inspection.report-archive.v1',
        reportId: 'RPT-INS-1-abc123',
        inspectionId: 'INS-1',
        materialId: 'MAT-1',
        issuedAt: '2026-07-16 10:00:00',
        issuedBy: 'operator-1',
        documentSha256: 'abc123',
        document: {},
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(issued))
      .mockResolvedValueOnce(jsonResponse({ code: 0, inspectionId: 'INS-1', reports: [issued.archive] }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, archive: issued.archive }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await issueInspectionReportArchive('INS-1');
    const history = await fetchInspectionReportArchives('INS-1');
    const detail = await fetchInspectionReportArchive('INS-1', 'RPT-INS-1-abc123');

    expect(result.reportId).toBe('RPT-INS-1-abc123');
    expect(history.reports[0].documentSha256).toBe('abc123');
    expect(detail.archive.reportId).toBe('RPT-INS-1-abc123');
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4873/api/admin/records/reports');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer report-token' }),
      body: JSON.stringify({ inspectionId: 'INS-1' }),
    });
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://127.0.0.1:4873/api/admin/records/reports?inspectionId=INS-1',
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      'http://127.0.0.1:4873/api/admin/records/reports/detail?inspectionId=INS-1&reportId=RPT-INS-1-abc123',
    );
    expect(fetchMock.mock.calls[2][1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer report-token' }),
    });
  });

  it('surfaces an actionable failure when an immutable report archive is damaged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      code: 409,
      error: 'report_archive_integrity_failed',
      invalidArchiveCount: 1,
    }, 409)));

    await expect(fetchInspectionReportArchives('INS-1')).rejects.toThrow(
      '检测报告归档完整性校验失败，请停止打印并联系运维恢复归档',
    );
  });

  it('does not inject bundled defect images into an online database snapshot', async () => {
    const fixture = getMockInspectionSnapshot();
    const productionSnapshot = {
      ...fixture,
      source: 'sqlite-seaorm',
      defects: fixture.defects.map((defect) => ({ ...defect, previewImageUrl: '' })),
      inspections: fixture.inspections.map((inspection) => ({
        ...inspection,
        source: 'production',
        defects: inspection.defects.map((defect) => ({ ...defect, previewImageUrl: '' })),
      })),
      captureImages: [{
        id: 'CAPTURE-1',
        cameraId: 'camera1',
        cameraIp: '192.168.1.11',
        dataName: 'intensity',
        sequenceNo: 1,
        fileType: 'png',
        path: 'records/INS-1/intensity.png',
        url: '/api/production/file?path=records%2FINS-1%2Fintensity.png',
        createdAt: '2026-07-12 10:00:00',
      }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(productionSnapshot)));

    const snapshot = await fetchInspectionSnapshot();

    expect(snapshot.source).toBe('sqlite-seaorm');
    expect(snapshot.defects.every((defect) => defect.previewImageUrl === '')).toBe(true);
    expect(snapshot.inspections.flatMap((inspection) => inspection.defects).every((defect) => defect.previewImageUrl === '')).toBe(true);
    expect(snapshot.captureImages?.[0].url).toBe(
      'http://127.0.0.1:4873/api/production/file?path=records%2FINS-1%2Fintensity.png',
    );
  });

  it('uses the stable valid-region endpoint for SICK online intensity frames', async () => {
    const fixture = getMockInspectionSnapshot();
    const sourcePath = 'H:\\steel-sick-data\\2444\\capture\\C5\\2d\\219.png';
    const productionSnapshot = {
      ...fixture,
      source: 'sqlite-seaorm',
      captureImages: [{
        id: 'CAPTURE-SICK-C5',
        cameraId: 'C5',
        cameraIp: '192.168.105.190',
        dataName: 'intensity',
        sequenceNo: 220,
        fileType: 'png',
        path: sourcePath,
        url: `/api/production/file?path=${encodeURIComponent(sourcePath)}`,
        createdAt: '2026-08-23 14:49:00',
      }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(productionSnapshot)));

    const snapshot = await fetchInspectionSnapshot();

    expect(snapshot.captureImages?.[0].url).toBe(
      `http://127.0.0.1:4873/api/capture/file?path=${encodeURIComponent(sourcePath)}&maxWidth=2048&region=valid`,
    );
  });

  it('normalizes epoch timestamps and repairs malformed record clocks from inspection time', async () => {
    const fixture = getMockInspectionSnapshot();
    const epoch = '1787498686739';
    const productionSnapshot = {
      ...fixture,
      source: 'sqlite-seaorm',
      currentPlate: { ...fixture.currentPlate, detectedAt: epoch },
      records: [{ ...fixture.records[0], id: 'INSP-63', plateNo: '63', time: '67:39' }],
      inspections: [{
        ...fixture.inspections[0],
        inspectionId: 'INSP-63',
        plate: { ...fixture.inspections[0].plate, plateNo: '63', detectedAt: epoch },
      }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(productionSnapshot)));

    const snapshot = await fetchInspectionSnapshot();
    const expectedDate = new Date(Number(epoch));
    expect(snapshot.currentPlate.detectedAt).toBe(expectedDate.toLocaleString('zh-CN', { hour12: false }));
    expect(snapshot.inspections[0].plate.detectedAt).toBe(expectedDate.toLocaleString('zh-CN', { hour12: false }));
    expect(snapshot.records[0].time).toBe(expectedDate.toLocaleTimeString('zh-CN', { hour12: false }));
    expect(formatProductionRecordTime('19:00', epoch)).toBe('19:00');
    expect(formatProductionDateTime('2026-08-24 08:30:00')).toBe('2026-08-24 08:30:00');
  });

  it('reads database-backed defect history and resolves cached crop URLs', async () => {
    const defect = {
      ...getMockInspectionSnapshot().defects[0],
      id: 'SICK-63-C1-000001',
      plateNo: '63',
      previewImageUrl: '/api/capture/file?path=defect-crop.png',
      reviewStatus: 'pending',
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      schema: 'steel.production-defect-history.v1',
      code: 0,
      total: 1,
      defects: [defect],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const history = await fetchProductionDefectHistory();

    expect(history.total).toBe(1);
    expect(history.defects[0].previewImageUrl).toBe(
      'http://127.0.0.1:4873/api/capture/file?path=defect-crop.png',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4873/api/defects/history?limit=5000',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });

  it('writes defect review with the current authenticated operator session', async () => {
    window.localStorage.setItem(
      'steel-inspection-admin-session',
      JSON.stringify({
        authenticated: true,
        token: 'review-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
        user: { id: 'reviewer', permissions: ['admin.records'] },
      }),
    );
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      code: 0,
      defectId: 'SICK-63-C1-000001',
      reviewStatus: 'confirmed',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await reviewProductionDefect({
      defectId: 'SICK-63-C1-000001',
      status: 'confirmed',
      note: '人工确认',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4873/api/defects/review',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer review-token' }),
        body: JSON.stringify({
          defectId: 'SICK-63-C1-000001',
          status: 'confirmed',
          note: '人工确认',
        }),
      }),
    );
  });

  it('allows bundled defect fallbacks only for an explicitly marked demo response', async () => {
    const fixture = getMockInspectionSnapshot();
    const demoSnapshot = {
      ...fixture,
      source: 'demo',
      defects: fixture.defects.map((defect) => ({ ...defect, previewImageUrl: '' })),
      inspections: fixture.inspections.map((inspection) => ({
        ...inspection,
        source: 'demo',
        defects: inspection.defects.map((defect) => ({ ...defect, previewImageUrl: '' })),
      })),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(demoSnapshot)));

    const snapshot = await fetchInspectionSnapshot();

    expect(snapshot.source).toBe('demo');
    expect(snapshot.defects.every((defect) => defect.previewImageUrl.includes('/src/assets/mock-defects/'))).toBe(true);
  });

  it('keeps structured readiness details when the service reports HTTP 503', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: false,
        status: 'not-ready',
        service: 'steel-inspection-service',
        uptimeMs: 1200,
        checks: {
          database: { ok: true, status: 'up' },
          capture: { ok: false, status: 'unavailable', reason: 'capture_provider_unreachable' },
          calibrationReconciliation: {
            ok: false,
            status: 'reconciliation-required',
            unresolvedCount: 1,
            unresolvedOperations: [{
              operationId: 'apply-pending-42',
              kind: 'apply',
              status: 'needs-reconciliation',
            }],
            reason: 'calibration_reconciliation_required',
          },
          storage: { ok: false, status: 'unavailable', reason: 'storage_provider_unreachable' },
          trigger: { ok: true, status: 'up', required: true },
        },
      }, 503),
    );
    vi.stubGlobal('fetch', fetchMock);

    const health = await fetchServiceHealthDetails();

    expect(health.ok).toBe(false);
    expect(health.checks.capture?.reason).toBe('capture_provider_unreachable');
    expect(health.checks.calibrationReconciliation).toMatchObject({
      ok: false,
      unresolvedCount: 1,
      unresolvedOperations: [{ operationId: 'apply-pending-42' }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4873/api/health/details',
      { headers: { Accept: 'application/json' }, signal: undefined },
    );
  });

  it('routes steel events to explicit durable task endpoints with caller idempotency', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse({ code: 0, task: { taskId: 'TASK-1', status: 'queued' } }, 202)),
    );
    vi.stubGlobal('fetch', fetchMock);

    await writeProductionSteelInfo({ materialId: 'MAT-1', requestId: 'INFO-1' });
    await startProductionSteelIn({ materialId: 'MAT-1', requestId: 'IN-1' });
    await stopProductionSteelOut({ materialId: 'MAT-1', requestId: 'OUT-1' });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'http://127.0.0.1:4873/api/production/tasks/steel-info',
      'http://127.0.0.1:4873/api/production/tasks/steel-in',
      'http://127.0.0.1:4873/api/production/tasks/steel-out',
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      materialId: 'MAT-1',
      requestId: 'INFO-1',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      requestId: 'IN-1',
      autoCapture: true,
      discardBlackFrames: true,
    });
  });

  it('enqueues capture-once through the generic task API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ code: 0, task: { taskId: 'TASK-CAPTURE', status: 'queued' } }, 202),
    );
    vi.stubGlobal('fetch', fetchMock);

    await captureProductionOnce({
      materialId: 'MAT-1',
      sessionId: 'SESSION-1',
      requestId: 'CAPTURE-1',
      rounds: 1,
    });

    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4873/api/production/tasks');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      kind: 'capture-once',
      idempotencyKey: 'CAPTURE-1',
      maxAttempts: 1,
      payload: {
        materialId: 'MAT-1',
        sessionId: 'SESSION-1',
        requestId: 'CAPTURE-1',
        rounds: 1,
        autoCapture: false,
        discardBlackFrames: true,
      },
    });
  });

  it('preserves queued task identity returned through the trigger gateway', async () => {
    window.localStorage.setItem(
      'steel-inspection-admin-session',
      JSON.stringify({
        authenticated: true,
        token: 'operator-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
        user: {
          id: 'operator-1',
          displayName: 'Operator',
          role: 'operator',
          permissions: ['admin.services'],
        },
      }),
    );
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 0,
        gateway: 'steel-trigger-gateway',
        mode: 'manual',
        target: '/api/production/tasks/steel-in',
        service: {
          code: 0,
          task: {
            taskId: 'TASK-IN',
            kind: 'steel-in',
            materialId: 'MAT-1',
            sessionId: 'SESSION-1',
            status: 'queued',
          },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await triggerGatewayManualSteelIn({
      materialId: 'MAT-1',
      requestId: 'IN-1',
    });

    expect(result.task?.taskId).toBe('TASK-IN');
    expect(result.materialId).toBe('MAT-1');
    expect(result.sessionId).toBe('SESSION-1');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://127.0.0.1:4873/api/trigger/manual/steel-in',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      requestId: 'IN-1',
      present: true,
      value: 1,
    });
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer operator-token',
    });
  });
});
