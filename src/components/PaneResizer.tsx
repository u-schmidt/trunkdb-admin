import { useRef, type KeyboardEvent, type PointerEvent } from "react";

interface Props {
  /** What the handle resizes, for its name. */
  label: string;
  /** Reads the pane's width now, to start from. */
  measure: () => number;
  /** The width asked for; the pane keeps it within its limits. */
  onWidth: (width: number) => void;
}

const STEP = 32;

/**
 * A handle on the left edge of a pane on the right: dragged, or moved
 * with the arrow keys, it makes the pane wider or narrower.
 */
export function PaneResizer({ label, measure, onWidth }: Props) {
  const start = useRef<{ x: number; width: number } | null>(null);

  const down = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, width: measure() };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const from = start.current;
    if (from === null) return;
    // The handle is on the left: moving it left widens the pane.
    onWidth(from.width - (event.clientX - from.x));
  };
  const up = () => {
    start.current = null;
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const by = event.key === "ArrowLeft" ? STEP : event.key === "ArrowRight" ? -STEP : 0;
    if (by === 0) return;
    event.preventDefault();
    onWidth(measure() + by);
  };

  return (
    <div
      className="pane-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      tabIndex={0}
      title="Drag to make the pane wider or narrower"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
    />
  );
}
