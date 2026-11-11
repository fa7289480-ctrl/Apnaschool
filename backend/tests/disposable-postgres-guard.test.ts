import { describe, expect, it } from 'vitest';
import { assertDisposablePostgresTestTarget } from './helpers/disposablePostgresGuard.js';

describe('disposable PostgreSQL test safety gate', () => {
  it('requires explicit opt-in', () => {
    expect(() => assertDisposablePostgresTestTarget('postgresql://fake_user:fake_password@127.0.0.1:55432/apnaschool_phase7_test', undefined)).toThrow(/approved disposable/i);
  });
  it('rejects missing and non-PostgreSQL URLs', () => {
    expect(() => assertDisposablePostgresTestTarget(undefined, '1')).toThrow(/DATABASE_URL is missing/i);
    expect(() => assertDisposablePostgresTestTarget('sqlite://local/test', '1')).toThrow(/only PostgreSQL/i);
  });
  it('rejects database names without the test suffix', () => {
    expect(() => assertDisposablePostgresTestTarget('postgresql://fake_user:fake_password@127.0.0.1:55432/apnaschool_dev', '1')).toThrow(/must end with _test/i);
  });
  it('rejects missing credentials and malformed or unsafe encoded database paths', () => {
    expect(() => assertDisposablePostgresTestTarget('postgresql://127.0.0.1:55432/apnaschool_test', '1')).toThrow(/username, and password are required/i);
    expect(() => assertDisposablePostgresTestTarget('postgresql://fake_user:fake_password@127.0.0.1:55432/apnaschool_test%2Fprod', '1')).toThrow(/one database name|unsafe path separator/i);
    expect(() => assertDisposablePostgresTestTarget('postgresql://fake_user:fake_password@127.0.0.1:55432/%ZZ_test', '1')).toThrow(/invalid URL encoding/i);
  });
  it('accepts URL-encoded characters in a single safe test database name', () => {
    const url = assertDisposablePostgresTestTarget('postgresql://fake_user:fake_password@127.0.0.1:55432/apnaschool%5Fphase7_test', '1');
    expect(url.pathname).toBe('/apnaschool%5Fphase7_test');
  });
  it('accepts an explicitly approved disposable test URL', () => {
    const url = assertDisposablePostgresTestTarget('postgresql://fake_user:fake_password@127.0.0.1:55432/apnaschool_phase7_test', '1');
    expect(url.pathname).toBe('/apnaschool_phase7_test');
  });
});
