import assert from 'node:assert/strict'

const input = process.argv.slice(2).filter((arg) => arg !== '--')
if (!input[0]) {
  throw new Error('用法：pnpm smoke:cloud https://chat.example.com [https://project.pages.dev]')
}
const base = new URL(input[0]).origin
assert.equal(new URL(base).protocol, 'https:')
const checks = []
async function request(url, init = {}) {
  return fetch(url, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': 'DSH-Chat-Deployment-Check', ...init.headers },
  })
}
for (const route of [
  '/',
  '/api/sessions',
  '/api/settings',
  '/api/files/deployment-check-missing',
]) {
  const response = await request(base + route)
  assert.ok([302, 303, 307].includes(response.status), `${route} 应由 Access 拦截`)
  const target = new URL(response.headers.get('location') || '', base)
  assert.ok(target.hostname.endsWith('.cloudflareaccess.com'), '必须跳转至 Cloudflare Access')
  checks.push(`匿名访问 ${route} 已被拦截`)
}
if (input[1]) {
  const legacy = new URL(input[1]).origin
  assert.equal(new URL(legacy).protocol, 'https:')
  const response = await request(legacy)
  assert.equal(response.status, 302)
  assert.equal(new URL(response.headers.get('location')).origin, base)
  checks.push('旧域名跳转到正式站点')
  const login = await request(legacy + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: legacy, 'Content-Type': 'application/json' },
    body: '{"password":"invalid-deployment-check"}',
  })
  assert.equal(login.status, 401)
  checks.push('旧密码入口已停用')
}
process.stdout.write(JSON.stringify({ passed: checks.length, checks }, null, 2) + '\n')
