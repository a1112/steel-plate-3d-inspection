import { describe, expect, it } from 'vitest';
import { acquisitionModeLabel } from './acquisition-mode';

describe('acquisition mode labels', () => {
  it('uses the formal three-mode wording everywhere', () => {
    expect(acquisitionModeLabel('online')).toBe('在线（真实相机）');
    expect(acquisitionModeLabel('offline')).toBe('离线（历史模式）');
    expect(acquisitionModeLabel('simulation')).toBe('模拟（数据回放）');
  });
});
