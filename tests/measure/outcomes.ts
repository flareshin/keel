const COLOUR_CODE = /\x1b\[[0-9;]*m/g
const USAGE_PREFIX = "usage:"

export interface RunOutcome {
  status: number | null
  stdout: string
  stderr: string
  files: Record<string, string>
}

export interface OutcomeSummary {
  status: number | null
  stdout: unknown
  usageError: boolean
  files: Record<string, unknown>
}

export function summarizeOutcome(outcome: RunOutcome): OutcomeSummary {
  return {
    status: outcome.status,
    stdout: parsedOrText(outcome.stdout),
    usageError: outcome.stderr.replace(COLOUR_CODE, "").startsWith(USAGE_PREFIX),
    files: Object.fromEntries(Object.entries(outcome.files).map(([file, text]) => [file, fileContent(file, text)])),
  }
}

function parsedOrText(stdout: string): unknown {
  const trimmed = stdout.trim()
  if (trimmed === "") return ""
  try {
    return JSON.parse(trimmed)
  } catch {
    return "text"
  }
}

function fileContent(file: string, text: string): unknown {
  if (file.endsWith(".jsonl")) return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as unknown)
  if (file.endsWith(".json")) return JSON.parse(text) as unknown
  return text
}
