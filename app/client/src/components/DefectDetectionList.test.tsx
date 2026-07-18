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

describe('DefectDetectionList algorithm defects', () => {
  it('shows an eight-camera synthetic algorithm defect with an explicit marker', () => {
    render(
      <DefectDetectionList
        defects={[syntheticDefect]}
        selectedDefectId={null}
        page={1}
        pageCount={1}
        filters={{ keyword: '', severity: 'all', surface: 'all', typeId: 'all' }}
        filterOpen={false}
        onPageChange={vi.fn()}
        onSelectDefect={vi.fn()}
        onToggleFilter={vi.fn()}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );

    expect(screen.getByText('camera8')).toBeInTheDocument();
    expect(screen.getByText('夹杂')).toBeInTheDocument();
    expect(screen.getByText('模拟')).toBeInTheDocument();
  });

  it('labels an unclassified radial anomaly as a review candidate', () => {
    render(
      <DefectDetectionList
        defects={[candidateDefect]}
        selectedDefectId={null}
        page={1}
        pageCount={1}
        filters={{ keyword: '', severity: 'all', surface: 'all', typeId: 'all' }}
        filterOpen={false}
        onPageChange={vi.fn()}
        onSelectDefect={vi.fn()}
        onToggleFilter={vi.fn()}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );

    expect(screen.getByText('凹陷候选')).toBeInTheDocument();
    expect(screen.getByText('候选')).toBeInTheDocument();
    expect(screen.queryByText('模拟')).not.toBeInTheDocument();
  });

  it('shows a clearly labeled development image and detailed measurements while hovering a defect row', () => {
    render(
      <DefectDetectionList
        defects={[syntheticDefect]}
        selectedDefectId={null}
        page={1}
        pageCount={1}
        filters={{ keyword: '', severity: 'all', surface: 'all', typeId: 'all' }}
        filterOpen={false}
        onPageChange={vi.fn()}
        onSelectDefect={vi.fn()}
        onToggleFilter={vi.fn()}
        onFilterChange={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(screen.getByRole('row', { name: '夹杂，camera8，距头10666mm，待复核' }));

    const tooltip = screen.getByRole('tooltip');
    expect(screen.getByRole('img', { name: '夹杂缺陷图像' })).toBeInTheDocument();
    expect(tooltip).toHaveTextContent('3.20 × 7.40 × 0.48mm');
    expect(tooltip).toHaveTextContent('91.0%');
    expect(tooltip).toHaveTextContent('开发模拟图 · 非生产产物');
  });
});
