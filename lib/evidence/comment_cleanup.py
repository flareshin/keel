from __future__ import annotations

import ast
import io
import re
import tokenize
from functools import lru_cache
from pathlib import PurePosixPath

from evidence import gitcmd

MAX_SOURCE_BYTES = 1024 * 1024
PROSE = re.compile(r'''[\w\s.,!?()'"-]+''')
PROTECTED = re.compile(
    r'copyright|licen[cs]e|spdx|notice|rights reserved|trademark|coding|encoding|'
    r'ignore|disable|enable|suppress|pragma|noqa|nosec|lint|prettier|formatter|'
    r'coverage|istanbul|source.?map|sourceurl|checkstyle|generated|preserve|'
    r'pyright|mypy|pylint|doctest|webpack|rollup|vite|region|falls?[\s-]*through|'
    r'databricks|command|magic|'
    r'global|exported|noinspection|sonar|pmd|isort|ruff|fmt|yapf|__', re.I)


def matches_content(repo: str, path: str, reviewed, current) -> bool:
    if reviewed == current:
        return True
    if not reviewed or not current or reviewed[0] != current[0] or current[0] not in ('100644', '100755'):
        return False
    return blob_comment_deletions(repo, path, reviewed[1], current[1])


@lru_cache(maxsize=128)
def blob_comment_deletions(repo: str, path: str, old_blob: str, new_blob: str) -> bool:
    try:
        sizes = [int(gitcmd.text(repo, 'cat-file', '-s', blob)) for blob in (old_blob, new_blob)]
        if not 0 < sizes[1] < sizes[0] <= MAX_SOURCE_BYTES:
            return False
        before, after = [gitcmd.run(repo, 'cat-file', 'blob', blob).stdout for blob in (old_blob, new_blob)]
        return only_comment_deletions(path, before, after)
    except (gitcmd.GitError, ValueError):
        return False


def only_comment_deletions(path: str, before: bytes, after: bytes) -> bool:
    suffix = PurePosixPath(path).suffix
    if suffix not in ('.py', '.js', '.ts', '.java') or not 0 < len(after) < len(before) <= MAX_SOURCE_BYTES:
        return False
    try:
        old, new = before.decode('utf-8'), after.decode('utf-8')
        if '\r' in old.replace('\r\n', '') or any(char in old for char in ('\0', '\ufeff', '\u2028', '\u2029')):
            return False
        spans = python_comments(old, new) if suffix == '.py' else slash_comments(old, suffix)
    except (UnicodeError, SyntaxError, tokenize.TokenError, IndentationError, RecursionError):
        return False
    if spans is None:
        return False
    chunks, cursor = [], 0
    for start, end, body in spans:
        if not PROSE.fullmatch(body) or PROTECTED.search(body):
            return False
        first = old.rfind('\n', 0, start) + 1
        last = old.find('\n', end)
        last = len(old) if last < 0 else last + 1
        if old[first:start].strip() or old[end:last].strip():
            continue
        chunks.extend(((old[cursor:first], False), (old[first:last], True)))
        cursor = last
    chunks.append((old[cursor:], False))
    position, removed = 0, False
    for text, removable in chunks:
        if new.startswith(text, position):
            position += len(text)
        elif removable:
            removed = True
        else:
            return False
    return removed and position == len(new)


def python_comments(old: str, new: str):
    if ast.dump(ast.parse(old)) != ast.dump(ast.parse(new)):
        return None
    offsets = [0]
    for line in old.splitlines(keepends=True):
        offsets.append(offsets[-1] + len(line))
    return [(offsets[token.start[0] - 1] + token.start[1],
             offsets[token.end[0] - 1] + token.end[1], token.string[1:])
            for token in tokenize.generate_tokens(io.StringIO(old).readline) if token.type == tokenize.COMMENT]


def slash_comments(text: str, suffix: str):
    if (suffix == '.java' and ('\\u' in text or '"""' in text)) or '`' in text:
        return None
    spans, position = [], 0
    while position < len(text):
        char = text[position]
        if char in ('"', "'"):
            position = quoted_end(text, position)
            if position is None:
                return None
        elif text.startswith('//', position):
            end = text.find('\n', position)
            end = len(text) if end < 0 else end
            spans.append((position, end, text[position + 2:end]))
            position = end
        elif text.startswith('/*', position):
            end = text.find('*/', position + 2)
            if end < 0:
                return None
            spans.append((position, end + 2, text[position + 2:end]))
            position = end + 2
        elif char == '#' or (char in '/<' and suffix != '.java'):
            return None
        else:
            position += 1
    return spans


def quoted_end(text: str, start: int):
    position = start + 1
    while position < len(text):
        char = text[position]
        if char == text[start]:
            return position + 1
        if char in '\r\n':
            return None
        position += 2 if char == '\\' else 1
    return None
