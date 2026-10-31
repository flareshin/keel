import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { gatedRepos } from "../../lib/evidence/registry.ts";
import { splitlines } from "../../hooks/lib/hookkit/text.ts";
import { scanFences } from "../../measure/lib/measurekit/fences.ts";
import { AGENTS_DIR, agentPaths, bulletTags, GENERATED_HEADER, K5_SUB_IDS, KEEL_HOME, markdownPaths, PRINCIPLES, read, rulesSection, SKILLS_DIR, skillPaths, VALID_IDS } from "./helpers.ts";

const EXPECTED_SKILLS = new Set(["prompt-refine", "readable-code", "descend", "improve", "no-comments"]);
const CLAUDE_MD_CAP = 4608;
const PERSONAL_BUDGET = 1024;
const SKILL_LINE_CAP = 500;
const DESCRIPTION_CAP = 1024;
const STEP_WORDS = /\bthen\b|→|->|\b(?:next|finally)\b|(?:^|\s)\d+[.)]\s/gi;
const EMPHATIC = /\b(?:MUST|NEVER|CRITICAL|IMPORTANT|ALWAYS|REQUIRED)\b/g;
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const DESIGN = join(KEEL_HOME, "docs", "DESIGN.md");
const LEDGER_HEADER = "id\tscope\ttype\tstatement\tlayer\tenforced_at\twhy_not_stronger\tjustification\tincidents\tmetric\treview_by\tgrace_until\tstatus";
const MANDATORY_IDS = ["K1", "K2", "K3", "K4", "K5", "risk", "F-irreversible", "F-secrets", "F-attribution", "F-force-push", "F-hookskip"];

function parseFrontmatter(text: string): Record<string, string> | null {
  const lines = splitlines(text);
  if (lines.length === 0 || lines[0] !== "---" || !lines.slice(1).includes("---")) return null;
  const end = lines.indexOf("---", 1);
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const cut = line.indexOf(":");
    if (cut < 0) return null;
    fields[line.slice(0, cut).trim()] = line.slice(cut + 1).trim();
  }
  return fields;
}

function fencedBlockAfter(text: string, labelLine: string): string | null {
  const escaped = labelLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\n\`\`\`\\n([\\s\\S]*?)^\`\`\``, "m").exec(text)?.[1] ?? null;
}

function stepWords(description: string): string[] {
  return Array.from(description.matchAll(STEP_WORDS), (match) => match[0].trim());
}

function emphaticWords(skillText: string): string[] {
  const body = skillText.startsWith("---\n") ? (skillText.split("\n---\n").slice(1).join("\n---\n")) : skillText;
  return body.replace(CODE, "").match(EMPHATIC) ?? [];
}

function skillNames(): string[] {
  return skillPaths().map((path) => basename(dirname(path)));
}

describe("frontmatter", () => {
  it("test_skills_existExactly_forThisTrack", () => {
    assert.deepEqual(new Set(skillNames()), EXPECTED_SKILLS);
  });

  it("test_frontmatter_namesItsDirectory_forEverySkill", () => {
    for (const path of skillPaths()) {
      const fields = parseFrontmatter(read(path));
      assert.notEqual(fields, null, `${path} must open with a --- frontmatter block`);
      assert.equal(fields?.["name"], basename(dirname(path)));
    }
  });

  it("test_frontmatter_statesWhenAndWhenNot_forEverySkill", () => {
    for (const path of skillPaths()) {
      const description = parseFrontmatter(read(path))?.["description"] ?? "";
      assert.ok(description.length > 0 && description.length <= DESCRIPTION_CAP, path);
      assert.match(description, /Trigger;|Load before/);
      assert.ok(description.includes("Do NOT use"), path);
    }
  });

  it("test_frontmatter_describesWhenNotHow_forEverySkill", () => {
    for (const path of skillPaths()) assert.deepEqual(stepWords(parseFrontmatter(read(path))?.["description"] ?? ""), [], path);
  });

  it("test_stepWords_findsProcedure_whenDescriptionListsSteps", () => {
    const procedure = "Move the finding down, then point the row at it. 1. pick 2) fix; next retire → done -> end";
    const whenOnly = 'Moving a finding to a stronger layer. Trigger; "descend this rule". Do NOT use for a one-off.';
    assert.deepEqual(stepWords(procedure), ["then", "1.", "2)", "next", "→", "->"]);
    assert.deepEqual(stepWords(whenOnly), []);
  });

  it("test_skillBodies_haveNoEmphaticCaps_forEverySkill", () => {
    for (const path of skillPaths()) assert.deepEqual(emphaticWords(read(path)), [], path);
  });

  it("test_emphaticWords_findsCapsOutsideCode_butNotInFrontmatterOrCode", () => {
    const text = "---\ndescription: Do NOT use. MUST\n---\nit MUST fail; `NEVER` here\n```\nALWAYS\n```\nIMPORTANT\n";
    assert.deepEqual(emphaticWords(text), ["MUST", "IMPORTANT"]);
  });

  it("test_parseFrontmatter_returnsNone_whenBlockMissingOrMalformed", () => {
    assert.equal(parseFrontmatter("# Title\nbody\n"), null);
    assert.equal(parseFrontmatter("---\nname: x\n"), null);
    assert.equal(parseFrontmatter("---\nname x\n---\n"), null);
  });
});

