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

  it('discovers LAN services and applies the selected IP to connection settings', () => {
    const settings = createDefaultSettings();
    const onConnectionDiscover = vi.fn();
    const onConnectionAutoSet = vi.fn();
    const service = {
      host: '192.168.10.25',
      port: 4873,
      origin: 'http://192.168.10.25:4873',
      scope: 'lan',
      preferred: true,
    };
    render(
      <SettingsPage
        embedded
        theme="dark"
        draft={settings}
        saved={settings}
        errors={{}}
        connection={{ mode: 'online', host: '127.0.0.1', port: 4873 }}
        discoveredServices={[service]}
        discoveryStatus="发现 1 个可用地址"
        onThemeChange={vi.fn()}
        onDraftChange={vi.fn()}
        onConnectionDiscover={onConnectionDiscover}
        onConnectionAutoSet={onConnectionAutoSet}
        onSave={vi.fn()}
        onReset={vi.fn()}
        onApplyToPlate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /连接设置/ }));
    fireEvent.click(screen.getByRole('button', { name: '自动发现' }));
    expect(onConnectionDiscover).toHaveBeenCalledTimes(1);
    expect(screen.getByText('192.168.10.25:4873')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '自动设置' }));
    expect(onConnectionAutoSet).toHaveBeenCalledWith(service);
  });
});
