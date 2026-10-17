import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { classifyNodePackageRuntime, classifyNodeSqliteProbe } from '../scripts/doctor.mjs'

const DOCTOR = fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url))

test('doctor distinguishes the package floor from the node:sqlite capability threshold', () => {
  const unsupportedPackage = classifyNodePackageRuntime('26.3.99')
  assert.equal(unsupportedPackage.status, 'unsupported')
  assert.match(unsupportedPackage.message, /requires Node\.js >= 26\.4\.0/)

  const sqliteCapability = classifyNodeSqliteProbe({ available: false, version: 'v22.4.0' })
  assert.equal(sqliteCapability.status, 'unsupported')
  assert.match(sqliteCapability.message, /node:sqlite requires Node >= 22\.5/)
  assert.doesNotMatch(sqliteCapability.message, /Pantheon requires Node/)
})

test('doctor reports separate Node policy and SQLite capability findings in text and JSON', () => {
  const target = mkdtempSync(join(tmpdir(), 'doctor-node-runtime-'))
  try {
    const json = spawnSync(
      process.execPath,
      [DOCTOR, '--json', '--target', target, '--profile', 'lite'],
      { encoding: 'utf8' },
    )
    assert.ok(json.stdout, json.stderr)
    const report = JSON.parse(json.stdout)
    const packageFinding = report.findings.find(({ code }) => code === 'node_version_supported')
    const sqliteFinding = report.findings.find(({ code }) => code === 'node_sqlite_supported')
    assert.equal(packageFinding?.classification, 'runtime')
    assert.equal(sqliteFinding?.classification, 'capability')

    const text = spawnSync(
      process.execPath,
      [DOCTOR, '--target', target, '--profile', 'lite', '--verbose'],
      { encoding: 'utf8' },
    )
    assert.match(text.stdout, /meets Pantheon's package requirement \(>= 26\.4\.0\)/)
    assert.match(text.stdout, /node:sqlite available/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
