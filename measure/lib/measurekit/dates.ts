const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/
const MILLISECONDS_PER_DAY = 86_400_000

export function todayLocal(): string {
  const now = new Date()
  return formatDate(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

export function parseIsoDate(text: string): string | null {
  const match = ISO_DATE.exec(text)
  if (!match) return null
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number]
  const calendar = utcDate(year, month, day)
  if (year < 1 || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null
  return formatDate(year, month, day)
}

export function addDays(isoDate: string, days: number): string {
  const [year = 0, month = 1, day = 1] = isoDate.split("-").map(Number)
  const shifted = new Date(utcDate(year, month, day).getTime() + days * MILLISECONDS_PER_DAY)
  return formatDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate())
}

export function utcSeconds(moment: Date): string {
  return moment.toISOString().slice(0, 19) + "Z"
}

export function compactUtcSeconds(moment: Date): string {
  return utcSeconds(moment).replace(/[-:]/g, "")
}

function formatDate(year: number, month: number, day: number): string {
  return [String(year).padStart(4, "0"), String(month).padStart(2, "0"), String(day).padStart(2, "0")].join("-")
}

function utcDate(year: number, month: number, day: number): Date {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return date
}
