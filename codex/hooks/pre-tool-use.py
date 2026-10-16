#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

KEEL = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(KEEL / 'hooks/lib'))
from hookkit.shell import resolve_directory, steps, write_targets
sys.path.insert(0, str(KEEL / 'codex/lib'))
from config_policy import complete_edit, validate_update


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        calls = normalize(payload)
        contexts = []
        for call in calls:
            protect_adapter(call)
            contexts.extend(run_guard('git-guard', call))
            if call['tool_name'] == 'Bash':
                contexts.extend(run_guard('ship-gate', call))
        if contexts:
            print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse',
                              'additionalContext': '\n'.join(contexts)}}))
        return 0
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse',
              'permissionDecision': 'deny', 'permissionDecisionReason': f'keel Codex guard: {error}'}}))
        return 0


def normalize(payload: dict) -> list[dict]:
    if not isinstance(payload, dict):
        raise ValueError('payload must be an object')
    name = payload.get('tool_name')
    tool = payload.get('tool_input')
    if not isinstance(tool, dict):
        raise ValueError('tool_input must be an object')
    if name in ('Bash', 'Edit', 'Write'):
        if name == 'Bash' and not isinstance(tool.get('command'), str):
            raise ValueError('Bash command is missing')
        return [payload]
    if name != 'apply_patch':
        raise ValueError(f'unsupported guarded tool: {name}')
    patch = tool.get('command')
    if not isinstance(patch, str):
        raise ValueError('apply_patch command is missing')
    calls = []
    path = None
    added = []
    for line in patch.splitlines():
        prefixes = ('*** Add File: ', '*** Update File: ', '*** Delete File: ', '*** Move to: ')
        prefix = next((item for item in prefixes if line.startswith(item)), None)
        if prefix:
            if path is not None:
                calls.append(edit_call(payload, path, added))
            path, added = line[len(prefix):], []
        elif line.startswith('+'):
            added.append(line[1:])
    if path is not None:
        calls.append(edit_call(payload, path, added))
    if not calls:
        raise ValueError('apply_patch has no recognized file operations')
    return calls


def edit_call(payload: dict, path: str, added: list[str]) -> dict:
    return dict(payload, tool_name='Write', tool_input={'file_path': path, 'content': '\n'.join(added), 'keel_partial': True})


def protect_adapter(payload: dict) -> None:
    profile = Path(os.environ.get('KEEL_CODEX_HOME', str(Path.home() / '.codex'))).resolve()
    agents_home = Path(os.environ.get('KEEL_AGENTS_HOME', str(Path.home() / '.agents'))).resolve()
    protected = {profile / name for name in ('AGENTS.md', 'hooks.json', 'keel-codex-state.json')}
    protected |= {agents_home / name for name in ('keel-codex-skills.json', 'keel-codex-skills.lock')}
    protected = {path.resolve() for path in protected}
    config = (profile / 'config.toml').resolve()
    cwd = str(payload.get('cwd') or os.getcwd())
    if payload['tool_name'] == 'Bash':
        protect_shell(payload['tool_input']['command'], cwd, protected | {config})
        return
    path = (Path(cwd) / payload['tool_input'].get('file_path', '')).resolve()
    if path in protected:
        raise ValueError(f'generated Codex configuration must be changed through codex/bin/link: {path}')
    if path == config:
        candidate = complete_edit(path, payload['tool_input'])
        validate_update(path.read_text() if path.exists() else '', candidate)


def protect_shell(command: str, cwd: str, protected: set[Path]) -> None:
    for step in steps(command, cwd):
        targets = write_targets(step.command)
        for target in targets.written + targets.removed:
            path = Path(resolve_directory(step.directory, target, step.expansion)).resolve()
            if path in protected or any(path in item.parents for item in protected):
                raise ValueError('shell config edits cannot be verified; use codex/bin/config --file <complete TOML>')


def run_guard(name: str, payload: dict) -> list[str]:
    completed = subprocess.run([sys.executable, str(KEEL / 'hooks' / name / f'{name}.py')],
                               input=json.dumps(payload), capture_output=True, text=True, timeout=35)
    if completed.returncode:
        raise ValueError(completed.stderr.strip() or f'{name} exited {completed.returncode}')
    if completed.stdout.strip():
        output = json.loads(completed.stdout)
        if not isinstance(output, dict):
            raise ValueError(f'{name} returned a non-object response')
        specific = output.get('hookSpecificOutput', {})
        if not isinstance(specific, dict):
            raise ValueError(f'{name} returned invalid hook output')
        context = specific.get('additionalContext')
        if context is not None and not isinstance(context, str):
            raise ValueError(f'{name} returned invalid context')
        return [context] if context else []
    return []


if __name__ == '__main__':
    sys.exit(main())
