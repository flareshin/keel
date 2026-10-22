from __future__ import annotations

import json
import os
import time
import unittest
from typing import Dict, List, Optional

import helpers
from helpers import LOGIC_WITH_TEST, Repo, Sandbox

TEST = "def test_it(): assert True\n"
DOTTED_CAPITAL_I = "\u0130"
DOTLESS_SMALL_I = "\u0131"
SLOW_GH = "#!/bin/bash\nsleep 30\n"
FAILING_GH = "#!/bin/bash\necho 'gh: HTTP 502' >&2\nexit 1\n"
SILENT_GH = "#!/bin/bash\nexit 0\n"
MERGE_SHAPES: List[dict] = [
    {"statusCheckRollup": "abc"}, {"statusCheckRollup": {"a": 1}}, {"statusCheckRollup": 5}, {"statusCheckRollup": True},
    {"statusCheckRollup": ["x"]}, {"statusCheckRollup": [1]}, {"statusCheckRollup": [[1]]}, {"statusCheckRollup": [None]},
    {"statusCheckRollup": [{"conclusion": ["x"]}]}, {"statusCheckRollup": [{"conclusion": {"a": 1}}]},
    {"statusCheckRollup": [{"conclusion": 5}]}, {"statusCheckRollup": [{"conclusion": True}]},
    {"statusCheckRollup": [{"status": "COMPLETED", "conclusion": "SUCCESS"}]},
    {"statusCheckRollup": [{"state": "PENDING"}]}, {"statusCheckRollup": [{"context": "c", "state": "ERROR"}]},
    {"statusCheckRollup": [{"name": 5, "conclusion": "FAILURE"}]}, {"statusCheckRollup": [{"name": ["a"], "conclusion": "FAILURE"}]},
    {"statusCheckRollup": [{"name": None, "context": None, "conclusion": "TIMED_OUT"}]},
    {"statusCheckRollup": [{"conclusion": "", "status": "IN_PROGRESS", "name": "ci"}]},
    {"statusCheckRollup": None}, {"statusCheckRollup": 0}, {"statusCheckRollup": ""},
    {"baseRefName": 5}, {"baseRefName": ""}, {"baseRefName": ["main"]}, {"baseRefName": "nobranch"}, {"baseRefName": None},
    {"baseRefName": True}, {"baseRefName": 1.5}, {"baseRefName": "ma\u00efn"}, {"baseRefName": "mai\U0001f600n"},
]
INT_DIGIT_LIMIT = 4300
OVER_LIMIT_INTEGER = "1" * (INT_DIGIT_LIMIT + 1)
DEEP_NESTING = 3000
BOUND_NESTING = 9999
OVER_BOUND_NESTINGS = [10001, 200000]
DEEPEST_PARSED_COMMAND_NESTING = 9998
COMMAND_DIVERGENT_NESTINGS = [9999, 10001]
JSON_EDGE_VALUES = [
    OVER_LIMIT_INTEGER, "-" + OVER_LIMIT_INTEGER, "1" * INT_DIGIT_LIMIT, OVER_LIMIT_INTEGER + ".5", OVER_LIMIT_INTEGER + "e2",
    "[" + OVER_LIMIT_INTEGER + "]", '{"a": ' + OVER_LIMIT_INTEGER + "}",
    "[" * DEEP_NESTING + "1" + "]" * DEEP_NESTING, '{"a": ' * DEEP_NESTING + "1" + "}" * DEEP_NESTING,
    "[" * BOUND_NESTING + "1" + "]" * BOUND_NESTING, "[" * DEEP_NESTING + OVER_LIMIT_INTEGER + "]" * DEEP_NESTING,
]
RAW_GH_ANSWERS = ["[]", "null", "{}", "NaN", "", "  ", '{"baseRefName": "main", "statusCheckRollup": NaN}',
                  '{"baseRefName": "main", "statusCheckRollup": [{"name": "ci", "conclusion": Infinity}]}',
                  '{"baseRefName": "main",}', '{"baseRefName": "main"} trailing', '[{"baseRefName": "main"}]',
                  '{"baseRefName": "main", "statusCheckRollup": []}\n\n', '\ufeff{"baseRefName": "main"}',
                  '{"baseRefName": "main", "baseRefName": "other"}', '{"baseRefName": "ma\\ud800in"}'] + [
    '{"baseRefName": "main", "number": %s}' % value for value in JSON_EDGE_VALUES]


class Holder(unittest.TestCase):
    def runTest(self):
        pass


class PendingLabel:
    value = ""


def send_labeled(sandbox: Sandbox, label: str, stdin: str, extra_env: Optional[Dict[str, str]] = None):
    PendingLabel.value = label
    try:
        return sandbox.hook_raw(stdin, extra_env)
    finally:
        PendingLabel.value = ""


def over_bound_label(kind: str, depth: int) -> str:
    return "%s-nested-%d" % (kind, depth)


def nested_command(depth: int):
    command = "'; git push origin feature; echo \""
    for _ in range(depth):
        command = [command]
    return command


def nested_lists(depth: int) -> str:
    return "[" * depth + "1" + "]" * depth


def payload_text(sandbox: Sandbox, repo: Repo, command, **changes) -> str:
    payload = sandbox.bash_payload(repo, "x")
    payload["tool_input"]["command"] = command
    payload.update(changes)
    return json.dumps(payload)


