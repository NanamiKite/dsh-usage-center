#!/usr/bin/env node
/**
 * usage-center CLI: read-only summary of the local usage ledger.
 *
 * Usage:
 *   node bin/usage-center.mjs [--db <path>] [--json] [--view summary|today|models|context]
 *
 * Reads the same SQLite ledger the plugin maintains; safe to run while the
 * plugin is active (WAL readers never block the collector).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { UsageDatabase } from '../lib/storage/database.js';
import { QueryService } from '../lib/query/query-service.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);

const dbPath = flag('db')
  ?? process.env.DSH_USAGE_CENTER_DB
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-usage-center', 'usage-center.db');
const view = flag('view') ?? 'summary';

let store;
try {
  store = new UsageDatabase(dbPath, { readOnly: true });
} catch (error) {
  console.error(`usage-center: cannot open ${dbPath}: ${error.message}`);
  process.exit(1);
}
const query = new QueryService(store);
try {
  if (has('json')) {
    const data = view === 'context'
      ? query.context()
      : { summary: query.summary() };
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } else {
    process.stdout.write(`${query.usageText(view)}\n`);
  }
} finally {
  store.close();
}
