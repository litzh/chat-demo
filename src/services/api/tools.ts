import { API_ORIGIN, request } from './client.js'
import { useSettings } from '../settings.js'

/** All provider calls go from this browser directly to DeepSeek. */
export async function providerCall(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  method = body === undefined ? 'GET' : 'POST'
): Promise<unknown> {
  const key = useSettings.getState().apiKey
  if (!key) {
    throw new Error('请先在数据管理中填写本设备的 API Key')
  }
  const response = await request(`${API_ORIGIN}${path}`, {
    method,
    signal: signal ?? AbortSignal.timeout(180_000),
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  })
  if (response.headers.get('content-type')?.startsWith('audio/')) {
    return response.blob()
  }
  const result = (await response.json()) as { error?: unknown }
  if (result.error) {
    throw new Error(JSON.stringify(result.error))
  }
  return result
}