def feature_sandbox(holder: Holder, registry: Optional[List[str]] = None, files=None, claude: bool = True):
    sandbox = Sandbox(holder, registry=registry)
    if claude:
        sandbox.stub_claude()
    repo = sandbox.clone("acme", "app")
    repo.branch("feature")
    repo.commit(files or LOGIC_WITH_TEST)
    return sandbox, repo


def reviewed_feature(holder: Holder):
    sandbox, repo = feature_sandbox(holder)
    head = repo.head()
    repo.git("push", "-q", "origin", "feature")
    sandbox.review(repo, head=head)
    sandbox.tests_evidence(repo)
    sandbox.approve("rv-root-0001")
    return sandbox, repo, head


def write_executable(path: str, text: str) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as stream:
        stream.write(text)
    os.chmod(path, 0o755)
    return path


def malformed_payloads(holder: Holder) -> None:
    sandbox, repo = feature_sandbox(holder)
    push = "git push origin feature"
    for raw in ["", "not json", "[]", "5", '"x"', "null", "true", "1.5", "{}", "[1, 2]", '{"hook_event_name": "PreToolUse"}',
                '{"hook_event_name": "PreToolUse", "tool_name": "Bash"}', '{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {}}',
                '{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push origin feature"',
                '{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "ls"',
                '{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "$CMD x"',
                '\ufeff{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push origin feature"}}',
                '{"x": NaN, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push origin feature"}}',
                '{"x": Infinity, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "ls"}}',
                '{"x": -Infinity}', '{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push origin feature"}} x',
                '{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push \\ud800 feature"}}',
                '{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push origin \\ud83d\\ude00"}}',
                '{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push origin \\u00e9"}}']:
        sandbox.hook_raw(raw)
    for command in [push, "ls"]:
        for value in JSON_EDGE_VALUES:
            sandbox.hook_raw(payload_text(sandbox, repo, command)[:-1] + ', "extra": ' + value + "}")
    for depth in OVER_BOUND_NESTINGS:
        for kind, command in [("stdin-push", push), ("stdin-ls", "ls")]:
            send_labeled(sandbox, over_bound_label(kind, depth), payload_text(sandbox, repo, command)[:-1] + ', "extra": ' + nested_lists(depth) + "}")
    for depth in [DEEP_NESTING, DEEPEST_PARSED_COMMAND_NESTING]:
        sandbox.hook_raw(payload_text(sandbox, repo, nested_command(depth)))
    for depth in COMMAND_DIVERGENT_NESTINGS:
        send_labeled(sandbox, over_bound_label("command-list", depth), payload_text(sandbox, repo, nested_command(depth)))
    for value in JSON_EDGE_VALUES[-4:]:
        sandbox.hook_raw(value + " git push origin feature")
        sandbox.hook_raw(value + " ls")
    base = sandbox.bash_payload(repo, push)
    variants: Dict[str, object] = {
        "list command": ["git push origin feature"], "number command": 5, "null command": None, "dict command": {"a": "git push"},
        "empty command": "", "true command": True, "float command": 1.5, "nested list": [["git push"]],
    }
    for label, command in variants.items():
        sandbox.hook_raw(payload_text(sandbox, repo, command))
    for tool_input in ["git push origin feature", ["git push"], 5, None, {"cmd": "git push"}, {"command": "git push", "extra": 1}]:
        sandbox.hook_raw(payload_text(sandbox, repo, push, tool_input=tool_input))
    for cwd in [5, ["x"], "", "/nonexistent", os.path.join(repo.path, "README.md"), ".", "..", repo.path + "/", sandbox.root, True, {"a": 1}]:
        sandbox.hook_raw(payload_text(sandbox, repo, push, cwd=cwd))
    for key, value in [("tool_name", "bash"), ("tool_name", None), ("tool_name", 5), ("tool_name", ["Bash"]),
                       ("hook_event_name", "pretooluse"), ("hook_event_name", None), ("hook_event_name", 5),
                       ("hook_event_name", "PostToolUse"), ("hook_event_name", "PreToolUse ")]:
        sandbox.hook_raw(payload_text(sandbox, repo, push, **{key: value}))
    for session in [5, ["a"], {"a": 1}, "../x", "", None, True, 1.5, "s\u00e9\U0001f600"]:
        sandbox.hook_raw(payload_text(sandbox, repo, push, session_id=session))
        sandbox.hook_raw(payload_text(sandbox, repo, "gh pr create --title t", session_id=session))
        sandbox.hook_raw(payload_text(sandbox, repo, "git push origin main", session_id=session))
    del base
    for command in ["git push origin feature \U0001f600", "git push origin \u00e9\u00e8", "git push origin \u0131feature",
                    "git push origin feature" + "x" * 5000, "git push origin " + "a" * 100000,
                    "git push " + "-u " * 3000 + "origin feature", "echo " + "$(" * 300 + "git push origin feature" + ")" * 300,
                    "(" * 400 + "git push origin feature" + ")" * 400, "{ " * 200 + "git push origin feature" + "; }" * 200]:
        sandbox.hook_raw(payload_text(sandbox, repo, command))


