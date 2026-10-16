import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ADAPTER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADAPTER / 'lib'))
import install

spec = importlib.util.spec_from_file_location('codex_hook', ADAPTER / 'hooks/pre-tool-use.py')
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


class InstallationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.env = dict(os.environ, HOME=str(self.home), KEEL_OVERLAY_DIR=str(self.home / 'overlay'),
                        KEEL_DATA_DIR=str(self.home / 'data'))
        self.env.pop('CODEX_HOME', None)

    def run_link(self, *args):
        return subprocess.run([sys.executable, str(ADAPTER / 'bin/link'), '--home', str(self.home), *args],
                              capture_output=True, text=True, env=self.env)

    def test_dryRun_doesNotWrite_home(self):
        run = self.run_link()
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertFalse((self.home / '.codex').exists())
        self.assertTrue(json.loads(run.stdout)['actions'])

    def test_install_isIdempotent_andUnlinksOwnedFiles(self):
        run = self.run_link('--write')
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue((self.home / '.agents/skills/readable-code/SKILL.md').is_file())
        self.assertIn('Codex runtime', (self.home / '.codex/AGENTS.md').read_text())
        self.assertEqual(self.run_link('--check').returncode, 0)
        self.assertEqual(json.loads(self.run_link('--write').stdout)['actions'], [])
        self.assertEqual(self.run_link('--unlink').returncode, 0)
        self.assertFalse((self.home / '.codex/AGENTS.md').exists())
        self.assertFalse((self.home / '.agents/skills/readable-code').exists())

    def test_conflict_preservesExistingInstructions_andWritesNothing(self):
        target = self.home / '.codex/AGENTS.md'
        target.parent.mkdir()
        target.write_text('owner instructions')
        self.assertEqual(self.run_link('--write').returncode, 3)
        self.assertEqual(target.read_text(), 'owner instructions')
        self.assertFalse((target.parent / 'hooks.json').exists())

    def test_refresh_refusesHandEditedManagedFile(self):
        self.assertEqual(self.run_link('--write').returncode, 0)
        target = self.home / '.codex/AGENTS.md'
        target.write_text('owner edit')
        self.assertEqual(self.run_link('--write').returncode, 3)
        self.assertEqual(self.run_link('--unlink').returncode, 3)
        self.assertEqual(target.read_text(), 'owner edit')

    def test_existingEquivalentSkill_survivesUnlink(self):
        skill = self.home / '.agents/skills/readable-code'
        skill.parent.mkdir(parents=True)
        skill.symlink_to(ADAPTER.parent / 'skills/readable-code')
        self.assertEqual(self.run_link('--write').returncode, 0)
        self.assertEqual(self.run_link('--unlink').returncode, 0)
        self.assertTrue(skill.is_symlink())

    def test_customCodexHome_preservesConfig_andIncludesPersonal(self):
        profile = self.home / 'custom codex'
        profile.mkdir()
        (profile / 'config.toml').write_text('model = "owner-model"\n')
        overlay = self.home / 'overlay'
        overlay.mkdir()
        (overlay / 'PERSONAL.md').write_text('Talk to the owner in Korean.\n')
        self.env['CODEX_HOME'] = str(profile)
        self.assertEqual(self.run_link('--write').returncode, 0)
        self.assertIn('Talk to the owner in Korean.', (profile / 'AGENTS.md').read_text())
        self.assertEqual((profile / 'config.toml').read_text(), 'model = "owner-model"\n')
        self.assertFalse((self.home / '.codex').exists())

    def test_duplicateSkills_refuseBeforeWriting(self):
        overlay = self.home / 'overlay/skills/readable-code'
        overlay.mkdir(parents=True)
        (overlay / 'SKILL.md').write_text('duplicate')
        self.assertEqual(self.run_link('--write').returncode, 3)
        self.assertFalse((self.home / '.codex').exists())

    def test_sharedSkills_surviveUntilLastProfileUnlinks(self):
        first = str(self.home / 'profile-a')
        second = str(self.home / 'profile-b')
        self.env['CODEX_HOME'] = first
        self.assertEqual(self.run_link('--write').returncode, 0)
        self.env['CODEX_HOME'] = second
        self.assertEqual(self.run_link('--write').returncode, 0)
        self.env['CODEX_HOME'] = first
        self.assertEqual(self.run_link('--unlink').returncode, 0)
        self.env['CODEX_HOME'] = second
        self.assertEqual(self.run_link('--check').returncode, 0)
        self.assertTrue((self.home / '.agents/skills/readable-code/SKILL.md').exists())
        self.assertEqual(self.run_link('--unlink').returncode, 0)
        self.assertFalse((self.home / '.agents/skills/readable-code').is_symlink())

    def test_unlink_doesNotRequireCurrentSourceInventory(self):
        self.assertEqual(self.run_link('--write').returncode, 0)
        duplicate = self.home / 'overlay/skills/readable-code'
        duplicate.mkdir(parents=True)
        (duplicate / 'SKILL.md').write_text('duplicate')
        self.assertEqual(self.run_link('--unlink').returncode, 0)

    def test_concurrentProfiles_keepBothReferences(self):
        processes = []
        profiles = [self.home / 'a', self.home / 'b']
        for profile in profiles:
            processes.append(subprocess.Popen(
                [sys.executable, str(ADAPTER / 'bin/link'), '--home', str(self.home), '--write'],
                env=dict(self.env, CODEX_HOME=str(profile)), stdout=subprocess.PIPE, stderr=subprocess.PIPE))
        for process in processes:
            out, error = process.communicate(timeout=30)
            self.assertEqual(process.returncode, 0, error)
        registry = json.loads((self.home / '.agents/keel-codex-skills.json').read_text())
        self.assertEqual(set(registry['skills']['readable-code']['profiles']), {str(p.resolve()) for p in profiles})

    def test_legacyOwnership_preservesSkillOnUnlink(self):
        self.assertEqual(self.run_link('--write').returncode, 0)
        state_path = self.home / '.codex/keel-codex-state.json'
        state = json.loads(state_path.read_text())
        state.pop('skills_home')
        skill = self.home / '.agents/skills/readable-code'
        state['owned'][str(skill)] = install.fingerprint(skill)
        state_path.write_text(json.dumps(state))
        (self.home / '.agents/keel-codex-skills.json').unlink()
        self.assertEqual(self.run_link('--write').returncode, 0)
        self.assertEqual(self.run_link('--unlink').returncode, 0)
        self.assertTrue(skill.is_symlink())


