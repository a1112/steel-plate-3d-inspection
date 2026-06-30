export type LayoutDensity = 'comfortable' | 'compact' | 'dense';
export type LayoutWidthClass = 'wide' | 'standard' | 'narrow';
export type LayoutHeightClass = 'tall' | 'short';

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ResponsiveProfile {
  density: LayoutDensity;
  widthClass: LayoutWidthClass;
  heightClass: LayoutHeightClass;
}

export function getResponsiveProfile({ width, height }: ViewportSize): ResponsiveProfile {
  const widthClass: LayoutWidthClass = width >= 1500 ? 'wide' : width >= 1366 ? 'standard' : 'narrow';
  const heightClass: LayoutHeightClass = height >= 830 ? 'tall' : 'short';
  let density: LayoutDensity = 'comfortable';

  if (width < 1366 || height < 740) {
    density = 'dense';
  } else if (width < 1500 || height < 830) {
    density = 'compact';
  }

  return { density, widthClass, heightClass };
}

export function getResponsiveProfileClassName(profile: ResponsiveProfile): string {
  return `layout-${profile.widthClass} height-${profile.heightClass} density-${profile.density}`;
}
