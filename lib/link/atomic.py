from __future__ import annotations

import os
import shutil
import tempfile

_TEMP_PREFIX = ".keel-link-"


def write_text_atomic(path: str, text: str, mode: int) -> None:
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(dir=directory, prefix=_TEMP_PREFIX)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(temp_path, mode)
        os.replace(temp_path, path)
    except BaseException:
        if os.path.lexists(temp_path):
            os.unlink(temp_path)
        raise


def replace_with_symlink(source: str, path: str) -> None:
    """Point `path` at `source` in one rename, so readers never see the link missing."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    temp_path = os.path.join(directory, f"{_TEMP_PREFIX}{os.getpid()}-{os.path.basename(path)}")
    if os.path.lexists(temp_path):
        os.unlink(temp_path)
    os.symlink(source, temp_path)
    try:
        os.replace(temp_path, path)
    except BaseException:
        os.unlink(temp_path)
        raise


def copy_file_atomic(source: str, path: str) -> None:
    """Replace `path` (file or link) with a regular copy of `source` in one rename."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(dir=directory, prefix=_TEMP_PREFIX)
    os.close(fd)
    try:
        shutil.copyfile(source, temp_path)
        shutil.copymode(source, temp_path)
        os.replace(temp_path, path)
    except BaseException:
        if os.path.lexists(temp_path):
            os.unlink(temp_path)
        raise


def move_aside(path: str, backup_path: str) -> None:
    """Rename `path` (file, directory or link) to `backup_path`; never overwrites an existing backup."""
    if os.path.lexists(backup_path):
        raise FileExistsError(f"backup path already exists: {backup_path}")
    os.makedirs(os.path.dirname(backup_path), mode=0o700, exist_ok=True)
    os.rename(path, backup_path)
