import { pathToFileURL } from "node:url";

export const FROZEN_NOW_VARIABLE = "KEEL_TEST_FROZEN_NOW";

const frozenNow = process.env[FROZEN_NOW_VARIABLE];
if (frozenNow) freezeClockAt(Date.parse(frozenNow));

function freezeClockAt(moment: number): void {
  if (Number.isNaN(moment)) throw new Error(`${FROZEN_NOW_VARIABLE} is not a date: ${frozenNow}`);
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date> | []) {
      if (args.length === 0) super(moment);
      else super(...(args as ConstructorParameters<typeof Date>));
    }

    static override now(): number {
      return moment;
    }
  }
  globalThis.Date = FrozenDate as DateConstructor;
}

export function frozenClockEnv(moment: string): Record<string, string> {
  const preload = `--import=${pathToFileURL(import.meta.filename).href}`;
  const inherited = process.env["NODE_OPTIONS"];
  return { [FROZEN_NOW_VARIABLE]: moment, NODE_OPTIONS: inherited ? `${inherited} ${preload}` : preload };
}
