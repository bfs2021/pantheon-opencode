#!/usr/bin/env node
/**
 * vision-status.mjs — report the effective vision mode and the resolved
 * vision target WITH its origin, for the `/pantheon-vision` status step.
 *
 * Resolution is deterministic and offline, mirroring the plugin's model
 * precedence: env `PANTHEON_VISION_MODEL` > config `visionModel` (project
 * `.opencode/opencode-vision.json`, then global) > active preset `vision.model`
 * > discovery > built-in default.
 *
 * Discovery needs the live host catalog (`GET /config/providers`), which only
 * exists inside the plugin runtime. When no explicit model is configured this
 * prints `auto (resolved at session start)` rather than inventing a value; the
 * built-in default is shown separately as the fallback.
 *
 * Never prints tokens — only whether a credential source is present.
 *
 * Two extra modes support the interactive picker:
 *   --list                 enumerate image-capable candidates from the best
 *                          available source (live host catalog when supplied,
 *                          else an offline `opencode models` name heuristic),
 *                          always printing WHICH source was used.
 *   --set <provider/model> merge `visionModel` into the project (default) or
 *                          global config, reusing the installer's atomic merge.
 *
 * Usage:
 *   node scripts/vision-status.mjs [--dir <project> | --dir=<project>] [--json]
 *   node scripts/vision-status.mjs --list [--catalog <file>] [--json]
 *   node scripts/vision-status.mjs --set <provider/model> [--global|--project]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hasVision, resolveActivePreset } from '../src/pantheon/presets.mjs'
import { mergeVisionModel } from './install/vision-prompt.mjs'

const require = createRequire(import.meta.url)

const CONFIG_FILENAME = 'opencode-vision.json'
/** Built-in fallback when nothing explicit is configured and discovery finds none. */
export const DEFAULT_VISION_MODEL = 'opencode-go/mimo-v2.5'
const VISION_MODES = new Set(['native', 'tool', 'auto'])
const LEGACY_ZEN_IDS = ['opencode-go', 'opencode']
const silentLogger = { log() {}, warn() {}, error() {} }

/** Global vision config path, honoring `XDG_CONFIG_HOME` (same rule as the plugin). */
export function globalVisionConfigPath(env = process.env) {
  const home = env.HOME?.trim() || homedir()
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
  return join(xdg, 'opencode', CONFIG_FILENAME)
}

/** Active-preset candidate order — same list the plugin passes to the resolver. */
export function activePresetCandidates(dir = process.cwd(), env = process.env) {
  const home = env.HOME?.trim() || ''
  const xdg = env.XDG_CONFIG_HOME?.trim() || `${home}/.config`
  return [
    join(dir, '.pantheon', 'active-preset.json'),
    join(xdg, 'opencode', '.pantheon', 'active-preset.json'),
    join(home, '.opencode', '.pantheon', 'active-preset.json'),
  ]
}

function readVisionField(configPath, field) {
  let raw
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch {
    return null // missing/unreadable
  }
  try {
    const parsed = JSON.parse(raw)
    const value = parsed?.[field]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  } catch {
    return null // corrupted JSON → treated as absent
  }
}

/** True when a V1 auth.json entry carries a non-empty credential. */
function hasAuthCredential(entry) {
  if (!entry || typeof entry !== 'object') return false
  for (const key of ['access', 'key', 'apiKey']) {
    if (typeof entry[key] === 'string' && entry[key].trim() !== '') return true
  }
  return false
}

/**
 * OpenCode data directory, honoring `XDG_DATA_HOME` (same rule as the plugin,
 * the native vision path, and the MCP): `$XDG_DATA_HOME/opencode` when set,
 * else `~/.local/share/opencode`. Keeping the V1 `auth.json` and the V2
 * credential db on this base means a host with a relocated data root resolves
 * the same stores as every other vision consumer.
 */
function opencodeDataDir(env, home) {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share')
  return join(dataHome, 'opencode')
}

/**
 * Provider ids with an ACTIVE credential in the V2 SQLite store (the
 * `credential` table). The database is the file named by `OPENCODE_DB` when
 * set, else the default `<data dir>/opencode.db`. Best-effort and read-only: a
 * missing DB/table, a locked file, or an unavailable `node:sqlite` yields
 * `[]`. Never returns secret material — only the integration ids.
 */
