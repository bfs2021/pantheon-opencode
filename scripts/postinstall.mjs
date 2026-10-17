#!/usr/bin/env node
/**
 * postinstall.mjs — Pantheon npm post-install hook
 *
 * Runs after `npm install` completes. Validates environment and prints
 * setup instructions. Does NOT install Pantheon platform components.
 */
import { isSupportedNodeVersion, unsupportedNodeVersionMessage } from './node-engine-policy.mjs'

try {
  // npm may warn about `engines.node`, but must still finish installing so the
  // bin can print the actionable hard-gate message. No Node-dependent setup is
  // attempted from an incompatible lifecycle runtime.
  if (!isSupportedNodeVersion(process.versions.node)) {
    console.warn(
      `⚠️ Pantheon postinstall skipped because this runtime is unsupported.\n${unsupportedNodeVersionMessage(process.versions.node)}\n   Switch to Node.js >= 26.4.0 before running Pantheon setup.`,
    )
  } else {
    // Validate js-yaml is available
    try {
      await import('js-yaml')
    } catch {
      console.warn('⚠️  js-yaml not found — run `npm install` to install dependencies')
    }

    console.log('')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('  Pantheon OpenCode — npm dependencies installed ✅')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('')
    console.log('  Next steps:')
    console.log('  1. Configure Pantheon:')
    console.log('     npm run setup')
    console.log('     # or: npx pantheon-opencode init')
    console.log('  2. Verify installation:')
    console.log('     npm run doctor')
    console.log('')
  }
} catch (err) {
  console.error(`❌ Post-install check failed: ${err.message}`)
  process.exit(1)
}
