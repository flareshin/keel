import { main } from '../lib/evidence/cli.ts';

const status = await main(process.argv.slice(2));
process.exitCode = ((status % 256) + 256) % 256;
