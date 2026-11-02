import type { ValueKind } from "../../ipc/types";

/** How a value's type is named to the user. */
export const KIND_LABELS: Record<ValueKind, string> = {
  null: "Null",
  bool: "Bool",
  int: "Int",
  float: "Float",
  string: "String",
  binary: "Binary",
  array: "Array",
  object: "Object",
  id: "Id",
  date_time: "DateTime",
  unknown: "Unknown type",
};
