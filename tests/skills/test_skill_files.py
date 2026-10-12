from __future__ import annotations

import os
import re
import shutil
import sys
import tempfile
import unittest
from unittest import mock

from helpers import (GENERATED_HEADER, KEEL_HOME, K5_SUB_IDS, PRINCIPLES, SKILLS_DIR, VALID_IDS, bullet_tags,
                     read, rules_section, skill_paths)

EXPECTED_SKILLS = {'prompt-refine', 'readable-code', 'descend'}
CLAUDE_MD_CAP = 4096
PERSONAL_BUDGET = 1024
SKILL_LINE_CAP = 500
DESCRIPTION_CAP = 1024
# A description says when to load the skill; step order belongs in the body.
STEP_WORDS = re.compile(r'\bthen\b|→|->|\b(?:next|finally)\b|(?:^|\s)\d+[.)]\s', re.IGNORECASE)
EMPHATIC = re.compile(r'\b(?:MUST|NEVER|CRITICAL|IMPORTANT|ALWAYS|REQUIRED)\b')
CODE = re.compile(r'```.*?```|`[^`\n]*`', re.DOTALL)
DESIGN = os.path.join(KEEL_HOME, 'docs', 'DESIGN.md')
LEDGER_HEADER = 'id\tscope\ttype\tstatement\tlayer\tenforced_at\twhy_not_stronger\tjustification\tincidents\tmetric\treview_by\tgrace_until\tstatus'


def parse_frontmatter(text):
    """{key: value} of the leading `---` block, or None when the file does not open with one."""
    lines = text.splitlines()
    if not lines or lines[0] != '---' or '---' not in lines[1:]:
        return None
    end = lines.index('---', 1)
    fields = {}
    for line in lines[1:end]:
        key, sep, value = line.partition(':')
        if not sep:
            return None
        fields[key.strip()] = value.strip()
    return fields


def fenced_block_after(text, label_line):
    """The fenced block that directly follows the line equal to label_line, or None."""
    match = re.search(r'^' + re.escape(label_line) + r'\n```\n(.*?)^```', text, re.MULTILINE | re.DOTALL)
    return match.group(1) if match else None


def step_words(description):
    return [m.group(0).strip() for m in STEP_WORDS.finditer(description)]


def emphatic_words(skill_text):
    """Emphatic all-caps words in the body after the frontmatter, outside code."""
    body = skill_text.split('\n---\n', 1)[1] if skill_text.startswith('---\n') else skill_text
    return EMPHATIC.findall(CODE.sub('', body))


class FrontmatterTest(unittest.TestCase):

    def test_skills_existExactly_forThisTrack(self):
        # given / when
        names = {os.path.basename(os.path.dirname(p)) for p in skill_paths()}
        # then
        self.assertEqual(names, EXPECTED_SKILLS)

    def test_frontmatter_namesItsDirectory_forEverySkill(self):
        for path in skill_paths():
            with self.subTest(path=path):
                fields = parse_frontmatter(read(path))
                self.assertIsNotNone(fields, 'SKILL.md must open with a --- frontmatter block')
                self.assertEqual(fields.get('name'), os.path.basename(os.path.dirname(path)))

    def test_frontmatter_statesWhenAndWhenNot_forEverySkill(self):
        for path in skill_paths():
            with self.subTest(path=path):
                description = parse_frontmatter(read(path)).get('description', '')
                self.assertTrue(0 < len(description) <= DESCRIPTION_CAP)
                self.assertRegex(description, r'Trigger;|Load before')
                self.assertIn('Do NOT use', description)

    def test_frontmatter_describesWhenNotHow_forEverySkill(self):
        for path in skill_paths():
            with self.subTest(path=path):
                description = parse_frontmatter(read(path)).get('description', '')
                self.assertEqual(step_words(description), [])

    def test_stepWords_findsProcedure_whenDescriptionListsSteps(self):
        # given
        procedure = 'Move the finding down, then point the row at it. 1. pick 2) fix; next retire → done -> end'
        when_only = 'Moving a finding to a stronger layer. Trigger; "descend this rule". Do NOT use for a one-off.'
        # when / then
        self.assertEqual(step_words(procedure), ['then', '1.', '2)', 'next', '→', '->'])
        self.assertEqual(step_words(when_only), [])

    def test_skillBodies_haveNoEmphaticCaps_forEverySkill(self):
        for path in skill_paths():
            with self.subTest(path=path):
                self.assertEqual(emphatic_words(read(path)), [])

    def test_emphaticWords_findsCapsOutsideCode_butNotInFrontmatterOrCode(self):
        # given
        text = '---\ndescription: Do NOT use. MUST\n---\nit MUST fail; `NEVER` here\n```\nALWAYS\n```\nIMPORTANT\n'
        # when / then
        self.assertEqual(emphatic_words(text), ['MUST', 'IMPORTANT'])

    def test_parseFrontmatter_returnsNone_whenBlockMissingOrMalformed(self):
        # given
        no_block = '# Title\nbody\n'
        unclosed = '---\nname: x\n'
        malformed = '---\nname x\n---\n'
        # when / then
        self.assertIsNone(parse_frontmatter(no_block))
        self.assertIsNone(parse_frontmatter(unclosed))
        self.assertIsNone(parse_frontmatter(malformed))


