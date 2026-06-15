import { describe, expect, it } from 'vitest';
import { getMockInspectionSnapshot } from '../data/inspection';
import { filterInspectionRecords } from './record-search';

describe('filterInspectionRecords', () => {
  const snapshot = getMockInspectionSnapshot();

  it('filters records by serial number', () => {
    const records = filterInspectionRecords(snapshot.records, snapshot.inspections, {
      serialNo: 'R-002',
      plateNo: '',
      time: '',
    });

    expect(records.map((record) => record.id)).toEqual(['R-002']);
  });

  it('filters records by plate number and full detected date', () => {
    const records = filterInspectionRecords(snapshot.records, snapshot.inspections, {
      serialNo: '',
      plateNo: '202606131858',
      time: '2026-06-13',
    });

    expect(records.map((record) => record.plateNo)).toEqual(['202606131858']);
  });

  it('filters records by display time', () => {
    const records = filterInspectionRecords(snapshot.records, snapshot.inspections, {
      serialNo: '',
      plateNo: '',
      time: '17:55',
    });

    expect(records.map((record) => record.plateNo)).toEqual(['202606131755']);
  });
});
