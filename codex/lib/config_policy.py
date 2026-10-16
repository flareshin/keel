from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
import tomllib

from files import write_atomic


def main() -> int:
    parser = argparse.ArgumentParser(description='Validate and replace Codex config without changing hook policy.')
    parser.add_argument('--file', type=Path, required=True, help='complete proposed config.toml')
    parser.add_argument('--profile', type=Path, default=Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))))
    args = parser.parse_args()
    try:
        path = (args.profile.expanduser() / 'config.toml').resolve()
        candidate = args.file.read_text()
        validate_update(path.read_text() if path.exists() else '', candidate)
        write_atomic(path, candidate)
        print(f'Updated {path}; hook configuration preserved.')
        return 0
    except (OSError, ValueError) as error:
        print(f'codex/config: refused: {error}', file=sys.stderr)
        return 3


def validate_update(current: str, candidate: str) -> None:
    before = tomllib.loads(current)
    after = tomllib.loads(candidate)
    features = after.get('features', {})
    if not isinstance(features, dict):
        raise ValueError('features must be a TOML table')
    if 'hooks' in features and features['hooks'] is not True:
        raise ValueError('F-hookskip: features.hooks must remain enabled')
    if after.get('allow_managed_hooks_only', False) is not False:
        raise ValueError('F-hookskip: user hooks must remain enabled')
    if before.get('hooks', {}) != after.get('hooks', {}):
        raise ValueError('hook configuration must be changed by the owner, outside agent tools')


def complete_edit(path: Path, tool: dict) -> str:
    if tool.get('keel_partial'):
        raise ValueError('partial config patches cannot be verified; use codex/bin/config --file <complete TOML>')
    if isinstance(tool.get('content'), str):
        return tool['content']
    current = path.read_text()
    old, new = tool.get('old_string'), tool.get('new_string')
    if not isinstance(old, str) or not old or not isinstance(new, str):
        raise ValueError('a complete config write or exact replacement is required')
    count = current.count(old)
    if not count or (count != 1 and not tool.get('replace_all')):
        raise ValueError('config replacement does not identify an unambiguous result')
    return current.replace(old, new, -1 if tool.get('replace_all') else 1)