class IdTaggingTest(unittest.TestCase):

    def assert_all_tagged(self, tagged, where):
        self.assertTrue(tagged, f'{where}: no bullet lines found (a vacuous pass)')
        untagged = [line for line, tag in tagged if tag is None]
        unknown = [line for line, tag in tagged if tag is not None and tag not in VALID_IDS]
        self.assertEqual(untagged, [], f'{where}: bullets without a leading [ID]')
        self.assertEqual(unknown, [], f'{where}: bullets with an unknown [ID]')

    def test_principles_tagsEveryBullet_withLedgerId(self):
        # given
        lines = read(PRINCIPLES).splitlines()
        # when
        tagged = bullet_tags(lines)
        # then
        self.assert_all_tagged(tagged, 'PRINCIPLES.md')

    def test_principles_coversCharterRiskAndFloor(self):
        tags = {tag for _, tag in bullet_tags(read(PRINCIPLES).splitlines())}
        self.assertTrue({'K1', 'K2', 'K3', 'K4', 'K5', 'risk', 'F-irreversible', 'F-secrets', 'F-attribution',
                         'F-force-push', 'F-hookskip'} <= tags)

    def test_skillRules_tagEveryBullet_withLedgerId(self):
        for path in skill_paths():
            with self.subTest(path=path):
                self.assert_all_tagged(bullet_tags(rules_section(read(path))), path)

    def test_readableCode_tagsEachSubCheckOnce_K5_1to16(self):
        # given
        path = os.path.join(SKILLS_DIR, 'readable-code', 'SKILL.md')
        # when
        sub_tags = [tag for _, tag in bullet_tags(rules_section(read(path))) if tag and tag.startswith('K5.')]
        # then
        self.assertEqual(sorted(sub_tags), sorted(K5_SUB_IDS))

    def test_bulletTags_reportsMissingTag_whenIdIsNotFirst(self):
        # given
        lines = ['- [K4] tagged', '- untagged [K4] later', '1. [K5.3] numbered', 'not a bullet [K1]']
        # when
        tagged = bullet_tags(lines)
        # then
        self.assertEqual([tag for _, tag in tagged], ['K4', None, 'K5.3'])

    def test_rulesSection_stopsAtNextHeading_andSkipsFences(self):
        # given
        text = '## Rules\n- [K4] in\n```\n## Rules\n- not a rule\n```\n## Output\n- out\n'
        # when
        lines = rules_section(text)
        # then
        self.assertEqual(lines, ['- [K4] in'])

    def test_rulesSection_readsAHeadingThatIsNotExactlyRules(self):
        for heading in ('## Rules (hard)', '## Rules:', '## rules'):
            with self.subTest(heading=heading):
                self.assertEqual(rules_section(heading + '\n- [K4] in\n## Output\n'), ['- [K4] in'])


