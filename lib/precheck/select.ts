import { globSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, normalize } from 'node:path';
import { SCRIPT_FILE } from './consumers.ts';

const TEST_GLOBS = ['tests/**/*.test.ts', 'codex/tests/*.test.ts', 'tests/workflows/*.test.mjs'];
const SUPPORT_GLOBS = ['tests/**/*', 'codex/tests/**/*'];
const SCRIPT_GLOB = '**/*.{ts,mts,cts,js,mjs,cjs,tsx,jsx}';
const ANY_FILE = '**/*';
const SHEBANG = '#!';
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
  if (!repo.support.has(file) && !repo.wrappers.has(file)) return false;
  const text = repo.read(file);
  return [...reaching].some((target) => mentionPatterns(repo, target, changed).some((pattern) => pattern.test(text)));
}

function mentionPatterns(repo: RepoFiles, target: string, changed: Set<string>): RegExp[] {
  const name = basename(target);
  if (changed.has(target)) return [target, name, name.slice(0, name.length - extname(name).length)].map(wholeWord);
  if (repo.support.has(target) && SCRIPT_FILE.test(target)) return [];
  if (repo.wrappers.has(target)) return [wholeWord(target), quoted(name)];
  return [target, name].map(wholeWord);
}

function wholeWord(name: string): RegExp {
  return new RegExp(`(?<![\\w-])${escaped(name)}(?![\\w-])`, 'u');
}

function quoted(name: string): RegExp {
  return new RegExp(`(['"\`])${escaped(name)}\\1`, 'u');
}

function escaped(name: string): string {
  return name.replace(REGEX_SPECIAL, '\\$&');
}

interface RepoFiles {
  tests: string[];
  support: Set<string>;
  wrappers: Set<string>;
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
  const wrappers = new Set(glob(ANY_FILE).filter((file) => extname(file) === '' && !support.has(file) && read(file).startsWith(SHEBANG)));
  const importsOf = (file: string): string[] => {
    const found = imports.get(file) ?? (SCRIPT_FILE.test(file) ? relativeImports(file, read(file)) : []);
    imports.set(file, found);
    return found;
  };
  return { tests: glob(TEST_GLOBS), support, wrappers, all: [...new Set([...support, ...wrappers, ...glob(SCRIPT_GLOB)])], read, importsOf };
}

function relativeImports(file: string, text: string): string[] {
  return [...text.matchAll(IMPORT_SPECIFIER)]
    .map((match) => match[1] ?? '')
    .map((specifier) => normalize(join(dirname(file), specifier)));
}
