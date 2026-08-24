import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DefectItem, DefectType } from '../data/inspection';
import { createSequentialCameraLanes } from '../lib/camera-display';
import type { BarSurfaceMesh } from '../services/bar-surface-api';
import { fetchCaptureRoiPreviews, type CaptureRoiPreviewResult } from '../services/capture-roi-api';
import { fetchInspectionWorldDefects, fetchInspectionWorldMeta, fetchInspectionWorldTile, type InspectionWorldMeta } from '../services/inspection-world-api';
import { cameraBandRotationRadians, PlateMap as ProductionPlateMap } from './PlateMap';

vi.mock('../services/inspection-world-api', async () => {
  const actual = await vi.importActual<typeof import('../services/inspection-world-api')>('../services/inspection-world-api');
  return {
    ...actual,
    fetchInspectionWorldMeta: vi.fn(),
    fetchInspectionWorldDefects: vi.fn(),
    fetchInspectionWorldTile: vi.fn(),
  };
});

vi.mock('../services/capture-roi-api', async () => {
  const actual = await vi.importActual<typeof import('../services/capture-roi-api')>('../services/capture-roi-api');
  return {
    ...actual,
    fetchCaptureRoiPreviews: vi.fn(),
  };
});

const onlineWorldMeta: InspectionWorldMeta = {
  schema: 'steel.inspection-world.meta.v1', provider: 'online', recordId: 'INS-WORLD-1', sourceFrameCount: 8,
  sourceRevision: 'online-revision',
  cache: { state: 'building', tileSize: 128, maxLevel: 10 },
  world: {
    width: 800, height: 1024, tileSize: 512, maxLevel: 10,
    cameras: Array.from({ length: 8 }, (_, index) => ({
      cameraId: index + 1, offsetX: index * 100, width: 100, height: 1024,
      frameWidth: 100, frameHeight: 1024, frameNumbers: [0],
      orientation: { frameOrder: 'ascending', rotation: 0, flipX: false, flipY: false },
    })),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchInspectionWorldMeta).mockRejectedValue(new Error('no persisted world'));
  vi.mocked(fetchInspectionWorldDefects).mockRejectedValue(new Error('no persisted world'));
  vi.mocked(fetchInspectionWorldTile).mockImplementation(async (_record, tile) => ({ ...tile, url: 'blob:online-world', revoke: vi.fn() }));
  vi.mocked(fetchCaptureRoiPreviews).mockResolvedValue(null);
});

// These legacy interaction cases intentionally exercise the bundled demo/test
// visualization. Production behavior is covered separately below.
function PlateMap(props: ComponentProps<typeof ProductionPlateMap>) {
  return <ProductionPlateMap artifactMode="demo" {...props} />;
}

const defectTypes: DefectType[] = [
  { id: 'pit', label: '凹坑', color: '#2f6bff', shape: 'circle' },
  { id: 'roll', label: '辊印', color: '#ff7f1f', shape: 'square' },
];

describe('line-scan image orientation', () => {
  it('keeps acquisition rows vertical and rotates them toward the right in horizontal mode', () => {
    expect(cameraBandRotationRadians('vertical')).toBe(0);
    expect(cameraBandRotationRadians('horizontal')).toBe(-Math.PI / 2);
  });
});

