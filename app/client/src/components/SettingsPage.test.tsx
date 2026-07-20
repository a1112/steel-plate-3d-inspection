import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultSettings, validateSettings } from '../state/operations';
import { SettingsPage } from './SettingsPage';

function renderSettingsPage(onThemeChange = vi.fn(), onThemeStyleChange = vi.fn()) {
  const settings = createDefaultSettings();
  render(
    <SettingsPage
      embedded
      theme="dark"
      draft={settings}
      saved={settings}
      errors={validateSettings(settings)}
      onThemeChange={onThemeChange}
      onThemeStyleChange={onThemeStyleChange}
      onDraftChange={vi.fn()}
      onSave={vi.fn()}
      onReset={vi.fn()}
      onApplyToPlate={vi.fn()}
    />,
  );
  return { onThemeChange, onThemeStyleChange };
}

describe('SettingsPage', () => {
  it('renders a left navigation and applies theme choices from the settings dialog', () => {
    const { onThemeChange, onThemeStyleChange } = renderSettingsPage();

    expect(screen.getByRole('button', { name: /主题外观/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '选择深色工业主题' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '选择浅色巡检主题' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择石墨高对比主题' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '选择蓝钢夜视主题' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '选择绿光值守主题' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择默认界面风格' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '选择柔和界面风格' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择科技界面风格' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择工业界面风格' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择现代界面风格' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '选择石墨高对比主题' }));
    expect(onThemeChange).toHaveBeenCalledWith('graphite');

    fireEvent.click(screen.getByRole('button', { name: '选择科技界面风格' }));
    expect(onThemeStyleChange).toHaveBeenCalledWith('tech');
  });

  it('switches setting sections from the left navigation', () => {
    renderSettingsPage();

    fireEvent.click(screen.getByRole('button', { name: /缺陷判级/ }));

    expect(screen.getByText('缺陷判级参数')).toBeInTheDocument();
    expect(screen.getByLabelText('严重深度阈值')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '选择深色工业主题' })).not.toBeInTheDocument();
  });
});
