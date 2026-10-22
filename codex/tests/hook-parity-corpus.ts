import { join } from "node:path";
import type { StdinDivergence } from "./stdin-policy.ts";
import type { HookCase, Paths } from "./hook-parity.ts";

const PATCH_BEGIN = "*** Begin Patch\n";
const PATCH_END = "\n*** End Patch";
const NORMAL_CONFIG = "[features]\nhooks = true\n";
const DISABLED_HOOKS = "[features]\nhooks = false\n";
const OWNER_MODEL = 'model = "owner-model"\n';

const DEEP_NESTING = [3000, 20000];

function deepArray(depth: number): string {
  return "[".repeat(depth) + "]".repeat(depth);
}

function deepObject(depth: number): string {
  return '{"a": '.repeat(depth) + "1" + "}".repeat(depth);
}

function tomlArrays(depth: number): string {
  return `a = ${"[".repeat(depth)}${"]".repeat(depth)}\n`;
}

function tomlInlineTables(depth: number): string {
  return `a = ${"{a=".repeat(depth)}1${"}".repeat(depth)}\n`;
}

function tomlArraysOfInlineTables(depth: number): string {
  return `a = ${"[{a=".repeat(depth)}1${"}]".repeat(depth)}\n`;
}

function payload(toolName: unknown, toolInput: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ tool_name: toolName, tool_input: toolInput, hook_event_name: "PreToolUse", session_id: "parity", ...extra });
}

