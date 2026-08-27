import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DefectItem } from '../data/inspection';
import { DefectDetectionList } from './DefectDetectionList';

const syntheticDefect: DefectItem = {
  id: 'MOCK-0008',
  plateNo: 'BAR-DEMO',
  cameraId: 'camera8',
  cameraIndex: 8,
  circumferenceRatio: 0.94,
  typeId: 'inclusion',
  typeLabel: '夹杂',
  surface: 'bottom',
  severity: 'review',
  distanceHeadMm: 10666,
  operatorSideMm: 0,
  driveSideMm: 0,
  widthMm: 3.2,
  heightMm: 7.4,
  depthMm: 0.48,
  xRatio: 0.88,
  yOffsetMm: 0,
  previewX: 88,
  previewY: 94,
  previewImageUrl: '',
  confidence: 0.91,
  synthetic: true,
};

const candidateDefect: DefectItem = {
  ...syntheticDefect,
  id: 'ALG-0001',
  typeId: 'pit',
  typeLabel: '凹陷候选',
  classificationState: 'candidate-only',
  classificationVersion: 'radial-polarity-candidate-v1',
  candidatePolarity: 'depression',
  synthetic: false,
};

const roiDefect: DefectItem = {
  ...candidateDefect,
  id: 'BKV-ROI-1',
  cameraIndex: 1,
  cameraId: 'camera1',
  artifacts: {
    schema: 'steel.surface.defect.artifacts.v1',
    cameraId: 'camera1',
    frameId: 'frame-18',
    sequenceNo: 18,
    roi: { x: 1208, y: 848, width: 4, height: 11 },
  },
};

