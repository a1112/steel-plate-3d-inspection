import { describe, expect, it } from 'vitest';
import { getResponsiveProfile, getResponsiveProfileClassName } from './responsive-layout';

describe('responsive layout profile', () => {
  it('keeps the accepted design viewport in the comfortable wide profile', () => {
    const profile = getResponsiveProfile({ width: 1676, height: 945 });

    expect(profile).toEqual({
      density: 'comfortable',
      widthClass: 'wide',
      heightClass: 'tall',
    });
    expect(getResponsiveProfileClassName(profile)).toBe('layout-wide height-tall density-comfortable');
  });

  it('uses compact layout at the minimum Tauri desktop size', () => {
    expect(getResponsiveProfile({ width: 1366, height: 768 })).toEqual({
      density: 'compact',
      widthClass: 'standard',
      heightClass: 'short',
    });
  });

  it('uses dense narrow layout below the minimum desktop target', () => {
    expect(getResponsiveProfile({ width: 1280, height: 720 })).toEqual({
      density: 'dense',
      widthClass: 'narrow',
      heightClass: 'short',
    });
  });
});
