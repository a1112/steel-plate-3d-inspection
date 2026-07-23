import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptureImageItem, ChartPoint, DefectItem } from '../data/inspection';
import { createSectionProfiles } from '../lib/section-profiles';
import type { BarSurfaceMesh } from '../services/bar-surface-api';
import { AlarmAnalysis } from './AlarmAnalysis';

const defect: DefectItem = {
  id: 'D-001',
  plateNo: 'P-001',
  typeId: 'pit',
  typeLabel: '凹坑',
  surface: 'top',
  severity: 'severe',
  distanceHeadMm: 8342,
  operatorSideMm: 1260,
  driveSideMm: 2240,
  widthMm: 0.42,
  heightMm: 0.36,
  depthMm: -0.12,
  xRatio: 0.68,
  yOffsetMm: 0.4,
  previewX: 50,
  previewY: 48,
  previewImageUrl: '',
};

const points: ChartPoint[] = Array.from({ length: 5 }, (_, index) => ({
  x: index * 20,
  z: Number((-0.02 * index).toFixed(3)),
}));

const captureImage: CaptureImageItem = {
  id: 'CAPTURE-1',
  cameraId: 'camera2',
  cameraIp: '192.168.1.12',
  dataName: 'intensity',
  sequenceNo: 7,
  fileType: 'png',
  path: 'records/INS-1/camera2/intensity-7.png',
  url: 'http://127.0.0.1:4873/api/production/file?path=records%2FINS-1%2Fcamera2%2Fintensity-7.png',
  createdAt: '2026-07-12 10:00:00',
};

const productionMesh: BarSurfaceMesh = {
  schema: 'steel.bar-surface.mesh.v1',
  coordinateUnit: 'mm',
  cameraCount: 1,
  frameStems: ['frame-007'],
  rows: 2,
  colsPerCamera: 2,
  positions: new Float32Array([0, 0, 0, 1, 0, 0.1, 0, 1, 0.2, 1, 1, 0.3]),
  uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
  colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0]),
  indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
};

describe('createSectionProfiles', () => {
  it('keeps the length section and adds an independent width section', () => {
    const profiles = createSectionProfiles(points, defect);

    expect(profiles).toHaveLength(points.length);
    expect(profiles[2].lengthSection).toBe(points[2].z);
    expect(profiles.some((point) => point.widthSection !== point.lengthSection)).toBe(true);
    expect(Math.min(...profiles.map((point) => point.widthSection))).toBeLessThan(-0.08);
  });
});

