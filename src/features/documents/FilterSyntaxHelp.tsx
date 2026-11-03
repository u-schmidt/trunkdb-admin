interface Example {
  text: string;
  says: string;
}

interface Section {
  title: string;
  examples: Example[];
}

/** trunkdb's filter language (its spec §111), by example. Field names are made up. */
const SECTIONS: Section[] = [
  {
    title: "Compare",
    examples: [
      { text: 'status = "open"', says: "equal; also !=, <, <=, >, >=" },
      { text: 'name contains "smith"', says: "part of a text, in any case" },
      { text: 'title starts with "Fix"', says: "the start of a text, case counting" },
      { text: 'status in ("open", "blocked")', says: "one of several values; also not in" },
      { text: "price >= 10 and price < 20", says: "a range" },
    ],
  },
  {
    title: "Combine",
    examples: [
      { text: 'a = 1 and (b > 2 or c = "x")', says: "and binds tighter than or" },
      { text: 'not (status = "done")', says: "the opposite" },
    ],
  },
  {
    title: "Missing, null and kinds",
    examples: [
      { text: "note is null", says: "null or missing; also is not null" },
      { text: "exists(note)", says: "the field is there; also not exists(…)" },
      {
        text: "hours is string",
        says: "a kind of value: bool, int, float, number, string, date, id, array, object, binary; also is not",
      },
    ],
  },
  {
    title: "Arrays",
    examples: [
      { text: 'tags[*] = "urgent"', says: "any element is this value" },
      { text: 'items[*].sku = "A1"', says: "a field of any element" },
      {
        text: 'items has (sku = "A1" and qty >= 10)',
        says: "one element meets all of it; paths start at the element",
      },
      { text: "scores has (@ >= 80 and @ < 90)", says: "@ is the element itself" },
      { text: "size(tags) > 2", says: "the number of elements" },
    ],
  },
  {
    title: "Paths and values",
    examples: [
      { text: 'address.city = "Berlin"', says: "a field inside an object" },
      { text: '`first name` = "Ada"', says: "a name with spaces, or a word like order" },
      {
        text: 'created >= date("2024-05-01T00:00:00Z")',
        says: 'a date-time; id("…") for an ID; values are JSON',
      },
    ],
  },
];

interface Props {
  /** Puts an example into the filter box where the cursor is. */
  onInsert: (text: string) => void;
}

/** Examples of the filter language beside the text box. */
export function FilterSyntaxHelp({ onInsert }: Props) {
  return (
    <details className="filter-syntax">
      <summary>Syntax</summary>
      <p className="muted">Click an example to put it where the cursor is.</p>
      <div className="filter-syntax-sections">
        {SECTIONS.map((section) => (
          <section key={section.title} aria-label={section.title}>
            <h3>{section.title}</h3>
            <ul>
              {section.examples.map((example) => (
                <li key={example.text}>
                  <button
                    type="button"
                    className="filter-syntax-example"
                    onClick={() => onInsert(example.text)}
                    aria-label={`Insert ${example.text}`}
                  >
                    <code>{example.text}</code>
                  </button>{" "}
                  <span className="muted">{example.says}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </details>
  );
}
