#!/usr/bin/env node
/**
 * postinstall.mjs — Pantheon npm post-install hook
 *
 * Runs after `npm install` completes. Validates environment and prints
 * setup instructions. Does NOT install Pantheon platform components.
 */
import { isSupportedNodeVersion, MIN_SUPPORTED_NODE_VERSION } from './node-engine-policy.mjs'

try {
  // Validate Node.js version
  if (!isSupportedNodeVersion(process.versions.node)) {
    console.error(
      `❌ Pantheon requires Node.js >= ${MIN_SUPPORTED_NODE_VERSION} (current: ${process.versions.node})`,
    )
    process.exit(1)
  }

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
} catch (err) {
  console.error(`❌ Post-install check failed: ${err.message}`)
  process.exit(1)
}
