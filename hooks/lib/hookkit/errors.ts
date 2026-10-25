export class ValueError extends Error {
  override name = "ValueError";
}

export class RecursionError extends Error {
  override name = "RecursionError";
}

export class AttributeError extends Error {
  override name = "AttributeError";
}

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

export function pythonTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  return Array.isArray(value) ? "list" : "dict";
}