function credentialDbProviderIds(home, env = process.env) {
  const override = (env.OPENCODE_DB ?? '').trim()
  const dbPath = override || join(opencodeDataDir(env, home), 'opencode.db')
  if (!existsSync(dbPath)) return []
  let sqlite
  try {
    sqlite = require('node:sqlite')
  } catch {
    return []
  }
  const DatabaseSync = sqlite?.DatabaseSync
  if (typeof DatabaseSync !== 'function') return []
  let db
  try {
    db = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true })
    const rows = db.prepare('SELECT integration_id FROM credential WHERE active = 1').all()
    const ids = []
    for (const row of rows) {
      const id = row?.integration_id
      if (typeof id === 'string' && id.trim() !== '' && !ids.includes(id)) ids.push(id)
    }
    return ids
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      // best-effort close
    }
  }
}

/**
 * Describe credential availability without exposing any secret.
 * @returns {{
 *   envKey: boolean, authStorePath: string, authStoreIds: string[],
 *   authStoreProviderIds: string[]
 * }}
 */
export function describeVisionAuth(env = process.env, home = env.HOME?.trim() || homedir()) {
  const envKey = Boolean(
    (env.PANTHEON_OPENCODE_API_KEY ?? '').trim() || (env.OPENCODE_API_KEY ?? '').trim(),
  )
  const authStorePath = join(opencodeDataDir(env, home), 'auth.json')
  let authStoreIds = []
  const authStoreProviderIds = []
  try {
    const auth = JSON.parse(readFileSync(authStorePath, 'utf8'))
    authStoreIds = LEGACY_ZEN_IDS.filter((id) => {
      const entry = auth?.[id]
      return entry && typeof entry.access === 'string' && entry.access.trim() !== ''
    })
    if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
      for (const [id, entry] of Object.entries(auth)) {
        if (hasAuthCredential(entry)) authStoreProviderIds.push(id)
      }
    }
  } catch {
    authStoreIds = []
  }
  for (const id of credentialDbProviderIds(home, env)) {
    if (!authStoreProviderIds.includes(id)) authStoreProviderIds.push(id)
  }
  return { envKey, authStorePath, authStoreIds, authStoreProviderIds }
}

/** Zen endpoints share the env keys and the legacy auth-store entries. */
function isZenProvider(providerID) {
  return providerID === 'opencode' || providerID.startsWith('opencode-go')
}

/**
 * Credential presence for a provider, mirroring the plugin's rule: Zen
 * endpoints accept the shared env keys then the auth store (the provider's own
 * entry, then the legacy `opencode-go` / `opencode` entries); non-Zen endpoints
 * accept ONLY their own auth-store entry. Returns `'env' | 'store' | null` —
 * never a token.
 */
export function visionCredentialSource(providerID, auth) {
  if (!providerID || !auth) return null
  const ids = auth.authStoreProviderIds ?? []
  if (isZenProvider(providerID)) {
    if (auth.envKey) return 'env'
    if (ids.includes(providerID)) return 'store'
    if (ids.includes('opencode-go') || ids.includes('opencode')) return 'store'
    return null
  }
  return ids.includes(providerID) ? 'store' : null
}

/**
 * Resolve mode + target + origin offline.
 * @returns {{
 *   mode: string, modeOrigin: 'env'|'config'|'default',
 *   model: string|null, origin: 'env'|'config'|'preset'|'auto', sourcePath: string|null,
 *   fallbackModel: string, auth: {envKey: boolean, authStorePath: string, authStoreIds: string[],
 *   authStoreProviderIds: string[]}
 * }}
 */
