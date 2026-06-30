import { ClipboardCheck, Gauge, Palette, RadioTower, RotateCcw, Save, Send } from 'lucide-react';
import { useState, type ChangeEvent, type ElementType } from 'react';
import type { ThemeMode } from '../data/inspection';
import type { InspectionSettings, SettingsErrors } from '../state/operations';
import { Panel } from './Panel';

type NumberSettingKey = 'severeDepthMm' | 'reviewDepthMm' | 'minDefectWidthMm' | 'cameraExposureUs' | 'encoderPulsePerMeter' | 'alarmVolume';
type BooleanSettingKey = 'autoReview' | 'saveRawImages';
type SettingsSection = 'theme' | 'grading' | 'acquisition' | 'status';

const settingsSections: Array<{ id: SettingsSection; label: string; hint: string; icon: ElementType }> = [
  { id: 'theme', label: '主题外观', hint: '界面配色与显示风格', icon: Palette },
  { id: 'grading', label: '缺陷判级', hint: '严重、复核与尺寸阈值', icon: Gauge },
  { id: 'acquisition', label: '采集联机', hint: '相机、编码器与归档', icon: RadioTower },
  { id: 'status', label: '参数状态', hint: '保存、应用与恢复', icon: ClipboardCheck },
];

const themeOptions: Array<{ id: ThemeMode; label: string; description: string; swatches: string[] }> = [
  { id: 'dark', label: '深色工业', description: '默认验收暗色', swatches: ['#11181c', '#2f7dff', '#4ed463'] },
  { id: 'light', label: '浅色巡检', description: '亮环境值守', swatches: ['#f3f6fa', '#2f7dff', '#07162c'] },
  { id: 'graphite', label: '石墨高对比', description: '低照度机房', swatches: ['#090d10', '#00b8d4', '#f2f5f6'] },
  { id: 'cobalt', label: '蓝钢夜视', description: '蓝色监控风格', swatches: ['#081220', '#4d8dff', '#50d890'] },
  { id: 'emerald', label: '绿光值守', description: '产线运行风格', swatches: ['#0c1715', '#21b8c7', '#45e38a'] },
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
  onThemeChange,
  onDraftChange,
  onSave,
  onReset,
  onApplyToPlate,
  embedded = false,
}: {
  theme: ThemeMode;
  draft: InspectionSettings;
  saved: InspectionSettings;
  errors: SettingsErrors;
  onThemeChange: (theme: ThemeMode) => void;
  onDraftChange: (patch: Partial<InspectionSettings>) => void;
  onSave: () => void;
  onReset: () => void;
  onApplyToPlate: () => void;
  embedded?: boolean;
}) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('theme');
  const setNumber = (key: NumberSettingKey) => (value: number) => onDraftChange({ [key]: value });
  const setBoolean = (key: BooleanSettingKey) => (checked: boolean) => onDraftChange({ [key]: checked });
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
                  应用到当前板
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
