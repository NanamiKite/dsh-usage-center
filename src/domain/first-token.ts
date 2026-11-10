/**
 * First-output-token timing over the compact assistant stream records that the
 * durable session log embeds in `assistant/message` (`data.stream`).
 *
 * The semantics mirror the official `@deepseek-ai/dsh-llm` helpers
 * (`isTokenDelta` / `assistantStreamFirstTokenTime`), reimplemented from the
 * verified contract:
 * - a `chunk` record counts when its chunk is a non-empty text/reasoning delta,
 *   or a tool-call delta with non-empty arguments or a name;
 * - a packed `tool-call-chunks` run starts at its first member when it carries
 *   a name, otherwise at its first non-empty arguments fragment;
 * - a packed `text-chunks` / `reasoning-chunks` run counts at its first
 *   non-empty fragment;
 * - usage/finish/block chunks never count.
 */

export interface RawChunk {
  type: string;
  text?: string;
  index?: number;
  argumentsDelta?: string;
  name?: string;
}

export interface RawChunkRecord {
  type: 'chunk';
  time: number;
  chunk: RawChunk;
}

export interface PackedTextRun {
  type: 'text-chunks' | 'reasoning-chunks';
  time0: number;
  index: number;
  dt: number[];
  texts: string[];
}

export interface PackedToolRun {
  type: 'tool-call-chunks';
  time0: number;
  index: number;
  dt: number[];
  id: string;
  name?: string;
  args: string[];
}

export type StreamRecord = RawChunkRecord | PackedTextRun | PackedToolRun;

function isTokenDeltaChunk(chunk: RawChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== undefined && chunk.text !== '';
    case 'tool-call-delta':
      return (
        (chunk.argumentsDelta !== undefined && chunk.argumentsDelta !== '') ||
        chunk.name !== undefined
      );
    default:
      return false;
  }
}

/** Time of the first qualifying member of one packed run, or undefined. */
function runFirstTokenTime(run: PackedTextRun | PackedToolRun): number | undefined {
  if (run.type === 'tool-call-chunks') {
    if (run.name !== undefined) return run.time0;
    let time = run.time0;
    const members = run.args;
    for (let i = 0; i < members.length; i += 1) {
      if (members[i] !== '') return time;
      const gap = run.dt[i];
      if (gap !== undefined) time += gap;
    }
    return undefined;
  }
  let time = run.time0;
  const members = run.texts;
  for (let i = 0; i < members.length; i += 1) {
    if (members[i] !== '') return time;
    const gap = run.dt[i];
    if (gap !== undefined) time += gap;
  }
  return undefined;
}

/**
 * Time of the first output token in one compact stream, or undefined when the
 * stream carries no token at all.
 */
export function firstTokenTime(stream: readonly StreamRecord[]): number | undefined {
  for (const record of stream) {
    if (record.type === 'chunk') {
      if (isTokenDeltaChunk(record.chunk)) return record.time;
      continue;
    }
    const time = runFirstTokenTime(record);
    if (time !== undefined) return time;
  }
  return undefined;
}

/** End time of one record (its last member's reconstructed time). */
function recordEndTime(record: StreamRecord): number {
  if (record.type === 'chunk') return record.time;
  let time = record.time0;
  const length =
    record.type === 'tool-call-chunks' ? record.args.length : record.texts.length;
  for (let i = 0; i < length - 1 && i < record.dt.length; i += 1) {
    const gap = record.dt[i];
    if (gap !== undefined) time += gap;
  }
  return time;
}

/** Time of the last record in the stream (stream end), or undefined when empty. */
export function lastStreamTime(stream: readonly StreamRecord[]): number | undefined {
  let last: number | undefined;
  for (const record of stream) {
    const end = recordEndTime(record);
    if (last === undefined || end > last) last = end;
  }
  return last;
}
