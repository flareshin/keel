import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { isTestPath as riskIsTestPath, TEST_BASENAME_GLOBS as riskTestBasenameGlobs, TEST_SEGMENTS as riskTestSegments } from "../../lib/evidence/risk.ts";
import { foldDottedAndDotlessI as hookkitFold } from "../../hooks/lib/hookkit/pycompat.ts";
import { foldDottedAndDotlessI, isTestPath, TEST_BASENAME_GLOBS, TEST_SEGMENTS } from "../../skills/readable-code/scripts/rule-checks.ts";
import { Isolated, KEEL_HOME, RULE_CHECKS } from "./helpers.ts";

const ANY_LINE = "const v: any = 1\n";
const CLEAN_LINE = "export const v = 1\n";
const SIGNAL_LINE = /^signal K5\.(?:[1-9]|1[0-6]) \S+ .{1,160}$/;

function signalSet(...pairs: Array<[string, string]>): Set<string> {
  return new Set(pairs.map(([id, where]) => `${id} ${where}`));
}

describe("rule-checks standalone copy of the dotted-I fold", () => {
  it("maps U+0130 and U+0131 to i and agrees with the hookkit helper it stands in for", () => {
    assert.equal(foldDottedAndDotlessI("\u0130\u0131x\u00e9"), "iix\u00e9");
    for (const text of ["", "plain", "\u0130NDEX", "\u0131", "mix\u0130\u0131ed", "\ud83d\ude00\u0130", "TEST\u0130"]) {
      assert.equal(foldDottedAndDotlessI(text), hookkitFold(text), text);
    }
  });
});

