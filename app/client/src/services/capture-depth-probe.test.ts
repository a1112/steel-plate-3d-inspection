import { describe, expect, it } from 'vitest';
import {
  captureDepthArtifactRef,
  decodeJetResidualRgb,
  mapFramePointerToCapturePixel,
} from './capture-depth-probe';

describe('capture depth probe', () => {
  it('maps the rotated horizontal frame back to the original depth pixel', () => {
    expect(mapFramePointerToCapturePixel({
      localX: 88,
      localY: 50,
      displayWidth: 176,
      displayHeight: 100,
      sourceWidth: 2560,
      sourceHeight: 1024,
      validRoi: [100, 0, 700, 1024],
      orientation: 'horizontal',
    })).toEqual({
      sourceX: 400,
      sourceY: 512,
      cropXRatio: 0.5,
      rowRatio: 0.5,
    });
  });

  it('decodes the production JET palette back to a cylinder residual', () => {
    expect(decodeJetResidualRgb(128, 255, 128)).toBeCloseTo(0, 2);
    expect(decodeJetResidualRgb(255, 0, 0)).toBeCloseTo(0.75, 2);
    expect(decodeJetResidualRgb(0, 0, 0)).toBeNull();
  });

  it('derives the immutable 3D archive from a stitched 2D artifact', () => {
    expect(captureDepthArtifactRef('4034/capture/C2/2d/113.png'))
      .toBe('4034/capture/C2/3d/113.npz');
  });
});
