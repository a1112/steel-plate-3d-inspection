import defectInclusionImage from '../assets/mock-defects/defect-inclusion.png';
import defectPitImage from '../assets/mock-defects/defect-pit.png';
import defectScratchImage from '../assets/mock-defects/defect-scratch.png';
import type { DefectItem, InspectionSnapshot } from '../data/inspection';

const DEFAULT_BACKEND_ORIGIN = 'http://127.0.0.1:4873';

const defectPreviewImages: Record<string, string> = {
  pit: defectPitImage,
  bubble: defectPitImage,
  scratch: defectScratchImage,
  longitudinal: defectScratchImage,
  edge: defectScratchImage,
  foreign: defectInclusionImage,
  inclusion: defectInclusionImage,
  roll: defectInclusionImage,
  burnt: defectInclusionImage,
  review: defectPitImage,
};

function getBackendOrigin() {
  const configuredOrigin = import.meta.env.VITE_INSPECTION_BACKEND_ORIGIN;
  return configuredOrigin && configuredOrigin.trim().length > 0 ? configuredOrigin : DEFAULT_BACKEND_ORIGIN;
}

function withPreviewImage(defect: DefectItem): DefectItem {
  return {
    ...defect,
    previewImageUrl: defectPreviewImages[defect.typeId] ?? defectPitImage,
  };
}

function normalizeInspectionSnapshot(snapshot: InspectionSnapshot): InspectionSnapshot {
  const inspections = snapshot.inspections.map((inspection) => ({
    ...inspection,
    defects: inspection.defects.map(withPreviewImage),
  }));
  return {
    ...snapshot,
    defects: snapshot.defects.map(withPreviewImage),
    inspections,
  };
}

export async function fetchInspectionSnapshot(signal?: AbortSignal): Promise<InspectionSnapshot> {
  const response = await fetch(`${getBackendOrigin()}/api/inspection/snapshot`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(`后台数据接口异常：${response.status}`);
  }
  return normalizeInspectionSnapshot((await response.json()) as InspectionSnapshot);
}
