import { useState } from 'react'
import {
  defaults,
  generationOptions,
  type Preferences,
  type GenerationOptions,
} from '../../../shared/preferences.js'
import { useSettings, updatePreferences } from '../../services/settings.js'
import { useChatStore, setSessionOptions, stopReply } from '../../services/chat/store.js'
import { canWrite, cloudApi, useCloud } from '../../services/cloud/client.js'

export function AdvancedSettings() {
  const settings = useSettings()
  const { activeId, sessionCache, streaming } = useChatStore()
  const cloud = useCloud()
  const [scope, setScope] = useState<'global' | 'session'>('global')
  const session = activeId ? sessionCache[activeId] : undefined
  const local = scope === 'session'
  const value = { ...settings, ...(local ? session?.options : {}) }
  const disabled =
    local && (!session || !canWrite(activeId) || (activeId !== null && !!streaming[activeId]))
  const change = <K extends keyof Preferences>(key: K, next: Preferences[K]) => {
    if (local && session) {
      setSessionOptions(session.id, { ...generationOptions(value), [key]: next })
    } else {
      updatePreferences({ [key]: next })
    }
  }
  const toggle = (key: keyof GenerationOptions, label: string, unavailable = false) => (
    <label className="cloud-toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={Boolean(value[key])}
        disabled={disabled || unavailable}
        onChange={(e) => change(key, e.target.checked as never)}
      />
    </label>
  )
  const number = (key: keyof GenerationOptions, label: string, max: number, step = 1) => (
    <label className="cloud-field">
      {label}
      <input
        type="number"
        min="0"
        max={max}
        step={step}
        value={value[key] as number}
        onChange={(e) => {
          if (e.target.value !== '' && e.target.validity.valid) {
            change(key, Number(e.target.value) as never)
          }
        }}
      />
    </label>
  )
  const extended =
    value.model === 'deepseek-flash' &&
    (value.search || value.readLinks || value.safety === 'high' || value.autoTitle)
  return (
    <div className="advanced-settings">
      <label className="cloud-field">
        设置范围
        <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="global">全局默认 · 同步到所有设备</option>
          <option value="session" disabled={!session}>
            当前对话 · 覆盖全局默认
          </option>
        </select>
      </label>
      <p className="cloud-hint">
        {local
          ? '覆盖值随对话保存。每次发送会保留当时的参数快照。'
          : `云端设置：${cloud.settingsStatus}。API Key 只保存在本设备。`}
      </p>
      {local && (
        <button disabled={disabled} onClick={() => session && setSessionOptions(session.id, {})}>
          恢复跟随全局默认
        </button>
      )}
      <fieldset disabled={disabled}>
        <label className="cloud-field">
          模型
          <select
            value={value.model}
            onChange={(e) => change('model', e.target.value as Preferences['model'])}
          >
            <option value="deepseek-flash">V4.1 Flash · 全家桶</option>
            <option value="deepseek-v4-pro">V4 Pro · 文本对话</option>
          </select>
        </label>
        {value.model !== 'deepseek-flash' && (
          <p className="cloud-hint">
            Pro 使用文本对话；文件、联网搜索、阅读链接、安全扩展和自动标题仅在 Flash 下发送。
          </p>
        )}
        {toggle('thinking', '深度思考')}
        <label className="cloud-field">
          思考强度
          <select
            value={value.effort}
            disabled={!value.thinking}
            onChange={(e) => change('effort', e.target.value as Preferences['effort'])}
          >
            <option value="low">低</option>
            <option value="high">高</option>
            <option value="max">最高</option>
          </select>
        </label>
        {toggle('search', '联网搜索', value.model !== 'deepseek-flash')}
        {toggle('readLinks', '自动阅读链接', value.model !== 'deepseek-flash')}
        {toggle('autoTitle', '自动生成标题', value.model !== 'deepseek-flash')}
        {toggle('sendMetadata', '向模型发送日期、语言和所选位置')}
        <label className="cloud-field">
          安全校验
          <select
            disabled={value.model !== 'deepseek-flash'}
            value={value.safety}
            onChange={(e) => change('safety', e.target.value as Preferences['safety'])}
          >
            <option value="high">高 · 开启基础风控</option>
            <option value="low">低</option>
          </select>
        </label>
        <label className="cloud-field">
          系统提示词
          <textarea
            rows={4}
            maxLength={16000}
            value={value.systemPrompt}
            onChange={(e) => change('systemPrompt', e.target.value)}
          />
        </label>
        <div className="cloud-grid">
          {number('maxTokens', '最大输出 Token（0 = API 默认）', 393216)}
          {number('contextRounds', '携带历史轮数（0 = 全部）', 1000)}
        </div>
        <p className="cloud-hint">扩展工具模式下，输出上限按每步推理计算，不是整轮费用上限。</p>
        <fieldset disabled={extended || value.thinking}>
          <div className="cloud-grid">
            {number('temperature', 'Temperature', 2, 0.1)}
            {number('topP', 'Top P', 1, 0.05)}
          </div>
          <label className="cloud-field">
            停止词（每行一个，最多 16 个）
            <textarea
              rows={2}
              value={value.stopSequences}
              onChange={(e) => change('stopSequences', e.target.value)}
            />
          </label>
        </fieldset>
        {(extended || value.thinking) && (
          <p className="cloud-hint">
            当前思考或扩展模式不应用采样参数与停止词；关闭这些功能后才会发送。
          </p>
        )}
      </fieldset>
      {!local && (
        <>
          <h3>文件与语音</h3>
          <label className="cloud-field">
            文档解析
            <select
              value={settings.documentPurpose}
              onChange={(e) =>
                change('documentPurpose', e.target.value as Preferences['documentPurpose'])
              }
            >
              <option value="rich_layout_recognition">图文混排解析</option>
              <option value="text_recognition">纯文本提取</option>
            </select>
          </label>
          <label className="cloud-field">
            DeepSeek 文件有效期（小时，0 = 永久）
            <input
              type="number"
              min="0"
              max="720"
              value={settings.fileExpiryHours}
              onChange={(e) =>
                e.target.validity.valid && change('fileExpiryHours', Number(e.target.value))
              }
            />
          </label>
          <p className="cloud-hint">
            原附件会另外保存在私有 R2 中。远端文件过期时可从原件重新上传。
          </p>
          {(['ttsFilterMarkdown', 'autoRead', 'streamingRead'] as const).map((key, i) => (
            <label className="cloud-toggle" key={key}>
              <span>
                {['朗读时过滤 Markdown', '自动朗读新回答', '边生成边朗读（WebSocket）'][i]}
              </span>
              <input
                type="checkbox"
                checked={settings[key]}
                onChange={(e) => change(key, e.target.checked)}
              />
            </label>
          ))}
          <p className="cloud-hint">手机浏览器可能需要先手动播放一次才能自动朗读。</p>
          <div className="cloud-grid">
            <label className="cloud-field">
              同步检查间隔（秒）
              <input
                type="number"
                min="2"
                max="60"
                value={settings.syncInterval}
                onChange={(e) =>
                  e.target.validity.valid && change('syncInterval', Number(e.target.value))
                }
              />
            </label>
            <label className="cloud-field">
              正文字号
              <input
                type="number"
                min="12"
                max="24"
                value={settings.fontSize}
                onChange={(e) =>
                  e.target.validity.valid && change('fontSize', Number(e.target.value))
                }
              />
            </label>
          </div>
          <button onClick={() => updatePreferences(defaults)}>恢复默认设置</button>
          <button
            onClick={() => {
              for (const id of Object.keys(useChatStore.getState().streaming)) {
                stopReply(id)
              }
              void cloudApi<{ logoutUrl?: string }>('auth/logout', { method: 'POST' }).then(
                (result) => {
                  sessionStorage.removeItem('dsh:authenticated')
                  if (result.logoutUrl) {
                    location.assign(result.logoutUrl)
                  } else {
                    location.reload()
                  }
                }
              )
            }}
          >
            退出登录
          </button>
        </>
      )}
    </div>
  )
}
