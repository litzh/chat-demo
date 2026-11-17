/** Only these fields cross the sync boundary. Credentials never belong to this type. */
export type GenerationOptions = {
  model: 'deepseek-flash' | 'deepseek-v4-pro'
  thinking: boolean
  search: boolean
  readLinks: boolean
  effort: 'low' | 'high' | 'max'
  safety: 'high' | 'low'
  autoTitle: boolean
  systemPrompt: string
  sendMetadata: boolean
  maxTokens: number
  contextRounds: number
  temperature: number
  topP: number
  stopSequences: string
}

export type Preferences = GenerationOptions & {
  locale: 'zh-CN' | 'en-US'
  themePreference: 'light' | 'dark' | 'system'
  location: { region: string; province?: string; city?: string } | null
  ttsVoice: 'stella' | 'tide'
  ttsFilterMarkdown: boolean
  autoRead: boolean
  streamingRead: boolean
  documentPurpose: 'text_recognition' | 'rich_layout_recognition'
  fileExpiryHours: number
  syncInterval: number
  fontSize: number
}

export const defaults: Preferences = {
  model: 'deepseek-flash',
  thinking: false,
  search: false,
  readLinks: true,
  effort: 'high',
  safety: 'high',
  autoTitle: true,
  systemPrompt: '你是一个有帮助的助手。',
  sendMetadata: true,
  maxTokens: 0,
  contextRounds: 0,
  temperature: 1,
  topP: 1,
  stopSequences: '',
  locale: 'zh-CN',
  themePreference: 'system',
  location: null,
  ttsVoice: 'stella',
  ttsFilterMarkdown: true,
  autoRead: false,
  streamingRead: false,
  documentPurpose: 'rich_layout_recognition',
  fileExpiryHours: 0,
  syncInterval: 5,
  fontSize: 16,
}

const choices: Record<string, readonly string[]> = {
  model: ['deepseek-flash', 'deepseek-v4-pro'],
  effort: ['low', 'high', 'max'],
  safety: ['high', 'low'],
  locale: ['zh-CN', 'en-US'],
  themePreference: ['light', 'dark', 'system'],
  ttsVoice: ['stella', 'tide'],
  documentPurpose: ['text_recognition', 'rich_layout_recognition'],
}
const ranges: Record<string, [number, number]> = {
  maxTokens: [0, 393216],
  contextRounds: [0, 1000],
  temperature: [0, 2],
  topP: [0, 1],
  fileExpiryHours: [0, 720],
  syncInterval: [2, 60],
  fontSize: [12, 24],
}

export function readPreferences(value: unknown): Partial<Preferences> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('设置格式无效')
  }
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(defaults, key)) {
      throw new Error(`不支持的设置字段：${key}`)
    }
    if (key === 'location') {
      if (item === null) {
        result[key] = null
        continue
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('位置无效')
      }
      const location: Record<string, string> = {}
      for (const [field, part] of Object.entries(item)) {
        if (
          !['region', 'province', 'city'].includes(field) ||
          typeof part !== 'string' ||
          part.length > 80
        ) {
          throw new Error('位置无效')
        }
        location[field] = part
      }
      if (!location.region) {
        throw new Error('位置无效')
      }
      result[key] = location
    } else if (choices[key]) {
      if (typeof item !== 'string' || !choices[key].includes(item)) {
        throw new Error(`${key} 选项无效`)
      }
      result[key] = item
    } else if (ranges[key]) {
      const [min, max] = ranges[key]
      if (
        typeof item !== 'number' ||
        !Number.isFinite(item) ||
        item < min ||
        item > max ||
        (!['temperature', 'topP'].includes(key) && !Number.isInteger(item))
      ) {
        throw new Error(`${key} 超出范围`)
      }
      result[key] = item
    } else if (typeof defaults[key as keyof Preferences] === 'boolean') {
      if (typeof item !== 'boolean') {
        throw new Error(`${key} 必须是开关`)
      }
      result[key] = item
    } else {
      if (typeof item !== 'string' || item.length > 16000) {
        throw new Error(`${key} 文本过长`)
      }
      result[key] = item
    }
  }
  return result as Partial<Preferences>
}

export function generationOptions(settings: GenerationOptions): GenerationOptions {
  const keys: (keyof GenerationOptions)[] = [
    'model',
    'thinking',
    'search',
    'readLinks',
    'effort',
    'safety',
    'autoTitle',
    'systemPrompt',
    'sendMetadata',
    'maxTokens',
    'contextRounds',
    'temperature',
    'topP',
    'stopSequences',
  ]
  return Object.fromEntries(keys.map((key) => [key, settings[key]])) as GenerationOptions
}
