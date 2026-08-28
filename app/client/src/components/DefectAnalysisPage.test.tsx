import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DefectItem, DefectType, SteelPlate } from '../data/inspection';
import { DefectAnalysisPage } from './DefectAnalysisPage';

const plate: SteelPlate = {
  plateNo: 'DEMO-4034',
  widthMm: 77.1,
  lengthMm: 12_000,
  thicknessMm: 3.2,
  steelGrade: 'Q235B',
  detectedAt: '2026-08-27 14:00:00',
};

const defectTypes: DefectType[] = [
  { id: 'scratch', label: '划伤', color: '#20c77a', shape: 'rect' },
  { id: 'pit', label: '凹坑', color: '#ff4d58', shape: 'circle' },
];

const defects: DefectItem[] = [
  {
    id: 'D-001',
    plateNo: plate.plateNo,
    typeId: 'scratch',
    typeLabel: '划伤',
    surface: 'top',
    severity: 'review',
    distanceHeadMm: 2_400,
    operatorSideMm: 12,
    driveSideMm: 65,
    widthMm: 8.2,
    heightMm: 3.4,
    depthMm: 0.2,
    xRatio: 0.2,
    yOffsetMm: 12,
    previewX: 0.2,
    previewY: 0.25,
    previewImageUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
    cameraId: 'C2',
    cameraIndex: 2,
    confidence: 0.87,
    reviewStatus: 'pending',
    artifacts: {
      schema: 'steel.surface.defect.artifacts.v1',
      cameraId: 'C2',
      frameId: 'F-0113',
      sequenceNo: 113,
      roi: { x: 10, y: 20, width: 30, height: 18 },
    },
  },
  {
    id: 'D-002',
    plateNo: plate.plateNo,
    typeId: 'pit',
    typeLabel: '凹坑',
    surface: 'bottom',
    severity: 'severe',
    distanceHeadMm: 9_600,
    operatorSideMm: 33,
    driveSideMm: 44,
    widthMm: 5.1,
    heightMm: 4.5,
    depthMm: 0.6,
    xRatio: 0.8,
    yOffsetMm: -8,
    previewX: 0.8,
    previewY: 0.7,
    previewImageUrl: '',
    cameraId: 'C6',
    cameraIndex: 6,
    confidence: 0.72,
    reviewStatus: 'pending',
    artifacts: {
      schema: 'steel.surface.defect.artifacts.v1',
      cameraId: 'C6',
      frameId: 'F-0012',
      sequenceNo: 12,
      roi: { x: 4, y: 8, width: 24, height: 20 },
    },
  },
];

function renderPage(overrides: Partial<React.ComponentProps<typeof DefectAnalysisPage>> = {}) {
  const onSelectDefect = vi.fn();
  const onReviewDefect = vi.fn().mockResolvedValue(undefined);
  render(
    <DefectAnalysisPage
      plate={plate}
      defects={defects}
      defectTypes={defectTypes}
      inspectionId="INSP-4034"
      selectedDefectId="D-001"
      expectedCameraCount={6}
      onSelectDefect={onSelectDefect}
      onReviewDefect={onReviewDefect}
      {...overrides}
    />,
  );
  return { onSelectDefect, onReviewDefect };
}

describe('DefectAnalysisPage', () => {
  it('opens in paired large-image mode with the camera-length distribution', () => {
    renderPage();

    expect(screen.getByRole('main', { name: '缺陷分析模式' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '大图' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('原始大图')).toBeInTheDocument();
    expect(screen.getByText('JET 大图')).toBeInTheDocument();

    const distribution = screen.getByRole('complementary', { name: '缺陷分布图' });
    expect(within(distribution).queryByText('C1–C6 · 纵向位置')).not.toBeInTheDocument();
    expect(within(distribution).getByRole('button', { name: '划伤，C2，位置2.40米' })).toBeInTheDocument();
    expect(within(distribution).getByRole('button', { name: '凹坑，C6，位置9.60米' })).toBeInTheDocument();
  });

  it('switches to paired defect cards and keeps selection linked', () => {
    const { onSelectDefect } = renderPage();

    fireEvent.click(screen.getByRole('button', { name: '卡片' }));
    expect(screen.getByRole('button', { name: '卡片' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByText('原始小图')).toHaveLength(2);
    expect(screen.getAllByText('JET', { selector: 'figcaption' })).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: '凹坑，C6，位置9.60米' }));
    expect(onSelectDefect).toHaveBeenCalledWith('D-002');
  });

  it('allows gray or JET-only viewing but never hides both image types', () => {
    renderPage();

    const grayButton = screen.getByRole('button', { name: '灰度' });
    const jetButton = screen.getByRole('button', { name: 'JET' });
    fireEvent.click(grayButton);

    expect(grayButton).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('原始大图')).not.toBeInTheDocument();
    expect(screen.getByText('JET 大图')).toBeInTheDocument();
    expect(jetButton).toBeDisabled();
  });

  it('submits the selected defect review through the existing review callback', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('人工复核通过');
    const { onReviewDefect } = renderPage();

    const confirmButton = screen.getByRole('button', { name: '确认缺陷' });
    fireEvent.click(confirmButton);
    await waitFor(() => expect(onReviewDefect).toHaveBeenCalledWith(defects[0], 'confirmed', '人工复核通过'));
    await waitFor(() => expect(confirmButton).toBeEnabled());
    promptSpy.mockRestore();
  });
});
