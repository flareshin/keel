import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { withNodePreload } from "../lib/node-preload.ts";

export const SLEEP_LOG_VARIABLE = "KEEL_TEST_SLEEP_LOG";

const sleepLog = process.env[SLEEP_LOG_VARIABLE];
if (sleepLog) logEverySleepTo(sleepLog);

function logEverySleepTo(path: string): void {
  const wait = Atomics.wait.bind(Atomics);
  Object.assign(Atomics, {
    wait(typedArray: Int32Array, index: number, value: number, timeout?: number) {
      appendFileSync(path, `${timeout}\n`);
      return wait(typedArray, index, value, timeout);
    },
  });
}

export function sleepLogEnv(path: string): Record<string, string> {
  return withNodePreload(new URL(import.meta.url), { [SLEEP_LOG_VARIABLE]: path });
}

export function loggedSleeps(path: string): number[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line !== "").map(Number);
}
