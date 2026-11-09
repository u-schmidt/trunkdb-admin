import {
  Braces,
  CodeXml,
  Columns3,
  FileJson,
  Group,
  Plus,
  RefreshCw,
  Route,
  Table2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDraftGuard } from "../../app/DraftGuard";
import { ErrorNotice } from "../../components/ErrorNotice";
import { useBackend } from "../../ipc/BackendContext";
import type {
  AppError,
  CollectionSummary,
  FilterInput,
  GroupResult,
  QueryRequest,
  QueryResult,
  SortInput,
} from "../../ipc/types";
import { ColumnChooser } from "./ColumnChooser";
import { CopyCommand } from "./CopyCommand";
import { DocumentEditor } from "./DocumentEditor";
import { ExplainPanel, hintWords } from "./ExplainPanel";
import { StatementPanel } from "./StatementPanel";
import { useFieldPaths } from "../fields/FieldPathsContext";
import { isEmptyFilter, sameFilter } from "./filter";
import { FilterBuilder, type FilterDraft, type FilterMistake } from "./FilterBuilder";
import { GroupsView } from "./GroupsView";
import { JsonResults } from "./JsonResults";
import { Pager } from "./Pager";
import { TableResults } from "./TableResults";
import { useCollectionQuery } from "./useCollectionQuery";
import { useDocumentDraft } from "./useDocumentDraft";
import { useExplain } from "./useExplain";
import { useGroups, type GroupSettings } from "./useGroups";

type View = "json" | "table" | "groups";
/** What the pane beside the list shows: a document, Explain or Statement. */
type SidePage = "document" | "explain" | "statement";

interface Props {
  sessionId: string;
  collection: CollectionSummary;
  /** false: read-only; documents open for viewing. */
  canMutate: boolean;
  /** Counts in the sidebar may be as old as the list; refresh both. */
  onRefreshOverview: () => void;
}

