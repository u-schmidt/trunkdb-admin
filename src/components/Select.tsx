import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";

/**
 * A native select drawn flat like the text fields beside it. The WebView
 * draws its own raised control unless told not to, so the arrow is
 * ours. The list that opens is still the system's.
 */
export function Select(props: ComponentProps<"select">) {
  return (
    <span className="select">
      <select {...props} />
      <ChevronDown className="select-chevron" size={14} strokeWidth={2} aria-hidden="true" />
    </span>
  );
}
