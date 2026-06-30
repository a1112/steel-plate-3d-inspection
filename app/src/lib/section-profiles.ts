import type { ChartPoint, DefectItem } from '../data/inspection';

export interface SectionProfilePoint extends ChartPoint {
  lengthSection: number;
  widthSection: number;
}

export function createSectionProfiles(points: ChartPoint[], defect: DefectItem): SectionProfilePoint[] {
  const widthCenter = Math.max(8, Math.min(72, Math.round((defect.previewX / 100) * 80)));
  const widthSpread = Math.max(10, Math.min(26, defect.widthMm * 46));
  const depth = defect.depthMm;

  return points.map((point) => {
    const widthDip = Math.exp(-Math.pow(point.x - widthCenter, 2) / widthSpread) * depth * 0.92;
    const widthRipple = Math.cos(point.x / 7 + defect.yOffsetMm) * 0.012;

    return {
      ...point,
      lengthSection: point.z,
      widthSection: Number((widthDip + widthRipple).toFixed(3)),
    };
  });
}
