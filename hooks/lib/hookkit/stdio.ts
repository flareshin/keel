import { readSync, writeSync } from "node:fs";

const NEWLINES = /\r\n|\r/g;
const STDIN = 0;
const STDOUT = 1;
const STDERR = 2;
const READ_CHUNK_BYTES = 1 << 16;

export function readStdin(): string {
  const chunks: Buffer[] = [];
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  for (;;) {
    let count: number;
    try {
      count = readSync(STDIN, chunk, 0, chunk.length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") continue;
      if (code === "EOF" || code === "EBADF") break;
      throw error;
    }
    if (count === 0) break;
    chunks.push(Buffer.from(chunk.subarray(0, count)));
  }
  return Buffer.concat(chunks).toString("utf8").replace(NEWLINES, "\n");
}

export function printLine(text: string): void {
  writeAll(STDOUT, text + "\n");
}

export function writeStderr(text: string): void {
  writeAll(STDERR, text);
}

function writeAll(descriptor: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  let written = 0;
  while (written < bytes.length) {
    try {
      written += writeSync(descriptor, bytes, written);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
    }
  }
}