class ConfigTest(unittest.TestCase):
    def test_updater_preservesHooksAndMode(self):
        with tempfile.TemporaryDirectory() as temp:
            profile = Path(temp)
            config = profile / 'config.toml'
            config.write_text('[features]\nhooks = true\n')
            config.chmod(0o600)
            candidate = profile / 'candidate.toml'
            candidate.write_text('model = "new-model"\n[features]\nhooks = true\n')
            run = subprocess.run([sys.executable, str(ADAPTER / 'bin/config'), '--profile', temp,
                                  '--file', str(candidate)], capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(config.read_text(), candidate.read_text())
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)

    def test_policy_parsesCompleteToml(self):
        from config_policy import validate_update
        for candidate in ('[features]\n"hooks" = false', 'features = {hooks = false}',
                          'allow_managed_hooks_only = true', 'hooks = {enabled = false}', 'bad ['):
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                validate_update('[features]\nhooks = true', candidate)
        validate_update('', '# hooks = false\nmodel = "safe"')

    def test_exactEditAndPartialPatch_areChecked(self):
        from config_policy import complete_edit, validate_update
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / 'config.toml'
            config.write_text('[features]\nhooks = true')
            candidate = complete_edit(config, {'old_string': 'true', 'new_string': 'false'})
            with self.assertRaises(ValueError):
                validate_update(config.read_text(), candidate)
            with self.assertRaises(ValueError):
                complete_edit(config, {'keel_partial': True, 'content': 'model = "safe"'})


