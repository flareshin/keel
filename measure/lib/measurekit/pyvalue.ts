export class PyFloat {
  readonly value: number

  constructor(value: number) {
    this.value = value
  }
}

export type PyValue = null | boolean | number | bigint | string | PyFloat | PyValue[] | { [key: string]: PyValue }
export type JsonObject = { [key: string]: PyValue }

export function isJsonObject(value: PyValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof PyFloat)
}

export type PyInt = number | bigint | boolean

export function isPyInt(value: PyValue | undefined): value is PyInt {
  return typeof value === "bigint" || typeof value === "boolean" || (typeof value === "number" && Number.isInteger(value))
}

export function pyIntSign(value: PyInt): -1 | 0 | 1 {
  const exact = BigInt(value)
  return exact > 0n ? 1 : exact < 0n ? -1 : 0
}

export function pyIntText(value: PyInt): string {
  return BigInt(value).toString()
}

export function pyTruthy(value: PyValue | undefined): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === 0n || value === "") return false
  if (value instanceof PyFloat) return value.value !== 0
  if (Array.isArray(value)) return value.length > 0
  if (isJsonObject(value)) return Object.keys(value).length > 0
  return true
}

export function pyTypeName(value: PyValue | undefined): string {
  if (value === null || value === undefined) return "NoneType"
  if (typeof value === "boolean") return "bool"
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float"
  if (typeof value === "bigint") return "int"
  if (typeof value === "string") return "str"
  if (value instanceof PyFloat) return "float"
  return Array.isArray(value) ? "list" : "dict"
}

const EXPONENT_FORM = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/
const FIRST_EXPONENT_FORM_DECIMAL_POINT = -4
const LAST_PLAIN_DECIMAL_POINT = 16
const ROUNDING_TIE_SCALE = 32

export function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) return "nan"
  if (!Number.isFinite(value)) return value < 0 ? "-inf" : "inf"
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0"
  const parts = EXPONENT_FORM.exec(value.toExponential())
  if (!parts) throw new Error(`unexpected exponent form of ${value}`)
  const [, sign = "", first = "", rest = "", exponentText = "0"] = parts
  const digits = first + rest
  const exponent = Number(exponentText)
  const decimalPoint = exponent + 1
  if (decimalPoint <= FIRST_EXPONENT_FORM_DECIMAL_POINT || decimalPoint > LAST_PLAIN_DECIMAL_POINT) {
    const mantissa = rest ? `${first}.${rest}` : first
    const exponentSign = exponent < 0 ? "-" : "+"
    return `${sign}${mantissa}e${exponentSign}${String(Math.abs(exponent)).padStart(2, "0")}`
  }
  if (decimalPoint <= 0) return `${sign}0.${"0".repeat(-decimalPoint)}${digits}`
  if (decimalPoint >= digits.length) return `${sign}${digits}${"0".repeat(decimalPoint - digits.length)}.0`
  return `${sign}${digits.slice(0, decimalPoint)}.${digits.slice(decimalPoint)}`
}

export function roundToFourDecimals(value: number): number {
  const scaled = value * ROUNDING_TIE_SCALE
  const isExactTie = Number.isInteger(scaled) && Math.abs(scaled) % 2 === 1
  if (!isExactTie) return Number(value.toFixed(4))
  const lower = Math.floor(value * 10000)
  return (lower % 2 === 0 ? lower : lower + 1) / 10000
}

export function pyRepr(value: PyValue | undefined): string {
  if (value === undefined || value === null) return "None"
  if (typeof value === "boolean") return value ? "True" : "False"
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : pyFloatRepr(value)
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "string") return pyStringRepr(value)
  if (value instanceof PyFloat) return pyFloatRepr(value.value)
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`
  return `{${Object.entries(value).map(([key, item]) => `${pyStringRepr(key)}: ${pyRepr(item)}`).join(", ")}}`
}

export function pyStr(value: PyValue | undefined): string {
  return typeof value === "string" ? value : pyRepr(value)
}

const NON_PRINTABLE = /[\p{C}\p{Z}]/u

function pyStringRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'"
  let escaped = ""
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0
    if (char === quote || char === "\\") escaped += `\\${char}`
    else if (char === "\n") escaped += "\\n"
    else if (char === "\r") escaped += "\\r"
    else if (char === "\t") escaped += "\\t"
    else if (char !== " " && NON_PRINTABLE.test(char)) escaped += escapeCodePoint(codePoint)
    else escaped += char
  }
  return quote + escaped + quote
}

function escapeCodePoint(codePoint: number): string {
  if (codePoint < 0x100) return `\\x${codePoint.toString(16).padStart(2, "0")}`
  if (codePoint < 0x10000) return `\\u${codePoint.toString(16).padStart(4, "0")}`
  return `\\U${codePoint.toString(16).padStart(8, "0")}`
}
