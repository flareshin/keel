import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readPush } from "../../hooks/git-guard/git-guard.ts";
import { parsePush } from "../../hooks/ship-gate/ship-gate.ts";

const BRANCH = "feature";

function guardReads(...args: string[]) {
  const push = readPush(args, BRANCH);
  return {
    sources: push.sources, destinations: [...push.destinations], force: push.force, forceWithLease: push.forceWithLease,
    wholeRepo: push.wholeRepo,
  };
}

function gateReads(...args: string[]) {
  const push = parsePush(["git", "push", ...args], args, "/work");
  return {
    remote: push.remote, refspecs: push.refspecs, deletesOnly: push.deletesOnly, tagsOnly: push.tagsOnly,
    wholeRepo: push.wholeRepo, dryRun: push.dryRun,
  };
}

describe("PushReadersDisagreementTest", () => {
  it("noRefspec_guardAssumesHeadToTheCurrentBranch_gateKeepsNoRefspec", () => {
    assert.deepEqual(guardReads("origin"), {
      sources: ["HEAD"], destinations: [BRANCH], force: false, forceWithLease: false, wholeRepo: false,
    });
    const gate = gateReads("origin");
    assert.deepEqual(gate.refspecs, []);
    assert.equal(gate.deletesOnly, false);
  });

  it("deleteOption_guardSkipsEveryRefspec_gateKeepsThemAndMarksDeletesOnly", () => {
    const guard = guardReads("--delete", "origin", "old");
    assert.deepEqual([guard.sources, guard.destinations], [[], []]);
    const gate = gateReads("--delete", "origin", "old");
    assert.deepEqual(gate.refspecs, [{ source: "old", destination: null }]);
    assert.equal(gate.deletesOnly, true);
  });

  it("deleteOptionWithoutRefspec_guardAddsNoHead_gateMarksDeletesOnly", () => {
    const guard = guardReads("-d", "origin");
    assert.deepEqual([guard.sources, guard.destinations], [[], []]);
    assert.equal(gateReads("-d", "origin").deletesOnly, true);
  });

  it("colonRefspec_bothDropItFromTheNamedRefs_gateCountsItTowardDeletesOnly", () => {
    for (const spec of [":old", "+:old", ":"]) {
      const guard = guardReads("origin", spec);
      assert.deepEqual([guard.sources, guard.destinations], [[], []], spec);
      const gate = gateReads("origin", spec);
      assert.deepEqual(gate.refspecs, [], spec);
      assert.equal(gate.deletesOnly, true, spec);
    }
    const mixed = gateReads("origin", "new", ":old");
    assert.deepEqual(mixed.refspecs, [{ source: "new", destination: null }]);
    assert.equal(mixed.deletesOnly, false);
  });

  it("emptyRefspecWord_guardSkipsIt_gateKeepsItAsAnEmptySource", () => {
    for (const word of ["", "+"]) {
      const guard = guardReads("origin", word);
      assert.deepEqual([guard.sources, guard.destinations], [[], []], word);
      const gate = gateReads("origin", word);
      assert.deepEqual(gate.refspecs, [{ source: "", destination: null }], word);
      assert.equal(gate.deletesOnly, false, word);
    }
  });

  it("destination_guardDefaultsToTheSourceAndNormalizesIt_gateKeepsWhatWasGiven", () => {
    const cases: Array<[spec: string, guardDestination: string, gateDestination: string | null]> = [
      ["topic", "topic", null],
      ["topic:", "topic", null],
      ["topic:refs/heads/x", "x", "refs/heads/x"],
      ["topic:HEAD", BRANCH, "HEAD"],
      ["HEAD:refs/heads/x", "x", "refs/heads/x"],
    ];
    for (const [spec, guardDestination, gateDestination] of cases) {
      assert.deepEqual(guardReads("origin", spec).destinations, [guardDestination], spec);
      assert.equal(gateReads("origin", spec).refspecs[0]?.destination, gateDestination, spec);
    }
  });

  it("forceSpellings_onlyGuardReadsThem_gateDropsThePlusFromTheRefspec", () => {
    for (const args of [["--force", "origin", "topic"], ["-f", "origin", "topic"], ["-fu", "origin", "topic"], ["origin", "+topic"]]) {
      assert.equal(guardReads(...args).force, true, args.join(" "));
      assert.deepEqual(gateReads(...args).refspecs, [{ source: "topic", destination: null }], args.join(" "));
    }
    assert.equal(guardReads("--force-with-lease=topic", "origin", "topic").forceWithLease, true);
    assert.equal(guardReads("--force-with-lease=topic", "origin", "topic").force, false);
  });

  it("tagsAndDryRunAndRemote_onlyGateReadsThem", () => {
    assert.equal(gateReads("--tags", "origin").tagsOnly, true);
    assert.equal(gateReads("--tags", "origin", "main").tagsOnly, false);
    assert.deepEqual(guardReads("--tags", "origin"), guardReads("origin"));
    assert.equal(gateReads("-n", "origin", "topic").dryRun, true);
    assert.equal(gateReads("--dry-run", "origin", "topic").dryRun, true);
    assert.deepEqual(guardReads("-n", "origin", "topic"), guardReads("origin", "topic"));
    assert.equal(gateReads("origin", "topic").remote, "origin");
    assert.equal(gateReads("--repo=upstream").remote, "upstream");
  });

  it("wholeRepoOptions_bothAgree", () => {
    for (const option of ["--all", "--branches", "--mirror"]) {
      assert.equal(guardReads(option, "origin").wholeRepo, true, option);
      assert.equal(gateReads(option, "origin").wholeRepo, true, option);
    }
    assert.equal(guardReads("origin", "topic").wholeRepo, false);
    assert.equal(gateReads("origin", "topic").wholeRepo, false);
  });
});