export function DocumentsPanel({ sessionId, collection, canMutate, onRefreshOverview }: Props) {
  const backend = useBackend();
  const guard = useDraftGuard();
  const query = useCollectionQuery(sessionId, collection.name);
  const { result, applied, requested, loading, error } = query;
  const [view, setView] = useState<View>("json");
  const [dismissed, setDismissed] = useState<object | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [statementOpen, setStatementOpen] = useState(false);
  // The page of the side pane in front, when more than one is open.
  const [sidePage, setSidePage] = useState<SidePage>("document");
  const groups = useGroups(sessionId, collection.name);
  const grouped = view === "groups";

  // Groups count what the list's filter finds: shown again after the
  // filter changed in another view, they are made again from it. Not
  // while the list's own newest filter is still on its way: Run in the
  // Groups view has sent the groups for it already.
  const runGroups = groups.run;
  const groupsAsked = groups.applied;
  const groupsRequested = groups.requested;
  useEffect(() => {
    if (
      !grouped ||
      groupsRequested === null ||
      sameFilter(groupsRequested.filter, applied.filter) ||
      !sameFilter(requested.filter, applied.filter)
    ) {
      return;
    }
    runGroups({ ...groupsRequested, filter: applied.filter });
  }, [grouped, groupsRequested, applied.filter, requested.filter, runGroups]);

  // In the Groups view, Run and Run groups do one thing: the filter as
  // typed and the group settings as set, the list's query and the groups.
  const draftRef = useRef<FilterDraft | null>(null);
  const groupSettingsRef = useRef<GroupSettings | null>(null);
  const runAll = (draft: FilterDraft, settings: GroupSettings | null) => {
    const same =
      sameFilter(draft.filter, requested.filter) &&
      draft.sort.field === requested.sort.field &&
      draft.sort.descending === requested.sort.descending;
    if (!same) {
      query.apply({
        ...draft,
        pageSize: requested.pageSize,
        select: requested.select,
        except: requested.except,
        hint: requested.hint,
      });
    }
    if (settings !== null) runGroups({ settings, filter: draft.filter });
  };

  // A filter a group's Show documents puts into the filter builder.
  const [loaded, setLoaded] = useState<{ id: number; filter: FilterInput } | null>(null);
  const showDocuments = (filter: FilterInput) => {
    setLoaded((previous) => ({ id: (previous?.id ?? 0) + 1, filter }));
    query.apply({ ...requested, filter });
    setView("table");
  };

  /** The list's query for `page`, as the list sends it. */
  const listRequest = useCallback(
    (requestId: number, page: number): QueryRequest => ({
      request_id: requestId,
      collection: collection.name,
      filter: applied.filter,
      sort: applied.sort,
      page,
      page_size: applied.pageSize,
      select: applied.select,
      except: applied.except,
      hint: applied.hint,
    }),
    [collection.name, applied],
  );
  const [commandError, setCommandError] = useState<AppError | null>(null);

  // A text that didn't read is shown under the box, with its place.
  const requestedText = "text" in requested.filter ? requested.filter.text : null;
  const mistake: FilterMistake | null =
    error !== null && error.at != null && requestedText !== null
      ? { error, text: requestedText }
      : null;

  // While open, Explain follows what is shown: every new page of the list
  // or of the groups is explained again (its query runs twice then).
  const explain = useExplain();
  const explainOpen = explain.state.status !== "closed";
  const runExplain = explain.run;
  const subject: QueryResult | GroupResult | null = grouped ? groups.result : result;
  const explained = useRef<QueryResult | GroupResult | null>(null);
  const requestFor = groups.requestFor;
  const explainSubject = useCallback(() => {
    if (grouped) {
      const page = groups.result?.page ?? 0;
      if (groupsAsked === null) return;
      runExplain((requestId) =>
        backend.collectionGroupsExplain(sessionId, requestFor(groupsAsked, page, requestId)),
      );
    } else {
      const page = result?.page ?? 0;
      runExplain((requestId) => backend.collectionExplain(sessionId, listRequest(requestId, page)));
    }
  }, [
    grouped,
    groups.result,
    groupsAsked,
    result,
    runExplain,
    backend,
    sessionId,
    listRequest,
    requestFor,
  ]);
  useEffect(() => {
    if (!explainOpen || subject === null || explained.current === subject) return;
    explained.current = subject;
    explainSubject();
  }, [explainOpen, subject, explainSubject]);
  const closeExplain = () => {
    explained.current = null;
    explain.close();
  };

  // A write or a Refresh: the documents may differ, so their paths are
  // read again on next need.
  const invalidatePaths = useFieldPaths().invalidate;
  const refreshQuery = query.refresh;
  const refreshGroups = groups.goToPage;
  const groupsPage = groups.result?.page ?? 0;
  const refresh = useCallback(() => {
    invalidatePaths();
    refreshQuery();
    if (grouped) refreshGroups(groupsPage);
    onRefreshOverview();
  }, [invalidatePaths, refreshQuery, grouped, refreshGroups, groupsPage, onRefreshOverview]);

  const editor = useDocumentDraft({
    sessionId,
    collection: collection.name,
    filter: applied.filter,
    onWritten: refresh,
  });
  const { draft } = editor;

  // The edited document is found by ID, wherever a refresh has put it.
  const selected =
    draft !== null && draft.id !== null && result !== null
      ? result.rows.findIndex((row) => row.id === draft.id)
      : -1;

  // The conditions stay; a new sort starts at page one.
  const sortBy = (sort: SortInput) => query.apply({ ...requested, sort });

  const select = (index: number) => {
    const row = result?.rows[index];
    if (result === null || row === undefined || row.id === draft?.id) return;
    guard.requestLeave(() => {
      setSidePage("document");
      editor.open(row.id);
    });
  };

  const newDocument = () =>
    guard.requestLeave(() => {
      setSidePage("document");
      editor.openNew();
    });

  // The side pane's pages that are open, in a fixed order; the chosen one
  // is in front, or the first open one once it closed.
  const statementShown = statementOpen && subject !== null;
  const openPages: SidePage[] = [
    ...(draft !== null || editor.opening ? (["document"] as const) : []),
    ...(explainOpen ? (["explain"] as const) : []),
    ...(statementShown ? (["statement"] as const) : []),
  ];
  const frontPage: SidePage | null = openPages.includes(sidePage)
    ? sidePage
    : (openPages[0] ?? null);

  // Open and in front: closes. Open behind another page: comes to the front.
  const toggleExplain = () => {
    if (explainOpen && frontPage !== "explain") {
      setSidePage("explain");
    } else if (explainOpen) {
      explained.current = null;
      explain.close();
    } else if (subject !== null) {
      explained.current = subject;
      explainSubject();
      setSidePage("explain");
    }
  };
  const toggleStatement = () => {
    if (statementOpen && frontPage !== "statement") {
      setSidePage("statement");
    } else {
      setStatementOpen(!statementOpen);
      setSidePage("statement");
    }
  };

  let body;
  if (grouped) {
    body = null;
  } else if (result === null) {
    body = loading ? <p className="state muted">Loading documents…</p> : null;
  } else if (result.total === 0) {
    body = (
      <p className="state muted" role="status">
        {!isEmptyFilter(applied.filter)
          ? "No documents match the filter."
          : collection.persisted
            ? "This collection has no documents."
            : "This collection is not saved yet. It is stored with its first document or index."}
      </p>
    );
  } else if (view === "json") {
    const chosen = applied.select;
    const hidden = applied.except;
    body = (
      <>
        {hidden.length > 0 && (
          <p className="chosen-note muted" role="note">
            Each document without {hidden.join(", ")}.{" "}
            <button type="button" className="link" onClick={() => query.choose(null)}>
              All fields
            </button>
          </p>
        )}
        {chosen !== null && (
          <p className="chosen-note muted" role="note">
            Showing {chosen.length === 1 ? "1 chosen field" : `${chosen.length} chosen fields`} of
            each document.{" "}
            <button type="button" className="link" onClick={() => query.choose(null)}>
              All fields
            </button>
          </p>
        )}
        <JsonResults
          rows={result.rows}
          offset={result.page * result.page_size}
          selected={selected >= 0 ? selected : null}
          onSelect={select}
        />
      </>
    );
  } else {
    body = (
      <TableResults
        rows={result.rows}
        columns={result.columns}
        paths={result.select !== null}
        sort={requested.sort}
        onSort={sortBy}
        selected={selected >= 0 ? selected : null}
        onSelect={select}
      />
    );
  }

  return (
    <div className="documents">
      <div className="documents-list">
        <FilterBuilder
          appliedFilter={applied.filter}
          sort={requested.sort}
          onRun={(next) => runAll(next, grouped ? groupSettingsRef.current : null)}
          draftRef={draftRef}
          onSort={sortBy}
          loaded={loaded}
          mistake={mistake}
          sortable={!grouped}
        />
        {!grouped && requested.hint !== null && (
          <p className="hint-note muted" role="note">
            Pages are read by {hintWords(requested.hint)}, a hint; the documents are the same with
            any.{" "}
            <button type="button" className="link" onClick={() => query.setHint(null)}>
              Let trunkdb choose
            </button>
          </p>
        )}
        {error !== null && mistake === null && dismissed !== error && (
          <ErrorNotice error={error} onDismiss={() => setDismissed(error)} />
        )}
        {commandError !== null && (
          <ErrorNotice error={commandError} onDismiss={() => setCommandError(null)} />
        )}
        {/* A failure with no editor to show it in: an open or a delete. */}
        {editor.error !== null && draft === null && (
          <ErrorNotice error={editor.error} onDismiss={editor.dismissError} />
        )}
        <div className="results-toolbar">
          <div role="group" aria-label="Result view" className="segmented">
            <button type="button" aria-pressed={view === "json"} onClick={() => setView("json")}>
              <Braces aria-hidden="true" />
              JSON
            </button>
            <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>
              <Table2 aria-hidden="true" />
              Table
            </button>
            <button type="button" aria-pressed={grouped} onClick={() => setView("groups")}>
              <Group aria-hidden="true" />
              Groups
            </button>
          </div>
          {view === "table" && (
            <button
              type="button"
              aria-expanded={choosing}
              onClick={() => setChoosing((open) => !open)}
            >
              <Columns3 aria-hidden="true" />
              {applied.select !== null
                ? `Columns (${applied.select.length})…`
                : applied.except.length > 0
                  ? `Columns (${applied.except.length} hidden)…`
                  : "Columns…"}
            </button>
          )}
          {canMutate && (
            <button type="button" onClick={newDocument}>
              <Plus aria-hidden="true" />
              New document
            </button>
          )}
          {loading && result !== null && <span className="muted">Loading…</span>}
          <button
            type="button"
            onClick={toggleExplain}
            disabled={subject === null}
            aria-pressed={explainOpen}
            title={subject === null && grouped ? "Run groups first" : undefined}
          >
            <Route aria-hidden="true" />
            Explain
          </button>
          <button
            type="button"
            onClick={toggleStatement}
            disabled={subject === null}
            aria-pressed={statementOpen}
            title={
              subject === null && grouped
                ? "Run groups first"
                : "The query trunkdb is asked for, as its Rust API"
            }
          >
            <CodeXml aria-hidden="true" />
            Statement
          </button>
          {!grouped && (
            <CopyCommand
              makeCommand={() =>
                backend.collectionFindCommand(sessionId, listRequest(0, result?.page ?? 0))
              }
              onError={setCommandError}
            />
          )}
          <button type="button" onClick={refresh} disabled={loading}>
            <RefreshCw aria-hidden="true" />
            Refresh
          </button>
        </div>
        {choosing && view === "table" && (
          <ColumnChooser
            initial={
              applied.except.length > 0
                ? applied.except
                : (applied.select ?? (result?.columns ?? []).filter((name) => name !== "_id"))
            }
            initialMode={applied.except.length > 0 ? "except" : "only"}
            choosing={applied.select !== null || applied.except.length > 0}
            onChoose={(chosen, except) => {
              setChoosing(false);
              query.choose(chosen, except);
            }}
            onClose={() => setChoosing(false)}
          />
        )}
        {/* Hidden rather than unmounted: the group settings survive a look
            at the documents. */}
        <div className="groups-layer" hidden={!grouped}>
          <GroupsView
            groups={groups}
            onShowDocuments={showDocuments}
            onRun={(settings) =>
              runAll(
                draftRef.current ?? { filter: requested.filter, sort: requested.sort },
                settings,
              )
            }
            settingsRef={groupSettingsRef}
          />
        </div>
        {!grouped && (
          <div className="results" aria-busy={loading}>
            {body}
          </div>
        )}
        {!grouped && result !== null && (
          <Pager
            result={result}
            busy={loading}
            onPage={query.goToPage}
            onPageSize={(pageSize) => query.apply({ ...requested, pageSize })}
          />
        )}
      </div>
      {frontPage !== null && (
        <div className="detail">
          {openPages.length > 1 && (
            <div role="tablist" aria-label="Side pane" className="side-tabs">
              {openPages.map((page) => (
                <button
                  key={page}
                  type="button"
                  role="tab"
                  aria-selected={page === frontPage}
                  onClick={() => setSidePage(page)}
                >
                  {page === "document" ? (
                    <FileJson aria-hidden="true" />
                  ) : page === "explain" ? (
                    <Route aria-hidden="true" />
                  ) : (
                    <CodeXml aria-hidden="true" />
                  )}
                  {page === "document"
                    ? draft?.id === null
                      ? "New document"
                      : "Document"
                    : page === "explain"
                      ? "Explain"
                      : "Statement"}
                </button>
              ))}
            </div>
          )}
          {draft !== null ? (
            <DocumentEditor
              collection={collection.name}
              editor={editor}
              readOnly={!canMutate}
              onRequestClose={() => guard.requestLeave(editor.close)}
              hidden={frontPage !== "document"}
            />
          ) : (
            editor.opening && (
              <aside
                className="side-page"
                aria-label="Document editor"
                hidden={frontPage !== "document"}
              >
                <p className="state muted">Loading document…</p>
              </aside>
            )
          )}
          {explain.state.status !== "closed" && (
            <div className="side-page" hidden={frontPage !== "explain"}>
              <ExplainPanel
                state={explain.state}
                sortField={applied.sort.field}
                grouped={grouped}
                groupFields={groupsAsked?.settings.groupBy ?? []}
                indexes={collection.indexes}
                hint={applied.hint}
                onHint={query.setHint}
                onClose={closeExplain}
              />
            </div>
          )}
          {statementShown && (
            <div className="side-page" hidden={frontPage !== "statement"}>
              <StatementPanel
                grouped={grouped}
                subject={subject}
                make={() =>
                  grouped && groupsAsked !== null
                    ? backend.groupsStatement(requestFor(groupsAsked, groups.result?.page ?? 0, 0))
                    : backend.queryStatement(listRequest(0, result?.page ?? 0))
                }
                onClose={() => setStatementOpen(false)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
