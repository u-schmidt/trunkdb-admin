import { useRef, type KeyboardEvent, type PointerEvent } from "react";

interface Props {
  /** The panel above, whose height this sets. */
  label: string;
  /** The most height the panel may take now, in pixels. */
  onHeight: (height: number) => void;
  /** Reads the panel's height now, to start from. */
  measure: () => number;
}

const MIN_HEIGHT = 96;
const STEP = 32;

/**
 * A handle under a panel that sits above the list: dragged, or moved
 * with the arrow keys, it lets the panel take more or less of the
 * height, so the list stays in view. A panel shorter than that keeps
 * its own height.
 */
export function PanelResizer({ label, onHeight, measure }: Props) {
  const start = useRef<{ y: number; height: number } | null>(null);

  const down = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { y: event.clientY, height: measure() };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const from = start.current;
    if (from === null) return;
    onHeight(Math.max(MIN_HEIGHT, from.height + event.clientY - from.y));
  };
  const up = () => {
    start.current = null;
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const by = event.key === "ArrowUp" ? -STEP : event.key === "ArrowDown" ? STEP : 0;
    if (by === 0) return;
    event.preventDefault();
    onHeight(Math.max(MIN_HEIGHT, measure() + by));
  };

  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="horizontal"
      aria-label={`Resize ${label}`}
      tabIndex={0}
      title="Drag to give this panel more or less room"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
    />
  );
}