def unicode_and_case_spellings(holder: Holder) -> None:
    sandbox, repo = feature_sandbox(holder)
    ghd = "git"
    for command in [
        "g%st push origin feature" % DOTLESS_SMALL_I, "G%sT push origin feature" % DOTTED_CAPITAL_I, "GIT push origin feature",
        "git PUSH origin feature", "git pus%s origin feature" % DOTLESS_SMALL_I, "git push%s origin feature" % DOTLESS_SMALL_I,
        "git push --DRY-RUN origin feature", "git push -N origin feature", "git push --DELETE origin feature", "git push --TAGS origin",
        "git push --ALL origin", "git push --Mirror origin", "git -C %s push origin feature" % repo.path.upper(),
        "git -c %snclude.path=/x push origin feature" % DOTTED_CAPITAL_I, "git -c %sncludeif.x.path=/x push origin feature" % DOTLESS_SMALL_I,
        "git -c REMOTE.pushDefault=origin push", "git -c Remote.pushDefault=origin push", "git -c BRANCH.x.remote=y push origin feature",
        "git -c %semote.pushDefault=origin push" % DOTLESS_SMALL_I, "git -c URL.x.insteadOf=y push origin feature",
        "git -c PUSH.default=nothing push origin feature", "git -c core.%sooksPath=x push origin feature" % DOTLESS_SMALL_I,
        "git config %snclude.path x && git push origin feature" % DOTTED_CAPITAL_I, "git config REMOTE.origin.url x && git push",
        "git config Remote.origin.url x && git push origin feature", "git config --get REMOTE.origin.url && git push origin feature",
        "git config %semote.origin.url x && git push origin feature" % DOTLESS_SMALL_I,
        "git remote SET-URL origin x && git push origin feature", "git remote set-url origin x && git push origin feature",
        "git remote ADD z y && git push origin feature", "git remote add z y; git push origin feature",
        "gh api -X pAtCh repos/acme/app/git/refs/heads/x", "gh api -X pUt repos/acme/app/pulls/7/merge",
        "gh api -X get repos/acme/app/git/refs/heads/main", "gh api -X gEt repos/acme/app/git/refs/heads/main",
        "gh api -X HEAD repos/acme/app/git/refs/heads/main", "gh api -X heaD repos/acme/app/git/refs/heads/main",
        "gh api -X %sET repos/acme/app/git/refs/heads/main" % DOTLESS_SMALL_I, "gh api -X g%st repos/acme/app/git/refs/heads/main" % DOTTED_CAPITAL_I.lower(),
        "gh api -X %sEAD repos/acme/app/git/refs/heads/main" % DOTLESS_SMALL_I, "gh api -X hea%s repos/acme/app/git/refs/heads/main" % DOTLESS_SMALL_I,
        "gh api -X %s repos/acme/app/git/refs/heads/main" % "d\u0131" , "gh api -X \u00df repos/acme/app/git/refs/heads/main",
        "gh api -X \ufb01 repos/acme/app/git/refs/heads/main", "gh api repos/acme/app/GIT/refs/heads/main -X PATCH",
        "gh api repos/acme/app/git/REFS/heads/main -X PATCH", "gh api repos/acme/app/MERGES -X POST", "gh api repos/acme/app/Pulls/7/Merge -X PUT",
        "gh api graphql -f query='mutation { MERGEPULLREQUEST(input: {}) { x } }'",
        "gh api graphql -f query='mutation { merge%sullRequest(input: {}) { x } }'" % DOTLESS_SMALL_I,
        "gh api graphql -f query='mutation { createref(input: {}) { x } }'", "gh pr MERGE 7 --match-head-commit abc", "GH pr merge 7",
        "gh pr merge 7 --MATCH-HEAD-COMMIT abc", "gh pr merge 7 --repo ACME/APP --match-head-commit abc", "gh pr merge 7 -R ACME/APP",
        "gh pr merge 7 --repo ACME/%s --match-head-commit abc" % "AP\u0130", "gh pr merge 7 --repo acme/\u0130 --match-head-commit abc",
        "gh pr merge https://github.com/ACME/APP/pull/\u0663", "gh pr merge https://github.com/acme/app/pull/7\n",
        "gh pr merge https://github.com/acme/app/pull/\u0967\u0968 --match-head-commit abc",
        "gh api repos/acme/app/pulls/7/merge\n", "gh api -X PUT repos/acme/app/pulls/7/merge/", "gh api -X PUT repos/acme/app/pulls/7/merge/x",
        "gh api -X PUT repos/acme/app/pulls/7/merge?x=1", "gh api repos/acme/app/merges?x=1 -f a=b", "gh api repos/acme/app/mergesx -f a=b",
        "gh api repos/acme/app/git/refs?x=1 -X PATCH", "gh api repos/acme/app/git/refsx -X PATCH", "gh api git/refs -X PATCH",
        "sudo %s -E git push origin feature" % DOTLESS_SMALL_I, "SUDO git push origin feature", "ENV git push origin feature",
        "xargs git push origin feature", "XARGS git push origin feature", "x%sargs git push origin feature" % DOTLESS_SMALL_I,
        "git ls-remote origin; echo push", "echo '%s' | git push" % DOTLESS_SMALL_I, "GIT_DIR=x git push", "git_dir=x git push origin feature",
        "GIT_CONFIG_COUNT=0 git push", "git_config_count=0 git push origin feature", "GIT_CONFIGx=1 git push origin feature",
        "git push origin feature # push", "git push origin 'feature'", 'git push origin "feat"ure', "git push 'origin' feature",
        "git push origin $'feature'", "git push origin feature\\\n", "git push \\\norigin feature", "git push origin\tfeature",
        "git push\u00a0origin feature", "git\u3000push origin feature", "git push origin feature\u2028git push origin main",
        "git push origin feature\rgit push origin main", "git push origin feature\x0bgit push", "git push origin\x1cfeature",
    ]:
        sandbox.hook_raw(payload_text(sandbox, repo, command))
    del ghd