export function resolveVisionStatus({ dir = process.cwd(), env = process.env } = {}) {
  const projectConfigPath = join(dir, '.opencode', CONFIG_FILENAME)
  const globalConfigPath = globalVisionConfigPath(env)

  const envModel = (env.PANTHEON_VISION_MODEL ?? '').trim()
  const projectModel = readVisionField(projectConfigPath, 'visionModel')
  const globalModel = readVisionField(globalConfigPath, 'visionModel')

  let model = null
  let origin = 'auto'
  let sourcePath = null
  if (envModel) {
    model = envModel
    origin = 'env'
  } else if (projectModel) {
    model = projectModel
    origin = 'config'
    sourcePath = projectConfigPath
  } else if (globalModel) {
    model = globalModel
    origin = 'config'
    sourcePath = globalConfigPath
  } else {
    const preset = resolveActivePreset({
      env,
      candidates: activePresetCandidates(dir, env),
      logger: silentLogger,
    })
    const presetModel = preset?.vision?.model
    if (typeof presetModel === 'string' && presetModel.trim() !== '') {
      model = presetModel.trim()
      origin = 'preset'
    }
  }

  const envMode = (env.PANTHEON_VISION_MODE ?? '').trim()
  const projectMode = readVisionField(projectConfigPath, 'mode')
  const globalMode = readVisionField(globalConfigPath, 'mode')
  let mode = 'auto'
  let modeOrigin = 'default'
  if (VISION_MODES.has(envMode)) {
    mode = envMode
    modeOrigin = 'env'
  } else if (VISION_MODES.has(projectMode)) {
    mode = projectMode
    modeOrigin = 'config'
  } else if (VISION_MODES.has(globalMode)) {
    mode = globalMode
    modeOrigin = 'config'
  }

  return {
    mode,
    modeOrigin,
    model,
    origin,
    sourcePath,
    fallbackModel: DEFAULT_VISION_MODEL,
    auth: describeVisionAuth(env),
  }
}

function formatStatus(status) {
  const lines = ['Pantheon Vision — status', '']
  lines.push(`Mode:   ${status.mode} (origin: ${status.modeOrigin})`)
  if (status.model) {
    lines.push(`Target: ${status.model} (origin: ${status.origin})`)
    if (status.sourcePath) lines.push(`        from ${status.sourcePath}`)
  } else {
    lines.push('Target: auto (resolved at session start — host catalog discovery)')
    lines.push(`        fallback default: ${status.fallbackModel}`)
  }
  // Extended detection: env keys PLUS every provider with a credential in the
  // V1 auth.json and the V2 credential db (best-effort). A V2 host with a db
  // credential must never read as "none" here — same rule as the picker's
  // `Credential` column.
  const credentialProviders = status.auth.authStoreProviderIds ?? []
  lines.push(
    `Auth:   env key ${status.auth.envKey ? 'set' : 'not set'}` +
      `; credential store ${
        credentialProviders.length > 0 ? credentialProviders.join(', ') : 'none'
      }`,
  )
  return lines.join('\n')
}

// ─── Candidate enumeration (`--list`) ─────────────────────────────────────

/** Name-based vision families — a GUESS, used only when no catalog exists. */
const VISION_NAME_PATTERNS = [
  { label: 'vl', re: /(?:^|[/-])vl(?:[/.-]|$)/i },
  { label: 'glm-v', re: /(?:^|\/)glm-[\w.]*v/i },
  { label: 'mimo', re: /mimo/i },
  { label: 'gemini', re: /gemini/i },
  { label: 'gpt-4o/4.1/5', re: /gpt-(?:4o|4\.1|5)/i },
  { label: 'claude', re: /claude/i },
  { label: 'qwen-vl', re: /qwen.*vl/i },
]

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function visionNameMatch(model) {
  return VISION_NAME_PATTERNS.some((pattern) => pattern.re.test(model))
}

/**
 * Vision support for a model from OFFLINE knowledge. Prefers the repo's
 * CAPABILITY_TABLE (known models, `confidence: 'table'`); otherwise guesses
 * from the model name (`confidence: 'name'`). A guess, never a guarantee.
 */
export function offlineVisionFor(model) {
  try {
    return { vision: hasVision(model), confidence: 'table' }
  } catch {
    return { vision: visionNameMatch(model), confidence: 'name' }
  }
}

/**
 * Parse `opencode models` output into `provider/model` ids (one per line).
 * Ignores blank lines and lines containing whitespace.
 */
