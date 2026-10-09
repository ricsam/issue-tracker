export type BoardArrow = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

function position(columns: readonly (readonly string[])[], id: string) {
  for (let column = 0; column < columns.length; column++) {
    const row = columns[column].indexOf(id);
    if (row >= 0) return { column, row };
  }
  return null;
}

/** Keyboard navigation follows visible lane/card order, never hidden cards. */
export function boardArrowTarget(columns: readonly (readonly string[])[], id: string, arrow: BoardArrow, edge = false): string | undefined {
  const from = position(columns, id);
  if (!from) return;
  if (arrow === "ArrowUp" || arrow === "ArrowDown") {
    const ids = columns[from.column];
    const row = edge ? arrow === "ArrowUp" ? 0 : ids.length - 1 : from.row + (arrow === "ArrowUp" ? -1 : 1);
    return ids[Math.max(0, Math.min(ids.length - 1, row))];
  }
  const direction = arrow === "ArrowLeft" ? -1 : 1;
  let destination = from.column;
  for (let column = from.column + direction; column >= 0 && column < columns.length; column += direction) {
    if (!columns[column].length) continue;
    destination = column;
    if (!edge) break;
  }
  const ids = columns[destination];
  return ids[Math.min(from.row, ids.length - 1)];
}

/** Spreadsheet-style rectangular range; short/empty lanes contribute only existing cards. */
export function boardSelectionRange(columns: readonly (readonly string[])[], anchor: string, head: string): string[] {
  const start = position(columns, anchor);
  const end = position(columns, head);
  if (!start || !end) return [];
  return columns.slice(Math.min(start.column, end.column), Math.max(start.column, end.column) + 1)
    .flatMap((ids) => ids.slice(Math.min(start.row, end.row), Math.max(start.row, end.row) + 1));
}
