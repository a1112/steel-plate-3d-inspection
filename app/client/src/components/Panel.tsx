import type { ReactNode } from 'react';

interface PanelProps {
  title: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
  headerless?: boolean;
}

export function Panel({ title, children, className = '', action, headerless = false }: PanelProps) {
  return (
    <section
      className={`panel ${headerless ? 'panel-headerless' : ''} ${className}`}
      data-layout-card
      data-card-label={title}
    >
      {headerless ? null : (
        <div className="panel-header">
          <h2>{title}</h2>
          {action}
        </div>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}