def refspec_and_option_spellings(holder: Holder) -> None:
    sandbox, repo = feature_sandbox(holder)
    repo.git("tag", "tmp")
    repo.git("tag", "-a", "annotated", "-m", "msg")
    for command in [
        "git push --force origin feature", "git push -f origin feature", "git push origin +feature", "git push origin +feature:feature",
        "git push --tags --all", "git push --tags origin feature", "git push origin refs/tags/*", "git push origin 'refs/heads/*:refs/heads/*'",
        "git push origin HEAD^:feature", "git push origin feature~1", "git push origin 'feature^{commit}'", "git push origin :feature",
        "git push origin :", "git push origin ''", "git push '' feature", "git push origin feature:", "git push origin :feature feature",
        "git push origin tmp", "git push origin annotated", "git push origin annotated:refs/heads/x", "git push origin tmp:refs/tags/tmp",
        "git push origin refs/tags/annotated:refs/heads/z", "git push origin HEAD", "git push origin @", "git push origin @{u}",
        "git push origin feature feature", "git push origin feature main", "git push origin feature nonexist", "git push origin nonexist",
        "git push upstream feature", "git push --repo=origin feature", "git push --repo origin feature", "git push -u origin",
        "git push --set-upstream origin feature", "git push --follow-tags origin feature", "git push --atomic origin feature",
        "git push --no-verify origin feature", "git push --signed=if-asked origin feature", "git push --receive-pack=x origin feature",
        "git push --exec=x origin feature", "git push --push-option=x origin feature", "git push -o x -o y origin feature",
        "git push --force-with-lease origin feature", "git push --force-with-lease=feature:abc origin feature", "git push --prune origin",
        "git push --mirror", "git push --branches origin", "git push --all", "git push --all --dry-run origin", "git push -nu origin feature",
        "git push -dn origin feature", "git push --delete --dry-run origin feature", "git push --tags --dry-run", "git push -- origin feature",
        "git push origin -- feature", "git push -C x origin feature", "git -C / push origin feature", "git -C %s -C . push origin feature" % repo.path,
        "git -C /nonexistent push origin feature", "git -C '' push origin feature", "git -C %s/README.md push origin feature" % repo.path,
        "cd /nonexistent && git push origin feature", "cd %s && git push origin feature" % repo.path, "cd && git push origin feature",
        "cd - && git push origin feature", "cd ~ && git push origin feature", "cd $HOME && git push origin feature",
        "pushd %s >/dev/null && git push origin feature" % repo.path, "(cd %s && git push origin feature)" % repo.path,
        "git --no-pager push origin feature", "git --bare push origin feature", "git --exec-path=/x push origin feature",
        "git --namespace=x push origin feature", "git --super-prefix=x push origin feature", "git -p push origin feature",
        "git --literal-pathspecs push origin feature", "git --work-tree=%s push origin feature" % repo.path, "git --git-dir=%s/.git push origin feature" % repo.path,
        "git --git-dir %s/.git push origin feature" % repo.path, "git -c push.default=current push", "git -c user.name=x push origin feature",
        "git -c color.ui=never push origin feature", "git -c core.sshCommand=x push origin feature", "git -c credential.helper=x push origin feature",
        "git --config-env=remote.x.url=Y push origin feature", "git --config-env=color.ui=Y push origin feature",
        "git -cremote.x.url=y push origin feature", "git -c remote.x.url push origin feature", "git -c =x push origin feature",
        "git -c push.pushOption=x push origin feature", "git -c url.x.pushInsteadOf=y push origin feature",
        "GIT_CONFIG_GLOBAL=/dev/null git push origin feature", "GIT_CONFIG_NOSYSTEM=1 git push origin feature", "GIT_CONFIG_PARAMETERS=x git push",
        "GIT_SSH_COMMAND=x git push origin feature", "GIT_WORK_TREE=x git push origin feature", "env -i git push origin feature",
        "env -u GIT_DIR git push origin feature", "env GIT_DIR=x git push origin feature", "export GIT_DIR=x; git push origin feature",
        "export -n GIT_DIR; git push origin feature", "unset GIT_DIR; git push origin feature", "GIT_DIR=x; git push origin feature",
        "git push origin feature && git push origin main", "git push origin feature; git push --all", "git push origin feature | cat",
        "git push origin feature & git push origin main", "! git push origin feature", "if git push origin feature; then echo ok; fi",
        "for b in a b; do git push origin $b; done", "while true; do git push origin feature; break; done", "git push origin feature || git push origin main",
        "time git push origin feature", "nohup git push origin feature", "command git push origin feature", "builtin git push origin feature",
        "\\git push origin feature", "'git' push origin feature", '"git" push origin feature', "/usr/bin/git push origin feature",
        "./git push origin feature", "git.exe push origin feature", "git-push origin feature", "git-receive-pack x", "git-upload-pack x",
        "git merge-base HEAD main; git push", "git rebase origin/main && git push", "git commit -m 'git push origin feature'",
        "git log --grep='git push'", "echo git push origin feature", "echo 'git push' | sh", "sh -c 'git push origin feature'", "sh -c \"git push origin feature\"",
        "bash -lc 'git push origin feature'", "bash -c 'git push origin feature' arg0", "bash --norc -c 'git push origin feature'", "zsh -c 'git push origin feature'",
        "eval git push origin feature", "eval \"git push origin feature\"", "source <(echo git push)", ". ./x.sh", "bash x.sh", "python3 -c 'import os; os.system(\"git push\")'",
        "git alias push", "git p", "git psh", "git pushx", "git push-origin", "git  push  origin  feature", "git push\torigin\tfeature",
    ]:
        sandbox.hook_raw(payload_text(sandbox, repo, command))


