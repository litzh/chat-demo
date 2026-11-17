import { splitSpeechText } from './textLimit.js'
import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { ApiError } from '../api/client.js'
import { classifyApiError } from '../api/errors.js'
import { synthesize, TTS_SAMPLE_RATE } from '../api/speech.js'
import { useSettings } from '../settings.js'

/**
 * 朗读：同一时间只读一条回复。
 * 请求 TTS 的裸 PCM 流，边收边用 AudioContext 按顺序排程播放，首帧到达即出声。
 * 状态：loading（已请求、未出声）→ playing → 结束回到 idle。
 */
export type ReadAloudStatus = 'idle' | 'loading' | 'playing'

type ReadAloudState = {
  /** 正在朗读的回复 id */
  messageId: string | null
  status: ReadAloudStatus
}

export const useReadAloud = create<ReadAloudState>(() => ({ messageId: null, status: 'idle' }))

/** 首帧前多缓冲一点，减少网络抖动造成的断续 */
const START_DELAY = 0.1

let current: { controller: AbortController; context: AudioContext } | null = null

const finish = (controller: AbortController) => {
  if (current?.controller !== controller) {
    return
  }
  void current.context.close()
  current = null
  useReadAloud.setState({ messageId: null, status: 'idle' })
}

/** 停止当前朗读（发送、停止生成、切换会话等场景调用） */
export const stopReadAloud = () => {
  if (current) {
    const { controller } = current
    controller.abort()
    finish(controller)
  }
}

/** 16-bit 小端 PCM 转成 Float32；奇数字节留到下一段 */
const toFloat32 = (bytes: Uint8Array) => {
  const samples = new Float32Array(bytes.length >> 1)
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000
  }
  return samples
}

export const describeReadAloudError = (error: unknown): TranslationMessage | string => {
  if (error instanceof ApiError && error.kind === 'protocol') {
    return error.message
  }
  // 400 表示这段正文服务端无法合成，与其余失败区分开
  if (error instanceof ApiError && error.status === 400) {
    return { key: 'ttsUnavailable' }
  }
  switch (classifyApiError(error)) {
    case 'unauthorized':
      return { key: 'apiKeyInvalidRetry' }
    case 'insufficientBalance':
      return { key: 'insufficientBalance' }
    case 'rateLimited':
      return { key: 'rateLimited' }
    default:
      return { key: 'ttsFailed' }
  }
}

/**
 * 开始朗读一条回复的正文；同一条正在朗读时调用等于停止。
 * 必须在点击事件中同步调用：AudioContext 需要用户手势才能出声。
 */
export const toggleReadAloud = (
  messageId: string,
  text: string,
  onError: (error: unknown) => void,
  incoming?: ReadableStream<Uint8Array>
) => {
  const reading = useReadAloud.getState().messageId
  stopReadAloud()
  if (reading === messageId) {
    return
  }
  const controller = new AbortController()
  const context =
    primed && primed.state !== 'closed' ? primed : new AudioContext({ sampleRate: TTS_SAMPLE_RATE })
  primed = null
  void context.resume().catch(() => {})
  current = { controller, context }
  useReadAloud.setState({ messageId, status: 'loading' })
  // 音色在开始朗读时读取，设置中切换后下一次朗读生效
  const { apiKey, ttsVoice } = useSettings.getState()

  void (async () => {
    let nextTime = 0
    let lastSource: AudioBufferSourceNode | null = null
    let rest = new Uint8Array(0)
    try {
      const stream = incoming ?? (await synthesize(apiKey ?? '', text, ttsVoice, controller.signal))
      const reader = stream.getReader()
      controller.signal.addEventListener('abort', () => void reader.cancel().catch(() => {}))
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        const bytes = new Uint8Array(rest.length + value.length)
        bytes.set(rest)
        bytes.set(value, rest.length)
        const samples = toFloat32(bytes)
        rest = bytes.slice(samples.length * 2)
        if (samples.length === 0) {
          continue
        }
        const buffer = context.createBuffer(1, samples.length, TTS_SAMPLE_RATE)
        buffer.copyToChannel(samples, 0)
        const source = context.createBufferSource()
        source.buffer = buffer
        source.connect(context.destination)
        // 网络慢于播放时从当前时间续上，不补播过去的时间
        nextTime = Math.max(nextTime, context.currentTime + (lastSource ? 0 : START_DELAY))
        source.start(nextTime)
        nextTime += buffer.duration
        lastSource = source
        if (useReadAloud.getState().status === 'loading') {
          useReadAloud.setState({ status: 'playing' })
        }
      }
      if (lastSource && nextTime > context.currentTime) {
        lastSource.onended = () => finish(controller)
      } else {
        finish(controller)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        finish(controller)
        onError(error)
      }
    }
  })()
}

