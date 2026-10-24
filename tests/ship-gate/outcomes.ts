import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringifySorted } from '../../measure/lib/measurekit/json.ts';

export const ROOT_TOKEN = '{{ROOT}}';
const FIXTURE_DIRECTORY = join(import.meta.dirname, '..', 'fixtures', 'evidence');
const JSON_LINE = /^(KEEL-TEST )?(\{.*\})$/;

export function canonicalText(text: string): string {
  return text.split('\n').map((line) => {
    const match = JSON_LINE.exec(line);
    if (match === null) return line;
    try {
      return (match[1] ?? '') + stringifySorted(JSON.parse(match[2]!));
    } catch (error) {
      if (error instanceof SyntaxError) return line;
      throw error;
    }
  }).join('\n');
}

export function readFixture<T>(name: string, root: string): T {
  const text = readFileSync(join(FIXTURE_DIRECTORY, name), 'utf8');
  return JSON.parse(text.replaceAll(ROOT_TOKEN, JSON.stringify(root).slice(1, -1))) as T;
}