def merge_spellings(holder: Holder) -> None:
    sandbox, repo, head = reviewed_feature(holder)
    for command in [
        "gh pr merge", "gh pr merge 7", "gh pr merge --match-head-commit %s" % head, "gh pr merge 7 --match-head-commit=%s" % head,
        "gh pr merge 7 --match-head-commit", "gh pr merge 7 --match-head-commit ''", "gh pr merge 7 --match-head-commit=",
        "gh pr merge 7 --match-head-commit nosuchsha", "gh pr merge 7 --match-head-commit %s --auto" % head,
        "gh pr merge 7 --match-head-commit %s --admin" % head, "gh pr merge 7 --match-head-commit %s --squash --delete-branch" % head,
        "gh pr merge 7 --match-head-commit %s -b body" % head, "gh pr merge 7 -b --match-head-commit %s" % head,
        "gh pr merge 7 8 --match-head-commit %s" % head, "gh pr merge -- 7 --match-head-commit %s" % head,
        "gh pr merge feature --match-head-commit %s" % head, "gh pr merge https://github.com/acme/app/pull/7 --match-head-commit %s" % head,
        "gh pr merge https://github.com/acme/other/pull/7 --match-head-commit %s" % head, "gh pr merge http://x/acme/app/pull/7 --match-head-commit %s" % head,
        "gh pr merge 7 -R acme/app --match-head-commit %s" % head, "gh pr merge 7 -Racme/app --match-head-commit %s" % head,
        "gh pr merge 7 --repo acme/app --repo acme/other --match-head-commit %s" % head, "gh pr merge 7 --repo --match-head-commit %s" % head,
        "gh pr merge 7 --repo '' --match-head-commit %s" % head, "gh pr merge 7 --repo=acme/app/x --match-head-commit %s" % head,
        "gh pr merge 7 --repo git@github.com:acme/app.git --match-head-commit %s" % head, "gh pr merge 7 --repo https://github.com/acme/app --match-head-commit %s" % head,
        "GH_REPO=acme/app gh pr merge 7 --match-head-commit %s" % head, "GH_REPO= gh pr merge 7 --match-head-commit %s" % head,
        "GH_REPO=x gh pr merge 7 --match-head-commit %s" % head, "GH_REPO=acme/other gh pr merge 7 --match-head-commit %s" % head,
        "export GH_REPO=acme/app; gh pr merge 7 --match-head-commit %s" % head, "env GH_REPO=acme/app gh pr merge 7 --match-head-commit %s" % head,
        "GH_REPO=acme/app GH_HOST=x gh pr merge 7 --match-head-commit %s" % head, "gh -R acme/app pr merge 7 --match-head-commit %s" % head,
        "gh --repo acme/app pr merge 7 --match-head-commit %s" % head, "gh pr -R acme/app merge 7 --match-head-commit %s" % head,
        "gh repo set-default acme/app && gh pr merge 7 --match-head-commit %s" % head, "gh repo set-default --view; gh pr merge 7 --match-head-commit %s" % head,
        "gh pr create && gh pr merge 7 --match-head-commit %s" % head, "gh pr view 7 && gh pr merge 7 --match-head-commit %s" % head,
        "gh pr merge 7 --match-head-commit %s && git push origin feature" % head, "gh pr merge 7 --match-head-commit %s; gh pr merge 8" % head,
        "gh pr merge 7 --match-head-commit %s | cat" % head, "$(echo gh) pr merge 7 --match-head-commit %s" % head,
        "GH=gh; $GH pr merge 7 --match-head-commit %s" % head, "gh $SUB merge 7", "gh pr $VERB 7", "gh api repos/acme/app/pulls/7/merge -X PUT",
        "gh api -X PUT repos/acme/app/pulls/7/merge -f sha=%s" % head, "gh api graphql -f query='mutation { mergePullRequest(input:{}) { x } }'",
        "gh pr merge 7 --match-head-commit %s --body 'git push'" % head, "gh pr ready 7", "gh pr checkout 7", "gh pr close 7", "gh pr comment 7 -b x",
        "gh pr edit 7 --add-label x", "gh pr list", "gh pr status", "gh pr diff 7", "gh pr review 7 --approve", "gh issue list", "gh run list",
        "gh auth status", "gh --version", "gh", "gh pr", "gh pr merge --help", "gh help pr merge",
    ]:
        sandbox.hook_raw(payload_text(sandbox, repo, command))
    responses = os.path.join(sandbox.root, "responses")
    os.makedirs(responses, exist_ok=True)
    merge = "gh pr merge 7 --match-head-commit %s" % head
    base = {"state": "OPEN", "isDraft": False, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "statusCheckRollup": [],
            "baseRefName": "main", "headRefOid": head}
    for shape in MERGE_SHAPES:
        with open(sandbox.gh_response, "w") as stream:
            json.dump(dict(base, **shape), stream)
        sandbox.hook_raw(payload_text(sandbox, repo, merge))
        sandbox.hook_raw(payload_text(sandbox, repo, merge + " --auto"))
    for answer in RAW_GH_ANSWERS:
        with open(sandbox.gh_response, "w", encoding="utf-8", errors="surrogatepass") as stream:
            stream.write(answer)
        sandbox.hook_raw(payload_text(sandbox, repo, merge))
    for depth in OVER_BOUND_NESTINGS:
        with open(sandbox.gh_response, "w") as stream:
            stream.write('{"baseRefName": "main", "number": ' + nested_lists(depth) + "}")
        send_labeled(sandbox, over_bound_label("gh-answer", depth), payload_text(sandbox, repo, merge))
    for raw in [b"\xff\xfe{}", b'{"baseRefName": "main"}\xff', b"\x00", b'{"baseRefName": "ma\xc3\xafn"}']:
        with open(sandbox.gh_response, "wb") as stream:
            stream.write(raw)
        sandbox.hook_raw(payload_text(sandbox, repo, merge))
    with open(sandbox.gh_response, "w") as stream:
        json.dump(base, stream)
    for label, gh in [("missing", os.path.join(sandbox.root, "no-such-gh")), ("directory", sandbox.root), ("devnull", "/dev/null"),
                      ("failing", write_executable(os.path.join(responses, "failing"), FAILING_GH)),
                      ("silent", write_executable(os.path.join(responses, "silent"), SILENT_GH)),
                      ("relative", "no-such-relative-gh"), ("slow", write_executable(os.path.join(responses, "slow"), SLOW_GH))]:
        sandbox.hook_raw(payload_text(sandbox, repo, merge), {"KEEL_GH": gh})
    sandbox.hook_raw(payload_text(sandbox, repo, "cd /nonexistent && " + merge))
    sandbox.hook_raw(payload_text(sandbox, repo, "GH_REPO=acme/app " + merge), {"GH_REPO": "other/x"})
    other_head = repo.commit({"src/b.py": "b = 1\n"}, "unpushed")
    for command in ["gh pr merge 7 --match-head-commit %s" % other_head, "gh pr merge 7 --match-head-commit %s" % other_head[:12]]:
        sandbox.hook_raw(payload_text(sandbox, repo, command))
    with open(sandbox.gh_response, "w") as stream:
        json.dump(dict(base, baseRefName="remote-only"), stream)
    sandbox.remote("acme", "app")
    repo.git("push", "-q", "origin", "HEAD:refs/heads/remote-only")
    sandbox.hook_raw(payload_text(sandbox, repo, merge))
    sandbox.hook_raw(payload_text(sandbox, repo, "gh pr merge 7 --match-head-commit %s" % head))


