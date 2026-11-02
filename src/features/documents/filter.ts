import type { FilterInput } from "../../ipc/types";

/** No conditions: every document. */
export const NO_FILTER: FilterInput = { rows: [] };

/** Whether `filter` lists every document: no rows, or blank text. */
export function isEmptyFilter(filter: FilterInput): boolean {
  return "rows" in filter ? filter.rows.length === 0 : filter.text.trim() === "";
}

/** The same filter, as sent: same kind and same content. */
export function sameFilter(a: FilterInput, b: FilterInput): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