export function parseModelsOutput(text) {
  if (typeof text !== 'string') return []
  const seen = new Set()
  for (const line of text.split('\n')) {
    const model = line.trim()
    if (model === '' || !model.includes('/') || /\s/.test(model)) continue
    seen.add(model)
  }
  return [...seen]
}

/** Best-effort `opencode models`; null when the CLI is missing or fails. */
function readModelsOutput(env = process.env) {
  try {
    const result = spawnSync('opencode', ['models'], { encoding: 'utf8', timeout: 20_000, env })
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null
    return result.stdout
  } catch {
    return null
  }
}

function accessOf(costInput) {
  if (costInput === 0) return 'free'
  if (typeof costInput === 'number' && costInput > 0) return 'paid'
  return 'unknown'
}

/**
 * Flatten a `GET /config/providers` payload (canonical `{providers:[{id,
 * models:{...}}]}` or a top-level `{models:[...]}`) into image-capable,
 * non-deprecated candidates. Mirrors the plugin's discovery predicate
 * (`capabilities.input.image === true`) without importing the plugin runtime.
 */
export function catalogImageCandidates(catalog) {
  const root = asRecord(catalog)
  if (!root) return []
  const out = []
  const add = (raw, providerID) => {
    const model = asRecord(raw)
    if (!model) return
    const id = typeof model.id === 'string' && model.id.trim() !== '' ? model.id.trim() : null
    const pid =
      typeof model.providerID === 'string' && model.providerID.trim() !== ''
        ? model.providerID.trim()
        : providerID
    if (!id || !pid) return
    if (asRecord(asRecord(model.capabilities)?.input)?.image !== true) return
    if (model.status === 'deprecated') return
    const cost = asRecord(model.cost)
    const costInput =
      typeof cost?.input === 'number' && Number.isFinite(cost.input) ? cost.input : null
    out.push({ model: `${pid}/${id}`, providerID: pid, costInput, confidence: 'catalog' })
  }
  if (Array.isArray(root.providers)) {
    for (const provider of root.providers) {
      const record = asRecord(provider)
      if (!record) continue
      const pid = typeof record.id === 'string' ? record.id : ''
      const models = asRecord(record.models)
      if (!models) continue
      for (const model of Object.values(models)) add(model, pid)
    }
  }
  if (Array.isArray(root.models)) {
    for (const model of root.models) add(model, '')
  }
  return out
}

function emptyList(dir, reason) {
  return { source: 'none', reason, candidates: [], status: resolveVisionStatus({ dir }) }
}

/**
 * Enumerate image-capable candidates from the best available source:
 *   - `catalog`  — an injected/loaded `GET /config/providers` payload
 *                  (`capabilities.input.image === true`); authoritative.
 *   - `heuristic`— offline `opencode models` filtered by known vision families;
 *                  a guess, explicitly marked as such.
 *   - `none`     — nothing could be enumerated; `reason` explains why.
 *
 * @param {{dir?: string, env?: Record<string,string|undefined>, catalog?: unknown,
 *   modelsText?: string|null, runModels?: (env?: object) => string|null}} [opts]
 */
export function listVisionCandidates({
  dir = process.cwd(),
  env = process.env,
  catalog,
  modelsText,
  runModels,
} = {}) {
  const status = resolveVisionStatus({ dir, env })
  const auth = status.auth
  const hasCatalog = catalog !== undefined && catalog !== null

  let source
  let reason = null
  let raw
  if (hasCatalog) {
    source = 'catalog'
    raw = catalogImageCandidates(catalog)
    if (raw.length === 0) reason = 'host catalog has no image-capable, non-deprecated entries'
  } else {
    const text = modelsText !== undefined ? modelsText : (runModels ?? readModelsOutput)(env)
    if (typeof text === 'string') {
      source = 'heuristic'
      raw = []
      for (const model of parseModelsOutput(text)) {
        const { vision, confidence } = offlineVisionFor(model)
        if (vision) {
          raw.push({
            model,
            providerID: model.slice(0, model.indexOf('/')),
            costInput: null,
            confidence,
          })
        }
      }
      if (raw.length === 0) reason = 'no vision-family models found in `opencode models` output'
    } else {
      source = 'none'
      raw = []
      reason = '`opencode models` unavailable — cannot enumerate the host model list'
    }
  }

  const candidates = raw
    .map((candidate) => {
      const credentialSource = visionCredentialSource(candidate.providerID, auth)
      return {
        model: candidate.model,
        providerID: candidate.providerID,
        access: accessOf(candidate.costInput),
        costInput: candidate.costInput,
        credential: credentialSource !== null,
        credentialSource,
        confidence: candidate.confidence,
        target: status.model === candidate.model,
      }
    })
    .sort((left, right) => {
      const free = (entry) => (entry.access === 'free' ? 0 : 1)
      // Codepoint comparison (not localeCompare) keeps numbering stable across
      // machines/locales for the same input.
      const byName = left.model < right.model ? -1 : left.model > right.model ? 1 : 0
      return free(left) - free(right) || byName
    })

  return { source, reason, candidates, status }
}

