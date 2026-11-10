/**
 * The side pane's width and whether it is shown, kept in the browser
 * storage of the app's window: the same for every collection and the next
 * start. Storage may be missing or refuse; the pane then starts as by
 * default.
 */
export interface SidePaneLayout {
  open: boolean;
  /** In pixels; null: the stylesheet's width. */
  width: number | null;
}

const KEY = "trunkdb-admin.side-pane";

export function loadSidePaneLayout(): SidePaneLayout {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return { open: false, width: null };
    const parsed = JSON.parse(raw) as Partial<SidePaneLayout>;
    return {
      open: parsed.open === true,
      width: typeof parsed.width === "number" && parsed.width > 0 ? parsed.width : null,
    };
  } catch {
    return { open: false, width: null };
  }
}

export function saveSidePaneLayout(layout: SidePaneLayout) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    // Not kept: the pane starts as by default next time.
  }
}
