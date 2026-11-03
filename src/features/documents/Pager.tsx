import { ChevronLeft, ChevronRight } from "lucide-react";
import { useId } from "react";
import { Select } from "../../components/Select";
import { PAGE_SIZES } from "./useCollectionQuery";

/** A page of anything: documents or groups. */
interface Paged {
  total: number;
  page: number;
  page_count: number;
  page_size: number;
}

interface Props {
  result: Paged;
  /** What is counted, singular and plural. */
  units?: readonly [string, string];
  busy: boolean;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}

const DOCUMENTS = ["document", "documents"] as const;

export function Pager({ result, units = DOCUMENTS, busy, onPage, onPageSize }: Props) {
  const sizeId = useId();
  const { total, page, page_count: pageCount, page_size: pageSize } = result;
  const documents = `${total.toLocaleString("en")} ${total === 1 ? units[0] : units[1]}`;
  return (
    <nav className="pager" aria-label={units === DOCUMENTS ? "Pages" : `Pages of ${units[1]}`}>
      <span role="status">
        {pageCount === 0 ? documents : `${documents} · page ${page + 1} of ${pageCount}`}
      </span>
      <span className="pager-controls">
        <label htmlFor={sizeId}>Per page</label>
        <Select
          id={sizeId}
          value={pageSize}
          onChange={(event) => onPageSize(Number(event.target.value))}
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </Select>
        <button type="button" onClick={() => onPage(page - 1)} disabled={busy || page === 0}>
          <ChevronLeft aria-hidden="true" />
          Previous
        </button>
        <button
          type="button"
          onClick={() => onPage(page + 1)}
          disabled={busy || page + 1 >= pageCount}
        >
          Next
          <ChevronRight aria-hidden="true" />
        </button>
      </span>
    </nav>
  );
}
