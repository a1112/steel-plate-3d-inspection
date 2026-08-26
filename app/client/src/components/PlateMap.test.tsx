import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DefectItem, DefectType } from '../data/inspection';
import { createSequentialCameraLanes } from '../lib/camera-display';
import type { CaptureFlowSurface, CaptureSurfaceCameraTiles } from '../lib/capture-api';
import type { BarSurfaceMesh } from '../services/bar-surface-api';
import { fetchCaptureStitchHistory, type CaptureStitchResult } from '../services/capture-roi-api';
import { fetchInspectionWorldDefects, fetchInspectionWorldMeta, fetchInspectionWorldTile, type InspectionWorldMeta } from '../services/inspection-world-api';
import { cameraBandCropPadding, cameraBandRotationRadians, captureStitchInitialFrameIndex, mergeCameraBandCropWindow, PlateMap as ProductionPlateMap } from './PlateMap';

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
    fetchCaptureStitchHistory: vi.fn(),
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

function algorithmRoiUrl(materialId: string, cameraId: string, sequence: number) {
  const path = encodeURIComponent(`${materialId}/capture/${cameraId}/2d/${sequence}.png`);
  return `http://127.0.0.1:4873/api/capture/file?path=${path}&maxWidth=2048&region=valid&cropX=100&cropY=0&cropWidth=600&cropHeight=1024`;
}

function captureStitchResult(materialId: string, frameCount = 1): CaptureStitchResult {
  return {
    materialId,
    indexed: true,
    totalFrames: frameCount,
    hasMore: false,
    expectedCameraCount: 6,
    algorithmRoiImageCount: frameCount * 6,
    autoCropImageCount: 0,
    frames: Array.from({ length: frameCount }, (_, frameIndex) => {
      const sequence = frameIndex + 1;
      return {
        frameId: `${materialId}:${String(sequence).padStart(12, '0')}`,
        sequence,
        capturedAt: '2026-08-24T02:00:00.000Z',
        cameras: Array.from({ length: 6 }, (_unused, cameraIndex) => ({
          cameraId: `C${cameraIndex + 1}`,
          cameraIp: `192.168.10${cameraIndex + 1}.100`,
          artifactRef: `${materialId}/capture/C${cameraIndex + 1}/2d/${sequence}.png`,
          frameSequence: sequence,
          storageIndex: sequence,
          sourceWidth: 2560,
          sourceHeight: 1024,
          validRoi: [100, 0, 700, 1024],
          url: algorithmRoiUrl(materialId, `C${cameraIndex + 1}`, sequence),
          cropMode: 'algorithm-roi' as const,
        })),
      };
    }),
  };
}

function emptyCaptureStitchResult(materialId: string): CaptureStitchResult {
  return {
    materialId,
    indexed: true,
    totalFrames: 0,
    hasMore: false,
    expectedCameraCount: 6,
    algorithmRoiImageCount: 0,
    autoCropImageCount: 0,
    frames: [],
  };
}

