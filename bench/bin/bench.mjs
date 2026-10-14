#!/usr/bin/env node
/**
 * bench/bin/bench.mjs — non-interactive latency baseline runner for the
 * beta-10 latency slice (Phase 0).
 *
 * WHAT IT DOES
 *   Runs the installed `opencode` CLI headlessly (`opencode run --format json
 *   --standalone`) N times per scenario, interleaved (A,B,A,B,…), one fresh
 *   sandbox directory and one private opencode.db per run, with the REPO's V2
 *   plugin (src/plugin-v2) forced via OPENCODE_CONFIG_CONTENT. After each run
 *   it reads the run's db STRICTLY READ-ONLY (same ledger as pantheon_cost)
 *   and the run's .pantheon/logs/hooks.log, aggregates tokens over the root +
 *   child sessions without double counting, and writes
 *   bench/results/baseline-<git-sha>.json after a secret scan.
 *
 * PROTOCOL (fixed; constants, no config system — YAGNI)
 *   - RUNS_PER_SCENARIO = 5, interleave A,B starting at A, same day
 *   - per-run timeout RUN_TIMEOUT_MS; a timeout is a RECORDED FAILURE, never
 *     a completed run
 *   - model pinned via BENCH_MODEL env (default below) and recorded from the
 *     db session row as ground truth
 *   - scenario A uses real web research; network variance is accepted and
 *     visible in the per-run records (controlled replay is a later phase —
 *     the per-run sandbox directories are kept under /tmp/opencode for it)
 *
 * Usage: node bench/bin/bench.mjs [--runs 5]
 *
 * @module bench/bin/bench
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, version as nodeVersion, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runIsCompleted, summarizeRuns } from '../lib/aggregate.mjs'
import { collectRunMetrics, openReadOnly } from '../lib/collector.mjs'
import { parseBenchHookLines, summarizeHookTimings } from '../lib/hooklog.mjs'
import { assertNoSecrets } from '../lib/redact.mjs'
import { resolveBenchEnv, runOnce } from '../lib/runner.mjs'

// ─── fixed protocol constants ────────────────────────────────────────────

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const RESULTS_DIR = join(REPO_ROOT, 'bench', 'results')
const RUNS_PER_SCENARIO = 5
const RUN_TIMEOUT_MS = 20 * 60_000
const DEFAULT_MODEL = 'opencode-go/glm-5.3-flash'
const PLUGIN_GENERATION = 'v2'
const PLUGIN_REF = join(REPO_ROOT, 'src', 'plugin-v2')
/**
 * Config-dir entries the bench shadow dir symlinks from the host config, so
 * the runs see the user's real injected content (AGENTS.md, agents,
 * instructions…) — the double-injection effect under study stays faithful.
 * Never linked: secrets/, plugins/, node_modules/, .venv, *.bak*.
 */
const SHADOW_LINKED_ENTRIES = [
  'AGENTS.md',
  'agents',
  'instructions',
  'commands',
  'skills',
  'prompts',
  'routing.yml',
  'skills-lock.json',
]

const SCENARIOS = {
  A: {
    name: 'multi-step (reproduces the ~2x vs Codex CLI)',
    prompt:
      'Pesquise os melhores carros elétricos de passeio do Brasil até R$150.000. ' +
      'Crie a pasta bench-run-A e monte um site comparativo simples em web moderna ' +
      '(index.html/styles.css/app.js): imagens reais, especificações técnicas e link ' +
      'do fabricante de cada carro.',
  },
  B: {
    name: 'one-shot delimitado',
    prompt:
      'Crie o arquivo bench-run-B.md contendo uma tabela markdown com os 3 países ' +
      'mais populosos do mundo e suas populações.',
  },
}

// ─── small helpers (I/O lives here; the lib/ modules stay pure) ──────────

function gitRev() {
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
  const dirty =
    execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() !==
    ''
  return { sha, dirty }
}

