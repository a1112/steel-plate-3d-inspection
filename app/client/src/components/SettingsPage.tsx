import { ClipboardCheck, Cpu, Factory, Gauge, LoaderCircle, Monitor, Palette, Radar, RadioTower, RotateCcw, Save, Send, Server, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type ElementType } from 'react';
import type { ThemeMode, ThemeStyle } from '../data/inspection';
import { openParameterManagementWindow } from '../lib/app-windows';
import { isWebHostedRuntime, type ConnectionConfig, type ConnectionMode, type DiscoveredInspectionService } from '../services/inspection-api';
import type { InspectionSettings, SettingsErrors } from '../state/operations';
import { Panel } from './Panel';

type NumberSettingKey = 'severeDepthMm' | 'reviewDepthMm' | 'minDefectWidthMm' | 'cameraExposureUs' | 'encoderPulsePerMeter' | 'alarmVolume';
type BooleanSettingKey = 'autoReview' | 'saveRawImages';
export type SettingsSection = 'theme' | 'connection' | 'grading' | 'acquisition' | 'status';

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

const themeStyleOptions: Array<{ id: ThemeStyle; label: string; description: string; icon: ElementType; swatches: string[] }> = [
  { id: 'default', label: '默认', description: '项目原有蓝钢体系', icon: Palette, swatches: ['#f3f6fa', '#009dff', '#001427'] },
  { id: 'soft', label: '柔和', description: '玫瑰与青绿色调', icon: Sparkles, swatches: ['#fff7fa', '#f472b6', '#14b8a6'] },
  { id: 'tech', label: '科技', description: '高辨识蓝青光感', icon: Cpu, swatches: ['#eef6fb', '#0284c7', '#22d3ee'] },
  { id: 'industrial', label: '工业', description: '石墨与安全琥珀', icon: Factory, swatches: ['#f3f4f6', '#52525b', '#f59e0b'] },
  { id: 'modern', label: '现代', description: '靛蓝与翡翠层次', icon: Monitor, swatches: ['#f5f7ff', '#4f46e5', '#10b981'] },
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

function ThemeSelector({
  theme,
  themeStyle,
  onThemeChange,
  onThemeStyleChange,
}: {
  theme: ThemeMode;
  themeStyle: ThemeStyle;
  onThemeChange: (theme: ThemeMode) => void;
  onThemeStyleChange: (themeStyle: ThemeStyle) => void;
}) {
  return (
    <div className="theme-system-selector">
      <section>
        <header><strong>界面风格</strong><span>控制色彩性格、表面材质与强调色</span></header>
        <div className="theme-style-grid">
          {themeStyleOptions.map((option) => {
            const Icon = option.icon;
            return (
              <button
                key={option.id}
                type="button"
                className={`theme-style-card ${themeStyle === option.id ? 'active' : ''}`}
                aria-pressed={themeStyle === option.id}
                aria-label={`选择${option.label}界面风格`}
                onClick={() => onThemeStyleChange(option.id)}
              >
                <Icon size={18} />
                <span className="theme-option-copy"><strong>{option.label}</strong><em>{option.description}</em></span>
                <span className="theme-option-swatches" aria-hidden="true">
                  {option.swatches.map((color) => <i key={color} style={{ background: color }} />)}
                </span>
              </button>
            );
          })}
        </div>
      </section>
      <section>
        <header><strong>明暗主题</strong><span>可与任一界面风格组合</span></header>
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
              <span className="theme-option-copy"><strong>{option.label}</strong><em>{option.description}</em></span>
              <span className="theme-option-swatches" aria-hidden="true">
                {option.swatches.map((color) => <i key={color} style={{ background: color }} />)}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

export function SettingsPage({
  theme,
  themeStyle = 'default',
  draft,
  saved,
  errors,
  connection = { mode: 'online', host: '127.0.0.1', port: 4873 },
  connectionStatus,
  discoveredServices = [],
  discoveryStatus,
  discoveryBusy = false,
  onThemeChange,
  onThemeStyleChange = () => undefined,
  onDraftChange,
  onConnectionChange = () => undefined,
  onConnectionRefresh = () => undefined,
  onConnectionSave = () => undefined,
  onConnectionDiscover = () => undefined,
  onConnectionAutoSet = () => undefined,
  onSave,
  onReset,
  onApplyToPlate,
  embedded = false,
  initialSection = 'theme',
}: {
  theme: ThemeMode;
  themeStyle?: ThemeStyle;
  draft: InspectionSettings;
  saved: InspectionSettings;
  errors: SettingsErrors;
  connection?: ConnectionConfig;
  connectionStatus?: string | null;
  discoveredServices?: DiscoveredInspectionService[];
  discoveryStatus?: string | null;
  discoveryBusy?: boolean;
  onThemeChange: (theme: ThemeMode) => void;
  onThemeStyleChange?: (themeStyle: ThemeStyle) => void;
  onDraftChange: (patch: Partial<InspectionSettings>) => void;
  onConnectionChange?: (patch: Partial<ConnectionConfig>) => void;
  onConnectionRefresh?: () => void;
  onConnectionSave?: () => void;
  onConnectionDiscover?: () => void;
  onConnectionAutoSet?: (service: DiscoveredInspectionService) => void;
  onSave: () => void;
  onReset: () => void;
  onApplyToPlate: () => void;
  embedded?: boolean;
  initialSection?: SettingsSection;
}) {
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection);
  const [connectionHostEdited, setConnectionHostEdited] = useState(false);
  const connectionRefreshRef = useRef(onConnectionRefresh);
  useEffect(() => {
    connectionRefreshRef.current = onConnectionRefresh;
  }, [onConnectionRefresh]);
  useEffect(() => {
    if (
      !connectionHostEdited
      || connection.mode === 'demo'
      || connection.host.trim().length === 0
      || !Number.isInteger(connection.port)
      || connection.port < 1
      || connection.port > 65535
      || discoveryBusy
    ) {
      return;
    }
    const timeout = window.setTimeout(() => {
      setConnectionHostEdited(false);
      connectionRefreshRef.current();
    }, 800);
    return () => window.clearTimeout(timeout);
  }, [connection.host, connection.mode, connection.port, connectionHostEdited, discoveryBusy]);
  const setNumber = (key: NumberSettingKey) => (value: number) => onDraftChange({ [key]: value });
  const setBoolean = (key: BooleanSettingKey) => (checked: boolean) => onDraftChange({ [key]: checked });
  const setConnectionMode = (mode: ConnectionMode) => onConnectionChange({ mode });
  const handleVolume = (event: ChangeEvent<HTMLInputElement>) => onDraftChange({ alarmVolume: Number(event.target.value) });
  const currentThemeLabel = themeOptions.find((option) => option.id === theme)?.label ?? '深色工业';
  const webHosted = isWebHostedRuntime();
  const displayedServiceAddress = `${connection.protocol ?? 'http'}://${connection.host}:${connection.port}`;

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
              <ThemeSelector theme={theme} themeStyle={themeStyle} onThemeChange={onThemeChange} onThemeStyleChange={onThemeStyleChange} />
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
              {webHosted ? (
                <div className="connection-browser-target" role="status">
                  <strong>网页可配置服务地址</strong>
                  <span>当前页面将直接访问 {displayedServiceAddress}；目标检测服务需允许浏览器跨域访问。</span>
                </div>
              ) : null}
              <label className="setting-field">
                <span>连接协议</span>
                <select
                  aria-label="连接协议"
                  value={connection.protocol ?? 'http'}
                  disabled={connection.mode === 'demo'}
                  onChange={(event) => onConnectionChange({ protocol: event.target.value as 'http' | 'https' })}
                >
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                </select>
              </label>
              <label className="setting-field">
                <span>服务端 IP</span>
                <input
                  aria-label="服务端 IP"
                  value={connection.host}
                  disabled={connection.mode === 'demo'}
                  onChange={(event) => {
                    onConnectionChange({ host: event.target.value });
                    setConnectionHostEdited(true);
                  }}
                />
                <em>修改 IP 后停止输入 0.8 秒，将自动保存到本机并刷新界面</em>
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
                <button type="button" disabled={connection.mode === 'demo' || discoveryBusy} onClick={onConnectionDiscover}>
                  {discoveryBusy ? <LoaderCircle className="spin" size={16} /> : <Radar size={16} />}
                  {discoveryBusy ? '正在发现' : '自动发现'}
                </button>
                <button type="button" onClick={onConnectionSave}>
                  <Save size={16} />
                  保存连接
                </button>
                <button
                  type="button"
                  title="浏览器中同页进入，桌面端打开独立窗口"
                  onClick={() => void openParameterManagementWindow()}
                >
                  <Server size={16} />
                  参数管理
                </button>
              </div>
              {discoveryStatus || discoveredServices.length > 0 ? (
                <section className="connection-discovery" aria-label="自动发现结果">
                  <header>
                    <strong>局域网服务</strong>
                    <span>{discoveryStatus ?? `发现 ${discoveredServices.length} 个可用地址`}</span>
                  </header>
                  {discoveredServices.length > 0 ? (
                    <div className="connection-discovery-list">
                      {discoveredServices.map((service) => (
                        <article key={service.origin} className={service.preferred ? 'preferred' : ''}>
                          <span>
                            <strong>{service.host}:{service.port}</strong>
                            <em>{service.scope === 'lan' ? '局域网地址' : '本机地址'}{service.preferred ? ' · 推荐' : ''}</em>
                          </span>
                          <button type="button" onClick={() => onConnectionAutoSet(service)}>自动设置</button>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </section>
              ) : null}
              <dl className="settings-summary">
                <div>
                  <dt>当前模式</dt>
                  <dd>{connection.mode === 'online' ? '在线模式' : '演示模式'}</dd>
                </div>
                <div>
                  <dt>数据来源</dt>
                  <dd>{connection.mode === 'online' ? `${(connection.runtime?.databaseEngine || '服务端').toUpperCase()} 数据库` : '客户端内置演示数据'}</dd>
                </div>
                <div>
                  <dt>服务端地址</dt>
                  <dd>{displayedServiceAddress}</dd>
                </div>
                <div>
                  <dt>状态</dt>
                  <dd>{connectionStatus ?? '待保存'}</dd>
                </div>
                <div>
                  <dt>局域网访问</dt>
                  <dd>{connection.runtime ? (connection.runtime.lanAccess ? `已开启 · ${connection.runtime.advertisedHost}` : '仅限本机') : '等待服务同步'}</dd>
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
