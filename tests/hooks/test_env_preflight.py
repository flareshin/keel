import os
import platform
import unittest

import helpers
from helpers import ENV_PREFLIGHT, bash

PIN_17 = "JAVA_HOME=$(/usr/libexec/java_home -v 17)"
RUN_YOURSELF = "Run it yourself in your terminal: "
ASK_USER = "Stop and ask the user."
ON_MACOS = platform.system() == "Darwin"


class EnvPreflightTestCase(helpers.SandboxTestCase):
    def setUp(self):
        super().setUp()
        self.sandbox.use_example_overlay("stack-data/spring-maven/jdk.tsv")
        self.repo = self.sandbox.make_repo("acmecorp", "billing")

    def check(self, command, cwd=None):
        return self.sandbox.run_hook(ENV_PREFLIGHT, bash(command, cwd or self.repo))

    def assertDenied(self, result):
        self.assertEqual(2, result.code, result.stderr)
        self.assertTrue(result.stderr.startswith("[S-jdk] env-preflight: mvn in acmecorp/billing must run on JDK 17"), result.stderr)
        self.assertBulletIdsSeeded(result.stderr)

    def assertLastLine(self, result, expected):
        self.assertEqual(expected, result.stderr.rstrip("\n").splitlines()[-1], result.stderr)

    def assertPassed(self, result):
        self.assertEqual(0, result.code, result.stderr)


class DenyTest(EnvPreflightTestCase):
    def test_mvn_deniedWithFire_whenNoJavaHome(self):
        # when
        result = self.check("mvn -q test")
        # then
        self.assertDenied(result)
        self.assertFired("S-jdk", "deny", "env-preflight")

    @unittest.skipUnless(ON_MACOS, "the retry command pins the JDK through macOS java_home")
    def test_mvnDeny_endsWithThePrefixedRetryCommand_whenNoJavaHome(self):
        result = self.check("mvn -q test")
        self.assertLastLine(result, RUN_YOURSELF + PIN_17 + " mvn -q test")

    @unittest.skipUnless(ON_MACOS, "the retry command pins the JDK through macOS java_home")
    def test_mvnDeny_endsWithAnExportRetryCommand_whenMvnIsNotTheFirstCommand(self):
        result = self.check("%s cd . && mvn test" % PIN_17)
        self.assertLastLine(result, RUN_YOURSELF + "export %s; %s cd . && mvn test" % (PIN_17, PIN_17))

    @unittest.skipUnless(ON_MACOS, "the retry command pins the JDK through macOS java_home")
    def test_mvnDeny_endsWithTheAssignmentReplaced_whenPrefixNamesOtherJdk(self):
        result = self.check("JAVA_HOME=$(/usr/libexec/java_home -v 21) mvn test")
        self.assertLastLine(result, RUN_YOURSELF + PIN_17 + " mvn test")

    def test_mvnDeny_endsWithAskUser_whenNoRewriteOfTheLinePinsTheJdk(self):
        result = self.check("export %s && env -i PATH=$PATH mvn test" % PIN_17)
        self.assertLastLine(result, ASK_USER)

    def test_mvn_deniedWithReplaceHint_whenPrefixNamesOtherJdk(self):
        result = self.check("JAVA_HOME=$(/usr/libexec/java_home -v 21) mvn test")
        self.assertDenied(result)
        self.assertIn("replace its value", result.stderr)

    def test_mvn_denied_whenPathNamesPatchVersionSeventeen(self):
        self.assertDenied(self.check("JAVA_HOME=/opt/jdk-11.0.17 mvn test"))

    def test_mvn_denied_whenAssignmentNotExported(self):
        self.assertDenied(self.check("JAVA_HOME=/opt/jdk-17; mvn test"))

    def test_mvn_deniedWithPlacementHint_whenPrefixSitsOnCd(self):
        result = self.check("%s cd . && mvn test" % PIN_17)
        self.assertDenied(result)
        self.assertIn("right before mvn", result.stderr)

    def test_mvn_deniedWithWrapperHint_whenEnvDropsExport(self):
        result = self.check("export %s && env -i PATH=$PATH mvn test" % PIN_17)
        self.assertDenied(result)
        self.assertIn("drops the inherited environment", result.stderr)

    def test_mvn_denied_whenUnsetAfterExport(self):
        self.assertDenied(self.check("export %s; unset JAVA_HOME; mvn test" % PIN_17))

    def test_mvn_denied_whenInsideBashDashC(self):
        self.assertDenied(self.check("bash -c 'mvn test'"))

    def test_mvn_deniedWithFire_whenAWrapperOptionTheParserReadsPastKeepsTheDirectory(self):
        for command in ("sudo -nE mvn test", "timeout --bogus 60 mvn test", "sudo -nC3 mvn test", "sudo -nuDavid mvn test",
                        "env -iv mvn test", "env -iuCFLAGS mvn test"):
            with self.subTest(command=command):
                self.assertDenied(self.check(command))
        self.assertFired("S-jdk", "deny", "env-preflight")

    def test_mvn_denied_whenCdIntoListedRepoFromElsewhere(self):
        self.assertDenied(self.check("cd %s && ./mvnw verify" % self.repo, cwd=self.sandbox.root))


