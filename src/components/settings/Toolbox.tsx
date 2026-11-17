import { confirmAction } from '../base/ConfirmAction.js'
import { useEffect, useRef, useState } from 'react'
import { providerCall } from '../../services/api/tools.js'
import { useSettings } from '../../services/settings.js'

type Mode =
  | 'search'
  | 'fetch'
  | 'ocr'
  | 'asr'
  | 'tts'
  | 'files'
  | 'balance'
  | 'json'
  | 'fim'
  | 'functions'
  | 'raw'
const names: Record<Mode, string> = {
  search: '网页搜索',
  fetch: '阅读链接',
  ocr: 'OCR',
  asr: '音频转文字',
  tts: '语音合成',
  files: 'DeepSeek 文件管理',
  balance: '账户余额',
  json: 'JSON 输出',
  fim: 'FIM 代码补全',
  functions: 'Function Calling',
  raw: '高级 API 请求',
}
const functionsExample = JSON.stringify(
  {
    model: 'deepseek-flash',
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: '查询北京天气' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: '查询天气',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ],
  },
  null,
  2
)
const rawExample = JSON.stringify(
  { model: 'deepseek-flash', input: '你好', stream: false },
  null,
  2
)
export function Toolbox() {
  const settings = useSettings()
  const [mode, setMode] = useState<Mode>('search'),
    [text, setText] = useState(''),
    [suffix, setSuffix] = useState('')
  const [payload, setPayload] = useState(functionsExample),
    [endpoint, setEndpoint] = useState('/responses')
  const [file, setFile] = useState<File | null>(null),
    [count, setCount] = useState(5),
    [content, setContent] = useState(true)
  const [result, setResult] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [audio, setAudio] = useState('')
  const [files, setFiles] = useState<Record<string, unknown>[]>([]),
    [cursor, setCursor] = useState('')
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  useEffect(
    () => () => {
      if (audio) {
        URL.revokeObjectURL(audio)
      }
    },
    [audio]
  )
  const run = async (more = false) => {
    if (busy) {
      return
    }
    setBusy(true)
    setError('')
    setAudio('')
    const abort = new AbortController()
    controller.current = abort
    try {
      let path: string, body: unknown
      if (mode === 'search') {
        path = '/v1/tools/search'
        body = { query: text, count, need_content: content }
      } else if (mode === 'fetch') {
        path = '/v1/tools/fetch'
        body = { url: text }
      } else if (mode === 'ocr' || mode === 'asr') {
        if (!file) {
          throw new Error('请选择文件')
        }
        if (file.size > (mode === 'asr' ? 8 : 100) * 1024 * 1024) {
          throw new Error('文件超过接口大小限制')
        }
        path = `/v1/tools/${mode}`
        const form = new FormData()
        if (mode === 'ocr') {
          form.append('purpose', settings.documentPurpose)
        }
        form.append('file', file)
        body = form
      } else if (mode === 'tts') {
        path = '/v1/tools/tts'
        body = {
          text,
          voice_id: settings.ttsVoice,
          format: 'wav',
          filter_markdown: settings.ttsFilterMarkdown,
        }
      } else if (mode === 'files') {
        path = `/v1/files?limit=100${more && cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`
      } else if (mode === 'balance') {
        path = '/user/balance'
      } else if (mode === 'json') {
        path = '/chat/completions'
        body = {
          model: settings.model,
          thinking: { type: 'disabled' },
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: `${settings.systemPrompt}\n请输出合法 JSON 对象。` },
            { role: 'user', content: text },
          ],
        }
      } else if (mode === 'fim') {
        path = '/beta/completions'
        body = { model: settings.model, prompt: text, suffix, max_tokens: 4096 }
      } else {
        path = mode === 'functions' ? '/chat/completions' : endpoint
        body = JSON.parse(payload)
        if (body && typeof body === 'object') {
          Object.assign(body, { stream: false })
        }
      }
      const data = await providerCall(path, body, abort.signal)
      if (data instanceof Blob) {
        setAudio(URL.createObjectURL(data))
        setResult('音频已生成，可播放或下载。')
      } else {
        setResult(JSON.stringify(data, null, 2))
        if (mode === 'files') {
          const page = data as {
            data?: Record<string, unknown>[]
            has_more?: boolean
            last_id?: string
          }
          setFiles((previous) => (more ? [...previous, ...(page.data ?? [])] : (page.data ?? [])))
          setCursor(page.has_more ? (page.last_id ?? String(page.data?.at(-1)?.id ?? '')) : '')
        }
      }
    } catch (e) {
      setError(abort.signal.aborted ? '已停止请求' : e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      controller.current = null
    }
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([result], { type: 'application/json' })),
      link = document.createElement('a')
    link.href = url
    link.download = `${mode}-${Date.now()}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <div className="advanced-settings">
      <label className="cloud-field">
        工具
        <select
          disabled={busy}
          value={mode}
          onChange={(e) => {
            const next = e.target.value as Mode
            setMode(next)
            setResult('')
            setError('')
            setFiles([])
            setCursor('')
            setPayload(next === 'raw' ? rawExample : functionsExample)
          }}
        >
          {Object.entries(names).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <p className="cloud-hint">
        本设备直接调用 DeepSeek，按 API 计费。工具结果仅留在当前页面，可复制或下载。
      </p>
      <fieldset disabled={busy}>
        {!['ocr', 'asr', 'files', 'balance', 'functions', 'raw'].includes(mode) && (
          <label className="cloud-field">
            {mode === 'fetch' ? '网页 URL' : mode === 'fim' ? '前缀代码' : '输入内容'}
            <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        )}
        {mode === 'search' && (
          <>
            <label className="cloud-field">
              结果数
              <input
                type="number"
                min="1"
                max="50"
                value={count}
                onChange={(e) => e.target.validity.valid && setCount(Number(e.target.value))}
              />
            </label>
            <label className="cloud-toggle">
              包含页面正文
              <input
                type="checkbox"
                checked={content}
                onChange={(e) => setContent(e.target.checked)}
              />
            </label>
          </>
        )}
        {(mode === 'ocr' || mode === 'asr') && (
          <>
            <input
              aria-label="选择输入文件"
              type="file"
              accept={
                mode === 'asr'
                  ? '.wav,.ogg,audio/wav,audio/ogg'
                  : '.pdf,.doc,.docx,.ppt,.pptx,image/*'
              }
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <p className="cloud-hint">
              {mode === 'asr'
                ? 'WAV / Ogg，最长 120 秒、最大 8 MiB。整段上传后识别。'
                : '使用对话参数中的解析模式，最多 100 MiB / 1000 页。'}
            </p>
          </>
        )}
        {mode === 'fim' && (
          <label className="cloud-field">
            后缀代码
            <textarea rows={3} value={suffix} onChange={(e) => setSuffix(e.target.value)} />
          </label>
        )}
        {mode === 'raw' && (
          <label className="cloud-field">
            协议
            <select value={endpoint} onChange={(e) => setEndpoint(e.target.value)}>
              <option value="/responses">Responses</option>
              <option value="/chat/completions">Chat Completions</option>
              <option value="/anthropic/v1/messages">Messages</option>
            </select>
          </label>
        )}
        {(mode === 'functions' || mode === 'raw') && (
          <label className="cloud-field">
            请求 JSON
            <textarea
              rows={12}
              spellCheck={false}
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
            />
          </label>
        )}
        {mode === 'functions' && (
          <p className="cloud-hint">
            此工具台展示工具调用请求，不执行任意代码。收到 tool_calls 后，把 assistant 消息及相应
            role: tool、tool_call_id、content 回填 messages，再次执行即可继续。
          </p>
        )}
      </fieldset>
      <button disabled={busy} onClick={() => void run()}>
        {busy ? '处理中…' : '执行'}
      </button>
      {busy && <button onClick={() => controller.current?.abort()}>停止</button>}
      {error && <p role="alert">{error}</p>}
      {mode === 'files' &&
        files.map((file) => (
          <div className="cloud-hint" key={String(file.id)}>
            <strong>{String(file.filename ?? file.id)}</strong> ·{' '}
            {String(file.bytes ?? file.size_bytes ?? 0)} B ·{' '}
            {file.expires_at ? new Date(Number(file.expires_at) * 1000).toLocaleString() : '永久'}{' '}
            <button
              disabled={busy}
              onClick={async () => {
                if (
                  !(await confirmAction(
                    `删除 DeepSeek 文件 ${String(file.filename ?? file.id)}？引用它的对话会在下次发送时尝试重新上传。`
                  ))
                ) {
                  return
                }
                setBusy(true)
                void providerCall(
                  `/v1/files/${encodeURIComponent(String(file.id))}`,
                  undefined,
                  undefined,
                  'DELETE'
                )
                  .then(() => setFiles((previous) => previous.filter((f) => f.id !== file.id)))
                  .catch((e) => setError(String(e)))
                  .finally(() => setBusy(false))
              }}
            >
              删除
            </button>
          </div>
        ))}
      {mode === 'files' && cursor && (
        <button disabled={busy} onClick={() => void run(true)}>
          加载更多文件
        </button>
      )}
      {audio && (
        <>
          <audio src={audio} controls />
          <a href={audio} download="speech.wav">
            下载 WAV
          </a>
        </>
      )}
      {result && (
        <>
          <button
            onClick={() =>
              void navigator.clipboard
                .writeText(result)
                .catch(() => setError('复制失败，请下载结果'))
            }
          >
            复制结果
          </button>
          <button onClick={download}>下载结果</button>
          <pre className="tool-result">{result}</pre>
        </>
      )}
    </div>
  )
}
