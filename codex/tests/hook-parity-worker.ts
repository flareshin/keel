import { hookCases } from "./hook-parity-corpus.ts";
import { runHookParity, sandboxPaths } from "./hook-parity.ts";

const [index = 0, count = 1] = process.argv.slice(2).map(Number);
const paths = sandboxPaths();
const cases = hookCases(paths).filter((_testCase, position) => position % count === index);
process.stdout.write(JSON.stringify(runHookParity(cases, paths)));
