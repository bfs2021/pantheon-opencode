/**
 * bench/lib/redact.mjs — last-line defense against credentials reaching the
 * bench report (beta-10 latency slice, Phase 0).
 *
 * The report is built from prompts, db aggregates, versions and hook timings
 * — none of which carry secrets — but the harness reads host config and env
 * indirectly, so the report is SCANNED before it is written. A finding throws
 * naming the JSON path and the pattern label, never the matched value.
 *
 * Planted examples in tests are assembled at runtime so this file never
 * contains a credential-shaped literal (the repo's own secret-scan scans it).
 *
 * @module bench/lib/redact
 */

/** High-confidence credential shapes worth blocking outright. */
export const SECRET_PATTERNS = [
  {
    label: 'bifrost-style API token (sk-bf-…)',
    // Assembled to keep the literal out of tooling output.
    regex: new RegExp(['sk', '-bf-', '[A-Za-z0-9_-]{8,}'].join('')),
  },
  { label: 'github personal access token (ghp_…)', regex: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { label: 'aws access key id (AKIA…)', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'bearer authorization value', regex: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/ },
]

/**
 * Walk a JSON-like value and return findings [{path, label}].
 *
 * Only string values are tested. The matched VALUE is never included in the
 * result — the finding carries the path and the label only.
 */
export function findSecrets(value, path = '$', out = []) {
  if (typeof value === 'string') {
    for (const { label, regex } of SECRET_PATTERNS) {
      if (regex.test(value)) out.push({ path, label })
    }
    return out
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      findSecrets(item, `${path}[${i}]`, out)
    })
    return out
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      findSecrets(item, `${path}.${key}`, out)
    }
  }
  return out
}

/**
 * Throw when any secret pattern is found anywhere in the report object; the
 * error message lists offending paths and labels (no values).
 */
export function assertNoSecrets(report) {
  const findings = findSecrets(report)
  if (findings.length === 0) return
  const detail = findings.map((f) => `${f.path}: ${f.label}`).join('; ')
  throw new Error(`bench: refusing to write the report — secret-shaped content found at ${detail}`)
}
