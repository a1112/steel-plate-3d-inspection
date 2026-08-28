import { BellRing, ClipboardList, Gauge, ScanSearch, Ruler, Workflow } from 'lucide-react';
import type { ElementType, MouseEvent } from 'react';
import type { InspectionUiState } from '../state/inspection-ui';

export type NavKey = InspectionUiState['activeNav'];

const navItems: Array<{ id: NavKey; label: string; icon: ElementType }> = [
  { id: 'online', label: '在线监测', icon: Gauge },
  { id: 'defects', label: '缺陷分析', icon: ScanSearch },
  { id: 'diameter', label: '测径分析', icon: Ruler },
  { id: 'report', label: '缺陷报表', icon: ClipboardList },
  { id: 'alarms', label: '报警中心', icon: BellRing },
  { id: 'processing', label: '采集算法日志', icon: Workflow },
];

export function TopNav({
  active,
  onChange,
  onDragMouseDown,
  embedded = false,
}: {
  active: NavKey;
  onChange: (next: NavKey) => void;
  onDragMouseDown?: (event: MouseEvent<HTMLElement>) => void;
  embedded?: boolean;
}) {
  const handleMouseDown = (event: MouseEvent<HTMLElement>) => {
    if (embedded) {
      event.stopPropagation();
      return;
    }
    onDragMouseDown?.(event);
  };

  return (
    <nav className={`top-nav ${embedded ? 'top-nav-embedded' : ''}`} data-no-drag={embedded || undefined} onMouseDown={handleMouseDown}>
      {navItems.map((item) => {
        const Icon = item.icon;
        return (
          <button key={item.id} type="button" className={active === item.id ? 'active' : ''} onClick={() => onChange(item.id)}>
            <Icon size={18} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
