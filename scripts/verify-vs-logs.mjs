/**
 * Log reconciliation check:
 *
 * 1. Scan every real session log under $DSH_HOME/sessions (multi-frame zstd,
 *    same framing as the persistence backend) and compute per-session expected
 *    totals directly from `assistant/message` + `compaction/summary` events.
 * 2. Feed the same events through SessionNormalizer into a throwaway SQLite
 *    ledger and compare ledger totals with the direct computation.
 * 3. Replay every upsert a second time: all writes must classify as
 *    "unchanged" (idempotency proof).
 * 4. Report token-identity violations (total != input+output+cacheRead+cacheWrite)
 *    as an informational semantic check.
 *
 * Exit code 0 only when 2 and 3 hold for every session.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { SessionNormalizer } from '../lib/collector/normalizer.js';
import { UsageDatabase } from '../lib/storage/database.js';

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const SESSIONS_DIR = path.join(DSH_HOME, 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decompressSessionLog(file) {
  const buf = fs.readFileSync(file);
  const offsets = [0];
  let i = buf.indexOf(MAGIC, 4);
  while (i !== -1) {
    offsets.push(i);
    i = buf.indexOf(MAGIC, i + 1);
  }
  const parts = [];
  for (let k = 0; k < offsets.length; k += 1) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(offsets[k], offsets[k + 1] ?? buf.length)));
    } catch {
      // partial trailing frame: the writer may append mid-frame; skip it
    }
  }
  return Buffer.concat(parts)
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function listSessionFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const workspace of fs.readdirSync(dir)) {
    const workspaceDir = path.join(dir, workspace);
    if (!fs.statSync(workspaceDir).isDirectory()) continue;
    for (const session of fs.readdirSync(workspaceDir)) {
      const sessionDir = path.join(workspaceDir, session);
      if (!fs.statSync(sessionDir).isDirectory()) continue;
      const log = path.join(sessionDir, 'session.v4.jsonl.zstd');
      if (fs.existsSync(log)) files.push(log);
    }
  }
  return files;
}

const USAGE_EVENTS = new Set(['assistant/message', 'compaction/summary', 'assistant/attempt']);
const FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];

function emptyTotals() {
  return { records: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
}

function addUsage(totals, usage) {
  totals.records += 1;
  for (const field of FIELDS) {
    const value = usage[field];
    if (typeof value === 'number' && Number.isFinite(value)) totals[field] += value;
  }
}

/**
 * Expected usage of one usage-bearing event. assistant/attempt keeps its
 * tokens inside the embedded stream's terminal `usage` chunk (verified real
 * payload); assistant/message and compaction/summary lift `data.usage`.
 */
function usageOfEvent(event) {
  if (event.type !== 'assistant/attempt') {
    const usage = event.data?.usage;
    return usage === undefined ? null : usage;
  }
  const stream = event.data?.stream;
  if (!Array.isArray(stream)) return null;
  for (const entry of stream) {
    if (entry?.type === 'chunk' && entry.chunk?.type === 'usage') {
      return entry.chunk.usage ?? null;
    }
  }
  return null;
}

// ---- expected totals: computed straight from the raw events ----------------
const files = listSessionFiles(SESSIONS_DIR);
const expected = new Map(); // sessionId -> totals
const expectedSeed = new Map(); // sessionId -> totals (seed rows only)
let identityViolations = 0;
let identityChecked = 0;
let usageEvents = 0;

for (const file of files) {
  const events = decompressSessionLog(file);
  if (events.length === 0) continue;
  const header = events[0].type === 'session' ? events[0] : {};
  const sessionId = header.id ?? path.basename(path.dirname(file));
  const seedLength = typeof header.seedLength === 'number' ? header.seedLength : 0;
  if (!expected.has(sessionId)) expected.set(sessionId, emptyTotals());
  for (const event of events) {
    if (!USAGE_EVENTS.has(event.type)) continue;
    const usage = usageOfEvent(event);
    if (usage === null) continue;
    usageEvents += 1;
    const isSeed = typeof event.seq === 'number' && event.seq < seedLength;
    addUsage(expected.get(sessionId), usage);
    if (isSeed) {
      if (!expectedSeed.has(sessionId)) expectedSeed.set(sessionId, emptyTotals());
      addUsage(expectedSeed.get(sessionId), usage);
    }
    if (
      typeof usage.totalTokens === 'number' &&
      typeof usage.inputTokens === 'number' &&
      typeof usage.outputTokens === 'number' &&
      typeof usage.cacheReadTokens === 'number' &&
      typeof usage.cacheWriteTokens === 'number'
    ) {
      identityChecked += 1;
      if (
        usage.totalTokens !==
        usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
      ) {
        identityViolations += 1;
      }
    }
  }
}

