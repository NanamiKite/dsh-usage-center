/**
 * SessionNormalizer: converts durable session events into `UsageRecord`s.
 *
 * One instance tracks one session (live or historical). Both the live
 * `session/event` feed and the history importer feed events through the same
 * `process()` — the single normalization path guarantees "live == history".
 *
 * Consumed event types (verified against real v4 logs):
 * - `step/start`            → step timing anchor (for duration/latency)
 * - `assistant/message`     → settled chat request (usage + stream)
 * - `compaction/summary`    → the compaction summarizer's own LLM call
 * - `assistant/attempt`     → failed/retried/cancelled attempt (defensive:
 *                             tokens and finish/failure live in the embedded
 *                             stream's terminal chunks)
 *
 * Token semantics guard: DSH-normalized usage observed locally satisfies
 * `total = input + output + cacheRead + cacheWrite`. The normalizer keeps the
 * raw usage verbatim (`rawUsage`) so semantics can be re-derived later; it
 * never invents missing values (missing → null).
 */

import type { RequestKind, UsageRecord } from '../domain/types.js';
import { firstTokenTime, type StreamRecord } from '../domain/first-token.js';

/** Session header subset the normalizer needs (fields verified in v4 logs). */
export interface SessionHeaderLike {
  id?: string;
  createdAt?: number;
  cwd?: string;
  parentSession?: string;
  origin?: string;
  seedLength?: number;
  isSeeded?: boolean;
  delegationDepth?: number;
}

export interface SessionEventLike {
  type: string;
  seq: number;
  time: number;
  data?: unknown;
}

interface UsageShape {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  reasoningTokens?: unknown;
  totalTokens?: unknown;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Extract a session title from a `session/title` event
 * (`{ title, messageSeqs, source }` in v4 logs), or null.
 */
export function sessionTitleOf(event: SessionEventLike): string | null {
  if (event.type !== 'session/title') return null;
  const data = asRecord(event.data);
  if (data === undefined) return null;
  return typeof data.title === 'string' && data.title.trim().length > 0
    ? data.title.trim()
    : null;
}

export class SessionNormalizer {
  private readonly sessionId: string;
  private readonly header: SessionHeaderLike;
  private readonly orphanRetry: 'record' | 'ignore';
  private readonly stepStarts = new Map<string, number>();
  /** requestId of the most recent attempt per step, for llm/retry amendment. */
  private readonly lastAttempt = new Map<string, UsageRecord>();

  /**
   * `orphanRetry` governs `llm/retry` events with no cached attempt:
   * - `'record'` (history replay): bill the retry boundary itself so a
   *   genuinely lost attempt stays visible.
   * - `'ignore'` (live feed): drop it. The live tracker starts empty at plugin
   *   boot, so an orphan retry here refers to a pre-boot attempt that history
   *   import owns — recording it would permanently double-count the call once
   *   the attempt row converges (review finding: startup boundary).
   */
  constructor(
    sessionId: string,
    header: SessionHeaderLike = {},
    options: { orphanRetry?: 'record' | 'ignore' } = {},
  ) {
    this.sessionId = sessionId;
    this.header = header;
    this.orphanRetry = options.orphanRetry ?? 'record';
  }

  /** First own-event boundary: events below it are fork-inherited seed. */
  get seedBoundary(): number {
    const seedLength = this.header.seedLength;
    return typeof seedLength === 'number' && seedLength >= 0 ? seedLength : 0;
  }

  private stepKey(turn: unknown, step: unknown): string | null {
    if (typeof turn !== 'number' || typeof step !== 'number') return null;
    return `${turn}:${step}`;
  }

  private stepStartTime(turn: unknown, step: unknown): number | null {
    const key = this.stepKey(turn, step);
    if (key === null) return null;
    const time = this.stepStarts.get(key);
    return time === undefined ? null : time;
  }

