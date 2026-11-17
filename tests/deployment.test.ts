import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readCloudConfig, validateProductionConfig } from '../scripts/cloud-config.mjs'
test('public deployment placeholders cannot be published accidentally', () => {
  const { config } = readCloudConfig('wrangler.example.jsonc')
  assert.throws(() => validateProductionConfig(config))
})
test('production requires Access, valid bindings and an actual HTTPS origin', () => {
  const { config } = readCloudConfig('wrangler.example.jsonc')
  const actual = structuredClone(config)
  actual.d1_databases[0].database_id = '11111111-1111-4111-8111-111111111111'
  actual.vars = {
    AUTH_MODE: 'access',
    APP_ORIGIN: 'https://chat.example.test',
    ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com',
    ACCESS_AUD: 'a'.repeat(64),
    ACCESS_EMAIL: 'owner@example.test',
  }
  assert.doesNotThrow(() => validateProductionConfig(actual))
  for (const patch of [
    { AUTH_MODE: 'password' },
    { APP_ORIGIN: 'http://chat.example.test' },
    { ACCESS_AUD: 'placeholder' },
    { ACCESS_EMAIL: '' },
  ]) {
    assert.throws(() => validateProductionConfig({ ...actual, vars: { ...actual.vars, ...patch } }))
  }
})