class ApprovalWordingTest(unittest.TestCase):

    def test_approvalDocs_namePlainApproveWithoutReadOrSizeCap_forPrinciplesAndHighTier(self):
        # given: the merge gate reads only a plain `keel approve` record; `--read` writes an ack no gate reads
        paths = [PRINCIPLES, os.path.join(SKILLS_DIR, 'readable-code', 'SKILL.md')]
        for path in paths:
            with self.subTest(path=path):
                # when
                text = read(path)
                # then
                self.assertIn('`keel approve <root_run_id>`', text)
                self.assertNotIn('<root_run_id> --read`', text)
                self.assertNotIn('size cap', text)


class SizeBudgetTest(unittest.TestCase):

    def test_generatedClaudeMd_fitsCap_withOneKilobytePersonal(self):
        # given: the generated file is header, PRINCIPLES.md, a blank line, PERSONAL.md
        principles = read(PRINCIPLES).encode('utf-8')
        # when
        total = len(GENERATED_HEADER.encode('utf-8')) + 1 + len(principles) + 1 + PERSONAL_BUDGET
        # then
        self.assertLessEqual(total, CLAUDE_MD_CAP, f'PRINCIPLES.md is {len(principles)} bytes')

    def test_skillFiles_stayUnderLineCap(self):
        for path in skill_paths():
            with self.subTest(path=path):
                self.assertLess(len(read(path).splitlines()), SKILL_LINE_CAP)


class ExampleDataTest(unittest.TestCase):

    def test_descendedRowExample_matchesLedgerShape(self):
        # given
        path = os.path.join(KEEL_HOME, 'examples', 'skills', 'descended-row.tsv')
        rows = [line for line in read(path).splitlines() if line and not line.startswith('#')]
        # when
        header, cells = rows[0], rows[1].split('\t')
        fields = dict(zip(header.split('\t'), cells))
        # then
        self.assertEqual(header, LEDGER_HEADER)
        self.assertEqual(len(cells), 13)
        self.assertEqual(fields['layer'], 'repo')
        self.assertTrue(fields['enforced_at'].startswith('repo:'))
        self.assertTrue(fields['metric'].startswith('exists:'))
        self.assertEqual(fields['why_not_stronger'], '-')
        self.assertGreaterEqual(len(fields['incidents'].split(',')), 2)
        self.assertRegex(fields['id'], r'^(K[1-7]|risk|[CSOF]-[a-z0-9-]+)$')

    def test_designGatedReposExample_parsesWithRegistry_whenCopiedAsOverlay(self):
        # given
        block = fenced_block_after(read(DESIGN), '`gated-repos.tsv`')
        self.assertIsNotNone(block, 'DESIGN.md Interfaces (h) lost its gated-repos.tsv example')
        overlay = tempfile.mkdtemp(prefix='keel-design-overlay-')
        self.addCleanup(shutil.rmtree, overlay, True)
        with open(os.path.join(overlay, 'gated-repos.tsv'), 'w', encoding='utf-8') as f:
            f.write(block)
        sys.path.insert(0, os.path.join(KEEL_HOME, 'lib'))
        self.addCleanup(sys.path.remove, os.path.join(KEEL_HOME, 'lib'))
        from evidence import registry
        # when
        with mock.patch.dict(os.environ, {'KEEL_OVERLAY_DIR': overlay}):
            repos = registry.gated_repos()
        # then
        self.assertEqual(repos['example/notes-data'].push_approval, 'false')
        self.assertEqual(repos['acmecorp/deploy-config'].push_approval, 'true')

    def test_fencedBlockAfter_returnsNone_whenLabelHasNoFence(self):
        # given
        text = '`gated-repos.tsv`\nprose, not a fence\n'
        # when
        block = fenced_block_after(text, '`gated-repos.tsv`')
        # then
        self.assertIsNone(block)


if __name__ == '__main__':
    unittest.main()