  /**
   * Process one durable event. Returns a UsageRecord when the event settles an
   * LLM request, otherwise null. Never throws on unexpected payload shapes.
   */
  /**
   * A `request/context` event → one context sample: the request's window
   * declaration (`{ provider, model, contextWindow }` in v4 logs). The
   * context size itself is derived later from the first following usage
   * record (see `fillContextTokens`), keeping live and replay identical.
   */
  processContext(event: SessionEventLike): {
    sessionId: string; seq: number; timestamp: number;
    provider: string | null; model: string | null; contextWindow: number | null;
  } | null {
    if (event.type !== 'request/context') return null;
    try {
      const data = asRecord(event.data);
      if (data === undefined) return null;
      const provider = nullableString(data.provider);
      const model = nullableString(data.model);
      const contextWindow = typeof data.contextWindow === 'number' && Number.isFinite(data.contextWindow)
        ? data.contextWindow
        : null;
      if (provider === null && model === null && contextWindow === null) return null;
      return {
        sessionId: this.sessionId,
        seq: Number(event.seq),
        timestamp: Number(event.time),
        provider, model, contextWindow,
      };
    } catch {
      return null;
    }
  }

  process(event: SessionEventLike): UsageRecord | null {
    try {
      switch (event.type) {
        case 'step/start': {
          const key = this.stepKey(
            asRecord(event.data)?.turn,
            asRecord(event.data)?.step,
          );
          if (key !== null) this.stepStarts.set(key, event.time);
          return null;
        }
        case 'assistant/message':
          return this.fromAssistantMessage(event);
        case 'compaction/summary':
          return this.fromCompactionSummary(event);
        case 'assistant/attempt':
          return this.fromAssistantAttempt(event);
        case 'llm/retry':
          return this.fromLlmRetry(event);
        default:
          return null;
      }
    } catch {
      // Collection must never break the host: a malformed event is dropped.
      return null;
    }
  }

  private base(event: SessionEventLike, kind: RequestKind): UsageRecord {
    const seq = event.seq;
    return {
      requestId: `${this.sessionId}:${seq}`,
      sessionId: this.sessionId,
      seq,
      turn: null,
      step: null,
      parentSessionId: nullableString(this.header.parentSession),
      origin: nullableString(this.header.origin),
      isSeed: seq < this.seedBoundary ? 1 : 0,
      cwd: nullableString(this.header.cwd),
      provider: null,
      model: null,
      kind,
      timestamp: event.time,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      durationMs: null,
      firstTokenLatencyMs: null,
      finishReason: null,
      errorCode: null,
      errorStatus: null,
      errorMessage: null,
      rawUsage: null,
      sourceEvent: event.type,
    };
  }

  private applyUsage(record: UsageRecord, usage: UsageShape | undefined): void {
    if (usage === undefined) return;
    record.inputTokens = tokenCount(usage.inputTokens);
    record.outputTokens = tokenCount(usage.outputTokens);
    record.cacheReadTokens = tokenCount(usage.cacheReadTokens);
    record.cacheWriteTokens = tokenCount(usage.cacheWriteTokens);
    record.reasoningTokens = tokenCount(usage.reasoningTokens);
    record.totalTokens = tokenCount(usage.totalTokens);
    record.rawUsage = JSON.stringify(usage);
  }

  private fromAssistantMessage(event: SessionEventLike): UsageRecord | null {
    const data = asRecord(event.data);
    if (data === undefined) return null;
    const record = this.base(event, 'chat');

    const turn = data.turn;
    const step = data.step;
    if (typeof turn === 'number') record.turn = turn;
    if (typeof step === 'number') record.step = step;

    const message = asRecord(data.message);
    const source = asRecord(message?.source);
    if (source !== undefined) {
      record.provider = nullableString(source.provider);
      record.model = nullableString(source.model);
    }

    this.applyUsage(record, asRecord(data.usage) as UsageShape | undefined);

    const stepStart = this.stepStartTime(turn, step);
    if (stepStart !== null && event.time >= stepStart) {
      record.durationMs = event.time - stepStart;
    }

    const stream = data.stream;
    if (Array.isArray(stream)) {
      const first = firstTokenTime(stream as readonly StreamRecord[]);
      if (first !== undefined && stepStart !== null && first >= stepStart) {
        record.firstTokenLatencyMs = first - stepStart;
      }
    }
    return record;
  }

  private fromCompactionSummary(event: SessionEventLike): UsageRecord | null {
    const data = asRecord(event.data);
    if (data === undefined) return null;
    const record = this.base(event, 'compaction');
    record.provider = nullableString(data.provider);
    record.model = nullableString(data.model);
    this.applyUsage(record, asRecord(data.usage) as UsageShape | undefined);
    return record;
  }

