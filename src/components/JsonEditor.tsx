import { json, jsonParseLinter } from "@codemirror/lang-json";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { linter } from "@codemirror/lint";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

// The same colors as the read-only JSON blocks, light and dark.
const highlight = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--text)", fontWeight: "600" },
  { tag: tags.string, color: "var(--json-string)" },
  { tag: tags.number, color: "var(--json-number)" },
  { tag: [tags.bool, tags.null], color: "var(--json-literal)" },
]);

const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "0.92em",
    backgroundColor: "var(--surface)",
    color: "var(--text)",
  },
  ".cm-scroller": { fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "var(--muted)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "color-mix(in srgb, var(--accent) 8%, transparent)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
});

interface Props {
  /** The text to start from. Remount (a new `key`) to load other text. */
  initialText: string;
  onChange: (text: string) => void;
  readOnly: boolean;
  label: string;
}

/**
 * A JSON text editor. The document is text throughout: this component
 * hands CodeMirror a string and reports back the string it holds. Syntax
 * highlighting and diagnostics annotate that text; nothing here parses it
 * into values or writes it back, so what the user did not touch is
 * byte-for-byte what was loaded. Validation proper is the backend's.
 */
export function JsonEditor({ initialText, onChange, readOnly, label }: Props) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const report = useRef(onChange);
  const first = useRef({ initialText, readOnly, label });

  useEffect(() => {
    report.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (parent.current === null) return;
    const { initialText, readOnly, label } = first.current;
    const created = new EditorView({
      doc: initialText,
      parent: parent.current,
      extensions: [
        basicSetup,
        json(),
        linter(jsonParseLinter()),
        syntaxHighlighting(highlight),
        theme,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": label }),
        editable.current.of(EditorState.readOnly.of(readOnly)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) report.current(update.state.doc.toString());
        }),
      ],
    });
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  return <div ref={parent} className="json-editor" />;
}
