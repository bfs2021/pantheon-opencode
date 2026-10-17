import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  PROMPT_CANCELED,
  promptReview,
  runInteractiveInstall,
} from '../scripts/install/interactive.mjs'
import { installOpenCode } from '../scripts/install/opencode.mjs'

const CANCEL = Symbol('cancel')

function fakePrompts({ components = ['agents'], target = 'global', confirmed = true } = {}) {
  const calls = []
  return {
    calls,
    isCancel: (value) => value === CANCEL,
    cancel: (message) => calls.push(['cancel', message]),
    multiselect: async (options) => {
      calls.push(['multiselect', options])
      return components
    },
    select: async (options) => {
      calls.push(['select', options])
      return target
    },
    confirm: async (options) => {
      calls.push(['confirm', options])
      return confirmed
    },
  }
}

test('interactive Clack prompts preserve selected components, location, and confirmation', async () => {
  const prompts = fakePrompts({ components: ['agents', 'plugins'], target: 'project' })
  const result = await runInteractiveInstall({
    components: ['agents'],
    defaultComponents: ['agents', 'skills'],
    prompts,
    isTTY: true,
  })

  assert.deepEqual([...result.components], ['agents', 'plugins'])
  assert.equal(result.target, 'project')
  assert.equal(result.confirmed, true)
  assert.deepEqual(
    prompts.calls.map(([name]) => name),
    ['multiselect', 'select', 'confirm'],
  )
})

test('interactive prompt cancellation exits before any installer configuration writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-interactive-cancel-'))
  const target = join(root, 'opencode')
  mkdirSync(target, { recursive: true })
  const sentinel = join(target, 'sentinel.json')
  writeFileSync(sentinel, '{"untouched":true}\n')
  const prompts = fakePrompts()
  prompts.multiselect = async () => CANCEL

  try {
    const result = await installOpenCode(target, false, false, ['agents'], {
      interactive: true,
      version: 'v1',
      global: true,
      deps: { prompts, isTTY: true },
    })
    assert.equal(result.applied, false)
    assert.equal(result.reason, 'canceled')
    assert.deepEqual(prompts.calls, [['cancel', 'Installation canceled.']])
    assert.equal(readFileSync(sentinel, 'utf8'), '{"untouched":true}\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review prompt preserves cancellation separately from an explicit decline', async () => {
  const prompts = fakePrompts()
  prompts.confirm = async (options) => {
    prompts.calls.push(['confirm', options])
    return CANCEL
  }

  assert.equal(
    await promptReview('Apply this reviewed plan?', { prompts, isTTY: true }),
    PROMPT_CANCELED,
  )
  assert.deepEqual(prompts.calls, [
    ['confirm', { message: 'Apply this reviewed plan?', initialValue: false }],
    ['cancel', 'Installation canceled.'],
  ])

  const declinePrompts = fakePrompts({ confirmed: false })
  assert.equal(
    await promptReview('Apply this reviewed plan?', { prompts: declinePrompts, isTTY: true }),
    false,
  )
  assert.equal(declinePrompts.calls.length, 1)
})

test('canceling final apply authorization reports canceled and writes nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-review-cancel-'))
  const target = join(root, 'opencode')
  mkdirSync(target, { recursive: true })
  const sentinel = join(target, 'sentinel.json')
  writeFileSync(sentinel, '{"untouched":true}\n')

  try {
    const result = await installOpenCode(target, false, false, ['agents'], {
      headless: true,
      version: 'v1',
      deps: { promptReview: async () => PROMPT_CANCELED },
    })
    assert.equal(result.applied, false)
    assert.equal(result.reason, 'canceled')
    assert.equal(readFileSync(sentinel, 'utf8'), '{"untouched":true}\n')
    assert.deepEqual(readdirSync(target), ['sentinel.json'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('forced interactive mode without a TTY keeps defaults and never invokes prompts', async () => {
  const prompts = fakePrompts()
  const result = await runInteractiveInstall({
    components: ['agents'],
    defaultComponents: ['agents', 'skills'],
    prompts,
    isTTY: false,
  })

  assert.deepEqual([...result.components], ['agents', 'skills'])
  assert.equal(result.target, 'global')
  assert.equal(result.confirmed, true)
  assert.deepEqual(prompts.calls, [])
})
