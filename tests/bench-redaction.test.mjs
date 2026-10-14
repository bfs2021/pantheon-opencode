/**
 * bench-redaction.test.mjs — TDD contract tests for bench/lib/redact.mjs
 * (beta-10 latency slice, Phase 0 baseline harness).
 *
 * Locked contract: NO secret can ever reach the bench report. assertNoSecrets
 * walks the whole report object and throws naming the offending PATH and the
 * pattern LABEL — never the value itself.
 *
 * Planted secrets in this file are assembled at runtime from fragments so the
 * repository's own secret-scan never sees a literal credential-shaped string.
 *
 * Run: node --test tests/bench-redaction.test.mjs
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

const { assertNoSecrets, findSecrets } = await import('../bench/lib/redact.mjs')

// Runtime-assembled fake credentials (never literals in source).
const FAKE_BIFROST = ['sk', '-bf-', 'FAKE0000FAKE'].join('')
const FAKE_GITHUB = ['ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'].join('')
const FAKE_AWS = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')

test('findSecrets flags high-confidence credential shapes with a path and label', () => {
  const hits = findSecrets({
    nested: { token: FAKE_BIFROST },
    list: ['clean', FAKE_GITHUB],
    aws: `prefix ${FAKE_AWS} suffix`,
  })
  const labels = hits.map((h) => h.label)
  assert.equal(hits.length, 3)
  assert.ok(labels.some((l) => /bifrost/i.test(l)))
  assert.ok(labels.some((l) => /github/i.test(l)))
  assert.ok(labels.some((l) => /aws/i.test(l)))
  assert.equal(hits[0].path, '$.nested.token')
  // the offending VALUE must never be part of the finding
  for (const hit of hits) {
    assert.ok(!JSON.stringify(hit).includes('FAKE0000FAKE'))
  }
})

test('findSecrets ignores benign report content (prompts, tool names, versions)', () => {
  const benign = {
    prompt: 'Crie a pasta bench-run-A e monte um site comparativo de carros',
    toolCalls: { shell: 12, read: 4 },
    protocol: { opencodeVersion: 'opencode v2.0.27', model: 'opencode-go/glm-5.3-flash' },
  }
  assert.deepEqual(findSecrets(benign), [])
})

test('assertNoSecrets throws and names the offending path', () => {
  assert.throws(() => assertNoSecrets({ a: { b: FAKE_BIFROST } }), /\$\.a\.b/)
})

test('assertNoSecrets passes a clean report through', () => {
  assert.doesNotThrow(() => assertNoSecrets({ ok: true, items: [1, 2, 3] }))
})
