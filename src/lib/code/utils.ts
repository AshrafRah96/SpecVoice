export const MAX_FILE_CHARS = 4000

export function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 512)
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true
  }
  return false
}

export function formatNumberedLines(
  lines: string[],
  totalLines: number,
  startLine = 1
): string[] {
  const width = String(totalLines).length
  return lines.map((line, i) => {
    const num = String(startLine + i).padStart(width, ' ')
    return `${num} | ${line}`
  })
}

export function buildSearchContext(lines: string[], i: number): string[] {
  return [
    ...lines.slice(Math.max(0, i - 2), i),
    ...lines.slice(i + 1, Math.min(lines.length, i + 3)),
  ]
}
