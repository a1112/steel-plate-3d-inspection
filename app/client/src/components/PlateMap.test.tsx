import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DefectItem, DefectType } from '../data/inspection';
import { createSequentialCameraLanes } from '../lib/camera-display';
import {
  readCaptureDefects,
  readCaptureRegions,
  type CaptureFlowMeasurement,
  type CaptureFlowSurface,
  type CaptureRegionMap,
  type CaptureSurfaceCameraTiles,
} from '../lib/capture-api';
import type { BarSurfaceMesh } from '../services/bar-surface-api';
import { fetchCaptureStitchHistory, type CaptureStitchResult } from '../services/capture-roi-api';
import { readCaptureRawDepthValue, sampleJetResidualMm } from '../services/capture-depth-probe';
import { fetchInspectionWorldDefects, fetchInspectionWorldMeta, fetchInspectionWorldTile, type InspectionWorldMeta } from '../services/inspection-world-api';
import { cameraBandCropPadding, cameraBandRotationRadians, captureFrameLongitudinalAspect, capturePrefetchFrameIndexes, captureStitchInitialFrameIndex, mergeCameraBandCropWindow, normalizeOwnedColumnIntervals, PlateMap as ProductionPlateMap, remapOwnedColumnRange, restoreOwnedColumnRatio } from './PlateMap';

vi.mock('../lib/capture-api', async () => {
  const actual = await vi.importActual<typeof import('../lib/capture-api')>('../lib/capture-api');
  return {
    ...actual,
    readCaptureDefects: vi.fn(),
    readCaptureRegions: vi.fn(),
  };
});

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

