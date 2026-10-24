import { globSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, normalize } from 'node:path';
import { SCRIPT_FILE } from './consumers.ts';

const TEST_GLOBS = ['tests/**/*.test.ts', 'codex/tests/*.test.ts', 'tests/workflows/*.test.mjs'];
const SUPPORT_GLOBS = ['tests/**/*', 'codex/tests/**/*'];
const SCRIPT_GLOB = '**/*.{ts,mts,cts,js,mjs,cjs,tsx,jsx}';
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git']);
const IMPORT_SPECIFIER = /\b(?:from|import|require)\s*\(?\s*['"]([^'"\n]+)['"]/gu;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\/]/gu;

export function candidateTests(root: string, changedPaths: string[]): string[] {
  const repo = scanRepo(root);
  const changed = new Set(changedPaths);
  const reaching = new Set(changedPaths);
  let grew = true;
  while (grew) {
    grew = false;
    for (const file of repo.all) {
      if (reaching.has(file) || !referencesAny(repo, file, reaching, changed)) continue;
      reaching.add(file);
      grew = true;
    }
  }
  return repo.tests.filter((test) => reaching.has(test)).sort();
}

function referencesAny(repo: RepoFiles, file: string, reaching: Set<string>, changed: Set<string>): boolean {
  if (repo.importsOf(file).some((imported) => reaching.has(imported))) return true;
  if (!repo.support.has(file)) return false;
  const text = repo.read(file);
  return [...reaching].some((target) => namesOf(repo, target, changed).some((name) => wholeWord(name).test(text)));
}

function namesOf(repo: RepoFiles, target: string, changed: Set<string>): string[] {
  const name = basename(target);
  if (changed.has(target)) return [target, name, name.slice(0, name.length - extname(name).length)];
  if (repo.support.has(target) && SCRIPT_FILE.test(target)) return [];
  return [target, name];
}

function wholeWord(name: string): RegExp {
  return new RegExp(`(?<![\\w-])${name.replace(REGEX_SPECIAL, '\\$&')}(?![\\w-])`, 'u');
}

interface RepoFiles {
  tests: string[];
  support: Set<string>;
  all: string[];
  read(file: string): string;
  importsOf(file: string): string[];
}

function scanRepo(root: string): RepoFiles {
  const glob = (patterns: string | string[]): string[] =>
    globSync(patterns, { cwd: root, exclude: (entry) => SKIPPED_DIRECTORIES.has(basename(entry)) })
      .filter((file) => statSync(join(root, file)).isFile());
  const support = new Set(glob(SUPPORT_GLOBS));
  const texts = new Map<string, string>();
  const imports = new Map<string, string[]>();
  const read = (file: string): string => {
    const text = texts.get(file) ?? readFileSync(join(root, file), 'utf8');
    texts.set(file, text);
    return text;
  };
  const importsOf = (file: string): string[] => {
    const found = imports.get(file) ?? (SCRIPT_FILE.test(file) ? relativeImports(file, read(file)) : []);
    imports.set(file, found);
    return found;
  };
  return { tests: glob(TEST_GLOBS), support, all: [...new Set([...support, ...glob(SCRIPT_GLOB)])], read, importsOf };
}

function relativeImports(file: string, text: string): string[] {
  return [...text.matchAll(IMPORT_SPECIFIER)]
    .map((match) => match[1] ?? '')
    .map((specifier) => normalize(join(dirname(file), specifier)));
}
