import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync,
  unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { run } from "../../hooks/lib/hookkit/subprocess.ts";
import { materialize, SnapshotPacker } from "../../tests/recorded-cases.ts";
import type { SnapshotStore } from "../../tests/recorded-cases.ts";
import { recordedAnswers } from "../../tests/recorded.ts";
import type { CompletedProcess } from "../../hooks/lib/hookkit/subprocess.ts";
import { withEnv } from "../../tests/hooks/helpers.ts";
import { completeEdit, validateUpdate } from "../lib/config_policy.ts";
import { digest, fingerprint } from "../lib/files.ts";
import { buildFiles, buildSkillLinks, reconcile } from "../lib/install.ts";
import { ValueError } from "../lib/pyerrors.ts";
import { pythonJsonLoads } from "../lib/pyjson.ts";
import { applySkillPlan, lockIsStale, planSkills, realSkillFiles, replaceLink } from "../lib/skill_registry.ts";
import type { SkillFiles } from "../lib/skill_registry.ts";
import { main as runHook, normalize, protectAdapter, runGuard } from "../hooks/pre-tool-use.ts";
import type { Call } from "../hooks/pre-tool-use.ts";

const ADAPTER = realpathSync(join(import.meta.dirname, ".."));
const KEEL = dirname(ADAPTER);
const LINK = join(ADAPTER, "bin", "link.ts");
const CONFIG = join(ADAPTER, "bin", "config.ts");
const HOOK = join(ADAPTER, "hooks", "pre-tool-use.ts");
const WRITE_MODE = { write: true, unlink: false, check: false };

function temporaryDirectory(): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keel-codex-")));
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function readJsonFile(path: string): Record<string, any> {
  return pythonJsonLoads(read(path)) as Record<string, any>;
}

function referenceDigest(kind: string, content: Buffer): string {
  return createHash("sha256").update(kind).update("\0").update(content).digest("hex");
}

