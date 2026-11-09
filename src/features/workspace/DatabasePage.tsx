import type { ReactNode } from "react";

/** The database's own pages, beside its collections in the side column. */
export type DatabasePageName = "overview" | "storage" | "tools";

interface Props {
  /** The heading's id, for the section's name. */
  id: string;
  title: string;
  /** Buttons at the right of the title. */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * One of the database's pages: a header band like a collection's, and
 * cards below it, side by side where the window is wide enough.
 */
export function DatabasePage({ id, title, actions, children }: Props) {
  return (
    <section className="database-page" aria-labelledby={id}>
      <header className="collection-header page-header" data-tauri-drag-region>
        <div className="collection-title" data-tauri-drag-region>
          <h2 id={id} className="collection-name">
            {title}
          </h2>
          {actions !== undefined && <span className="page-actions">{actions}</span>}
        </div>
      </header>
      <div className="overview" data-tauri-drag-region>
        {children}
      </div>
    </section>
  );
}
