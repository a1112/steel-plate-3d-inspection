import { describe, expect, it } from 'vitest';
import { createSequentialCameraLanes, normalizeCameraDisplayLanes } from './camera-display';

describe('camera display parameters', () => {
  it('creates exactly six ordered BKV camera lanes', () => {
    expect(createSequentialCameraLanes(6)).toEqual([
      { cameraId: 'camera1', label: '相机 1', shortLabel: 'C1', order: 0 },
      { cameraId: 'camera2', label: '相机 2', shortLabel: 'C2', order: 1 },
      { cameraId: 'camera3', label: '相机 3', shortLabel: 'C3', order: 2 },
      { cameraId: 'camera4', label: '相机 4', shortLabel: 'C4', order: 3 },
      { cameraId: 'camera5', label: '相机 5', shortLabel: 'C5', order: 4 },
      { cameraId: 'camera6', label: '相机 6', shortLabel: 'C6', order: 5 },
    ]);
  });

  it('preserves acquisition order and derives labels from camera identifiers', () => {
    expect(normalizeCameraDisplayLanes(['camera3', 'camera1'])).toEqual([
      { cameraId: 'camera3', label: '相机 3', shortLabel: 'C3', order: 0 },
      { cameraId: 'camera1', label: '相机 1', shortLabel: 'C1', order: 1 },
    ]);
  });

  it('keeps an empty camera configuration empty', () => {
    expect(normalizeCameraDisplayLanes([])).toEqual([]);
  });

  it('rejects invalid counts, blank identifiers and duplicate cameras', () => {
    expect(() => createSequentialCameraLanes(0)).toThrow('camera count');
    expect(() => normalizeCameraDisplayLanes(['camera1', ' '])).toThrow('camera identifier');
    expect(() => normalizeCameraDisplayLanes(['camera1', 'CAMERA1'])).toThrow('duplicate camera identifier');
  });
});
