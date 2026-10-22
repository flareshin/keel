import json
import os
import sys

KEEL_HOME = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
sys.path.insert(0, os.path.join(KEEL_HOME, "tests", "ship-gate"))

import helpers  # noqa: E402

REVIEW_ROOT_RUN_ID = "rv-root-0001"


class KeepSandbox:
    def addCleanup(self, *_arguments, **_keywords):
        pass


def main() -> int:
    box = helpers.Sandbox(KeepSandbox())
    repo = box.clone("acme", "app")
    before = repo.head()
    repo.commit({"src/a.py": "print(2)\n", "tests/test_a.py": "assert 2 == 2\n"})
    target = repo.head()
    box.review(repo)
    box.tests_evidence(repo)
    repo.git("checkout", "--detach", target)
    box.approve(REVIEW_ROOT_RUN_ID)
    repo.git("checkout", "--detach", before)
    print(json.dumps({"root": box.root, "repo": repo.path, "target": target, "env": box.env}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