def deep_evidence_file(holder: Holder) -> None:
    for depth in OVER_BOUND_NESTINGS:
        sandbox, repo, head = reviewed_feature(holder)
        directory = os.path.join(sandbox.data, "state", "keel", "evidence", "review", "acme__app")
        for name in os.listdir(directory):
            path = os.path.join(directory, name)
            with open(path, encoding="utf-8") as stream:
                text = stream.read().rstrip()
            with open(path, "w", encoding="utf-8") as stream:
                stream.write(text[:-1] + ', "deep": ' + nested_lists(depth) + "}")
        send_labeled(sandbox, over_bound_label("evidence-file", depth), payload_text(sandbox, repo, "git push origin feature"))


def broken_state(holder: Holder) -> None:
    push = "git push origin feature"
    for registry in [["acme/app\tbogus\tmain\tacme\trequired"], ["acme/app\tcode\tmain\tacme"], ["acme/app\tcode\tmain\tacme\trequired\tmaybe"],
                     ["acme/app\tcode\tnosuchbase\tacme\trequired"], ["acme/app\tcode\tmain\tmissingset\trequired"], ["ACME/APP\tcode\tmain\tacme\trequired"],
                     ["acme/app\tcode\tmain\tacme\trequired", "acme/app\toff\tmain\t-\tnone"], ["# comment", "acme/app\tcode\tmain\tacme\trequired"],
                     ["acme/app\tcode\tmain\tacme\trequired\t\xe9"], ["acme/app \tcode\tmain\tacme\trequired"], ["acme/app\tcode\tmain\tacme\tnone"],
                     ["acme/app\tsmoke\tmain\t-\tnone"], ["acme/app\tcode\t\tacme\trequired"], ["acme/app\tcode\tmain\t-\trequired"]]:
        sandbox, repo = feature_sandbox(holder, registry=registry)
        sandbox.hook_raw(payload_text(sandbox, repo, push))
        sandbox.hook_raw(payload_text(sandbox, repo, "gh pr create --title t"))
        sandbox.hook_raw(payload_text(sandbox, repo, "git push origin main"))
    sandbox, repo = feature_sandbox(holder)
    with open(os.path.join(sandbox.overlay, "gated-repos.tsv"), "wb") as stream:
        stream.write(b"origin\tgate\tintegration_base\trisk_rules\ttests\n\xff\xfe\n")
    sandbox.hook_raw(payload_text(sandbox, repo, push))
    sandbox, repo = feature_sandbox(holder)
    with open(os.path.join(sandbox.overlay, "gated-repos.tsv"), "w") as stream:
        stream.write("acme/app\tcode\tmain\tacme\trequired\n")
    sandbox.hook_raw(payload_text(sandbox, repo, push))
    sandbox, repo = feature_sandbox(holder)
    sandbox.risk_rules(["acme\t*\tbogus"])
    sandbox.hook_raw(payload_text(sandbox, repo, push))
    sandbox, repo = feature_sandbox(holder)
    sandbox.risk_rules(["acme\t*"])
    sandbox.hook_raw(payload_text(sandbox, repo, push))
    sandbox, repo = feature_sandbox(holder)
    os.unlink(os.path.join(sandbox.overlay, "risk-rules.tsv"))
    sandbox.hook_raw(payload_text(sandbox, repo, push))
    sandbox, repo = feature_sandbox(holder)
    sandbox.hook_raw(payload_text(sandbox, repo, push), {"KEEL_OVERLAY_DIR": os.path.join(sandbox.root, "no-overlay")})
    sandbox.hook_raw(payload_text(sandbox, repo, push), {"KEEL_DATA_DIR": os.path.join(sandbox.root, "other-data")})
    sandbox.hook_raw(payload_text(sandbox, repo, push), {"KEEL_DATA_DIR": os.path.join(sandbox.root, "gc.stamp-parent", "x")})
    sandbox, repo = feature_sandbox(holder)
    state = os.path.join(sandbox.data, "state", "keel")
    os.makedirs(state)
    with open(os.path.join(state, "sessions"), "w") as stream:
        stream.write("a file where the sessions directory goes")
    sandbox.remove_registry()
    sandbox.hook_raw(payload_text(sandbox, repo, push))
    sandbox, repo = feature_sandbox(holder)
    os.makedirs(os.path.join(sandbox.data, "state", "keel", "gc.stamp"))
    sandbox.hook_raw(payload_text(sandbox, repo, "git push origin main"))
    sandbox, repo = feature_sandbox(holder)
    os.makedirs(os.path.join(sandbox.data, "state", "keel"))
    with open(os.path.join(sandbox.data, "state", "keel", "evidence"), "w") as stream:
        stream.write("a file where the evidence directory goes")
    sandbox.hook_raw(payload_text(sandbox, repo, push))
    sandbox.hook_raw(payload_text(sandbox, repo, "git push origin main"))
    sandbox, repo = feature_sandbox(holder)
    sandbox.full_bundle(repo)
    evidence = sandbox.evidence_files("review")[0]
    directory = os.path.dirname(evidence)
    with open(evidence) as stream:
        text = stream.read()
    old = os.path.join(sandbox.data, "state", "keel", "gc.stamp")
    for label, content in [("expired", text.replace('"expires_at": "20', '"expires_at": "19')), ("garbage", "{not json"), ("empty", ""),
                           ("list", "[]"), ("nulls", text.replace('"expires_at"', '"expires_atx"')), ("bom", "\ufeff" + text)]:
        with open(os.path.join(directory, "review-%s.json" % label), "w", encoding="utf-8") as stream:
            stream.write(content)
        sandbox.hook_raw(payload_text(sandbox, repo, push))
        sandbox.hook_raw(payload_text(sandbox, repo, "git push origin main"))
        if os.path.exists(old):
            ago = time.time() - 3 * 24 * 3600
            os.utime(old, (ago, ago))
        sandbox.hook_raw(payload_text(sandbox, repo, push))
    sandbox, repo = feature_sandbox(holder)
    sandbox.make_logs_unwritable()
    for command in ["gh pr create --title t", "git status", "git push origin main", "git push origin feature", "ls", "gh pr merge 7"]:
        sandbox.hook_raw(payload_text(sandbox, repo, command))
    sandbox.hook_raw("not json")
    sandbox.hook_raw('{"truncated push')
    sandbox, repo = feature_sandbox(holder, claude=False)
    sandbox.hook_raw(payload_text(sandbox, repo, "git status", tool_input={}))
    sandbox.hook_raw(payload_text(sandbox, repo, "git status", tool_input="gh pr merge 7"))
    sandbox.hook_raw('{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": []}')


