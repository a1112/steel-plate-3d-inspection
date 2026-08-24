import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TopNav } from './TopNav';

describe('TopNav', () => {
  it('exposes one online monitoring entry and no duplicate realtime-monitor entry', () => {
    const onChange = vi.fn();
    render(<TopNav active="online" onChange={onChange} />);

    const navigation = screen.getByRole('navigation');
    const buttons = within(navigation).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
      '在线监测',
      '缺陷报表',
      '报警中心',
    ]);
    expect(within(navigation).getAllByRole('button', { name: '在线监测' })).toHaveLength(1);
    expect(within(navigation).queryByRole('button', { name: '实时监控' })).not.toBeInTheDocument();
    expect(within(navigation).getByRole('button', { name: '在线监测' })).toHaveClass('active');

    fireEvent.click(within(navigation).getByRole('button', { name: '缺陷报表' }));
    expect(onChange).toHaveBeenCalledWith('report');
  });
});
