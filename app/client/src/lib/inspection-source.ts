import type { InspectionSourceEvidence } from '../data/inspection';

export type InspectionSourcePresentation = {
  label: string;
  tone: 'production' | 'simulation' | 'history';
  title: string;
};

export function inspectionSourcePresentation(
  evidence: InspectionSourceEvidence,
): InspectionSourcePresentation {
  if (evidence.replayed || evidence.sourceMode === 'simulation') {
    return {
      label: '模拟回放·不计入生产验收',
      tone: 'simulation',
      title: [
        evidence.sourceDatasetId ? `数据集 ${evidence.sourceDatasetId}` : '',
        evidence.sourceRunId ? `运行 ${evidence.sourceRunId}` : '',
        evidence.sourceSessionId ? `源会话 ${evidence.sourceSessionId}` : '',
        evidence.sourceContentHash ? `内容 ${evidence.sourceContentHash}` : '',
      ].filter(Boolean).join(' · ') || '回放记录永久排除在生产验收统计之外',
    };
  }
  if (!evidence.sourceMode || evidence.sourceMode === 'unknown' || evidence.sourceMode === 'legacy_unknown') {
    return {
      label: '历史来源未知',
      tone: 'history',
      title: '旧记录没有可验证的采集来源证据',
    };
  }
  if (evidence.productionEligible === false) {
    return {
      label: '非生产来源·不计入生产验收',
      tone: 'history',
      title: `来源模式 ${evidence.sourceMode}`,
    };
  }
  return evidence.sourceMode === 'online'
    ? {
        label: '生产采集',
        tone: 'production',
        title: evidence.sourceRunId ? `运行 ${evidence.sourceRunId}` : '来源模式 online',
      }
    : {
        label: '离线历史',
        tone: 'history',
        title: evidence.sourceRunId ? `运行 ${evidence.sourceRunId}` : `来源模式 ${evidence.sourceMode}`,
      };
}
