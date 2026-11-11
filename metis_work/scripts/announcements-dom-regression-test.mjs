import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src-modern');
const html = await readFile(path.join(root, 'announcements.html'), 'utf8');
const script = await readFile(path.join(root, 'scripts/announcements.js'), 'utf8');

// Every static ID looked up with $(...) must exist in the page markup.
const referencedIds = [...script.matchAll(/\$\('([A-Za-z][A-Za-z0-9_-]*)'\)/g)].map((match) => match[1]);
const declaredIds = new Set([...html.matchAll(/\bid=["\']([^"\']+)["\']/g)].map((match) => match[1]));
const missing = [...new Set(referencedIds)].filter((id) => !declaredIds.has(id));
assert.deepEqual(missing, [], `announcements.js references missing HTML IDs: ${missing.join(', ')}`);

// Guard the user-visible notification actions and existing API contract.
assert.match(script, /request\('\/api\/announcements\/notifications'\)/, 'notification feed must load');
assert.match(script, /\/api\/announcements\/notifications\/read-all/, 'mark-all-read endpoint must remain wired');
assert.match(script, /\/api\/announcements\/notifications\/\$\{encodeURIComponent\(b\.dataset\.notificationRead\)\}\/read/, 'single notification mark-read endpoint must remain wired');
assert.match(script, /\/api\/announcements\/\$\{encodeURIComponent\(b\.dataset\.read\)\}\/read/, 'announcement mark-read endpoint must remain wired');
console.log('PASS announcements DOM IDs and notification action wiring');
