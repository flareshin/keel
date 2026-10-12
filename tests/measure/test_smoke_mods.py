from __future__ import annotations

import json
import os
import unittest

from helpers import read_text
from test_smoke import SmokeTestCase

MOD_HOOKS = json.dumps({"modules": ["./register.js"]})
HOOKS_ONLY = json.dumps({"hooks": {"PreToolUse": []}})


class ModTrustTest(SmokeTestCase):
    def plugin_dir(self, relative_path: str, hooks_json: str) -> str:
        self.box.write(os.path.join(relative_path, "hooks", "hooks.json"), hooks_json)
        return os.path.join(self.box.root, relative_path)

    def install(self, *plugins: tuple) -> None:
        self.box.install_plugins([{"id": plugin_id, "installPath": path} for plugin_id, path in plugins])

    def commit_overlay_mod(self) -> str:
        mod = self.plugin_dir("overlay/mods/own", MOD_HOOKS)
        self.box.write("overlay/mods/own/hooks/register.js", "module.exports = {};\n")
        self.box.init_repo(self.box.overlay, origin="https://example.invalid/example/keel-overlay.git")
        self.box.commit_all(self.box.overlay)
        return mod

    def linked_overlay_worktree(self) -> str:
        worktree = os.path.join(self.box.root, "overlay-wt")
        self.box.git(self.box.overlay, "worktree", "add", "-q", "--detach", worktree)
        return worktree

    def test_modTrust_failsListingTheId_whenAnInstalledModIsUnreviewed(self) -> None:
        # given
        self.install(("a-mod@market", self.plugin_dir("plugins/a-mod", MOD_HOOKS)))
        # when
        item = self.assertStatus("mod-trust", "all", "FAIL", "unreviewed mods: a-mod@market")
        # then
        self.assertIn("claude plugin validate", item["detail"])
        self.assertIn("reviewed-mods.txt", item["detail"])

    def test_modTrust_passesAfterAskingTheCliForJson_whenTheModIdIsInTheReviewedList(self) -> None:
        # given
        self.install(("a-mod@market", self.plugin_dir("plugins/a-mod", MOD_HOOKS)))
        self.box.write("overlay/reviewed-mods.txt", "# read with claude plugin validate\na-mod@market\n")
        # when
        self.assertStatus("mod-trust", "all", "PASS", "no unreviewed mod among 1 plugins")
        # then
        self.assertEqual(read_text(os.path.join(self.box.root, "stubs", "claude.calls")), "plugin list --json\n")

    def test_modTrust_ignoresPlugins_whoseHooksJsonListsNoModulesOrIsAbsent(self) -> None:
        # given
        self.install(
            ("hooks-only@market", self.plugin_dir("plugins/hooks-only", HOOKS_ONLY)),
            ("empty-modules@market", self.plugin_dir("plugins/empty-modules", json.dumps({"modules": []}))),
            ("no-hooks@market", os.path.join(self.box.root, "plugins", "no-hooks")),
        )
        # then
        self.assertStatus("mod-trust", "all", "PASS", "no unreviewed mod among 3 plugins")

    def test_modTrust_countsAPluginAsAMod_whenItsHooksJsonDoesNotParse(self) -> None:
        # given
        self.install(("broken@market", self.plugin_dir("plugins/broken", '{"modules": ["./r.js"],}')))
        # then
        self.assertStatus("mod-trust", "all", "FAIL", "unreviewed mods: broken@market")

    def test_modTrust_passes_forACommittedCleanOverlayModReachedThroughALink(self) -> None:
        # given
        mod = self.commit_overlay_mod()
        os.makedirs(os.path.join(self.box.data, "mods"))
        os.symlink(mod, os.path.join(self.box.data, "mods", "own"))
        self.install(("own@inline", os.path.join(self.box.data, "mods", "own")))
        # then
        self.assertStatus("mod-trust", "all", "PASS", "no unreviewed mod among 1 plugins")

    def test_modTrust_passes_forAModCommittedInTheMainOverlay_whenTheOverlayDirIsALinkedWorktree(self) -> None:
        # given
        mod = self.commit_overlay_mod()
        self.box.env["KEEL_OVERLAY_DIR"] = self.linked_overlay_worktree()
        self.install(("own@inline", mod))
        # then
        self.assertStatus("mod-trust", "all", "PASS", "no unreviewed mod among 1 plugins")

    def test_modTrust_fails_whenTheMainOverlayModHasAnUncommittedChange_andTheOverlayDirIsALinkedWorktree(self) -> None:
        # given
        mod = self.commit_overlay_mod()
        self.box.env["KEEL_OVERLAY_DIR"] = self.linked_overlay_worktree()
        self.box.write("overlay/mods/own/hooks/register.js", "module.exports = {changed: true};\n")
        self.install(("own@inline", mod))
        # then
        self.assertStatus("mod-trust", "all", "FAIL", "unreviewed mods: own@inline")

    def test_modTrust_fails_forAModInstalledFromTheLinkedOverlayWorktree(self) -> None:
        # given: installed mods link from the main overlay, so a mod inside the linked worktree is not the reviewed one
        self.commit_overlay_mod()
        worktree = self.linked_overlay_worktree()
        self.box.env["KEEL_OVERLAY_DIR"] = worktree
        self.install(("own@inline", os.path.join(worktree, "mods", "own")))
        # then
        self.assertStatus("mod-trust", "all", "FAIL", "unreviewed mods: own@inline")

    def test_modTrust_fails_forAModInsideTheOverlay_whenTheOverlayIsNotAGitRepo(self) -> None:
        # given
        self.box.write("overlay/mods/own/hooks/register.js", "module.exports = {};\n")
        self.install(("own@inline", self.plugin_dir("overlay/mods/own", MOD_HOOKS)))
        # then
        self.assertStatus("mod-trust", "all", "FAIL", "unreviewed mods: own@inline")

    def test_modTrust_fails_whenTheOverlayModHasAnUncommittedChange(self) -> None:
        # given
        mod = self.commit_overlay_mod()
        self.box.write("overlay/mods/own/hooks/hooks.json", json.dumps({"modules": ["./register.js", "./extra.js"]}))
        self.install(("own@inline", mod))
        # then
        self.assertStatus("mod-trust", "all", "FAIL", "unreviewed mods: own@inline")

    def test_modTrust_fails_whenTheOverlayModGainsAnUntrackedFile(self) -> None:
        # given
        mod = self.commit_overlay_mod()
        self.box.write("overlay/mods/own/extra.js", "module.exports = {};\n")
        self.install(("own@inline", mod))
        # then
        self.assertStatus("mod-trust", "all", "FAIL", "unreviewed mods: own@inline")

    def test_modTrust_fails_whenTheOverlayModIsIgnoredAndSoNeverCommitted(self) -> None:
        # given
        self.box.init_repo(self.box.overlay, origin="https://example.invalid/example/keel-overlay.git")
        self.box.write("overlay/.gitignore", "mods/\n")
        self.box.commit_all(self.box.overlay)
        self.install(("own@inline", self.plugin_dir("overlay/mods/own", MOD_HOOKS)))
        # then
        self.assertStatus("mod-trust", "all", "FAIL", "unreviewed mods: own@inline")

    def test_modTrust_fails_whenTheCommittedOverlayModListsAnIgnoredModule(self) -> None:
        # given: hooks.json is committed, the module it names is an ignored build output
        self.box.init_repo(self.box.overlay, origin="https://example.invalid/example/keel-overlay.git")
        mod = self.plugin_dir("overlay/mods/own", json.dumps({"modules": ["./dist/register.js"]}))
        self.box.write("overlay/mods/own/.gitignore", "dist/\n")
        self.box.commit_all(self.box.overlay)
        self.box.write("overlay/mods/own/hooks/dist/register.js", "module.exports = {};\n")
        self.install(("own@inline", mod))
        # then
        self.assertStatus("mod-trust", "all", "FAIL", "unreviewed mods: own@inline")

    def test_modTrust_countsAPluginAsAMod_whenItsModulesIsAnObject(self) -> None:
        # given
        self.install(("odd@market", self.plugin_dir("plugins/odd", json.dumps({"modules": {}}))))
        # then
        self.assertStatus("mod-trust", "all", "FAIL", "unreviewed mods: odd@market")

    def test_modTrust_countsAPluginAsAMod_whenItsModulesIsNull(self) -> None:
        # given
        self.install(("odd@market", self.plugin_dir("plugins/odd", json.dumps({"modules": None}))))
        # then
        self.assertStatus("mod-trust", "all", "FAIL", "unreviewed mods: odd@market")

    def test_modTrust_countsAPluginAsAMod_whenItsHooksJsonIsNotAnObject(self) -> None:
        # given
        self.install(("odd@market", self.plugin_dir("plugins/odd", "[]")))
        # then
        self.assertStatus("mod-trust", "all", "FAIL", "unreviewed mods: odd@market")

    def test_modTrust_doesNotExempt_aCommittedModReachedByTraversingOutOfTheOverlay(self) -> None:
        # given: the overlay is a subdirectory of a repo that also tracks a clean mod beside it
        repo = os.path.join(self.box.root, "outer")
        self.box.write("outer/overlay/README.md", "Overlay.\n")
        self.plugin_dir("outer/beside", MOD_HOOKS)
        self.box.write("outer/beside/hooks/register.js", "module.exports = {};\n")
        self.box.init_repo(repo, origin="https://example.invalid/example/outer.git")
        self.box.commit_all(repo)
        self.box.env["KEEL_OVERLAY_DIR"] = os.path.join(repo, "overlay")
        self.install(("beside@inline", os.path.join(repo, "overlay", "..", "beside")))
        # then
        self.assertStatus("mod-trust", "all", "FAIL", "unreviewed mods: beside@inline")

    def test_modTrust_doesNotExempt_aCommittedModBesideTheOverlay_whenTheOverlayDirIsASubdirectoryOfALinkedWorktree(self) -> None:
        # given: the main worktree tracks a clean mod beside the overlay subdirectory
        repo = os.path.join(self.box.root, "outer")
        self.box.write("outer/overlay/README.md", "Overlay.\n")
        self.plugin_dir("outer/beside", MOD_HOOKS)
        self.box.write("outer/beside/hooks/register.js", "module.exports = {};\n")
        self.box.init_repo(repo, origin="https://example.invalid/example/outer.git")
        self.box.commit_all(repo)
        worktree = os.path.join(self.box.root, "outer-wt")
        self.box.git(repo, "worktree", "add", "-q", "--detach", worktree)
        self.box.env["KEEL_OVERLAY_DIR"] = os.path.join(worktree, "overlay")
        self.install(("beside@inline", os.path.join(repo, "beside")))
        # then
        self.assertStatus("mod-trust", "all", "FAIL", "unreviewed mods: beside@inline")

    def test_modTrust_warns_whenTheClaudeCliIsMissing(self) -> None:
        # given
        os.remove(self.box.claude_stub)
        # then
        self.assertStatus("mod-trust", "all", "WARN", "mod check could not run: ")

    def test_modTrust_warns_whenTheCliExitsNonZero_evenWithAParsableList(self) -> None:
        # given
        self.box.write("stubs/claude", "#!/bin/bash\necho '[]'\necho 'unknown command' >&2\nexit 1\n", executable=True)
        # then
        self.assertStatus("mod-trust", "all", "WARN", "mod check could not run: ")

    def test_modTrust_warns_whenThePluginListIsNotJson(self) -> None:
        # given
        self.box.write("stubs/plugins.json", "Installed plugins:\n  a-mod@market\n")
        # then
        self.assertStatus("mod-trust", "all", "WARN", "mod check could not run: ")

    def test_modTrust_warns_whenAPluginEntryHasNoInstallPath(self) -> None:
        # given
        self.box.write("stubs/plugins.json", json.dumps([{"id": "a-mod@market", "path": "/somewhere"}]))
        # then
        self.assertStatus("mod-trust", "all", "WARN", "mod check could not run: ")


if __name__ == "__main__":
    unittest.main()