describe("agent files", () => {
  it("test_agentFrontmatter_namesFileAndListsTools_forEveryAgent", () => {
    const paths = agentPaths();
    assert.ok(paths.length > 0, "no agent files found (a vacuous pass)");
    for (const path of paths) {
      const fields = parseFrontmatter(read(path));
      assert.notEqual(fields, null, `${path} must open with a --- frontmatter block`);
      assert.equal(fields?.["name"], basename(path, ".md"), path);
      const description = fields?.["description"] ?? "";
      assert.ok(description.length > 0 && description.length <= DESCRIPTION_CAP, path);
      assert.ok((fields?.["tools"] ?? "").length > 0, `${path} must list its tools; without tools: it inherits every tool`);
    }
  });

  it("test_links_installEveryAgent_underDataAgents", () => {
    const links = new Set(splitlines(read(join(KEEL_HOME, "settings", "links.tsv"))));
    const paths = agentPaths();
    assert.ok(paths.length > 0, "no agent files found (a vacuous pass)");
    for (const path of paths) {
      const name = basename(path);
      assert.ok(links.has(`{{KEEL}}/agents/${name}\tagents/${name}`), `settings/links.tsv must install agents/${name}`);
    }
  });
});

describe("code fences", () => {
  it("test_markdownFences_closeAndNest_forEverySkillAndAgentFile", () => {
    const paths = markdownPaths();
    assert.ok(paths.some((path) => path.endsWith("SKILL.md")) && paths.some((path) => dirname(path) === AGENTS_DIR), "skill or agent markdown missing (a vacuous pass)");
    for (const path of paths) assert.deepEqual(scanFences(splitlines(read(path))).problems, [], path);
  });
});

describe("id tagging", () => {
  function assertAllTagged(tagged: Array<[string, string | null]>, where: string): void {
    assert.ok(tagged.length > 0, `${where}: no bullet lines found (a vacuous pass)`);
    assert.deepEqual(tagged.filter(([, tag]) => tag === null).map(([line]) => line), [], `${where}: bullets without a leading [ID]`);
    assert.deepEqual(tagged.filter(([, tag]) => tag !== null && !VALID_IDS.has(tag)).map(([line]) => line), [], `${where}: bullets with an unknown [ID]`);
  }

  it("test_principles_tagsEveryBullet_withLedgerId", () => {
    assertAllTagged(bulletTags(splitlines(read(PRINCIPLES))), "PRINCIPLES.md");
  });

  it("test_principles_coversCharterRiskAndFloor", () => {
    const tags = new Set(bulletTags(splitlines(read(PRINCIPLES))).map(([, tag]) => tag));
    for (const id of MANDATORY_IDS) assert.ok(tags.has(id), id);
  });

  it("test_skillRules_tagEveryBullet_withLedgerId", () => {
    for (const path of skillPaths()) assertAllTagged(bulletTags(rulesSection(read(path))), path);
  });

  it("test_readableCode_tagsEachSubCheckOnce_K5_1to16", () => {
    const path = join(SKILLS_DIR, "readable-code", "SKILL.md");
    const subTags = bulletTags(rulesSection(read(path))).map(([, tag]) => tag).filter((tag): tag is string => tag !== null && tag.startsWith("K5."));
    assert.deepEqual([...subTags].sort(), [...K5_SUB_IDS].sort());
  });

  it("test_bulletTags_reportsMissingTag_whenIdIsNotFirst", () => {
    const lines = ["- [K4] tagged", "- untagged [K4] later", "1. [K5.3] numbered", "not a bullet [K1]"];
    assert.deepEqual(bulletTags(lines).map(([, tag]) => tag), ["K4", null, "K5.3"]);
  });

  it("test_rulesSection_stopsAtNextHeading_andSkipsFences", () => {
    const text = "## Rules\n- [K4] in\n```\n## Rules\n- not a rule\n```\n## Output\n- out\n";
    assert.deepEqual(rulesSection(text), ["- [K4] in"]);
  });

  it("test_rulesSection_keepsRulesAfterALongerOuterFence_thatHoldsAShorterOne", () => {
    const text = "## Rules\n- [K4] a\n````markdown\n```\n- example\n````\n- [K4] b\n## Output\n";
    assert.deepEqual(rulesSection(text), ["- [K4] a", "- [K4] b"]);
  });

  it("test_rulesSection_readsAHeadingThatIsNotExactlyRules", () => {
    for (const heading of ["## Rules (hard)", "## Rules:", "## rules"]) {
      assert.deepEqual(rulesSection(`${heading}\n- [K4] in\n## Output\n`), ["- [K4] in"], heading);
    }
  });
});

