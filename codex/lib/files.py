from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import tempfile


def fingerprint(path: Path) -> str | None:
    if path.is_symlink():
        return digest('link', str(path.resolve()))
    if path.is_file():
        return digest('file', path.read_text())
    if path.exists():
        raise ValueError(f'expected a file or symlink: {path}')
    return None


def digest(kind: str, content: str) -> str:
    return hashlib.sha256((kind + '\0' + content).encode()).hexdigest()


def write_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=f'.{path.name}.')
    try:
        with os.fdopen(descriptor, 'w') as output:
            output.write(content)
        if path.exists():
            os.chmod(temporary, path.stat().st_mode & 0o777)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path: Path) -> dict:
    value = json.loads(path.read_text()) if path.is_file() else {}
    if not isinstance(value, dict):
        raise ValueError(f'expected an object: {path}')
    return value
