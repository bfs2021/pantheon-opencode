// biome-ignore-all lint/suspicious/noExplicitAny: OpenCode V2 exposes its TUI API at runtime.
// biome-ignore-all lint/a11y/noStaticElementInteractions: TUI elements, not DOM
/** @jsxImportSource @opentui/solid */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Plugin } from '@opencode/plugin/tui'
import type { Context } from '@opencode/plugin/tui/context'
import type { Accessor } from 'solid-js'
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'

const SINGLETON = Symbol.for('pantheon.tui.v2.loaded')

/* ─── Constants ─────────────────────────────────────────── */

/** How often the sidebar re-reads .pantheon/active-preset.json (V1 parity) so
 *  `set-tier` changes made while opencode is open show up within ~30s. */
const PRESET_REFRESH_MS = 30_000
/** Running delegations rendered before the "… +N more" line (V1 parity). */
export const DELEGATIONS_VISIBLE_CEILING = 8
/** Running-row spinner cadence — matches V1's animation tick. */
const SPINNER_INTERVAL_MS = 80
/** Bounded warm-up: sync at most this many sessions at plugin load. */
const WARMUP_SESSION_LIMIT = 24
/** Sidebar body shown while the host has not published a session yet. */
export const SIDEBAR_WAITING_LABEL = 'Aguardando sessão…'
/** Delegate-completion toast title. */
const TOAST_TITLE = 'Pantheon'
/** One event name the host publishes on `data.on` — the OpenCode V2 union. */
export type SidebarDataEvent = Parameters<Context['data']['on']>[0]
/** V2 events that refresh the sidebar. V1 also listened to `session.updated`,
 *  but that name is absent from the OpenCode V2 event union (verified against
 *  `@opencode/client`'s `OpenCodeEvent`), so the valid events that carry the
 *  same state changes are used instead: `session.renamed` /
 *  `session.metadata.updated` / `session.moved` (the mutations `session.updated`
 *  used to stand for) and `session.idle` (a child finishing). `satisfies` keeps
 *  the literals while making a name outside the union a type error (surfaced by
 *  `tsc -p tsconfig.build.json`), and the sidebar test asserts the same names
 *  against the installed union at runtime. */
export const SIDEBAR_REFRESH_EVENTS = [
  'session.created',
  'session.renamed',
  'session.metadata.updated',
  'session.moved',
  'session.idle',
  'session.status',
  'session.deleted',
] as const satisfies readonly SidebarDataEvent[]

/* ─── Active Preset Detection ──────────────────────────────
 * Inline replica of the V1 sidebar resolver (src/plugins/tui/src/index.tsx,
 * which itself mirrors src/pantheon/presets.mjs). The copied plugin ships only
 * dist/ + package.json, so it can reach neither module at runtime — the
 * resolution logic is mirrored here rather than imported.
 *
 * Priority: env PANTHEON_MODEL_PRESET > first existing candidate file > none.
 * Custom/unknown preset names are shown as-is. "none" disables → default. */

export type PresetInfo = { name: string | null; source: 'env' | 'file' | null }

/** Read .pantheon/active-preset.json — first existing candidate wins; malformed
 *  JSON or a `preset` that is missing, empty or "none" → null (no fall-through
 *  to lower candidates). */
async function readActivePresetFile(cwd: string): Promise<{ name: string; source: 'file' } | null> {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  const candidates = [
    join(cwd, '.pantheon', 'active-preset.json'),
    join(xdgConfig, 'opencode', '.pantheon', 'active-preset.json'),
    join(homedir(), '.opencode', '.pantheon', 'active-preset.json'),
  ]
  for (const candidate of candidates) {
    let raw: string
    try {
      raw = await readFile(candidate, 'utf8')
    } catch {
      continue // candidate does not exist — try the next one
    }
    try {
      const parsed = JSON.parse(raw) as { preset?: unknown }
      const name = parsed && typeof parsed === 'object' ? parsed.preset : undefined
      if (typeof name !== 'string' || name.length === 0 || name === 'none') return null
      return { name, source: 'file' }
    } catch {
      return null // malformed file — treat as default (mirrors presets.mjs)
    }
  }
  return null
}

/** Env leg of resolution: PANTHEON_MODEL_PRESET set and !== 'none' wins. */
export function presetFromEnv(env: Record<string, string | undefined>): PresetInfo {
  const name = env.PANTHEON_MODEL_PRESET
  if (name !== undefined && name !== '' && name !== 'none') {
    return { name, source: 'env' }
  }
  return { name: null, source: null }
}

