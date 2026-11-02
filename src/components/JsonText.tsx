import { memo, type ReactNode } from "react";

// Strings (a key when a colon follows), literals and numbers. Everything
// between matches is punctuation and whitespace.
const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/**
 * JSON text with syntax colors. It only wraps slices of the given text in
 * spans: the text is never parsed into values or re-serialized, so what is
 * shown is exactly what the backend wrote (large integers, `2.0`, tags).
 */
export const JsonText = memo(function JsonText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index;
    if (start > last) parts.push(text.slice(last, start));
    const [whole, quoted, colon, literal] = match;
    if (quoted !== undefined) {
      parts.push(
        <span key={start} className={colon !== undefined ? "json-key" : "json-string"}>
          {quoted}
        </span>,
      );
      if (colon !== undefined) parts.push(colon);
    } else {
      parts.push(
        <span key={start} className={literal !== undefined ? "json-literal" : "json-number"}>
          {whole}
        </span>,
      );
    }
    last = start + whole.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <pre className="json-text">{parts}</pre>;
});