describe('parameterized camera lanes', () => {
  it('keeps exactly six configured camera slots even when every image is missing', () => {
    render(
      <PlateMap
        defectTypes={defectTypes}
        defects={[]}
        defectTypeCounts={{}}
        hiddenTypeIds={new Set()}
        selectedDefectId={null}
        surfaceMode="all"
        previewPositionM={0}
        cameraLanes={createSequentialCameraLanes(6)}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    expect(screen.getByRole('region', { name: '6 相机圆周展开缺陷图' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /采集图像/ })).toHaveLength(6);
    expect(screen.getByText('C6')).toBeInTheDocument();
    expect(screen.queryByText('C7')).not.toBeInTheDocument();
    expect(screen.queryByText('C8')).not.toBeInTheDocument();
  });

  it('maps BKV CamImageSource identities into all six main-view camera bands', () => {
    render(
      <PlateMap
        defectTypes={defectTypes}
        defects={[]}
        defectTypeCounts={{}}
        hiddenTypeIds={new Set()}
        selectedDefectId={null}
        surfaceMode="all"
        previewPositionM={0}
        cameraLanes={createSequentialCameraLanes(6)}
        captureImages={Array.from({ length: 6 }, (_, index) => ({
          id: `bkv-camera-${index + 1}`,
          cameraId: `camera${index + 1}`,
          cameraIp: `CamImageSource${index + 1}`,
          dataName: 'intensity',
          sequenceNo: 0,
          fileType: 'bmp',
          path: `\\\\10.5.241.17\\CamImageSource${index + 1}\\1902352\\2D\\0000.bmp`,
          url: `http://127.0.0.1:4873/api/bkv-online/image?camera=${index + 1}&seq=1902352&index=0&kind=2d`,
          createdAt: '2026-07-24 20:18:19',
        }))}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    expect(screen.getAllByLabelText(/实际裁剪图/)).toHaveLength(6);
    expect(screen.getByLabelText('camera1 实际裁剪图')).toBeInTheDocument();
    expect(screen.getByLabelText('camera6 实际裁剪图')).toBeInTheDocument();
  });

  it('shows an explicit empty state instead of a zero-camera canvas', () => {
    render(
      <PlateMap
        defectTypes={defectTypes}
        defects={[]}
        defectTypeCounts={{}}
        hiddenTypeIds={new Set()}
        selectedDefectId={null}
        surfaceMode="all"
        previewPositionM={0}
        cameraLanes={[]}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('未配置 2D 相机');
    expect(screen.queryByRole('region', { name: /相机圆周展开缺陷图/ })).not.toBeInTheDocument();
  });
});

describe('online inspection world compatibility', () => {
  const common = {
    defectTypes,
    defects: [],
    defectTypeCounts: {},
    hiddenTypeIds: new Set<string>(),
    selectedDefectId: null,
    surfaceMode: 'all' as const,
    previewPositionM: 0,
    cameraLanes: createSequentialCameraLanes(8),
    onToggleType: vi.fn(),
    onSurfaceModeChange: vi.fn(),
    onPreviewPositionChange: vi.fn(),
    onSelectDefect: vi.fn(),
  };

  it('uses the shared tiled Canvas for a persisted online inspection world', async () => {
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), strokeRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.mocked(fetchInspectionWorldMeta).mockResolvedValue(onlineWorldMeta);
    vi.mocked(fetchInspectionWorldDefects).mockResolvedValue({
      schema: 'steel.inspection-world.defects.v1', provider: 'online', recordId: 'INS-WORLD-1', defects: [],
    });

    render(<ProductionPlateMap {...common} artifactMode="production" inspectionId="INS-WORLD-1" />);

    expect(await screen.findByTestId('inspection-world-canvas')).toBeInTheDocument();
    expect(screen.getAllByTestId('inspection-world-camera')).toHaveLength(8);
    expect(screen.queryByText('实时预览')).not.toBeInTheDocument();
    context.mockRestore();
  });

  it('uses the numeric flow playback index for six algorithm ROI bands without probing missing world metadata', async () => {
    const roiResult: CaptureRoiPreviewResult = {
      materialId: '2747',
      indexed: true,
      totalFrames: 187,
      representativeFrameId: '2747:000000008769',
      expectedCameraCount: 6,
      complete: true,
      images: Array.from({ length: 6 }, (_, index) => ({
        id: `capture-roi:2747:C${index + 1}:8769`,
        cameraId: `C${index + 1}`,
        cameraIp: `192.168.10${index + 1}.100`,
        dataName: 'intensity',
        sequenceNo: 126,
        fileType: 'png',
        path: `2747/capture/C${index + 1}/2d/126.png`,
        url: `http://127.0.0.1:4873/api/capture/file?camera=C${index + 1}&region=valid`,
        createdAt: '2026-08-24T02:00:00.000Z',
        validRoi: [100, 0, 700, 1024],
        sourceFrameId: '2747:000000008769',
        sourceFrameSequence: 8769,
        sourceWidth: 2560,
        sourceHeight: 1024,
      })),
    };
    vi.mocked(fetchCaptureRoiPreviews).mockResolvedValue(roiResult);

    render(
      <ProductionPlateMap
        {...common}
        artifactMode="production"
        inspectionId="INSP-unknown-material-1787509339423"
        captureMaterialId="2747"
        cameraLanes={createSequentialCameraLanes(6)}
      />,
    );

    expect(await screen.findByTestId('capture-roi-status')).toHaveTextContent('算法 ROI 6/6');
    expect(screen.getAllByLabelText(/实际裁剪图/)).toHaveLength(6);
    expect(fetchCaptureRoiPreviews).toHaveBeenCalledWith(
      '2747',
      ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
    );
    expect(fetchInspectionWorldMeta).not.toHaveBeenCalled();
    expect(screen.queryByTestId('inspection-world-canvas')).not.toBeInTheDocument();
  });

  it('keeps the record-bound capture fallback while waiting and upgrades when the ROI index appears', async () => {
    vi.useFakeTimers();
    const roiResult: CaptureRoiPreviewResult = {
      materialId: '2747',
      indexed: true,
      totalFrames: 20,
      representativeFrameId: '2747:000000000020',
      expectedCameraCount: 6,
      complete: true,
      images: Array.from({ length: 6 }, (_, index) => ({
        id: `roi-${index + 1}`,
        cameraId: `C${index + 1}`,
        cameraIp: `192.168.10${index + 1}.100`,
        dataName: 'intensity',
        sequenceNo: 20,
        fileType: 'png',
        path: `2747/capture/C${index + 1}/2d/20.png`,
        url: `http://127.0.0.1:4873/roi-C${index + 1}.jpg`,
        createdAt: '2026-08-24T02:00:00.000Z',
        validRoi: [100, 0, 700, 1024],
        sourceFrameId: '2747:000000000020',
        sourceFrameSequence: 20,
        sourceWidth: 2560,
        sourceHeight: 1024,
      })),
    };
    vi.mocked(fetchCaptureRoiPreviews)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(roiResult);
    try {
      render(
        <ProductionPlateMap
          {...common}
          artifactMode="production"
          inspectionId="INSP-unknown-material-1787509339423"
          captureMaterialId="2747"
          cameraLanes={createSequentialCameraLanes(6)}
          captureImages={Array.from({ length: 6 }, (_, index) => ({
            id: `raw-${index + 1}`,
            cameraId: `C${index + 1}`,
            cameraIp: `192.168.10${index + 1}.100`,
            dataName: 'intensity',
            sequenceNo: 1,
            fileType: 'png',
            path: `2747/capture/C${index + 1}/2d/1.png`,
            url: `http://127.0.0.1:4873/raw-C${index + 1}.png`,
            createdAt: '2026-08-24T01:59:00.000Z',
          }))}
        />,
      );
      await act(async () => { await Promise.resolve(); });

      expect(screen.getByTestId('capture-roi-status')).toHaveTextContent('采集裁剪预览');
      expect(screen.getAllByLabelText(/实际裁剪图/)).toHaveLength(6);
      expect(fetchInspectionWorldMeta).not.toHaveBeenCalled();

      await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });

      expect(screen.getByTestId('capture-roi-status')).toHaveTextContent('算法 ROI 6/6');
      expect(fetchCaptureRoiPreviews).toHaveBeenCalledTimes(2);
      expect(fetchInspectionWorldMeta).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not request raw frame images until the ROI catalog probe has settled', async () => {
    let resolveProbe: ((result: CaptureRoiPreviewResult | null) => void) | undefined;
    vi.mocked(fetchCaptureRoiPreviews).mockReturnValue(new Promise((resolve) => {
      resolveProbe = resolve;
    }));
    const rawImages = Array.from({ length: 6 }, (_, index) => ({
      id: `raw-pending-${index + 1}`,
      cameraId: `C${index + 1}`,
      cameraIp: `192.168.10${index + 1}.100`,
      dataName: 'intensity',
      sequenceNo: 1,
      fileType: 'png',
      path: `2822/capture/C${index + 1}/2d/1.png`,
      url: `http://127.0.0.1:4873/pending-raw-C${index + 1}.png`,
      createdAt: '2026-08-24T04:00:00.000Z',
    }));
    render(
      <ProductionPlateMap
        {...common}
        artifactMode="production"
        captureMaterialId="2822"
        cameraLanes={createSequentialCameraLanes(6)}
        captureImages={rawImages}
      />,
    );

    expect(screen.getByTestId('capture-roi-status')).toHaveTextContent('正在读取算法 ROI');
    expect(screen.queryAllByLabelText(/实际裁剪图/)).toHaveLength(0);

    await act(async () => { resolveProbe?.(null); });

    expect(screen.getByTestId('capture-roi-status')).toHaveTextContent('采集裁剪预览');
    expect(screen.getAllByLabelText(/实际裁剪图/)).toHaveLength(6);
  });

  it('temporarily shows the latest complete ROI flow and keeps probing the current flow', async () => {
    vi.useFakeTimers();
    const makeResult = (materialId: string): CaptureRoiPreviewResult => ({
      materialId,
      indexed: true,
      totalFrames: 24,
      representativeFrameId: `${materialId}:000000000024`,
      expectedCameraCount: 6,
      complete: true,
      images: Array.from({ length: 6 }, (_, index) => ({
        id: `roi-${materialId}-${index + 1}`,
        cameraId: `C${index + 1}`,
        cameraIp: `192.168.10${index + 1}.100`,
        dataName: 'intensity',
        sequenceNo: 24,
        fileType: 'png',
        path: `${materialId}/capture/C${index + 1}/2d/24.png`,
        url: `http://127.0.0.1:4873/${materialId}-C${index + 1}.jpg`,
        createdAt: '2026-08-24T04:00:00.000Z',
        validRoi: [100, 0, 700, 1024],
        sourceFrameId: `${materialId}:000000000024`,
        sourceFrameSequence: 24,
        sourceWidth: 2560,
        sourceHeight: 1024,
      })),
    });
    const currentResult = makeResult('2822');
    const fallbackResult = makeResult('2818');
    let currentReady = false;
    vi.mocked(fetchCaptureRoiPreviews).mockImplementation(async (materialId) => {
      if (materialId === '2822') return currentReady ? currentResult : null;
      if (materialId === '2818') return fallbackResult;
      return null;
    });

    try {
      render(
        <ProductionPlateMap
          {...common}
          artifactMode="production"
          captureMaterialId="2822"
          captureRoiFallbackMaterialIds={['2821', '2818']}
          cameraLanes={createSequentialCameraLanes(6)}
        />,
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByTestId('capture-roi-status')).toHaveTextContent('算法 ROI 6/6 · 回退流水 2818');
      expect(vi.mocked(fetchCaptureRoiPreviews).mock.calls.map(([materialId]) => materialId)).toEqual([
        '2822',
        '2821',
        '2818',
      ]);

      currentReady = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });

      expect(screen.getByTestId('capture-roi-status')).toHaveTextContent('算法 ROI 6/6');
      expect(screen.getByTestId('capture-roi-status')).not.toHaveTextContent('回退流水');
      expect(fetchCaptureRoiPreviews).toHaveBeenLastCalledWith(
        '2822',
        ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('labels the existing camera bands as a live preview when no world is persisted', async () => {
    render(<ProductionPlateMap {...common} artifactMode="production" inspectionId="INS-LIVE-1" />);

    expect(await screen.findByText('采集裁剪预览')).toBeInTheDocument();
    expect(screen.queryByTestId('inspection-world-canvas')).not.toBeInTheDocument();
    expect(screen.getByTestId('bar-unfolded-map')).toBeInTheDocument();
  });

  it('upgrades a live preview when the first persisted frame becomes available', async () => {
    vi.useFakeTimers();
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), strokeRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    try {
      vi.mocked(fetchInspectionWorldMeta)
        .mockRejectedValueOnce(new Error('no frames yet'))
        .mockResolvedValue(onlineWorldMeta);
      vi.mocked(fetchInspectionWorldDefects).mockResolvedValue({
        schema: 'steel.inspection-world.defects.v1', provider: 'online', recordId: 'INS-WORLD-1', defects: [],
      });
      render(<ProductionPlateMap {...common} artifactMode="production" inspectionId="INS-WORLD-1" />);
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByText('采集裁剪预览')).toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

      expect(screen.getByTestId('inspection-world-canvas')).toBeInTheDocument();
      expect(fetchInspectionWorldMeta).toHaveBeenCalledTimes(2);
    } finally {
      context.mockRestore();
      vi.useRealTimers();
    }
  });

  it('shows only a BKV world loading state while the first record metadata is pending', () => {
    vi.mocked(fetchInspectionWorldMeta).mockImplementation(() => new Promise(() => undefined));

    render(
      <ProductionPlateMap
        {...common}
        artifactMode="production"
        inspectionId="1893700"
        requireInspectionWorld
      />,
    );

    expect(screen.getByRole('status', {
      name: '正在加载 BKV 检测图像世界',
    })).toBeInTheDocument();
    expect(screen.queryByTestId('bar-unfolded-map')).not.toBeInTheDocument();
  });

  it('keeps the painted record visible until the next record paints its first tile', async () => {
    const images: Array<{ onload: null | (() => void) }> = [];
    class ManualImage {
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      set src(_value: string) { images.push(this); }
    }
    vi.stubGlobal('Image', ManualImage);
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([], this); }
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), strokeRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.mocked(fetchInspectionWorldMeta).mockImplementation(async (recordId) => ({
      ...onlineWorldMeta,
      recordId,
    }));
    vi.mocked(fetchInspectionWorldDefects).mockImplementation(async (recordId) => ({
      schema: 'steel.inspection-world.defects.v1',
      provider: 'bkv',
      recordId,
      defects: [],
    }));

    const { rerender } = render(
      <ProductionPlateMap
        {...common}
        artifactMode="production"
        inspectionId="1893700"
        requireInspectionWorld
      />,
    );
    await act(async () => Promise.resolve());
    await act(async () => images.forEach((image) => image.onload?.()));
    await screen.findByTestId('inspection-world-canvas');
    expect(screen.getByTestId('inspection-world-viewport')).toHaveAttribute('data-record-id', '1893700');

    const previousImageCount = images.length;
    rerender(
      <ProductionPlateMap
        {...common}
        artifactMode="production"
        inspectionId="1893701"
        requireInspectionWorld
      />,
    );

    expect(screen.getByTestId('inspection-world-viewport')).toHaveAttribute('data-record-id', '1893700');
    expect(screen.getByRole('status', {
      name: '正在切换 BKV 检测记录',
    })).toBeInTheDocument();
    await waitFor(() => expect(images.length).toBeGreaterThan(previousImageCount));
    await waitFor(() => expect(screen.getByRole('status', {
      name: '首屏瓦片加载进度',
    })).toHaveTextContent(/首屏瓦片 \d+\/\d+/));

    const nextRecordImages = images.slice(previousImageCount);
    await act(async () => nextRecordImages[0]?.onload?.());
    await waitFor(() => {
      expect(screen.getByTestId('inspection-world-viewport')).toHaveAttribute('data-record-id', '1893701');
    });
    await act(async () => nextRecordImages.slice(1).forEach((image) => image.onload?.()));
    await waitFor(() => {
      expect(screen.getByTestId('inspection-world-viewport')).toHaveAttribute('data-record-id', '1893701');
    });
    expect(images.length).toBe(previousImageCount + nextRecordImages.length);
    expect(screen.queryByRole('status', {
      name: '正在切换 BKV 检测记录',
    })).not.toBeInTheDocument();
  });
});

