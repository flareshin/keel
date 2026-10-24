import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { isDirectory, isFile, resolveSymlinksKeepingMissingTail } from "../../hooks/lib/hookkit/files.ts";
import { Sandbox } from "./helpers.ts";

describe("hookkit files", () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = new Sandbox();
  });

  afterEach(() => {
    sandbox.close();
  });

  it("isFile and isDirectory follow links and answer false for a missing path", () => {
    const directory = join(sandbox.root, "dir");
    mkdirSync(directory);
    writeFileSync(join(directory, "f"), "");
    symlinkSync(directory, join(sandbox.root, "dir-link"));
    assert.deepEqual([isFile(join(directory, "f")), isDirectory(directory), isDirectory(join(sandbox.root, "dir-link")), isFile(directory)], [true, true, true, false]);
    assert.deepEqual([isFile(join(sandbox.root, "absent")), isDirectory(join(sandbox.root, "absent"))], [false, false]);
  });

  it("resolveSymlinksKeepingMissingTail resolves a link before applying .. and keeps the missing tail", () => {
    const real = join(sandbox.root, "real");
    mkdirSync(join(real, "inner"), { recursive: true });
    symlinkSync(join(real, "inner"), join(sandbox.root, "link"));
    const resolvedRoot = resolveSymlinksKeepingMissingTail(sandbox.root);
    assert.equal(resolveSymlinksKeepingMissingTail(sandbox.root + "/link/../y/z"), join(resolvedRoot, "real", "y", "z"));
  });

  it("resolveSymlinksKeepingMissingTail follows a link whose target does not exist yet", () => {
    const real = join(sandbox.root, "real");
    mkdirSync(real);
    symlinkSync(join(real, "not-yet"), join(sandbox.root, "dangling"));
    const resolvedRoot = resolveSymlinksKeepingMissingTail(sandbox.root);
    assert.equal(resolveSymlinksKeepingMissingTail(join(sandbox.root, "dangling", "file")), join(resolvedRoot, "real", "not-yet", "file"));
  });

  it("resolveSymlinksKeepingMissingTail stops at a link loop and keeps the rest of the path", () => {
    symlinkSync(join(sandbox.root, "b"), join(sandbox.root, "a"));
    symlinkSync(join(sandbox.root, "a"), join(sandbox.root, "b"));
    const resolvedRoot = resolveSymlinksKeepingMissingTail(sandbox.root);
    assert.equal(resolveSymlinksKeepingMissingTail(join(sandbox.root, "a", "x")), join(resolvedRoot, "a", "x"));
  });
});

