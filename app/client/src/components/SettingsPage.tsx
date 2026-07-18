import { ClipboardCheck, Gauge, Palette, RadioTower, RotateCcw, Save, Send, Server } from 'lucide-react';
import { useState, type ChangeEvent, type ElementType } from 'react';
import type { ThemeMode } from '../data/inspection';
import type { ConnectionConfig, ConnectionMode } from '../services/inspection-api';
import type { InspectionSettings, SettingsErrors } from '../state/operations';
import { Panel } from './Panel';

type NumberSettingKey = 'severeDepthMm' | 'reviewDepthMm' | 'minDefectWidthMm' | 'cameraExposureUs' | 'encoderPulsePerMeter' | 'alarmVolume';
type BooleanSettingKey = 'autoReview' | 'saveRawImages';
type SettingsSection = 'theme' | 'connection' | 'grading' | 'acquisition' | 'status';

const settingsSections: Array<{ id: SettingsSection; label: string; hint: string; icon: ElementType }> = [
  { id: 'theme', label: '主题外观', hint: '界面配色与显示风格', icon: Palette },
  { id: 'connection', label: '连接设置', hint: '在线/演示与服务端地址', icon: Server },
  { id: 'grading', label: '缺陷判级', hint: '严重、复核与尺寸阈值', icon: Gauge },
  { id: 'acquisition', label: '采集联机', hint: '相机、编码器与归档', icon: RadioTower },
  { id: 'status', label: '参数状态', hint: '保存、应用与恢复', icon: ClipboardCheck },
];

const themeOptions: Array<{ id: ThemeMode; label: string; description: string; swatches: string[] }> = [
  { id: 'light', label: '浅色巡检', description: '默认亮环境值守', swatches: ['#f3f6fa', '#2f7dff', '#07162c'] },
  { id: 'dark', label: '深色工业', description: '工业监控暗色', swatches: ['#11181c', '#2f7dff', '#4ed463'] },
  { id: 'graphite', label: '石墨高对比', description: '低照度机房', swatches: ['#090d10', '#00b8d4', '#f2f5f6'] },
];

function NumberField({
  label,
  unit,
  value,
  error,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  error?: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="setting-field">
      <span>{label}</span>
      <div className="number-input">
        <input
          aria-label={label}
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <b>{unit}</b>
      </div>
      {error ? <em>{error}</em> : null}
    </label>
  );
}

function ToggleField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="toggle-field">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i />
    </label>
  );
}

function ThemeSelector({ theme, onThemeChange }: { theme: ThemeMode; onThemeChange: (theme: ThemeMode) => void }) {
  return (
    <div className="theme-option-grid">
      {themeOptions.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`theme-option-card ${theme === option.id ? 'active' : ''}`}
          aria-pressed={theme === option.id}
          aria-label={`选择${option.label}主题`}
          onClick={() => onThemeChange(option.id)}
        >
          <span className="theme-option-copy">
            <strong>{option.label}</strong>
            <em>{option.description}</em>
          </span>
          <span className="theme-option-swatches" aria-hidden="true">
            {option.swatches.map((color) => (
              <i key={color} style={{ background: color }} />
            ))}
          </span>
        </button>
      ))}
    </div>
  );
}

