/** DeepSeek counts Han characters twice; other Unicode characters count once. */
export function splitSpeechText(text: string, limit = 10000): string[] {
  const parts: string[] = []
  let current = '',
    count = 0
  for (const char of text) {
    const cost = /\p{Script=Han}/u.test(char) ? 2 : 1
    if (count + cost > limit) {
      parts.push(current)
      current = ''
      count = 0
    }
    current += char
    count += cost
  }
  if (current) {
    parts.push(current)
  }
  return parts
}
