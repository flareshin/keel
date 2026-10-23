import { isJsonObject, PyFloat, pythonFloatRepr } from "./pyjson.ts";
import { pythonRepr } from "./pyrepr.ts";

type Pending = string | { value: unknown };

export function pythonValueStr(value: unknown): string {
  if (typeof value === "string") return value;
  const output: string[] = [];
  const pending: Pending[] = [{ value }];
  while (pending.length > 0) {
    const item = pending.pop() as Pending;
    if (typeof item === "string") output.push(item);
    else for (const step of expand(item.value)) pending.push(step);
  }
  return output.join("");
}

function expand(value: unknown): Pending[] {
  if (Array.isArray(value)) return enclose("[", "]", value.map((item) => [{ value: item }]));
  if (isJsonObject(value)) return enclose("{", "}", Object.entries(value).map(([key, item]) => [pythonRepr(key), ": ", { value: item }]));
  return [scalarRepr(value)];
}

function enclose(open: string, close: string, members: Pending[][]): Pending[] {
  const steps: Pending[] = [open];
  members.forEach((member, position) => {
    if (position > 0) steps.push(", ");
    for (const step of member) steps.push(step);
  });
  steps.push(close);
  return steps.reverse();
}

function scalarRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return pythonRepr(value);
  if (value instanceof PyFloat) return floatRepr(value.value);
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : floatRepr(value);
  return String(value);
}

function floatRepr(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  return pythonFloatRepr(value);
}
