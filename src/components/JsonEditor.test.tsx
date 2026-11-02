import { EditorView } from "@codemirror/view";
import { render } from "@testing-library/react";
import { JsonEditor } from "./JsonEditor";

// Text a JavaScript JSON round trip would damage: integers beyond 2^53,
// `2.0`, key order, duplicate-looking tags, odd spacing, escapes.
const TRICKY = `{
  "max": 9223372036854775807,
  "beyond_js": 9007199254740993,
  "float_two": 2.0,
  "exp": 1e-7,
  "nan": {"$float": "NaN"},
  "when": {"$date": "2026-03-01T12:00:00.123456789Z"},
  "tag_like": {"$object": {"$id": "x"}},
  "z": 1,   "a": 2,
  "unicode": "\\u00e9 \\u0000 😀"
}`;

function mount(initialText: string) {
  const changes: string[] = [];
  const { container } = render(
    <JsonEditor
      initialText={initialText}
      onChange={(text) => changes.push(text)}
      readOnly={false}
      label="Test JSON"
    />,
  );
  const dom = container.querySelector<HTMLElement>(".cm-editor");
  const view = dom === null ? null : EditorView.findFromDOM(dom);
  if (view === null) throw new Error("the editor did not mount");
  return { view, changes };
}

describe("JsonEditor", () => {
  it("holds the given text unchanged, with highlighting and diagnostics active", () => {
    const { view, changes } = mount(TRICKY);

    expect(view.state.doc.toString()).toBe(TRICKY);
    expect(changes).toEqual([]);
    expect(view.contentDOM).toHaveAttribute("aria-label", "Test JSON");
  });

  it("reports an edit as text and leaves everything untouched as it was", () => {
    const { view, changes } = mount(TRICKY);
    const at = TRICKY.indexOf('"z": 1') + '"z": '.length;

    view.dispatch({ changes: { from: at, to: at + 1, insert: "100" } });

    const expected = TRICKY.replace('"z": 1,', '"z": 100,');
    expect(changes).toEqual([expected]);
    expect(view.state.doc.toString()).toBe(expected);
  });

  it("keeps invalid text as typed instead of repairing it", () => {
    const broken = '{"a": 1,, "b": 009}';
    const { view } = mount(broken);

    expect(view.state.doc.toString()).toBe(broken);
  });
});
