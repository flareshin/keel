import { hookCases } from "./hook-parity-corpus.ts";
import { goldenEntries, runHookParity, sandboxPaths, selectedCases } from "./hook-parity.ts";
import type { WorkerMode } from "./hook-parity.ts";

const mode = process.argv[2] as WorkerMode;
const [index, count] = process.argv.slice(3).map(Number) as [number, number];
const paths = sandboxPaths();
const corpus = hookCases(paths);
const cases = (mode === "record" ? corpus : selectedCases(corpus, paths)).filter((_testCase, position) => position % count === index);
process.stdout.write(JSON.stringify(mode === "record" ? goldenEntries(cases, paths) : runHookParity(cases, paths)));