/** Render the `--list` output: numbered, stable, with an honest source line. */
export function formatVisionList(list) {
  const lines = ['Pantheon Vision — model candidates', '']
  if (list.source === 'catalog') {
    lines.push('Source: host catalog (capabilities.input.image) — authoritative')
  } else if (list.source === 'heuristic') {
    lines.push('Source: heuristic (`opencode models` + known vision families) — NOT authoritative')
  } else {
    lines.push('Source: none')
  }
  lines.push('')

  const candidates = list.candidates ?? []
  if (candidates.length === 0) {
    lines.push(`No vision-capable models enumerated: ${list.reason ?? 'unknown reason'}`)
  } else {
    const modelWidth = Math.max(5, ...candidates.map((candidate) => candidate.model.length))
    lines.push(`  #  ${'Model'.padEnd(modelWidth)}  ${'Access'.padEnd(7)}  Credential`)
    candidates.forEach((candidate, index) => {
      const num = String(index + 1).padStart(3)
      const credential = candidate.credential ? `yes (${candidate.credentialSource})` : 'no'
      const marker = candidate.target ? '  <- current target' : ''
      lines.push(
        `  ${num}  ${candidate.model.padEnd(modelWidth)}  ${candidate.access.padEnd(7)}  ${credential}${marker}`,
      )
    })
  }

  lines.push('')
  if (list.status.model) {
    lines.push(`Target: ${list.status.model} (origin: ${list.status.origin})`)
  } else {
    lines.push('Target: auto (resolved at session start — host catalog discovery)')
  }
  lines.push(
    'Choose a number or type provider/model, then run: node scripts/vision-status.mjs --set <provider/model> [--global|--project]',
  )
  return lines.join('\n')
}

// ─── Config write (`--set`) ────────────────────────────────────────────────

/**
 * A `provider/model` id the plugin can address: non-empty, at least one slash,
 * no whitespace. Multi-slash ids (e.g. `openrouter/google/gemini-2.5-flash`)
 * are valid opencode model ids, so they are accepted here — the picker must
 * never list an unpinnable candidate.
 */
function isPinnableVisionModel(value) {
  return typeof value === 'string' && /^\S+\/\S+$/.test(value.trim())
}

/**
 * Merge `visionModel` into the project (default) or global vision config,
 * reusing the installer's atomic `mergeVisionModel` (backup, merge, corrupt
 * JSON left untouched). Never throws: a write failure is reported and the
 * target file is left intact.
 *
 * @param {string} model `provider/model`
 * @param {{dir?: string, env?: object, target?: 'project'|'global', dryRun?: boolean,
 *   beforeRecheck?: (existing: string|null) => void, configPath?: string}} [opts]
 * @returns {{ok: boolean, wrote?: boolean, reason?: string, path?: string,
 *   model?: string, error?: string, detail?: string}}
 */