describe('AlarmAnalysis', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a single-camera modal from a production capture thumbnail', () => {
    render(createElement(AlarmAnalysis, {
      selectedDefect: null,
      heightProfile: [],
      captureImages: [captureImage],
      headerless: true,
    }));

    fireEvent.click(screen.getByRole('button', { name: '打开 camera2 intensity #7' }));
    expect(screen.getByRole('dialog', { name: '单相机采集图像查看' })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent('camera2');
    fireEvent.click(screen.getByRole('button', { name: '关闭图像弹窗' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('can show the lower analysis charts without the removed panel title', () => {
    render(createElement(AlarmAnalysis, { selectedDefect: defect, heightProfile: points, headerless: true, artifactMode: 'demo' }));

    expect(screen.queryByRole('heading', { name: '缺陷检测报警图' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '灰度图' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '点云图' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '缺陷高度剖面图' })).toBeInTheDocument();
    expect(screen.getByText('长度切面')).toBeInTheDocument();
    expect(screen.getByText('宽度切面')).toBeInTheDocument();
  });

  it('switches to a focused analysis view and fully collapses from the footer state', () => {
    const { rerender } = render(createElement(AlarmAnalysis, {
      selectedDefect: defect,
      heightProfile: points,
      headerless: true,
      artifactMode: 'demo',
      viewMode: 'image',
    }));

    expect(screen.getByRole('heading', { name: '灰度图' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '点云图' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '缺陷高度剖面图' })).not.toBeInTheDocument();

    rerender(createElement(AlarmAnalysis, {
      selectedDefect: defect,
      heightProfile: points,
      headerless: true,
      artifactMode: 'demo',
      viewMode: 'image',
      collapsed: true,
    }));

    expect(screen.queryByRole('heading', { name: '灰度图' })).not.toBeInTheDocument();
  });

  it('fully collapses the empty lower information area without a selected defect', () => {
    const { container } = render(createElement(AlarmAnalysis, {
      selectedDefect: null,
      heightProfile: [],
      captureImages: [],
      headerless: true,
      collapsed: true,
    }));

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('当前钢管暂无缺陷')).not.toBeInTheDocument();
  });

  it('adds horizontal drag and wheel zoom controls to the point cloud', () => {
    render(createElement(AlarmAnalysis, { selectedDefect: defect, heightProfile: points, headerless: true, artifactMode: 'demo' }));

    const viewer = screen.getByTestId('point-cloud-viewer');
    expect(viewer).toHaveAttribute('data-point-cloud-yaw', '-0.320');
    expect(viewer).toHaveAttribute('data-point-cloud-zoom', '1.00');
    expect(viewer).toHaveAttribute('data-point-cloud-points', '1643');
    expect(Number(viewer.getAttribute('data-point-cloud-memory-bytes'))).toBeLessThan(40000);
    expect(screen.getByText('缩放 1.00x')).toBeInTheDocument();

    const verticalPointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(verticalPointerDown, 'button', { value: 0 });
    Object.defineProperty(verticalPointerDown, 'clientX', { value: 400 });
    Object.defineProperty(verticalPointerDown, 'pointerId', { value: 2 });
    fireEvent(viewer, verticalPointerDown);

    const verticalPointerMove = new Event('pointermove', { bubbles: true, cancelable: true });
    Object.defineProperty(verticalPointerMove, 'clientX', { value: 400 });
    Object.defineProperty(verticalPointerMove, 'pointerId', { value: 2 });
    fireEvent(viewer, verticalPointerMove);
    expect(viewer).toHaveAttribute('data-point-cloud-yaw', '-0.320');

    const verticalPointerUp = new Event('pointerup', { bubbles: true, cancelable: true });
    Object.defineProperty(verticalPointerUp, 'pointerId', { value: 2 });
    fireEvent(viewer, verticalPointerUp);

    const horizontalPointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(horizontalPointerDown, 'button', { value: 0 });
    Object.defineProperty(horizontalPointerDown, 'clientX', { value: 400 });
    Object.defineProperty(horizontalPointerDown, 'pointerId', { value: 3 });
    fireEvent(viewer, horizontalPointerDown);

    const horizontalPointerMove = new Event('pointermove', { bubbles: true, cancelable: true });
    Object.defineProperty(horizontalPointerMove, 'clientX', { value: 460 });
    Object.defineProperty(horizontalPointerMove, 'pointerId', { value: 3 });
    fireEvent(viewer, horizontalPointerMove);
    expect(viewer).toHaveAttribute('data-point-cloud-yaw', '0.040');

    fireEvent.wheel(viewer, { deltaY: -120 });
    expect(viewer).toHaveAttribute('data-point-cloud-zoom', '1.12');
    expect(screen.getByText('缩放 1.12x')).toBeInTheDocument();

    fireEvent.wheel(viewer, { deltaY: 120 });
    expect(viewer).toHaveAttribute('data-point-cloud-zoom', '1.00');
  });

  it('adjusts the height chart coordinate range with the mouse wheel', () => {
    render(createElement(AlarmAnalysis, { selectedDefect: defect, heightProfile: points, headerless: true, artifactMode: 'demo' }));

    const chart = screen.getByTestId('height-profile-chart');
    expect(chart).toHaveAttribute('data-axis-zoom', '1.00');
    expect(chart).toHaveAttribute('data-x-domain', '0.00,80.00');
    expect(chart).toHaveAttribute('data-y-domain', '-1.00,1.00');
    expect(screen.getByText('坐标 1.00x')).toBeInTheDocument();

    fireEvent.wheel(chart, { deltaY: -120 });
    expect(chart).toHaveAttribute('data-axis-zoom', '1.20');
    expect(chart).toHaveAttribute('data-x-domain', '6.67,73.33');
    expect(chart).toHaveAttribute('data-y-domain', '-0.83,0.83');
    expect(screen.getByText('坐标 1.20x')).toBeInTheDocument();

    fireEvent.wheel(chart, { deltaY: 120 });
    expect(chart).toHaveAttribute('data-axis-zoom', '1.00');
    expect(chart).toHaveAttribute('data-x-domain', '0.00,80.00');
    expect(chart).toHaveAttribute('data-y-domain', '-1.00,1.00');
  });

  it('shows explicit production empty states instead of demo images, point clouds, or profiles', () => {
    render(createElement(AlarmAnalysis, {
      selectedDefect: defect,
      heightProfile: [],
      headerless: true,
      inspectionId: 'INS-PROD-1',
    }));

    expect(screen.getByText('暂无生产缺陷图像产物')).toBeInTheDocument();
    expect(screen.getByText('暂无生产点云产物')).toBeInTheDocument();
    expect(screen.getByText('暂无生产高度剖面产物')).toBeInTheDocument();
    expect(screen.queryByTestId('point-cloud-viewer')).not.toBeInTheDocument();
    expect(screen.queryByText('演示缺陷图')).not.toBeInTheDocument();
  });

  it('labels a record-bound capture as a raw image and renders the real record mesh', () => {
    render(createElement(AlarmAnalysis, {
      selectedDefect: defect,
      heightProfile: [],
      captureImages: [captureImage],
      surfaceMesh: productionMesh,
      inspectionId: 'INS-PROD-2',
      headerless: true,
    }));

    expect(screen.getByRole('img', { name: '检测记录采集原图 camera2' })).toHaveAttribute('src', captureImage.url);
    expect(screen.getByText(/非缺陷 ROI 裁剪/)).toBeInTheDocument();
    expect(screen.getByTestId('analysis-production-point-cloud')).toHaveAttribute('data-artifact-source', 'production-record');
    expect(screen.getByTestId('analysis-production-point-cloud')).toHaveAttribute('data-artifact-points', '4');
    expect(screen.queryByTestId('point-cloud-viewer')).not.toBeInTheDocument();
  });

  it('loads defect-bound ROI, local point cloud, and two real profiles before record-wide fallbacks', async () => {
    const artifactDefect: DefectItem = {
      ...defect,
      artifacts: {
        schema: 'steel.surface.defect.artifacts.v1',
        cameraId: 'camera2',
        frameId: 'frame-007',
        sequenceNo: 7,
        roi: { x: 10, y: 20, width: 30, height: 40 },
        roiImage: 'runs/MAT/RUN/defects/D-001/intensity-roi.png',
        localPointCloud: 'runs/MAT/RUN/defects/D-001/local-point-cloud.json',
        lengthProfile: 'runs/MAT/RUN/defects/D-001/length-profile.json',
        widthProfile: 'runs/MAT/RUN/defects/D-001/width-profile.json',
      },
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('local-point-cloud')) {
        return new Response(JSON.stringify({ schema: 'steel.surface.defect.point-cloud.v1', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], colors: [1, 0, 0, 0, 1, 0, 0, 0, 1] }), { status: 200 });
      }
      const axis = url.includes('width-profile') ? 'width' : 'length';
      return new Response(JSON.stringify({ axis, points: [{ x: -1, z: 0 }, { x: 0, z: -0.4 }, { x: 1, z: 0 }] }), { status: 200 });
    });

    render(createElement(AlarmAnalysis, {
      selectedDefect: artifactDefect,
      heightProfile: [],
      surfaceMesh: productionMesh,
      inspectionId: 'INS-PROD-3',
      headerless: true,
    }));

    await waitFor(() => expect(screen.getByTestId('analysis-production-point-cloud')).toHaveAttribute('data-artifact-points', '3'));
    expect(screen.queryByText('整管参考 · 非缺陷局部点云')).not.toBeInTheDocument();
    expect(screen.getByTestId('height-profile-chart')).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(document.querySelector('.defect-preview')).toHaveAttribute('data-artifact-source', 'production-record');
  });
});
