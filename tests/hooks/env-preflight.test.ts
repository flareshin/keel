import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { join } from "node:path";
import { assertBulletIdsSeeded, assertFired, bash, ENV_PREFLIGHT, HookSandbox } from "./helpers.ts";
import type { HookResult } from "./helpers.ts";

const PIN_17 = "JAVA_HOME=$(/usr/libexec/java_home -v 17)";
const RUN_YOURSELF = "Run it yourself in your terminal: ";
const ASK_USER = "Stop and ask the user.";
const ON_MACOS = process.platform === "darwin";
const MACOS_ONLY = { skip: ON_MACOS ? false : "the retry command pins the JDK through macOS java_home" };

let sandbox: HookSandbox;
let repo: string;

beforeEach(() => {
  sandbox = new HookSandbox();
  sandbox.useExampleOverlay("stack-data/spring-maven/jdk.tsv");
  repo = sandbox.makeRepo("acmecorp", "billing");
});

afterEach(() => {
  sandbox.close();
});

function check(command: string, cwd: string = repo): HookResult {
  return sandbox.runHook(ENV_PREFLIGHT, { payload: bash(command, cwd) });
}

function assertDenied(result: HookResult): void {
  assert.equal(result.code, 2, result.stderr);
  assert.ok(result.stderr.startsWith("[S-jdk] env-preflight: mvn in acmecorp/billing must run on JDK 17"), result.stderr);
  assertBulletIdsSeeded(result.stderr);
}

function assertLastLine(result: HookResult, expected: string): void {
  const lines = result.stderr.replace(/\n+$/, "").split("\n");
  assert.equal(lines[lines.length - 1], expected, result.stderr);
}

function assertPassed(result: HookResult): void {
  assert.equal(result.code, 0, result.stderr);
}

describe("DenyTest", () => {
  it("mvn_deniedWithFire_whenNoJavaHome", () => {
    assertDenied(check("mvn -q test"));
    assertFired(sandbox, "S-jdk", "deny", "env-preflight");
  });

  it("mvnDeny_endsWithThePrefixedRetryCommand_whenNoJavaHome", MACOS_ONLY, () => {
    assertLastLine(check("mvn -q test"), RUN_YOURSELF + PIN_17 + " mvn -q test");
  });

  it("mvnDeny_endsWithAnExportRetryCommand_whenMvnIsNotTheFirstCommand", MACOS_ONLY, () => {
    const result = check(`${PIN_17} cd . && mvn test`);
    assertLastLine(result, RUN_YOURSELF + `export ${PIN_17}; ${PIN_17} cd . && mvn test`);
  });

  it("mvnDeny_endsWithTheAssignmentReplaced_whenPrefixNamesOtherJdk", MACOS_ONLY, () => {
    const result = check("JAVA_HOME=$(/usr/libexec/java_home -v 21) mvn test");
    assertLastLine(result, RUN_YOURSELF + PIN_17 + " mvn test");
  });

  it("mvnDeny_endsWithAskUser_whenNoRewriteOfTheLinePinsTheJdk", () => {
    assertLastLine(check(`export ${PIN_17} && env -i PATH=$PATH mvn test`), ASK_USER);
  });

  it("mvn_deniedWithReplaceHint_whenPrefixNamesOtherJdk", () => {
    const result = check("JAVA_HOME=$(/usr/libexec/java_home -v 21) mvn test");
    assertDenied(result);
    assert.match(result.stderr, /replace its value/);
  });

  it("mvn_denied_whenPathNamesPatchVersionSeventeen", () => {
    assertDenied(check("JAVA_HOME=/opt/jdk-11.0.17 mvn test"));
  });

  it("mvn_denied_whenAssignmentNotExported", () => {
    assertDenied(check("JAVA_HOME=/opt/jdk-17; mvn test"));
  });

  it("mvn_deniedWithPlacementHint_whenPrefixSitsOnCd", () => {
    const result = check(`${PIN_17} cd . && mvn test`);
    assertDenied(result);
    assert.match(result.stderr, /right before mvn/);
  });

  it("mvn_deniedWithWrapperHint_whenEnvDropsExport", () => {
    const result = check(`export ${PIN_17} && env -i PATH=$PATH mvn test`);
    assertDenied(result);
    assert.match(result.stderr, /drops the inherited environment/);
  });

  it("mvn_denied_whenUnsetAfterExport", () => {
    assertDenied(check(`export ${PIN_17}; unset JAVA_HOME; mvn test`));
  });

  it("mvn_denied_whenInsideBashDashC", () => {
    assertDenied(check("bash -c 'mvn test'"));
  });

  it("mvn_deniedWithFire_whenAWrapperOptionTheParserReadsPastKeepsTheDirectory", () => {
    const commands = ["sudo -nE mvn test", "timeout --bogus 60 mvn test", "sudo -nC3 mvn test", "sudo -nuDavid mvn test",
      "env -iv mvn test", "env -iuCFLAGS mvn test", "env -P/opt/homebrew/Cellar/maven/bin mvn test"];
    for (const command of commands) assertDenied(check(command));
    assertFired(sandbox, "S-jdk", "deny", "env-preflight");
  });

  it("mvn_denied_whenCdIntoListedRepoFromElsewhere", () => {
    assertDenied(check(`cd ${repo} && ./mvnw verify`, sandbox.root));
  });
});

