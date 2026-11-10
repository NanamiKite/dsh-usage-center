/**
 * RFC 4180-style CSV serialization for the export endpoints.
 *
 * - Fields containing commas, quotes, or line breaks are double-quoted with
 *   inner quotes doubled.
 * - Rows are joined with CRLF.
 * - Callers prepend the UTF-8 BOM so Excel opens Chinese text correctly.
 */
function escapeField(value) {
    if (value === null || value === undefined)
        return '';
    const text = String(value);
    if (/[",\r\n]/.test(text))
        return `"${text.replaceAll('"', '""')}"`;
    return text;
}
/** Serialize one table; `null`/`undefined` become empty fields. */
export function toCsv(headers, rows) {
    const lines = [headers.map(escapeField).join(',')];
    for (const row of rows)
        lines.push(row.map(escapeField).join(','));
    return lines.join('\r\n');
}