function opencodeVersion() {
  return execFileSync('opencode', ['--version'], { encoding: 'utf8' }).trim()
}

function readHostConfig() {
  const configDir = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  const path = join(configDir, 'opencode', 'opencode.json')
  if (!existsSync(path)) return { path, config: null }
  try {
    return { path, config: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (err) {
    console.warn(
      `bench: host config at ${path} is not valid JSON (${err.message}); proceeding without it`,
    )
    return { path, config: null }
  }
}

/**
 * Build the bench shadow config dir: host config content (AGENTS.md, agents,
 * instructions… are symlinked, never copied) with an opencode.json whose
 * `plugins` is pinned to THIS REPO's V2 plugin. A shadow dir — not a config
 * override — is required because opencode's config merge is ADDITIVE: an
 * OPENCODE_CONFIG override still loads the host's globally installed plugin,
 * and whichever copy registers first wins (plugin-once), so the instrumented
 * repo plugin could silently lose its registration.
 */
function buildShadowConfigDir(hostConfig, model, sandboxRoot) {
  const hostConfigDir = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  const hostOpencodeDir = join(hostConfigDir, 'opencode')
  // XDG_CONFIG_HOME must point at the PARENT: opencode looks for
  // <XDG_CONFIG_HOME>/opencode/opencode.json.
  const shadowHome = join(sandboxRoot, 'shadow-config')
  const shadow = join(shadowHome, 'opencode')
  mkdirSync(shadow, { recursive: true })
  for (const entry of SHADOW_LINKED_ENTRIES) {
    const source = join(hostOpencodeDir, entry)
    if (existsSync(source)) {
      try {
        symlinkSync(source, join(shadow, entry))
      } catch {
        // pre-existing link — fine
      }
    }
  }
  const base =
    hostConfig !== null && typeof hostConfig === 'object' && !Array.isArray(hostConfig)
      ? hostConfig
      : {}
  const benchConfig = { ...base, plugins: [PLUGIN_REF], model }
  writeFileSync(join(shadow, 'opencode.json'), `${JSON.stringify(benchConfig, null, 2)}\n`, 'utf8')
  return shadowHome
}

/**
 * The global opencode.db path — the metric source AND the provider-credential
 * source. Honors XDG_DATA_HOME exactly like the host CLI does.
 */
function globalDbPath() {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  return join(dataHome, 'opencode', 'opencode.db')
}

function interleavedOrder(runsPerScenario) {
  const order = []
  for (let i = 0; i < runsPerScenario; i++) {
    order.push('A', 'B')
  }
  return order
}

function toolCallsToMap(toolCalls) {
  if (toolCalls?.status !== 'ok') return toolCalls
  return Object.fromEntries(toolCalls.calls.map((c) => [c.name, c.count]))
}

function collectRunArtifacts(dbPath, runDir, sessionId) {
  const hooksLogPath = join(runDir, '.pantheon', 'logs', 'hooks.log')
  let metrics = {
    root: { status: 'unavailable', reason: 'run database not available' },
    tokens: { status: 'unavailable', reason: 'run database not available' },
    toolCalls: { status: 'unavailable', reason: 'run database not available' },
    childrenCount: null,
  }
  let rootSession = null
  if (sessionId !== null && existsSync(dbPath)) {
    let db
    try {
      db = openReadOnly(dbPath)
    } catch (err) {
      metrics = {
        ...metrics,
        tokens: { status: 'unavailable', reason: err.message },
        toolCalls: { status: 'unavailable', reason: err.message },
      }
      db = null
    }
    if (db !== null) {
      try {
        metrics = collectRunMetrics(db, sessionId)
        rootSession =
          metrics.root.status === 'ok' ? { idle_outcome: metrics.root.idle_outcome } : null
      } finally {
        db.close()
      }
    }
  } else if (sessionId === null) {
    const reason = 'no sessionID in the CLI output — the session never started'
    metrics = {
      ...metrics,
      tokens: { status: 'unavailable', reason },
      toolCalls: { status: 'unavailable', reason },
    }
  }
  const hooks = existsSync(hooksLogPath)
    ? summarizeHookTimings(parseBenchHookLines(readFileSync(hooksLogPath, 'utf8')))
    : { status: 'unavailable', reason: 'hooks.log not found in the run sandbox' }
  return { metrics, rootSession, hooks }
}

// ─── main ────────────────────────────────────────────────────────────────

function parseRunsArg(argv) {
  const index = argv.indexOf('--runs')
  if (index === -1) return RUNS_PER_SCENARIO
  const value = Number(argv[index + 1])
  if (!Number.isInteger(value) || value < 1) {
    console.error('bench: --runs must be a positive integer')
    process.exit(2)
  }
  return value
}

async function main() {
  const runsPerScenario = parseRunsArg(process.argv.slice(2))
  const model = process.env.BENCH_MODEL ?? DEFAULT_MODEL
  const startedAtIso = new Date().toISOString()
  const rev = gitRev()
  const version = opencodeVersion()
  const hostConfig = readHostConfig()

  const sandboxRoot = join(tmpdir(), 'opencode', `bench-${Date.now()}`)
  mkdirSync(sandboxRoot, { recursive: true })
  const shadowConfigDir = buildShadowConfigDir(hostConfig.config, model, sandboxRoot)
  const dbPath = globalDbPath()

  console.log(
    `bench: model=${model} runs=${runsPerScenario}/scenario timeout=${RUN_TIMEOUT_MS / 60000}min`,
  )
  console.log(
    `bench: opencode ${version} | git ${rev.sha}${rev.dirty ? ' (dirty)' : ''} | plugin ${PLUGIN_GENERATION} (${PLUGIN_REF})`,
  )
  console.log(`bench: sandbox ${sandboxRoot} | shadow config ${shadowConfigDir}`)
  console.log(`bench: metrics from ${dbPath} (read-only)`)

  const runs = []
  const order = interleavedOrder(runsPerScenario)
  let runNumber = 0
  for (const scenario of order) {
    runNumber += 1
    const label = `run-${String(runNumber).padStart(2, '0')}-${scenario}`
    const runDir = join(sandboxRoot, label)
    mkdirSync(runDir, { recursive: true })
    const env = resolveBenchEnv(process.env, { configDir: shadowConfigDir, cwd: runDir })
    const startedIso = new Date().toISOString()
    process.stdout.write(`bench: ${label} started… `)
    let outcome
    try {
      outcome = await runOnce({
        cwd: runDir,
        prompt: SCENARIOS[scenario].prompt,
        model,
        title: `pantheon-bench-${label}`,
        timeoutMs: RUN_TIMEOUT_MS,
        env,
      })
    } catch (err) {
      outcome = {
        exitCode: null,
        timedOut: false,
        wallMs: 0,
        events: [],
        sessionId: null,
        stdoutTail: '',
        stderrTail: String(err?.message ?? err),
      }
    }
    const { metrics, rootSession, hooks } = collectRunArtifacts(dbPath, runDir, outcome.sessionId)
    const completed = runIsCompleted({
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      rootSession,
    })
    let failureReason = null
    if (outcome.timedOut) failureReason = `timeout after ${RUN_TIMEOUT_MS}ms`
    else if (outcome.exitCode !== 0) failureReason = `exit code ${outcome.exitCode}`
    else if (rootSession === null)
      failureReason = 'root session not found or ended failed/interrupted'
    const record = {
      run: runNumber,
      scenario,
      scenarioName: SCENARIOS[scenario].name,
      startedAt: startedIso,
      status: completed ? 'completed' : 'failed',
      failureReason,
      wallMs: outcome.wallMs,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      sessionId: outcome.sessionId,
      modelRequested: model,
      root: metrics.root,
      childrenCount: metrics.childrenCount,
      tokens:
        metrics.tokens.status === 'ok'
          ? {
              input: metrics.tokens.input,
              output: metrics.tokens.output,
              reasoning: metrics.tokens.reasoning,
              cacheRead: metrics.tokens.cacheRead,
              cacheWrite: metrics.tokens.cacheWrite,
            }
          : metrics.tokens,
      toolCalls: toolCallsToMap(metrics.toolCalls),
      hooks,
      stderrTail: outcome.stderrTail === '' ? null : outcome.stderrTail,
    }
    runs.push(record)
    console.log(
      completed
        ? `done in ${(outcome.wallMs / 1000).toFixed(1)}s (session ${outcome.sessionId})`
        : `FAILED (${failureReason})`,
    )
  }

  const summary = summarizeRuns(runs)
  const report = {
    meta: {
      kind: 'pantheon-bench-baseline',
      reportVersion: 1,
      createdAt: startedAtIso,
      gitSha: rev.sha,
      gitDirty: rev.dirty,
      opencodeVersion: version,
      nodeVersion,
      pluginGeneration: PLUGIN_GENERATION,
      pluginRef: PLUGIN_REF,
      hostConfigPath: hostConfig.path,
      hostConfigUsed: hostConfig.config !== null,
      shadowConfigDir,
      modelRequested: model,
      sandboxRoot,
      protocol: {
        runsPerScenario,
        interleave: 'A,B starting at A',
        runTimeoutMs: RUN_TIMEOUT_MS,
        standaloneServerPerRun: true,
        permissionMode: '--auto (non-interactive auto-approve)',
        agent:
          'zeus (headless sessions default to agent=NULL, which the delegation policy denies; the TUI starts on the default agent)',
        logLevel:
          'debug (required for the V2 tool-hook registration to complete; protocol constant, equal across phases)',
        pluginSelection: 'XDG_CONFIG_HOME shadow config dir; repo plugin pinned via plugins[]',
        metricDb: dbPath,
        isolatedDbPerRun: false,
        scenarioAUsesRealWebResearch: true,
      },
    },
    scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, v.name])),
    runs,
    summary,
    schemaNotes: [
      'Tokens come from the V2 session_message ledger (assistant rows, data.tokens), the same source as pantheon_cost; cache read/write from data.tokens.cache.',
      'Child sessions resolved recursively via session_v2.parent_id with a visited set — each session counted once.',
      'Runs share the global opencode.db (provider credentials live there), but every metric is scoped by the run root sessionID and the db is opened READ-ONLY; no db writes are ever performed.',
      'Tool calls counted from assistant content parts with type=tool; only the tool NAME is read, never tool inputs.',
      'Hook timings come from the [bench] lines the V2 plugin appends to .pantheon/logs/hooks.log (instrumentation-only change).',
      'A metric the schema cannot provide is {status:"unavailable", reason} — never zero.',
    ],
  }
  assertNoSecrets(report)

  mkdirSync(RESULTS_DIR, { recursive: true })
  const resultPath = join(RESULTS_DIR, `baseline-${rev.sha}.json`)
  writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  // ── console summary table ──
  console.log(`\nbench: report → ${resultPath}`)
  for (const key of ['A', 'B']) {
    const s = summary.perScenario[key] ?? { runs: 0, completed: 0, failures: 0 }
    const wall =
      s.wallMs && s.wallMs.median !== undefined
        ? `${(s.wallMs.median / 1000).toFixed(1)}s median / ${(s.wallMs.p80 / 1000).toFixed(1)}s p80`
        : 'wall-time unavailable'
    console.log(`  ${key}: ${s.completed}/${s.runs} completed, ${s.failures} failures — ${wall}`)
  }
}

main().catch((err) => {
  console.error(`bench: fatal: ${err?.stack ?? err}`)
  process.exit(1)
})