export function setVisionModel(
  model,
  {
    dir = process.cwd(),
    env = process.env,
    target = 'project',
    dryRun = false,
    beforeRecheck,
    configPath,
  } = {},
) {
  const value = typeof model === 'string' ? model.trim() : ''
  if (!isPinnableVisionModel(value)) {
    return {
      ok: false,
      error: 'invalid-format',
      detail: `"${value}" is not provider/model (no spaces, at least one slash)`,
    }
  }
  const resolvedPath =
    configPath ??
    (target === 'global' ? globalVisionConfigPath(env) : join(dir, '.opencode', CONFIG_FILENAME))
  let result
  try {
    result = mergeVisionModel(value, { env, dryRun, beforeRecheck, configPath: resolvedPath })
  } catch (err) {
    return {
      ok: false,
      error: 'write-failed',
      detail: err instanceof Error ? err.message : String(err),
      path: resolvedPath,
    }
  }
  if (result.reason === 'corrupt') return { ok: false, error: 'corrupt', path: result.path }
  if (result.reason === 'conflict') return { ok: false, error: 'conflict', path: result.path }
  return { ok: true, wrote: result.wrote, reason: result.reason, path: result.path, model: value }
}

function formatSetError(result) {
  switch (result.error) {
    case 'invalid-format':
      return `Vision: not saved — ${result.detail}.`
    case 'corrupt':
      return `Vision: not saved — config at ${result.path} is not valid JSON; left untouched. Fix it and re-run.`
    case 'conflict':
      return `Vision: not saved — config at ${result.path} changed concurrently; re-run to retry.`
    default:
      return `Vision: not saved — write failed for ${result.path ?? 'config'}: ${result.detail ?? 'unknown error'}.`
  }
}

/**
 * Resolve the `--dir` value from argv, accepting BOTH `--dir <path>` and
 * `--dir=<path>` (the command spec uses the `=` form). A missing/empty value
 * falls back to the current working directory.
 */
function parseDirArg(argv) {
  const equals = argv.find((arg) => arg.startsWith('--dir='))
  if (equals) {
    const value = equals.slice('--dir='.length)
    if (value) return value
  }
  const dirFlag = argv.indexOf('--dir')
  return dirFlag !== -1 && argv[dirFlag + 1] ? argv[dirFlag + 1] : process.cwd()
}

function parseCatalogArg(argv) {
  const equals = argv.find((arg) => arg.startsWith('--catalog='))
  if (equals) return equals.slice('--catalog='.length) || null
  const dirFlag = argv.indexOf('--catalog')
  return dirFlag !== -1 && argv[dirFlag + 1] ? argv[dirFlag + 1] : null
}

function parseSetArg(argv) {
  const equals = argv.find((arg) => arg.startsWith('--set='))
  if (equals) return equals.slice('--set='.length)
  const dirFlag = argv.indexOf('--set')
  return dirFlag !== -1 && argv[dirFlag + 1] && !argv[dirFlag + 1].startsWith('--')
    ? argv[dirFlag + 1]
    : ''
}

function main(argv = process.argv.slice(2)) {
  const dir = parseDirArg(argv)
  const json = argv.includes('--json')

  const hasSet = argv.some((arg) => arg === '--set' || arg.startsWith('--set='))
  if (hasSet) {
    const model = parseSetArg(argv)
    if (!model) {
      process.stdout.write('Usage: vision-status.mjs --set <provider/model> [--global|--project]\n')
      return 1
    }
    const target = argv.includes('--global') ? 'global' : 'project'
    const result = setVisionModel(model, { dir, target })
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    else if (result.ok) {
      process.stdout.write(`Vision: pinned ${result.model} in ${result.path} (${result.reason}).\n`)
    } else process.stdout.write(`${formatSetError(result)}\n`)
    return result.ok ? 0 : 1
  }

  if (argv.includes('--list')) {
    const catalogPath = parseCatalogArg(argv)
    let list
    if (catalogPath) {
      try {
        const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
        list = listVisionCandidates({ dir, catalog })
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        list = emptyList(dir, `could not read catalog ${catalogPath}: ${detail}`)
      }
    } else {
      list = listVisionCandidates({ dir })
    }
    if (json) process.stdout.write(`${JSON.stringify(list, null, 2)}\n`)
    else process.stdout.write(`${formatVisionList(list)}\n`)
    return 0
  }

  const status = resolveVisionStatus({ dir })
  if (json) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
  else process.stdout.write(`${formatStatus(status)}\n`)
  return 0
}

// Only run when invoked directly, so tests can import the resolvers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main())
}

export { formatStatus, main, parseDirArg }