/** Called synchronously from Send so mobile browsers can unlock audio. */
let primed: AudioContext | null = null
export function primeReadAloud() {
  if (!useSettings.getState().autoRead) {
    return
  }
  if (primed && primed.state !== 'closed') {
    return
  }
  primed = new AudioContext({ sampleRate: TTS_SAMPLE_RATE })
  void primed.resume().catch(() => {})
}

/** Browser-authenticated WebSocket: no API credential passes through our Worker. */
export function beginStreamingRead(messageId: string, onError: (error: unknown) => void) {
  let socket: WebSocket | null = null,
    previous = '',
    pending = '',
    finished = false,
    closed = false
  let sink: ReadableStreamDefaultController<Uint8Array> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const resetTimer = () => {
    clearTimeout(timer)
    timer = setTimeout(() => fail(new Error('流式朗读连接超时')), 60_000)
  }
  const fail = (error: Error) => {
    if (closed) {
      return
    }
    closed = true
    clearTimeout(timer)
    sink?.error(error)
    socket?.close()
  }
  const send = () => {
    if (socket?.readyState !== WebSocket.OPEN || closed) {
      return
    }
    if (pending && (finished || /[。！？.!?\n]/.test(pending) || pending.length >= 80)) {
      socket.send(JSON.stringify({ event: 'text', text: pending }))
      pending = ''
      resetTimer()
    }
    if (finished) {
      socket.send(JSON.stringify({ event: 'finish_text' }))
    }
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller
    },
    cancel() {
      closed = true
      clearTimeout(timer)
      socket?.close()
    },
  })
  const start = () => {
    const { apiKey, ttsVoice, ttsFilterMarkdown } = useSettings.getState()
    if (!apiKey) {
      fail(new Error('请先填写 API Key'))
      return
    }
    const url = new URL('https://api.deepseek.com/v1/tools/tts')
    url.protocol = 'wss:'
    url.search = new URLSearchParams({
      voice_id: ttsVoice,
      format: 'pcm',
      filter_markdown: String(ttsFilterMarkdown),
    }).toString()
    socket = new WebSocket(url, ['tts', `bearer.${apiKey}`])
    socket.binaryType = 'arraybuffer'
    resetTimer()
    socket.onopen = send
    socket.onmessage = (event) => {
      if (closed) {
        return
      }
      resetTimer()
      if (event.data instanceof ArrayBuffer) {
        sink?.enqueue(new Uint8Array(event.data))
      } else {
        try {
          const data = JSON.parse(String(event.data))
          if (data.event === 'finish' && data.code === 'success') {
            closed = true
            clearTimeout(timer)
            sink?.close()
            socket?.close()
          } else if (data.event === 'finish' || data.error) {
            fail(new Error(data.message ?? JSON.stringify(data)))
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error('朗读响应无效'))
        }
      }
    }
    socket.onerror = () => fail(new Error('无法连接 DeepSeek 流式语音服务'))
    socket.onclose = () => {
      if (!closed) {
        fail(new Error('流式朗读连接意外中断'))
      }
    }
    toggleReadAloud(messageId, '', onError, stream)
  }
  return {
    update(text: string) {
      if (closed || finished) {
        return
      }
      if (!text.startsWith(previous)) {
        this.stop()
        return
      }
      const chunks = splitSpeechText(text)
      const clipped = chunks[0] ?? ''
      pending += clipped.slice(previous.length)
      previous = clipped
      if (pending && !socket) {
        start()
      }
      if (chunks.length > 1) {
        finished = true
        onError(new Error('本次流式朗读达到 1 万计费字符上限，余下文字可在回答完成后手动朗读'))
      }
      send()
    },
    finish() {
      if (finished || closed) {
        return
      }
      finished = true
      if (socket) {
        send()
      } else {
        closed = true
        sink?.close()
      }
    },
    stop() {
      if (useReadAloud.getState().messageId === messageId) {
        stopReadAloud()
      }
      if (closed) {
        return
      }
      closed = true
      clearTimeout(timer)
      socket?.close()
      sink?.close()
      if (useReadAloud.getState().messageId === messageId) {
        stopReadAloud()
      }
    },
  }
}
