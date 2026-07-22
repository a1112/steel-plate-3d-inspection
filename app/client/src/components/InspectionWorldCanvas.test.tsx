import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchInspectionWorldTile, type InspectionWorldDefect, type InspectionWorldMeta } from '../services/inspection-world-api';
import { InspectionWorldCanvas } from './InspectionWorldCanvas';

vi.mock('../services/inspection-world-api', async () => {
  const actual = await vi.importActual<typeof import('../services/inspection-world-api')>('../services/inspection-world-api');
  return { ...actual, fetchInspectionWorldTile: vi.fn() };
});

const meta: InspectionWorldMeta = {
  schema: 'steel.inspection-world.meta.v1', provider: 'bkv', recordId: '1893700', sourceFrameCount: 126,
  world: {
    width: 600, height: 21504, tileSize: 512, maxLevel: 15,
    cameras: Array.from({ length: 6 }, (_, index) => ({
      cameraId: index + 1, offsetX: index * 100, width: 100, height: 21504,
      frameWidth: 100, frameHeight: 1024, frameNumbers: Array.from({ length: 21 }, (__, frame) => frame),
      orientation: { frameOrder: 'ascending', rotation: 0, flipX: false, flipY: false },
    })),
  },
};

const defects: InspectionWorldDefect[] = [
  { id: 2019096, className: '轧折', cameraId: 1, imageIndex: 12, locatable: true, worldRect: { x: 73, y: 13145, width: 10, height: 10 } },
  { id: 2, className: '不可定位', locatable: false, worldRect: null },
];

describe('InspectionWorldCanvas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchInspectionWorldTile).mockImplementation(async (_record, tile) => ({ ...tile, url: `blob:${tile.level}-${tile.x}-${tile.y}`, revoke: vi.fn() }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(),
      save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
  });

  it('requests only visible tiles and exposes configured camera boundaries', async () => {
    render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    expect(screen.getByRole('img', { name: '1893700 检测图像世界' })).toBeInTheDocument();
    expect(screen.getAllByTestId('inspection-world-camera')).toHaveLength(6);
    expect(screen.getByText('C1')).toBeInTheDocument();
    expect(screen.getByText('C6')).toBeInTheDocument();
    expect(screen.queryByText('C7')).not.toBeInTheDocument();
    expect(screen.getByTestId('inspection-world-canvas')).toHaveAttribute('data-locatable-defects', '1');
    await waitFor(() => expect(fetchInspectionWorldTile).toHaveBeenCalled());
    expect(vi.mocked(fetchInspectionWorldTile).mock.calls.length).toBeLessThan(126);
  });

  it('changes LOD on wheel zoom and pans with pointer dragging', async () => {
    render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    const canvas = screen.getByTestId('inspection-world-canvas');
    await waitFor(() => expect(fetchInspectionWorldTile).toHaveBeenCalled());
    const initialLevel = canvas.getAttribute('data-level');
    const initialX = canvas.getAttribute('data-view-x');

    fireEvent.wheel(canvas, { deltaY: -500, clientX: 500, clientY: 300 });
    await waitFor(() => expect(canvas.getAttribute('data-level')).not.toBe(initialLevel));
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 500, clientY: 300 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 450, clientY: 300 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 450, clientY: 300 });
    expect(canvas.getAttribute('data-view-x')).not.toBe(initialX);
  });

  it('focuses a locatable defect and reports a failed tile without shifting the world', async () => {
    vi.mocked(fetchInspectionWorldTile).mockImplementation(async (_record, tile) => {
      if (tile.y === 0) throw new Error('missing tile');
      return { ...tile, url: `blob:${tile.level}-${tile.x}-${tile.y}`, revoke: vi.fn() };
    });
    const { rerender } = render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 个瓦片读取失败'));
    const canvas = screen.getByTestId('inspection-world-canvas');
    const initialY = canvas.getAttribute('data-view-y');
    rerender(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} focusDefectId={2019096} />);
    await waitFor(() => expect(canvas.getAttribute('data-view-y')).not.toBe(initialY));
  });
});
