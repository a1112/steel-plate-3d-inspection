import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DefectItem } from '../data/inspection';
import { DefectImagePanel } from './DefectImagePanel';

const defect: DefectItem = {
  id: 'SICK-63-C1-000001',
  plateNo: '63',
  inspectionId: 'INSP-63',
  typeId: 'scratch',
  typeLabel: '划伤',
  surface: 'top',
  severity: 'review',
  distanceHeadMm: 0,
  operatorSideMm: 0,
  driveSideMm: 0,
  widthMm: 0,
  heightMm: 0,
  depthMm: 0,
  xRatio: 0.25,
  yOffsetMm: 0,
  previewX: 25,
  previewY: 10,
  previewImageUrl: 'http://127.0.0.1:4873/api/capture/file?path=crop.png',
  cameraId: 'C1',
  cameraIndex: 1,
  confidence: 0.91,
  reviewStatus: 'pending',
  artifacts: {
    schema: 'steel.surface.defect.artifacts.v1',
    cameraId: 'C1',
    frameId: '18',
    sequenceNo: 18,
    roi: { x: 100, y: 200, width: 8, height: 9 },
  },
};

afterEach(() => vi.restoreAllMocks());

describe('DefectImagePanel review workflow', () => {
  it('uses the cached defect crop and submits an operator review', async () => {
    const onReviewDefect = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(window, 'prompt').mockReturnValue('人工确认');
    render(
      <DefectImagePanel
        inspectionId="INSP-63"
        defect={defect}
        onReviewDefect={onReviewDefect}
      />,
    );

    expect(screen.getByRole('img', { name: /划伤/ })).toHaveAttribute(
      'src',
      `${defect.previewImageUrl}&maxWidth=960&maxHeight=640`,
    );
    fireEvent.click(screen.getByRole('button', { name: '确认缺陷' }));
    await waitFor(() => expect(onReviewDefect).toHaveBeenCalledWith(defect, 'confirmed', '人工确认'));
  });

  it('prefers the LAN-normalized preview over a raw Windows ROI path', () => {
    const productionDefect: DefectItem = {
      ...defect,
      artifacts: {
        ...defect.artifacts!,
        roiImage: 'E:\\C2\\4034\\defect\\4034-C2-000001.jpg',
      },
    };

    render(<DefectImagePanel inspectionId="INSP-4034" defect={productionDefect} />);

    expect(screen.getByRole('img', { name: /划伤/ })).toHaveAttribute(
      'src',
      `${defect.previewImageUrl}&maxWidth=960&maxHeight=640`,
    );
  });

  it('routes a raw Windows ROI path through the capture file service', () => {
    const rawPathDefect: DefectItem = {
      ...defect,
      previewImageUrl: '',
      artifacts: {
        ...defect.artifacts!,
        roiImage: 'E:\\C2\\4034\\defect\\4034-C2-000001.jpg',
      },
    };

    render(<DefectImagePanel defect={rawPathDefect} />);

    const source = screen.getByRole('img', { name: /划伤/ }).getAttribute('src') ?? '';
    expect(source).toContain('/api/capture/file?');
    expect(source).toContain('E%3A%5CC2%5C4034%5Cdefect%5C4034-C2-000001.jpg');
    expect(source).not.toContain('/api/algorithm/bar-surface/file');
  });

  it('treats a cancelled note prompt as cancellation instead of writing an empty review', () => {
    const onReviewDefect = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    render(<DefectImagePanel defect={defect} onReviewDefect={onReviewDefect} />);

    fireEvent.click(screen.getByRole('button', { name: '排除误报' }));

    expect(onReviewDefect).not.toHaveBeenCalled();
  });

  it('keeps review failures inside the panel without an unhandled rejection', async () => {
    const onReviewDefect = vi.fn().mockRejectedValue(new Error('当前账号没有复核权限'));
    vi.spyOn(window, 'prompt').mockReturnValue('确认');
    render(<DefectImagePanel defect={defect} onReviewDefect={onReviewDefect} />);

    fireEvent.click(screen.getByRole('button', { name: '确认缺陷' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('当前账号没有复核权限');
    expect(screen.getByRole('button', { name: '确认缺陷' })).not.toBeDisabled();
  });

  it('does not treat an ordinary source-frame intensity file as a defect crop', () => {
    const sourceFrameOnly: DefectItem = {
      ...defect,
      previewImageUrl: '',
      artifacts: {
        ...defect.artifacts!,
        sourceFrame: {
          intensity: 'http://127.0.0.1:4873/api/capture/file?path=63%2Fcapture%2FC1%2F2d%2F18.png',
        },
      },
    };

    render(<DefectImagePanel defect={sourceFrameOnly} />);

    expect(screen.getByText('算法 ROI 小图未就绪')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('does not request an inspection frame when its ROI is invalid', () => {
    const invalidRoi: DefectItem = {
      ...defect,
      previewImageUrl: '',
      artifacts: {
        ...defect.artifacts!,
        roi: { x: 100, y: 200, width: 0, height: 9 },
      },
    };

    render(<DefectImagePanel inspectionId="INSP-63" defect={invalidRoi} />);

    expect(screen.getByText('算法 ROI 小图未就绪')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('uses a BKV source frame only through a legal ROI crop request', () => {
    const bkvRoi: DefectItem = {
      ...defect,
      previewImageUrl: '',
      artifacts: {
        ...defect.artifacts!,
        sourceFrame: {
          intensity: '/api/bkv-online/image?camera=1&seq=63&index=18&kind=2d',
        },
      },
    };

    render(<DefectImagePanel defect={bkvRoi} />);

    const image = screen.getByRole('img', { name: /划伤/ });
    expect(image).toHaveAttribute('src', expect.stringContaining('cropX=100'));
    expect(image).toHaveAttribute('src', expect.stringContaining('cropHeight=9'));
  });
});