describe("rule-checks CLI", () => {
  let fixture: Isolated;

  beforeEach(() => {
    fixture = new Isolated();
  });

  afterEach(() => fixture.close());

  function baseRepo(name = "repo"): string {
    const repo = fixture.newRepo(name);
    fixture.write(repo, "README", "x\n");
    fixture.commitAll(repo);
    fixture.git(repo, ["branch", "base"]);
    return repo;
  }

  function divergedRepo(): string {
    const repo = fixture.newRepo("diverged");
    fixture.write(repo, "z.ts", ANY_LINE);
    fixture.commitAll(repo);
    fixture.git(repo, ["branch", "base"]);
    fixture.git(repo, ["checkout", "-q", "base"]);
    fixture.write(repo, "z.ts", CLEAN_LINE);
    fixture.commitAll(repo);
    fixture.git(repo, ["checkout", "-q", "main"]);
    fixture.write(repo, "a.ts", ANY_LINE);
    fixture.commitAll(repo);
    return repo;
  }

  it("test_selfTest_passes", () => {
    const completed = spawnSync(process.execPath, [RULE_CHECKS, "--self-test"], { encoding: "utf8", env: fixture.env });
    assert.equal(completed.status, 0, completed.stdout);
    assert.match(completed.stdout, /self-test: (\d+)\/\1 pass/);
  });

  it("test_ruleChecks_exitsTwo_whenRepoOrBaseMissing", () => {
    const completed = spawnSync(process.execPath, [RULE_CHECKS, "--base", "main"], { encoding: "utf8", env: fixture.env });
    assert.equal(completed.status, 2);
  });

  it("test_ruleChecks_reportsK5Signals_forWorkingTreeAndUntrackedLines", () => {
    const repo = baseRepo();
    fixture.write(repo, "web/a.ts", ANY_LINE);
    fixture.write(repo, "core/Service.java", "class S { void f() { try { run(); } catch (Exception e) {} } }\n" +
      "Map<String, Object> m = null;\n// TODO clean this\nString data = x;\n");
    fixture.git(repo, ["add", "core/Service.java"]);

    const run = fixture.runRuleChecks("--repo", repo, "--base", "base");

    assert.equal(run.code, 0);
    assert.deepEqual(run.signals, signalSet(["K5.11", "web/a.ts:1"], ["K5.12", "core/Service.java:1"], ["K5.11", "core/Service.java:2"],
      ["K5.14", "core/Service.java:3"], ["K5.5", "core/Service.java:4"]));
    assert.equal(run.summary, "summary repos=1 scanned_lines=5 signals=5 unscanned=none blocked=none");
    for (const line of run.lines.slice(0, -1)) assert.match(line, SIGNAL_LINE);
  });

  it("test_ruleChecks_reportsSuppressionSignals_forTsDirectiveAndExhaustiveDepsDisable", () => {
    const repo = baseRepo();
    fixture.write(repo, "web/a.ts", "// @ts-ignore\nconst v = f(x)\n");
    fixture.write(repo, "web/Panel.jsx", "useEffect(() => load(id), [])  // eslint-disable-line react-hooks/exhaustive-deps\n");

    const run = fixture.runRuleChecks("--repo", repo, "--base", "base");

    assert.equal(run.code, 0);
    assert.deepEqual(run.signals, signalSet(["K5.11", "web/a.ts:1"], ["K5.9", "web/Panel.jsx:1"]));
    assert.equal(run.summary, "summary repos=1 scanned_lines=3 signals=2 unscanned=none blocked=none");
    for (const line of run.lines.slice(0, -1)) assert.match(line, SIGNAL_LINE);
  });

  it("test_ruleChecks_reportsNoSignal_forCleanDiff", () => {
    const repo = baseRepo();
    fixture.write(repo, "web/a.ts", CLEAN_LINE);
    const run = fixture.runRuleChecks("--repo", repo, "--base", "base");
    assert.equal(run.code, 0);
    assert.deepEqual(run.signals, new Set());
    assert.equal(run.summary, "summary repos=1 scanned_lines=1 signals=0 unscanned=none blocked=none");
  });

  it("test_ruleChecks_blocksWithExitTwo_whenBaseUnknown", () => {
    const repo = baseRepo();
    const run = fixture.runRuleChecks("--repo", repo, "--base", "no-such-ref");
    assert.equal(run.code, 2);
    assert.deepEqual(run.signals, new Set());
    assert.ok(run.summary.endsWith("blocked=."), run.summary);
  });

  it("test_ruleChecks_scansFromMergeBase_whenHeadIsCommit", () => {
    const repo = divergedRepo();
    fixture.write(repo, "later.ts", ANY_LINE);
    const run = fixture.runRuleChecks("--repo", repo, "--base", "base", "--head", "HEAD");
    assert.equal(run.code, 0);
    assert.deepEqual(run.signals, signalSet(["K5.11", "a.ts:1"]));
  });

  it("test_ruleChecks_scansFromBaseAsGiven_whenHeadIsSnapshotTree", () => {
    const repo = divergedRepo();
    fixture.write(repo, "snap.ts", ANY_LINE);
    const tree = fixture.snapshotTree(repo);
    fixture.write(repo, "after-snapshot.ts", ANY_LINE);
    const reviewBase = fixture.git(repo, ["rev-parse", "base"]);

    const run = fixture.runRuleChecks("--repo", repo, "--base", reviewBase, "--head", tree);

    assert.equal(run.code, 0);
    assert.deepEqual(run.signals, signalSet(["K5.11", "a.ts:1"], ["K5.11", "snap.ts:1"], ["K5.11", "z.ts:1"]));
    assert.equal(fixture.git(repo, ["status", "--porcelain"]), "?? after-snapshot.ts\n?? snap.ts", "the real index stays untouched");
  });

  it("test_ruleChecks_blocksWithExitTwo_whenSnapshotBaseUnknown", () => {
    const repo = baseRepo();
    fixture.write(repo, "a.ts", ANY_LINE);
    const tree = fixture.snapshotTree(repo);
    const run = fixture.runRuleChecks("--repo", repo, "--base", "no-such-ref", "--head", tree);
    assert.equal(run.code, 2);
    assert.ok(run.summary.endsWith("blocked=."), run.summary);
  });

  it("test_ruleChecks_ignoresExternalDiffAndTextconv_whenRepoConfiguresThem", () => {
    const repo = baseRepo();
    fixture.git(repo, ["config", "diff.external", "/usr/bin/true"]);
    fixture.git(repo, ["config", "diff.strip.textconv", "sed s/any/ANY/"]);
    fixture.write(repo, ".git/info/attributes", "*.ts diff=strip\n");
    fixture.write(repo, "a.ts", ANY_LINE);
    fixture.commitAll(repo);
    const run = fixture.runRuleChecks("--repo", repo, "--base", "base", "--head", "HEAD");
    assert.deepEqual(run.signals, signalSet(["K5.11", "a.ts:1"]));
  });

  it("test_ruleChecks_signalsDiffSize_whenChangedLinesExceedSignalCountingRemovals", () => {
    const repo = fixture.newRepo("rewrite");
    const numbered = (prefix: string, count: number): string => Array.from({ length: count }, (_unused, index) => `${prefix} ${index}\n`).join("");
    fixture.write(repo, "notes.md", numbered("old", 300));
    fixture.commitAll(repo);
    fixture.git(repo, ["branch", "base"]);
    fixture.write(repo, "notes.md", numbered("old", 50) + numbered("new", 200));
    fixture.commitAll(repo);
    const run = fixture.runRuleChecks("--repo", repo, "--base", "base", "--head", "HEAD");
    assert.deepEqual(run.signals, signalSet(["K5.7", "(diff)"]));
  });

  it("test_ruleChecks_skipsDiffSize_forTestAndGeneratedFiles", () => {
    const repo = baseRepo();
    fixture.write(repo, "web/big.test.ts", "x\n".repeat(450));
    fixture.write(repo, "package-lock.json", "{}\n".repeat(450));
    fixture.write(repo, "src/test/AppTest.java", "x\n".repeat(450));
    const run = fixture.runRuleChecks("--repo", repo, "--base", "base");
    assert.deepEqual(run.signals, new Set());
  });

  it("test_ruleChecks_skipsDiffSizeAndLineSignals_forPythonAndSuffixTestFiles", () => {
    const repo = baseRepo();
    fixture.write(repo, "tests/test_feature.py", "x = 1\n".repeat(450));
    fixture.write(repo, "web/util_test.ts", "const data = load()\n");
    const run = fixture.runRuleChecks("--repo", repo, "--base", "base");
    assert.equal(run.code, 0);
    assert.deepEqual(run.signals, new Set());
  });

  it("test_ruleChecks_scansWithExitZero_whenChangedFileIsNotUtf8", () => {
    const repo = baseRepo();
    writeFileSync(join(repo, "messages.properties"), Buffer.from("greeting=caf\xe9\n", "latin1"));
    fixture.commitAll(repo);
    const run = fixture.runRuleChecks("--repo", repo, "--base", "base", "--head", "HEAD");
    assert.equal(run.code, 0);
    assert.equal(run.summary, "summary repos=1 scanned_lines=1 signals=0 unscanned=none blocked=none");
  });

  it("test_ruleChecks_signalsFileSize_onlyWhenDiffCrossesSignal", () => {
    const repo = fixture.newRepo("sizes");
    fixture.write(repo, "web/Big.tsx", "x\n".repeat(290));
    fixture.write(repo, "web/Legacy.tsx", "x\n".repeat(310));
    fixture.write(repo, "web/State.tsx", "useState(0)\n".repeat(10));
    fixture.write(repo, "core/Big.java", "x\n".repeat(495));
    fixture.write(repo, "web/Panel.test.tsx", "x\n".repeat(290));
    fixture.commitAll(repo);
    fixture.git(repo, ["branch", "base"]);
    fixture.write(repo, "web/Big.tsx", "x\n".repeat(305));
    fixture.write(repo, "web/Legacy.tsx", "x\n".repeat(320));
    fixture.write(repo, "web/State.tsx", "useState(0)\n".repeat(11));
    fixture.write(repo, "core/Big.java", "x\n".repeat(505));
    fixture.write(repo, "web/Panel.test.tsx", "x\n".repeat(305));
    const run = fixture.runRuleChecks("--repo", repo, "--base", "base");
    assert.deepEqual(run.signals, signalSet(["K5.7", "web/Big.tsx"], ["K5.7", "web/State.tsx"], ["K5.7", "core/Big.java"]));
  });

  it("test_ruleChecks_skipsBinaryAndSymlinks_whenUntracked", () => {
    const repo = baseRepo();
    fixture.write(repo, "logo.png", Buffer.concat([Buffer.from("\x89PNG\0", "latin1"), Buffer.from("const v: any = 1\n".repeat(3))]));
    symlinkSync(join(repo, "README"), join(repo, "file-link.ts"));
    symlinkSync(join(fixture.tmp, "no-such-file"), join(repo, "dangling.ts"));
    const run = fixture.runRuleChecks("--repo", repo, "--base", "base");
    assert.equal(run.code, 0);
    assert.deepEqual(run.signals, new Set());
    assert.ok(run.summary.includes("scanned_lines=0"), run.summary);
  });

  it("test_ruleChecks_listsUntrackedNestedRepo_asUnscanned", () => {
    const repo = baseRepo();
    const nested = join(repo, "nested");
    mkdirSync(nested);
    fixture.git(nested, ["init", "-q"]);
    fixture.write(nested, "n.ts", ANY_LINE);
    const run = fixture.runRuleChecks("--repo", repo, "--base", "base");
    assert.equal(run.code, 0);
    assert.deepEqual(run.signals, new Set());
    assert.ok(run.summary.includes("unscanned=nested(untracked repo)"), run.summary);
  });
});

