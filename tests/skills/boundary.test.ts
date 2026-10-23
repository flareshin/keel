import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { splitlines } from "../../hooks/lib/hookkit/pycompat.ts";
import { Isolated, KEEL_HOME, read } from "./helpers.ts";

const TRACK_ROOTS = ["PRINCIPLES.md", "skills", "examples/skills", "tests/skills"];
const HOME_PATH = /\/(?:Users|home)\/[A-Za-z][\w.-]*/;

function trackFiles(): string[] {
  const found: string[] = [];
  const walk = (path: string): void => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.isFile()) {
      found.push(path);
      return;
    }
    for (const name of readdirSync(path).sort()) if (name !== "__pycache__") walk(join(path, name));
  };
  for (const entry of TRACK_ROOTS) walk(join(KEEL_HOME, entry));
  return found;
}

describe("boundary scan of the skills track", () => {
  let fixture: Isolated;

  beforeEach(() => {
    fixture = new Isolated();
  });

  afterEach(() => fixture.close());

  function runBoundary(cwd: string, ...args: string[]): { code: number | null; result: { hits: unknown[]; scanned: number } } {
    const scanner = fixture.env["KEEL_BOUNDARY"] || join(KEEL_HOME, "measure", "boundary");
    const completed = spawnSync(scanner, args, { cwd, encoding: "utf8", env: fixture.env });
    assert.ok([0, 1].includes(completed.status ?? -1), completed.stderr);
    return { code: completed.status, result: JSON.parse(completed.stdout) as { hits: unknown[]; scanned: number } };
  }

  it("test_trackFiles_passGenericBoundaryScan_includingThisFile", () => {
    const { code, result } = runBoundary(KEEL_HOME, "--generic-only", "--paths", ...TRACK_ROOTS);
    assert.deepEqual([code, result.hits], [0, []]);
    assert.ok(result.scanned > splitlines(read(import.meta.filename)).length);
  });

  it("test_trackFiles_holdNoHomePath", () => {
    const paths = trackFiles();
    const hits = paths.flatMap((path) => splitlines(read(path)).flatMap((line, index) => (HOME_PATH.test(line) ? [[path, index + 1]] : [])));
    assert.ok(paths.map((path) => realpathSync(path)).includes(realpathSync(import.meta.filename)));
    assert.deepEqual(hits, []);
  });
});