describe('DefectDetectionList algorithm defects', () => {
  it('shows an eight-camera synthetic algorithm defect with an explicit marker', () => {
    render(
      <DefectDetectionList
        defects={[syntheticDefect]}
        selectedDefectId={null}
        filters={{ keyword: '', severity: 'all', surface: 'all', typeId: 'all' }}
        filterOpen={false}
        onSelectDefect={vi.fn()}
        onToggleFilter={vi.fn()}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle('列表'));

    expect(screen.getByText('camera8')).toBeInTheDocument();
    expect(screen.getByText('夹杂')).toBeInTheDocument();
    expect(screen.getByText('模拟')).toBeInTheDocument();
  });

  it('labels an unclassified radial anomaly as a review candidate', () => {
    render(
      <DefectDetectionList
        defects={[candidateDefect]}
        selectedDefectId={null}
        filters={{ keyword: '', severity: 'all', surface: 'all', typeId: 'all' }}
        filterOpen={false}
        onSelectDefect={vi.fn()}
        onToggleFilter={vi.fn()}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle('列表'));

    expect(screen.getByText('凹陷候选')).toBeInTheDocument();
    expect(screen.getByText('候选')).toBeInTheDocument();
    expect(screen.queryByText('模拟')).not.toBeInTheDocument();
  });

  it('shows a clearly labeled development image and detailed measurements while hovering a defect row', () => {
    render(
      <DefectDetectionList
        defects={[syntheticDefect]}
        selectedDefectId={null}
        filters={{ keyword: '', severity: 'all', surface: 'all', typeId: 'all' }}
        filterOpen={false}
        onSelectDefect={vi.fn()}
        onToggleFilter={vi.fn()}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle('列表'));

    fireEvent.mouseEnter(screen.getByRole('row', { name: '夹杂，camera8，距头10666mm，待复核' }));

    const tooltip = screen.getByRole('tooltip');
    expect(screen.getByRole('img', { name: '夹杂缺陷图像' })).toBeInTheDocument();
    expect(tooltip).toHaveTextContent('3.20 × 7.40 × 0.48mm');
    expect(tooltip).toHaveTextContent('91.0%');
    expect(tooltip).toHaveTextContent('开发模拟图 · 非生产产物');
  });

  it('uses the selected production frame ROI in the hover preview', () => {
    render(
      <DefectDetectionList
        defects={[roiDefect]}
        inspectionId="1908500"
        selectedDefectId={null}
        filters={{ keyword: '', severity: 'all', surface: 'all', typeId: 'all' }}
        filterOpen={false}
        onSelectDefect={vi.fn()}
        onToggleFilter={vi.fn()}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle('列表'));

    fireEvent.mouseEnter(screen.getByRole('row', { name: /凹陷候选，camera1/ }));
    const image = screen.getByRole('img', { name: '凹陷候选缺陷图像' });
    expect(image).toHaveAttribute('src', expect.stringContaining('cropX=1208'));
    expect(image).toHaveAttribute('src', expect.stringContaining('cropHeight=11'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('检测记录 ROI 裁剪');
  });

  it('prefers the cached defect crop over loading the production frame', () => {
    const cached = {
      ...roiDefect,
      previewImageUrl: 'http://127.0.0.1:4873/api/capture/file?path=defect-crop.png',
    };
    render(
      <DefectDetectionList
        defects={[cached]}
        inspectionId="1908500"
        selectedDefectId={null}
        filters={{ keyword: '', severity: 'all', surface: 'all', typeId: 'all' }}
        filterOpen={false}
        onSelectDefect={vi.fn()}
        onToggleFilter={vi.fn()}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle('列表'));

    fireEvent.mouseEnter(screen.getByRole('row', { name: /凹陷候选，camera1/ }));
    expect(screen.getByRole('img', { name: '凹陷候选缺陷图像' })).toHaveAttribute(
      'src',
      cached.previewImageUrl,
    );
    expect(screen.getByRole('tooltip')).toHaveTextContent('检测记录缺陷小图');
  });

  it('shows an explicit pending state instead of falling back to a source frame or uncropped inspection frame', () => {
    const sourceFrameOnly: DefectItem = {
      ...roiDefect,
      artifacts: {
        ...roiDefect.artifacts!,
        roi: { x: 1208, y: 848, width: 0, height: 11 },
        sourceFrame: {
          intensity: 'http://127.0.0.1:4873/api/capture/file?path=1908500%2Fcapture%2FC1%2F2d%2F18.png',
        },
      },
    };
    render(
      <DefectDetectionList
        defects={[sourceFrameOnly]}
        inspectionId="1908500"
        selectedDefectId={null}
        filters={{ keyword: '', severity: 'all', surface: 'all', typeId: 'all' }}
        filterOpen={false}
        onSelectDefect={vi.fn()}
        onToggleFilter={vi.fn()}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle('列表'));

    fireEvent.mouseEnter(screen.getByRole('row', { name: /凹陷候选，camera1/ }));

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('算法 ROI 小图未就绪');
    expect(tooltip.querySelector('img')).toBeNull();
    expect(tooltip).not.toHaveTextContent('检测记录原始帧');
  });

  it('switches between the defect list and the pipe distribution map', () => {
    const onSelectDefect = vi.fn();
    render(
      <DefectDetectionList
        defects={[syntheticDefect, { ...candidateDefect, id: 'ALG-0002', xRatio: 0.22, cameraIndex: 2, circumferenceRatio: 0.25 }]}
        defectTypes={[
          { id: 'inclusion', label: '夹杂', color: '#f0141e', shape: 'diamond' },
          { id: 'pit', label: '凹陷候选', color: '#2f6bff', shape: 'circle' },
        ]}
        pipeLengthMm={12_000}
        selectedDefectId="ALG-0002"
        filters={{ keyword: '', severity: 'all', surface: 'all', typeId: 'all' }}
        filterOpen={false}
        onSelectDefect={onSelectDefect}
        onToggleFilter={vi.fn()}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );

    expect(screen.getByTitle('分布图')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('img', { name: '缺陷分布图，共 2 个缺陷' }).closest('.defect-list-panel')).toHaveClass('display-mode-distribution');
    expect(screen.getByRole('img', { name: '缺陷分布图，共 2 个缺陷' }).parentElement).toHaveClass('panel-body');
    expect(screen.getByRole('img', { name: '缺陷分布图，共 2 个缺陷' }).parentElement).toHaveStyle({ padding: '0px' });
    expect(screen.getByLabelText('钢管长度刻度，0.0 至 12.0 米')).toBeInTheDocument();
    expect(screen.getByText('12.0 m')).toBeInTheDocument();
    expect(screen.getByLabelText('相机区域 C1 至 C6')).toHaveTextContent('C1C2C3C4C5C6');
    expect(screen.queryByText('管头')).not.toBeInTheDocument();
    expect(screen.queryByText('管尾')).not.toBeInTheDocument();
    const marker = screen.getByRole('button', { name: /凹陷候选，camera2/ });
    expect(marker).toHaveClass('selected');
    expect(marker).toBeEmptyDOMElement();
    expect(marker).toHaveStyle({ '--defect-type-color': '#2f6bff' });
    fireEvent.click(marker);
    expect(onSelectDefect).toHaveBeenCalledWith('ALG-0002');

    const distribution = screen.getByRole('img', { name: '缺陷分布图，共 2 个缺陷' });
    fireEvent.wheel(distribution.querySelector('.defect-distribution-pipe')!, { deltaY: 120 });
    expect(onSelectDefect).toHaveBeenLastCalledWith(syntheticDefect.id);
    fireEvent.wheel(distribution.querySelector('.defect-distribution-pipe')!, { deltaY: -120 });
    expect(onSelectDefect).toHaveBeenLastCalledWith(syntheticDefect.id);

    fireEvent.click(screen.getByTitle('列表'));
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});
