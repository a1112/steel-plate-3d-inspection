import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InspectionFlowTool } from './InspectionFlowTool';

describe('InspectionFlowTool footer integration', () => {
  it('does not render its legacy launcher while externally hidden', () => {
    render(<InspectionFlowTool visible={false} onVisibleChange={vi.fn()} />);

    expect(screen.queryByRole('button', { name: '全流程' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('完整检测流程悬浮工具')).not.toBeInTheDocument();
  });

  it('reports close actions to the footer-owned visibility state', () => {
    const onVisibleChange = vi.fn();
    render(<InspectionFlowTool visible onVisibleChange={onVisibleChange} />);

    fireEvent.click(screen.getByRole('button', { name: '关闭完整检测工具' }));
    expect(onVisibleChange).toHaveBeenCalledWith(false);
  });
});
