import { describe, expect, it } from 'vitest';
import { connectionModeLabel } from './connection-mode';

describe('developer service connection labels', () => {
  it('keeps online/demo terminology separate from formal acquisition modes', () => {
    expect(connectionModeLabel('online')).toBe('服务连接（在线 API）');
    expect(connectionModeLabel('demo')).toBe('开发演示（本地假数据，非采集模拟）');
  });
});
