import tty from "node:tty"

export interface ArgparseTheme {
  readonly usage: string
  readonly prog: string
  readonly heading: string
  readonly summaryLongOption: string
  readonly summaryShortOption: string
  readonly summaryLabel: string
  readonly summaryAction: string
  readonly longOption: string
  readonly shortOption: string
  readonly label: string
  readonly action: string
  readonly reset: string
  readonly error: string
  readonly message: string
}

const RESET = "\x1b[0m"
const MAGENTA = "\x1b[35m"
const CYAN = "\x1b[36m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const BOLD_BLUE = "\x1b[1;34m"
const BOLD_MAGENTA = "\x1b[1;35m"
const BOLD_CYAN = "\x1b[1;36m"
const BOLD_GREEN = "\x1b[1;32m"
const BOLD_YELLOW = "\x1b[1;33m"

export const STDOUT_DESCRIPTOR = 1
export const STDERR_DESCRIPTOR = 2

const COLORED_THEME: ArgparseTheme = {
  usage: BOLD_BLUE,
  prog: BOLD_MAGENTA,
  heading: BOLD_BLUE,
  summaryLongOption: CYAN,
  summaryShortOption: GREEN,
  summaryLabel: YELLOW,
  summaryAction: GREEN,
  longOption: BOLD_CYAN,
  shortOption: BOLD_GREEN,
  label: BOLD_YELLOW,
  action: BOLD_GREEN,
  reset: RESET,
  error: BOLD_MAGENTA,
  message: MAGENTA,
}

const COLORLESS_THEME: ArgparseTheme = {
  usage: "",
  prog: "",
  heading: "",
  summaryLongOption: "",
  summaryShortOption: "",
  summaryLabel: "",
  summaryAction: "",
  longOption: "",
  shortOption: "",
  label: "",
  action: "",
  reset: "",
  error: "",
  message: "",
}

export function themeFor(descriptor: number): ArgparseTheme {
  return canColorize(descriptor) ? COLORED_THEME : COLORLESS_THEME
}

export function decolor(text: string, theme: ArgparseTheme): string {
  return Object.values(theme).reduce((plain, code) => (code === "" ? plain : plain.replaceAll(code, "")), text)
}

function canColorize(descriptor: number): boolean {
  const environment = process.env
  if (environment["PYTHON_COLORS"] === "0") return false
  if (environment["PYTHON_COLORS"] === "1") return true
  if (environment["NO_COLOR"]) return false
  if (environment["FORCE_COLOR"]) return true
  if (environment["TERM"] === "dumb") return false
  return tty.isatty(descriptor)
}
