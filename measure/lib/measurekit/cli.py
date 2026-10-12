"""Shared exit-code contract for measure executables (Interfaces (e))."""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from datetime import date, datetime
from typing import Callable

EXIT_OK, EXIT_NEGATIVE, EXIT_USAGE, EXIT_INTERNAL = 0, 1, 2, 70


def run_main(main: Callable[[list[str]], int]) -> None:
    """Exit with main's code; an unexpected exception is an internal error (70), never a silent pass."""
    try:
        code = main(sys.argv[1:])
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        print("internal error: %s: %s" % (type(error).__name__, error), file=sys.stderr)
        code = EXIT_INTERNAL
    sys.exit(code)


def print_json(payload: dict) -> None:
    print(json.dumps(payload, sort_keys=True))


def iso_date(value: str) -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        raise argparse.ArgumentTypeError("expected YYYY-MM-DD, got %r" % value)