describe("approval wording", () => {
  it("test_approvalDocs_namePlainApproveWithoutReadOrSizeCap_forPrinciplesAndHighTier", () => {
    for (const path of [PRINCIPLES, join(SKILLS_DIR, "readable-code", "SKILL.md")]) {
      const text = read(path);
      assert.ok(text.includes("`keel approve <root_run_id>`"), path);
      assert.ok(!text.includes("<root_run_id> --read`"), path);
      assert.ok(!text.includes("size cap"), path);
    }
  });
});

describe("size budget", () => {
  it("test_generatedClaudeMd_fitsCap_withOneKilobytePersonal", () => {
    const principles = Buffer.byteLength(read(PRINCIPLES), "utf8");
    const total = Buffer.byteLength(GENERATED_HEADER, "utf8") + 1 + principles + 1 + PERSONAL_BUDGET;
    assert.ok(total <= CLAUDE_MD_CAP, `PRINCIPLES.md is ${principles} bytes`);
  });

  it("test_skillFiles_stayUnderLineCap", () => {
    for (const path of skillPaths()) assert.ok(splitlines(read(path)).length < SKILL_LINE_CAP, path);
  });
});

describe("example data", () => {
  it("test_descendedRowExample_matchesLedgerShape", () => {
    const rows = splitlines(read(join(KEEL_HOME, "examples", "skills", "descended-row.tsv"))).filter((line) => line !== "" && !line.startsWith("#"));
    const header = rows[0] as string;
    const cells = (rows[1] as string).split("\t");
    const fields = Object.fromEntries(header.split("\t").map((name, index) => [name, cells[index]]));
    assert.equal(header, LEDGER_HEADER);
    assert.equal(cells.length, 13);
    assert.equal(fields["layer"], "repo");
    assert.ok(fields["enforced_at"]?.startsWith("repo:"));
    assert.ok(fields["metric"]?.startsWith("exists:"));
    assert.equal(fields["why_not_stronger"], "-");
    assert.ok((fields["incidents"] ?? "").split(",").length >= 2);
    assert.match(fields["id"] ?? "", /^(K[1-7]|risk|[CSOF]-[a-z0-9-]+)$/);
  });

  it("test_designGatedReposExample_parsesWithRegistry_whenCopiedAsOverlay", () => {
    const block = fencedBlockAfter(read(DESIGN), "`gated-repos.tsv`");
    assert.notEqual(block, null, "DESIGN.md Interfaces (h) lost its gated-repos.tsv example");
    const overlay = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keel-design-overlay-")));
    try {
      writeFileSync(join(overlay, "gated-repos.tsv"), block as string);
      const savedOverlay = process.env["KEEL_OVERLAY_DIR"];
      process.env["KEEL_OVERLAY_DIR"] = overlay;
      try {
        const repos = gatedRepos();
        assert.deepEqual([repos.get("example/notes-data")?.pushApproval, repos.get("acmecorp/deploy-config")?.pushApproval], ["false", "true"]);
      } finally {
        if (savedOverlay === undefined) delete process.env["KEEL_OVERLAY_DIR"];
        else process.env["KEEL_OVERLAY_DIR"] = savedOverlay;
      }
    } finally {
      rmSync(overlay, { recursive: true, force: true });
    }
  });

  it("test_fencedBlockAfter_returnsNone_whenLabelHasNoFence", () => {
    assert.equal(fencedBlockAfter("`gated-repos.tsv`\nprose, not a fence\n", "`gated-repos.tsv`"), null);
  });
});