vi.mock('../services/capture-depth-probe', async () => {
  const actual = await vi.importActual<typeof import('../services/capture-depth-probe')>('../services/capture-depth-probe');
  return {
    ...actual,
    sampleJetResidualMm: vi.fn(),
    readCaptureRawDepthValue: vi.fn(),
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

function renderUrl(materialId: string, cameraId: string, sequence: number, modality: 'gray' | 'jet', level: 'thumbnail' | 'original') {
  const path = encodeURIComponent(`${materialId}/capture/${cameraId}/2d/${sequence}.png`);
  return `http://127.0.0.1:4873/api/capture/render?path=${path}&modality=${modality}&level=${level}`;
}

function captureStitchResult(materialId: string, frameCount = 1): CaptureStitchResult {
  return {
    materialId,
    indexed: true,
    totalFrames: frameCount,
    hasMore: false,
    expectedCameraCount: 6,
    renderableImageCount: frameCount * 6,
    frames: Array.from({ length: frameCount }, (_, frameIndex) => {
      const sequence = frameIndex + 1;
      return {
        frameId: `${materialId}:${String(sequence).padStart(12, '0')}`,
        sequence,
        capturedAt: new Date(Date.parse('2026-08-24T02:00:00.000Z') + frameIndex * 100).toISOString(),
        cameras: Array.from({ length: 6 }, (_unused, cameraIndex) => ({
          cameraId: `C${cameraIndex + 1}`,
          cameraIp: `192.168.10${cameraIndex + 1}.100`,
          artifactRef: `${materialId}/capture/C${cameraIndex + 1}/2d/${sequence}.png`,
          frameSequence: sequence,
          storageIndex: sequence,
          sourceWidth: 2560,
          sourceHeight: 1024,
          validRoi: [100, 0, 700, 1024],
          url: renderUrl(materialId, `C${cameraIndex + 1}`, sequence, 'gray', 'thumbnail'),
          grayThumbnailUrl: renderUrl(materialId, `C${cameraIndex + 1}`, sequence, 'gray', 'thumbnail'),
          grayOriginalUrl: renderUrl(materialId, `C${cameraIndex + 1}`, sequence, 'gray', 'original'),
          jetThumbnailUrl: renderUrl(materialId, `C${cameraIndex + 1}`, sequence, 'jet', 'thumbnail'),
          jetOriginalUrl: renderUrl(materialId, `C${cameraIndex + 1}`, sequence, 'jet', 'original'),
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
    renderableImageCount: 0,
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

function captureRegionMap(materialId: string): CaptureRegionMap {
  return {
    schema: 'steel.capture-region-map.v1',
    materialId,
    state: 'ready',
    backgroundReady: true,
    defectDetectionAllowed: true,
    qualityGate: { passed: true, reasons: [] },
    calibration: { revision: 'cal-1', approved: true, sha256: 'a'.repeat(64) },
    ownership: {
      ready: true,
      reasons: [],
      overlapPairCount: 6,
      pairs: Array.from({ length: 6 }, (_, index) => ({
        cameras: [`C${index + 1}`, `C${(index + 1) % 6 + 1}`],
        angleIntervalsDeg: [[index * 60, index * 60 + 10]],
        binCount: 100,
      })),
    },
    cameras: Object.fromEntries(Array.from({ length: 6 }, (_, index) => {
      const cameraId = `C${index + 1}`;
      return [cameraId, {
        cameraId,
        state: 'ready',
        sourceSize: [2560, 1024],
        stableCrop: [100, 0, 700, 1024],
        sourceOffset: { x: 100, y: 0 },
        displaySize: [600, 1024],
        ownedColumnIntervals: [[100, 550]],
        overlapColumnIntervals: [[500, 700]],
      }];
    })),
  };
}

function captureSurfaceCameraTiles(): CaptureSurfaceCameraTiles {
  const ownedColumnCount = 450;
  return {
    schema: 'steel.ranger3-camera-jet-tiles.v1',
    coordinateSpace: 'camera-crop-columns',
    angleConvention: 'clockwise-degrees-0-360',
    rowOrder: 'head-to-tail',
    cameras: Array.from({ length: 6 }, (_, index) => {
      const cameraId = `C${index + 1}`;
      const lowerAngle = index * 60;
      const upperAngle = (index + 1) * 60;
      const reverseColumns = index % 2 === 1;
      return {
        cameraId,
        state: 'ready',
        fixedAngleDeg: lowerAngle + 30,
        sourceShape: [1024, 2560],
        cropBox: [100, 0, 700, 1024],
        sourceOffset: { x: 100, y: 0 },
        rows: 30,
        columns: 600,
        coordinateLayout: 'row-major-camera-crop',
        angleDegByColumn: Array.from({ length: 600 }, (_unused, column) => {
          const angleOffset = (column + 0.5) * 60 / ownedColumnCount;
          return reverseColumns ? upperAngle - angleOffset : lowerAngle + angleOffset;
        }),
        coverage: {
          ownedAngleIntervalsDeg: [[lowerAngle, upperAngle]],
          ownedColumnIntervals: [[100, 550]],
          overlapColumnIntervals: [[500, 700]],
        },
      };
    }),
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
  vi.mocked(sampleJetResidualMm).mockResolvedValue(0.25);
  vi.mocked(readCaptureRawDepthValue).mockResolvedValue(1842);
  vi.mocked(readCaptureRegions).mockRejectedValue(new Error('no region map'));
  vi.mocked(readCaptureDefects).mockRejectedValue(new Error('no defect manifest'));
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
  it('normalizes owned source columns and remaps a defect into concatenated space', () => {
    const intervals = normalizeOwnedColumnIntervals(
      [[90, 180], [170, 240], [300, 360], [500, 510]],
      [100, 0, 400, 1024],
    );

    expect(intervals).toEqual([
      [0, 140 / 300],
      [200 / 300, 260 / 300],
    ]);
    const remapped = remapOwnedColumnRange(0.7, 0.8, intervals);
    expect(remapped?.[0]).toBeCloseTo(150 / 200);
    expect(remapped?.[1]).toBeCloseTo(180 / 200);
    expect(remapOwnedColumnRange(0.5, 0.6, intervals)).toBeNull();
    expect(restoreOwnedColumnRatio(0.75, intervals)).toBeCloseTo(210 / 300);
  });

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

  it('selects a bounded ring of frames outside the rendered overscan window', () => {
    expect(capturePrefetchFrameIndexes(20, 6, 10)).toEqual([2, 3, 4, 5, 10, 11, 12, 13]);
    expect(capturePrefetchFrameIndexes(5, 0, 4)).toEqual([4]);
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
    const stitch = captureStitchResult('2747', 12);
    const onVisibleRangeChange = vi.fn();
    stitch.frames.forEach((frame, frameIndex) => frame.cameras.forEach((camera) => {
      camera.sourceBytes = frameIndex >= 9 ? 24 * 1024 : 256 * 1024;
    }));
    vi.mocked(fetchCaptureStitchHistory).mockResolvedValue(stitch);

    render(
      <ProductionPlateMap
        {...common}
        artifactMode="production"
        inspectionId="INSP-unknown-material-1787509339423"
        captureMaterialId="2747"
        cameraLanes={createSequentialCameraLanes(6)}
        surfaceHeadAlignment={headAlignment()}
        onVisibleRangeChange={onVisibleRangeChange}
      />,
    );

    expect(await screen.findByTestId('capture-roi-status')).toHaveTextContent('12/12 轮对齐拼接');
    const viewport = screen.getByTestId('capture-stitch-viewport');
    expect(viewport).toHaveAttribute('data-scroll-axis', 'x');
    expect(viewport).toHaveAttribute('data-frame-count', '12');
    expect(viewport).toHaveAttribute('data-prefetch-frame-count', '4');
    expect(viewport).toHaveAttribute('data-prefetch-image-count', '24');
    expect(viewport).toHaveAttribute('data-head-aligned', 'true');
    expect(viewport).toHaveAttribute('data-head-display-padding-applied', 'true');
    expect(viewport).toHaveAttribute('data-head-retained-context-frames', '0.35');
    expect(viewport).toHaveAttribute('data-timeline-origin-frames', '2.650000');
    expect(viewport).toHaveAttribute('data-tail-trim-applied', 'true');
    expect(viewport).toHaveAttribute('data-tail-detection-source', 'frame-density');
    expect(viewport).toHaveAttribute('data-tail-content-frame-index', '8');
    expect(viewport).toHaveAttribute('data-tail-timeline-frame', '11.000000');
    expect(viewport).toHaveAttribute('data-tail-retained-context-frames', '0.35');
    expect(viewport).toHaveAttribute('data-timeline-end-frames', '11.350000');
    expect(viewport).toHaveAttribute('data-longitudinal-extent-px', '1531.200');
    expect(screen.queryByTestId('head-alignment-summary')).not.toBeInTheDocument();
    const c1First = document.querySelector('.bar-camera-frame[data-camera-id="C1"][data-frame-sequence="1"]');
    const c2First = document.querySelector('.bar-camera-frame[data-camera-id="C2"][data-frame-sequence="1"]');
    expect(Number.parseFloat((c1First as HTMLElement).style.left)).toBeCloseTo(-466.4, 5);
    expect(Number.parseFloat((c2First as HTMLElement).style.left)).toBeCloseTo(-114.4, 5);
    const c1AlignedHead = document.querySelector('.bar-camera-frame[data-camera-id="C1"][data-frame-sequence="4"]');
    const c2AlignedHead = document.querySelector('.bar-camera-frame[data-camera-id="C2"][data-frame-sequence="2"]');
    expect(Number.parseFloat((c1AlignedHead as HTMLElement).style.left)).toBeCloseTo(61.6, 5);
    expect(Number.parseFloat((c2AlignedHead as HTMLElement).style.left)).toBeCloseTo(61.6, 5);
    expect(screen.getByRole('button', { name: /camera2 采集图像/ })).toHaveAttribute(
      'data-head-offset-frames',
      '-2.000000',
    );
    const ruler = screen.getByRole('slider', { name: '预览位置' });
    const scrollbar = screen.getByRole('scrollbar', { name: '展开图滚动位置' });
    expect(screen.getByTestId('bar-unfolded-map')).toContainElement(ruler);
    expect(ruler).toContainElement(scrollbar);
    expect(scrollbar).toHaveAttribute('aria-orientation', 'horizontal');
    Object.defineProperty(ruler, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        right: 600,
        bottom: 24,
        width: 600,
        height: 24,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    fireEvent.click(scrollbar, { clientX: 450, clientY: 20 });
    expect(common.onPreviewPositionChange).toHaveBeenLastCalledWith(9);
    expect(document.querySelectorAll('.bar-camera-frame').length).toBeGreaterThan(6);
    expect(document.querySelectorAll('.bar-camera-frame').length).toBeLessThan(12 * 6);
    expect(screen.getAllByLabelText(/2D 去背景图/).every((canvas) => (
      canvas.getAttribute('data-edge-policy') === 'source-roi'
    ))).toBe(true);
    expect(document.querySelectorAll('canvas[data-load-priority="high"]')).toHaveLength(6);
    fireEvent.doubleClick(screen.getByLabelText('C2 裁剪拼接帧'));
    expect(screen.getByTestId('bar-unfolded-map')).toHaveAttribute('data-expanded-camera', 'camera2');
    fireEvent.doubleClick(screen.getByLabelText('C2 裁剪拼接帧'));
    expect(screen.getByTestId('bar-unfolded-map')).not.toHaveAttribute('data-expanded-camera');
    expect(fetchCaptureStitchHistory).toHaveBeenCalledWith(
      '2747',
      ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
    );
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 360 },
      scrollWidth: { configurable: true, value: 2400 },
      scrollLeft: { configurable: true, value: 600, writable: true },
    });
    fireEvent(window, new Event('resize'));
    expect(onVisibleRangeChange).toHaveBeenLastCalledWith([0.25, 0.5]);
    expect(viewport).toHaveAttribute('data-visible-range-start', '0.250000');
    expect(viewport).toHaveAttribute('data-visible-range-end', '0.500000');
    const cameraBand = screen.getByRole('button', { name: 'camera2 采集图像，双击展开' });
    expect(cameraBand.querySelector(':scope > span')).toHaveTextContent('C2');
    expect(cameraBand.querySelector(':scope > span')).not.toHaveTextContent('头偏移');
    const steadyPointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperties(steadyPointerDown, {
      button: { value: 0 },
      clientX: { value: 500 },
      clientY: { value: 200 },
      pointerId: { value: 40 },
    });
    fireEvent(cameraBand, steadyPointerDown);
    const steadyPointerMove = new Event('pointermove', { bubbles: true, cancelable: true });
    Object.defineProperties(steadyPointerMove, {
      clientX: { value: 496 },
      clientY: { value: 200 },
      pointerId: { value: 40 },
    });
    fireEvent(cameraBand, steadyPointerMove);
    const steadyPointerUp = new Event('pointerup', { bubbles: true, cancelable: true });
    Object.defineProperties(steadyPointerUp, {
      clientX: { value: 496 },
      clientY: { value: 200 },
      pointerId: { value: 40 },
    });
    fireEvent(cameraBand, steadyPointerUp);
    expect(viewport.scrollLeft).toBe(600);
    const secondPointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperties(secondPointerDown, {
      button: { value: 0 },
      clientX: { value: 496 },
      clientY: { value: 200 },
      pointerId: { value: 42 },
    });
    fireEvent(cameraBand, secondPointerDown);
    const secondPointerUp = new Event('pointerup', { bubbles: true, cancelable: true });
    Object.defineProperties(secondPointerUp, {
      clientX: { value: 496 },
      clientY: { value: 200 },
      pointerId: { value: 42 },
    });
    fireEvent(cameraBand, secondPointerUp);
    expect(screen.getByTestId('bar-unfolded-map')).toHaveAttribute('data-expanded-camera', 'camera2');
    expect(viewport).toHaveAttribute('data-expanded-preserve-aspect', 'true');
    expect(viewport).toHaveAttribute('data-frame-pixel-aspect', '1.706667');
    expect(viewport).toHaveAttribute('data-frame-span-px', '614.400');
    fireEvent.keyDown(cameraBand, { key: 'Enter' });
    expect(screen.getByTestId('bar-unfolded-map')).not.toHaveAttribute('data-expanded-camera');
    expect(viewport).toHaveAttribute('data-frame-span-px', '176.000');
    fireEvent.pointerMove(cameraBand, { pointerId: 43, clientX: 420, clientY: 200 });
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    expect(screen.getByTestId('bar-unfolded-map')).toHaveAttribute('data-expanded-camera', 'camera2');
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    expect(screen.getByTestId('bar-unfolded-map')).not.toHaveAttribute('data-expanded-camera');
    const dragPointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperties(dragPointerDown, {
      button: { value: 0 },
      clientX: { value: 500 },
      clientY: { value: 200 },
      pointerId: { value: 41 },
    });
    fireEvent(cameraBand, dragPointerDown);
    expect(viewport).toHaveClass('is-dragging');
    const dragPointerMove = new Event('pointermove', { bubbles: true, cancelable: true });
    Object.defineProperties(dragPointerMove, {
      clientX: { value: 350 },
      clientY: { value: 200 },
      pointerId: { value: 41 },
    });
    fireEvent(cameraBand, dragPointerMove);
    expect(viewport.scrollLeft).toBe(750);
    const dragPointerUp = new Event('pointerup', { bubbles: true, cancelable: true });
    Object.defineProperties(dragPointerUp, {
      clientX: { value: 350 },
      clientY: { value: 200 },
      pointerId: { value: 41 },
    });
    fireEvent(cameraBand, dragPointerUp);
    expect(viewport).not.toHaveClass('is-dragging');
    expect(screen.getByTestId('bar-unfolded-map')).not.toHaveAttribute('data-expanded-camera');
    fireEvent.keyDown(cameraBand, { key: 'Enter' });
    expect(screen.getByTestId('bar-unfolded-map')).toHaveAttribute('data-expanded-camera', 'camera2');
    fireEvent.keyDown(cameraBand, { key: 'Enter' });
    expect(screen.getByTestId('bar-unfolded-map')).not.toHaveAttribute('data-expanded-camera');
    fireEvent.click(screen.getByRole('button', { name: '纵向' }));
    expect(viewport).toHaveAttribute('data-scroll-axis', 'y');
    expect(scrollbar).toHaveAttribute('aria-orientation', 'vertical');
    expect(fetchInspectionWorldMeta).not.toHaveBeenCalled();
    expect(screen.queryByTestId('inspection-world-canvas')).not.toBeInTheDocument();
  });

  it('derives the expanded frame aspect from the visible source ROI', () => {
    const frame = captureStitchResult('2747').frames[0].cameras[0];
    expect(captureFrameLongitudinalAspect(frame)).toBeCloseTo(1024 / 600, 6);
    expect(captureFrameLongitudinalAspect(frame, [[0, 0.75]])).toBeCloseTo(1024 / 450, 6);
  });

  it('shows fitted-cylinder depth on hover and raw camera depth while T is held', async () => {
    vi.mocked(fetchCaptureStitchHistory).mockResolvedValue(captureStitchResult('2747', 1));
    const measurement: CaptureFlowMeasurement = {
      schema: 'steel.ranger3-flow-measurement.v1',
      generatedAt: '2026-08-24T02:00:00.000Z',
      materialId: '2747',
      mode: 'metric',
      metricValid: true,
      qualityGate: { passed: true, reasons: [] },
      selectedSection: {},
      cameras: {},
      surfaceFit: {
        available: true,
        metricValid: true,
        sections: [
          { positionRatio: 0, metricValid: true, circleFit: { available: true, diameterMm: 76.669 } },
        ],
      },
    };
    render(
      <ProductionPlateMap
        {...common}
        artifactMode="production"
        captureMaterialId="2747"
        cameraLanes={createSequentialCameraLanes(6)}
        surfaceMeasurement={measurement}
      />,
    );

    await screen.findByTestId('capture-roi-status');
    const frame = document.querySelector('.bar-camera-frame[data-camera-id="C2"][data-frame-sequence="1"]') as HTMLElement;
    expect(frame).toBeInTheDocument();
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 176, bottom: 100,
      width: 176, height: 100, toJSON: () => ({}),
    });
    const move = new Event('pointermove', { bubbles: true });
    Object.defineProperties(move, {
      clientX: { value: 88 },
      clientY: { value: 50 },
      pointerId: { value: 9 },
    });
    fireEvent(frame, move);

    const probe = await screen.findByRole('status', { name: '3D 深度探针' });
    await waitFor(() => expect(probe).toHaveTextContent('+0.250 mm'));
    expect(probe).toHaveTextContent('相对拟合圆柱');
    expect(probe).toHaveTextContent('测径76.669 mm');
    expect(probe).toHaveTextContent('源像素 400, 512');

    fireEvent.keyDown(window, { code: 'KeyT', key: 't' });
    await waitFor(() => expect(probe).toHaveAttribute('data-probe-mode', 'raw'));
    await waitFor(() => expect(probe).toHaveTextContent('1842'));
    expect(readCaptureRawDepthValue).toHaveBeenCalledWith(
      '2747/capture/C2/2d/1.png',
      400,
      512,
    );

    fireEvent.keyUp(window, { code: 'KeyT', key: 't' });
    await waitFor(() => expect(probe).toHaveAttribute('data-probe-mode', 'relative'));
  });

  it('keeps camera expansion available without showing a native double-click description', async () => {
    vi.mocked(fetchCaptureStitchHistory).mockResolvedValue(captureStitchResult('2747', 1));
    render(
      <ProductionPlateMap
        {...common}
        artifactMode="production"
        captureMaterialId="2747"
        cameraLanes={createSequentialCameraLanes(6)}
      />,
    );

    await screen.findByTestId('capture-roi-status');
    const camera = screen.getByRole('button', { name: 'camera2 采集图像，双击展开' });
    expect(camera).not.toHaveAttribute('title');
    fireEvent.doubleClick(camera);
    expect(camera).toHaveAttribute('aria-label', 'camera2 采集图像，已展开，双击恢复');
    expect(camera).not.toHaveAttribute('title');
  });

  it('marks a frame ROI with a rectangle and repeats the defect on the distance ruler', async () => {
    vi.mocked(fetchCaptureStitchHistory).mockResolvedValue(captureStitchResult('4034', 3));
    const onSelectDefect = vi.fn();
    const frameDefect: DefectItem = {
      ...defects[0],
      id: 'SICK-4034-C2-000001',
      plateNo: '4034',
      cameraId: 'C2',
      cameraIndex: 2,
      distanceHeadMm: 3_000,
      detectionConfidence: 0.95,
      artifacts: {
        schema: 'steel.surface.defect.artifacts.v1',
        cameraId: 'C2',
        frameId: '2',
        sequenceNo: 2,
        roi: { x: 200, y: 100, width: 50, height: 120 },
      },
    };

    render(
      <ProductionPlateMap
        {...common}
        artifactMode="production"
        inspectionId="INSP-4034"
        captureMaterialId="4034"
        cameraLanes={createSequentialCameraLanes(6)}
        defects={[frameDefect]}
        defectTypes={defectTypes}
        defectTypeCounts={{ pit: 1 }}
        selectedDefectId={frameDefect.id}
        onSelectDefect={onSelectDefect}
      />,
    );

    const frameMarker = await screen.findByRole('button', { name: /凹坑矩形标记，C2 文件序号 2/ });
    expect(frameMarker).toHaveClass('selected');
    expect(frameMarker).toHaveStyle({ left: '9.765625%', width: '11.71875%' });
    fireEvent.mouseEnter(frameMarker, { clientX: 700, clientY: 620 });
    const hoverCard = screen.getByTestId('defect-frame-hover-card');
    expect(hoverCard).toHaveClass('frame-preview');
    expect(screen.getByRole('img', { name: '凹坑缺陷大图' })).toHaveAttribute(
      'src',
      '/mock-defect-pit.png',
    );
    expect(hoverCard).toHaveTextContent('C2');
    expect(hoverCard).toHaveTextContent('2 / 2');
    expect(hoverCard).toHaveTextContent('200, 100 · 50×120px');
    expect(hoverCard).toHaveTextContent('95%');
    fireEvent.mouseLeave(frameMarker);
    expect(screen.queryByTestId('defect-frame-hover-card')).not.toBeInTheDocument();
    const rulerMarker = screen.getByRole('button', { name: '凹坑位置，距头3000毫米' });
    expect(rulerMarker).toHaveClass('selected');
    fireEvent.click(frameMarker);
    fireEvent.click(rulerMarker);
    expect(onSelectDefect).toHaveBeenNthCalledWith(1, frameDefect.id);
    expect(onSelectDefect).toHaveBeenNthCalledWith(2, frameDefect.id);
  });

  it('does not show record-bound raw PNGs while rebuilding stitch cache and upgrades when history appears', async () => {
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

      expect(screen.getByTestId('capture-roi-status')).toHaveTextContent('拼接缓存尚未就绪 · 已发现 6/6 路原图，等待重建');
      expect(screen.queryAllByLabelText(/实际裁剪图/)).toHaveLength(0);
      expect(requestedImageUrls).toHaveLength(0);
      expect(fetchInspectionWorldMeta).not.toHaveBeenCalled();

      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });

      expect(screen.getByTestId('capture-roi-status')).toHaveTextContent('2/2 轮对齐拼接');
      expect(requestedImageUrls.length).toBeGreaterThan(0);
      expect(requestedImageUrls.every((url) => (
        url.includes('/api/capture/render')
        && url.includes('modality=gray')
        && url.includes('level=thumbnail')
        && !url.includes('/raw-')
      ))).toBe(true);
      expect(fetchCaptureStitchHistory).toHaveBeenCalledTimes(2);
      expect(fetchInspectionWorldMeta).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal('Image', NativeImage);
      vi.useRealTimers();
    }
  });

  it('keeps record-bound raw PNGs hidden while the stitch-history probe is pending or empty', async () => {
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

    expect(screen.getByTestId('capture-roi-status')).toHaveTextContent('拼接缓存准备中 · 正在校验索引并从原图按需重建');
    expect(screen.queryAllByLabelText(/实际裁剪图/)).toHaveLength(0);

    await act(async () => { resolveProbe?.(emptyCaptureStitchResult('2822')); });

    expect(screen.getByTestId('capture-roi-status')).toHaveTextContent('拼接缓存尚未就绪 · 已发现 6/6 路原图，等待重建');
    expect(screen.queryAllByLabelText(/实际裁剪图/)).toHaveLength(0);
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

    await waitFor(() => expect(screen.getByTestId('capture-roi-status')).toHaveTextContent('当前记录缺少可重建的拼接原图'));
    expect(vi.mocked(fetchCaptureStitchHistory).mock.calls.map(([materialId]) => materialId)).toEqual(['2822']);
    expect(document.querySelectorAll('.bar-camera-frame')).toHaveLength(0);
  });

  it('shows a fail-closed state when neither an algorithm ROI nor a world is persisted', async () => {
    render(
      <ProductionPlateMap
        {...common}
        artifactMode="production"
        inspectionId="INS-LIVE-1"
        captureImages={[{
          id: 'forbidden-raw-c1',
          cameraId: 'C1',
          cameraIp: '192.168.101.144',
          dataName: 'intensity',
          sequenceNo: 1,
          fileType: 'png',
          path: '4033/capture/C1/2d/1.png',
          url: 'http://127.0.0.1:4873/forbidden-raw-c1.png',
          createdAt: '2026-08-25T11:16:43.000Z',
        }]}
      />,
    );

    expect(await screen.findByText('拼接缓存尚未就绪 · 已发现 1/8 路原图，等待重建')).toBeInTheDocument();
    expect(screen.queryByTestId('inspection-world-canvas')).not.toBeInTheDocument();
    expect(screen.queryAllByLabelText(/实际裁剪图/)).toHaveLength(0);
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
      expect(screen.getByText('当前记录缺少可重建的拼接原图')).toBeInTheDocument();

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

  it('shows overlap counts and concatenates owned camera columns in the 2D deduplicated mode', async () => {
    vi.mocked(fetchCaptureStitchHistory).mockResolvedValue(captureStitchResult('4034'));
    vi.mocked(readCaptureRegions).mockResolvedValue(captureRegionMap('4034'));
    vi.mocked(readCaptureDefects).mockResolvedValue({
      code: 0,
      detection: {
        schema: 'steel.sick-flow-defect-detection.v1',
        generatedAt: '2026-08-27T10:00:00Z',
        materialId: '4034',
        state: 'complete',
        temporaryModel: true,
        quality: {
          reviewRequired: true,
          fineGrainedClassification: false,
        },
        statistics: {
          overlapDuplicateFilteredCount: 4,
          defectCount: 0,
        },
        defects: [],
      },
    });
    render(
      <ProductionPlateMap
        defectTypes={defectTypes}
        defects={[]}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId={null}
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        inspectionId="INS-OVERLAP"
        captureMaterialId="4034"
        cameraLanes={createSequentialCameraLanes(6)}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    expect(await screen.findByText('重叠区')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: /重叠区 6，去重候选 4/ })).toBeInTheDocument();
    const deduplicate = screen.getByRole('button', { name: '去除重叠' });
    expect(deduplicate).toBeEnabled();
    expect(screen.getByTestId('bar-unfolded-map')).toHaveAttribute('data-overlap-display-mode', 'overlap');

    fireEvent.click(deduplicate);

    expect(screen.getByTestId('bar-unfolded-map')).toHaveAttribute('data-overlap-display-mode', 'deduplicated');
    expect(screen.getAllByLabelText(/2D 去背景图/)[0]).toHaveAttribute(
      'data-overlap-policy',
      'owned-columns-concatenated',
    );
    expect(screen.getAllByLabelText(/2D 去背景图/)[0]).toHaveAttribute(
      'data-source-intervals',
      '0.000000:0.750000',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Jet' }));
    expect(screen.getByTestId('bar-unfolded-map')).toHaveAttribute('data-overlap-display-mode', 'deduplicated');
    expect(screen.getAllByLabelText(/JET/)[0]).toHaveAttribute(
      'data-overlap-policy',
      'owned-columns-concatenated',
    );
  });

  it('maps owned-column gray and JET renditions onto the production cylinder at 1:1 pixels', async () => {
    vi.mocked(fetchCaptureStitchHistory).mockResolvedValue(captureStitchResult('4033', 134));
    vi.mocked(readCaptureRegions).mockResolvedValue(captureRegionMap('4033'));
    render(
      <ProductionPlateMap
        defectTypes={defectTypes}
        defects={[]}
        defectTypeCounts={{}}
        hiddenTypeIds={new Set()}
        selectedDefectId={null}
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        inspectionId="INS-4033"
        captureMaterialId="4033"
        cameraLanes={createSequentialCameraLanes(6)}
        surfaceMesh={{
          ...productionMesh,
          materialId: '4033',
          longitudinalAxis: { absoluteScaleVerified: false },
        }}
        surfaceCameraTiles={captureSurfaceCameraTiles()}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    fireEvent.click(screen.getByRole('button', { name: '灰度贴图' }));

    await waitFor(() => expect(screen.getByTestId('plate-production-surface')).toHaveAttribute(
      'data-artifact-overlap-policy',
      'owned-columns-concatenated',
    ));
    const gray = screen.getByTestId('plate-production-surface');
    expect(gray).toHaveAttribute('data-artifact-color-mode', 'texture');
    expect(gray).toHaveAttribute('data-artifact-texture-modality', 'gray');
    expect(gray).toHaveAttribute('data-artifact-pixel-aspect', '1.000');
    expect(Number(gray.getAttribute('data-artifact-length-diameter-ratio'))).toBeCloseTo(
      Math.PI * 134 * 1024 / (6 * 450),
      2,
    );
    expect(screen.getByText(/去重灰度贴图准备中/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'JET贴图' }));
    const jet = screen.getByTestId('plate-production-surface');
    expect(jet).toHaveAttribute('data-artifact-color-mode', 'radial-jet');
    expect(screen.getByLabelText('Jet 拟合圆径向偏差图例')).toBeInTheDocument();
  });

  it('keeps the existing 2D image visible when calibrated ownership is unavailable', async () => {
    vi.mocked(fetchCaptureStitchHistory).mockResolvedValue(captureStitchResult('4035'));
    render(
      <ProductionPlateMap
        defectTypes={defectTypes}
        defects={[]}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId={null}
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        inspectionId="INS-NO-OVERLAP"
        captureMaterialId="4035"
        cameraLanes={createSequentialCameraLanes(6)}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    const deduplicate = await screen.findByRole('button', { name: '去除重叠' });
    expect(deduplicate).toBeDisabled();
    expect(screen.getByRole('status', { name: /重叠区 不可用，去重候选 不可用/ })).toBeInTheDocument();
    expect(screen.getByTestId('bar-unfolded-map')).toHaveAttribute('data-overlap-display-mode', 'overlap');
    expect(screen.getAllByLabelText(/2D 去背景图/)[0]).toHaveAttribute('data-overlap-policy', 'overlap-retained');
  });

  it('uses the same aligned frame timeline for two-level JET images', async () => {
    vi.mocked(fetchCaptureStitchHistory).mockResolvedValue(captureStitchResult('4033'));
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
        captureMaterialId="4033"
        surfaceMesh={{ ...productionMesh, jetRangeMm: 0.18 }}
        surfaceHeadAlignment={headAlignment()}
        cameraLanes={createSequentialCameraLanes(6)}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    await waitFor(() => expect(fetchCaptureStitchHistory).toHaveBeenCalledWith(
      '4033',
      expect.any(Array),
    ));
    expect(screen.getByTestId('surface-gray-unfolded')).toHaveAttribute('data-image-source', 'per-frame-two-level-gray');
    const grayViewport = screen.getByTestId('capture-stitch-viewport');
    const grayCanvas = screen.getAllByLabelText(/2D 去背景图/)[0];
    grayCanvas.dataset.hasPaintedFrame = 'true';
    Object.defineProperty(grayViewport, 'scrollLeft', { configurable: true, value: 320, writable: true });
    const grayOrigin = grayViewport.getAttribute('data-timeline-origin-frames');
    fireEvent.click(screen.getByRole('button', { name: 'Jet' }));
    expect(screen.getByTestId('surface-jet-unfolded')).toHaveAttribute('data-image-source', 'per-frame-two-level-jet');
    const jetViewport = screen.getByTestId('capture-stitch-viewport');
    expect(jetViewport).toBe(grayViewport);
    expect(jetViewport.scrollLeft).toBe(320);
    expect(jetViewport).toHaveAttribute(
      'data-head-display-padding-applied',
      'true',
    );
    expect(jetViewport).toHaveAttribute('data-image-mode', 'jet');
    expect(jetViewport).toHaveAttribute('data-timeline-origin-frames', grayOrigin);
    expect(screen.getByRole('region', { name: '6 相机圆周展开缺陷图' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /采集图像/ })).toHaveLength(6);
    const jetImages = screen.getAllByLabelText(/JET/);
    expect(jetImages).toHaveLength(6);
    expect(jetImages[0]).toBe(grayCanvas);
    expect(jetImages[0]).toHaveAttribute('data-has-painted-frame', 'true');
    expect(jetImages[0]).toHaveAttribute('data-render-state', 'loading-retaining-frame');
    expect(jetImages[0].getAttribute('data-pending-image-source')).toContain('modality=jet');
  });
});
