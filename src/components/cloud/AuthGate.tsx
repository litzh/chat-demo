import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { cloudApi, loseLock, useCloud } from '../../services/cloud/client.js'
import { initializeCloudSettings } from '../../services/settings.js'
import './cloud.css'

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'loading' | 'login' | 'ready' | 'setup' | 'offline'>(
    'loading'
  )
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const authMode = useCloud((state) => state.authMode)
  const loginUrl = useCloud((state) => state.authLoginUrl)
  const initialize = async () => {
    try {
      const auth = await cloudApi<{
        authenticated: boolean
        configured: boolean
        mode: 'access' | 'password'
        loginUrl?: string
      }>('auth')
      useCloud.setState({ authMode: auth.mode, authLoginUrl: auth.loginUrl || '/' })
      if (!auth.configured) {
        setStatus('setup')
        return
      }
      if (!auth.authenticated) {
        setStatus('login')
        return
      }
      await initializeCloudSettings()
      sessionStorage.setItem('dsh:authenticated', 'true')
      setStatus('ready')
    } catch (e) {
      setError(e instanceof Error ? e.message : '连接失败')
      setStatus(useCloud.getState().authMode === 'access' ? 'login' : 'offline')
    }
  }
  useEffect(() => {
    void initialize()
    const expired = () => {
      for (const id of Object.keys(useCloud.getState().locks)) {
        loseLock(id, '登录已过期')
      }
      sessionStorage.removeItem('dsh:authenticated')
      setStatus('login')
    }
    window.addEventListener('dsh-auth-required', expired)
    return () => window.removeEventListener('dsh-auth-required', expired)
  }, [])
  const login = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await cloudApi('auth/login', { method: 'POST', body: JSON.stringify({ password }) })
      setPassword('')
      await initialize()
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }
  if (status === 'ready') {
    return children
  }
  return (
    <main className="cloud-auth">
      <div className="cloud-auth-card">
        <div className="cloud-mark">D</div>
        <h1>DSH Chat</h1>
        <p>属于你的 DeepSeek 工作空间</p>
        {status === 'loading' ? (
          <p role="status">正在连接…</p>
        ) : status === 'setup' ? (
          <p>
            {authMode === 'access'
              ? '尚未配置 Cloudflare Access，请查看部署设置。'
              : '尚未配置本地开发密码，请查看部署文档。'}
          </p>
        ) : status === 'offline' ? (
          <>
            <p role="alert">{error}</p>
            <button onClick={() => void initialize()}>重新连接</button>
            {sessionStorage.getItem('dsh:authenticated') && (
              <button onClick={() => setStatus('ready')}>只读查看本机缓存</button>
            )}
          </>
        ) : authMode === 'access' ? (
          <>
            <p>使用你的邮箱验证码登录，验证由 Cloudflare Access 完成。</p>
            {error ? <p role="alert">{error}</p> : null}
            <button className="cloud-primary" onClick={() => location.assign(loginUrl)}>
              邮箱验证登录
            </button>
            <small>DeepSeek API Key 仍仅保存在此设备。</small>
          </>
        ) : (
          <form onSubmit={(event) => void login(event)}>
            <label htmlFor="admin-password">登录密码</label>
            <input
              id="admin-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {error && (
              <p role="alert" className="cloud-error">
                {error}
              </p>
            )}
            <button className="cloud-primary" disabled={busy}>
              {busy ? '正在登录…' : '进入聊天'}
            </button>
            <small>
              登录密码用于访问同步数据。DeepSeek API Key 在登录后单独设置，仅留在此设备。
            </small>
          </form>
        )}
      </div>
    </main>
  )
}
