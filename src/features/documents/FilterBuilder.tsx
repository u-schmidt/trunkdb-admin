import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { toAppError } from "../../ipc/backend";
import { useBackend } from "../../ipc/BackendContext";
import { FilterSyntaxHelp } from "./FilterSyntaxHelp";
import {
  KINDS,
  OPERATORS,
  VALUE_TYPES,
  type AppError,
  type ConditionInput,
  type FilterInput,
  type Kind,
  type Operator,
  type SortInput,
  type ValueType,
} from "../../ipc/types";
import { knownPaths, rowTypeOf, useFieldPaths } from "../fields/FieldPathsContext";
import { sameFilter } from "./filter";

const OPERATOR_LABELS: Record<Operator, string> = {
  eq: "equals",
  ne: "does not equal",
  lt: "less than",
  lte: "less than or equal",
  gt: "greater than",
  gte: "greater than or equal",
  contains: "contains (ignores case)",
  starts_with: "starts with (case counts)",
  in: "is one of",
  not_in: "is none of",
  exists: "exists",
  missing: "is missing",
  is_kind: "is of kind",
  is_not_kind: "is not of kind",
};

const KIND_LABELS: Record<Kind, string> = {
  string: "String",
  int: "Int",
  float: "Float",
  number: "Number (Int or Float)",
  bool: "Bool",
  date: "DateTime",
  id: "Id",
  array: "Array",
  object: "Object",
  binary: "Binary",
};

const TYPE_LABELS: Record<ValueType, string> = {
  string: "String",
  int: "Int",
  float: "Float",
  bool: "Bool",
  null: "Null",
  date_time: "DateTime",
  id: "Id",
};

const PLACEHOLDERS: Partial<Record<ValueType, string>> = {
  int: "e.g. 42",
  float: "e.g. 2.5",
  date_time: "2026-01-31T12:00:00Z",
  id: "UUID",
};

interface Row {
  key: number;
  field: string;
  operator: Operator;
  type: ValueType;
  /** The value of a single-value operator. */
  text: string;
  /** The values of `in` and `not_in`, all of `type`. */
  values: string[];
  kind: Kind;
}

export interface FilterDraft {
  filter: FilterInput;
  sort: SortInput;
}

type Mode = "rows" | "text";

/** A text filter that didn't read, with the text that was sent. */
export interface FilterMistake {
  error: AppError;
  text: string;
}

interface Props {
  /** The filter the listed result was produced with. */
  appliedFilter: FilterInput;
  /** The sort of the newest query, which may still be loading. */
  sort: SortInput;
  /** Applies the filter and the sort. */
  onRun: (draft: FilterDraft) => void;
  /** Applies a new sort to the applied filter. */
  onSort: (sort: SortInput) => void;
  /**
   * A filter run from elsewhere (a group's Show documents): each new `id`
   * replaces the rows or the text with it.
   */
  loaded?: { id: number; filter: FilterInput } | null;
  /** Kept current with the filter and sort as typed, applied or not. */
  draftRef?: RefObject<FilterDraft | null>;
  /** The newest query's text that didn't read, shown under the box. */
  mistake?: FilterMistake | null;
}

type Shape = "value" | "values" | "kind" | "none";

/** What an operator takes besides the field. */
function shapeOf(operator: Operator): Shape {
  switch (operator) {
    case "exists":
    case "missing":
      return "none";
    case "in":
    case "not_in":
      return "values";
    case "is_kind":
    case "is_not_kind":
      return "kind";
    default:
      return "value";
  }
}

/** Operators that search strings, whatever type was selected before. */
const takesString = (operator: Operator) => operator === "contains" || operator === "starts_with";

/** The type a row's value is sent as. */
function typeOf(row: Pick<Row, "operator" | "type">): ValueType {
  if (takesString(row.operator)) return "string";
  // An `in` of null is `equals null`; the menu doesn't offer it.
  if (shapeOf(row.operator) === "values" && row.type === "null") return "string";
  return row.type;
}

