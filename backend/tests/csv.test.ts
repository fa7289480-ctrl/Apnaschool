import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/services/csv.js';

describe('CSV parser for student import', () => {
  it('parses headers, commas inside quoted fields, escaped quotes, and CRLF', () => {
    expect(parseCsv('firstName,lastName\r\n"Ali, Ahmad","Said ""Khan"""\r\n')).toEqual([
      ['firstName', 'lastName'], ['Ali, Ahmad', 'Said "Khan"'],
    ]);
  });
  it('supports newlines inside quoted fields', () => {
    expect(parseCsv('firstName,lastName\n"Ali\nAhmad",Khan\n')).toEqual([
      ['firstName', 'lastName'], ['Ali\nAhmad', 'Khan'],
    ]);
  });
  it('rejects malformed or oversized input', () => {
    expect(() => parseCsv('firstName,lastName\n"Ali,Khan')).toThrow();
    expect(() => parseCsv('firstName,lastName\nAli')).toThrow();
    expect(() => parseCsv('x'.repeat(1_000_001))).toThrow();
  });
});