  /**
   * Best-effort: `assistant/attempt` retains failed/retried/cancelled attempts
   * `assistant/attempt` retains failed/retried/cancelled attempts (dsh-session
   * README). Verified real payload (subagent session, 2026-11-10):
   * `{ turn, step, stream }` where the embedded compact stream carries a
   * terminal `usage` chunk (tokens billed before the failure) and a `finish`
   * chunk whose `reason` is `{kind:'error', failure:{message, code}}`.
   * The paired `llm/retry` event (same turn/step, next seq) adds `provider`
   * and the full failure; `fromLlmRetry` amends this record with it.
   */
  private fromAssistantAttempt(event: SessionEventLike): UsageRecord | null {
    const data = asRecord(event.data);
    if (data === undefined) return null;
    const record = this.base(event, 'attempt');

    const turn = data.turn;
    const step = data.step;
    if (typeof turn === 'number') record.turn = turn;
    if (typeof step === 'number') record.step = step;

    const source = asRecord(asRecord(data.message)?.source) ?? asRecord(data.source);
    if (source !== undefined) {
      record.provider = nullableString(source.provider);
      record.model = nullableString(source.model);
    }

    this.applyUsage(record, asRecord(data.usage) as UsageShape | undefined);

    // Terminal chunks embedded in the attempt's compact stream.
    if (Array.isArray(data.stream)) {
      for (const entry of data.stream) {
        const rec = asRecord(entry);
        if (rec === undefined) continue;
        if (rec.type !== 'chunk') continue;
        const chunk = asRecord(rec.chunk);
        if (chunk === undefined) continue;
        if (chunk.type === 'usage') {
          this.applyUsage(record, asRecord(chunk.usage) as UsageShape | undefined);
        } else if (chunk.type === 'finish') {
          const reason = asRecord(chunk.reason);
          const kind = nullableString(reason?.kind);
          if (kind !== null) record.finishReason = kind;
          const failure = asRecord(reason?.failure);
          if (failure !== undefined) {
            record.errorCode = nullableString(failure.code);
            record.errorStatus = nullableNumber(failure.status);
            record.errorMessage = nullableString(failure.message);
          }
        }
      }
    }

    const key = this.stepKey(turn, step);
    if (key !== null) this.lastAttempt.set(key, record);
    return record;
  }

  /**
   * `llm/retry` (verified payload): `{retryId, turn, step, provider, mode,
   * policyKey, retry, maxRetries, delayMs, failure:{message, code}}`.
   * Amends the attempt record of the same (turn, step) — same requestId, so
   * the ledger upsert updates the existing row — or, when the attempt event
   * was lost, bills the retry itself as an attempt row.
   */
  private fromLlmRetry(event: SessionEventLike): UsageRecord | null {
    const data = asRecord(event.data);
    if (data === undefined) return null;
    const turn = data.turn;
    const step = data.step;
    const key = this.stepKey(turn, step);
    if (key === null) return null;

    const provider = nullableString(data.provider);
    const failure = asRecord(data.failure);
    const code = nullableString(failure?.code);
    const status = nullableNumber(failure?.status);
    const message = nullableString(failure?.message);

    const cached = this.lastAttempt.get(key);
    if (cached !== undefined) {
      const amended: UsageRecord = { ...cached };
      if (amended.provider === null && provider !== null) amended.provider = provider;
      if (amended.errorCode === null && code !== null) amended.errorCode = code;
      if (amended.errorStatus === null && status !== null) amended.errorStatus = status;
      if (amended.errorMessage === null && message !== null) amended.errorMessage = message;
      if (amended.finishReason === null) amended.finishReason = 'error';
      this.lastAttempt.set(key, amended);
      return amended;
    }

    // The attempt event never settled in THIS tracker. History replay keeps
    // the retry visible as an attempt row; the live feed drops it because the
    // attempt belongs to a pre-boot session that history import will own.
    if (this.orphanRetry === 'ignore') return null;
    const record = this.base(event, 'attempt');
    if (typeof turn === 'number') record.turn = turn;
    if (typeof step === 'number') record.step = step;
    record.provider = provider;
    record.errorCode = code;
    record.errorStatus = status;
    record.errorMessage = message;
    record.finishReason = 'error';
    return record;
  }
}
