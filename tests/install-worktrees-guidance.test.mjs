import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { getWorktreeRecommendation, printWorktreeGuidance } from '../scripts/install/cli-ui.mjs'

function captureLogs(callback) {
  const originalLog = console.log
  const lines = []
  console.log = (...values) => lines.push(values.join(' '))
  try {
    callback()
  } finally {
    console.log = originalLog
  }
  return lines.join('\n')
}

function withTTY(isTTY, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: isTTY })
  try {
    return callback()
  } finally {
    if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor)
    else delete process.stdout.isTTY
  }
}

test('worktree recommendation keeps spaced repo names distinct in an external sibling path', () => {
  const recommendation = getWorktreeRecommendation('/home/user/my project')

  assert.deepEqual(recommendation, {
    pattern: '/home/user/.pantheon-worktrees/my project/<task>',
    example: '/home/user/.pantheon-worktrees/my project/feature-name',
  })
  assert.notEqual(
    getWorktreeRecommendation('/home/user/foo bar').pattern,
    getWorktreeRecommendation('/home/user/foo-bar').pattern,
  )
})

test('interactive TTY guidance renders the default, example, and no-auto-create warning', () => {
  const output = withTTY(true, () =>
    captureLogs(() =>
      printWorktreeGuidance({ projectRoot: '/home/user/my project', interactive: true }),
    ),
  )

  assert.match(output, /Worktrees/)
  assert.match(output, /\/home\/user\/\.pantheon-worktrees\/my project\/<task>/)
  assert.match(output, /\/home\/user\/\.pantheon-worktrees\/my project\/feature-name/)
  assert.match(output, /does not create Git worktrees or directories automatically/)
})

test('interactive guidance leaves the proposed worktree location and fixture unchanged', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'pantheon-worktree-guidance-'))
  const projectRoot = join(fixture, 'My Project')
  await mkdir(projectRoot)

  try {
    const before = {
      fixture: await readdir(fixture),
      projectRoot: await readdir(projectRoot),
    }
    const proposedRoot = join(fixture, '.pantheon-worktrees', basename(projectRoot))
    const proposedWorktree = join(proposedRoot, 'feature-name')

    withTTY(true, () =>
      captureLogs(() => printWorktreeGuidance({ projectRoot, interactive: true })),
    )

    assert.deepEqual(await readdir(fixture), before.fixture)
    assert.deepEqual(await readdir(projectRoot), before.projectRoot)
    assert.equal(existsSync(proposedRoot), false)
    assert.equal(existsSync(proposedWorktree), false)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('guidance stays out of headless, dry-run, and non-TTY output', () => {
  const cases = [
    { isTTY: true, options: { interactive: false } },
    { isTTY: true, options: { interactive: true, dryRun: true } },
    { isTTY: false, options: { interactive: true } },
  ]

  for (const { isTTY, options } of cases) {
    const output = withTTY(isTTY, () => captureLogs(() => printWorktreeGuidance(options)))
    assert.equal(output, '')
  }
})
