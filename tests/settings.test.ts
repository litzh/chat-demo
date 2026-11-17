import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaults } from '../shared/preferences.js'
const storage = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
  configurable: true,
})
Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true })
Object.defineProperty(globalThis, 'document', {
  value: { visibilityState: 'visible' },
  configurable: true,
})
const settings = await import('../src/services/settings.js')
test('unsynced preferences survive initialization and never send local credentials', async () => {
  const original = globalThis.fetch,
    bodies: Record<string, unknown>[] = []
  let shouldFail = true
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'PUT') {
      bodies.push(JSON.parse(String(init.body)))
      if (shouldFail) {
        throw new Error('offline')
      }
      return Response.json({ revision: 2 })
    }
    return Response.json({ settings: { ...defaults, temperature: 0.2 }, revision: 1 })
  }
  const dispose = settings.bindCloudSettings()
  try {
    settings.setApiKey('private-local-credential')
    settings.updatePreferences({ temperature: 0.7 })
    window.dispatchEvent(new Event('focus'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(storage.get('dsh:preferences-dirty'), 'true')
    dispose()
    shouldFail = false
    await settings.initializeCloudSettings()
    assert.equal(settings.useSettings.getState().temperature, 0.7)
    assert.equal(bodies.at(-1)?.temperature, 0.7)
    assert.equal(storage.has('dsh:preferences-dirty'), false)
    assert.ok(
      bodies.every(
        (body) =>
          !Object.hasOwn(body, 'apiKey') &&
          !JSON.stringify(body).includes('private-local-credential')
      )
    )
  } finally {
    dispose()
    globalThis.fetch = original
  }
})
