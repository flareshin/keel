import { join } from 'node:path';
import { isFile, readUtf8, splitLines } from '../../measure/lib/measurekit/files.ts';
import * as env from './env.ts';
import * as gitcmd from './gitcmd.ts';
import { isWhitespaceBothWays, stripEitherWay } from './text.ts';

const GATED_HEADER = ['origin', 'gate', 'integration_base', 'risk_rules', 'tests'];
const GATED_OPTIONAL = ['push_approval', 'auto_merge'];
const RISK_HEADER = ['set', 'path_glob', 'class'];
const GATE_OFF = 'off';
const GATE_VALUES = ['code', 'smoke', GATE_OFF];
const RISK_CLASSES = ['light', 'heavy', 'smoke-only'];
const FLAG_VALUES = ['true', 'false'];
const EMPTY = '-';

export class RegistryError extends Error {
  override name = 'RegistryError';
}

export interface GatedRepo {
  origin: string;
  gate: string;
  integrationBase: string;
  riskRules: string;
  tests: string;
  pushApproval: string;
  autoMerge: string;
}

export interface RiskRule {
  ruleSet: string;
  pathGlob: string;
  riskClass: string;
}

export function testsRequired(row: GatedRepo): boolean {
  return row.tests !== 'none';
}

export function pushNeedsApproval(row: GatedRepo): boolean {
  return row.pushApproval === 'true';
}

export function mergesWithoutApproval(row: GatedRepo): boolean {
  return row.autoMerge === 'true';
}

export function normalizeRepoKey(origin: string | null | undefined): string | null {
  if (!origin) return null;
  const trimmed = stripEitherWay(origin).replace(/\/+$/, '');
  const withoutSuffix = trimmed.endsWith('.git') ? trimmed.slice(0, -'.git'.length) : trimmed;
  const segments = withoutSuffix.replaceAll(':', '/').split('/').filter((segment) => segment);
  return segments.length >= 2 ? segments.slice(-2).join('/').toLowerCase() : null;
}

export function originKey(repoRoot: string): string | null {
  return normalizeRepoKey(gitcmd.originUrl(repoRoot));
}

export function registryPath(): string {
  return join(env.overlayDir(), 'gated-repos.tsv');
}

export function gatedRepos(): Map<string, GatedRepo> {
  const repos = new Map<string, GatedRepo>();
  for (const row of readTsv(registryPath(), GATED_HEADER, GATED_OPTIONAL)) {
    if (!GATE_VALUES.includes(row['gate']!)) {
      throw new RegistryError(`gated-repos.tsv: unknown gate ${JSON.stringify(row['gate'])} for ${row['origin']}`);
    }
    for (const flag of GATED_OPTIONAL) {
      if (!FLAG_VALUES.includes(row[flag] ?? 'false')) {
        throw new RegistryError(`gated-repos.tsv: ${flag} must be true or false for ${row['origin']}`);
      }
    }
    repos.set(row['origin']!.toLowerCase(), {
      origin: row['origin']!, gate: row['gate']!, integrationBase: row['integration_base']!, riskRules: row['risk_rules']!,
      tests: row['tests']!, pushApproval: row['push_approval'] ?? 'false', autoMerge: row['auto_merge'] ?? 'false',
    });
  }
  return repos;
}

export function isGated(row: GatedRepo | null | undefined): boolean {
  return row !== null && row !== undefined && row.gate !== GATE_OFF;
}

export function gatesAnyRepo(): boolean {
  return [...gatedRepos().values()].some(isGated);
}

export function lookup(repoKey: string | null): GatedRepo | null {
  if (!repoKey) return null;
  return gatedRepos().get(repoKey) ?? null;
}

export function riskRules(ruleSet: string): RiskRule[] {
  if (ruleSet === EMPTY) return [];
  const rules: RiskRule[] = [];
  for (const row of readTsv(join(env.overlayDir(), 'risk-rules.tsv'), RISK_HEADER)) {
    if (row['set'] !== ruleSet) continue;
    if (!RISK_CLASSES.includes(row['class']!)) {
      throw new RegistryError(`risk-rules.tsv: unknown class ${JSON.stringify(row['class'])}`);
    }
    rules.push({ ruleSet: row['set']!, pathGlob: row['path_glob']!, riskClass: row['class']! });
  }
  return rules;
}

export function readTsv(path: string, header: string[], optional: string[] = []): Array<Record<string, string>> {
  if (!isFile(path)) return [];
  const content = splitLines(readUtf8(path)).filter((line) => !isWhitespaceBothWays(line) && !line.startsWith('#'));
  if (content.length === 0) return [];
  const columns = content[0]!.split('\t');
  const expected = Array.from({ length: optional.length + 1 }, (_, count) => [...header, ...optional.slice(0, count)]);
  if (!expected.some((candidate) => candidate.length === columns.length && candidate.every((name, index) => name === columns[index]))) {
    throw new RegistryError(`${path}: header must be ${[...header, ...optional].join('\t')}`);
  }
  return content.slice(1).map((line) => {
    const values = line.split('\t');
    if (values.length !== columns.length) {
      throw new RegistryError(`${path}: expected ${columns.length} columns: ${JSON.stringify(line)}`);
    }
    return Object.fromEntries(columns.map((column, index) => [column, values[index]!]));
  });
}