/** Resolve the active preset for the sidebar: env > file > default. */
export async function resolvePresetForTui(
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<PresetInfo> {
  const envPreset = presetFromEnv(env)
  if (envPreset.source === 'env') return envPreset
  return (await readActivePresetFile(cwd)) ?? { name: null, source: null }
}

/* ─── Session helpers ────────────────────────────────────── */

/** `SessionInfo.id` is always a `ses…` handle. Guarded so a placeholder or a
 *  foreign id never reaches the status/navigate APIs. */
export function isValidSessionID(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith('ses')
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/* ─── Delegation helpers ─────────────────────────────────── */

export type DelegationState = 'running' | 'completed' | 'failed' | 'interrupted'
export type DelegationTone = 'warning' | 'error' | 'success'

/** Grace window for a child that has not started yet. V2's `session.status()`
 *  returns `idle` both for "created but not started" and for "finished", so an
 *  idle/unknown/absent child whose own last activity (`time.updated`, falling
 *  back to `time.created`) is this recent still reads as running — otherwise a
 *  just-spawned child renders a premature ✓. Trade-off (V1 parity: it had the
 *  same window for its absent statuses): a child that finished within the window
 *  and reports no `outcome` reads as running until the window closes, at which
 *  point it turns terminal and its completion toast fires. A child that reports
 *  a terminal `outcome` is never held back by the window. */
export const DELEGATION_CHILD_STATUS_GRACE_MS = 60 * 1000

/** One delegated child job as the sidebar renders it. */
export type DelegationView = {
  /** Child session id — also the click-through target. */
  id: string
  /** Alias shown on the row: the child title, else agent, else short id. */
  label: string
  state: DelegationState
  /** Epoch ms of the child's `time.created`. */
  startedAt: number | null
  /** Epoch ms of the child's `time.updated`. */
  updatedAt: number | null
}

/** Map the host's live session status to a display state. V2 exposes only
 *  `"idle" | "running"` through the TUI context (the client union adds `retry`
 *  and `busy`); `error`/`failed` are handled defensively for host drift.
 *  `idle`, `retry` and unknown/absent statuses are terminal only once the
 *  child's own activity is older than the grace window — within it the child
 *  reads as running (see `DELEGATION_CHILD_STATUS_GRACE_MS`). An interruption is
 *  not part of this union: it arrives as a terminal `outcome`. Pure. */
export function delegationStateFromStatus(
  status: string | undefined,
  time?: { created?: number; updated?: number },
  now = Date.now(),
  graceMs = DELEGATION_CHILD_STATUS_GRACE_MS,
): DelegationState {
  switch (status) {
    case 'running':
    case 'busy':
      return 'running'
    case 'error':
    case 'failed':
      return 'failed'
    default: {
      const lastActivity = Math.max(time?.updated ?? 0, time?.created ?? 0)
      if (lastActivity > 0 && now - lastActivity < graceMs) return 'running'
      return 'completed'
    }
  }
}

/** Map a V2 child `outcome` to a display state. `interrupted` (user abort,
 *  shutdown, superseded, inactivity) is distinct from both success and failure,
 *  so an aborted child never renders the ✓ of a completed one. Returns null for
 *  an absent/unrecognised outcome so the live status decides. Pure. */
export function delegationStateFromOutcome(outcome: unknown): DelegationState | null {
  switch (outcome) {
    case 'succeeded':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'interrupted':
      return 'interrupted'
    default:
      return null
  }
}

/** Build a delegation row from a child session + its live status. A terminal
 *  `outcome` wins when present (the only V2 primitive that surfaces a
 *  delegation failure/interruption once the status is back to idle); otherwise
 *  the live status decides, with the absent/idle grace window applied. Pure. */
export function toDelegationView(
  child: any,
  status: string | undefined,
  now = Date.now(),
): DelegationView {
  const id = typeof child?.id === 'string' ? child.id : ''
  const title = typeof child?.title === 'string' && child.title !== '' ? child.title : ''
  const agent = typeof child?.agent === 'string' && child.agent !== '' ? child.agent : ''
  const label = title !== '' ? title : agent !== '' ? agent : id.slice(0, 8)
  const state: DelegationState =
    delegationStateFromOutcome(child?.outcome) ??
    delegationStateFromStatus(status, child?.time, now)
  return {
    id,
    label,
    state,
    startedAt: numberOrNull(child?.time?.created),
    updatedAt: numberOrNull(child?.time?.updated),
  }
}

const DELEGATION_TONES: Record<DelegationState, DelegationTone> = {
  running: 'warning',
  completed: 'success',
  failed: 'error',
  interrupted: 'warning',
}

/** Whole-row tone: red = failed, green = terminal, yellow = in flight. The
 *  glyph stays a redundant channel so the state reads in monochrome. Pure. */
export function delegationStateTone(state: DelegationState): DelegationTone {
  return DELEGATION_TONES[state]
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** Spinner glyph for a frame counter (incremented every ~80ms while any job is
 *  running). Pure. */
export function spinnerFrame(frame: number): string {
  const index = Math.abs(Math.floor(frame)) % SPINNER_FRAMES.length
  return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0]
}

/** Row marker (`<glyph> `): the animated spinner while running, ✓ when done,
 *  ⊘ when interrupted, ✕ on failure. Pure. */
export function delegationRowMarker(state: DelegationState, frame = 0): string {
  if (state === 'running') return `${spinnerFrame(frame)} `
  if (state === 'failed') return '\u2715 '
  if (state === 'interrupted') return '\u2298 '
  return '\u2713 '
}

/** Compact single-unit elapsed label: "12s"/"3m"/"1h"/"2d". Pure. */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const seconds = total % 60
  if (days > 0) return `${days}d`
  if (hours > 0) return `${hours}h`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

/** Elapsed label for one row: a running job ticks `now - startedAt`; a terminal
 *  one is fixed at `updatedAt - startedAt` (em dash when a timestamp is
 *  missing). Pure. */
export function delegationElapsed(view: DelegationView, now: number): string {
  if (view.state === 'running') {
    return view.startedAt === null ? '\u2014' : fmtElapsed(now - view.startedAt)
  }
  if (view.startedAt !== null && view.updatedAt !== null)
    return fmtElapsed(view.updatedAt - view.startedAt)
  return '\u2014'
}

/** Live rows first (a running job never falls behind the cap), then by most
 *  recent activity. Pure. */
export function orderDelegations(views: readonly DelegationView[]): DelegationView[] {
  return [...views].sort((a, b) => {
    const activeA = a.state === 'running' ? 1 : 0
    const activeB = b.state === 'running' ? 1 : 0
    if (activeA !== activeB) return activeB - activeA
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  })
}

/** Cap the panel: at most `maxVisible` rows, the remainder collapsing into the
 *  "… +N more" line. Pure. */
export function ceilingDelegations(
  views: readonly DelegationView[],
  maxVisible = DELEGATIONS_VISIBLE_CEILING,
): { visible: DelegationView[]; hidden: number } {
  const limit = Math.max(0, maxVisible)
  const visible = views.slice(0, limit)
  return { visible, hidden: Math.max(0, views.length - visible.length) }
}

/** Session ids to eagerly sync at load (deduped, bounded). Pure. */
export function collectWarmupTargets(
  sessions: readonly any[],
  limit = WARMUP_SESSION_LIMIT,
): string[] {
  const ids: string[] = []
  for (const session of sessions) {
    if (!isValidSessionID(session?.id) || ids.includes(session.id)) continue
    ids.push(session.id)
    if (ids.length >= limit) break
  }
  return ids
}

/* ─── Known Issue guard ──────────────────────────────────── */

/** Body a sidebar instance renders when the host has not published a real
 *  session id yet. OpenCode V2 scopes the `sidebar.content` slot to a session
 *  (`SlotMap["sidebar.content"] = { sessionID: string }`), so before the first
 *  prompt the slot may not mount at all — see the `home.footer.status`
 *  contribution for the pre-prompt degradation. Pure. */
export function sidebarPlaceholder(sessionID: string | undefined): string | null {
  return isValidSessionID(sessionID) ? null : SIDEBAR_WAITING_LABEL
}

/* ─── Click-through ──────────────────────────────────────── */

/** Navigate to a session through the V2 router. Fail-open: an absent router or
 *  a removed session must never break the sidebar. Returns whether a valid
 *  navigation was dispatched. Pure. */
export function navigateToSession(
  router: { navigate?: (destination: any) => void } | undefined,
  sessionID: string | undefined,
): boolean {
  if (typeof router?.navigate !== 'function' || !isValidSessionID(sessionID)) return false
  try {
    router.navigate({ type: 'session', sessionID })
    return true
  } catch {
    return false
  }
}

/* ─── Delegate-completion detection (toasts) ─────────────── */

export type DelegationCompletion = { id: string; label: string; state: DelegationState }

/** Diff two delegation observations: entries that were `running` and are no
 *  longer running count as completions, fired once per transition. Returns the
 *  next snapshot so callers can keep a single tracker. First observation never
 *  reports a completion (no toast spam on mount). Pure. */
export function detectDelegationCompletions(
  previous: ReadonlyMap<string, DelegationState>,
  current: ReadonlyArray<DelegationCompletion>,
): { completed: DelegationCompletion[]; snapshot: Map<string, DelegationState> } {
  const snapshot = new Map<string, DelegationState>()
  const completed: DelegationCompletion[] = []
  for (const entry of current) {
    snapshot.set(entry.id, entry.state)
    if (previous.get(entry.id) === 'running' && entry.state !== 'running') completed.push(entry)
  }
  return { completed, snapshot }
}

/* ─── Runtime helpers ────────────────────────────────────── */

function resolveLocation(context: any): any {
  try {
    return context?.location ?? context?.data?.location?.default()
  } catch {
    return undefined
  }
}

function resolveSidebarCwd(context: any): string {
  const location = resolveLocation(context)
  if (location && typeof location.directory === 'string' && location.directory !== '') {
    return location.directory
  }
  return process.cwd()
}

function sessionStatusOf(context: any, sessionID: string): string | undefined {
  try {
    const status = context?.data?.session?.status?.(sessionID)
    return typeof status === 'string' ? status : undefined
  } catch {
    return undefined
  }
}

/** Populate the cached data at load so the sidebar has content before the first
 *  prompt (Known Issue guard). Fire-and-forget: a missing API or a failed sync
 *  degrades silently and the sidebar still renders its static header. */
function warmUpSidebarData(context: any, location: any): void {
  try {
    void Promise.resolve(context?.data?.location?.vcs?.sync?.(location)).catch(() => {})
  } catch {
    /* vcs API unavailable */
  }
  let listed: any[] = []
  try {
    const result = context?.data?.session?.list?.()
    if (Array.isArray(result)) listed = result
  } catch {
    /* session API unavailable */
  }
  for (const id of collectWarmupTargets(listed)) {
    try {
      void Promise.resolve(context?.data?.session?.sync?.(id)).catch(() => {})
    } catch {
      /* per-session sync unavailable */
    }
  }
}

function showDelegationToast(context: any, done: DelegationCompletion): void {
  const variant =
    done.state === 'failed' ? 'error' : done.state === 'interrupted' ? 'warning' : 'success'
  const verb =
    done.state === 'failed' ? 'falhou' : done.state === 'interrupted' ? 'interrompida' : 'concluída'
  try {
    context?.ui?.toast?.show?.({
      title: TOAST_TITLE,
      message: `${done.label} ${verb}`,
      variant,
      sessionID: done.id,
    })
  } catch {
    /* toast API unavailable — the row already carries the state tone */
  }
}

/** Active preset signal with mount + 30s refresh. Shared by the sidebar and the
 *  home-screen status contribution. */
function useActivePreset(context: any): () => PresetInfo {
  const [preset, setPreset] = createSignal<PresetInfo>(presetFromEnv(process.env))
  onMount(() => {
    const cwd = resolveSidebarCwd(context)
    let cancelled = false
    const refresh = async () => {
      try {
        const info = await resolvePresetForTui(process.env, cwd)
        if (!cancelled) setPreset(info)
      } catch {
        /* transient read error — keep the last known value */
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), PRESET_REFRESH_MS)
    onCleanup(() => {
      cancelled = true
      clearInterval(timer)
    })
  })
  return preset
}

/* ─── Reactive model ─────────────────────────────────────── */

/** Reactive state the sidebar view renders. Accessors keep the view reactive
 *  while the model itself stays free of JSX, so its effects are exercisable
 *  without a TUI renderer. */
export type SidebarModel = {
  activeSessionID: Accessor<string>
  session: Accessor<any>
  branch: Accessor<string | null>
  delegations: Accessor<DelegationView[]>
  ceiling: Accessor<{ visible: DelegationView[]; hidden: number }>
  hasRunning: Accessor<boolean>
  frame: Accessor<number>
  preset: Accessor<PresetInfo>
}

/** Reactive wiring behind the sidebar: refresh subscription, warm syncs, the
 *  running-only spinner and the completion-toast effect. `context` stays loosely
 *  typed (the host API only exists at runtime) but the refresh event names are
 *  narrowed to the V2 union at the subscription site. */
export function createSidebarModel(
  context: any,
  sessionID: () => string | undefined,
): SidebarModel {
  const [revision, setRevision] = createSignal(0)
  const [frame, setFrame] = createSignal(0)
  const location = resolveLocation(context)
  const preset = useActivePreset(context)
  let observedStates = new Map<string, DelegationState>()

  const refresh = () => setRevision((value) => value + 1)
  const activeSessionID = () => {
    const id = sessionID()
    return isValidSessionID(id) ? id : ''
  }

  const session = createMemo(() => {
    revision()
    const id = activeSessionID()
    if (id === '') return undefined
    try {
      return context.data.session.get(id)
    } catch {
      /* session API unavailable */
      return undefined
    }
  })

  const branch = createMemo(() => {
    revision()
    try {
      return context.data.location.vcs.info(location)?.branch?.current ?? null
    } catch {
      /* vcs API unavailable */
      return null
    }
  })

  // Delegations = the children of the active session (native task() children),
  // enriched with each child's live status + outcome. The V2 family API returns
  // the id set; `parentID` narrows it to direct children exactly like V1.
  const allDelegations = createMemo(() => {
    revision()
    const id = activeSessionID()
    if (id === '') return []
    let family: string[] = []
    try {
      const result = context.data.session.family?.(id)
      if (Array.isArray(result)) family = result
    } catch {
      return []
    }
    const now = Date.now()
    const views: DelegationView[] = []
    for (const childID of family) {
      if (childID === id || !isValidSessionID(childID)) continue
      const child = context.data.session.get(childID)
      if (child?.parentID !== id) continue
      views.push(toDelegationView(child, sessionStatusOf(context, childID), now))
    }
    return orderDelegations(views)
  })

  // The sidebar lists in-flight work only; terminal jobs are covered by the
  // completion toast, so they are dropped from the displayed set. The full set
  // is kept for the running→terminal detection that feeds those toasts.
  const delegations = createMemo(() => allDelegations().filter((view) => view.state === 'running'))

  const ceiling = createMemo(() => ceilingDelegations(delegations(), DELEGATIONS_VISIBLE_CEILING))
  const hasRunning = createMemo(() => delegations().length > 0)

  onMount(() => {
    const stop: Array<() => void> = []
    // The event names come from the V2 union; this cast is what turns an unknown
    // name into a compile error instead of a silent no-op subscription.
    const data = context?.data as Context['data'] | undefined
    if (typeof data?.on === 'function') {
      for (const type of SIDEBAR_REFRESH_EVENTS) {
        try {
          const unsubscribe = data.on(type, refresh)
          if (typeof unsubscribe === 'function') stop.push(unsubscribe)
        } catch {
          // Sidebar stays useful with the initial cached state if an event is unavailable.
        }
      }
    }
    const id = activeSessionID()
    if (id !== '') {
      try {
        void Promise.resolve(context.data.session.sync(id)).then(refresh)
      } catch {
        /* sync unavailable */
      }
    }
    try {
      void Promise.resolve(context.data.location.vcs.sync(location)).then(refresh)
    } catch {
      /* vcs sync unavailable */
    }

    // Spinner ticks only while a job is running; terminal rows stay static. The
    // interval is armed on the running edge and cleared on the terminal one, so
    // an idle sidebar schedules no work at all.
    createEffect(() => {
      if (!hasRunning()) return
      const spinner = setInterval(() => setFrame((value) => value + 1), SPINNER_INTERVAL_MS)
      onCleanup(() => clearInterval(spinner))
    })

    onCleanup(() => {
      for (const unsubscribe of stop) {
        if (typeof unsubscribe === 'function') unsubscribe()
      }
    })
  })

  // Discrete completion toast: exactly one per running→terminal transition.
  createEffect(() => {
    const views = allDelegations()
    if (activeSessionID() === '') {
      observedStates = new Map()
      return
    }
    const { completed, snapshot } = detectDelegationCompletions(
      observedStates,
      views.map((view) => ({ id: view.id, label: view.label, state: view.state })),
    )
    observedStates = snapshot
    for (const done of completed) showDelegationToast(context, done)
  })

  return {
    activeSessionID,
    session,
    branch,
    delegations,
    ceiling,
    hasRunning,
    frame,
    preset,
  }
}

/* ─── Components ─────────────────────────────────────────── */

function Sidebar(props: { context: any; sessionID?: string }) {
  const { context } = props
  const model = createSidebarModel(context, () => props.sessionID)
  const text = () => context.theme.text?.base
  const muted = () => context.theme.text?.muted ?? text()
  const tone = (value: DelegationTone) => context.theme?.text?.feedback?.[value]?.base ?? text()
  const open = (sessionID: string) => () => navigateToSession(context.ui?.router, sessionID)

  return (
    <box flexDirection="column" width="100%" padding={1}>
      <text fg={text()} attributes={1}>{`Pantheon v${__PANTHEON_VERSION__}`}</text>
      <text fg={muted()}>OpenCode V2 · plugin TUI ativo</text>
      <Show when={model.branch()}>
        {(value) => <text fg={muted()}>{`Branch: ${value()}`}</text>}
      </Show>
      <Show
        when={model.preset().name}
        fallback={
          <box flexDirection="row">
            <text fg={muted()}>Preset: default</text>
          </box>
        }
      >
        {(name) => (
          <box flexDirection="row">
            <text fg={muted()}>{'⚡ Preset: '}</text>
            <text fg={text()}>{name()}</text>
            <text fg={muted()}>{` (${model.preset().source ?? ''})`}</text>
          </box>
        )}
      </Show>

      <Show
        when={model.activeSessionID() !== '' && model.session()}
        fallback={<text fg={muted()}>{sidebarPlaceholder(props.sessionID)}</text>}
      >
        {(current: any) => (
          <>
            <text fg={text()}>{`Sessão: ${current().title || current().id}`}</text>
            <Show when={current().agent}>
              <text fg={muted()}>{`Agente: ${current().agent}`}</text>
            </Show>
          </>
        )}
      </Show>

      <Show when={model.delegations().length > 0}>
        <text fg={text()} attributes={1}>
          Delegações
        </text>
        <For each={model.ceiling().visible}>
          {(view: DelegationView) => (
            <box onMouseDown={open(view.id)}>
              <text fg={tone(delegationStateTone(view.state))}>
                {`${delegationRowMarker(view.state, model.frame())}${view.label} ${delegationElapsed(view, Date.now())}`}
              </text>
            </box>
          )}
        </For>
        <Show when={model.ceiling().hidden > 0}>
          <text fg={muted()}>{`… +${model.ceiling().hidden} more`}</text>
        </Show>
      </Show>
    </box>
  )
}

/** Home-screen status contribution. The sidebar slot is session-scoped, so
 *  before the first prompt the sidebar may not mount at all (Known Issue) —
 *  this keeps a compact Pantheon line visible on the home footer meanwhile. */
function HomeStatus(props: { context: any }) {
  const preset = useActivePreset(props.context)
  const muted = () => props.context.theme?.text?.muted ?? props.context.theme?.text?.base
  return (
    <text
      fg={muted()}
    >{`Pantheon v${__PANTHEON_VERSION__}${preset().name ? ` ⚡ ${preset().name}` : ''}`}</text>
  )
}

/* ─── Plugin registration ────────────────────────────────── */

const plugin = Plugin.define({
  id: 'pantheon.tui',
  setup(context: Context) {
    const globalState = globalThis as unknown as Record<PropertyKey, unknown>
    if (globalState[SINGLETON]) return
    globalState[SINGLETON] = true

    const location = resolveLocation(context)
    // Eager load/sync at setup so the cache is warm before the slot's first
    // render (Known Issue: empty sidebar before the first prompt).
    warmUpSidebarData(context, location)

    const unregisterSidebar = context.ui.slot({
      append: 'sidebar.content',
      render: ({ sessionID }: { sessionID: string }) => (
        <Sidebar context={context} sessionID={sessionID} />
      ),
    })
    const unregisterHome = context.ui.slot({
      append: 'home.footer.status',
      render: () => <HomeStatus context={context} />,
    })
    return () => {
      if (typeof unregisterSidebar === 'function') unregisterSidebar()
      if (typeof unregisterHome === 'function') unregisterHome()
      delete globalState[SINGLETON]
    }
  },
})

export default plugin
