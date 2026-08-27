import type { CSSProperties, ReactNode } from 'react';

interface PanelProps {
  title: string;
  children: ReactNode;
  className?: string;
  beforeHeader?: ReactNode;
  bodyStyle?: CSSProperties;
  leadingAction?: ReactNode;
  action?: ReactNode;
  headerless?: boolean;
}

export function Panel({
  title,
  children,
  className = '',
  beforeHeader,
  bodyStyle,
  leadingAction,
  action,
  headerless = false,
}: PanelProps) {
  return (
    <section
      className={`panel ${headerless ? 'panel-headerless' : ''} ${className}`}
      data-layout-card
      data-card-label={title}
    >
      {beforeHeader}
      {headerless ? null : (
        <div className="panel-header">
          {leadingAction}
          <h2>{title}</h2>
          {action}
        </div>
      )}
      <div className="panel-body" style={bodyStyle}>{children}</div>
    </section>
  );
}