function runNode(script: string, args: string[], env: NodeJS.ProcessEnv, input?: string) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env, input });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("installation", () => {
  let temp: string;
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = temporaryDirectory();
    home = temp;
    env = { ...process.env, HOME: home, KEEL_OVERLAY_DIR: join(home, "overlay"), KEEL_DATA_DIR: join(home, "data") };
    delete env["CODEX_HOME"];
  });

  afterEach(() => rmSync(temp, { recursive: true, force: true }));

  function runLink(...args: string[]) {
    return runNode(LINK, ["--home", home, ...args], env);
  }

  function runSourceLink(source: string, ...args: string[]) {
    return runNode(join(source, "codex", "bin", "link.ts"), ["--home", home, ...args], env);
  }

  function copySource(name: string): string {
    const source = join(home, name);
    mkdirSync(source);
    for (const file of ["PRINCIPLES.md", "package.json"]) cpSync(join(KEEL, file), join(source, file));
    for (const directory of ["skills", "codex", "hooks/lib"]) {
      cpSync(join(KEEL, directory), join(source, directory), { recursive: true, dereference: true, filter: (path) => !path.includes("__pycache__") });
    }
    return source;
  }

  function actionsOf(result: { stdout: string }): unknown {
    return (pythonJsonLoads(result.stdout) as Record<string, unknown>)["actions"];
  }

  it("test_dryRun_doesNotWrite_home", () => {
    const run = runLink();
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(join(home, ".codex")), false);
    assert.ok((actionsOf(run) as unknown[]).length > 0);
  });

  it("test_install_requiresOwnerApprovalAndShip1_inGeneratedGuidance", () => {
    const run = runLink("--write");
    assert.equal(run.status, 0, run.stderr);
    assert.ok(read(join(home, ".codex/AGENTS.md")).includes("PRs require owner `keel approve` then explicit `/ship1`; PASS is not consent."));
  });

  it("test_install_requiresConcreteOwnerCommand_afterEveryReview", () => {
    const run = runLink("--write");
    assert.equal(run.status, 0, run.stderr);
    const guidance = read(join(home, ".codex/AGENTS.md"));
    assert.ok(guidance.includes("After every review, include a copyable zsh command in the final response."));
    assert.ok(guidance.includes("Use the actual registered root_run_id"));
    assert.ok(guidance.includes("Never invent an approval ID or offer a placeholder approval command."));
    assert.ok(guidance.includes("provide a concrete permitted diagnostic command"));
    for (const source of ["docs/codex-review.md", "codex/skills/keel-review/SKILL.md"]) {
      assert.ok(read(join(KEEL, source)).includes("After every review"), source);
    }
  });

  it("test_install_isIdempotent_andUnlinksOwnedFiles", () => {
    const run = runLink("--write");
    assert.equal(run.status, 0, run.stderr);
    assert.ok(statSync(join(home, ".agents/skills/readable-code/SKILL.md")).isFile());
    assert.ok(read(join(home, ".codex/AGENTS.md")).includes("Codex runtime"));
    assert.equal(runLink("--check").status, 0);
    assert.deepEqual(actionsOf(runLink("--write")), []);
    assert.equal(runLink("--unlink").status, 0);
    assert.equal(existsSync(join(home, ".codex/AGENTS.md")), false);
    assert.equal(existsSync(join(home, ".agents/skills/readable-code")), false);
  });

  it("test_conflict_preservesExistingInstructions_andWritesNothing", () => {
    const target = join(home, ".codex/AGENTS.md");
    mkdirSync(dirname(target));
    writeFileSync(target, "owner instructions");
    assert.equal(runLink("--write").status, 3);
    assert.equal(read(target), "owner instructions");
    assert.equal(existsSync(join(dirname(target), "hooks.json")), false);
  });

  it("test_refresh_refusesHandEditedManagedFile", () => {
    assert.equal(runLink("--write").status, 0);
    const target = join(home, ".codex/AGENTS.md");
    writeFileSync(target, "owner edit");
    assert.equal(runLink("--write").status, 3);
    assert.equal(runLink("--unlink").status, 3);
    assert.equal(read(target), "owner edit");
  });

  it("test_existingEquivalentSkill_survivesUnlink", () => {
    const skill = join(home, ".agents/skills/readable-code");
    mkdirSync(dirname(skill), { recursive: true });
    symlinkSync(join(KEEL, "skills/readable-code"), skill);
    assert.equal(runLink("--write").status, 0);
    assert.equal(runLink("--unlink").status, 0);
    assert.ok(lstatSync(skill).isSymbolicLink());
  });

  it("test_existingEquivalentGeneratedFiles_remainUnownedAndSurviveUnlink", () => {
    const profile = join(home, ".codex");
    const desired = buildFiles(profile, join(home, "overlay"), join(home, "data"), join(home, ".agents"));
    for (const [path, file] of desired) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
    }
    assert.equal(runLink("--write").status, 0);
    const state = readJsonFile(join(profile, "keel-codex-state.json"));
    assert.deepEqual(state["owned"], {});

    assert.equal(runLink("--unlink").status, 0);

    for (const [path, file] of desired) assert.equal(read(path), file.content);
  });

  it("test_customCodexHome_preservesConfig_andIncludesPersonal", () => {
    const profile = join(home, "custom codex");
    mkdirSync(profile);
    writeFileSync(join(profile, "config.toml"), 'model = "owner-model"\n');
    const overlay = join(home, "overlay");
    mkdirSync(overlay);
    writeFileSync(join(overlay, "PERSONAL.md"), "Talk to the owner in Korean.\n");
    env["CODEX_HOME"] = profile;
    assert.equal(runLink("--write").status, 0);
    assert.ok(read(join(profile, "AGENTS.md")).includes("Talk to the owner in Korean."));
    assert.equal(read(join(profile, "config.toml")), 'model = "owner-model"\n');
    assert.equal(existsSync(join(home, ".codex")), false);
  });

  it("test_duplicateSkills_refuseBeforeWriting", () => {
    const overlay = join(home, "overlay/skills/readable-code");
    mkdirSync(overlay, { recursive: true });
    writeFileSync(join(overlay, "SKILL.md"), "duplicate");
    assert.equal(runLink("--write").status, 3);
    assert.equal(existsSync(join(home, ".codex")), false);
  });

  it("test_bothInstallers_exposeSameCoreSkillsAndImplementationReference", () => {
    mkdirSync(join(home, "overlay"));
    const claude = spawnSync(join(KEEL, "bin/link"), ["--write", "--allow-worktree"], { encoding: "utf8", env: { ...env, KEEL_HOME: KEEL } });
    assert.equal(claude.status, 0, claude.stdout + claude.stderr);
    assert.equal(runLink("--write").status, 0);

    for (const name of ["readable-code", "improve", "descend", "prompt-refine"]) {
      const claudeSkill = join(home, "data/skills", name);
      const codexSkill = join(home, ".agents/skills", name);
      assert.equal(realpathSync(claudeSkill), realpathSync(codexSkill), name);
      assert.deepEqual(readFileSync(join(claudeSkill, "SKILL.md")), readFileSync(join(codexSkill, "SKILL.md")), name);
    }
    const reference = "readable-code/references/implementation.md";
    assert.deepEqual(readFileSync(join(home, "data/skills", reference)), readFileSync(join(home, ".agents/skills", reference)));
  });

  it("test_refresh_movesOwnedSkillsToNewSource_andBothHostsReadSameReference", () => {
    const first = copySource("old-source");
    const second = copySource("new-source");
    assert.equal(runSourceLink(first, "--write").status, 0);
    const claudeSkill = join(home, ".claude/skills/readable-code");
    mkdirSync(dirname(claudeSkill), { recursive: true });
    symlinkSync(join(second, "skills/readable-code"), claudeSkill);

    const refreshed = runSourceLink(second, "--write");

    assert.equal(refreshed.status, 0, refreshed.stdout + refreshed.stderr);
    const codexSkill = join(home, ".agents/skills/readable-code");
    assert.equal(realpathSync(codexSkill), realpathSync(claudeSkill));
    const reference = "references/implementation.md";
    assert.deepEqual(readFileSync(join(codexSkill, reference)), readFileSync(join(claudeSkill, reference)));
    assert.ok(statSync(join(home, ".agents/skills/improve/SKILL.md")).isFile());
    assert.equal(runSourceLink(second, "--check").status, 0);
    assert.deepEqual(actionsOf(runSourceLink(second, "--write")), []);
  });

  for (const failure of ["registry-write", "second-link"] as const) {
    it(`test_refresh_resumesAfterRegistryWriteOrMidwayReplacementFailure (${failure})`, () => {
      const first = copySource("old-source");
      const second = copySource("new-source");
      assert.equal(runSourceLink(first, "--write").status, 0);
      const agents = join(home, ".agents");
      const registry = join(agents, "keel-codex-skills.json");
      const original = readFileSync(registry);
      const records = (pythonJsonLoads(original.toString()) as Record<string, any>)["skills"] as Record<string, { target: string }>;
      const desired = new Map(Object.entries(records).map(([name, entry]) =>
        [join(agents, "skills", name), { kind: "link" as const, content: entry.target.replace(first, second) }]));
      const profile = join(home, ".codex");

      for (const [name, entry] of Object.entries(records)) replaceLink(join(agents, "skills", name), entry.target);
      writeFileSync(registry, original);
      const plan = planSkills(agents, profile, desired);
      assert.deepEqual(plan.problems, []);
      const replaced: string[] = [];
      const failing: SkillFiles = failure === "registry-write"
        ? { ...realSkillFiles, writeAtomic: () => { throw Object.assign(new Error("registry unavailable"), { code: "EIO", errno: -5 }); } }
        : {
          ...realSkillFiles,
          replaceLink: (path, target) => {
            if (replaced.length > 0) throw Object.assign(new Error("interrupted during link refresh"), { code: "EIO", errno: -5 });
            replaceLink(path, target);
            replaced.push(path);
          },
        };
      assert.throws(() => applySkillPlan(agents, plan, failing), /registry unavailable|interrupted during link refresh/);
      assert.deepEqual(readFileSync(registry), original);
      assert.ok(Array.from(desired).some(([path, file]) => realpathSync(path) === file.content));

      const retry = planSkills(agents, profile, desired);
      assert.deepEqual(retry.problems, []);
      applySkillPlan(agents, retry);

      for (const [path, file] of desired) assert.equal(realpathSync(path), file.content);
      const persisted = (pythonJsonLoads(readFileSync(registry).toString()) as Record<string, any>)["skills"] as Record<string, { target: string }>;
      assert.deepEqual(
        Object.fromEntries(Object.entries(persisted).map(([name, entry]) => [name, entry.target])),
        Object.fromEntries(Array.from(desired, ([path, file]) => [path.slice(path.lastIndexOf("/") + 1), file.content])));
      assert.equal(planSkills(agents, profile, desired).changed, false);
    });
  }

  it("test_refresh_cliResumesAfterRegistryFailure_andRecordsGeneratedFileOwnership", () => {
    const first = copySource("old-source");
    const second = copySource("new-source");
    assert.equal(runSourceLink(first, "--write").status, 0);
    const agents = join(home, ".agents");
    const profile = join(home, ".codex");
    const state = join(profile, "keel-codex-state.json");
    const original = readFileSync(state);
    const desired = buildFiles(profile, join(home, "overlay"), join(home, "data"), agents, second);
    const skills = buildSkillLinks(home, join(home, "overlay"), second);
    const failing: SkillFiles = { ...realSkillFiles, writeAtomic: () => { throw Object.assign(new Error("registry unavailable"), { code: "EIO", errno: -5 }); } };
    assert.throws(() => reconcile(desired, skills, agents, state, WRITE_MODE, failing), /registry unavailable/);
    assert.deepEqual(readFileSync(state), original);

    const retry = runSourceLink(second, "--write");

    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.equal(runSourceLink(second, "--check").status, 0);
    const saved = readJsonFile(state)["owned"];
    for (const path of [join(profile, "AGENTS.md"), join(profile, "hooks.json")]) assert.equal(saved[path], referenceDigest("file", readFileSync(path)));
  });

  it("test_refresh_dryRunLeavesOwnedLinksAndRegistryUntouched", () => {
    const first = copySource("old-source");
    const second = copySource("new-source");
    assert.equal(runSourceLink(first, "--write").status, 0);
    const registry = join(home, ".agents/keel-codex-skills.json");
    const before = readFileSync(registry);

    const checked = runSourceLink(second, "--check");

    assert.equal(checked.status, 1, checked.stdout);
    assert.deepEqual((pythonJsonLoads(checked.stdout) as Record<string, unknown>)["problems"], []);
    assert.deepEqual(readFileSync(registry), before);
    assert.equal(realpathSync(join(home, ".agents/skills/readable-code")), join(first, "skills/readable-code"));
  });

  it("test_refresh_refusesRetargetUsedByAnotherProfile", () => {
    const first = copySource("old-source");
    const second = copySource("new-source");
    assert.equal(runSourceLink(first, "--write").status, 0);
    env["CODEX_HOME"] = join(home, "other-profile");
    assert.equal(runSourceLink(first, "--write").status, 0);
    delete env["CODEX_HOME"];
    const registry = join(home, ".agents/keel-codex-skills.json");
    const before = readFileSync(registry);

    const refused = runSourceLink(second, "--write");

    assert.equal(refused.status, 3, refused.stdout);
    assert.deepEqual(readFileSync(registry), before);
    assert.equal(realpathSync(join(home, ".agents/skills/readable-code")), join(first, "skills/readable-code"));
  });

  for (const managed of [false, true]) {
    it(`test_refresh_preservesUnmanagedOrEditedSkill (managed=${managed})`, () => {
      const agents = join(home, "agents");
      const skill = join(agents, "skills/demo");
      mkdirSync(dirname(skill), { recursive: true });
      const original = join(agents, "original");
      const changed = join(agents, "owner-choice");
      symlinkSync(managed ? changed : original, skill, "dir");
      const profile = join(agents, "profile");
      const registry = { version: 1, skills: { demo: { target: original, managed, profiles: [profile] } } };
      writeFileSync(join(agents, "keel-codex-skills.json"), JSON.stringify(registry));

      const plan = planSkills(agents, profile, new Map([[skill, { kind: "link" as const, content: join(agents, "replacement") }]]));

      assert.ok(plan.problems.length > 0);
      assert.equal(readlinkSync(skill), managed ? changed : original);
    });
  }

  it("test_sharedSkills_surviveUntilLastProfileUnlinks", () => {
    const first = join(home, "profile-a");
    const second = join(home, "profile-b");
    env["CODEX_HOME"] = first;
    assert.equal(runLink("--write").status, 0);
    env["CODEX_HOME"] = second;
    assert.equal(runLink("--write").status, 0);
    env["CODEX_HOME"] = first;
    assert.equal(runLink("--unlink").status, 0);
    env["CODEX_HOME"] = second;
    assert.equal(runLink("--check").status, 0);
    assert.ok(existsSync(join(home, ".agents/skills/readable-code/SKILL.md")));
    assert.equal(runLink("--unlink").status, 0);
    assert.equal(existsSync(join(home, ".agents/skills/readable-code")) || isSymlink(join(home, ".agents/skills/readable-code")), false);
  });

  it("test_unlink_doesNotRequireCurrentSourceInventory", () => {
    assert.equal(runLink("--write").status, 0);
    const duplicate = join(home, "overlay/skills/readable-code");
    mkdirSync(duplicate, { recursive: true });
    writeFileSync(join(duplicate, "SKILL.md"), "duplicate");
    assert.equal(runLink("--unlink").status, 0);
  });

  it("test_concurrentProfiles_keepBothReferences", async () => {
    const profiles = [join(home, "a"), join(home, "b")];
    const runs = profiles.map((profile) => new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [LINK, "--home", home, "--write"], { env: { ...env, CODEX_HOME: profile } });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdout.resume();
      child.on("close", (status) => resolve({ status, stderr }));
    }));
    for (const run of await Promise.all(runs)) assert.equal(run.status, 0, run.stderr);
    const registry = readJsonFile(join(home, ".agents/keel-codex-skills.json"));
    assert.deepEqual(new Set(registry["skills"]["readable-code"]["profiles"]), new Set(profiles.map((profile) => realpathSync(profile))));
  });

  it("test_staleLock_isReclaimed_whenItsOwnerProcessIsGone", () => {
    const finished = spawnSync(process.execPath, ["-e", ""]);
    const lock = join(home, ".agents", "keel-codex-skills.lock.d");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner"), String(finished.pid));
    const run = runLink("--write");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(lock), false);
  });

  describe("lock ownership", () => {
    const HOUR_SECONDS = 3600;
    const lockWith = (owner: string | null, ageSeconds: number): string => {
      const lock = join(home, ".agents", "keel-codex-skills.lock.d");
      mkdirSync(lock, { recursive: true });
      if (owner !== null) writeFileSync(join(lock, "owner"), owner);
      const modified = Date.now() / 1000 - ageSeconds;
      utimesSync(lock, modified, modified);
      return lock;
    };

    for (const owner of ["", "abc", "0", "-5", "12abc", "1.5", " "]) {
      it(`reclaims a lock whose owner file holds ${JSON.stringify(owner)} once the grace period has passed`, () => {
        assert.equal(lockIsStale(lockWith(owner, HOUR_SECONDS)), true);
      });

      it(`waits for a fresh lock whose owner file holds ${JSON.stringify(owner)}`, () => {
        assert.equal(lockIsStale(lockWith(owner, 0)), false);
      });
    }

    it("keeps a live owner's lock when the process listing cannot start", () => {
      const lock = lockWith(String(process.pid), HOUR_SECONDS);
      withEnv({ PATH: join(home, "missing-programs") }, () => assert.equal(lockIsStale(lock), false));
    });

    it("keeps a lock held by this live process", () => {
      assert.equal(lockIsStale(lockWith(String(process.pid), 0)), false);
    });

    it("reclaims a lock whose process id now belongs to a process started after the lock", () => {
      const unrelated = spawn("sleep", ["30"]);
      try {
        assert.ok(unrelated.pid !== undefined);
        assert.equal(lockIsStale(lockWith(String(unrelated.pid), HOUR_SECONDS)), true);
      } finally {
        unrelated.kill();
      }
    });

    it("keeps a lock whose live owner started before the lock was taken", () => {
      const holder = spawn("sleep", ["30"]);
      try {
        assert.ok(holder.pid !== undefined);
        assert.equal(lockIsStale(lockWith(String(holder.pid), 0)), false);
      } finally {
        holder.kill();
      }
    });

    it("link --write proceeds past a stale lock with an empty owner file", () => {
      const lock = lockWith("", HOUR_SECONDS);
      const run = runLink("--write");
      assert.equal(run.status, 0, run.stderr);
      assert.equal(existsSync(lock), false);
    });
  });

  describe("hook command", () => {
    const PAYLOAD_ENV = { PATH: "/usr/bin:/bin" };

    function nodeLauncher(name: string): string {
      const directory = join(home, name);
      mkdirSync(directory);
      symlinkSync(process.execPath, join(directory, "node"));
      return directory;
    }

    function installedCommand(searchPath: string): string {
      const run = spawnSync(process.execPath, [LINK, "--home", home, "--write"], { env: { ...env, PATH: searchPath }, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      return readJsonFile(join(home, ".codex/hooks.json"))["hooks"]["PreToolUse"][0]["hooks"][0]["command"];
    }

    function commandFor(runtime: string): string {
      return [
        `KEEL_HOME=${KEEL}`, `KEEL_OVERLAY_DIR=${home}/overlay`, `KEEL_DATA_DIR=${home}/data`, `KEEL_CODEX_HOME=${home}/.codex`,
        `KEEL_AGENTS_HOME=${home}/.agents`, runtime, `${KEEL}/codex/hooks/pre-tool-use.ts`,
      ].join(" ");
    }

    it("writes the PATH launcher of the running node, not its version-specific install path", () => {
      assert.match(home, /^[A-Za-z0-9_\/.-]+$/);
      const launcher = nodeLauncher("launcher");
      assert.equal(installedCommand(`${launcher}:${process.env["PATH"]}`), commandFor(`${launcher}/node`));
    });

    it("installs a command that runs the TypeScript hook and denies a protected write", () => {
      const launcher = nodeLauncher("launcher");
      const command = installedCommand(`${launcher}:${process.env["PATH"]}`);
      const write = { tool_name: "Write", tool_input: { file_path: `${home}/.codex/hooks.json`, content: "x" }, cwd: home, session_id: "link-test" };
      const run = spawnSync("sh", ["-c", command], { input: JSON.stringify(write), encoding: "utf8", env: { ...PAYLOAD_ENV, HOME: home } });
      assert.equal(run.status, 0, run.stderr);
      const decision = (pythonJsonLoads(run.stdout) as Record<string, any>)["hookSpecificOutput"];
      assert.equal(decision["permissionDecision"], "deny");
      assert.equal(decision["permissionDecisionReason"], `keel Codex guard: generated Codex configuration must be changed through codex/bin/link: ${home}/.codex/hooks.json`);
    });

    it("falls back to the binary path when no PATH entry is the running node", () => {
      const impostor = join(home, "impostor");
      mkdirSync(impostor);
      writeFileSync(join(impostor, "node"), "#!/bin/sh\n");
      chmodSync(join(impostor, "node"), 0o755);
      assert.equal(installedCommand(`${impostor}:${join(home, "missing")}:relative/bin::`), commandFor(process.execPath));
    });
  });

  describe("reading a profile the Python installer wrote", () => {
    const PYTHON_LINK = join(ADAPTER, "bin", "link");

    function runPythonLink(...args: string[]) {
      const result = spawnSync("python3", [PYTHON_LINK, "--home", home, ...args], { encoding: "utf8", env });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }

    interface PythonInstall {
      store: SnapshotStore;
      snapshot: string;
      agents: string;
      agentsBytes: string;
      ownedAgentsDigest: string;
      registry: string;
    }

    function recordedPythonInstall(): PythonInstall {
      const askPython = (): PythonInstall[] => {
        assert.equal(runPythonLink("--write").status, 0);
        const packer = new SnapshotPacker();
        const agents = join(home, ".codex/AGENTS.md");
        const owned = readJsonFile(join(home, ".codex/keel-codex-state.json"))["owned"][agents];
        const registry = read(join(home, ".agents/keel-codex-skills.json"));
        return [{ store: packer.store, snapshot: packer.addTree(home, home), agents: read(agents), agentsBytes: readFileSync(agents).toString("base64"), ownedAgentsDigest: owned, registry }];
      };
      return recordedAnswers("codex-python-install", [{ install: "write" }], askPython, { "{{ROOT}}": home, "{{KEEL_HOME}}": dirname(ADAPTER) })[0] as PythonInstall;
    }

    function restoredPythonInstall(): PythonInstall {
      const install = recordedPythonInstall();
      rmSync(home, { recursive: true, force: true });
      materialize(install.store, install.snapshot, home);
      const statePath = join(home, ".codex/keel-codex-state.json");
      const state = readJsonFile(statePath);
      for (const owned of Object.keys(state["owned"])) state["owned"][owned] = fingerprint(owned);
      writeFileSync(statePath, JSON.stringify(state));
      return install;
    }

    const HOOKS_ONLY = { actions: [] as string[], problems: [] as string[] };

    it("lets TypeScript verify and refresh a Python install, rewriting only the hook command", () => {
      restoredPythonInstall();
      const hooks = join(home, ".codex/hooks.json");
      const pythonHooks = read(hooks);
      const check = runLink("--check");
      assert.equal(check.status, 1, check.stderr);
      assert.deepEqual(pythonJsonLoads(check.stdout), { ...HOOKS_ONLY, actions: [hooks] });
      assert.equal(runLink("--write").status, 0);
      assert.notEqual(read(hooks), pythonHooks);
      assert.match(read(hooks), /pre-tool-use\.ts"/);
      const back = runLink("--check");
      assert.equal(back.status, 0, back.stderr);
    });

    it("lets TypeScript unlink a Python install", () => {
      restoredPythonInstall();
      const second = runLink("--unlink");
      assert.equal(second.status, 0, second.stderr);
      assert.equal(existsSync(join(home, ".codex/AGENTS.md")), false);
      assert.equal(existsSync(join(home, ".codex/hooks.json")), false);
      assert.equal(existsSync(join(home, ".codex/keel-codex-state.json")), false);
    });

    it("records the same ownership digests and skill registry as the recorded Python install", () => {
      const install = recordedPythonInstall();
      assert.equal(runLink("--write").status, 0);
      const state = readJsonFile(join(home, ".codex/keel-codex-state.json"));
      const agents = join(home, ".codex/AGENTS.md");
      assert.equal(install.ownedAgentsDigest, referenceDigest("file", Buffer.from(install.agentsBytes, "base64")));
      assert.equal(state["owned"][agents], digest("file", install.agents));
      assert.equal(read(agents), install.agents);
      assert.equal(read(join(home, ".agents/keel-codex-skills.json")), install.registry);
    });
  });

  it("test_legacyOwnership_preservesSkillOnUnlink", () => {
    assert.equal(runLink("--write").status, 0);
    const statePath = join(home, ".codex/keel-codex-state.json");
    const state = readJsonFile(statePath);
    delete state["skills_home"];
    const skill = join(home, ".agents/skills/readable-code");
    state["owned"][skill] = fingerprint(skill);
    writeFileSync(statePath, JSON.stringify(state));
    unlinkSync(join(home, ".agents/keel-codex-skills.json"));
    assert.equal(runLink("--write").status, 0);
    assert.equal(runLink("--unlink").status, 0);
    assert.ok(lstatSync(skill).isSymbolicLink());
  });
});

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

describe("ownership digests", () => {
  it("hash the kind, a NUL byte and the UTF-8 content, as the Python installer records them", () => {
    assert.equal(digest("file", "x"), "24e5fa83ea3d78ba97ff36665723f0df9e3d179e110965a34b679ad5ad27eaab");
    assert.equal(digest("link", "/a/b"), "8f4a147acc2778b4d17f7113578e7ff8fd04c72279c09865028f0d5257d1e4c7");
    assert.equal(digest("file", "\u00e9"), "5eb5e24ec91d24caac54c01428c2f2c8bf2c4c6f65817ff1c2db9405c6fa7765");
  });
});

describe("hookkit run", () => {
  it("feeds input to the child and reports its streams and exit code", () => {
    const completed = run(["sh", "-c", "cat; echo err >&2; exit 3"], 5, { input: "payload" });
    assert.deepEqual(completed, { returncode: 3, stdout: "payload", stderr: "err\n" });
  });

  it("ignores a child that exits without reading its input", () => {
    assert.equal(run(["true"], 5, { input: "x".repeat(1 << 20) }).returncode, 0);
  });

  it("runs the child in the requested directory", () => {
    const directory = temporaryDirectory();
    try {
      assert.equal(run(["pwd", "-P"], 5, { cwd: directory }).stdout, `${realpathSync(directory)}\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("config", () => {
  it("test_updater_preservesHooksAndMode", () => {
    const profile = temporaryDirectory();
    try {
      const config = join(profile, "config.toml");
      writeFileSync(config, "[features]\nhooks = true\n");
      chmodSync(config, 0o600);
      const candidate = join(profile, "candidate.toml");
      writeFileSync(candidate, 'model = "new-model"\n[features]\nhooks = true\n');
      const run = runNode(CONFIG, ["--profile", profile, "--file", candidate], process.env);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(read(config), read(candidate));
      assert.equal(statSync(config).mode & 0o777, 0o600);
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });

  it("test_policy_parsesCompleteToml", () => {
    for (const candidate of ['[features]\n"hooks" = false', "features = {hooks = false}", "allow_managed_hooks_only = true", "hooks = {enabled = false}", "bad ["]) {
      assert.throws(() => validateUpdate("[features]\nhooks = true", candidate), ValueError, candidate);
    }
    validateUpdate("", '# hooks = false\nmodel = "safe"');
  });

  it("test_exactEditAndPartialPatch_areChecked", () => {
    const profile = temporaryDirectory();
    try {
      const config = join(profile, "config.toml");
      writeFileSync(config, "[features]\nhooks = true");
      const candidate = completeEdit(config, { old_string: "true", new_string: "false" });
      assert.throws(() => validateUpdate(read(config), candidate), ValueError);
      assert.throws(() => completeEdit(config, { keel_partial: true, content: 'model = "safe"' }), ValueError);
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });
});

describe("guard", () => {
  let temp: string;

  beforeEach(() => {
    temp = temporaryDirectory();
  });

  afterEach(() => rmSync(temp, { recursive: true, force: true }));

  function payload(name: string, tool: Record<string, unknown>, extra: Record<string, unknown> = {}): Call {
    return { tool_name: name, tool_input: tool, hook_event_name: "PreToolUse", cwd: "/tmp", session_id: "codex-test", ...extra };
  }

  function expectProtected(call: Call, message?: string): void {
    assert.throws(() => protectAdapter(call), (error: unknown) => error instanceof ValueError, message ?? JSON.stringify(call));
  }

  it("test_shell_preservesCommand", () => {
    const call = payload("Bash", { command: "git status" });
    assert.deepEqual(normalize(call), [call]);
  });

  it("test_patch_checksEveryPath_includingMoveAndDelete", () => {
    const patch = "*** Begin Patch\n*** Update File: a.py\n*** Move to: b.py\n@@\n-old\n+new\n*** Delete File: c.py\n*** Add File: d.py\n+x\n*** End Patch";
    const calls = normalize(payload("apply_patch", { command: patch }));
    assert.deepEqual(calls.map((call) => call.tool_input["file_path"]), ["a.py", "b.py", "c.py", "d.py"]);
    assert.equal(calls[1]?.tool_input["content"], "new");
  });

  it("test_adapterConfig_blocksShellWriteAndDelete_butAllowsRead", () => {
    const profile = join(temp, "profile");
    mkdirSync(profile);
    withEnv({ KEEL_CODEX_HOME: profile }, () => {
      for (const command of [`printf x > ${profile}/hooks.json`, `rm ${profile}/hooks.json`, `rm -rf ${profile}`]) {
        expectProtected(payload("Bash", { command }), command);
      }
      protectAdapter(payload("Bash", { command: `cat ${profile}/hooks.json` }));
    });
  });

  it("test_adapterConfig_resolvesProfileSymlink_forPatch", () => {
    const real = join(temp, "real");
    mkdirSync(real);
    const alias = join(temp, "alias");
    symlinkSync(real, alias, "dir");
    withEnv({ KEEL_CODEX_HOME: alias }, () => {
      expectProtected(payload("Write", { file_path: join(real, "hooks.json") }));
    });
  });

  it("test_hookToggle_blocksDisable_butAllowsModelSetting", () => {
    const profile = temp;
    withEnv({ KEEL_CODEX_HOME: profile }, () => {
      const disabled = "[features]\nhooks = false\n";
      for (const call of [
        payload("Write", { file_path: join(profile, "config.toml"), content: disabled }),
        payload("Bash", { command: `printf '[features]\\nhooks = false\\n' >> ${profile}/config.toml` }),
      ]) expectProtected(call);
      protectAdapter(payload("Write", { file_path: join(profile, "config.toml"), content: 'model = "owner-model"' }));
      expectProtected(payload("Bash", { command: `printf 'model = owner-model' >> ${profile}/config.toml` }));
    });
  });

  it("test_configEdit_rejectsShellSubstitution", () => {
    const profile = temp;
    writeFileSync(join(profile, "config.toml"), "[features]\nhooks = true\n");
    withEnv({ KEEL_CODEX_HOME: profile }, () => {
      expectProtected(payload("Bash", { command: `sed -i '' 's/true/false/' ${profile}/config.toml` }));
    });
  });

  it("test_sessionRecords_denyWritesDeletesAndMoves_butAllowReads", () => {
    const profile = temp;
    withEnv({ KEEL_CODEX_HOME: profile }, () => {
      for (const folder of ["sessions", "archived_sessions"]) {
        const target = join(profile, folder, "2026/10/16/review.jsonl");
        const calls = [
          payload("Write", { file_path: target, content: "forged" }),
          payload("Edit", { file_path: target, old_string: "fail", new_string: "pass" }),
        ];
        for (const command of [`printf forged > ${target}`, `rm ${target}`, `mv ${target} /tmp/moved-review`, `rm -rf ${join(profile, folder)}`,
          `rm -rf ${profile}/${folder.slice(0, 4)}*`, `rm -rf ${profile}/*`]) {
          calls.push(payload("Bash", { command }));
        }
        calls.push(...normalize(payload("apply_patch", { command: `*** Begin Patch\n*** Delete File: ${target}\n*** End Patch` })));
        for (const call of calls) expectProtected(call);
        protectAdapter(payload("Bash", { command: `cat ${target}` }));
      }
      protectAdapter(payload("Write", { file_path: join(profile, "sessions-notes.txt"), content: "ok" }));
    });
  });

  it("test_sessionRecords_denyGlobThroughSymlink", () => {
    const profile = join(temp, "profile");
    const records = join(profile, "sessions");
    mkdirSync(records, { recursive: true });
    writeFileSync(join(records, "review.jsonl"), "original");
    const aliases = join(temp, "aliases");
    mkdirSync(aliases);
    symlinkSync(records, join(aliases, "session-link"));
    withEnv({ KEEL_CODEX_HOME: profile }, () => {
      expectProtected(payload("Bash", { command: `rm ${aliases}/s*/review.jsonl` }));
    });
  });

  it("test_customProfile_protectsOsUserDefaultSessions", () => {
    withEnv({ KEEL_CODEX_HOME: join(temp, "custom"), HOME: join(temp, "fake") }, () => {
      for (const folder of ["sessions", "archived_sessions"]) {
        const call = payload("Write", { file_path: join(temp, ".codex", folder, "record.jsonl"), content: "forged" });
        assert.throws(() => protectAdapter(call, temp), ValueError);
      }
    });
  });

  it("test_badPayload_refusesRatherThanPassing", () => {
    for (const bad of [[], payload("Bash", {}), payload("apply_patch", { command: "bad" })]) {
      assert.throws(() => normalize(bad), ValueError, JSON.stringify(bad));
    }
  });

  it("test_guardFailure_returnsDenial", () => {
    const failed: CompletedProcess = { returncode: 2, stdout: "", stderr: "blocked by floor" };
    assert.throws(() => runGuard("git-guard", payload("Bash", { command: "git push" }), () => failed), { name: "ValueError", message: /blocked by floor/ });
  });

  it("test_invalidGuardResponse_isRefused", () => {
    for (const stdout of ["[]", '{"hookSpecificOutput": []}']) {
      const passed: CompletedProcess = { returncode: 0, stdout, stderr: "" };
      assert.throws(() => runGuard("git-guard", {}, () => passed), ValueError, stdout);
    }
  });

  it("test_guardWarning_isCollectedAsContext", () => {
    const passed: CompletedProcess = { returncode: 0, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: "warning" } }), stderr: "" };
    assert.deepEqual(runGuard("ship-gate", {}, () => passed), ["warning"]);
  });

  it("test_guardInput_isPythonJsonWithEscapedNonAscii", () => {
    const seen: string[] = [];
    runGuard("git-guard", { tool_name: "Bash", note: "é😀" }, (_command, input) => {
      seen.push(input);
      return { returncode: 0, stdout: "", stderr: "" };
    });
    assert.deepEqual(seen, ['{"tool_name": "Bash", "note": "\\u00e9\\ud83d\\ude00"}']);
  });

  it("test_hookMain_deniesWithPythonStyleReason_onMalformedJson", () => {
    const result = runHook(() => Buffer.from("{bad"));
    assert.equal(result.code, 0);
    assert.deepEqual(pythonJsonLoads(result.stdout), {
      hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: "deny",
        permissionDecisionReason: "keel Codex guard: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)",
      },
    });
  });

  it("test_realGuard_blocksForcePush_andAllowsRead", () => {
    spawnSync("git", ["init", "-q", temp], { stdio: "ignore" });
    const env = { ...process.env, KEEL_DATA_DIR: temp, KEEL_OVERLAY_DIR: temp };
    for (const [command, denied] of [["git push --force origin main", true], ["git status", false]] as const) {
      const input = JSON.stringify({ ...payload("Bash", { command }), cwd: temp });
      const run = runNode(HOOK, [], env, input);
      assert.equal(run.status, 0, run.stderr);
      if (denied) {
        const decision = (pythonJsonLoads(run.stdout) as Record<string, any>)["hookSpecificOutput"];
        assert.equal(decision["permissionDecision"], "deny");
        assert.ok(decision["permissionDecisionReason"].includes("F-force-push"));
      } else {
        assert.equal(run.stdout, "");
      }
    }
  });

  it("test_realGuard_blocksPatchToEvidenceStore", () => {
    const target = join(temp, "state/keel/evidence/forged.json");
    const env = { ...process.env, KEEL_DATA_DIR: temp, KEEL_OVERLAY_DIR: temp };
    const input = JSON.stringify(payload("apply_patch", { command: `*** Begin Patch\n*** Add File: ${target}\n+fake\n*** End Patch` }));
    const run = runNode(HOOK, [], env, input);
    assert.equal((pythonJsonLoads(run.stdout) as Record<string, any>)["hookSpecificOutput"]["permissionDecision"], "deny");
  });
});