// ---- actual: normalizer → throwaway SQLite ledger ---------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-center-verify-'));
const dbPath = path.join(tmpDir, 'verify.db');
const db = new UsageDatabase(dbPath);

let mismatched = 0;
const rows = [];

for (const file of files) {
  const events = decompressSessionLog(file);
  if (events.length === 0) continue;
  const header = events[0].type === 'session' ? events[0] : {};
  const sessionId = header.id ?? path.basename(path.dirname(file));
  const normalizer = new SessionNormalizer(sessionId, header);

  for (const event of events) {
    const record = normalizer.process(event);
    if (record !== null) db.upsertRecord(record);
  }

  const expectedRow = expected.get(sessionId) ?? emptyTotals();
  const actual = db.totals({ sessionId });
  const match =
    actual.requests === expectedRow.records &&
    actual.inputTokens === expectedRow.inputTokens &&
    actual.outputTokens === expectedRow.outputTokens &&
    actual.cacheReadTokens === expectedRow.cacheReadTokens &&
    actual.cacheWriteTokens === expectedRow.cacheWriteTokens &&
    actual.totalTokens === expectedRow.totalTokens;
  if (!match) mismatched += 1;
  rows.push({ sessionId: sessionId.slice(8, 16), expected: expectedRow, actual, match });
}

// ---- idempotency: a full replay must leave the ledger's final state identical.
const dumpFacts = (database) =>
  JSON.stringify(
    database.db
      .prepare(
        'SELECT request_id, turn, step, provider, model, kind, timestamp, input_tokens, output_tokens, ' +
          'cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, duration_ms, ' +
          'first_token_latency_ms, finish_reason, error_code, error_status, error_message, raw_usage ' +
          'FROM usage_records ORDER BY request_id',
      )
      .all(),
  );
const before = dumpFacts(db);
for (const file of files) {
  const events = decompressSessionLog(file);
  if (events.length === 0) continue;
  const header = events[0].type === 'session' ? events[0] : {};
  const sessionId = header.id ?? path.basename(path.dirname(file));
  const normalizer = new SessionNormalizer(sessionId, header);
  for (const event of events) {
    const record = normalizer.process(event);
    if (record !== null) db.upsertRecord(record);
  }
}
let replayProblems = before === dumpFacts(db) ? 0 : 1;

// ---- report ------------------------------------------------------------------
console.log('=== dsh-usage-center: normalizer + ledger vs real session logs ===');
console.log(`sessions scanned: ${expected.size}, usage events: ${usageEvents}`);
console.log(`token identity checked: ${identityChecked}, violations: ${identityViolations} (informational)`);
console.log('');
for (const row of rows) {
  const e = row.expected;
  const a = row.actual;
  console.log(
    `${row.match ? 'OK  ' : 'FAIL'} ${row.sessionId}  records ${a.requests}/${e.records}  ` +
      `in ${a.inputTokens}/${e.inputTokens}  out ${a.outputTokens}/${e.outputTokens}  ` +
      `cRead ${a.cacheReadTokens}/${e.cacheReadTokens}  cWrite ${a.cacheWriteTokens}/${e.cacheWriteTokens}  ` +
      `total ${a.totalTokens}/${e.totalTokens}`,
  );
}
const grand = db.totals();
console.log('');
console.log(
  `ledger totals: ${grand.requests} requests, in ${grand.inputTokens}, out ${grand.outputTokens}, ` +
    `cacheRead ${grand.cacheReadTokens}, cacheWrite ${grand.cacheWriteTokens}, total ${grand.totalTokens}`,
);
console.log(`cache hit rate: ${grand.cacheHitRate === null ? 'n/a' : (grand.cacheHitRate * 100).toFixed(2) + '%'}`);
console.log(`avg first-token: ${
  grand.firstTokenMsCount > 0 ? (grand.firstTokenMsTotal / grand.firstTokenMsCount).toFixed(0) + 'ms' : 'n/a'
}`);

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

if (mismatched > 0 || replayProblems > 0) {
  console.error(`\nACCEPTANCE FAILED: ${mismatched} mismatched sessions, ${replayProblems} non-idempotent replays`);
  process.exit(1);
}
console.log('\nACCEPTANCE PASSED: ledger == direct log scan for every session; replay fully idempotent');
