import { unlinkSync } from 'node:fs';
import { compareCodePoints } from '../../measure/lib/measurekit/json.ts';
import * as env from './env.ts';
import { printErrorLine } from './stdio.ts';
import * as store from './store.ts';
import { EvidenceError } from './store.ts';

export function collect(): number {
  const now = env.iso(env.utcNow());
  const targets: Array<[string, string | null]> = [];
  for (const kind of store.REPO_SCOPED_KINDS) {
    for (const key of store.repoKeys(kind)) targets.push([kind, key]);
  }
  for (const kind of store.GLOBAL_KINDS) targets.push([kind, null]);
  return targets.reduce((total, [kind, repoKey]) => total + sweep(kind, repoKey, now), 0);
}

function sweep(kind: string, repoKey: string | null, now: string): number {
  let deleted = 0;
  for (const path of store.listFiles(kind, repoKey)) {
    let evidence;
    try {
      evidence = store.readFile(path);
    } catch (error) {
      if (!(error instanceof EvidenceError)) throw error;
      printErrorLine(`keel evidence gc: skipped ${error.message}`);
      continue;
    }
    if (compareCodePoints(evidence.expires_at, now) < 0) {
      unlinkSync(path);
      deleted++;
    }
  }
  return deleted;
}
