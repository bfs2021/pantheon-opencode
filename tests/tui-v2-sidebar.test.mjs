/**
 * Focused tests for the OpenCode V2 TUI sidebar bundle (dist/tui-v2.js).
 *
 * The packaged V2 plugin is imported with a fake `context` — the same pattern
 * as tests/tui-packaged-smoke.test.mjs — so no OpenCode TUI runtime is needed.
 * Assertions cover the logic ported from the V1 sidebar: preset resolution,
 * the active-session line, running-only delegation filtering and formatting
 * (tone / elapsed / marker / "+N"), the empty-initial-state guard behind the
 * Known Issue, the completion tracker that feeds the toasts, click-through
 * routing, and the eager warm-up the plugin performs at setup.
 *
 * They also drive the reactive model (`createSidebarModel`) inside a Solid root
 * with a fake host: the refresh subscription only uses names from the OpenCode
 * V2 event union, one toast fires per running→terminal transition and none at
 * mount, the spinner is armed only while a child runs, terminal delegations
 * are filtered out of the rendered set, and teardown calls every unsubscribe
 * the host handed out.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/* Under `node --test` the bare `solid-js` specifier resolves to the SSR build,
 * where `createEffect`/`onMount` are no-ops and no subscription would ever be
 * registered. Map it to the client build so the model's effects really run. */