class GuardTest(unittest.TestCase):
    def payload(self, name, tool):
        return {'tool_name': name, 'tool_input': tool, 'hook_event_name': 'PreToolUse',
                'cwd': '/tmp', 'session_id': 'codex-test'}

    def test_shell_preservesCommand(self):
        payload = self.payload('Bash', {'command': 'git status'})
        self.assertEqual(hook.normalize(payload), [payload])

    def test_patch_checksEveryPath_includingMoveAndDelete(self):
        patch_text = ('*** Begin Patch\n*** Update File: a.py\n*** Move to: b.py\n'
                      '@@\n-old\n+new\n*** Delete File: c.py\n*** Add File: d.py\n+x\n*** End Patch')
        calls = hook.normalize(self.payload('apply_patch', {'command': patch_text}))
        self.assertEqual([c['tool_input']['file_path'] for c in calls], ['a.py', 'b.py', 'c.py', 'd.py'])
        self.assertEqual(calls[1]['tool_input']['content'], 'new')

    def test_adapterConfig_blocksShellWriteAndDelete_butAllowsRead(self):
        with tempfile.TemporaryDirectory() as temp:
            profile = Path(temp) / 'profile'
            profile.mkdir()
            env = {'KEEL_CODEX_HOME': str(profile)}
            with patch.dict(os.environ, env):
                for command in (f'printf x > {profile}/hooks.json', f'rm {profile}/hooks.json',
                                f'rm -rf {profile}'):
                    with self.subTest(command=command), self.assertRaises(ValueError):
                        hook.protect_adapter(self.payload('Bash', {'command': command}))
                hook.protect_adapter(self.payload('Bash', {'command': f'cat {profile}/hooks.json'}))

    def test_adapterConfig_resolvesProfileSymlink_forPatch(self):
        with tempfile.TemporaryDirectory() as temp:
            real = Path(temp) / 'real'
            real.mkdir()
            alias = Path(temp) / 'alias'
            alias.symlink_to(real, target_is_directory=True)
            with patch.dict(os.environ, {'KEEL_CODEX_HOME': str(alias)}):
                with self.assertRaises(ValueError):
                    hook.protect_adapter(self.payload('Write', {'file_path': str(real / 'hooks.json')}))

    def test_hookToggle_blocksDisable_butAllowsModelSetting(self):
        with tempfile.TemporaryDirectory() as temp:
            profile = Path(temp).resolve()
            with patch.dict(os.environ, {'KEEL_CODEX_HOME': str(profile)}):
                disabled = '[features]\nhooks = false\n'
                for payload in (
                    self.payload('Write', {'file_path': str(profile / 'config.toml'), 'content': disabled}),
                    self.payload('Bash', {'command': f"printf '[features]\\nhooks = false\\n' >> {profile}/config.toml"}),
                ):
                    with self.subTest(payload=payload), self.assertRaises(ValueError):
                        hook.protect_adapter(payload)
                hook.protect_adapter(self.payload('Write', {
                    'file_path': str(profile / 'config.toml'), 'content': 'model = "owner-model"'}))
                with self.assertRaises(ValueError):
                    hook.protect_adapter(self.payload('Bash', {
                        'command': f"printf 'model = owner-model' >> {profile}/config.toml"}))

    def test_configEdit_rejectsShellSubstitution(self):
        with tempfile.TemporaryDirectory() as temp:
            profile = Path(temp).resolve()
            (profile / 'config.toml').write_text('[features]\nhooks = true\n')
            with patch.dict(os.environ, {'KEEL_CODEX_HOME': str(profile)}):
                with self.assertRaises(ValueError):
                    hook.protect_adapter(self.payload('Bash', {
                        'command': f"sed -i '' 's/true/false/' {profile}/config.toml"}))

    def test_sessionRecords_denyWritesDeletesAndMoves_butAllowReads(self):
        with tempfile.TemporaryDirectory() as temp:
            profile = Path(temp).resolve()
            with patch.dict(os.environ, {'KEEL_CODEX_HOME': str(profile)}):
                for folder in ('sessions', 'archived_sessions'):
                    target = profile / folder / '2026/10/16/review.jsonl'
                    calls = [self.payload('Write', {'file_path': str(target), 'content': 'forged'}),
                             self.payload('Edit', {'file_path': str(target), 'old_string': 'fail', 'new_string': 'pass'})]
                    for command in (f'printf forged > {target}', f'rm {target}',
                                    f'mv {target} /tmp/moved-review', f'rm -rf {profile / folder}',
                                    f'rm -rf {profile}/{folder[:4]}*', f'rm -rf {profile}/*'):
                        calls.append(self.payload('Bash', {'command': command}))
                    calls += hook.normalize(self.payload('apply_patch', {'command':
                        f'*** Begin Patch\n*** Delete File: {target}\n*** End Patch'}))
                    for call in calls:
                        with self.subTest(call=call), self.assertRaises(ValueError):
                            hook.protect_adapter(call)
                    hook.protect_adapter(self.payload('Bash', {'command': f'cat {target}'}))
                hook.protect_adapter(self.payload('Write', {'file_path': str(profile / 'sessions-notes.txt'), 'content': 'ok'}))

    def test_sessionRecords_denyGlobThroughSymlink(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            profile = root / 'profile'
            records = profile / 'sessions'
            records.mkdir(parents=True)
            (records / 'review.jsonl').write_text('original')
            aliases = root / 'aliases'
            aliases.mkdir()
            (aliases / 'session-link').symlink_to(records)
            with patch.dict(os.environ, {'KEEL_CODEX_HOME': str(profile)}):
                with self.assertRaises(ValueError):
                    hook.protect_adapter(self.payload('Bash', {
                        'command': f'rm {aliases}/s*/review.jsonl'}))

    def test_customProfile_protectsOsUserDefaultSessions(self):
        import pwd
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            account = pwd.struct_passwd(('owner', 'x', 1, 1, '', str(root), '/bin/zsh'))
            with patch.dict(os.environ, {'KEEL_CODEX_HOME': str(root / 'custom'), 'HOME': str(root / 'fake')}), \
                    patch.object(pwd, 'getpwuid', return_value=account):
                for folder in ('sessions', 'archived_sessions'):
                    with self.assertRaises(ValueError):
                        hook.protect_adapter(self.payload('Write', {
                            'file_path': str(root / '.codex' / folder / 'record.jsonl'), 'content': 'forged'}))

    def test_badPayload_refusesRatherThanPassing(self):
        for payload in ([], self.payload('Bash', {}), self.payload('apply_patch', {'command': 'bad'})):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                hook.normalize(payload)

    def test_guardFailure_returnsDenial(self):
        failed = subprocess.CompletedProcess([], 2, '', 'blocked by floor')
        with patch.object(hook.subprocess, 'run', return_value=failed):
            with self.assertRaisesRegex(ValueError, 'blocked by floor'):
                hook.run_guard('git-guard', self.payload('Bash', {'command': 'git push'}))

    def test_invalidGuardResponse_isRefused(self):
        for stdout in ('[]', '{\"hookSpecificOutput\": []}'):
            passed = subprocess.CompletedProcess([], 0, stdout, '')
            with patch.object(hook.subprocess, 'run', return_value=passed):
                with self.assertRaises(ValueError):
                    hook.run_guard('git-guard', {})

    def test_guardWarning_isCollectedAsContext(self):
        output = {'hookSpecificOutput': {'additionalContext': 'warning'}}
        passed = subprocess.CompletedProcess([], 0, json.dumps(output), '')
        with patch.object(hook.subprocess, 'run', return_value=passed):
            self.assertEqual(hook.run_guard('ship-gate', {}), ['warning'])

    def test_realGuard_blocksForcePush_andAllowsRead(self):
        with tempfile.TemporaryDirectory() as temp:
            subprocess.run(['git', 'init', '-q', temp], check=True)
            env = dict(os.environ, KEEL_DATA_DIR=temp, KEEL_OVERLAY_DIR=temp)
            for command, denied in [('git push --force origin main', True), ('git status', False)]:
                run = subprocess.run([sys.executable, str(ADAPTER / 'hooks/pre-tool-use.py')],
                                     input=json.dumps(dict(self.payload('Bash', {'command': command}), cwd=temp)),
                                     capture_output=True, text=True, env=env)
                self.assertEqual(run.returncode, 0, run.stderr)
                if denied:
                    decision = json.loads(run.stdout)['hookSpecificOutput']
                    self.assertEqual(decision['permissionDecision'], 'deny')
                    self.assertIn('F-force-push', decision['permissionDecisionReason'])
                else:
                    self.assertEqual(run.stdout, '')

    def test_realGuard_blocksPatchToEvidenceStore(self):
        with tempfile.TemporaryDirectory() as temp:
            target = str(Path(temp) / 'state/keel/evidence/forged.json')
            env = dict(os.environ, KEEL_DATA_DIR=temp, KEEL_OVERLAY_DIR=temp)
            payload = self.payload('apply_patch', {'command': f'*** Begin Patch\n*** Add File: {target}\n+fake\n*** End Patch'})
            run = subprocess.run([sys.executable, str(ADAPTER / 'hooks/pre-tool-use.py')],
                                 input=json.dumps(payload), capture_output=True, text=True, env=env)
            self.assertEqual(json.loads(run.stdout)['hookSpecificOutput']['permissionDecision'], 'deny')


if __name__ == '__main__':
    unittest.main()
