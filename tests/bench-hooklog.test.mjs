/**
 * bench-hooklog.test.mjs — TDD contract tests for bench/lib/hooklog.mjs
 * (beta-10 latency slice, Phase 0 baseline harness).
 *
 * The hook instrumentation writes single-line `[bench]` entries to the
 * existing .pantheon/logs/hooks.log via the plugin's append helper (which
 * prefixes `[ISO] `). The parser must:
 *   - extract per-hook durations and the before→after chain duration
 *   - skip malformed / non-bench lines without throwing
 *   - report 'unavailable' (never zeros) when no bench lines exist
 *
 * Run: node --test tests/bench-hooklog.test.mjs
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

const { parseBenchHookLines, summarizeHookTimings } = await import('../bench/lib/hooklog.mjs')

const STAMP = '[2026-10-14T10:00:00.000Z]'

test('parseBenchHookLines extracts phase, tool, callID and duration from bench lines', () => {
  const text = [
    `${STAMP} [bench] tool.execute.before end tool=shell callID=c1 started_at=2026-10-14T10:00:00.000Z duration_ms=12`,
    `${STAMP} [bench] tool.execute.after end tool=shell callID=c1 duration_ms=4 since_before_ms=654`,
  ].join('\n')
  const entries = parseBenchHookLines(text)
  assert.equal(entries.length, 2)
  assert.deepEqual(
    { ...entries[0] },
    {
      phase: 'before',
      tool: 'shell',
      callID: 'c1',
      durationMs: 12,
      startedAtMs: Date.parse('2026-10-14T10:00:00.000Z'),
      lineAtMs: Date.parse('2026-10-14T10:00:00.000Z'),
      sinceBeforeMs: null,
    },
  )
  assert.equal(entries[1].phase, 'after')
  assert.equal(entries[1].sinceBeforeMs, 654)
})

test('non-bench and malformed lines are ignored without throwing', () => {
  const text = [
    `${STAMP} [SECRET SCAN] something else`,
    'garbage without a stamp',
    `${STAMP} [bench] tool.execute.before end tool=read callID=broken duration_ms=notanumber`,
    `${STAMP} [bench] tool.execute.before end tool=read callID=ok2 started_at=2026-10-14T10:00:01.000Z duration_ms=7`,
    '',
  ].join('\n')
  const entries = parseBenchHookLines(text)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].callID, 'ok2')
})

test('summarizeHookTimings computes per-hook medians and the before→after chain', () => {
  const text = [
    // c1: before starts at 10:00:00.000, ends +12ms; after ends at +1000ms
    `${STAMP} [bench] tool.execute.before end tool=shell callID=c1 started_at=2026-10-14T10:00:00.000Z duration_ms=12`,
    `[2026-10-14T10:00:01.000Z] [bench] tool.execute.after end tool=shell callID=c1 duration_ms=4`,
    // c2: before starts at 10:00:02.000 (+2000ms); after ends at +3000ms
    `[2026-10-14T10:00:02.012Z] [bench] tool.execute.before end tool=read callID=c2 started_at=2026-10-14T10:00:02.000Z duration_ms=12`,
    `[2026-10-14T10:00:03.000Z] [bench] tool.execute.after end tool=read callID=c2 duration_ms=6`,
  ].join('\n')
  const entries = parseBenchHookLines(text)
  const summary = summarizeHookTimings(entries, '2026-10-14T10:00:00.000Z')
  assert.equal(summary.status, 'ok')
  assert.equal(summary.beforeCount, 2)
  assert.equal(summary.afterCount, 2)
  assert.equal(summary.beforeMs.median, 12)
  // chain per call: c1 → 1000ms, c2 → 1000ms
  assert.equal(summary.chainMs.median, 1000)
  assert.equal(summary.chainMs.p80, 1000)
})

test('an after line without a matching before still counts as an after (orphan tolerated)', () => {
  const entries = parseBenchHookLines(
    `${STAMP} [bench] tool.execute.after end tool=shell callID=orphan duration_ms=5`,
  )
  const summary = summarizeHookTimings(entries, '2026-10-14T10:00:00.000Z')
  assert.equal(summary.status, 'ok')
  assert.equal(summary.afterCount, 1)
  assert.equal(summary.chainMs.status, 'unavailable')
})

test('summarizeHookTimings with no bench entries reports unavailable, not zeros', () => {
  const summary = summarizeHookTimings([], '2026-10-14T10:00:00.000Z')
  assert.equal(summary.status, 'unavailable')
  assert.ok(summary.reason.length > 0)
})
