import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BkvCompatibilityApp } from './BkvCompatibilityApp';

const { material } = vi.hoisted(() => ({ material: {
  legacySeqNo: 1893700,
  legacyCheckRecordSeqNo: 1451214,
  steelId: '253B09401250925A12004328',
  steelType: '37Mn/2',
  lengthMm: 12096,
  outerDiameterLegacyValue: 233.664,
  wallThicknessMm: null,
  inspectionTime: '2025-09-26 03:36:17',
  defects: [{ legacyDefectId: 2019096, classNo: 16, className: '轧折', cameraId: 2, grade: 2, confidence: 88 }],
  cameras: Array.from({ length: 6 }, (_, index) => ({
    cameraId: index + 1,
    mode: 'offline-file',
    twoDFrameCount: 21,
    npzFrameCount: 21,
    twoDFrames: [{ frameNo: 0, path: `camera-${index + 1}.jpg`, size: 3, sha256: 'a'.repeat(64) }],
    npzFrames: [{ frameNo: 0, path: `camera-${index + 1}.npz`, size: 3, sha256: 'b'.repeat(64) }],
  })),
  artifacts: {
    unwrapped: { path: 'unwrapped.png', size: 3, sha256: 'c'.repeat(64) },
    cylinder: { path: 'cylinder.json', size: 3, sha256: 'd'.repeat(64) },
    summary: { path: 'summary.json', size: 3, sha256: 'e'.repeat(64) },
  },
} }));

vi.mock('../services/bkv-api', async () => {
  const actual = await vi.importActual<typeof import('../services/bkv-api')>('../services/bkv-api');
  return {
    ...actual,
    fetchBkvMaterials: vi.fn().mockResolvedValue([material, { ...material, legacySeqNo: 1893701, steelId: 'STEEL-B' }]),
    fetchBkvArtifactBlobUrl: vi.fn().mockImplementation(async (path: string) => `blob:${path}`),
    fetchBkvCylinder: vi.fn().mockResolvedValue({
      schema: 'bkv-cylinder-preview.v1', longitudinal_samples: 2, angular_samples: 3,
      display_residual: [[0, 0.2, -0.1], [0.1, 0, -0.2]], valid_mask: [[true, true, true], [true, true, true]],
    }),
    nextBkvReplay: vi.fn().mockResolvedValue({ code: 0, provider: 'bkv', completed: false, capture: { legacySeqNo: 1893700 } }),
    resetBkvReplay: vi.fn().mockResolvedValue({ code: 0, provider: 'bkv' }),
  };
});

describe('BkvCompatibilityApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  it('clearly isolates offline BKV data and exposes 2D, unfolded and 3D views', async () => {
    render(<BkvCompatibilityApp status={{
      provider: 'bkv', ready: true, mode: 'offline-replay-no-camera-hardware', cameraMode: 'offline-file',
      cameraCount: 6, physicalCamerasOnline: 0, batchId: 'legacy-1893700-1893710', materialCount: 11,
      nextIndex: 0, nextLegacySeqNo: 1893700, completed: false,
    }} />);

    expect(await screen.findByText('BKV 离线回放')).toBeInTheDocument();
    expect(screen.getByText('6/6 离线数据')).toBeInTheDocument();
    expect(screen.getByText('真实相机在线 0')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('1893700');
    expect(screen.getByText('轧折')).toBeInTheDocument();
    expect(await screen.findAllByAltText(/离线二维图/)).toHaveLength(6);
    expect(screen.queryByText('连接相机')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'JIT 平铺展开' }));
    expect(await screen.findByAltText('1893700 JIT 平铺展开')).toHaveAttribute('src', 'blob:unwrapped.png');
    fireEvent.click(screen.getByRole('button', { name: '圆柱 3D' }));
    await waitFor(() => expect(screen.getByLabelText('1893700 BKV 圆柱三维预览')).toBeInTheDocument());
  });

  it('shows completed state and allows an explicit reset without hardware controls', async () => {
    render(<BkvCompatibilityApp status={{
      provider: 'bkv', ready: true, mode: 'offline-replay-no-camera-hardware', cameraMode: 'offline-file',
      cameraCount: 6, physicalCamerasOnline: 0, batchId: 'legacy-1893700-1893710', materialCount: 11,
      nextIndex: 11, nextLegacySeqNo: null, completed: true,
    }} />);
    expect(await screen.findByText('本批次回放已完成')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重置批次' })).toBeEnabled();
    expect(screen.getByText('硬件控制已禁用')).toBeInTheDocument();
  });
});
