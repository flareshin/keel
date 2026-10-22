from __future__ import annotations

import datetime
import json
import math
import os
import pathlib
import shlex
import sys
import tomllib


def canonical_toml(value):
    if isinstance(value, bool):
        return {'t': 'bool', 'v': value}
    if isinstance(value, int):
        return {'t': 'int', 'v': str(value)}
    if isinstance(value, float):
        return {'t': 'float', 'v': 'nan' if math.isnan(value) else repr(value)}
    if isinstance(value, str):
        return {'t': 'str', 'v': value}
    if isinstance(value, datetime.datetime):
        offset = None if value.utcoffset() is None else int(value.utcoffset().total_seconds() // 60)
        return {'t': 'datetime', 'v': [value.year, value.month, value.day, value.hour, value.minute, value.second,
                                      value.microsecond, offset]}
    if isinstance(value, datetime.date):
        return {'t': 'date', 'v': [value.year, value.month, value.day]}
    if isinstance(value, datetime.time):
        return {'t': 'time', 'v': [value.hour, value.minute, value.second, value.microsecond]}
    if isinstance(value, list):
        return {'t': 'array', 'v': [canonical_toml(item) for item in value]}
    return {'t': 'table', 'v': [[key, canonical_toml(item)] for key, item in value.items()]}


def failure(error):
    return {'error': str(error), 'type': type(error).__name__}


def integral_floats_as_ints(value):
    if isinstance(value, float) and math.isfinite(value) and value.is_integer() and abs(value) < 1e16:
        return int(value)
    if isinstance(value, list):
        return [integral_floats_as_ints(item) for item in value]
    if isinstance(value, dict):
        return {key: integral_floats_as_ints(item) for key, item in value.items()}
    return value


def json_loads(text):
    try:
        return {'ok': json.dumps(integral_floats_as_ints(json.loads(text)), sort_keys=True)}
    except ValueError as error:
        return failure(error)


def json_dumps(value, indent, sort_keys, ensure_ascii):
    return {'ok': json.dumps(value, indent=indent, sort_keys=sort_keys, ensure_ascii=ensure_ascii)}


def float_repr(text):
    return {'ok': json.dumps(float(text))}


def toml_loads(text):
    try:
        return {'ok': canonical_toml(tomllib.loads(text))}
    except ValueError as error:
        return failure(error)


def toml_equals(left, right):
    try:
        return {'ok': tomllib.loads(left) == tomllib.loads(right)}
    except ValueError as error:
        return failure(error)


def py_repr(text):
    return {'ok': repr(text)}


def decode_utf8(hex_bytes):
    try:
        return {'ok': bytes.fromhex(hex_bytes).decode('utf-8')}
    except UnicodeDecodeError as error:
        return failure(error)


def shell_quote(text):
    return {'ok': shlex.quote(text)}


def resolve(path):
    try:
        return {'ok': str(pathlib.Path(path).resolve())}
    except ValueError as error:
        return failure(error)


def pure(path):
    pure_path = pathlib.PurePosixPath(path)
    return {'ok': [str(pure_path), str(pure_path.parent), pure_path.name]}


def os_error(path):
    try:
        pathlib.Path(path).read_text()
    except (OSError, ValueError) as error:
        return failure(error)
    return {'ok': None}


FUNCTIONS = {name: function for name, function in globals().items()
             if name in ('json_loads', 'json_dumps', 'float_repr', 'toml_loads', 'toml_equals', 'py_repr',
                         'decode_utf8', 'shell_quote', 'resolve', 'pure', 'os_error')}


def main():
    calls = json.load(sys.stdin)
    os.chdir(calls['cwd'])
    print(json.dumps([FUNCTIONS[call['fn']](*call['args']) for call in calls['calls']]))


if __name__ == '__main__':
    main()