function resolveSolidClientUrl() {
  const candidates = [
    new URL('../node_modules/solid-js/dist/solid.js', import.meta.url),
    new URL('../src/plugins/tui/node_modules/solid-js/dist/solid.js', import.meta.url),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate.href
  throw new Error('solid-js client build not found — cannot exercise sidebar effects')
}

const solidClientUrl = resolveSolidClientUrl()
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'solid-js') return { url: solidClientUrl, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const { createRoot } = await import('solid-js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function loadV2() {
  return import(pathToFileURL(join(root, 'src/plugins/tui/dist/tui-v2.js')).href)
}

/* ─── OpenCode V2 event union ─────────────────────────────
 * The refresh subscription must only use names the host actually publishes.
 * `session.updated` (the V1 name) is NOT one of them — reading the generated
 * union keeps that honest instead of trusting a snapshot. */

/** Documented snapshot of the V2 `session.*` event names, used when the
 *  installed `@opencode/client` generated types cannot be located. */
const V2_SESSION_EVENTS = new Set([
  'session.agent.selected',
  'session.compaction.delta',
  'session.compaction.ended',
  'session.compaction.failed',
  'session.compaction.started',
  'session.created',
  'session.deleted',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.execution.started',
  'session.execution.succeeded',
  'session.forked',
  'session.idle',
  'session.inbox.cancelled',
  'session.inbox.delivered',
  'session.inbox.delivery.changed',
  'session.inbox.enqueued',
  'session.instructions.updated',
  'session.message.content.updated',
  'session.metadata.updated',
  'session.model.selected',
  'session.moved',
  'session.permissions',
  'session.reasoning.delta',
  'session.reasoning.ended',
  'session.reasoning.started',
  'session.renamed',
  'session.retry.scheduled',
  'session.revert.cleared',
  'session.revert.committed',
  'session.revert.staged',
  'session.shell.ended',
  'session.shell.started',
  'session.skill.activated',
  'session.status',
  'session.step.ended',
  'session.step.failed',
  'session.step.started',
  'session.step.streamed',
  'session.synthetic',
  'session.text.delta',
  'session.text.ended',
  'session.text.started',
  'session.tool.called',
  'session.tool.failed',
  'session.tool.input.delta',
  'session.tool.input.ended',
  'session.tool.input.started',
  'session.tool.progress',
  'session.tool.success',
  'session.usage.recorded',
  'session.usage.updated',
  'session.viewed',
])

/** Event names read out of the installed `@opencode/client` generated types,
 *  or null when that file is not where a hoisted/nested layout puts it. */
function readInstalledEventUnion() {
  const clients = [
    join(root, 'src/plugins/tui/node_modules/@opencode/plugin/node_modules/@opencode/client'),
    join(root, 'src/plugins/tui/node_modules/@opencode/client'),
    join(root, 'node_modules/@opencode/plugin/node_modules/@opencode/client'),
    join(root, 'node_modules/@opencode/client'),
  ].find((dir) => existsSync(join(dir, 'package.json')))
  if (clients === undefined) return null

  const pkg = JSON.parse(readFileSync(join(clients, 'package.json'), 'utf8'))
  const typesEntry = pkg.exports?.['.']?.types
  if (typeof typesEntry !== 'string') return null

  const generated = join(clients, dirname(typesEntry), 'generated', 'types.d.ts')
  if (!existsSync(generated)) return null

  const names = new Set()
  for (const match of readFileSync(generated, 'utf8').matchAll(
    /\btype:\s*"([a-z][a-zA-Z0-9.]*)"/g,
  )) {
    names.add(match[1])
  }
  return names.size > 0 ? names : null
}

/* ─── Fake sidebar host ───────────────────────────────────
 * A minimal `context`: only the surface `createSidebarModel` touches. */

function createSidebarHost(options = {}) {
  const registered = new Map()
  const unsubscribed = []
  const toasts = []
  const children = new Map(options.children ?? [])
  const statuses = new Map(options.statuses ?? [])
  const family = [...(options.family ?? [])]
  /* A host that publishes an event outside the V2 union is a bug, not a
   * tolerated drift — fail loudly so a typo cannot hide as a no-op. */
  const known = options.knownEvents ?? V2_SESSION_EVENTS
  const returnsUnsubscribe = options.returnsUnsubscribe ?? true

  const context = {
    location: { directory: options.directory ?? tmpdir() },
    data: {
      location: {
        vcs: { sync: async () => {}, info: () => ({ branch: { current: 'main' } }) },
      },
      session: {
        get: (id) => children.get(id),
        family: () => family.slice(),
        status: (id) => statuses.get(id),
        sync: async () => {},
      },
      on: (type, handler) => {
        if (!known.has(type)) throw new Error(`unknown V2 event subscribed: ${type}`)
        registered.set(type, handler)
        return returnsUnsubscribe ? () => unsubscribed.push(type) : undefined
      },
    },
    ui: { toast: { show: (options) => toasts.push(options) }, router: { navigate: () => {} } },
  }

  return {
    context,
    registered,
    unsubscribed,
    toasts,
    emit: (type) => registered.get(type)?.(),
    setChild: (id, child) => children.set(id, child),
    setStatus: (id, status) => statuses.set(id, status),
  }
}

/** Run `fn` with an isolated XDG_CONFIG_HOME so the active-preset file leg can
 *  never read the developer's real ~/.config candidate. */
async function withIsolatedXdg(fn) {
  const previous = process.env.XDG_CONFIG_HOME
  const isolated = mkdtempSync(join(tmpdir(), 'pantheon-xdg-'))
  process.env.XDG_CONFIG_HOME = isolated
  try {
    return await fn(isolated)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    rmSync(isolated, { recursive: true, force: true })
  }
}

test('preset resolution: env beats file, malformed/none fall back to default', async () => {
  const { presetFromEnv, resolvePresetForTui } = await loadV2()

  assert.deepEqual(presetFromEnv({ PANTHEON_MODEL_PRESET: 'max' }), {
    name: 'max',
    source: 'env',
  })
  assert.deepEqual(presetFromEnv({}), { name: null, source: null })
  assert.deepEqual(presetFromEnv({ PANTHEON_MODEL_PRESET: 'none' }), { name: null, source: null })
  assert.deepEqual(presetFromEnv({ PANTHEON_MODEL_PRESET: '' }), { name: null, source: null })

  await withIsolatedXdg(async () => {
    const project = mkdtempSync(join(tmpdir(), 'pantheon-preset-'))
    try {
      const dir = join(project, '.pantheon')
      mkdirSync(dir, { recursive: true })

      // No file → default.
      assert.deepEqual(await resolvePresetForTui({}, project), { name: null, source: null })

      // File wins when env is unset.
      writeFileSync(join(dir, 'active-preset.json'), JSON.stringify({ preset: 'pro' }))
      assert.deepEqual(await resolvePresetForTui({}, project), { name: 'pro', source: 'file' })

      // Env still wins over the file.
      assert.deepEqual(await resolvePresetForTui({ PANTHEON_MODEL_PRESET: 'max' }, project), {
        name: 'max',
        source: 'env',
      })

      // "none" in the file disables the preset.
      writeFileSync(join(dir, 'active-preset.json'), JSON.stringify({ preset: 'none' }))
      assert.deepEqual(await resolvePresetForTui({}, project), { name: null, source: null })

      // Malformed JSON degrades to default rather than throwing.
      writeFileSync(join(dir, 'active-preset.json'), '{ not json')
      assert.deepEqual(await resolvePresetForTui({}, project), { name: null, source: null })
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})

test('delegation view: state from status + outcome, grace window, label fallbacks', async () => {
  const { toDelegationView, delegationStateFromOutcome } = await loadV2()

  const running = toDelegationView(
    { id: 'ses_child', title: 'apo-1', time: { created: 1_000, updated: 4_000 } },
    'running',
  )
  assert.deepEqual(running, {
    id: 'ses_child',
    label: 'apo-1',
    state: 'running',
    startedAt: 1_000,
    updatedAt: 4_000,
  })

  const failed = toDelegationView(
    { id: 'ses_fail', agent: 'apollo', outcome: 'failed', time: { created: 1, updated: 2 } },
    'idle',
  )
  assert.equal(failed.state, 'failed', 'a failed outcome wins over an idle status')
  assert.equal(failed.label, 'apollo', 'falls back to the agent when there is no title')

  // V2 reports `idle` for both "created but not started" and "finished": a
  // fresh child must not flash the ✓ of a completed one.
  const now = 1_000_000
  const justSpawned = toDelegationView(
    { id: 'ses_new', title: 'just spawned', time: { created: now - 1_000, updated: now - 1_000 } },
    'idle',
    now,
  )
  assert.equal(justSpawned.state, 'running', 'an idle child inside the grace window is not done')

  const stale = toDelegationView(
    { id: 'ses_old', title: 'long done', time: { created: now - 600_000, updated: now - 600_000 } },
    'idle',
    now,
  )
  assert.equal(stale.state, 'completed', 'past the grace window idle is terminal')

  // An interrupted outcome is neither success nor failure.
  const interrupted = toDelegationView(
    {
      id: 'ses_abort',
      title: 'aborted',
      outcome: 'interrupted',
      time: { created: 1, updated: 2 },
    },
    'idle',
  )
  assert.equal(interrupted.state, 'interrupted')
  assert.equal(delegationStateFromOutcome('succeeded'), 'completed')
  assert.equal(delegationStateFromOutcome(undefined), null, 'absent outcome defers to status')

  const untitled = toDelegationView({ id: 'ses_abcdef123' }, 'idle')
  assert.equal(untitled.state, 'completed')
  assert.equal(untitled.label, 'ses_abcd', 'falls back to the short id')
  assert.equal(untitled.startedAt, null)
})

test('delegation formatting: tone, marker/spinner, elapsed, ordering, +N', async () => {
  const {
    delegationStateTone,
    delegationRowMarker,
    spinnerFrame,
    fmtElapsed,
    delegationElapsed,
    orderDelegations,
    ceilingDelegations,
  } = await loadV2()

  assert.equal(delegationStateTone('running'), 'warning')
  assert.equal(delegationStateTone('completed'), 'success')
  assert.equal(delegationStateTone('failed'), 'error')
  assert.equal(delegationStateTone('interrupted'), 'warning', 'an aborted job is not a success')

  assert.equal(delegationRowMarker('running', 0), `${spinnerFrame(0)} `)
  assert.equal(delegationRowMarker('completed'), '\u2713 ')
  assert.equal(delegationRowMarker('failed'), '\u2715 ')
  assert.equal(delegationRowMarker('interrupted'), '\u2298 ')
  assert.equal(spinnerFrame(0), '\u280b', 'first spinner frame')

  assert.equal(fmtElapsed(12_000), '12s')
  assert.equal(fmtElapsed(180_000), '3m')
  assert.equal(fmtElapsed(3_600_000), '1h')
  assert.equal(fmtElapsed(2 * 86_400_000), '2d')

  const running = {
    id: 'r',
    label: 'r',
    state: 'running',
    startedAt: 1_000,
    updatedAt: 1_000,
  }
  assert.equal(delegationElapsed(running, 61_000), '1m')

  const done = {
    id: 'd',
    label: 'd',
    state: 'completed',
    startedAt: 1_000,
    updatedAt: 4_000,
  }
  assert.equal(delegationElapsed(done, 999_999), '3s', 'terminal rows freeze at updated-started')
  assert.equal(
    delegationElapsed({ ...done, updatedAt: null }, 999_999),
    '\u2014',
    'a missing timestamp reads as an em dash',
  )

  const ordered = orderDelegations([
    { id: 'z', label: 'z', state: 'completed', startedAt: 0, updatedAt: 10 },
    { id: 'y', label: 'y', state: 'running', startedAt: 0, updatedAt: 5 },
    { id: 'x', label: 'x', state: 'completed', startedAt: 0, updatedAt: 20 },
  ])
  assert.deepEqual(
    ordered.map((v) => v.id),
    ['y', 'x', 'z'],
    'running first, then most recently active',
  )

  const many = Array.from({ length: 10 }, (_, i) => ({
    id: `s${i}`,
    label: `s${i}`,
    state: 'completed',
    startedAt: 0,
    updatedAt: i,
  }))
  const capped = ceilingDelegations(many)
  assert.equal(capped.visible.length, 8)
  assert.equal(capped.hidden, 2, 'the remainder collapses into "… +N more"')
})

test('empty initial state guard (Known Issue) + session id validation', async () => {
  const { sidebarPlaceholder, isValidSessionID, SIDEBAR_WAITING_LABEL } = await loadV2()

  assert.equal(isValidSessionID('ses_abc'), true)
  assert.equal(isValidSessionID(''), false)
  assert.equal(isValidSessionID(undefined), false)
  assert.equal(isValidSessionID('foo'), false)

  assert.equal(sidebarPlaceholder(undefined), SIDEBAR_WAITING_LABEL)
  assert.equal(sidebarPlaceholder(''), SIDEBAR_WAITING_LABEL)
  assert.equal(sidebarPlaceholder('foo'), SIDEBAR_WAITING_LABEL)
  assert.equal(sidebarPlaceholder('ses_abc'), null, 'a real session suppresses the placeholder')
})

test('detectDelegationCompletions: one report per running→terminal transition', async () => {
  const { detectDelegationCompletions } = await loadV2()

  const running = (id) => ({ id, label: id, state: 'running' })
  const completed = (id) => ({ id, label: id, state: 'completed' })
  const failed = (id) => ({ id, label: id, state: 'failed' })

  // First observation never toasts.
  assert.deepEqual(detectDelegationCompletions(new Map(), [running('a')]).completed, [])

  const prev = new Map([['a', 'running']])
  assert.deepEqual(
    detectDelegationCompletions(prev, [completed('a')]).completed.map((c) => c.id),
    ['a'],
  )
  assert.deepEqual(
    detectDelegationCompletions(prev, [failed('a')]).completed.map((c) => c.state),
    ['failed'],
  )
  // Still running → no completion.
  assert.deepEqual(detectDelegationCompletions(prev, [running('a')]).completed, [])
  // Already terminal before → no double report.
  assert.deepEqual(
    detectDelegationCompletions(new Map([['a', 'completed']]), [failed('a')]).completed,
    [],
  )
})

test('navigateToSession: fail-open click-through', async () => {
  const { navigateToSession } = await loadV2()

  const calls = []
  assert.equal(
    navigateToSession({ navigate: (destination) => calls.push(destination) }, 'ses_1'),
    true,
  )
  assert.deepEqual(calls, [{ type: 'session', sessionID: 'ses_1' }])

  assert.equal(navigateToSession(undefined, 'ses_1'), false)
  assert.equal(navigateToSession({ navigate: () => {} }, 'nope'), false)
  assert.equal(navigateToSession({ navigate: () => {} }, undefined), false)
  assert.equal(
    navigateToSession(
      {
        navigate: () => {
          throw new Error('removed session')
        },
      },
      'ses_1',
    ),
    false,
    'a throwing router is absorbed',
  )
})

test('collectWarmupTargets: deduped, validated, bounded', async () => {
  const { collectWarmupTargets } = await loadV2()

  assert.deepEqual(
    collectWarmupTargets([
      { id: 'ses_a' },
      { id: 'ses_a' },
      { id: 'bad' },
      { id: '' },
      {},
      { id: 'ses_b' },
    ]),
    ['ses_a', 'ses_b'],
  )
  assert.equal(
    collectWarmupTargets([{ id: 'ses_a' }, { id: 'ses_b' }, { id: 'ses_c' }], 2).length,
    2,
  )
})

test('packaged plugin registers both slots, warms up eagerly, and disposes', async () => {
  const { default: plugin } = await loadV2()

  assert.equal(plugin.id, 'pantheon.tui')
  assert.equal(typeof plugin.setup, 'function')

  const project = mkdtempSync(join(tmpdir(), 'pantheon-v2-sidebar-'))
  const registrations = []
  const disposers = []
  const calls = { vcsSync: [], sessionSync: [] }

  const context = {
    location: { directory: project },
    data: {
      location: {
        default: () => ({ directory: project }),
        vcs: { sync: async (location) => calls.vcsSync.push(location) },
      },
      session: {
        list: () => [
          { id: 'ses_1', time: { updated: 2 } },
          { id: 'ses_2', time: { updated: 1 } },
        ],
        sync: async (id) => calls.sessionSync.push(id),
      },
      on: () => () => {},
    },
    ui: {
      slot: (claim) => {
        registrations.push(claim)
        const dispose = () => {}
        disposers.push(dispose)
        return dispose
      },
    },
  }

  try {
    const cleanup = plugin.setup(context)
    assert.equal(typeof cleanup, 'function', 'setup returns a cleanup function')

    const paths = registrations.map((claim) => claim.append)
    assert.ok(paths.includes('sidebar.content'), 'sidebar slot is registered')
    assert.ok(
      paths.includes('home.footer.status'),
      'home footer status guards the pre-prompt state',
    )
    for (const claim of registrations) assert.equal(typeof claim.render, 'function')

    // Eager warm-up: vcs + every listed session synced at load (Known Issue fix).
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.vcsSync.length, 1)
    assert.deepEqual([...calls.sessionSync].sort(), ['ses_1', 'ses_2'])

    // Singleton guard: a second setup is a no-op.
    const count = registrations.length
    assert.equal(plugin.setup(context), undefined)
    assert.equal(registrations.length, count)

    cleanup()
    // After cleanup the guard is released, so a reload can register again.
    const again = plugin.setup(context)
    assert.equal(typeof again, 'function')
    assert.ok(registrations.length > count)
    again()
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('refresh subscription uses only names from the OpenCode V2 event union', async () => {
  const { SIDEBAR_REFRESH_EVENTS } = await loadV2()

  assert.ok(SIDEBAR_REFRESH_EVENTS.length > 0)
  const installed = readInstalledEventUnion()
  const known = installed ?? V2_SESSION_EVENTS
  for (const name of SIDEBAR_REFRESH_EVENTS) {
    assert.ok(
      known.has(name),
      `${name} is not in the ${installed ? 'installed' : 'snapshot'} V2 event union`,
    )
  }

  assert.ok(
    !SIDEBAR_REFRESH_EVENTS.includes('session.updated'),
    'session.updated is absent from the V2 union — subscribing to it was a silent no-op',
  )
  for (const replacement of [
    'session.renamed',
    'session.metadata.updated',
    'session.moved',
    'session.idle',
  ]) {
    assert.ok(
      SIDEBAR_REFRESH_EVENTS.includes(replacement),
      `${replacement} carries the refresh V1 got from session.updated`,
    )
  }
})

test('createSidebarModel: subscription, toast, spinner and teardown (fake host)', async () => {
  const { createSidebarModel } = await loadV2()
  const now = Date.now()
  const host = createSidebarHost({
    children: [
      ['ses_root', { id: 'ses_root', title: 'Root', agent: 'zeus' }],
      [
        'ses_child',
        {
          id: 'ses_child',
          parentID: 'ses_root',
          title: 'apo-1',
          time: { created: now, updated: now },
        },
      ],
      // A terminal child at mount must never render — its toast covers it.
      [
        'ses_done',
        {
          id: 'ses_done',
          parentID: 'ses_root',
          title: 'done-1',
          outcome: 'succeeded',
          time: { created: now - 5_000, updated: now - 4_000 },
        },
      ],
    ],
    statuses: [['ses_child', 'running']],
    family: ['ses_root', 'ses_child', 'ses_done'],
  })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })

  try {
    // The fake host throws on any name outside the union, so a passing mount
    // proves every subscription is a real V2 event.
    assert.deepEqual(
      [...host.registered.keys()],
      [
        'session.created',
        'session.renamed',
        'session.metadata.updated',
        'session.moved',
        'session.idle',
        'session.status',
        'session.deleted',
      ],
    )
    assert.deepEqual(host.toasts, [], 'mounting must not toast')

    // The sidebar no longer lists other sessions — only the active one.
    assert.equal(model.sessions, undefined, 'the session list is gone from the model')
    assert.equal(model.session()?.id, 'ses_root', 'the active session is exposed')
    assert.equal(model.session()?.title, 'Root')
    assert.equal(model.activeSessionID(), 'ses_root')

    // Only in-flight delegations render; the finished child is filtered out.
    assert.deepEqual(
      model.delegations().map((view) => [view.label, view.state]),
      [['apo-1', 'running']],
    )

    // Spinner armed only while a child runs.
    await sleep(3 * 80 + 40)
    assert.ok(model.frame() > 0, 'the spinner ticks while a delegation runs')

    host.setStatus('ses_child', 'idle')
    host.setChild('ses_child', {
      id: 'ses_child',
      parentID: 'ses_root',
      title: 'apo-1',
      outcome: 'succeeded',
      time: { created: now - 9_000, updated: now },
    })
    host.emit('session.idle')

    assert.deepEqual(
      host.toasts.map((toast) => [toast.message, toast.variant, toast.sessionID]),
      [['apo-1 concluída', 'success', 'ses_child']],
      'one toast on the running→terminal transition',
    )
    assert.deepEqual(model.delegations(), [], 'a finished delegation leaves the running-only list')

    const frozen = model.frame()
    await sleep(3 * 80 + 40)
    assert.equal(model.frame(), frozen, 'the interval is cleared once nothing runs')

    host.emit('session.status')
    assert.equal(host.toasts.length, 1, 'a terminal→terminal refresh is not a completion')
  } finally {
    dispose()
  }

  assert.deepEqual(
    [...host.unsubscribed].sort(),
    [...host.registered.keys()].sort(),
    'teardown releases every subscription the host handed out',
  )
})

test('createSidebarModel: a host returning no unsubscribe still tears down', async () => {
  const { createSidebarModel } = await loadV2()
  const host = createSidebarHost({ returnsUnsubscribe: false })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => undefined)
    return disposeRoot
  })

  assert.deepEqual(model.delegations(), [])
  assert.doesNotThrow(() => dispose())
  assert.deepEqual(host.unsubscribed, [])
})
