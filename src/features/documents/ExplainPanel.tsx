import type { AlternativeReport, ExplainReport, HintInput, IndexSummary } from "../../ipc/types";
import type { ExplainState } from "./useExplain";

interface Props {
  state: Exclude<ExplainState, { status: "closed" }>;
  /** The sort field of the list shown now. */
  sortField: string;
  /** Set when the groups are explained rather than a page of documents. */
  grouped: boolean;
  /** The group fields of the groups shown. */
  groupFields: string[];
  indexes: IndexSummary[];
  /** The list's hint; null: trunkdb's choice. */
  hint: HintInput | null;
  /** Reads the list's page with another hint, or none. */
  onHint: (hint: HintInput | null) => void;
}

const count = (n: number) => n.toLocaleString("en");

/** How trunkdb read the page shown (trunkdb SPEC §94), or made the groups (§107.6). */
export function ExplainPanel({
  state,
  sortField,
  grouped,
  groupFields,
  indexes,
  hint,
  onHint,
}: Props) {
  const answer =
    state.status === "loaded" ? state.report : state.status === "loading" ? state.previous : null;
  // While a switch between list and groups loads, the other's answer isn't shown.
  const report = answer !== null && (answer.groups !== null) === grouped ? answer : null;
  return (
    <section
      className="explain"
      aria-labelledby="explain-heading"
      aria-busy={state.status === "loading"}
    >
      <div className="panel-heading">
        <h2 id="explain-heading">
          {grouped ? "How these groups are made" : "How this page is read"}
        </h2>
        {state.status === "loading" && <span className="muted">Reading…</span>}
      </div>
      {state.status === "failed" && (
        <div className="tool-result tool-failed" role="alert">
          <p>
            <strong>The query could not be explained.</strong> {state.error.message}
          </p>
          {state.error.detail !== null && <p className="muted">{state.error.detail}</p>}
        </div>
      )}
      {report === null ? (
        state.status === "loading" ? (
          <p className="muted">Running the query…</p>
        ) : (
          state.status === "loaded" && (
            <p className="muted">
              {grouped
                ? "Run groups to see how they are made."
                : "Once the documents are listed, this shows how they were read."}
            </p>
          )
        )
      ) : (
        <div className={state.status === "loading" ? "explain-body explain-stale" : "explain-body"}>
          {report.groups !== null ? (
            <GroupsReportView report={report} groups={report.groups} groupFields={groupFields} />
          ) : (
            <ExplainReportView
              report={report}
              sortField={sortField}
              indexes={indexes}
              hint={hint}
              onHint={onHint}
            />
          )}
        </div>
      )}
    </section>
  );
}

function ExplainReportView({
  report,
  sortField,
  indexes,
  hint,
  onHint,
}: {
  report: ExplainReport;
  sortField: string;
  indexes: IndexSummary[];
  hint: HintInput | null;
  onHint: (hint: HintInput | null) => void;
}) {
  const ms = (report.elapsed_micros / 1000).toLocaleString("en", { maximumFractionDigits: 1 });
  return (
    <>
      <p>{planText(report)}</p>
      {report.hinted && hint !== null && (
        <p>
          This is {hintWords(hint)}, as the hint asks.{" "}
          <button type="button" className="link" onClick={() => onHint(null)}>
            Let trunkdb choose
          </button>
        </p>
      )}
      {coveringText(report) !== null && <p>{coveringText(report)}</p>}
      {report.from_entries > 0 && <p>{fromEntriesText(report)}</p>}
      {missText(report) !== null && <p>{missText(report)}</p>}
      {report.sort !== null && <p>{sortText(report, sortField, indexes)}</p>}
      <dl className="facts">
        <dt>Index entries read</dt>
        <dd>{count(report.keys_examined)}</dd>
        <dt>Documents read</dt>
        <dd>{count(report.documents_examined)}</dd>
        <dt>Matching</dt>
        <dd>
          {count(report.documents_matched)}
          {report.skip > 0 && report.documents_matched > 0 && ", those on earlier pages included"}
        </dd>
        <dt>Shown</dt>
        <dd>{count(report.documents_returned)}</dd>
        <dt>Time</dt>
        <dd>
          {ms} ms <span className="muted">(a second run is usually faster, from the cache)</span>
        </dd>
      </dl>
      <ReadsTable report={report} />
      <AlternativesTable report={report} hint={hint} onHint={onHint} />
    </>
  );
}

