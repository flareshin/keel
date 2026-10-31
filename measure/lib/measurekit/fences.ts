const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

export interface FenceScan {
  fenced: boolean[]
  problems: string[]
}

interface FenceLine {
  marker: string
  length: number
  info: string
}

export function scanFences(lines: readonly string[]): FenceScan {
  const fenced: boolean[] = []
  const problems: string[] = []
  let open: (FenceLine & { line: number }) | null = null
  for (const [index, line] of lines.entries()) {
    const fence = fenceLine(line)
    fenced.push(open !== null || fence !== null)
    if (fence === null) continue
    if (open === null) open = { ...fence, line: index + 1 }
    else if (fence.marker === open.marker && fence.length >= open.length) {
      if (fence.info === "") open = null
      else problems.push(`line ${index + 1}: a fence with an info string inside the block opened at line ${open.line} does not nest; lengthen the outer fence`)
    }
  }
  if (open !== null) problems.push(`line ${open.line}: code block is never closed`)
  return { fenced, problems }
}

function fenceLine(line: string): FenceLine | null {
  const match = FENCE.exec(line)
  if (match === null) return null
  const run = match[1] as string
  const info = (match[2] as string).trim()
  const marker = run.charAt(0)
  if (marker === "`" && info.includes("`")) return null
  return { marker, length: run.length, info }
}
