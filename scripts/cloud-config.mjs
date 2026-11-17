import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'jsonc-parser'

export const projectRoot = fileURLToPath(new URL('../', import.meta.url))
export function readCloudConfig(file = 'wrangler.jsonc') {
  const configPath = path.resolve(projectRoot, file)
  if (!fs.existsSync(configPath)) {
    throw new Error('请先复制 wrangler.example.jsonc 为 wrangler.jsonc，再填写本地配置')
  }
  const errors = []
  const config = parse(fs.readFileSync(configPath, 'utf8'), errors, { allowTrailingComma: true })
  if (errors.length || !config || typeof config !== 'object') {
    throw new Error('Wrangler 配置不是有效的 JSONC')
  }
  const database = config.d1_databases?.find((item) => item.binding === 'DB')
  if (!database?.database_name) {
    throw new Error('缺少 DB 绑定或 database_name')
  }
  return { config, configPath, database }
}
export function validateProductionConfig(config) {
  const vars = config.vars || {}
  const database = config.d1_databases?.find((item) => item.binding === 'DB')
  const bucket = config.r2_buckets?.find((item) => item.binding === 'FILES')
  if (
    !/^[a-z0-9][a-z0-9-]*$/.test(config.name || '') ||
    !bucket?.bucket_name ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      database?.database_id || ''
    ) ||
    database.database_id === '00000000-0000-0000-0000-000000000000'
  ) {
    throw new Error('请在 wrangler.jsonc 填写实际的 Pages 项目及 D1/R2 绑定')
  }
  let origin
  try {
    origin = new URL(vars.APP_ORIGIN)
  } catch {
    throw new Error('请配置正式 HTTPS APP_ORIGIN')
  }
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== vars.APP_ORIGIN ||
    /(^|\.)example\.(com|org|net)$/.test(origin.hostname) ||
    vars.AUTH_MODE !== 'access' ||
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(vars.ACCESS_TEAM_DOMAIN || '') ||
    vars.ACCESS_TEAM_DOMAIN === 'your-team.cloudflareaccess.com' ||
    !/^[a-f0-9]{64}$/i.test(vars.ACCESS_AUD || '') ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(vars.ACCESS_EMAIL || '') ||
    /@example\.(com|org|net)$/.test(vars.ACCESS_EMAIL)
  ) {
    throw new Error('生产部署要求完整的 Access 配置，不能使用公开模板占位值或密码模式')
  }
}
