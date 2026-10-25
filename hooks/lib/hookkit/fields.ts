export class FieldTypeError extends TypeError {
  override name = "FieldTypeError";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getField(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : null;
}

export function jsonTypeName(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "list";
  return typeof value === "object" ? "object" : typeof value;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

export function textOrEmpty(value: unknown, field: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  throw new FieldTypeError(`${field} must be a string, not ${jsonTypeName(value)}`);
}

export function textField(record: Record<string, unknown>, key: string): string {
  return textOrEmpty(getField(record, key), key);
}
