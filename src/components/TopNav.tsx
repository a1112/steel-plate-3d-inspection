import { AlertTriangle, ClipboardList, Gauge, MonitorCog, Settings } from 'lucide-react';
import type { ElementType, MouseEvent } from 'react';
import type { InspectionSummary } from '../data/inspection';
import type { InspectionUiState } from '../state/inspection-ui';

type NavKey = InspectionUiState['activeNav'];

const navItems: Array<{ id: NavKey; label: string; icon: ElementType }> = [
  { id: 'online', label: '在线检测', icon: Gauge },
  { id: 'report', label: '缺陷报表', icon: ClipboardList },
  { id: 'settings', label: '系统设置', icon: Settings },
  { id: 'status', label: '系统状态', icon: MonitorCog },
];

export function TopNav({
  active,
  summary,
  onChange,
  onDragMouseDown,
}: {
  active: NavKey;
  summary: InspectionSummary;
  onChange: (next: NavKey) => void;
  onDragMouseDown: (event: MouseEvent<HTMLElement>) => void;
}) {
  const hasSevereDefect = summary.bySeverity.severe > 0;
  const hasDefect = summary.total > 0;
  const message = hasSevereDefect
    ? `检测到 ${summary.bySeverity.severe} 个严重缺陷`
    : hasDefect
      ? `当前钢板 ${summary.total} 个缺陷均未达严重等级`
      : '当前钢板未检出缺陷';

  return (
    <nav className="top-nav" onMouseDown={onDragMouseDown}>
      {navItems.map((item) => {
        const Icon = item.icon;
        return (
          <button key={item.id} type="button" className={active === item.id ? 'active' : ''} onClick={() => onChange(item.id)}>
            <Icon size={18} />
            <span>{item.label}</span>
          </button>
        );
      })}
      <div className={`top-nav-alert ${hasSevereDefect ? '' : 'stable'}`} aria-label={`${hasSevereDefect ? '严重缺陷报警' : '缺陷状态正常'}，${message}`} data-no-drag>
        <AlertTriangle size={20} strokeWidth={1.9} />
        <strong>{hasSevereDefect ? '严重缺陷报警' : '缺陷状态正常'}</strong>
        <span>{message}</span>
        <b>{hasSevereDefect ? '请立即复核' : '可继续跟踪'}</b>
      </div>
    </nav>
  );
}
