import type { Env } from '../server/app.js'

export const onRequest: PagesFunction<Env> = async ({ request, env, next }) => {
  if (env.AUTH_MODE !== 'password' && env.APP_ORIGIN) {
    const url = new URL(request.url)
    if (url.origin !== env.APP_ORIGIN) {
      if (request.method === 'GET' || request.method === 'HEAD') {
        const target = new URL(env.APP_ORIGIN)
        target.pathname = url.pathname
        target.search = url.search
        return Response.redirect(target.href, 302)
      }
      return Response.json({ error: '请通过正式域名进行邮箱验证后访问' }, { status: 401 })
    }
  }
  return next()
}