def repository_states(holder: Holder) -> None:
    push = "git push origin feature"
    sandbox, repo = feature_sandbox(holder)
    repo.git("checkout", "-q", "--detach")
    for command in [push, "git push", "git push origin HEAD", "git push origin HEAD:feature", "git push -u", "git push origin main"]:
        sandbox.hook_raw(payload_text(sandbox, repo, command))
    sandbox, repo = feature_sandbox(holder)
    repo.git("remote", "remove", "origin")
    for command in [push, "git push", "git push mirror feature", "gh pr merge 7", "gh pr merge 7 --match-head-commit abc", "gh pr create"]:
        sandbox.hook_raw(payload_text(sandbox, repo, command))
    sandbox, repo = feature_sandbox(holder)
    repo.git("update-ref", "-d", "refs/remotes/origin/main")
    for command in [push, "gh pr create", "git push origin main", "git push --tags", "git push --delete origin feature"]:
        sandbox.hook_raw(payload_text(sandbox, repo, command))
    sandbox, repo = feature_sandbox(holder)
    repo.git("config", "remote.origin.url", "")
    for command in [push, "git push origin main", "gh pr merge 7"]:
        sandbox.hook_raw(payload_text(sandbox, repo, command))
    for url in ["origin-is-a-word", "/nonexistent/path", "file:///nonexistent", "https://github.com/acme", "https://github.com/acme/app/", "https://github.com/acme/app.git/",
                "git@github.com:acme/app", "ssh://git@github.com:22/acme/app.git", "ext::sh -c x", "https://github.com/Acme/App", "https://github.com/acme/app/extra",
                "acme/app", "../x", "C:\\x\\y", "https://user:pw@github.com/acme/app", "https://github.com:443/acme/app.git"]:
        sandbox, repo = feature_sandbox(holder)
        repo.git("remote", "set-url", "origin", url)
        sandbox.hook_raw(payload_text(sandbox, repo, push))
        sandbox.hook_raw(payload_text(sandbox, repo, "git push"))
        sandbox.hook_raw(payload_text(sandbox, repo, "gh pr merge 7 --match-head-commit abc"))
        sandbox.hook_raw(payload_text(sandbox, repo, "gh pr create"))
        sandbox.hook_raw(payload_text(sandbox, repo, "git push %s feature" % url))
    sandbox, repo = feature_sandbox(holder)
    for command in ["git push %s feature" % sandbox.remote("acme", "app"), "git push file://%s feature" % sandbox.remote("acme", "app"),
                    "git push %s feature" % os.path.relpath(sandbox.remote("acme", "app"), repo.path), "git push ../../remotes/acme/app.git feature",
                    "git push . feature", "git push .. feature", "git push ~ feature", "git push $HOME feature", "git push -- feature",
                    "git push https://github.com/acme/app.git feature", "git push git@github.com:acme/app.git feature", "git push github.com:acme/app feature",
                    "git push ssh://x/acme/app feature", "git push http://x/acme/app feature", "git push ext::x feature", "git push fd::3 feature",
                    "git push a:b:c feature", "git push 'a b' feature", "git push C:/x feature"]:
        sandbox.hook_raw(payload_text(sandbox, repo, command))
    sandbox, repo = feature_sandbox(holder)
    bare = os.path.join(sandbox.root, "bare.git")
    helpers_run(["git", "init", "-q", "--bare", bare], sandbox)
    for cwd in [bare, os.path.join(repo.path, ".git"), os.path.join(repo.path, ".git", "refs")]:
        sandbox.hook_raw(payload_text(sandbox, repo, push, cwd=cwd))
    sandbox, repo = feature_sandbox(holder)
    repo.git("config", "branch.feature.remote", "mirror")
    repo.git("config", "remote.mirror.url", sandbox.remote("acme", "app"))
    repo.git("config", "remote.mirror.pushurl", sandbox.remote("other", "x"))
    for command in ["git push", "git push mirror feature", push]:
        sandbox.hook_raw(payload_text(sandbox, repo, command))
    sandbox, repo = feature_sandbox(holder, registry=["acme/app\tcode\tmain\tacme\trequired", "acme/x\tcode\tmain\tacme\trequired"])
    repo.git("config", "--add", "remote.origin.pushurl", sandbox.remote("acme", "x"))
    repo.git("config", "--add", "remote.origin.pushurl", sandbox.remote("acme", "app"))
    for command in [push, "git push", "gh pr merge 7", "gh pr create"]:
        sandbox.hook_raw(payload_text(sandbox, repo, command))
    sandbox, repo = feature_sandbox(holder)
    repo.git("config", "remote.origin.gh-resolved", "base")
    repo.git("remote", "add", "up", sandbox.remote("other", "x"))
    repo.git("config", "remote.up.gh-resolved", "other/x")
    for command in ["gh pr merge 7", "gh pr merge 7 --match-head-commit abc", "gh repo set-default x/y && gh pr merge 7"]:
        sandbox.hook_raw(payload_text(sandbox, repo, command))
    sandbox, repo = feature_sandbox(holder, registry=["acme/app\tcode\tmain\tacme\trequired", "other/x\tcode\tmain\tacme\trequired"])
    repo.git("remote", "add", "up", sandbox.remote("other", "x"))
    for command in ["gh pr merge 7", "gh pr merge 7 --repo other/x", "git push up feature", "git push up", "gh pr create"]:
        sandbox.hook_raw(payload_text(sandbox, repo, command))
    sandbox = Sandbox(holder, registry=["acme/platform\tcode\tmain\tacme\trequired", "acme/lib\tcode\tmain\tacme\trequired"])
    sandbox.stub_claude()
    parent, submodule = sandbox.clone_with_submodule()
    for repository in (parent, submodule):
        repository.git("checkout", "-q", "-b", "feature")
    submodule.commit({"lib.py": "LIB = 2\n", "tests/test_lib.py": TEST}, "lib change")
    parent.git("add", "lib")
    parent.git("commit", "-q", "-m", "bump lib")
    for repository in (parent, submodule):
        for command in [push, "git push", "git -C lib push origin feature", "git -C .. push origin feature", "cd lib && git push origin feature",
                        "git push --recurse-submodules=check origin feature", "git submodule foreach 'git push origin feature'", "gh pr create"]:
            sandbox.hook_raw(payload_text(sandbox, repository, command))
    sandbox.review(submodule, run_id="rv-run-0001")
    sandbox.tests_evidence(submodule)
    sandbox.approve("rv-run-0001")
    for command in [push, "git push", "git push origin feature:other", "gh pr create"]:
        sandbox.hook_raw(payload_text(sandbox, submodule, command))
    sandbox.hook_raw(payload_text(sandbox, parent, push))


def helpers_run(argv, sandbox: Sandbox) -> None:
    import subprocess
    subprocess.run(argv, check=True, env=sandbox.env, capture_output=True)


def record_all(recorder) -> None:
    original_hook_raw = helpers.Sandbox.hook_raw

    def recording_hook_raw(self, stdin, extra_env=None):
        recorder.record(self.root, stdin, dict(self.env, **(extra_env or {})), os.getcwd(), PendingLabel.value)
        return original_hook_raw(self, stdin, extra_env)

    helpers.Sandbox.hook_raw = recording_hook_raw
    for scenario in (malformed_payloads, unicode_and_case_spellings, refspec_and_option_spellings, merge_spellings, deep_evidence_file,
                     broken_state, repository_states):
        recorder.current_test = scenario.__name__
        holder = Holder()
        try:
            scenario(holder)
        finally:
            holder.doCleanups()
