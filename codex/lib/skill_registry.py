from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import json
from pathlib import Path

from files import read_json, write_atomic

REGISTRY_NAME = 'keel-codex-skills.json'
LOCK_NAME = 'keel-codex-skills.lock'


@dataclass
class SkillPlan:
    records: dict
    create: dict[Path, str]
    remove: list[Path]
    problems: list[str]
    changed: bool


@contextmanager
def installation_lock(agents_home: Path, write: bool):
    if not write:
        yield
        return
    agents_home.mkdir(parents=True, exist_ok=True)
    with (agents_home / LOCK_NAME).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def plan_skills(agents_home: Path, profile: Path, desired: dict) -> SkillPlan:
    original = read_registry(agents_home)
    records = json.loads(json.dumps(original))
    plan = SkillPlan(records, {}, [], [], False)
    profile_name = str(profile)
    desired_names = {path.name for path in desired}
    for name in list(records):
        if name not in desired_names and profile_name in records[name]['profiles']:
            release_skill(plan, agents_home / 'skills' / name, profile_name)
    for path, (_, target) in desired.items():
        register_skill(plan, path, target, profile_name)
    plan.changed = plan.records != original or bool(plan.create or plan.remove)
    return plan


def read_registry(agents_home: Path) -> dict:
    registry = read_json(agents_home / REGISTRY_NAME)
    if not registry:
        return {}
    if registry.get('version') != 1 or not isinstance(registry.get('skills'), dict):
        raise ValueError('invalid shared skill registry')
    records = registry['skills']
    for name, entry in records.items():
        validate_record(name, entry)
    return records


def validate_record(name: str, entry: dict) -> None:
    if not name or name in ('.', '..') or '/' in name or not isinstance(entry, dict):
        raise ValueError('invalid skill registry entry')
    target, profiles = entry.get('target'), entry.get('profiles')
    if not isinstance(target, str) or not Path(target).is_absolute() or type(entry.get('managed')) is not bool:
        raise ValueError(f'invalid skill target or ownership: {name}')
    if not isinstance(profiles, list) or not profiles:
        raise ValueError(f'invalid skill profile references: {name}')
    if any(not isinstance(profile, str) or not Path(profile).is_absolute() for profile in profiles):
        raise ValueError(f'invalid skill profile path: {name}')


def release_skill(plan: SkillPlan, path: Path, profile: str) -> None:
    entry = plan.records[path.name]
    remaining = [name for name in entry['profiles'] if name != profile]
    if remaining:
        entry['profiles'] = remaining
        return
    if entry['managed'] and (path.exists() or path.is_symlink()):
        if not same_link(path, entry['target']):
            plan.problems.append(f'managed skill edited: {path}')
            return
        plan.remove.append(path)
    del plan.records[path.name]


def register_skill(plan: SkillPlan, path: Path, target: str, profile: str) -> None:
    entry = plan.records.get(path.name)
    if entry is not None and entry['target'] != target:
        plan.problems.append(f'shared skill target conflicts with another installation: {path}')
        return
    exists = path.exists() or path.is_symlink()
    if exists and not same_link(path, target):
        plan.problems.append(f'conflict: {path}; preserve it and reconcile manually')
        return
    if entry is None:
        entry = {'target': target, 'managed': not exists, 'profiles': []}
        plan.records[path.name] = entry
    entry['profiles'] = sorted(set(entry['profiles']) | {profile})
    if not exists:
        plan.create[path] = target
        entry['managed'] = True


def same_link(path: Path, target: str) -> bool:
    return path.is_symlink() and str(path.resolve()) == target


def apply_skill_plan(agents_home: Path, plan: SkillPlan) -> None:
    for path, target in plan.create.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to(target, target_is_directory=True)
    if plan.changed:
        write_atomic(agents_home / REGISTRY_NAME, json.dumps({'version': 1, 'skills': plan.records}, indent=2) + '\n')
    for path in plan.remove:
        path.unlink()
