#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { validateNodeEnginePolicy } from './node-engine-policy.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const errors = validateNodeEnginePolicy(root)
if (errors.length) {
  console.error('Node engine policy validation failed:')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log('Node engine policy is consistent across manifests and lockfiles.')
}
