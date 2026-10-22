import { pyInt } from "./pystr.ts"

const DATE_FORMAT = /^(\p{Nd}{4})-(1[0-2]|0[1-9]|[1-9])-(3[01]|[12]\p{Nd}|0[1-9]|[1-9]| [1-9])$/u
const MILLISECONDS_PER_DAY = 86_400_000

export function todayLocal(): string {
  const now = new Date()
  return formatDate(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

export function parseIsoDate(value: string): string | null {
  const match = DATE_FORMAT.exec(value)
  if (!match) return null
  const year = pyInt(match[1] as string)
  const month = pyInt(match[2] as string)
  const day = pyInt((match[3] ?? "").trim())
  const calendar = utcDate(year, month, day)
  if (year < 1 || calendar.getUTCMonth() !== month - 1) return null
  return formatDate(year, month, day)
}

export function addDays(isoDate: string, days: number): string {
  const [year = 0, month = 1, day = 1] = isoDate.split("-").map(Number)
  const shifted = new Date(utcDate(year, month, day).getTime() + days * MILLISECONDS_PER_DAY)
  return formatDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate())
}

export function utcStamp(moment: Date, compact: boolean): string {
  const iso = moment.toISOString().slice(0, 19) + "Z"
  return compact ? iso.replace(/[-:]/g, "") : iso
}

function formatDate(year: number, month: number, day: number): string {
  return [String(year).padStart(4, "0"), String(month).padStart(2, "0"), String(day).padStart(2, "0")].join("-")
}

function utcDate(year: number, month: number, day: number): Date {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return date
}