/** A Bool row's value as its menu shows it: anything but "false" is true. */
const boolText = (text: string) => (text === "false" ? "false" : "true");

/** The value text a row sends: what its controls show. */
function valueText(type: ValueType, text: string): string {
  if (type === "null") return "";
  if (type === "bool") return boolText(text);
  return text;
}

function toCondition(row: Row): ConditionInput {
  const base = { field: row.field, operator: row.operator, value: null };
  const type = typeOf(row);
  switch (shapeOf(row.operator)) {
    case "none":
      return base;
    case "kind":
      return { ...base, kind: row.kind };
    case "values":
      return { ...base, values: row.values.map((text) => ({ type, text: valueText(type, text) })) };
    case "value":
      return { ...base, value: { type, text: valueText(type, row.text) } };
  }
}

function rowsOf(conditions: ConditionInput[], firstKey: number): Row[] {
  return conditions.map((condition, n) => ({
    key: firstKey + n,
    field: condition.field,
    operator: condition.operator,
    type: condition.value?.type ?? condition.values?.[0]?.type ?? "string",
    text: condition.value?.text ?? "",
    values: condition.values?.map((value) => value.text) ?? [""],
    kind: condition.kind ?? "string",
  }));
}

/**
 * A new operator keeps what was typed: one value becomes the first of a
 * list, the first of a list the one value.
 */
function withOperator(row: Row, operator: Operator): Partial<Row> {
  const from = shapeOf(row.operator);
  const to = shapeOf(operator);
  if (from === "value" && to === "values" && row.values.every((v) => v === "")) {
    return { operator, values: [row.text] };
  }
  if (from === "values" && to === "value" && row.text === "") {
    return { operator, text: row.values[0] ?? "" };
  }
  return { operator };
}

/** What an empty sort field means, as in the backend. */
const DEFAULT_SORT_FIELD = "_id";

/**
 * The filter, as condition rows (all combined with AND) or as a condition
 * in trunkdb's text, applied by Run; and the sort, applied as
 * soon as it is chosen. Values and text stay text here; the backend reads
 * and checks them.
 */
