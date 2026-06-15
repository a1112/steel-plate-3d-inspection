import type { InspectionRecord, PlateInspection } from '../data/inspection';

export interface RecordSearchFilters {
  serialNo: string;
  plateNo: string;
  time: string;
}

export const emptyRecordSearchFilters: RecordSearchFilters = {
  serialNo: '',
  plateNo: '',
  time: '',
};

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase();
}

export function filterInspectionRecords(records: InspectionRecord[], inspections: PlateInspection[], filters: RecordSearchFilters) {
  const serialNo = normalizeSearchText(filters.serialNo);
  const plateNo = normalizeSearchText(filters.plateNo);
  const time = normalizeSearchText(filters.time);

  if (!serialNo && !plateNo && !time) {
    return records;
  }

  const detectedAtByPlate = new Map(inspections.map((inspection) => [inspection.plate.plateNo, inspection.plate.detectedAt.toLowerCase()]));

  return records.filter((record) => {
    if (serialNo && !record.id.toLowerCase().includes(serialNo)) {
      return false;
    }
    if (plateNo && !record.plateNo.toLowerCase().includes(plateNo)) {
      return false;
    }
    if (time) {
      const detectedAt = detectedAtByPlate.get(record.plateNo) ?? '';
      const timeText = `${record.time.toLowerCase()} ${detectedAt}`;
      if (!timeText.includes(time)) {
        return false;
      }
    }
    return true;
  });
}
