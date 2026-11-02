import { JsonText } from "../../components/JsonText";
import type { ResultRow } from "../../ipc/types";

interface Props {
  rows: ResultRow[];
  /** Position of the first row among all matches, for numbering. */
  offset: number;
  selected: number | null;
  onSelect: (index: number) => void;
}

/** Each document as its own block of pretty tagged JSON. */
export function JsonResults({ rows, offset, selected, onSelect }: Props) {
  return (
    <ol className="json-results" aria-label="Documents as JSON">
      {rows.map((row, index) => (
        <li key={row.id} className={index === selected ? "json-block selected" : "json-block"}>
          <button
            type="button"
            className="json-block-header"
            aria-pressed={index === selected}
            onClick={() => onSelect(index)}
          >
            <span className="muted">{offset + index + 1}</span>
            <code>{row.id}</code>
          </button>
          <JsonText text={row.json} />
        </li>
      ))}
    </ol>
  );
}
