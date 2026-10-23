import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export const KEEL_HOME = realpathSync(join(import.meta.dirname, "..", ".."));

export function withEnv<T>(changes: Record<string, string | null>, body: () => T, options: { clear?: boolean } = {}): T {
  const saved = { ...process.env };
  try {
    if (options.clear) for (const name of Object.keys(process.env)) delete process.env[name];
    for (const [name, value] of Object.entries(changes)) {
      if (value === null) delete process.env[name];
      else process.env[name] = value;
    }
    return body();
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

export class Sandbox {
  readonly root: string;
  readonly data: string;
  readonly overlay: string;
  readonly home: string;

  constructor() {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), "keel-hookkit-")));
    this.data = join(this.root, "data");
    this.overlay = join(this.root, "overlay");
    this.home = join(this.root, "home");
    for (const path of [this.data, this.overlay, this.home]) mkdirSync(path);
  }

  close(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  write(path: string, text: string): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  }

  stubClaude(version = "9.9.9"): string {
    const path = this.write(join(this.root, "stubs", "claude"), `#!/bin/bash\necho '${version} (Claude Code)'\n`);
    chmodSync(path, 0o755);
    return dirname(path) + delimiter + (process.env["PATH"] ?? "/usr/bin:/bin");
  }
}
