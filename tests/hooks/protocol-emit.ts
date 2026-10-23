import * as protocol from "../../hooks/lib/hookkit/protocol.ts";

const [name, argumentsJson] = process.argv.slice(2);
const emit = (protocol as Record<string, unknown>)[name ?? ""] as (...args: unknown[]) => number;
process.exitCode = emit(...(JSON.parse(argumentsJson ?? "[]") as unknown[]));
