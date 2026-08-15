/**
 * Escape a single CSV field. Wraps the value in double quotes when it
 * contains a comma, double quote, or newline, and doubles any internal
 * double quotes per RFC 4180.
 */
export function escapeCSVField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Build a CSV string from a header row and body rows, escaping every field.
 */
export function buildCSV(headers: string[], rows: unknown[][]): string {
  const lines = [
    headers.map(escapeCSVField).join(','),
    ...rows.map((row) => row.map(escapeCSVField).join(',')),
  ];
  return lines.join('\r\n');
}

/**
 * Build a CSV from headers + rows and trigger a browser download.
 */
export function downloadCSV(filename: string, headers: string[], rows: unknown[][]): void {
  const csvContent = buildCSV(headers, rows);
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
