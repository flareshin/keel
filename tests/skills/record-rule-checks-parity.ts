import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { asciiJson, tokenized } from "../recorded-cases.ts";
import { buildRuns, execute, FIXTURE_PATH, inputDigest, recordedName } from "./rule-checks-parity.ts";
import type { RecordedRuns } from "./rule-checks-parity.ts";

const PYTHON_SCRIPT = join(import.meta.dirname, "..", "..", "skills", "readable-code", "scripts", "rule-checks.py");
const [recordingRoot = ""] = process.argv.slice(2);
const root = realpathSync(dirname(recordingRoot)) + "/" + recordingRoot.split("/").pop();

const recorded: RecordedRuns = { rootLength: root.length, runs: {} };
try {
  for (const run of buildRuns(root)) {
    const observation = await execute(["python3", PYTHON_SCRIPT], run.args, "rule-checks.py");
    recorded.runs[recordedName(run, root)] = {
      input: inputDigest(run, root), status: observation.status, stdout: tokenized(observation.stdout, root), stderr: tokenized(observation.stderr, root),
    };
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
writeFileSync(FIXTURE_PATH, asciiJson(recorded) + "\n");
console.log(JSON.stringify({ recorded: Object.keys(recorded.runs).length }));
