import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DefectItem, DefectType, SteelPlate } from '../data/inspection';
import { fetchCaptureStitchHistory } from '../services/capture-roi-api';
import { DefectAnalysisPage } from './DefectAnalysisPage';

vi.mock('../services/capture-roi-api', async () => {
  const actual = await vi.importActual<typeof import('../services/capture-roi-api')>('../services/capture-roi-api');
  return { ...actual, fetchCaptureStitchHistory: vi.fn() };
});

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
  beforeEach(() => {
    vi.mocked(fetchCaptureStitchHistory).mockReset();
  });

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

  it('toggles between large images and cards by double-clicking an image', () => {
    renderPage();

    fireEvent.doubleClick(screen.getByRole('img', { name: '划伤原始大图' }));
    expect(screen.getByRole('button', { name: '卡片' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('img', { name: '划伤原始小图' })).toBeInTheDocument();

    fireEvent.doubleClick(screen.getByRole('img', { name: '划伤原始小图' }));
    expect(screen.getByRole('button', { name: '大图' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('img', { name: '划伤原始大图' })).toBeInTheDocument();
  });

  it('switches to the previous or next defect by scrolling over a large image', () => {
    const thirdDefect: DefectItem = {
      ...defects[0],
      id: 'D-003',
      typeLabel: '裂纹',
      distanceHeadMm: 6_000,
    };
    const { onSelectDefect } = renderPage({
      defects: [...defects, thirdDefect],
      selectedDefectId: 'D-002',
    });

    const [grayLargeImage, jetLargeImage] = Array.from(
      document.querySelectorAll<HTMLElement>('.defect-analysis-image.large'),
    );
    expect(grayLargeImage).toBeDefined();
    expect(jetLargeImage).toBeDefined();
    fireEvent.wheel(grayLargeImage, { deltaY: 120 });
    expect(onSelectDefect).toHaveBeenCalledWith('D-003');
    fireEvent.wheel(jetLargeImage, { deltaY: -120 });
    expect(onSelectDefect).toHaveBeenCalledWith('D-001');
  });

  it('centers gray and JET images on the real defect ROI with surrounding context and a red box', async () => {
    const focusedDefect: DefectItem = {
      ...defects[0],
      plateNo: '4034',
      artifacts: {
        ...defects[0].artifacts!,
        roi: { x: 130, y: 200, width: 30, height: 18 },
      },
    };
    vi.mocked(fetchCaptureStitchHistory).mockResolvedValue({
      materialId: '4034',
      indexed: true,
      totalFrames: 1,
      hasMore: false,
      expectedCameraCount: 6,
      renderableImageCount: 1,
      frames: [{
        frameId: '4034:113',
        sequence: 113,
        capturedAt: '2026-08-27T14:00:00.000Z',
        cameras: [{
          cameraId: 'C2',
          cameraIp: '192.168.102.100',
          artifactRef: '4034/capture/C2/2d/113.png',
          frameSequence: 113,
          storageIndex: 113,
          sourceWidth: 2560,
          sourceHeight: 1024,
          validRoi: [100, 0, 700, 1024],
          displaySize: [600, 1024],
          sourceOffset: { x: 100, y: 0 },
          url: '/gray-thumbnail.jpg',
          grayThumbnailUrl: '/gray-thumbnail.jpg',
          grayOriginalUrl: '/gray-original.jpg',
          jetThumbnailUrl: '/jet-thumbnail.jpg',
          jetOriginalUrl: '/jet-original.jpg',
        }],
      }],
    });

    renderPage({
      plate: { ...plate, plateNo: '4034' },
      defects: [focusedDefect],
      selectedDefectId: focusedDefect.id,
    });

    await waitFor(() => expect(
      screen.getByRole('img', { name: '划伤原始大图' }),
    ).toHaveAttribute('data-context-window', '0,145,210,128'));
    const gray = screen.getByRole('img', { name: '划伤原始大图' });
    const jet = screen.getByRole('img', { name: '划伤 JET 大图' });
    expect(gray).toHaveAttribute('data-defect-roi', '30,200,30,18');
    expect(jet).toHaveAttribute('data-context-window', '0,145,210,128');
    expect(document.querySelectorAll('.defect-analysis-roi-box')).toHaveLength(4);
    expect(document.querySelector('.defect-analysis-crosshair')).not.toBeInTheDocument();
  });

  it('uses the BKV defect crop with context instead of an unrelated full capture frame', async () => {
    const focusedDefect: DefectItem = {
      ...defects[0],
      plateNo: '4034',
      previewImageUrl: '/api/bkv-online/image?camera=2&seq=4034&index=113&kind=2d',
      artifacts: {
        ...defects[0].artifacts!,
        roi: { x: 10, y: 20, width: 30, height: 18 },
        sourceFrame: {
          intensity: '/api/bkv-online/image?camera=2&seq=4034&index=113&kind=2d',
          depth: '/api/bkv-online/image?camera=2&seq=4034&index=113&kind=depth',
        },
      },
    };
    vi.mocked(fetchCaptureStitchHistory).mockResolvedValue({
      materialId: '4034',
      indexed: true,
      totalFrames: 0,
      hasMore: false,
      expectedCameraCount: 6,
      renderableImageCount: 0,
      frames: [],
    });

    renderPage({
      plate: { ...plate, plateNo: '4034' },
      defects: [focusedDefect],
      selectedDefectId: focusedDefect.id,
    });
    fireEvent.click(screen.getByRole('button', { name: '卡片' }));

    const gray = await screen.findByRole('img', { name: '划伤原始小图' });
    expect(gray).toHaveAttribute('data-context-window', '0,0,256,128');
    expect(gray).toHaveAttribute('data-defect-roi', '10,20,30,18');
    const image = gray.querySelector('image');
    const grayUrl = new URL(image?.getAttribute('href') ?? '');
    expect(grayUrl.searchParams.get('cropX')).toBe('10');
    expect(grayUrl.searchParams.get('cropY')).toBe('20');
    expect(grayUrl.searchParams.get('cropWidth')).toBe('30');
    expect(grayUrl.searchParams.get('cropHeight')).toBe('18');
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

  it('submits the selected structured annotation through the review callback', async () => {
    const { onReviewDefect } = renderPage();

    fireEvent.change(screen.getByLabelText('标注缺陷类别'), { target: { value: 'pit' } });
    fireEvent.change(screen.getByLabelText('标注严重度'), { target: { value: 'severe' } });
    fireEvent.change(screen.getByLabelText('标注说明'), { target: { value: '人工复核通过' } });
    const confirmButton = screen.getByRole('button', { name: '确认缺陷' });
    fireEvent.click(confirmButton);
    await waitFor(() => expect(onReviewDefect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'D-001',
        typeId: 'pit',
        typeLabel: '凹坑',
        severity: 'severe',
      }),
      'confirmed',
      '人工复核通过',
    ));
    await waitFor(() => expect(confirmButton).toBeEnabled());
  });

  it('requires an annotation note before excluding a false positive', async () => {
    const { onReviewDefect } = renderPage();
    const excludeButton = screen.getByRole('button', { name: '排除误报' });

    expect(excludeButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText('标注说明'), { target: { value: '边缘反光，不是表面缺陷' } });
    expect(excludeButton).toBeEnabled();
    fireEvent.click(excludeButton);

    await waitFor(() => expect(onReviewDefect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'D-001', typeId: 'scratch', severity: 'review' }),
      'false-positive',
      '边缘反光，不是表面缺陷',
    ));
  });

  it('requires replacing a legacy category that is no longer configured', () => {
    const legacyDefect: DefectItem = {
      ...defects[0],
      typeId: 'legacy-unknown',
      typeLabel: '旧版未知类别',
    };
    renderPage({ defects: [legacyDefect, defects[1]] });

    expect(screen.getByRole('option', { name: '旧版未知类别（未配置）' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认缺陷' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('标注缺陷类别'), { target: { value: 'scratch' } });
    expect(screen.getByRole('button', { name: '确认缺陷' })).toBeEnabled();
  });

  it('shows review provenance and can restore a reviewed defect to pending', async () => {
    const reviewedDefect: DefectItem = {
      ...defects[0],
      reviewStatus: 'confirmed',
      reviewedBy: 'reviewer-01',
      reviewedAt: '2026-08-29T10:30:00+08:00',
      reviewNote: '形貌符合划伤',
    };
    const { onReviewDefect } = renderPage({ defects: [reviewedDefect, defects[1]] });

    expect(screen.getByText(/最近操作：reviewer-01/)).toBeInTheDocument();
    expect(screen.getByLabelText('标注说明')).toHaveValue('形貌符合划伤');
    fireEvent.click(screen.getByRole('button', { name: '恢复待复核' }));

    await waitFor(() => expect(onReviewDefect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'D-001' }),
      'pending',
      '形貌符合划伤',
    ));
  });

  it('keeps geometry and legacy detector candidates separate and reports overlap', () => {
    renderPage({
      defectGroups: {
        geometry: {
          defects: [defects[0]],
          state: 'degraded',
          globalPositionAvailable: false,
          riskTags: ['global-position-unavailable'],
        },
        legacy: [defects[1]],
      },
      comparison: {
        matched: 1,
        geometryOnly: 0,
        legacyOnly: 0,
        estimatedUniqueCount: 1,
        cameraLocal: true,
        warning: 'same-camera estimate',
      },
    });

    expect(screen.getByRole('tab', { name: 'All (2)' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Estimated unique: 1 (overlap retained)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Geometry (1)' }));
    expect(screen.getAllByRole('button', { name: /划伤.*C2/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /凹坑.*C6/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Comparison' }));
    expect(screen.getByText('Matched: 1')).toBeInTheDocument();
    expect(screen.getByText('Estimated unique: 1')).toBeInTheDocument();
    expect(screen.getByText('Camera-local estimate: cross-camera matching unavailable.')).toBeInTheDocument();
    expect(screen.getByText('Risk tags: global-position-unavailable')).toBeInTheDocument();
    expect(screen.getByText('same-camera estimate')).toBeInTheDocument();
  });

  it('keeps the analysis view usable when optional groups or comparison are null', () => {
    renderPage({
      selectedDefectId: null,
      defectGroups: { geometry: null, legacy: null },
      comparison: null,
    });

    expect(screen.getByRole('tab', { name: 'All (2)' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Comparison' }));
    expect(screen.getByText('Matched: 0')).toBeInTheDocument();
    expect(screen.getByText('Geometry only: 0')).toBeInTheDocument();
    expect(screen.getByText('Legacy only: 0')).toBeInTheDocument();
  });

  it('does not present geometry pixel progress as encoder-derived millimetres', () => {
    const geometryDefect: DefectItem = {
      ...defects[0],
      source: 'sick-depth-geometry',
      xRatio: 0.2,
      longitudinalMm: null,
      longitudinalSpanMm: null,
      areaMm2: null,
      horizontalSpanMm: 1.25,
      metricAvailability: {
        horizontal: true,
        longitudinal: false,
        longitudinalMm: false,
        longitudinalSpanMm: false,
        area: false,
        areaMm2: false,
        reason: 'encoder-unavailable',
      },
    };
    renderPage({
      defects: [geometryDefect],
      defectGroups: { geometry: [geometryDefect], legacy: [] },
      selectedDefectId: geometryDefect.id,
    });

    expect(screen.getAllByText(/Head-relative 20\.0%/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Horizontal 1\.3 mm · Longitudinal --/).length).toBeGreaterThan(0);
    expect(screen.queryByText('2.40 m')).not.toBeInTheDocument();
  });
});
