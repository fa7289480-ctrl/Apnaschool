import { badRequest } from '../middleware/errorHandler.js';

/** Small RFC-4180-style CSV parser supporting escaped quotes, commas, and newlines inside quoted fields. */
export function parseCsv(text: string, maxRows = 500): string[][] {
  if (typeof text !== 'string' || text.trim() === '') throw badRequest('Upload a non-empty CSV file');
  if (text.length > 1_000_000) throw badRequest('CSV file exceeds the 1 MB limit');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') {
      if (field.length > 0) throw badRequest('Malformed CSV: quote found inside an unquoted field');
      quoted = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > maxRows + 1) throw badRequest(`CSV may contain at most ${maxRows} student rows`);
    } else field += ch;
  }
  if (quoted) throw badRequest('Malformed CSV: unclosed quoted field');
  row.push(field);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  if (rows.length < 2) throw badRequest('CSV must include a header and at least one student row');
  if (rows.length > maxRows + 1) throw badRequest(`CSV may contain at most ${maxRows} student rows`);
  const width = rows[0].length;
  if (rows.some((values) => values.length !== width)) throw badRequest('CSV rows must all have the same number of columns');
  return rows;
}
