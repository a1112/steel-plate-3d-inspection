import { RotateCcw, Save, Send } from 'lucide-react';
import type { ChangeEvent } from 'react';
import type { InspectionSettings, SettingsErrors } from '../state/operations';
import { Panel } from './Panel';

type NumberSettingKey = 'severeDepthMm' | 'reviewDepthMm' | 'minDefectWidthMm' | 'cameraExposureUs' | 'encoderPulsePerMeter' | 'alarmVolume';
type BooleanSettingKey = 'autoReview' | 'saveRawImages';

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

export function SettingsPage({
  draft,
  saved,
  errors,
  onDraftChange,
  onSave,
  onReset,
  onApplyToPlate,
}: {
  draft: InspectionSettings;
  saved: InspectionSettings;
  errors: SettingsErrors;
  onDraftChange: (patch: Partial<InspectionSettings>) => void;
  onSave: () => void;
  onReset: () => void;
  onApplyToPlate: () => void;
}) {
  const setNumber = (key: NumberSettingKey) => (value: number) => onDraftChange({ [key]: value });
  const setBoolean = (key: BooleanSettingKey) => (checked: boolean) => onDraftChange({ [key]: checked });
  const handleVolume = (event: ChangeEvent<HTMLInputElement>) => onDraftChange({ alarmVolume: Number(event.target.value) });

  return (
    <main className="workspace-page settings-page">
      <section className="settings-layout">
        <Panel title="缺陷判级参数" className="settings-panel">
          <NumberField label="严重深度阈值" unit="mm" value={draft.severeDepthMm} min={0.01} max={1} step={0.01} error={errors.severeDepthMm} onChange={setNumber('severeDepthMm')} />
          <NumberField label="待复核深度阈值" unit="mm" value={draft.reviewDepthMm} min={0.01} max={1} step={0.01} error={errors.reviewDepthMm} onChange={setNumber('reviewDepthMm')} />
          <NumberField label="最小缺陷宽度" unit="mm" value={draft.minDefectWidthMm} min={0.01} max={5} step={0.01} error={errors.minDefectWidthMm} onChange={setNumber('minDefectWidthMm')} />
          <ToggleField label="检测后自动进入复核队列" checked={draft.autoReview} onChange={setBoolean('autoReview')} />
        </Panel>

        <Panel title="采集与联机参数" className="settings-panel">
          <NumberField label="相机曝光时间" unit="us" value={draft.cameraExposureUs} min={100} max={5000} step={10} error={errors.cameraExposureUs} onChange={setNumber('cameraExposureUs')} />
          <NumberField label="编码器脉冲" unit="p/m" value={draft.encoderPulsePerMeter} min={500} max={10000} step={1} error={errors.encoderPulsePerMeter} onChange={setNumber('encoderPulsePerMeter')} />
          <ToggleField label="保存原始灰度与点云数据" checked={draft.saveRawImages} onChange={setBoolean('saveRawImages')} />
          <label className="setting-field">
            <span>报警音量</span>
            <input className="range-input" type="range" min={0} max={100} value={draft.alarmVolume} onChange={handleVolume} />
            <strong>{draft.alarmVolume}%</strong>
            {errors.alarmVolume ? <em>{errors.alarmVolume}</em> : null}
          </label>
        </Panel>

        <Panel title="参数状态" className="settings-summary-panel">
          <dl className="settings-summary">
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
      </section>
    </main>
  );
}
