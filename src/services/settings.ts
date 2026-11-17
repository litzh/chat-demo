import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'
import { defaults, readPreferences, type Preferences } from '../../shared/preferences.js'
import { cloudApi, useCloud } from './cloud/client.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = Preferences & {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

export const useSettings = create<Settings>(() => ({
  ...defaults,
  ...readCachedPreferences(),
  apiKey: read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  ...readCachedPreferences(),
}))

function readCachedPreferences(): Partial<Preferences> {
  try {
    return readPreferences(JSON.parse(read('dsh:preferences') ?? '{}'))
  } catch {
    return {}
  }
}
export const getPreferences = (): Preferences => {
  const state = useSettings.getState()
  return Object.fromEntries(
    Object.keys(defaults).map((key) => [key, state[key as keyof Preferences]])
  ) as Preferences
}
export const updatePreferences = (patch: Partial<Preferences>) => {
  useSettings.setState(readPreferences(patch))
  write('dsh:preferences', JSON.stringify(getPreferences()))
}
let remoteSettings = false
let settingsRevision = 0
function applyRemotePreferences(value: unknown) {
  remoteSettings = true
  try {
    updatePreferences(readPreferences(value))
    const prefs = getPreferences()
    for (const key of ['locale', 'themePreference', 'ttsVoice', 'thinking', 'search'] as const) {
      write(KEYS[key], String(prefs[key]))
    }
    write(KEYS.location, prefs.location ? JSON.stringify(prefs.location) : null)
  } finally {
    remoteSettings = false
  }
}
export async function initializeCloudSettings() {
  const result = await cloudApi<{ settings: Preferences | null; revision: number }>('settings')
  settingsRevision = result.revision
  if (result.settings && read('dsh:preferences-dirty') !== 'true') {
    applyRemotePreferences(result.settings)
  } else {
    const saved = await cloudApi<{ revision: number }>('settings', {
      method: 'PUT',
      body: JSON.stringify(getPreferences()),
    })
    settingsRevision = saved.revision
    write('dsh:preferences-dirty', null)
  }
}
export function bindCloudSettings() {
  let timer: ReturnType<typeof setTimeout> | undefined
  let dirty = read('dsh:preferences-dirty') === 'true',
    saving = false,
    disposed = false
  let last = JSON.stringify(getPreferences())
  const save = async () => {
    if (saving || !dirty || disposed) {
      return
    }
    saving = true
    const serialized = JSON.stringify(getPreferences())
    try {
      const result = await cloudApi<{ revision: number }>('settings', {
        method: 'PUT',
        body: serialized,
      })
      settingsRevision = result.revision
      dirty = serialized !== JSON.stringify(getPreferences())
      write('dsh:preferences-dirty', dirty ? 'true' : null)
      useCloud.setState({ settingsStatus: dirty ? '等待保存' : '已同步' })
    } catch {
      useCloud.setState({ settingsStatus: '设置未同步，联网后重试' })
    } finally {
      saving = false
    }
  }
  const unsubscribe = useSettings.subscribe(() => {
    const next = JSON.stringify(getPreferences())
    if (next === last) {
      return
    }
    last = next
    write('dsh:preferences', next)
    if (remoteSettings) {
      return
    }
    dirty = true
    write('dsh:preferences-dirty', 'true')
    useCloud.setState({ settingsStatus: '等待保存' })
    clearTimeout(timer)
    timer = setTimeout(() => void save(), 500)
  })
  const refresh = async () => {
    if (disposed || document.visibilityState !== 'visible') {
      return
    }
    if (dirty) {
      await save()
      return
    }
    try {
      const result = await cloudApi<{ settings: Preferences | null; revision: number }>('settings')
      if (!dirty && result.settings && result.revision > settingsRevision) {
        settingsRevision = result.revision
        applyRemotePreferences(result.settings)
      }
    } catch {
      /* keep the local preferences when offline */
    }
  }
  const interval = setInterval(() => void refresh(), 15_000)
  const focus = () => void refresh()
  window.addEventListener('focus', focus)
  return () => {
    disposed = true
    clearInterval(interval)
    clearTimeout(timer)
    unsubscribe()
    window.removeEventListener('focus', focus)
  }
}

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
