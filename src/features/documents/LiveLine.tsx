import { Radio } from "lucide-react";

interface Props {
  /** The session can change data: nothing else writes to it, so nothing is live. */
  canMutate: boolean;
  /** The groups are in front: made anew from the filter, not live. */
  grouped: boolean;
  /** Whether a read-only list follows other programs' changes. */
  on: boolean;
  /** When the list last read again because of a change. */
  changedAt: Date | null;
  onToggle: () => void;
}

/**
 * What the list below its pager does about changes: follows another
 * program's writes (read-only, Live on), or can't (groups, editing). Read-only
 * lists have a toggle.
 */
export function LiveLine({ canMutate, grouped, on, changedAt, onToggle }: Props) {
  if (grouped) {
    return (
      <p className="live-line muted">
        Groups are not live: they are made again from the filter each time they are shown.
      </p>
    );
  }
  if (canMutate) {
    return (
      <p className="live-line muted">
        Not live: the file is open for editing, so no other program can change it here.
      </p>
    );
  }
  return (
    <div className="live-line">
      <span className={on ? "live-state" : "live-state muted"} role="status">
        {on ? (
          <>
            <Radio aria-hidden="true" />
            Live: other programs&apos; changes appear here as they happen
            {changedAt !== null && <> · updated {changedAt.toLocaleTimeString("en")}</>}
          </>
        ) : (
          "Live updates are off"
        )}
      </span>
      <button type="button" aria-pressed={on} onClick={onToggle}>
        Live updates
      </button>
    </div>
  );
}
