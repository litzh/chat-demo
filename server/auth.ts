const encoder = new TextEncoder()
export const digest = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, rounds, salt, expected] = encoded.split('$')
  if (
    algorithm !== 'pbkdf2' ||
    rounds !== '100000' ||
    !/^[a-f0-9]{32}$/.test(salt ?? '') ||
    !/^[a-f0-9]{64}$/.test(expected ?? '')
  ) {
    return false
  }
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bytes = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        iterations: 100000,
        salt: Uint8Array.from(salt.match(/../g) ?? [], (x) => parseInt(x, 16)),
      },
      key,
      256
    )
  )
  const wanted = Uint8Array.from(expected.match(/../g) ?? [], (x) => parseInt(x, 16))
  return bytes.reduce((difference, byte, index) => difference | (byte ^ wanted[index]), 0) === 0
}

export function cookieToken(request: Request): string {
  return (
    request.headers.get('Cookie')?.match(/(?:^|;\s*)dsh_session=([a-f0-9-]{64,80})(?:;|$)/)?.[1] ??
    ''
  )
}

export function sessionCookie(request: Request, token: string, seconds: number): string {
  const url = new URL(request.url)
  const local =
    url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  return `dsh_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${local ? '' : '; Secure'}`
}