/** The plans trunkdb passed over (its SPEC §133), each one click away as a hint. */
function AlternativesTable({
  report,
  hint,
  onHint,
}: {
  report: ExplainReport;
  hint: HintInput | null;
  onHint: (hint: HintInput | null) => void;
}) {
  if (report.alternatives.length === 0) return null;
  const current = JSON.stringify(hint);
  return (
    <>
      <h3 className="explain-subheading">Other ways to read this page</h3>
      <p className="muted">
        What trunkdb would have read instead. A hint makes it read the page one of these ways; the
        documents are the same.
      </p>
      <table className="plain-table" aria-label="Other ways to read this page">
        <thead>
          <tr>
            <th scope="col">Plan</th>
            <th scope="col" className="numeric">
              Index entries
            </th>
            <th scope="col">Documents</th>
            <th scope="col">
              <span className="sr-only">Hint</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {report.alternatives.map((alternative, n) => {
            const inUse = alternative.hint !== null && JSON.stringify(alternative.hint) === current;
            return (
              <tr key={n}>
                <td>
                  {alternativeWords(alternative)}
                  {alternative.fewer && <span className="badge">fewer entries</span>}
                </td>
                <td className="numeric">
                  {alternative.more_than ? "more than " : ""}
                  {count(alternative.entries)}
                </td>
                <td>{alternative.reads_documents ? "one read per entry" : "the entries decide"}</td>
                <td>
                  {alternative.hint === null ? null : inUse ? (
                    <span className="muted">in use</span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Read the page by ${alternativeWords(alternative)}`}
                      onClick={() => alternative.hint !== null && onHint(alternative.hint)}
                    >
                      Use
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/** A passed-over plan in words. */
function alternativeWords(alternative: AlternativeReport): string {
  const names = [...new Set(alternative.indexes)].join(", ");
  switch (alternative.plan) {
    case "scan":
      return "every document, no index";
    case "by_id":
      return "lookups by ID";
    case "index_order":
      return names === "_id"
        ? "the primary index, in sort order"
        : `the index on ${names}, in sort order`;
    case "index_union":
      return `the indexes on ${names}, together`;
    case "index":
      return names === "_id" ? "the primary index" : `the index on ${names}`;
    case "other":
      return "a plan this version of the app does not describe";
  }
}

/** A hint in words: "the index on age", "no index". */
export function hintWords(hint: HintInput): string {
  if (hint.kind === "no_index") return "reading every document, no index";
  const [first, ...rest] = hint.fields;
  if (first === "_id" && rest.length === 0) return "the primary index";
  return `the index on ${rest.length === 0 ? first : `(${hint.fields.join(", ")})`}`;
}

function ReadsTable({ report }: { report: ExplainReport }) {
  return (
    <>
      {report.reads.length > 0 && (
        <table className="plain-table" aria-label="Index reads">
          <thead>
            <tr>
              <th scope="col">Index</th>
              <th scope="col">Bounded by</th>
              <th scope="col">Direction</th>
              <th scope="col" className="numeric">
                Entries
              </th>
            </tr>
          </thead>
          <tbody>
            {report.reads.map((read, n) => (
              <tr key={n}>
                <td>{read.index}</td>
                <td>{read.bounds.length === 0 ? "the whole index" : read.bounds.join(" and ")}</td>
                <td>{read.backward ? "backward" : "forward"}</td>
                <td className="numeric">{count(read.entries)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function GroupsReportView({
  report,
  groups,
  groupFields,
}: {
  report: ExplainReport;
  groups: number;
  groupFields: string[];
}) {
  const ms = (report.elapsed_micros / 1000).toLocaleString("en", { maximumFractionDigits: 1 });
  const first = report.reads[0]?.index ?? "";
  const plan =
    report.plan === "index_order"
      ? `trunkdb walked the index on ${first} from end to end.`
      : planText(report);
  const missed = report.from_entries === 0 ? missText(report) : null;
  return (
    <>
      <p>{plan}</p>
      <p>{entriesText(report, groupFields)}</p>
      {missed !== null && <p>{missed}</p>}
      <dl className="facts">
        <dt>Index entries read</dt>
        <dd>{count(report.keys_examined)}</dd>
        <dt>Documents read</dt>
        <dd>{count(report.documents_examined)}</dd>
        <dt>Matching</dt>
        <dd>{count(report.documents_matched)}</dd>
        <dt>Groups</dt>
        <dd>{count(groups)}</dd>
        <dt>Time</dt>
        <dd>
          {ms} ms <span className="muted">(a second run is usually faster, from the cache)</span>
        </dd>
      </dl>
      <ReadsTable report={report} />
    </>
  );
}

/** Whether the index entries answered (trunkdb SPEC §107.5), and if not, what could. */
function entriesText(report: ExplainReport, groupFields: string[]): string {
  const { from_entries: entries, documents_matched: matched, documents_examined: read } = report;
  if (entries > 0 && read === 0) {
    return "Counted from the index entries: no document was read.";
  }
  if (entries > 0) {
    const documents = read === 1 ? "document was" : "documents were";
    return `${count(entries)} of ${count(matched)} matches were counted from their index entries; ${count(read)} ${documents} read for the rest and for values the index does not hold exactly.`;
  }
  const every = "Every matching document was read to be counted.";
  if (report.plan !== "scan" || groupFields.length === 0) return every;
  const name =
    groupFields.length === 1 ? `“${groupFields[0] ?? ""}”` : `(${groupFields.join(", ")})`;
  return `${every} An index on ${name} could let trunkdb count from its entries instead, without reading documents (not for sums).`;
}

/** What was read, in a sentence; the reads table shows the ranges. */
function planText(report: ExplainReport): string {
  const first = report.reads[0]?.index ?? "";
  switch (report.plan) {
    case "scan":
      return "No index was used: trunkdb read every document of the collection.";
    case "by_id":
      return "trunkdb looked the documents up by their IDs.";
    case "index":
      return `trunkdb used the index on ${first} and looked only at the range below.`;
    case "index_union": {
      const names = [...new Set(report.reads.map((read) => read.index))].join(", ");
      return `trunkdb used the indexes on ${names} and looked only at the ranges below.`;
    }
    case "index_order":
      return `trunkdb read ${first === "_id" ? "the primary index" : `the index on ${first}`} in sort order${
        report.reads[0]?.backward === true ? ", backward," : ""
      } and stopped once the page was full.`;
    case "other":
      return "trunkdb chose a plan this version of the app does not describe.";
  }
}

/** Whether the index entries decided which documents match (trunkdb
 * SPEC §100), so that documents were read only where the page needed
 * them. */
function coveringText(report: ExplainReport): string | null {
  if (!report.reads.some((read) => read.covering)) return null;
  const decided = "The index entries decided which documents match";
  return report.documents_examined <= report.documents_returned
    ? `${decided}, so trunkdb read only the documents shown.`
    : `${decided}; documents were read only where the page needed them.`;
}

/** Results built from index entries alone (trunkdb SPEC §106.5): chosen
 * fields that an index holds. */
function fromEntriesText(report: ExplainReport): string {
  const all = report.from_entries === report.documents_returned;
  const which = all
    ? `All ${count(report.documents_returned)} shown were`
    : `${count(report.from_entries)} of the ${count(report.documents_returned)} shown were`;
  return `${which} built from the index entries alone, as the index holds the chosen fields: their documents were not read.`;
}

/** Documents read in vain, when there were any. */
function missText(report: ExplainReport): string | null {
  const missed = report.documents_examined - report.documents_matched;
  if (missed <= 0) return null;
  const documents = missed === 1 ? "document was" : "documents were";
  return report.plan === "scan" || report.plan === "other"
    ? `${count(missed)} ${documents} read but did not match the filter.`
    : `${count(missed)} ${documents} read but did not match: the index narrows by part of the filter, and the rest is checked on each document.`;
}

function sortText(report: ExplainReport, sortField: string, indexes: IndexSummary[]): string {
  const sort = report.sort;
  if (sort === null) return "";
  if (sort.from_index > 0) {
    return sort.in_memory === 0
      ? "The order came from the index."
      : "The first sort key came from the index; the rest were sorted in memory.";
  }
  const read = "Every match was sorted in memory to find this page.";
  if (sortField === "_id") {
    return `${read} The filter found its documents by ID or through another index, which beats walking the primary index in order.`;
  }
  const indexed = indexes.some((index) => index.fields[0] === sortField);
  return indexed
    ? `${read} The index on “${sortField}” could not give the order for this filter.`
    : `${read} An index on “${sortField}” could let trunkdb stop once the page is full.`;
}
