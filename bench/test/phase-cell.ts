/**
 * The cell under `column` in a phase-table row. The header and each row start with two spaces
 * and a 34-wide name column, so the cells begin at column 37.
 */
const cells = (line: string): string[] => line.slice(37).trim().split(/\s+/);

export function phaseCell(header: string, row: string, column: string): string | undefined {
  return cells(row)[cells(header).indexOf(column)];
}