export function FilterBuilder({
  appliedFilter,
  sort: currentSort,
  onRun,
  onSort,
  loaded = null,
  mistake = null,
  draftRef,
}: Props) {
  const backend = useBackend();
  const fields = useFieldPaths();
  const [mode, setMode] = useState<Mode>("rows");
  const [rows, setRows] = useState<Row[]>([]);
  const [text, setText] = useState("");
  // Why a switch between rows and text didn't happen.
  const [switchNote, setSwitchNote] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [nextKey, setNextKey] = useState(1);
  // The value "+ value" just added, to take the focus.
  const [addedValue, setAddedValue] = useState<{ key: number; at: number } | null>(null);
  const [shownLoad, setShownLoad] = useState(loaded?.id ?? 0);
  if (loaded !== null && loaded.id !== shownLoad) {
    setShownLoad(loaded.id);
    setSwitchNote(null);
    if ("rows" in loaded.filter) {
      setMode("rows");
      setRows(rowsOf(loaded.filter.rows, nextKey));
      setNextKey(nextKey + loaded.filter.rows.length);
    } else {
      setMode("text");
      setText(loaded.filter.text);
    }
  }
  // The sort field while it is typed; it applies on leaving the field.
  const [sortField, setSortField] = useState(currentSort.field);
  // A sort chosen elsewhere (a table header) replaces what is shown.
  const [shownSort, setShownSort] = useState(currentSort);
  if (shownSort.field !== currentSort.field || shownSort.descending !== currentSort.descending) {
    setShownSort(currentSort);
    setSortField(currentSort.field);
  }
  const sortFieldId = useId();
  const sortDirectionId = useId();
  const textId = useId();
  const hintId = useId();
  const mistakeId = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  // Where the cursor goes once an inserted example is in the box.
  const caretAfterInsert = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = caretAfterInsert.current;
    const area = box.current;
    if (at === null || area === null) return;
    caretAfterInsert.current = null;
    area.focus();
    area.setSelectionRange(at, at);
  }, [text]);

  /** An example replaces the selection in the box, or goes where the cursor is. */
  const insert = (example: string) => {
    const area = box.current;
    const start = area?.selectionStart ?? text.length;
    const end = area?.selectionEnd ?? text.length;
    // Kept apart from the words beside it by a space.
    const before = start > 0 && !/\s/.test(text.charAt(start - 1)) ? " " : "";
    const after = end < text.length && !/\s/.test(text.charAt(end)) ? " " : "";
    const piece = before + example + after;
    caretAfterInsert.current = start + before.length + example.length;
    setText(text.slice(0, start) + piece + text.slice(end));
  };

  // A new mistake puts the cursor where it is, if the text is unchanged.
  const shownMistake = mode === "text" ? mistake : null;
  useEffect(() => {
    const at = shownMistake?.error.at;
    const area = box.current;
    if (at == null || area === null || area.value !== shownMistake?.text) return;
    area.focus();
    area.setSelectionRange(at.index, at.index);
  }, [shownMistake]);

  const sort: SortInput = {
    field: sortField === "" ? DEFAULT_SORT_FIELD : sortField,
    descending: currentSort.descending,
  };
  const filter: FilterInput = mode === "rows" ? { rows: rows.map(toCondition) } : { text };
  const draft: FilterDraft = { filter, sort };
  const edited = !sameFilter(filter, appliedFilter);
  useEffect(() => {
    if (draftRef !== undefined) draftRef.current = draft;
  });

  const applySort = (next: SortInput) => {
    setSortField(next.field);
    if (next.field !== currentSort.field || next.descending !== currentSort.descending) {
      onSort(next);
    }
  };

  /** Rows to text always; text to rows where it has their shape. Runs nothing. */
  const switchTo = async (next: Mode) => {
    if (next === mode || switching) return;
    setSwitchNote(null);
    setSwitching(true);
    try {
      if (next === "text") {
        const conditions = rows.map(toCondition);
        setText(conditions.length === 0 ? "" : await backend.filterToText(conditions));
        setMode("text");
      } else if (text.trim() === "") {
        setRows([]);
        setMode("rows");
      } else {
        const answer = await backend.filterToRows(text);
        if ("rows" in answer) {
          setRows(rowsOf(answer.rows, nextKey));
          setNextKey(nextKey + answer.rows.length);
          setMode("rows");
        } else {
          // The text stays: nothing is thrown away by a switch.
          setSwitchNote(answer.reason);
        }
      }
    } catch (thrown) {
      setSwitchNote(toAppError(thrown).message);
    } finally {
      setSwitching(false);
    }
  };

  const change = (key: number, patch: Partial<Row>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  /**
   * A path taken from the suggestions sets an empty row's value type to
   * the path's most common kind; a typed value keeps its type.
   */
  const changeField = (row: Row, field: string) => {
    const known = knownPaths(fields.state)?.paths.find((p) => p.nameable && p.path === field);
    const type = known === undefined ? null : rowTypeOf(known);
    const shape = shapeOf(row.operator);
    const untyped =
      (shape === "value" && row.text === "") ||
      (shape === "values" && row.values.every((v) => v === ""));
    const retype = type !== null && untyped && !takesString(row.operator);
    change(row.key, retype ? { field, type } : { field });
  };

  const addRow = () => {
    setRows((current) => [
      ...current,
      {
        key: nextKey,
        field: "",
        operator: "eq",
        type: "string",
        text: "",
        values: [""],
        kind: "string",
      },
    ]);
    setNextKey((key) => key + 1);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onRun(draft);
  };

  const runOnCmdEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      onRun(draft);
    }
  };

  return (
    <form className="filter" onSubmit={submit} aria-label="Filter and sort">
      <div className="filter-mode">
        <div role="group" aria-label="Filter as" className="segmented">
          <button
            type="button"
            aria-pressed={mode === "rows"}
            onClick={() => void switchTo("rows")}
          >
            Rows
          </button>
          <button
            type="button"
            aria-pressed={mode === "text"}
            onClick={() => void switchTo("text")}
          >
            Text
          </button>
        </div>
        {switchNote !== null && (
          <p className="filter-switch-note muted" role="status">
            {switchNote}
          </p>
        )}
      </div>

      {mode === "text" ? (
        <div className="filter-text">
          <label htmlFor={textId} className="sr-only">
            Filter text
          </label>
          <textarea
            id={textId}
            ref={box}
            className="filter-text-box"
            rows={3}
            value={text}
            placeholder={'status = "failed" or retries > 3'}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={runOnCmdEnter}
            aria-invalid={shownMistake !== null}
            aria-describedby={shownMistake !== null ? `${mistakeId} ${hintId}` : hintId}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          {shownMistake !== null && <Mistake id={mistakeId} mistake={shownMistake} />}
          <p id={hintId} className="filter-hint muted">
            A condition in trunkdb&apos;s filter language, such as{" "}
            <code>a = 1 and (b &gt; 2 or c is null)</code>; Run or ⌘↩ applies it.
          </p>
          <FilterSyntaxHelp onInsert={insert} />
        </div>
      ) : rows.length === 0 ? (
        <p className="muted">No conditions: all documents are listed.</p>
      ) : (
        <ol className="filter-rows">
          {rows.map((row, index) => {
            const n = index + 1;
            const valueType = typeOf(row);
            const shape = shapeOf(row.operator);
            const typeMenu = (
              <select
                aria-label={`Condition ${n} value type`}
                value={valueType}
                disabled={takesString(row.operator)}
                onChange={(event) =>
                  change(row.key, {
                    type: event.target.value as ValueType,
                    text: "",
                    values: row.values.map(() => ""),
                  })
                }
              >
                {VALUE_TYPES.filter((type) => shape !== "values" || type !== "null").map((type) => (
                  <option key={type} value={type}>
                    {TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            );
            return (
              <li key={row.key} className="filter-row">
                <span className="filter-joiner">{index === 0 ? "Where" : "and"}</span>
                <input
                  type="text"
                  className="filter-field"
                  aria-label={`Condition ${n} field path`}
                  placeholder="field or nested.path"
                  value={row.field}
                  list={fields.listAll}
                  onFocus={fields.ensure}
                  onChange={(event) => changeField(row, event.target.value)}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                <select
                  aria-label={`Condition ${n} operator`}
                  value={row.operator}
                  onChange={(event) =>
                    change(row.key, withOperator(row, event.target.value as Operator))
                  }
                >
                  {OPERATORS.map((operator) => (
                    <option key={operator} value={operator}>
                      {OPERATOR_LABELS[operator]}
                    </option>
                  ))}
                </select>
                {shape === "value" && (
                  <>
                    {typeMenu}
                    <ValueControl
                      label={`Condition ${n} value`}
                      type={valueType}
                      text={row.text}
                      onChange={(text) => change(row.key, { text })}
                    />
                  </>
                )}
                {shape === "values" && (
                  <>
                    {typeMenu}
                    <span
                      className="filter-values"
                      role="group"
                      aria-label={`Condition ${n} values`}
                    >
                      {row.values.map((text, at) => (
                        <span key={at} className="filter-values-item">
                          <ValueControl
                            label={`Condition ${n} value ${at + 1}`}
                            type={valueType}
                            text={text}
                            focus={addedValue?.key === row.key && addedValue.at === at}
                            onChange={(next) =>
                              change(row.key, {
                                values: row.values.map((v, i) => (i === at ? next : v)),
                              })
                            }
                          />
                          {row.values.length > 1 && (
                            <button
                              type="button"
                              className="quiet filter-values-remove"
                              aria-label={`Remove value ${at + 1} of condition ${n}`}
                              title="Remove this value"
                              onClick={() =>
                                change(row.key, {
                                  values: row.values.filter((_, i) => i !== at),
                                })
                              }
                            >
                              ×
                            </button>
                          )}
                        </span>
                      ))}
                      <button
                        type="button"
                        className="quiet"
                        aria-label={`Add a value to condition ${n}`}
                        onClick={() => {
                          setAddedValue({ key: row.key, at: row.values.length });
                          change(row.key, { values: [...row.values, ""] });
                        }}
                      >
                        + value
                      </button>
                    </span>
                  </>
                )}
                {shape === "kind" && (
                  <select
                    aria-label={`Condition ${n} kind`}
                    value={row.kind}
                    onChange={(event) => change(row.key, { kind: event.target.value as Kind })}
                  >
                    {KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  className="quiet"
                  aria-label={`Remove condition ${n}`}
                  onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ol>
      )}

      <div className="filter-footer">
        {mode === "rows" ? (
          <button type="button" onClick={addRow}>
            Add condition
          </button>
        ) : (
          <span />
        )}
        <span className="filter-sort">
          <label htmlFor={sortFieldId}>Sort by</label>
          <input
            id={sortFieldId}
            type="text"
            className="filter-field"
            value={sortField}
            placeholder="_id"
            list={fields.listPlain}
            onFocus={fields.ensure}
            onChange={(event) => setSortField(event.target.value)}
            onBlur={() => applySort(sort)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <label htmlFor={sortDirectionId} className="sr-only">
            Sort direction
          </label>
          <select
            id={sortDirectionId}
            value={sort.descending ? "desc" : "asc"}
            onChange={(event) => applySort({ ...sort, descending: event.target.value === "desc" })}
          >
            <option value="asc">ascending</option>
            <option value="desc">descending</option>
          </select>
        </span>
        <span className="filter-run">
          {edited && <span className="muted">Not applied yet</span>}
          {/* Never disabled while a query runs: a slow one can be replaced, and
              only the newest request's answer is shown. */}
          <button type="submit" className="primary">
            Run
          </button>
        </span>
      </div>
    </form>
  );
}

/** One typed value: a menu for a Bool, nothing to enter for a null, text otherwise. */
function ValueControl({
  label,
  type,
  text,
  focus = false,
  onChange,
}: {
  label: string;
  type: ValueType;
  text: string;
  /** Takes the focus when this turns true: a value just added. */
  focus?: boolean;
  onChange: (text: string) => void;
}) {
  const control = useRef<HTMLInputElement & HTMLSelectElement>(null);
  useEffect(() => {
    if (focus) control.current?.focus();
  }, [focus]);
  if (type === "bool") {
    return (
      <select
        ref={control}
        aria-label={label}
        value={boolText(text)}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (type === "null") return <span className="filter-null muted">null</span>;
  return (
    <input
      ref={control}
      type="text"
      className="filter-value"
      aria-label={label}
      placeholder={PLACEHOLDERS[type] ?? ""}
      value={text}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
    />
  );
}

/** trunkdb's message, and the line of the text with a mark under the place. */
function Mistake({ id, mistake }: { id: string; mistake: FilterMistake }) {
  const { error, text } = mistake;
  const at = error.at;
  const line = at != null ? (text.split("\n")[at.line - 1] ?? "") : null;
  return (
    <div id={id} className="filter-mistake" role="alert">
      <p>
        {error.message}
        {error.detail !== null && <> {error.detail}</>}
      </p>
      {line !== null && at != null && (
        <pre className="filter-mistake-line" aria-hidden="true">
          {line}
          {"\n"}
          {" ".repeat(Math.max(0, at.column - 1))}^
        </pre>
      )}
    </div>
  );
}
