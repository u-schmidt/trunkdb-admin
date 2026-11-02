import { useEffect, useId, useRef, type ReactNode } from "react";

interface Props {
  title: string;
  /** Escape. Ignored while `busy`. */
  onCancel: () => void;
  busy?: boolean;
  children: ReactNode;
}

/**
 * A modal dialog on the native <dialog> element, which provides the focus
 * trap, the inert background and the return of focus to where it was.
 */
export function Modal({ title, onCancel, busy = false, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (!dialog.open) dialog.showModal();
    return () => dialog.close();
  }, []);

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Closing is the parent's decision; Escape only asks for it.
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id={titleId} className="modal-title">
        {title}
      </h2>
      {children}
    </dialog>
  );
}
