import { readFileSync, writeSync } from 'node:fs';
import { decodeStrict } from '../../measure/lib/measurekit/files.ts';

const STDOUT_FD = 1;
const STDERR_FD = 2;
const STDIN_FD = 0;

export function writeStdout(data: string | Uint8Array): void {
  writeAll(STDOUT_FD, data);
}

export function writeStderr(data: string | Uint8Array): void {
  writeAll(STDERR_FD, data);
}

export function printLine(text: string): void {
  writeStdout(text + '\n');
}

export function printErrorLine(text: string): void {
  writeStderr(text + '\n');
}

export function readStdinText(): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(STDIN_FD);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EOF') throw error;
    bytes = Buffer.alloc(0);
  }
  return decodeStrict(bytes, 'stdin');
}

function writeAll(fd: number, data: string | Uint8Array): void {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPIPE') return;
      if (code !== 'EAGAIN') throw error;
    }
  }
}
