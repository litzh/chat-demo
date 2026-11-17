import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

export type AccessEnv = {
  AUTH_MODE?: 'access' | 'password'
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  ACCESS_EMAIL?: string
  APP_ORIGIN?: string
}
const resolvers = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
export function accessConfiguration(env: AccessEnv) {
  if (
    !env.ACCESS_TEAM_DOMAIN ||
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN) ||
    !env.ACCESS_AUD ||
    !env.ACCESS_EMAIL ||
    !env.APP_ORIGIN
  ) {
    return null
  }
  try {
    const origin = new URL(env.APP_ORIGIN)
    if (origin.protocol !== 'https:' || origin.origin !== env.APP_ORIGIN) {
      return null
    }
  } catch {
    return null
  }
  return {
    issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
    audience: env.ACCESS_AUD,
    email: env.ACCESS_EMAIL.trim().toLowerCase(),
    origin: env.APP_ORIGIN,
  }
}
export async function verifyAccessAssertion(
  token: string,
  env: AccessEnv,
  resolver?: JWTVerifyGetKey
) {
  const config = accessConfiguration(env)
  if (!config || !token || token.length > 16_384) {
    return null
  }
  try {
    let keys = resolver ?? resolvers.get(config.issuer)
    if (!keys) {
      keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', config.issuer), {
        timeoutDuration: 5000,
        cooldownDuration: 30_000,
        cacheMaxAge: 600_000,
      })
      resolvers.set(config.issuer, keys as ReturnType<typeof createRemoteJWKSet>)
    }
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'email'],
      clockTolerance: 30,
    })
    if (
      typeof payload.email !== 'string' ||
      payload.email.toLowerCase() !== config.email ||
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      payload.type !== 'app'
    ) {
      return null
    }
    return { email: payload.email, subject: payload.sub }
  } catch {
    return null
  }
}
export async function authenticateAccess(request: Request, env: AccessEnv) {
  const config = accessConfiguration(env)
  if (!config || new URL(request.url).origin !== config.origin) {
    return null
  }
  // Neither the email header nor an old password cookie is proof of authentication.
  return verifyAccessAssertion(request.headers.get('Cf-Access-Jwt-Assertion') ?? '', env)
}
