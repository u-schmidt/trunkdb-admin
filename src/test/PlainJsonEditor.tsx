/**
 * Stands in for the CodeMirror editor in component tests: jsdom cannot
 * lay out or type into CodeMirror, and these tests are about what happens
 * around the text, not about the editor widget. Same props, plain text.
 */
export function JsonEditor(props: {
  initialText: string;
  onChange: (text: string) => void;
  readOnly: boolean;
  label: string;
}) {
  return (
    <textarea
      aria-label={props.label}
      defaultValue={props.initialText}
      readOnly={props.readOnly}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}
