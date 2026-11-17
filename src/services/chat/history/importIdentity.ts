import type { Session } from '../types.js'
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonical)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)])
    )
  }
  return value
}
export const hashBytes = async (bytes: ArrayBuffer) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
export const importKey = (session: Session) =>
  hashBytes(new TextEncoder().encode('dsh-import-v1:' + JSON.stringify(canonical(session))).buffer)