describe("PassTest", () => {
  it("mvn_passesWithFire_whenPrefixPinsJdk", () => {
    assertPassed(check(`${PIN_17} mvn -q test`));
    assertFired(sandbox, "S-jdk", "pass", "env-preflight");
  });

  it("mvnw_passes_whenPrefixIsJdkPath", () => {
    assertPassed(check("JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home ./mvnw verify"));
  });

  it("mvn_passes_whenVendorWordSpellsIWithDottedOrDotlessI", () => {
    assertPassed(check("JAVA_HOME=/opt/temur\u0130n-17 mvn test"));
    assertPassed(check("JAVA_HOME=/opt/temur\u0131n-17 mvn test"));
  });

  it("mvn_passes_whenExportedBefore", () => {
    assertPassed(check(`export ${PIN_17} && mvn test`));
  });

  it("mvn_passes_whenJavaHomeLookupNamesAPatchReleaseOfTheRequiredMajor", () => {
    assertPassed(check("export JAVA_HOME=$(/usr/libexec/java_home -v 17.0.20); mvn -o -q compile"));
    assertPassed(check("JAVA_HOME=$(/usr/libexec/java_home --version=17.0.2) mvn test"));
  });

  it("mvn_denied_whenJavaHomeLookupNamesAnOpenRangeOrAnotherMajor", () => {
    assertDenied(check("JAVA_HOME=$(/usr/libexec/java_home -v 17.0.20+) mvn test"));
    assertDenied(check("JAVA_HOME=$(/usr/libexec/java_home -v 17.0.*) mvn test"));
    assertDenied(check("JAVA_HOME=$(/usr/libexec/java_home -v 170.0.1) mvn test"));
    assertDenied(check("JAVA_HOME=$(/usr/libexec/java_home -v 17.) mvn test"));
  });

  it("mvn_passes_whenPrefixReferencesEarlierVariable", () => {
    assertPassed(check("J=$(/usr/libexec/java_home -v 17); JAVA_HOME=$J mvn test"));
  });

  it("mvn_passes_whenAssignmentFollowsClearingWrapper", () => {
    assertPassed(check(`env -i PATH=$PATH ${PIN_17} mvn test`));
  });

  it("mvn_passes_whenPrefixedWrapper", () => {
    assertPassed(check(`${PIN_17} nohup mvn test > build.log 2>&1`));
  });

  it("versionQuery_passesWithoutFire", () => {
    assertPassed(check("mvn -v"));
    assert.deepEqual(sandbox.fires(), []);
  });

  it("mvnAsData_passesWithoutFire", () => {
    assertPassed(check('grep mvn pom.xml; echo "mvn test"'));
    assert.deepEqual(sandbox.fires(), []);
  });

  it("mvn_passesWithoutFire_whenRepoUnlisted", () => {
    const other = sandbox.makeRepo("example", "app");
    assertPassed(check("mvn test", other));
    assert.deepEqual(sandbox.fires(), []);
  });

  it("mvn_passesWithoutFire_whenAWrapperRunsItInADirectoryTheHookCannotRead", () => {
    const commands = ["sudo -D /tmp mvn test", "sudo --chdir /tmp mvn test", "env --chdir=/tmp mvn test", "env -C/tmp mvn test",
      "env -iC/tmp mvn test", "sudo -i mvn test", "sudo --login mvn test", "sudo --chdir=/tmp mvn test", "sudo -nD/tmp mvn test",
      "sudo -R/srv mvn test", "sudo --chroot=/srv mvn test", "env -S'-C /tmp' mvn test", "env -SX=1 mvn test", "env -S -i mvn test",
      "env --split-string=X=1 mvn test"];
    for (const command of commands) assertPassed(check(command));
    assert.deepEqual(sandbox.fires(), []);
  });

  it("mvn_passes_whenNoOverlayData", () => {
    rmSync(join(sandbox.overlay, "stack-data", "spring-maven", "jdk.tsv"));
    assertPassed(check("mvn test"));
  });
});

describe("SubmoduleTest", () => {
  it("mvn_denied_whenSubmoduleOfListedSuperproject", () => {
    const module = sandbox.makeRepo("example", "module");
    sandbox.git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "module");
    assertDenied(check("mvn test", join(repo, "module")));
  });
});

describe("FailureTest", () => {
  it("envPreflight_passesAndLogsError_whenOverlayHeaderWrong", () => {
    sandbox.write(join(sandbox.overlay, "stack-data", "spring-maven", "jdk.tsv"), "repo\tversion\n");
    assertPassed(check("mvn test"));
    assertFired(sandbox, "S-jdk", "error", "env-preflight");
  });

  it("envPreflight_passes_whenPayloadIsNotJson", () => {
    assert.equal(sandbox.runHook(ENV_PREFLIGHT, { raw: "mvn" }).code, 0);
  });
});

describe("JdkMapGlobTest", () => {
  it("mvn_passesWithErrorFire_whenAJdkMapGlobHasABackwardsRange", () => {
    sandbox.write(join(sandbox.overlay, "stack-data", "spring-maven", "jdk.tsv"), "origin_glob\tjdk\nacmecorp/[z-a]\t17\n");
    assertPassed(check("mvn -q test"));
    assertFired(sandbox, "S-jdk", "error", "env-preflight");
  });
});
