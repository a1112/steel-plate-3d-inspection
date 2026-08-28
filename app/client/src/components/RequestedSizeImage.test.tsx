import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RequestedSizeImage, requestedSizeImageUrl } from './RequestedSizeImage';

describe('RequestedSizeImage', () => {
  it('adds quantized physical request bounds only to resize-capable image routes', () => {
    expect(requestedSizeImageUrl(
      '/api/production/file?path=records%2FC1.png',
      301,
      101,
      2,
    )).toBe('/api/production/file?path=records%2FC1.png&maxWidth=640&maxHeight=256');
    expect(requestedSizeImageUrl('/assets/logo.png', 300, 100, 2)).toBe('/assets/logo.png');
  });

  it('never starts with an unbounded production image request', () => {
    render(
      <RequestedSizeImage
        src="/api/production/file?path=records%2FC1.png"
        alt="production"
        requestWidth={320}
        requestHeight={160}
      />,
    );
    expect(screen.getByRole('img', { name: 'production' })).toHaveAttribute(
      'src',
      '/api/production/file?path=records%2FC1.png&maxWidth=320&maxHeight=192',
    );
  });
});
