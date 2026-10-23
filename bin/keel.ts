import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const keelHome = process.env['KEEL_HOME'] || dirname(import.meta.dirname);
const { main } = await import(pathToFileURL(join(keelHome, 'lib', 'evidence', 'cli.ts')).href) as typeof import('../lib/evidence/cli.ts');

const status = await main(process.argv.slice(2));
process.exitCode = ((status % 256) + 256) % 256;
