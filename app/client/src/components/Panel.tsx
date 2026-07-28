import type { ReactNode } from 'react';

interface PanelProps {
  title: string;
  children: ReactNode;
  className?: string;
  leadingAction?: ReactNode;
  action?: ReactNode;
  headerless?: boolean;
}

export function Panel({
  title,
  children,
  className = '',
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
      {headerless ? null : (
        <div className="panel-header">
          {leadingAction}
          <h2>{title}</h2>
          {action}
        </div>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}