export function hookCases(paths: Paths): HookCase[] {
  const { profile, agents, aliases, repo, home, accountHome } = paths;
  const cases: HookCase[] = [];
  const add = (name: string, stdin: string | Buffer, extra: Partial<HookCase> = {}): void => {
    cases.push({ name, stdin, ...extra });
  };
  const bash = (name: string, command: string, extra: Record<string, unknown> = {}, options: Partial<HookCase> = {}): void =>
    add(name, payload("Bash", { command }, { cwd: repo, ...extra }), options);
  const write = (name: string, filePath: string, content: unknown, options: Partial<HookCase> = {}): void =>
    add(name, payload("Write", { file_path: filePath, content }, { cwd: repo }), options);
  const edit = (name: string, filePath: string, fields: Record<string, unknown>, options: Partial<HookCase> = {}): void =>
    add(name, payload("Edit", { file_path: filePath, ...fields }, { cwd: repo }), options);
  const patch = (name: string, body: string, options: Partial<HookCase> = {}): void =>
    add(name, payload("apply_patch", { command: PATCH_BEGIN + body + PATCH_END }, { cwd: repo }), options);

  add("empty stdin", "");
  add("whitespace stdin", "  \n\t ");
  add("truncated object", "{bad");
  add("unterminated string", '{"tool_name": "Bash');
  add("bad escape", '{"tool_name": "\\x"}');
  add("trailing comma", '{"tool_name": "Bash",}');
  add("control character in string", '{"tool_name": "Ba\u0001sh"}');
  add("extra data", payload("Bash", { command: "ls" }) + " 1");
  add("byte order mark", "\ufeff" + payload("Bash", { command: "ls" }));
  add("json array", "[]");
  add("json null", "null");
  add("json string", '"text"');
  add("json number", "12");
  add("json NaN", "NaN");
  add("empty object", "{}");
  add("tool_input missing", '{"tool_name": "Bash"}');
  add("tool_input list", payload("Bash", []));
  add("tool_input null", payload("Bash", null));
  add("unsupported tool", payload("Read", { file_path: "x" }));
  add("tool_name null", payload(null, {}));
  add("tool_name number", payload(7, {}));
  add("tool_name list", payload(["Bash", "x"], {}));
  for (const [name, object] of [
    ["descending numeric keys", '{"2":0,"1":0}'],
    ["duplicate numeric key", '{"2":1,"a":2,"1":3,"2":4}'],
    ["nested numeric keys", '{"outer":{"3":0,"1":1,"2":2}}'],
    ["numeric keys and prototype name", '{"__proto__":{"2":0,"1":1},"1":0,"0":1}'],
  ]) add(`tool_name ${name}`, `{"tool_name":${object},"tool_input":{}}`);
  add("tool_name object", payload({ a: "b" }, {}));
  add("tool_name lowercase", payload("bash", { command: "ls" }));
  add("Bash without command", payload("Bash", {}));
  add("Bash command number", payload("Bash", { command: 5 }));
  add("Bash command null", payload("Bash", { command: null }));
  add("apply_patch without command", payload("apply_patch", {}));
  add("apply_patch bad text", payload("apply_patch", { command: "bad" }));
  add("apply_patch empty text", payload("apply_patch", { command: "" }));
  add("apply_patch command number", payload("apply_patch", { command: 3 }));
  add("invalid utf-8 start byte", Buffer.concat([Buffer.from('{"tool_name": "Bash", "tool_input": {"command": "'), Buffer.from([0xff]), Buffer.from('"}}')]));
  add("truncated utf-8 sequence", Buffer.concat([Buffer.from('{"a": "'), Buffer.from([0xe2, 0x82]), Buffer.from('"}')]));
  add("invalid continuation", Buffer.concat([Buffer.from('{"a": "'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]));
  const strictLocale = { PYTHONUTF8: "0", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
  add("strict locale invalid start byte", Buffer.concat([Buffer.from('{"tool_name": "Bash", "tool_input": {"command": "'), Buffer.from([0xff]), Buffer.from('"}}')]), { env: strictLocale });
  add("strict locale truncated sequence", Buffer.concat([Buffer.from('{"a": "'), Buffer.from([0xe2, 0x82]), Buffer.from('"}')]), { env: strictLocale });
  add("strict locale valid non-ascii", payload("Bash", { command: "echo h\u00e9llo" }, { cwd: repo }), { env: strictLocale });
  add("posix locale invalid byte with utf8 mode off", Buffer.concat([Buffer.from('{"a": "'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]), { env: { PYTHONUTF8: "0", LANG: "C" } });
  add("utf8 mode invalid byte", Buffer.concat([Buffer.from('{"a": "'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]), { env: { PYTHONUTF8: "1", LANG: "en_US.UTF-8" } });
  add("crlf whitespace json", payload("Bash", { command: "ls" }).replace(/,/g, ",\r\n"));
  add("bare cr in string", payload("Bash", { command: "ls" }).replace("ls", "l\\rs").replace("\\r", "\r"));
  add("json constants inside tool_input", `{"tool_name": "Bash", "tool_input": {"command": "git status", "timeout": NaN, "limits": [Infinity, -Infinity]}, "cwd": "${repo}"}`);
  add("json constant as tool_input", '{"tool_name": "Bash", "tool_input": NaN}');
  add("deep unicode escapes", `{"tool_name": "Bash", "tool_input": {"command": "echo \\u00e9\\ud83d\\ude00 \\ud800"}, "cwd": "${repo}"}`);
  add("lone surrogate payload", `{"tool_name": "Bash", "tool_input": {"command": "echo \\ud800"}, "cwd": "${repo}"}`);

  add("tool_name with dotted capital I", payload("BASH".replace("A", "\u0130"), { command: "ls" }));
  add("tool_name with dotless i", payload("Bash".replace("a", "\u0131"), { command: "ls" }));
  bash("dotted capital I in command", "git push --force origin ma\u0130n");
  bash("dotless i in command", "g\u0131t push --force origin main");
  bash("dotted capital I in path", `rm ${profile}/HOOKS.JSON`);
  bash("dotted capital I in profile path", `rm ${profile}/hooks.js\u0131n`);
  write("write dotted capital I path", `${profile}/\u0130ndex.txt`, "x");
  bash("git status", "git status");
  bash("echo", "echo hello");
  bash("non-ascii echo", 'echo "héllo 😀"');
  bash("force push", "git push --force origin main");
  bash("force push with plus refspec", "git push origin +main");
  bash("hook skip", "git commit --no-verify -m x");
  bash("attribution commit", 'git commit -m "feat\n\nCo-Authored-By: Claude <noreply@anthropic.com>"');
  bash("plain push", "git push origin feature");
  bash("pr create", 'gh pr create --title "x" --body "y"');
  bash("merge", "gh pr merge 12 --squash");
  bash("keel approve", "keel approve abc");
  bash("evidence store write", `printf x > ${join(paths.data, "state/keel/evidence/forged.json")}`);
  bash("fires log write", `printf x > ${join(paths.data, "logs/keel-fires.jsonl")}`);
  bash("cwd missing", "git status", { cwd: undefined });
  bash("cwd nonexistent", "git status", { cwd: join(paths.root, "nowhere") });
  bash("cwd relative", "git status", { cwd: "repo" });
  bash("cwd number", "git status", { cwd: 5 });
  bash("cwd empty", "git status", { cwd: "" });
  bash("pipeline of guarded commands", "git status && git push --force origin main | cat");
  bash("subshell", "(cd /tmp && git push -f origin main)");
  bash("multi-line command", "git status\ngit push --force origin main");

  for (const [name, command] of [
    ["redirect to hooks.json", `printf x > ${profile}/hooks.json`],
    ["append to hooks.json", `printf x >> ${profile}/hooks.json`],
    ["tee hooks.json", `echo x | tee ${profile}/hooks.json`],
    ["cp over AGENTS.md", `cp /tmp/x ${profile}/AGENTS.md`],
    ["mv over state", `mv /tmp/x ${profile}/keel-codex-state.json`],
    ["rm hooks.json", `rm ${profile}/hooks.json`],
    ["rm -rf profile", `rm -rf ${profile}`],
    ["rm profile glob", `rm -rf ${profile}/*`],
    ["rm hidden-less glob", `rm ${profile}/h*.json`],
    ["rm question glob", `rm ${profile}/AGENT?.md`],
    ["rm class glob", `rm ${profile}/[Aa]GENTS.md`],
    ["rm parent", `rm -rf ${join(profile, "..")}`],
    ["rm root", "rm -rf /"],
    ["cat hooks.json", `cat ${profile}/hooks.json`],
    ["ls profile", `ls ${profile}`],
    ["cd then relative rm", `cd ${profile} && rm hooks.json`],
    ["cd then relative redirect", `cd ${profile} && echo x > AGENTS.md`],
    ["cd dotdot then rm", `cd ${profile}/sessions && rm ../hooks.json`],
    ["env expansion target", `rm $KEEL_CODEX_HOME/hooks.json`],
    ["assigned variable target", `P=${profile}; rm $P/hooks.json`],
    ["braced variable target", `P=${profile}; rm \${P}/hooks.json`],
    ["tilde target", `rm ~/.codex/sessions/r.jsonl`],
    ["bash -c rm", `bash -c 'rm ${profile}/hooks.json'`],
    ["sh -c redirect", `sh -c "echo x > ${profile}/AGENTS.md"`],
    ["eval rm", `eval "rm ${profile}/hooks.json"`],
    ["sed -i state", `sed -i '' 's/a/b/' ${profile}/keel-codex-state.json`],
    ["sed -i config", `sed -i '' 's/true/false/' ${profile}/config.toml`],
    ["dd of config", `dd if=/dev/null of=${profile}/config.toml`],
    ["append hooks off to config", `printf '[features]\\nhooks = false\\n' >> ${profile}/config.toml`],
    ["append model to config", `printf 'model = x' >> ${profile}/config.toml`],
    ["read config", `cat ${profile}/config.toml`],
    ["heredoc into config", `cat > ${profile}/config.toml <<'EOF'\nmodel = 1\nEOF`],
    ["write session record", `printf forged > ${profile}/sessions/2026/10/16/review.jsonl`],
    ["rm session record", `rm ${profile}/sessions/2026/10/16/review.jsonl`],
    ["mv session record", `mv ${profile}/sessions/2026/10/16/review.jsonl /tmp/moved`],
    ["rm sessions dir", `rm -rf ${profile}/sessions`],
    ["rm archived dir", `rm -rf ${profile}/archived_sessions`],
    ["rm sessions prefix glob", `rm -rf ${profile}/sess*`],
    ["rm archived prefix glob", `rm -rf ${profile}/archived_*`],
    ["rm through symlink glob", `rm ${aliases}/s*/2026/10/16/review.jsonl`],
    ["rm through symlink path", `rm ${aliases}/session-link/2026/10/16/review.jsonl`],
    ["rm through profile alias", `rm ${aliases}/profile-alias/hooks.json`],
    ["rm dangling alias", `rm ${aliases}/dangling`],
    ["touch notes", `touch ${profile}/notes.txt`],
    ["write notes", `echo x > ${profile}/notes.txt`],
    ["write next to sessions", `echo x > ${profile}/sessions-notes.txt`],
    ["account default sessions", `rm ${accountHome}/.codex/sessions/anything.jsonl`],
    ["account default archived", `echo x > ${accountHome}/.codex/archived_sessions/a.jsonl`],
    ["fake home sessions", `rm ${home}/.codex/sessions/r.jsonl`],
    ["registry write", `echo x > ${agents}/keel-codex-skills.json`],
    ["registry lock write", `echo x > ${agents}/keel-codex-skills.lock`],
    ["agents skills write", `echo x > ${agents}/skills/demo`],
    ["unicode path target", `echo x > ${profile}/hé😀.txt`],
    ["quoted path with space", `echo x > "${profile}/a b/hooks.json"`],
    ["single-quoted target", `echo x > '${profile}/hooks.json'`],
    ["escaped target", `echo x > ${profile}/hooks\\.json`],
    ["unknown write target", `python3 -c "open('${profile}/hooks.json','w')"`],
    ["xargs rm", `echo ${profile}/hooks.json | xargs rm`],
    ["find delete", `find ${profile} -name hooks.json -delete`],
    ["command substitution target", `rm $(echo ${profile}/hooks.json)`],
    ["backtick target", "rm `echo " + profile + "/hooks.json`"],
    ["process substitution", `cat <(echo x) > ${profile}/hooks.json`],
    ["fd redirect", `echo x 2> ${profile}/hooks.json`],
    ["clobber redirect", `echo x >| ${profile}/hooks.json`],
    ["ampersand redirect", `echo x &> ${profile}/hooks.json`],
    ["relative path under repo", "echo x > ./out.txt"],
    ["parent relative path", "echo x > ../profile/hooks.json"],
    ["long glob chain", `rm ${profile}/*/*/*/*.jsonl`],
    ["glob with no match", `rm ${profile}/zzz*`],
    ["glob in directory", `rm ${profile}/s*`],
  ] as const) bash(name, command);

  for (const [name, filePath] of [
    ["write hooks.json", `${profile}/hooks.json`],
    ["write AGENTS.md", `${profile}/AGENTS.md`],
    ["write state file", `${profile}/keel-codex-state.json`],
    ["write registry", `${agents}/keel-codex-skills.json`],
    ["write lock", `${agents}/keel-codex-skills.lock`],
    ["write via alias", `${aliases}/profile-alias/hooks.json`],
    ["write notes", `${profile}/notes.txt`],
    ["write sessions file", `${profile}/sessions/new.jsonl`],
    ["write sessions dir itself", `${profile}/sessions`],
    ["write archived record", `${profile}/archived_sessions/a.jsonl`],
    ["write profile dir", profile],
    ["write parent of profile", paths.root],
    ["write account sessions", `${accountHome}/.codex/sessions/x.jsonl`],
    ["write relative file", "out.txt"],
    ["write relative up", "../profile/hooks.json"],
    ["write sessions-like name", `${profile}/sessions-notes.txt`],
    ["write unicode path", `${profile}/é😀.txt`],
    ["write dot path", `${profile}/./hooks.json`],
    ["write double slash path", `${profile}//hooks.json`],
    ["write empty path", ""],
  ] as const) write(name, filePath, "content");

  write("write config disabling hooks", `${profile}/config.toml`, DISABLED_HOOKS);
  write("write config enabling hooks", `${profile}/config.toml`, NORMAL_CONFIG);
  write("write config model only", `${profile}/config.toml`, OWNER_MODEL);
  write("write config invalid toml", `${profile}/config.toml`, "bad [");
  write("write config invalid toml with astral prefix", `${profile}/config.toml`, "a = '😀'\nbad [");
  write("write config quoted hooks key", `${profile}/config.toml`, '[features]\n"hooks" = false');
  write("write config inline features", `${profile}/config.toml`, "features = {hooks = false}");
  write("write config managed only", `${profile}/config.toml`, "allow_managed_hooks_only = true");
  write("write config hooks table", `${profile}/config.toml`, "hooks = {enabled = false}");
  write("write config features scalar", `${profile}/config.toml`, "features = 3");
  write("write config hooks int", `${profile}/config.toml`, "[features]\nhooks = 1");
  write("write config comment only", `${profile}/config.toml`, "# hooks = false\n");
  write("write config crlf", `${profile}/config.toml`, "[features]\r\nhooks = true\r\n");
  write("write config empty", `${profile}/config.toml`, "");
  write("write config non-string content", `${profile}/config.toml`, 5);
  write("write config null content", `${profile}/config.toml`, null);
  write("write config date values", `${profile}/config.toml`, "d = 1979-05-27T07:32:00Z\n[features]\nhooks = true");
  write("write config big int", `${profile}/config.toml`, "x = " + "9".repeat(4301));
  write("write config via relative path", "../profile/config.toml", DISABLED_HOOKS);
  write("write config through alias", `${aliases}/profile-alias/config.toml`, DISABLED_HOOKS);
  add("write config without content", payload("Write", { file_path: `${profile}/config.toml` }, { cwd: repo }));
  add("write missing file_path", payload("Write", { content: "x" }, { cwd: repo }));
  add("write file_path number", payload("Write", { file_path: 5, content: "x" }, { cwd: repo }), { crash: true });
  add("write file_path null", payload("Write", { file_path: null, content: "x" }, { cwd: repo }), { crash: true });
  add("write file_path nul byte", payload("Write", { file_path: "a\u0000b", content: "x" }, { cwd: repo }));
  add("write without cwd", payload("Write", { file_path: "notes.txt", content: "x" }));

  edit("edit config disable", `${profile}/config.toml`, { old_string: "true", new_string: "false" });
  edit("edit config comment", `${profile}/config.toml`, { old_string: "[features]", new_string: "# [features]" });
  edit("edit config add model", `${profile}/config.toml`, { old_string: "[features]", new_string: 'model = "x"\n[features]' });
  edit("edit config missing old", `${profile}/config.toml`, { old_string: "nope", new_string: "x" });
  edit("edit config empty old", `${profile}/config.toml`, { old_string: "", new_string: "x" });
  edit("edit config no strings", `${profile}/config.toml`, {});
  edit("edit config non-string new", `${profile}/config.toml`, { old_string: "true", new_string: 5 });
  edit("edit config ambiguous", `${profile}/config.toml`, { old_string: "e", new_string: "E" });
  edit("edit config replace_all", `${profile}/config.toml`, { old_string: "e", new_string: "E", replace_all: true });
  edit("edit config replace_all false", `${profile}/config.toml`, { old_string: "e", new_string: "E", replace_all: false });
  edit("edit config replace_all zero", `${profile}/config.toml`, { old_string: "e", new_string: "E", replace_all: 0 });
  edit("edit config dollar replacement", `${profile}/config.toml`, { old_string: "true", new_string: "$&$1" });
  edit("edit config partial flag", `${profile}/config.toml`, { old_string: "true", new_string: "true", keel_partial: true });
  edit("edit config content wins", `${profile}/config.toml`, { content: OWNER_MODEL, old_string: "a", new_string: "b" });
  edit("edit hooks.json", `${profile}/hooks.json`, { old_string: "{}", new_string: "{x}" });
  edit("edit session record", `${profile}/sessions/2026/10/16/review.jsonl`, { old_string: "fail", new_string: "pass" });
  edit("edit notes", `${profile}/notes.txt`, { old_string: "notes", new_string: "memo" });
  edit("edit config absent file", `${profile}/config.toml`, { old_string: "a", new_string: "b" }, { config: null });
  edit("edit config invalid toml file", `${profile}/config.toml`, { old_string: "bad", new_string: "good" }, { config: "bad [\n" });
  edit("edit config invalid utf-8 file", `${profile}/config.toml`, { old_string: "a", new_string: "b" }, { config: Buffer.from([0x61, 0xff, 0x62]) });
  edit("edit config truncated utf-8 file", `${profile}/config.toml`, { old_string: "a", new_string: "b" }, { config: Buffer.from([0x61, 0xe2, 0x82]) });
  write("write config over invalid existing", `${profile}/config.toml`, OWNER_MODEL, { config: "bad [\n" });
  write("write config over absent", `${profile}/config.toml`, DISABLED_HOOKS, { config: null });
  write("write config over absent, no hooks", `${profile}/config.toml`, OWNER_MODEL, { config: null });
  write("write config over crlf existing", `${profile}/config.toml`, "[features]\nhooks = true\n", { config: "[features]\r\nhooks = true\r\n" });
  write("write config changing hooks table", `${profile}/config.toml`, "[hooks]\nx = 2\n", { config: "[hooks]\nx = 1\n" });
  write("write config keeping hooks table", `${profile}/config.toml`, '[hooks]\nx = 1\nmodel = "a"\n', { config: "[hooks]\nx = 1\n" });
  write("write config hooks int vs bool", `${profile}/config.toml`, "[hooks]\nx = true\n", { config: "[hooks]\nx = 1\n" });
  write("write config hooks float vs int", `${profile}/config.toml`, "[hooks]\nx = 1.0\n", { config: "[hooks]\nx = 1\n" });
  write("write config hooks datetime zone", `${profile}/config.toml`, "[hooks]\nx = 2020-01-01T00:00:00Z\n", { config: "[hooks]\nx = 2019-12-31T19:00:00-05:00\n" });
  write("write config hooks nan", `${profile}/config.toml`, "[hooks]\nx = nan\n", { config: "[hooks]\nx = nan\n" });

  patch("patch plain files", "*** Update File: a.py\n@@\n-old\n+new\n*** Add File: b.py\n+x");
  patch("patch move", "*** Update File: a.py\n*** Move to: b.py\n@@\n-old\n+new");
  patch("patch delete", "*** Delete File: c.py");
  patch("patch hooks.json", `*** Update File: ${profile}/hooks.json\n+x`);
  patch("patch second file protected", `*** Add File: ok.txt\n+x\n*** Update File: ${profile}/AGENTS.md\n+y`);
  patch("patch move onto protected", `*** Update File: a.py\n*** Move to: ${profile}/keel-codex-state.json\n+x`);
  patch("patch config", `*** Update File: ${profile}/config.toml\n+model = 1`);
  patch("patch config absolute add", `*** Add File: ${profile}/config.toml\n+[features]\n+hooks = false`);
  patch("patch session delete", `*** Delete File: ${profile}/sessions/2026/10/16/review.jsonl`);
  patch("patch session add", `*** Add File: ${profile}/archived_sessions/new.jsonl\n+forged`);
  patch("patch evidence store", `*** Add File: ${join(paths.data, "state/keel/evidence/forged.json")}\n+fake`);
  patch("patch without operations", "just text");
  patch("patch crlf", "*** Add File: a.txt\r\n+x\r\n+y");
  patch("patch unicode lines", "*** Add File: a.txt\n+héllo 😀\n+tab\there");
  patch("patch unicode separators", "*** Add File: a.txt\n+one\u2028two\u0085three\u000bfour\u000cfive\u001csix");
  patch("patch plus-only lines", "*** Add File: a.txt\n+\n+\n++\n+ +");
  patch("patch prefix-lookalike", "*** Add File:a.txt\n+x");
  patch("patch trailing spaces in path", "*** Add File: a.txt  \n+x");
  patch("patch no trailing newline", "*** Add File: a.txt\n+x");
  patch("patch many files", Array.from({ length: 25 }, (_unused, index) => `*** Add File: f${index}.txt\n+${index}`).join("\n"));
  add("patch cwd missing", payload("apply_patch", { command: `${PATCH_BEGIN}*** Add File: notes.txt\n+x${PATCH_END}` }));

  const rawPayload = (toolName: string, toolInput: string, extra = ""): string =>
    `{"tool_name": ${toolName}, "tool_input": ${toolInput}, "cwd": ${JSON.stringify(repo)}${extra}}`;
  const protectedWrite = JSON.stringify({ file_path: `${profile}/hooks.json`, content: "x" });
  const benignWrite = JSON.stringify({ file_path: `${profile}/notes.txt`, content: "x" });
  for (const depth of DEEP_NESTING) {
    add(`deep array beside protected write (${depth})`, rawPayload('"Write"', protectedWrite, `, "deep": ${deepArray(depth)}`));
    add(`deep object beside protected write (${depth})`, rawPayload('"Write"', protectedWrite, `, "deep": ${deepObject(depth)}`));
    add(`deep array beside allowed write (${depth})`, rawPayload('"Write"', benignWrite, `, "deep": ${deepArray(depth)}`));
    add(`deep object beside allowed write (${depth})`, rawPayload('"Write"', benignWrite, `, "deep": ${deepObject(depth)}`));
    add(`deep array inside tool_input (${depth})`, rawPayload('"Write"', `{"file_path": ${JSON.stringify(`${profile}/notes.txt`)}, "content": ${deepArray(depth)}}`));
    add(`deep array beside force push (${depth})`, rawPayload('"Bash"', '{"command": "git push --force origin main"}', `, "deep": ${deepArray(depth)}`));
    add(`deep array as tool_name (${depth})`, rawPayload(deepArray(depth), "{}"));
    add(`deep object as tool_name (${depth})`, rawPayload(deepObject(depth), "{}"));
    add(`deep array as cwd (${depth})`, `{"tool_name": "Bash", "tool_input": {"command": "git status"}, "cwd": ${deepArray(depth)}}`);
    add(`deep array then malformed tail (${depth})`, rawPayload('"Write"', protectedWrite, `, "deep": ${deepArray(depth)} x`));
  }

  for (const [name, content, options] of [
    ["toml arrays below the recursion limit", tomlArrays(300), {}],
    ["toml arrays far above the recursion limit", tomlArrays(700), { crash: true }],
    ["toml arrays thousands deep", tomlArrays(5000), { crash: true }],
    ["toml inline tables below the recursion limit", tomlInlineTables(200), {}],
    ["toml inline tables far above the recursion limit", tomlInlineTables(600), { crash: true }],
    ["toml arrays of inline tables below the limit", tomlArraysOfInlineTables(100), {}],
    ["toml arrays of inline tables far above the limit", tomlArraysOfInlineTables(400), { crash: true }],
    ["toml deep array in hooks table", `[hooks]\nx = ${"[".repeat(600)}${"]".repeat(600)}\n`, { crash: true }],
  ] as const) write(name, `${profile}/config.toml`, content, options);
  write("write over a deep existing config", `${profile}/config.toml`, OWNER_MODEL, { config: tomlArrays(600), crash: true });
  write("write over a deep but loadable existing config", `${profile}/config.toml`, OWNER_MODEL, { config: tomlArrays(300) });
  edit("edit a deep existing config", `${profile}/config.toml`, { old_string: "a", new_string: "b" }, { config: tomlArrays(600), crash: true });

  const surrogateTargets: Array<[string, string]> = [
    ["lone high surrogate", "\ud800"], ["lone low surrogate", "\udfff"], ["surrogate inside a name", "x\ud800.txt"],
    ["run of surrogates", "\ud800\ud801z"], ["escaped byte then surrogate", "\udc80\ud800"], ["escaped byte alone", "\udc80x"],
    ["escaped byte range edges", "\udc80\udcff"], ["surrogate in a parent directory", "\ud800/child.txt"],
    ["surrogate after dotdot", "sub/../\ud800"],
  ];
  for (const [name, suffix] of surrogateTargets) {
    write(`write target with ${name}`, `${repo}/${suffix}`, "x");
    write(`write profile target with ${name}`, `${profile}/${suffix}`, "x");
    write(`write relative target with ${name}`, suffix, "x");
    edit(`edit target with ${name}`, `${repo}/${suffix}`, { old_string: "a", new_string: "b" });
    patch(`patch target with ${name}`, `*** Add File: ${suffix}\n+x`);
    bash(`shell redirect to ${name}`, `echo x > ${repo}/${suffix}`);
    bash(`shell rm of ${name}`, `rm ${repo}/${suffix}`);
    bash(`shell tee into profile with ${name}`, `echo x | tee ${profile}/${suffix}`);
    bash(`shell cp to ${name}`, `cp x ${repo}/${suffix}`);
  }
  bash("shell glob with surrogate", `rm ${repo}/\ud800*`);
  bash("shell glob over profile with surrogate", `rm ${profile}/\ud800*`);
  bash("shell cd into surrogate directory then write", `cd ${repo}/\ud800 && echo x > out.txt`);
  bash("shell write with surrogate in quotes", `echo x > "${repo}/\ud800 b"`);
  bash("cwd with surrogate", "git status", { cwd: `${repo}/\ud800` });
  bash("cwd with escaped byte", "git status", { cwd: `${repo}/\udc80` });
  add("write with surrogate cwd", payload("Write", { file_path: "a.txt", content: "x" }, { cwd: `${repo}\ud800` }));
  add("write with surrogate file_path and no cwd", payload("Write", { file_path: "\ud800", content: "x" }));

  for (const [name, toolName] of [
    ["control character", ["a\u0001"]], ["no-break space", ["a b"]], ["both", ["Bash", "\u0001", " "]],
    ["line separators", [" \u0085"]], ["zero width and soft hyphen", ["​­"]], ["delete character", ["x\u007f"]],
    ["nested list", [["\u0001", " "], []]], ["dict with control keys", { "k\u0001": "v ", " ": [null, true, false, 1.5] }],
    ["astral and lone surrogate", ["😀", "\ud800"]], ["quotes of both kinds", ["it's", 'say "hi"', "both ' \""]],
    ["single string with control character", "Ba\u0001sh"], ["non-breaking string", "Bash "], ["empty list", []], ["number list", [1, 2.5, -3e-7, 1e22]],
  ] as const) add(`tool_name ${name}`, payload(toolName, { command: "ls" }));

  const FLOAT_LITERALS = ["1.0", "100.0", "-0.0", "0.0", "1e16", "1E22", "0.5", "2.5", "1e400", "-1e400"];
  const withCwd = (cwd: string): string => `{"tool_name": "Write", "tool_input": {"file_path": "hj", "content": "x"}, "cwd": ${cwd}}`;
  for (const literal of FLOAT_LITERALS) {
    add(`float cwd ${literal}`, withCwd(literal));
    add(`float cwd ${literal} in a list`, withCwd(`[${literal}]`));
    add(`float tool_name ${literal}`, `{"tool_name": ${literal}, "tool_input": {}, "cwd": ${JSON.stringify(repo)}}`);
    add(`float tool_name ${literal} in a list`, `{"tool_name": [${literal}, "x"], "tool_input": {}, "cwd": ${JSON.stringify(repo)}}`);
    add(`float tool_name ${literal} in a dict`, `{"tool_name": {"k": ${literal}}, "tool_input": {}, "cwd": ${JSON.stringify(repo)}}`);
    add(`float file_path ${literal}`, `{"tool_name": "Write", "tool_input": {"file_path": ${literal}, "content": "x"}, "cwd": ${JSON.stringify(repo)}}`, { crash: true });
    add(`float tool_input ${literal}`, `{"tool_name": "Write", "tool_input": ${literal}, "cwd": ${JSON.stringify(repo)}}`);
    add(`float payload ${literal}`, literal);
    add(`float Bash command ${literal}`, `{"tool_name": "Bash", "tool_input": {"command": ${literal}}, "cwd": ${JSON.stringify(repo)}}`);
    add(`float apply_patch command ${literal}`, `{"tool_name": "apply_patch", "tool_input": {"command": ${literal}}, "cwd": ${JSON.stringify(repo)}}`);
    add(`float keel_partial ${literal}`, `{"tool_name": "Edit", "tool_input": {"file_path": ${JSON.stringify(`${profile}/config.toml`)}, "old_string": "true", "new_string": "false", "keel_partial": ${literal}}, "cwd": ${JSON.stringify(repo)}}`);
    add(`float replace_all ${literal}`, `{"tool_name": "Edit", "tool_input": {"file_path": ${JSON.stringify(`${profile}/config.toml`)}, "old_string": "e", "new_string": "E", "replace_all": ${literal}}, "cwd": ${JSON.stringify(repo)}}`);
    add(`float beside force push ${literal}`, `{"tool_name": "Bash", "tool_input": {"command": "git push --force origin main"}, "cwd": ${JSON.stringify(repo)}, "extra": [${literal}, {"k": ${literal}}]}`);
  }
  add("integral float cwd beside a decoy integer directory", withCwd("1.0"));
  add("integer cwd", withCwd("1"));

  const CRASHING_HANDLER_SAFE_INPUTS = ["ascii only", "byte order mark first", "valid non-ascii", "iso2022 escape sequence", "empty input"];
  const textVariables: Array<[string, Record<string, string>, StdinDivergence?]> = [
    ["default", {}],
    ["utf8 invalid value", { PYTHONUTF8: "2" }],
    ["utf8 invalid with encoding override", { PYTHONUTF8: "bogus", PYTHONIOENCODING: "utf-8" }],
    ["utf8 invalid precedes unknown encoding", { PYTHONUTF8: "2", PYTHONIOENCODING: "bogus" }],
    ["utf8 invalid precedes unsupported encoding", { PYTHONUTF8: "bogus", PYTHONIOENCODING: "utf-16" }],
    ["utf8 mode off in the C locale via LANG", { PYTHONUTF8: "0", LANG: "C" }],
    ["utf8 mode off, LANG C and LC_CTYPE C.UTF-8 as a Python parent exports it", { PYTHONUTF8: "0", LANG: "C", LC_CTYPE: "C.UTF-8" }],
    ["utf8 mode off with only LC_CTYPE C.UTF-8", { PYTHONUTF8: "0", LC_CTYPE: "C.UTF-8" }],
    ["utf8 mode off with LC_CTYPE UTF-8", { PYTHONUTF8: "0", LC_CTYPE: "UTF-8" }],
    ["utf8 mode off with no locale variables", { PYTHONUTF8: "0" }],
    ["utf8 mode off with LC_ALL C", { PYTHONUTF8: "0", LC_ALL: "C" }],
    ["utf8 mode off with LC_ALL C and no coercion", { PYTHONUTF8: "0", LC_ALL: "C", PYTHONCOERCECLOCALE: "0" }],
    ["utf8 mode off with LC_CTYPE C and no coercion", { PYTHONUTF8: "0", LC_CTYPE: "C", PYTHONCOERCECLOCALE: "0" }],
    ["utf8 mode off with LC_ALL overriding LC_CTYPE", { PYTHONUTF8: "0", LC_ALL: "en_US.UTF-8", LC_CTYPE: "C" }],
    ["utf8 mode off with LC_CTYPE overriding LANG", { PYTHONUTF8: "0", LC_CTYPE: "en_US.UTF-8", LANG: "C" }],
    ["utf8 mode off in a UTF-8 locale", { PYTHONUTF8: "0", LANG: "en_US.UTF-8" }],
    ["utf8 mode off in a Latin-1 locale", { PYTHONUTF8: "0", LC_ALL: "en_US.ISO8859-1" }],
    ["utf8 mode off in an ASCII locale", { PYTHONUTF8: "0", LC_ALL: "en_US.US-ASCII" }],
    ["utf8 mode off in a missing locale", { PYTHONUTF8: "0", LANG: "xx_YY.UTF-8" }],
    ["utf8 mode off with a missing LC_ALL", { PYTHONUTF8: "0", LC_ALL: "xx_YY.UTF-8" }],
    ["utf8 mode on in the C locale", { PYTHONUTF8: "1", LANG: "C" }],
    ["utf8 mode empty value", { PYTHONUTF8: "", LC_ALL: "C" }],
    ["io encoding utf-8", { PYTHONIOENCODING: "utf-8" }],
    ["io encoding utf-8 with surrogateescape", { PYTHONIOENCODING: "utf-8:surrogateescape", PYTHONUTF8: "0", LANG: "en_US.UTF-8" }],
    ["io errors strict only", { PYTHONIOENCODING: ":strict" }],
    ["io errors replace only", { PYTHONIOENCODING: ":replace" }],
    ["io errors ignore only", { PYTHONIOENCODING: ":ignore" }],
    ["io errors backslashreplace only", { PYTHONIOENCODING: ":backslashreplace" }],
    ["io encoding ascii", { PYTHONIOENCODING: "ascii" }],
    ["io encoding ascii with replace", { PYTHONIOENCODING: "ascii:replace" }],
    ["io encoding latin-1", { PYTHONIOENCODING: "latin-1" }],
    ["io encoding with an empty spec in the C locale", { PYTHONIOENCODING: ":", PYTHONUTF8: "0", LC_ALL: "C" }],
    ["io encoding u8", { PYTHONIOENCODING: "u8" }],
    ["io encoding cp65001", { PYTHONIOENCODING: "cp65001" }],
    ["io encoding utf alias", { PYTHONIOENCODING: "utf" }],
    ["io encoding spelled UTF 8", { PYTHONIOENCODING: "UTF 8" }],
    ["io encoding cp1252", { PYTHONIOENCODING: "cp1252" }],
    ["io encoding windows-1252 with replace", { PYTHONIOENCODING: "windows-1252:replace" }],
    ["io encoding cp1251 with surrogateescape", { PYTHONIOENCODING: "cp1251:surrogateescape" }],
    ["io encoding iso-8859-15 with backslashreplace", { PYTHONIOENCODING: "iso-8859-15:backslashreplace" }],
    ["io encoding koi8-r with ignore", { PYTHONIOENCODING: "koi8-r:ignore" }],
    ["io encoding cp819", { PYTHONIOENCODING: "cp819" }],
    ["io encoding utf-8-sig", { PYTHONIOENCODING: "utf-8-sig" }],
    ["io errors surrogatepass only", { PYTHONIOENCODING: ":surrogatepass" }],
    ["io encoding utf-8 with surrogatepass", { PYTHONIOENCODING: "utf-8:surrogatepass" }],
    ["io encoding ascii with surrogatepass", { PYTHONIOENCODING: "ascii:surrogatepass" }],
    ["io errors xmlcharrefreplace", { PYTHONIOENCODING: "utf-8:xmlcharrefreplace" }],
    ["io errors namereplace", { PYTHONIOENCODING: "utf-8:namereplace" }],
    ["io errors unknown", { PYTHONIOENCODING: "utf-8:bogus" }],
    ["io encoding unknown name", { PYTHONIOENCODING: "bogus" }],
    ["io encoding non-text hex", { PYTHONIOENCODING: "hex" }],
    ["io encoding non-text rot13", { PYTHONIOENCODING: "rot13" }],
    ["io encoding dotted module name", { PYTHONIOENCODING: "ISO8859.15" }],
    ["io encoding dotted alias", { PYTHONIOENCODING: "iso8859.1" }],
    ["io encoding utf-16", { PYTHONIOENCODING: "utf-16" }, { codec: "utf_16", encoding: "utf_16" }],
    ["io encoding gb2312", { PYTHONIOENCODING: "gb2312" }, { codec: "gb2312", encoding: "gb2312" }],
    ["io encoding big5", { PYTHONIOENCODING: "big5" }, { codec: "big5", encoding: "big5" }],
    ["io encoding gbk", { PYTHONIOENCODING: "gbk" }, { codec: "gbk", encoding: "gbk" }],
    ["io encoding cp949", { PYTHONIOENCODING: "cp949" }, { codec: "cp949", encoding: "cp949" }],
    ["io encoding iso2022_jp", { PYTHONIOENCODING: "iso2022_jp" }, { codec: "iso2022_jp", encoding: "iso2022_jp" }],
    ["utf8 mode off in a CP949 locale", { PYTHONUTF8: "0", LC_ALL: "ko_KR.CP949" }, { codec: "cp949", encoding: "cp949" }],
    ["io encoding euc-kr", { PYTHONIOENCODING: "euc-kr" }, { codec: "euc_kr", encoding: "euc_kr" }],
    ["utf8 mode off in an EUC-KR locale", { PYTHONUTF8: "0", LC_ALL: "ko_KR.eucKR" }, { codec: "euc_kr", encoding: "euckr" }],
    ["utf8 mode off in a KOI8-R locale", { PYTHONUTF8: "0", LC_ALL: "ru_RU.KOI8-R" }],
    ["utf8 mode off in a CP1251 locale", { PYTHONUTF8: "0", LC_CTYPE: "ru_RU.CP1251" }],
  ];
  const asciiPayload = `{"tool_name": "Bash", "tool_input": {"command": "echo hi"}, "cwd": ${JSON.stringify(repo)}}`;
  const insideCommand = (middle: number[]): Buffer =>
    Buffer.concat([Buffer.from('{"tool_name": "Bash", "tool_input": {"command": "echo '), Buffer.from(middle), Buffer.from(`"}, "cwd": ${JSON.stringify(repo)}}`)]);
  const textInputs: Array<[string, Buffer]> = [
    ["empty input", Buffer.alloc(0)],
    ["incomplete signature first byte", Buffer.from([0xef])],
    ["incomplete signature second byte", Buffer.from([0xef, 0xbb])],
    ["ascii only", Buffer.from(asciiPayload)],
    ["encoded surrogate", insideCommand([0xed, 0xa0, 0x80])],
    ["encoded surrogate then invalid byte", insideCommand([0xed, 0xa0, 0x80, 0xff])],
    ["truncated encoded surrogate", insideCommand([0xed, 0xa0])],
    ["byte order mark first", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(asciiPayload)])],
    ["byte order mark then invalid byte", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), insideCommand([0xff])])],
    ["cp1252 undefined byte", insideCommand([0x81, 0x9d])],
    ["gb2312 and big5 invalid lead", insideCommand([0x81, 0x40])],
    ["gbk valid trail byte", insideCommand([0xa0, 0x80])],
    ["iso2022 escape sequence", insideCommand([0x1b, 0x24, 0x42, 0x43, 0x66, 0x1b, 0x28, 0x42])],
    ["euc-kr valid", insideCommand([0xb0, 0xa1, 0xb3, 0xaa])],
    ["valid non-ascii", Buffer.from(`{"tool_name": "Bash", "tool_input": {"command": "echo héllo 😀"}, "cwd": ${JSON.stringify(repo)}}`)],
    ["invalid start byte", Buffer.concat([Buffer.from('{"tool_name": "Bash", "tool_input": {"command": "echo '), Buffer.from([0xff]), Buffer.from(`"}, "cwd": ${JSON.stringify(repo)}}`)])],
    ["truncated sequence", Buffer.concat([Buffer.from('{"tool_name": "Bash", "tool_input": {"command": "echo '), Buffer.from([0xe2, 0x82]), Buffer.from(`"}, "cwd": ${JSON.stringify(repo)}}`)])],
    ["bad continuation", Buffer.concat([Buffer.from('{"tool_name": "Bash", "tool_input": {"command": "echo '), Buffer.from([0xc3, 0x28]), Buffer.from(`"}, "cwd": ${JSON.stringify(repo)}}`)])],
    ["invalid byte before a protected write", Buffer.concat([Buffer.from(`{"tool_name": "Write", "tool_input": {"file_path": ${JSON.stringify(`${profile}/hooks.json`)}, "content": "`), Buffer.from([0xc3, 0x28]), Buffer.from(`"}, "cwd": ${JSON.stringify(repo)}}`)])],
  ];
  for (const [variablesName, env, divergence] of textVariables) {
    for (const [inputName, stdin] of textInputs) {
      const startupFailure = variablesName.startsWith("utf8 invalid") || variablesName === "io encoding unknown name" || variablesName === "io encoding dotted module name" || variablesName.startsWith("io encoding non-text");
      const crashes = !startupFailure && /xmlcharrefreplace|namereplace|unknown/.test(variablesName) && !CRASHING_HANDLER_SAFE_INPUTS.includes(inputName);
      add(`stdin ${inputName} with ${variablesName}`, stdin, { env, crash: crashes, divergence, startupFailure });
    }
  }

  return cases;
}