const defects: DefectItem[] = [
  {
    id: 'D-TOP',
    plateNo: 'P-001',
    typeId: 'pit',
    typeLabel: '凹坑',
    surface: 'top',
    severity: 'severe',
    distanceHeadMm: 1000,
    operatorSideMm: 100,
    driveSideMm: 200,
    widthMm: 0.4,
    heightMm: 0.3,
    depthMm: -0.12,
    xRatio: 0.25,
    yOffsetMm: 0.5,
    previewX: 50,
    previewY: 50,
    previewImageUrl: '/mock-defect-pit.png',
  },
  {
    id: 'D-BOTTOM',
    plateNo: 'P-001',
    typeId: 'roll',
    typeLabel: '辊印',
    surface: 'bottom',
    severity: 'minor',
    distanceHeadMm: 2000,
    operatorSideMm: 140,
    driveSideMm: 240,
    widthMm: 0.5,
    heightMm: 0.2,
    depthMm: -0.06,
    xRatio: 0.6,
    yOffsetMm: -0.4,
    previewX: 60,
    previewY: 60,
    previewImageUrl: '',
  },
];

const defectTypeCounts = {
  pit: 1,
  roll: 1,
};

const productionMesh: BarSurfaceMesh = {
  schema: 'steel.bar-surface.mesh.v1',
  coordinateUnit: 'mm',
  cameraCount: 1,
  frameStems: ['frame-001'],
  rows: 2,
  colsPerCamera: 2,
  positions: new Float32Array([
    0, 0, 0,
    1, 0, 0.1,
    0, 1, 0.2,
    1, 1, 0.3,
  ]),
  uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
  colors: new Float32Array([
    0.1, 0.5, 0.9,
    0.2, 0.6, 0.8,
    0.3, 0.7, 0.7,
    0.4, 0.8, 0.6,
  ]),
  indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
};

