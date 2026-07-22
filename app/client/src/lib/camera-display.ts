export type CameraDisplayLane = {
  cameraId: string;
  label: string;
  shortLabel: string;
  order: number;
};

function cameraNumber(cameraId: string, fallback: number) {
  const match = cameraId.match(/(\d+)$/);
  return match ? Number(match[1]) : fallback;
}

export function normalizeCameraDisplayLanes(cameraIds: Array<string | number>): CameraDisplayLane[] {
  const seen = new Set<string>();
  return cameraIds.map((value, order) => {
    const cameraId = String(value).trim();
    if (!cameraId) throw new Error('camera identifier must not be blank');
    const stableId = cameraId.toLowerCase();
    if (seen.has(stableId)) throw new Error(`duplicate camera identifier: ${cameraId}`);
    seen.add(stableId);
    const number = cameraNumber(cameraId, order + 1);
    return { cameraId: stableId, label: `相机 ${number}`, shortLabel: `C${number}`, order };
  });
}

export function createSequentialCameraLanes(count: number): CameraDisplayLane[] {
  if (!Number.isInteger(count) || count <= 0) throw new Error('camera count must be a positive integer');
  return normalizeCameraDisplayLanes(Array.from({ length: count }, (_, index) => `camera${index + 1}`));
}
