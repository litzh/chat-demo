import { spawn } from 'node:child_process'
import { readCloudConfig, validateProductionConfig, projectRoot } from './cloud-config.mjs'

const action = process.argv[2]
if (!['dev', 'db-local', 'db-remote', 'deploy', 'check'].includes(action)) {
  throw new Error('用法：cloud.mjs dev|db-local|db-remote|deploy|check')
}
const { config, configPath, database } = readCloudConfig()
if (['db-remote', 'deploy', 'check'].includes(action)) {
  validateProductionConfig(config)
}
const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, WRANGLER_LOG_SANITIZE: 'true' },
    })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`命令退出，状态码 ${code}`))
    )
  })
// Pages only reads the standard configuration filename from the project root.
const wrangler = (args) => run(['exec', 'wrangler', ...args])
if (action === 'dev') {
  await wrangler(['pages', 'dev', 'dist', '--port', '8788'])
} else if (action === 'db-local' || action === 'db-remote') {
  await wrangler([
    'd1',
    'migrations',
    'apply',
    database.database_name,
    action === 'db-local' ? '--local' : '--remote',
    '--config',
    configPath,
  ])
} else if (action === 'deploy') {
  await run(['build'])
  await wrangler([
    'pages',
    'deploy',
    'dist',
    '--project-name',
    config.name,
    '--branch',
    process.env.DSH_DEPLOY_BRANCH || 'main',
  ])
} else {
  process.stdout.write('部署配置校验通过（未连接 Cloudflare）\n')
}