class PassTest(EnvPreflightTestCase):
    def test_mvn_passesWithFire_whenPrefixPinsJdk(self):
        result = self.check("%s mvn -q test" % PIN_17)
        self.assertPassed(result)
        self.assertFired("S-jdk", "pass", "env-preflight")

    def test_mvnw_passes_whenPrefixIsJdkPath(self):
        self.assertPassed(self.check("JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home ./mvnw verify"))

    def test_mvn_passes_whenExportedBefore(self):
        self.assertPassed(self.check("export %s && mvn test" % PIN_17))

    def test_mvn_passes_whenPrefixReferencesEarlierVariable(self):
        self.assertPassed(self.check("J=$(/usr/libexec/java_home -v 17); JAVA_HOME=$J mvn test"))

    def test_mvn_passes_whenAssignmentFollowsClearingWrapper(self):
        self.assertPassed(self.check("env -i PATH=$PATH %s mvn test" % PIN_17))

    def test_mvn_passes_whenPrefixedWrapper(self):
        self.assertPassed(self.check("%s nohup mvn test > build.log 2>&1" % PIN_17))

    def test_versionQuery_passesWithoutFire(self):
        self.assertPassed(self.check("mvn -v"))
        self.assertEqual([], self.sandbox.fires())

    def test_mvnAsData_passesWithoutFire(self):
        self.assertPassed(self.check("grep mvn pom.xml; echo \"mvn test\""))
        self.assertEqual([], self.sandbox.fires())

    def test_mvn_passesWithoutFire_whenRepoUnlisted(self):
        other = self.sandbox.make_repo("example", "app")
        self.assertPassed(self.check("mvn test", cwd=other))
        self.assertEqual([], self.sandbox.fires())

    def test_mvn_passesWithoutFire_whenAWrapperRunsItInADirectoryTheHookCannotRead(self):
        for command in ("env --chdir=/tmp mvn test", "env -C/tmp mvn test", "env -iC/tmp mvn test", "sudo -i mvn test",
                        "sudo --login mvn test", "sudo --chdir=/tmp mvn test", "sudo -nD/tmp mvn test", "sudo -R/srv mvn test",
                        "sudo --chroot=/srv mvn test"):
            with self.subTest(command=command):
                self.assertPassed(self.check(command))
        self.assertEqual([], self.sandbox.fires())

    def test_mvn_passes_whenNoOverlayData(self):
        os.remove(os.path.join(self.sandbox.overlay, "stack-data", "spring-maven", "jdk.tsv"))
        self.assertPassed(self.check("mvn test"))


class SubmoduleTest(EnvPreflightTestCase):
    def test_mvn_denied_whenSubmoduleOfListedSuperproject(self):
        # given
        module = self.sandbox.make_repo("example", "module")
        self.sandbox.git(self.repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "module")
        # when
        result = self.check("mvn test", cwd=os.path.join(self.repo, "module"))
        # then
        self.assertDenied(result)


class FailureTest(EnvPreflightTestCase):
    def test_envPreflight_passesAndLogsError_whenOverlayHeaderWrong(self):
        self.sandbox.write(os.path.join(self.sandbox.overlay, "stack-data", "spring-maven", "jdk.tsv"), "repo\tversion\n")
        result = self.check("mvn test")
        self.assertPassed(result)
        self.assertFired("S-jdk", "error", "env-preflight")

    def test_envPreflight_passes_whenPayloadIsNotJson(self):
        self.assertEqual(0, self.sandbox.run_hook(ENV_PREFLIGHT, raw="mvn").code)


if __name__ == "__main__":
    unittest.main()
