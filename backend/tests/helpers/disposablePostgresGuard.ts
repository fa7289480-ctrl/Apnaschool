/** Safety gate for any future destructive PostgreSQL integration-test setup.
 * This helper never connects to or modifies a database; callers must invoke it
 * before any destructive setup and use a dedicated low-privilege test account.
 */
export function assertDisposablePostgresTestTarget(
  databaseUrl: string | undefined,
  explicitOptIn: string | undefined,
): URL {
  if (explicitOptIn !== '1') {
    throw new Error('Refusing database test setup: set APNASCHOOL_ALLOW_DISPOSABLE_POSTGRES_TESTS=1 only for an approved disposable test database.');
  }
  if (!databaseUrl) throw new Error('Refusing database test setup: DATABASE_URL is missing.');

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('Refusing database test setup: DATABASE_URL is not a valid URL.');
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('Refusing database test setup: only PostgreSQL URLs are allowed.');
  }
  if (!url.hostname || !url.username || !url.password) {
    throw new Error('Refusing database test setup: hostname, username, and password are required.');
  }
  if (url.hash) {
    throw new Error('Refusing database test setup: URL fragments are not allowed.');
  }

  // Treat the path as exactly one database-name segment. Reject encoded path
  // separators before decoding so e.g. `school_test%2Fproduction` cannot pass
  // by truncation and then be interpreted differently by another URL parser.
  const rawDatabasePath = url.pathname.slice(1);
  if (!rawDatabasePath || rawDatabasePath.includes('/') || /%(?:2f|5c)/i.test(rawDatabasePath)) {
    throw new Error('Refusing database test setup: DATABASE_URL must contain one database name.');
  }
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(rawDatabasePath);
  } catch {
    throw new Error('Refusing database test setup: database name has invalid URL encoding.');
  }
  if (!databaseName || databaseName.includes('/') || databaseName.includes('\\')) {
    throw new Error('Refusing database test setup: database name contains an unsafe path separator.');
  }
  if (!databaseName.toLowerCase().endsWith('_test')) {
    throw new Error('Refusing database test setup: database name must end with _test.');
  }
  if (/prod|production|live/i.test(databaseName)) {
    throw new Error('Refusing database test setup: production-like database names are forbidden.');
  }
  return url;
}
