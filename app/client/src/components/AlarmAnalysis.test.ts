import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { CaptureImageItem, DefectItem } from '../data/inspection';
import type { CaptureFlowMeasurement } from '../lib/capture-api';
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

const roiArtifactDefect: DefectItem = {
  ...defect,
  cameraId: 'camera2',
  cameraIndex: 2,
  artifacts: {
    schema: 'steel.surface.defect.artifacts.v1',
    cameraId: 'camera2',
    frameId: 'frame-007',
    sequenceNo: 7,
    roi: { x: 10, y: 20, width: 30, height: 40 },
    roiImage: 'runs/MAT/RUN/defects/D-001/intensity-roi.png',
  },
};

const diameterMesh: BarSurfaceMesh = {
  schema: 'steel.bar-surface.mesh.v1',
  coordinateUnit: 'millimeter-normalized-radius',
  cameraCount: 1,
  frameStems: ['frame-007'],
  rows: 2,
  colsPerCamera: 4,
  positions: new Float32Array([
    0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1,
    1, 1.01, 0, 1, 0, 0.99, 1, -1.01, 0, 1, 0, -0.99,
  ]),
  uvs: new Float32Array(16),
  colors: new Float32Array(24),
  validMask: new Uint8Array(8).fill(1),
  indices: new Uint32Array(),
};

const diameterArtifact: CaptureFlowMeasurement = {
  schema: 'steel.ranger3-flow-measurement.v1',
  generatedAt: '2026-08-24T14:21:25.495Z',
  materialId: '3703',
  mode: 'metric',
  metricValid: true,
  qualityGate: { passed: true, reasons: [] },
  selectedSection: {},
  cameras: {},
  surfaceFit: {
    available: true,
    metricValid: true,
    absoluteLongitudinalScaleVerified: false,
    sectionsRequested: 3,
    sectionsAccepted: 2,
    diameterMeanMm: 45.4,
    diameterRangeMm: 0.2,
    sections: [
      { anchorOrdinal: 0, elapsedFromHeadMs: 0, positionRatio: 0, metricValid: false, circleFit: { available: true, diameterMm: 41.8 } },
      { anchorOrdinal: 1, elapsedFromHeadMs: 1_000, positionRatio: 0.5, metricValid: true, circleFit: { available: true, diameterMm: 45.3, roundnessMm: 0.2, p95AbsResidualMm: 0.1 } },
      { anchorOrdinal: 2, elapsedFromHeadMs: 2_000, positionRatio: 1, metricValid: true, circleFit: { available: true, diameterMm: 45.5, roundnessMm: 0.3, p95AbsResidualMm: 0.2 } },
    ],
  },
};

describe('AlarmAnalysis', () => {
  it('renders only one full-width outer-diameter analysis surface', () => {
    const { container } = render(createElement(AlarmAnalysis, {
      selectedDefect: defect,
      heightProfile: [],
      surfaceMesh: diameterMesh,
      diameterMeasurement: { nominalDiameterMm: 200, lengthMm: 12_000 },
      headerless: true,
      viewMode: 'overview',
    }));

    expect(screen.queryByRole('heading', { name: '测径（外径）曲线' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: '测径（外径）曲线，按钢管长度位置变化' })).toBeInTheDocument();
    expect(container.querySelector('.diameter-curve-card > footer')).toBeNull();
    expect(container.querySelector('.diameter-only-analysis')).not.toBeNull();
    expect(container.querySelector('.diameter-analysis-panel > .panel-body')).toHaveStyle({ padding: '0px' });
    expect(container.querySelector('.analysis-grid')).toBeNull();
    expect(screen.queryByRole('heading', { name: '灰度图' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '点云图' })).not.toBeInTheDocument();
  });

  it('shows one explicit measurement empty state without gray or point-cloud fallbacks', () => {
    render(createElement(AlarmAnalysis, {
      selectedDefect: defect,
      heightProfile: [],
      inspectionId: 'INS-PROD-1',
      headerless: true,
    }));

    expect(screen.getByText('暂无测径（外径）曲线')).toBeInTheDocument();
    expect(screen.queryByText('算法 ROI 小图未就绪')).not.toBeInTheDocument();
    expect(screen.queryByText('暂无生产点云产物')).not.toBeInTheDocument();
  });

  it('renders the calibrated artifact without secondary nominal diameter or length data', () => {
    render(createElement(AlarmAnalysis, {
      selectedDefect: null,
      heightProfile: [],
      inspectionId: 'INSP-3703',
      diameterArtifact,
      diameterMeasurement: { nominalDiameterMm: 0, lengthMm: 0 },
      headerless: true,
    }));

    expect(screen.getByTestId('diameter-trend-grid')).toHaveAttribute('data-measurement-source', 'measurement-artifact');
    expect(screen.getByTestId('diameter-trend-grid')).toHaveAttribute('data-x-axis-mode', 'head-relative');
    expect(screen.queryByText('2 / 3')).not.toBeInTheDocument();
    expect(document.querySelectorAll('.diameter-canvas-chart canvas')).toHaveLength(2);
    expect(screen.getByRole('img', { name: '测径（外径）曲线，按头部相对位置变化' })).toHaveTextContent('圆拟合外径 2 个截面');
  });

  it('fully collapses the lower measurement area', () => {
    const { container } = render(createElement(AlarmAnalysis, {
      selectedDefect: defect,
      heightProfile: [],
      collapsed: true,
    }));

    expect(container).toBeEmptyDOMElement();
  });

  it('uses an algorithm ROI image in the separate defect strip', () => {
    const { container } = render(createElement(AlarmAnalysis, {
      selectedDefect: roiArtifactDefect,
      heightProfile: [],
      captureImages: [captureImage],
      viewMode: 'defects',
      headerless: true,
    }));

    expect(screen.getByRole('button', { name: '打开 C2 · 凹坑 intensity #7' })).toBeInTheDocument();
    expect(container.querySelector(`img[src="${captureImage.url}"]`)).toBeNull();
    expect(screen.queryByTestId('diameter-trend-grid')).not.toBeInTheDocument();
  });

  it('does not substitute a production capture when an ROI image is unavailable', () => {
    render(createElement(AlarmAnalysis, {
      selectedDefect: defect,
      heightProfile: [],
      captureImages: [captureImage],
      viewMode: 'defects',
      headerless: true,
    }));

    expect(screen.getByText('算法 ROI 小图未就绪')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开 camera2 intensity #7' })).not.toBeInTheDocument();
  });

  it('opens a demo capture from the retained defect strip', () => {
    render(createElement(AlarmAnalysis, {
      selectedDefect: defect,
      heightProfile: [],
      captureImages: [captureImage],
      artifactMode: 'demo',
      viewMode: 'defects',
      headerless: true,
    }));

    fireEvent.click(screen.getByRole('button', { name: '打开 camera2 intensity #7' }));
    expect(screen.getByRole('dialog', { name: '单相机采集图像查看' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭图像弹窗' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