export function SettingsPage({
  theme,
  draft,
  saved,
  errors,
  connection = { mode: 'online', host: '127.0.0.1', port: 4873 },
  connectionStatus,
  onThemeChange,
  onDraftChange,
  onConnectionChange = () => undefined,
  onConnectionSave = () => undefined,
  onSave,
  onReset,
  onApplyToPlate,
  embedded = false,
}: {
  theme: ThemeMode;
  draft: InspectionSettings;
  saved: InspectionSettings;
  errors: SettingsErrors;
  connection?: ConnectionConfig;
  connectionStatus?: string | null;
  onThemeChange: (theme: ThemeMode) => void;
  onDraftChange: (patch: Partial<InspectionSettings>) => void;
  onConnectionChange?: (patch: Partial<ConnectionConfig>) => void;
  onConnectionSave?: () => void;
  onSave: () => void;
  onReset: () => void;
  onApplyToPlate: () => void;
  embedded?: boolean;
}) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('theme');
  const setNumber = (key: NumberSettingKey) => (value: number) => onDraftChange({ [key]: value });
  const setBoolean = (key: BooleanSettingKey) => (checked: boolean) => onDraftChange({ [key]: checked });
  const setConnectionMode = (mode: ConnectionMode) => onConnectionChange({ mode });
  const handleVolume = (event: ChangeEvent<HTMLInputElement>) => onDraftChange({ alarmVolume: Number(event.target.value) });
  const currentThemeLabel = themeOptions.find((option) => option.id === theme)?.label ?? '深色工业';

  return (
    <div className={`settings-page ${embedded ? 'settings-page-embedded' : 'workspace-page'}`}>
      <section className="settings-layout">
        <aside className="settings-sidebar" aria-label="设置分组">
          <div className="settings-sidebar-head">
            <span>当前主题</span>
            <strong>{currentThemeLabel}</strong>
          </div>
          <div className="settings-section-list">
            {settingsSections.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={activeSection === item.id ? 'active' : ''}
                  aria-pressed={activeSection === item.id}
                  onClick={() => setActiveSection(item.id)}
                >
                  <Icon size={18} />
                  <span>
                    <strong>{item.label}</strong>
                    <em>{item.hint}</em>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="settings-content">
          {activeSection === 'theme' ? (
            <Panel title="主题外观" className="settings-panel settings-theme-panel">
              <ThemeSelector theme={theme} onThemeChange={onThemeChange} />
            </Panel>
          ) : null}

          {activeSection === 'connection' ? (
            <Panel title="连接设置" className="settings-panel">
              <div className="connection-mode-toggle" role="group" aria-label="数据模式">
                <button type="button" className={connection.mode === 'online' ? 'active' : ''} onClick={() => setConnectionMode('online')}>
                  在线模式
                </button>
                <button type="button" className={connection.mode === 'demo' ? 'active' : ''} onClick={() => setConnectionMode('demo')}>
                  演示模式
                </button>
              </div>
              <label className="setting-field">
                <span>服务端 IP</span>
                <input
                  aria-label="服务端 IP"
                  value={connection.host}
                  disabled={connection.mode === 'demo'}
                  onChange={(event) => onConnectionChange({ host: event.target.value })}
                />
              </label>
              <label className="setting-field">
                <span>服务端端口</span>
                <div className="number-input">
                  <input
                    aria-label="服务端端口"
                    type="number"
                    min={1}
                    max={65535}
                    value={connection.port}
                    disabled={connection.mode === 'demo'}
                    onChange={(event) => onConnectionChange({ port: Number(event.target.value) })}
                  />
                  <b>port</b>
                </div>
              </label>
              <div className="settings-actions">
                <button type="button" onClick={onConnectionSave}>
                  <Save size={16} />
                  保存连接
                </button>
                <button type="button" onClick={() => window.open('/?app=parameters', '_blank', 'popup,width=1480,height=900')}>
                  <Server size={16} />
                  参数管理
                </button>
              </div>
              <dl className="settings-summary">
                <div>
                  <dt>当前模式</dt>
                  <dd>{connection.mode === 'online' ? '在线模式' : '演示模式'}</dd>
                </div>
                <div>
                  <dt>数据来源</dt>
                  <dd>{connection.mode === 'online' ? '服务端 SQLite 数据库' : '客户端内置演示数据'}</dd>
                </div>
                <div>
                  <dt>服务端地址</dt>
                  <dd>{connection.host}:{connection.port}</dd>
                </div>
                <div>
                  <dt>状态</dt>
                  <dd>{connectionStatus ?? '待保存'}</dd>
                </div>
              </dl>
            </Panel>
          ) : null}

          {activeSection === 'grading' ? (
            <Panel title="缺陷判级参数" className="settings-panel">
              <NumberField label="严重深度阈值" unit="mm" value={draft.severeDepthMm} min={0.01} max={1} step={0.01} error={errors.severeDepthMm} onChange={setNumber('severeDepthMm')} />
              <NumberField label="待复核深度阈值" unit="mm" value={draft.reviewDepthMm} min={0.01} max={1} step={0.01} error={errors.reviewDepthMm} onChange={setNumber('reviewDepthMm')} />
              <NumberField label="最小缺陷宽度" unit="mm" value={draft.minDefectWidthMm} min={0.01} max={5} step={0.01} error={errors.minDefectWidthMm} onChange={setNumber('minDefectWidthMm')} />
              <ToggleField label="检测后自动进入复核队列" checked={draft.autoReview} onChange={setBoolean('autoReview')} />
            </Panel>
          ) : null}

          {activeSection === 'acquisition' ? (
            <Panel title="采集与联机参数" className="settings-panel">
              <NumberField label="相机曝光时间" unit="us" value={draft.cameraExposureUs} min={100} max={5000} step={10} error={errors.cameraExposureUs} onChange={setNumber('cameraExposureUs')} />
              <NumberField label="编码器脉冲" unit="p/m" value={draft.encoderPulsePerMeter} min={500} max={10000} step={1} error={errors.encoderPulsePerMeter} onChange={setNumber('encoderPulsePerMeter')} />
              <ToggleField label="保存原始灰度与点云数据" checked={draft.saveRawImages} onChange={setBoolean('saveRawImages')} />
              <label className="setting-field">
                <span>报警音量</span>
                <input className="range-input" aria-label="报警音量" type="range" min={0} max={100} value={draft.alarmVolume} onChange={handleVolume} />
                <strong>{draft.alarmVolume}%</strong>
                {errors.alarmVolume ? <em>{errors.alarmVolume}</em> : null}
              </label>
            </Panel>
          ) : null}

          {activeSection === 'status' ? (
            <Panel title="参数状态" className="settings-summary-panel">
              <dl className="settings-summary">
                <div>
                  <dt>当前主题</dt>
                  <dd>{currentThemeLabel}</dd>
                </div>
                <div>
                  <dt>已保存严重阈值</dt>
                  <dd>{saved.severeDepthMm.toFixed(2)}mm</dd>
                </div>
                <div>
                  <dt>已保存待复核阈值</dt>
                  <dd>{saved.reviewDepthMm.toFixed(2)}mm</dd>
                </div>
                <div>
                  <dt>相机曝光</dt>
                  <dd>{saved.cameraExposureUs}us</dd>
                </div>
                <div>
                  <dt>原始数据归档</dt>
                  <dd>{saved.saveRawImages ? '启用' : '关闭'}</dd>
                </div>
              </dl>
              <div className="settings-actions">
                <button type="button" onClick={onSave}>
                  <Save size={16} />
                  保存参数
                </button>
                <button type="button" onClick={onApplyToPlate}>
                  <Send size={16} />
                  应用到当前材料
                </button>
                <button type="button" onClick={onReset}>
                  <RotateCcw size={16} />
                  恢复默认
                </button>
              </div>
            </Panel>
          ) : null}
        </section>
      </section>
    </div>
  );
}