describe("test path equivalence with the risk classifier", () => {
  const PATHS = ["tests/test_x.py", "src/test/A.java", "web/a.test.ts", "pkg/a_test.go", "__tests__/a.js", "test_x.py", "web/b.spec.tsx", "src/app.py",
    "web/Screen.tsx", "lib/contest/a.py", "docs/testing.md", "latest.py"];

  it("test_testPathConstants_equalTheRiskClassifiers", () => {
    assert.deepEqual([...TEST_SEGMENTS].sort(), [...riskTestSegments].sort());
    assert.deepEqual(TEST_BASENAME_GLOBS, riskTestBasenameGlobs);
  });

  it("test_isTestPath_agreesWithRiskClassifier_forSharedPathTable", () => {
    const verdicts = PATHS.map(riskIsTestPath);
    const disagreements = PATHS.filter((path, index) => isTestPath(path) !== verdicts[index]);
    assert.deepEqual(disagreements, []);
    assert.deepEqual(new Set(verdicts), new Set([true, false]));
  });
});

describe("rule-checks over submodules", () => {
  let fixture: Isolated;

  beforeEach(() => {
    fixture = new Isolated();
  });

  afterEach(() => fixture.close());

  function parentWithSubmodule(): { parent: string; source: string } {
    const source = fixture.newRepo("mod-src");
    fixture.write(source, "f.ts", CLEAN_LINE);
    fixture.commitAll(source);
    const parent = fixture.newRepo("parent");
    fixture.addSubmodule(parent, source, "mod");
    fixture.commitAll(parent);
    fixture.git(parent, ["branch", "base"]);
    const mod = join(parent, "mod");
    fixture.git(mod, ["branch", "base"]);
    fixture.write(mod, "f.ts", ANY_LINE);
    fixture.commitAll(mod);
    fixture.commitAll(parent);
    return { parent, source };
  }

  it("test_ruleChecks_scansMovedSubmodule_withPathPrefix", () => {
    const { parent } = parentWithSubmodule();
    for (const head of [["--head", "HEAD"], []]) {
      const run = fixture.runRuleChecks("--repo", parent, "--base", "base", ...head);
      assert.equal(run.code, 0, head.join(" "));
      assert.deepEqual(run.signals, signalSet(["K5.11", "mod/f.ts:1"]));
      assert.ok(run.summary.includes("repos=2"), run.summary);
    }
  });

  it("test_ruleChecks_scansSubmodule_inSnapshotTree", () => {
    const { parent } = parentWithSubmodule();
    const tree = fixture.snapshotTree(parent);
    const reviewBase = fixture.git(parent, ["rev-parse", "base"]);
    const run = fixture.runRuleChecks("--repo", parent, "--base", reviewBase, "--head", tree);
    assert.equal(run.code, 0);
    assert.deepEqual(run.signals, signalSet(["K5.11", "mod/f.ts:1"]));
  });

  it("test_ruleChecks_scansFromParentPin_whenBaseIsHeadRelative", () => {
    const { parent } = parentWithSubmodule();
    const mod = join(parent, "mod");
    fixture.write(mod, "g.ts", ANY_LINE);
    fixture.commitAll(mod);
    const run = fixture.runRuleChecks("--repo", parent, "--base", "HEAD~1");
    assert.equal(run.code, 0);
    assert.deepEqual(run.signals, signalSet(["K5.11", "mod/f.ts:1"], ["K5.11", "mod/g.ts:1"]));
  });

  it("test_ruleChecks_listsAddedSubmodule_asUnscanned", () => {
    const { parent, source } = parentWithSubmodule();
    fixture.addSubmodule(parent, source, "extra");
    fixture.commitAll(parent);
    const run = fixture.runRuleChecks("--repo", parent, "--base", "base", "--head", "HEAD");
    assert.equal(run.code, 0);
    assert.ok(run.summary.includes("unscanned=extra(added)"), run.summary);
  });

  it("test_ruleChecks_blocksWithExitTwo_whenSubmoduleNotInitialized", () => {
    const { parent } = parentWithSubmodule();
    fixture.git(parent, ["submodule", "deinit", "-q", "-f", "mod"]);
    const run = fixture.runRuleChecks("--repo", parent, "--base", "base", "--head", "HEAD");
    assert.equal(run.code, 2);
    assert.deepEqual(run.signals, new Set());
    assert.ok(run.summary.endsWith("blocked=mod"), run.summary);
  });

  it("test_ruleChecks_blocksWithExitTwo_whenGitlinkReplacedBySymlink", () => {
    const { parent } = parentWithSubmodule();
    fixture.git(parent, ["rm", "-q", "--cached", "mod"]);
    renameSync(join(parent, "mod"), join(fixture.tmp, "mod-moved"));
    symlinkSync("README", join(parent, "mod"));
    fixture.commitAll(parent);
    const run = fixture.runRuleChecks("--repo", parent, "--base", "base", "--head", "HEAD");
    assert.equal(run.code, 2);
    assert.match(run.summary, /blocked=mod$/);
  });
});
