"""Copies that shipped code may not import across tracks, pinned to their source by reading both files as text."""
from __future__ import annotations

import ast
import os
import unittest

from helpers import CHECKOUT, read_text

LINK_HEADER_SOURCE = ("lib/link/claude_md.py", "HEADER")
HEADER_COPIES = (
    ("measure/evals/lib/evalkit/liveconfig.py", "GENERATED_CLAUDE_MD_HEADER"),
    ("tests/measure/eval_helpers.py", "GENERATED_HEADER"),
    ("tests/skills/helpers.py", "GENERATED_HEADER"),
)
GRADE_MODULE = ("measure/evals/lib/evalkit/grade.py", "REFINED_REQUEST_HEADER")
RULES_HEADING_SOURCE = ("measure/lib/measurekit/smoke_files.py", "RULES_HEADING_PATTERN")
RULES_HEADING_COPY = ("tests/skills/helpers.py", "RULES_HEADING_PATTERN")
PROMPT_REFINE_SKILL = "skills/prompt-refine/SKILL.md"


def string_constant(relative_path: str, name: str) -> str:
    """The value of a module-level `name = <string literal>` in the file, without importing it."""
    tree = ast.parse(read_text(os.path.join(CHECKOUT, relative_path)))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError("%s defines no %s" % (relative_path, name))


class SharedCopiesTest(unittest.TestCase):
    def test_generatedClaudeMdHeader_equalsLinkHeader_inEveryCopy(self) -> None:
        # given
        source = string_constant(*LINK_HEADER_SOURCE)
        # when
        copies = {path: string_constant(path, name) for path, name in HEADER_COPIES}
        # then
        self.assertEqual(copies, {path: source for path, _ in HEADER_COPIES})

    def test_refinedRequestHeader_isAHeadingInThePromptRefineSkill(self) -> None:
        # given
        heading = "## " + string_constant(*GRADE_MODULE)
        # when
        lines = [line.strip() for line in read_text(os.path.join(CHECKOUT, PROMPT_REFINE_SKILL)).splitlines()]
        # then
        self.assertIn(heading, lines)

    def test_stringConstant_raises_whenTheNameIsMissing(self) -> None:
        # when / then
        with self.assertRaises(AssertionError):
            string_constant(LINK_HEADER_SOURCE[0], "NO_SUCH_NAME")

    def test_rulesHeadingPattern_ofTheSkillsTests_equalsSmoke(self) -> None:
        self.assertEqual(string_constant(*RULES_HEADING_COPY), string_constant(*RULES_HEADING_SOURCE))


if __name__ == "__main__":
    unittest.main()
