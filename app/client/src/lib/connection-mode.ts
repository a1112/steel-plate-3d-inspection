import type { ConnectionMode } from '../services/inspection-api';

export const CONNECTION_MODE_LABELS: Record<ConnectionMode, string> = {
  online: '服务连接（在线 API）',
  demo: '开发演示（本地假数据，非采集模拟）',
};

export function connectionModeLabel(mode: ConnectionMode) {
  return CONNECTION_MODE_LABELS[mode];
}