describe('PlateMap', () => {
  it('shows clear selected and cancelled states for defect legend toggles', () => {
    const onToggleType = vi.fn();
    render(
      <PlateMap
        defectTypes={defectTypes}
        defects={[]}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set(['roll'])}
        selectedDefectId={null}
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        artifactMode="demo"
        onToggleType={onToggleType}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    const selectedToggle = screen.getByRole('button', { name: '凹坑 1 个已选中，点击取消' });
    const cancelledToggle = screen.getByRole('button', { name: '辊印 1 个已取消，点击选中' });

    expect(selectedToggle).toHaveAttribute('aria-pressed', 'true');
    expect(selectedToggle).toHaveClass('is-selected');
    expect(selectedToggle).toHaveTextContent('凹坑1');
    expect(cancelledToggle).toHaveAttribute('aria-pressed', 'false');
    expect(cancelledToggle).toHaveClass('is-cancelled');
    expect(cancelledToggle).toHaveTextContent('辊印1');

    fireEvent.click(cancelledToggle);
    expect(onToggleType).toHaveBeenCalledWith('roll');
  });

  it('renders a single eight-camera unfolded map instead of top and bottom surfaces', () => {
    const onSurfaceModeChange = vi.fn();
    render(
      <PlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId={null}
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        onToggleType={vi.fn()}
        onSurfaceModeChange={onSurfaceModeChange}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: '棒材圆周展开缺陷图' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '8 相机圆周展开缺陷图' })).toBeInTheDocument();
    expect(screen.getByTestId('bar-unfolded-map')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '相机区显示切换' })).not.toBeInTheDocument();
    expect(screen.queryByText('上表面')).not.toBeInTheDocument();
    expect(screen.queryByText('下表面')).not.toBeInTheDocument();
    expect(screen.queryByText('camera1', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('camera8', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText('C1')).toBeInTheDocument();
    expect(screen.getByText('C8')).toBeInTheDocument();
    expect(onSurfaceModeChange).not.toHaveBeenCalled();
  });

  it('expands one camera on double click and restores the eight-camera view', () => {
    render(
      <PlateMap
        defectTypes={defectTypes}
        defects={[]}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId={null}
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    fireEvent.doubleClick(screen.getByRole('button', { name: 'camera1 采集图像，双击展开' }));
    expect(screen.getByTestId('bar-unfolded-map')).toHaveAttribute('data-expanded-camera', 'camera1');
    fireEvent.doubleClick(screen.getByRole('button', { name: 'camera1 采集图像，已展开，双击恢复' }));
    expect(screen.getByTestId('bar-unfolded-map')).not.toHaveAttribute('data-expanded-camera');
  });

  it('keeps the existing map as 2D and can switch to the 3D plate view', () => {
    render(
      <PlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId="D-TOP"
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '2D' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('slider', { name: '预览位置' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '3D' }));

    expect(screen.getByRole('button', { name: '3D' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('plate-map-3d-view')).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: '预览位置' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^点云$/ }));

    expect(screen.getByRole('button', { name: /^点云$/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('plate-point-cloud-view')).toBeInTheDocument();
    expect(screen.queryByTestId('plate-map-3d-view')).not.toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: '预览位置' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '2D' }));
    expect(screen.getByRole('slider', { name: '预览位置' })).toBeInTheDocument();
  });

  it('renders point-cloud mode as camera-zone height unfolded maps', () => {
    render(
      <PlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId="D-TOP"
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    fireEvent.click(screen.getByRole('button', { name: /^点云$/ }));
    const view = screen.getByTestId('plate-point-cloud-view');

    expect(Number(view.getAttribute('data-point-cloud-points'))).toBeGreaterThan(5000);
    expect(screen.getByText('1-3号相机 3D 高度展开图')).toBeInTheDocument();
    expect(screen.getByText('4-6号相机 3D 高度展开图')).toBeInTheDocument();
    expect(screen.getByLabelText('1-3号相机高度色标')).toBeInTheDocument();
    expect(screen.getByLabelText('4-6号相机高度色标')).toBeInTheDocument();
    expect(screen.getByLabelText('凹坑点云标注，1-3号相机，距头1000mm')).toBeInTheDocument();
    expect(screen.getByLabelText('辊印点云标注，4-6号相机，距头2000mm')).toBeInTheDocument();
  });

  it('limits 3D view control to horizontal dragging', () => {
    render(
      <PlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId="D-TOP"
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    const view = screen.getByTestId('plate-map-3d-view');
    expect(view).toHaveAttribute('data-view-yaw', '0.000');

    const verticalPointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(verticalPointerDown, 'button', { value: 0 });
    Object.defineProperty(verticalPointerDown, 'clientX', { value: 300 });
    Object.defineProperty(verticalPointerDown, 'pointerId', { value: 8 });
    fireEvent(view, verticalPointerDown);

    const verticalPointerMove = new Event('pointermove', { bubbles: true, cancelable: true });
    Object.defineProperty(verticalPointerMove, 'clientX', { value: 300 });
    Object.defineProperty(verticalPointerMove, 'pointerId', { value: 8 });
    fireEvent(view, verticalPointerMove);
    expect(view).toHaveAttribute('data-view-yaw', '0.000');

    const verticalPointerUp = new Event('pointerup', { bubbles: true, cancelable: true });
    Object.defineProperty(verticalPointerUp, 'pointerId', { value: 8 });
    fireEvent(view, verticalPointerUp);

    const horizontalPointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(horizontalPointerDown, 'button', { value: 0 });
    Object.defineProperty(horizontalPointerDown, 'clientX', { value: 300 });
    Object.defineProperty(horizontalPointerDown, 'pointerId', { value: 9 });
    fireEvent(view, horizontalPointerDown);

    const horizontalPointerMove = new Event('pointermove', { bubbles: true, cancelable: true });
    Object.defineProperty(horizontalPointerMove, 'clientX', { value: 360 });
    Object.defineProperty(horizontalPointerMove, 'pointerId', { value: 9 });
    fireEvent(view, horizontalPointerMove);
    expect(view).toHaveAttribute('data-view-yaw', '0.240');
  });

  it('zooms the 3D plate view with the mouse wheel', () => {
    render(
      <PlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId="D-TOP"
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    const view = screen.getByTestId('plate-map-3d-view');

    expect(view).toHaveAttribute('data-view-zoom', '1.00');
    expect(screen.getByText('缩放倍率')).toBeInTheDocument();
    expect(screen.getByText('1.00x')).toBeInTheDocument();

    fireEvent.wheel(view, { deltaY: -120 });
    expect(view).toHaveAttribute('data-view-zoom', '1.12');
    expect(screen.getByText('1.12x')).toBeInTheDocument();

    fireEvent.wheel(view, { deltaY: 120 });
    expect(view).toHaveAttribute('data-view-zoom', '1.00');
  });

  it('shows a defect detail card on marker hover and keyboard focus', () => {
    render(
      <PlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId="D-TOP"
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    const marker = screen.getByRole('button', { name: '凹坑，camera3，距头1000mm' });
    fireEvent.mouseEnter(marker);

    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '凹坑缺陷小图' })).toHaveAttribute('src', '/mock-defect-pit.png');
    expect(screen.getByText('D-TOP')).toBeInTheDocument();
    expect(screen.getByText('严重')).toBeInTheDocument();
    expect(screen.getByText('0.40 x 0.30 x 0.12mm')).toBeInTheDocument();

    fireEvent.mouseLeave(marker);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.focus(marker);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('switches selected defects with keyboard arrows and mouse wheel on the 2D strip', () => {
    const onSelectDefect = vi.fn();
    const { rerender } = render(
      <PlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId="D-TOP"
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={onSelectDefect}
      />,
    );

    const unfoldedMap = screen.getByRole('region', { name: '8 相机圆周展开缺陷图' });
    fireEvent.keyDown(unfoldedMap, { key: 'ArrowRight' });
    expect(onSelectDefect).toHaveBeenLastCalledWith('D-BOTTOM');

    rerender(
      <PlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId="D-BOTTOM"
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={onSelectDefect}
      />,
    );

    const rerenderedMap = screen.getByRole('region', { name: '8 相机圆周展开缺陷图' });
    fireEvent.wheel(rerenderedMap, { deltaY: -120 });
    expect(onSelectDefect).toHaveBeenLastCalledWith('D-TOP');

    fireEvent.keyDown(rerenderedMap, { key: 'End' });
    expect(onSelectDefect).toHaveBeenLastCalledWith('D-BOTTOM');
  });

  it('updates the preview position from click and drag on the length ruler', () => {
    const onPreviewPositionChange = vi.fn();
    render(
      <PlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId={null}
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={onPreviewPositionChange}
        onSelectDefect={vi.fn()}
      />,
    );

    const ruler = screen.getByRole('slider', { name: '预览位置' });
    Object.defineProperty(ruler, 'getBoundingClientRect', {
      value: vi.fn(
        () =>
          ({
            left: 100,
            right: 1300,
            width: 1200,
            height: 44,
            top: 0,
            bottom: 44,
            x: 100,
            y: 0,
            toJSON: () => ({}),
          }) as DOMRect,
      ),
    });

    const pointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(pointerDown, 'clientX', { value: 900 });
    Object.defineProperty(pointerDown, 'pointerId', { value: 1 });
    fireEvent(ruler, pointerDown);
    expect(onPreviewPositionChange).toHaveBeenLastCalledWith(8);

    const pointerMove = new Event('pointermove', { bubbles: true, cancelable: true });
    Object.defineProperty(pointerMove, 'clientX', { value: 1000 });
    Object.defineProperty(pointerMove, 'pointerId', { value: 1 });
    fireEvent(ruler, pointerMove);
    expect(onPreviewPositionChange).toHaveBeenLastCalledWith(9);

    const pointerUp = new Event('pointerup', { bubbles: true, cancelable: true });
    Object.defineProperty(pointerUp, 'pointerId', { value: 1 });
    fireEvent(ruler, pointerUp);

    fireEvent.mouseDown(ruler, { clientX: 700 });
    expect(onPreviewPositionChange).toHaveBeenLastCalledWith(6);

    fireEvent.mouseMove(ruler, { clientX: 500 });
    expect(onPreviewPositionChange).toHaveBeenLastCalledWith(4);

    fireEvent.keyDown(ruler, { key: 'ArrowLeft' });
    expect(onPreviewPositionChange).toHaveBeenLastCalledWith(5.9);
  });

  it('renders the preview cursor on the unfolded eight-camera map', () => {
    render(
      <PlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId={null}
        surfaceMode="all"
        previewPositionM={3}
        plateLengthM={12}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    expect(screen.getByTestId('preview-cursor-unfolded')).toHaveStyle({ left: '25%' });
    expect(screen.getByRole('slider', { name: '预览位置' })).toHaveAttribute('aria-valuenow', '3');
  });

  it('fails closed in production when the selected record has no 3D or point-cloud artifact', () => {
    render(
      <ProductionPlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId="D-TOP"
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        inspectionId="INS-PROD-1"
        artifactStatus="记录尚未生成算法产物"
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    expect(screen.getByRole('note')).toHaveTextContent('生产记录 INS-PROD-1');
    expect(screen.queryByText(/演示\/测试数据/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    expect(screen.getByTestId('plate-production-surface-empty')).toHaveTextContent('暂无生产三维表面产物');
    expect(screen.queryByTestId('plate-map-3d-view')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^点云$/ }));
    expect(screen.getByTestId('plate-production-point-cloud-empty')).toHaveTextContent('暂无生产点云产物');
    expect(screen.queryByTestId('plate-point-cloud-view')).not.toBeInTheDocument();
  });

  it('renders only the record-bound production mesh in 3D and point-cloud modes', () => {
    render(
      <ProductionPlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId="D-TOP"
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        inspectionId="INS-PROD-2"
        surfaceMesh={productionMesh}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    expect(screen.getByTestId('plate-production-surface')).toHaveAttribute('data-artifact-source', 'production-record');
    expect(screen.getByTestId('plate-production-surface')).toHaveAttribute('data-artifact-points', '4');
    expect(screen.getByTestId('plate-production-surface')).toHaveAttribute('data-artifact-triangles', '2');

    fireEvent.click(screen.getByRole('button', { name: /^点云$/ }));
    expect(screen.getByTestId('plate-production-point-cloud')).toHaveAttribute('data-artifact-source', 'production-record');
    expect(screen.queryByTestId('plate-point-cloud-view')).not.toBeInTheDocument();
  });
});