function headAlignment(): NonNullable<CaptureFlowSurface['headAlignment']> {
  return {
    referenceCameraId: 'C1',
    origin: 'detected-steel-head',
    aligned: true,
    mode: 'capture-round-and-in-frame-row-padding',
    displayAligned: true,
    alignedTimelinePositionFrames: 4,
    timelineSpreadFrames: 2,
    maximumDisplayPaddingFrames: 2,
    cameras: Object.fromEntries(Array.from({ length: 6 }, (_, index) => {
      const cameraId = `C${index + 1}`;
      return [cameraId, {
        detected: true,
        offsetFramesFromReference: index === 1 ? -2 : 0,
        displayPaddingFrames: index === 1 ? 2 : 0,
        displayAligned: true,
      }];
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchInspectionWorldMeta).mockRejectedValue(new Error('no persisted world'));
  vi.mocked(fetchInspectionWorldDefects).mockRejectedValue(new Error('no persisted world'));
  vi.mocked(fetchInspectionWorldTile).mockImplementation(async (_record, tile) => ({ ...tile, url: 'blob:online-world', revoke: vi.fn() }));
  vi.mocked(fetchCaptureStitchHistory).mockImplementation(async (materialId) => (
    emptyCaptureStitchResult(materialId)
  ));
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

  it('keeps a conservative guard around automatically detected steel edges', () => {
    expect(cameraBandCropPadding(20)).toBe(6);
    expect(cameraBandCropPadding(200)).toBe(12);
  });

  it('keeps one expanding source-coordinate crop window for adjacent frames', () => {
    const first = mergeCameraBandCropWindow(undefined, { left: 0.27, right: 0.49 });
    const merged = mergeCameraBandCropWindow(first, { left: 0.25, right: 0.48 });
    expect(merged).toEqual({ left: 0.25, right: 0.49 });
    expect(mergeCameraBandCropWindow(merged, { left: 0.26, right: 0.47 })).toBe(merged);
  });

  it('lands a switched record on its first complete content-bearing frame', () => {
    const result = captureStitchResult('2747', 4);
    const frames = result.frames.map((frame, frameIndex) => ({
      ...frame,
      cameras: frame.cameras.map((camera, cameraIndex) => ({
        ...camera,
        sourceBytes: frameIndex < 2 || (frameIndex === 2 && cameraIndex === 5) ? 24_000 : 180_000,
      })),
    }));
    expect(captureStitchInitialFrameIndex(frames, 6)).toBe(3);
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

  it('does not leak unprocessed BKV CamImageSource frames into camera bands', () => {
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

    expect(screen.queryByLabelText(/实际裁剪图/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /采集图像/ })).toHaveLength(6);
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

  it('uses the current flow history as a horizontally scrollable six-camera crop stitch', async () => {
    vi.mocked(fetchCaptureStitchHistory).mockResolvedValue(captureStitchResult('2747', 12));

    render(
      <ProductionPlateMap
        {...common}
        artifactMode="production"
        inspectionId="INSP-unknown-material-1787509339423"
        captureMaterialId="2747"
        cameraLanes={createSequentialCameraLanes(6)}
        surfaceHeadAlignment={headAlignment()}
      />,
    );

    expect(await screen.findByTestId('capture-roi-status')).toHaveTextContent('12/12 轮裁剪拼接');
    const viewport = screen.getByTestId('capture-stitch-viewport');
    expect(viewport).toHaveAttribute('data-scroll-axis', 'x');
    expect(viewport).toHaveAttribute('data-frame-count', '12');
    expect(viewport).toHaveAttribute('data-head-aligned', 'true');
    expect(viewport).toHaveAttribute('data-head-display-padding-applied', 'true');
    expect(screen.getByTestId('head-alignment-summary')).toHaveTextContent(
      '头部已对齐参考 C1 · 最大补偿 2.00 帧',
    );
    const c1First = document.querySelector('.bar-camera-frame[data-camera-id="C1"][data-frame-sequence="1"]');
    const c2First = document.querySelector('.bar-camera-frame[data-camera-id="C2"][data-frame-sequence="1"]');
    expect(c1First).toHaveStyle({ left: '0px' });
    expect(c2First).toHaveStyle({ left: '352px' });
    expect(screen.getByRole('button', { name: /camera2 采集图像/ })).toHaveAttribute(
      'data-head-offset-frames',
      '-2.000000',
    );
    expect(document.querySelectorAll('.bar-camera-frame').length).toBeGreaterThan(6);
    expect(document.querySelectorAll('.bar-camera-frame').length).toBeLessThan(12 * 6);
    expect(screen.getAllByLabelText(/算法 ROI 裁剪图/).every((canvas) => (
      canvas.getAttribute('data-edge-policy') === 'source-roi'
    ))).toBe(true);
    expect(document.querySelectorAll('canvas[data-load-priority="high"]')).toHaveLength(6);
    expect(fetchCaptureStitchHistory).toHaveBeenCalledWith(
      '2747',
      ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
    );
    fireEvent.click(screen.getByRole('button', { name: '纵向' }));
    expect(viewport).toHaveAttribute('data-scroll-axis', 'y');
    expect(fetchInspectionWorldMeta).not.toHaveBeenCalled();
    expect(screen.queryByTestId('inspection-world-canvas')).not.toBeInTheDocument();
  });

  it('shows record-bound raw gray images while waiting and upgrades when stitch history appears', async () => {
    vi.useFakeTimers();
    const requestedImageUrls: string[] = [];
    const NativeImage = globalThis.Image;
    class RequestedImage {
      complete = false;
      naturalWidth = 0;
      naturalHeight = 0;
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      set src(value: string) { requestedImageUrls.push(value); }
    }
    vi.stubGlobal('Image', RequestedImage);
    vi.mocked(fetchCaptureStitchHistory)
      .mockResolvedValueOnce(emptyCaptureStitchResult('2747'))
      .mockResolvedValueOnce(captureStitchResult('2747', 2));
    try {
      render(
        <ProductionPlateMap
          {...common}
          artifactMode="production"
          inspectionId="INSP-unknown-material-1787509339423"
          captureMaterialId="2747"
          refreshCaptureRoi
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

      expect(screen.getByTestId('capture-roi-status')).toHaveTextContent('原始灰度 6/6 · 拼接历史尚未就绪');
      expect(screen.queryAllByLabelText(/实际裁剪图/)).toHaveLength(6);
      expect(requestedImageUrls).toHaveLength(6);
      expect(requestedImageUrls.every((url) => url.includes('/raw-'))).toBe(true);
      expect(fetchInspectionWorldMeta).not.toHaveBeenCalled();

      await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });

      expect(screen.getByTestId('capture-roi-status')).toHaveTextContent('2/2 轮裁剪拼接');
      expect(requestedImageUrls.length).toBeGreaterThan(6);
      expect(requestedImageUrls.slice(-12).every((url) => (
        url.includes('region=valid')
        && url.includes('cropX=100')
        && url.includes('cropWidth=600')
        && !url.includes('/raw-')
      ))).toBe(true);
      expect(fetchCaptureStitchHistory).toHaveBeenCalledTimes(2);
      expect(fetchInspectionWorldMeta).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal('Image', NativeImage);
      vi.useRealTimers();
    }
  });

  it('keeps record-bound raw frames visible while the stitch-history probe is pending', async () => {
    let resolveProbe: ((result: CaptureStitchResult) => void) | undefined;
    vi.mocked(fetchCaptureStitchHistory).mockReturnValue(new Promise((resolve) => {
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

    expect(screen.getByTestId('capture-roi-status')).toHaveTextContent('原始灰度 6/6 · 正在读取裁剪拼接');
    expect(screen.queryAllByLabelText(/实际裁剪图/)).toHaveLength(6);

    await act(async () => { resolveProbe?.(emptyCaptureStitchResult('2822')); });

    expect(screen.getByTestId('capture-roi-status')).toHaveTextContent('原始灰度 6/6 · 拼接历史尚未就绪');
    expect(screen.queryAllByLabelText(/实际裁剪图/)).toHaveLength(6);
  });

  it('never borrows stitch images from fallback material records', async () => {
    vi.mocked(fetchCaptureStitchHistory).mockImplementation(async (materialId) => (
      materialId === '2818'
        ? captureStitchResult('2818', 24)
        : emptyCaptureStitchResult(materialId)
    ));

    render(
      <ProductionPlateMap
        {...common}
        artifactMode="production"
        captureMaterialId="2822"
        captureRoiFallbackMaterialIds={['2821', '2818']}
        cameraLanes={createSequentialCameraLanes(6)}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('capture-roi-status')).toHaveTextContent('当前卷暂无可拼接灰度图'));
    expect(vi.mocked(fetchCaptureStitchHistory).mock.calls.map(([materialId]) => materialId)).toEqual(['2822']);
    expect(document.querySelectorAll('.bar-camera-frame')).toHaveLength(0);
  });

  it('shows a fail-closed state when neither an algorithm ROI nor a world is persisted', async () => {
    render(<ProductionPlateMap {...common} artifactMode="production" inspectionId="INS-LIVE-1" />);

    expect(await screen.findByText('当前卷暂无可拼接灰度图')).toBeInTheDocument();
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
      expect(screen.getByText('当前卷暂无可拼接灰度图')).toBeInTheDocument();

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
    expect(screen.getByTestId('plate-production-surface')).toHaveAttribute('data-artifact-color-mode', 'neutral');

    fireEvent.click(screen.getByRole('button', { name: /^点云$/ }));
    expect(screen.getByTestId('plate-production-point-cloud')).toHaveAttribute('data-artifact-source', 'production-record');
    expect(screen.queryByTestId('plate-point-cloud-view')).not.toBeInTheDocument();
  });

  it('uses the fused capture cross-section view for a record-bound SICK mesh', () => {
    const onPreviewPositionChange = vi.fn();
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
        inspectionId="INS-4034"
        surfaceMesh={{
          ...productionMesh,
          materialId: '4034',
          metricValid: false,
          displayMode: 'diagnostic-unqualified',
          validMask: new Uint8Array([1, 1, 1, 1]),
          longitudinalAxis: { absoluteScaleVerified: false },
        }}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={onPreviewPositionChange}
        onSelectDefect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '切面' }));
    expect(screen.getByTestId('capture-section-view')).toBeInTheDocument();
    expect(screen.queryByTestId('bkv-reconstruction-section')).not.toBeInTheDocument();
    expect(screen.getByText(/头部进度/)).toBeInTheDocument();
  });

  it('keeps point-cloud and section modes available when isolated rows have no triangles', () => {
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
        inspectionId="INS-SECTION-ONLY"
        surfaceMesh={{
          ...productionMesh,
          materialId: 'SECTION-ONLY',
          indices: new Uint32Array(),
          validMask: new Uint8Array([1, 1, 1, 1]),
          metricValid: false,
          displayMode: 'diagnostic-unqualified',
        }}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    expect(screen.getByTestId('plate-production-surface-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^点云$/ }));
    expect(screen.getByTestId('plate-production-point-cloud')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '切面' }));
    expect(screen.getByTestId('capture-section-view')).toBeInTheDocument();
  });

  it('keeps the original camera-band layout and only swaps in processed JET images', () => {
    const surfaceCameraTiles: CaptureSurfaceCameraTiles = {
      schema: 'steel.ranger3-camera-jet-tiles.v1',
      cameras: Array.from({ length: 6 }, (_, index) => ({
        cameraId: `C${index + 1}`,
        state: 'ready',
        rows: 2,
        columns: 2,
        jet: {
          palette: 'JET',
          imagePath: `D:\\capture\\surface-jet-c${index + 1}.png`,
        },
      })),
    };
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
        inspectionId="INS-PROD-JET"
        surfaceMesh={{ ...productionMesh, jetRangeMm: 0.18 }}
        surfaceCameraTiles={surfaceCameraTiles}
        surfaceHeadAlignment={headAlignment()}
        cameraLanes={createSequentialCameraLanes(6)}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Jet 平铺' }));
    expect(screen.getByTestId('surface-jet-unfolded')).toHaveAttribute('data-image-source', 'processed-jet-camera-images');
    expect(screen.getByTestId('capture-stitch-viewport')).toHaveAttribute(
      'data-head-display-padding-applied',
      'false',
    );
    expect(screen.getByRole('region', { name: '6 相机圆周展开缺陷图' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /采集图像/ })).toHaveLength(6);
    const jetImages = screen.getAllByLabelText(/处理后 JET 图/);
    expect(jetImages).toHaveLength(6);
  });
});
