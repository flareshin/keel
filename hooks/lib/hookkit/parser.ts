import { isDigits, lstripChar } from "./text.ts";
import { SimpleCommand, unwrap } from "./commands.ts";

export const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
export const SEPARATOR_OPS: readonly string[] = ["&&", "||", "|&", ";;", ";", "|", "&", "(", ")"];
export const REDIRECT_OPS: readonly string[] = ["&>>", "&>", ">>", ">|", ">&", "<<<", "<<-", "<<", "<>", "<&", ">", "<"];
const PIPE_OPS: ReadonlySet<string> = new Set(["|", "|&"]);
export const WORD_BREAK: ReadonlySet<string> = new Set(" \t\n;&|()<>");
export const KEYWORDS_AT_COMMAND_START: ReadonlySet<string> =
  new Set(["if", "then", "else", "elif", "fi", "while", "until", "do", "done", "!", "{", "}", "esac"]);
const HEREDOC_START_RE = /<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z0-9_.-]+))/y;
const SHELL_CODE_OPTION_RE = /^-[a-zA-Z]*c[a-zA-Z]*$/;
const ASSIGNMENT_NAME_RE = /^([A-Za-z_][A-Za-z0-9_]*)=/;

export function parseCommands(text: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  new Reader(text, false, commands).read();
  expandCodeStrings(commands);
  return commands;
}

function expandCodeStrings(commands: SimpleCommand[]): void {
  let index = 0;
  while (index < commands.length) {
    const command = commands[index] as SimpleCommand;
    for (const code of codeStrings(commands, index)) {
      const nested: SimpleCommand[] = [];
      new Reader(code, true, nested, command).read();
      commands.push(...nested);
    }
    index += 1;
  }
}

function codeStrings(commands: readonly SimpleCommand[], index: number): string[] {
  const command = commands[index] as SimpleCommand;
  const invocation = unwrap(command);
  const name = invocation.name;
  const args = invocation.argv.slice(1);
  if (name === "eval") return [args.join(" ")];
  if ((name === "source" || name === ".") && args.length > 0 && ["/dev/stdin", "/dev/fd/0"].includes(args[0] ?? "")) {
    return [...command.heredocs];
  }
  if (!SHELLS.has(name)) return [];
  for (const [position, arg] of args.entries()) {
    if (SHELL_CODE_OPTION_RE.test(arg) && position + 1 < args.length) return [args[position + 1] ?? ""];
  }
  const runsScriptFile = args.some((arg) => !arg.startsWith("-"));
  if (runsScriptFile) return [];
  const hereStrings = command.redirects.filter((redirect) => redirect.op === "<<<").map((redirect) => redirect.target);
  return [...command.heredocs, ...hereStrings, ...heredocsPipedInto(commands, index)];
}

function heredocsPipedInto(commands: readonly SimpleCommand[], index: number): string[] {
  let bodies: string[] = [];
  let previous = index - 1;
  while (previous >= 0 && (commands[previous] as SimpleCommand).pipesToNext) {
    bodies = [...(commands[previous] as SimpleCommand).heredocs, ...bodies];
    previous -= 1;
  }
  return bodies;
}

interface PendingHeredoc {
  command: SimpleCommand;
  delimiter: string;
  stripTabs: boolean;
}

class Reader {
  text: string;
  position = 0;
  nested: boolean;
  out: SimpleCommand[];
  parent: SimpleCommand | null;
  substitutions: Array<[string, SimpleCommand]> = [];
  pendingHeredocs: PendingHeredoc[] = [];
  pendingFd: string | null = null;
  current: SimpleCommand;

  constructor(text: string, nested: boolean, out: SimpleCommand[], parent: SimpleCommand | null = null) {
    this.text = text;
    this.nested = nested;
    this.out = out;
    this.parent = parent;
    this.current = new SimpleCommand(nested, parent);
  }

  read(): void {
    while (this.position < this.text.length) this.readNext();
    this.finishCommand(false);
    for (const [body, owner] of this.substitutions) new Reader(body, true, this.out, owner).read();
  }

  private readNext(): void {
    const text = this.text;
    const position = this.position;
    const char = text[position] ?? "";
    if (text.startsWith("\\\n", position)) {
      this.position += 2;
    } else if (char === "\n") {
      this.finishCommand(false);
      this.position += 1;
      this.readHeredocBodies();
    } else if (char === " " || char === "\t") {
      this.position += 1;
    } else if (char === "#") {
      const end = text.indexOf("\n", position);
      this.position = end < 0 ? text.length : end;
    } else if (text.startsWith("<(", position) || text.startsWith(">(", position)) {
      const [body, end] = readBalanced(text, position + 2);
      this.position = end;
      this.ownSubstitutions([body]);
      this.addWord(text.slice(position, this.position), true);
    } else if (this.readOperator()) {
      return;
    } else {
      this.readWordOrFd();
    }
  }

  private readOperator(): boolean {
    const text = this.text;
    const position = this.position;
    for (const op of REDIRECT_OPS) {
      if (text.startsWith(op, position) && !text.startsWith("&&", position)) {
        this.position += op.length;
        this.readRedirectTarget(op);
        return true;
      }
    }
    for (const op of SEPARATOR_OPS) {
      if (text.startsWith(op, position)) {
        this.position += op.length;
        this.finishCommand(PIPE_OPS.has(op));
        return true;
      }
    }
    return false;
  }

  private readRedirectTarget(op: string): void {
    while (this.position < this.text.length && (this.text[this.position] === " " || this.text[this.position] === "\t")) {
      this.position += 1;
    }
    const [word, , end] = this.readWordHere();
    this.position = end;
    const fd = this.pendingFd;
    this.pendingFd = null;
    if (op === "<<" || op === "<<-") {
      this.pendingHeredocs.push({ command: this.current, delimiter: word, stripTabs: op === "<<-" });
      return;
    }
    this.current.redirects.push(fd === null ? { op, target: word } : { op, target: word, fd });
  }

  private readWordOrFd(): void {
    const start = this.position;
    const [word, quoted, end] = this.readWordHere();
    this.position = end;
    const next = this.text.slice(this.position, this.position + 2);
    const isFdNumber = isDigits(word) && !quoted && ["<", ">"].includes(next.slice(0, 1));
    if (isFdNumber) {
      if (next !== "<(" && next !== ">(") this.pendingFd = word;
    } else {
      this.addWord(word, quoted, assignmentName(this.text.slice(start, this.position)));
    }
  }

  private readWordHere(): [string, boolean, number] {
    const found: string[] = [];
    const result = readWord(this.text, this.position, found);
    this.ownSubstitutions(found);
    return result;
  }

  private ownSubstitutions(bodies: readonly string[]): void {
    for (const body of bodies) this.substitutions.push([body, this.current]);
  }

  private addWord(word: string, quoted: boolean, name: string | null = null): void {
    const command = this.current;
    const atStart = command.argv.length === 0;
    if (atStart && command.assignments.length === 0 && !quoted && KEYWORDS_AT_COMMAND_START.has(word)) return;
    if (atStart && name) {
      command.assignments.push([name, word.slice(name.length + 1)]);
      return;
    }
    command.argv.push(word);
  }

  private finishCommand(pipesToNext: boolean): void {
    if (this.current.argv.length > 0 || this.current.assignments.length > 0 || this.current.redirects.length > 0) {
      this.current.pipesToNext = pipesToNext;
      this.out.push(this.current);
    }
    this.current = new SimpleCommand(this.nested, this.parent);
  }

  private readHeredocBodies(): void {
    for (const { command, delimiter, stripTabs } of this.pendingHeredocs) {
      const [body, end] = readHeredocBody(this.text, this.position, delimiter, stripTabs);
      this.position = end;
      command.heredocs.push(body);
    }
    this.pendingHeredocs = [];
  }
}

function assignmentName(rawWord: string): string | null {
  return ASSIGNMENT_NAME_RE.exec(rawWord)?.[1] ?? null;
}

function readWord(text: string, start: number, substitutions: string[]): [string, boolean, number] {
  const parts: string[] = [];
  let quoted = false;
  let position = start;
  while (position < text.length) {
    const char = text[position] ?? "";
    if (WORD_BREAK.has(char)) break;
    if (char === "\\") {
      if (text.startsWith("\\\n", position)) {
        position += 2;
        continue;
      }
      parts.push(text.slice(position + 1, position + 2));
      position += 2;
    } else if (char === "'") {
      const close = text.indexOf("'", position + 1);
      const end = close < 0 ? text.length : close;
      parts.push(text.slice(position + 1, end));
      quoted = true;
      position = end + 1;
    } else if (char === '"') {
      const [content, end] = readDoubleQuoted(text, position + 1, substitutions);
      parts.push(content);
      quoted = true;
      position = end;
    } else if (text.startsWith("$((", position)) {
      const [, end] = readBalanced(text, position + 2);
      parts.push(text.slice(position, end));
      position = end;
    } else if (text.startsWith("${", position)) {
      const close = text.indexOf("}", position);
      const end = close < 0 ? text.length : close + 1;
      parts.push(text.slice(position, end));
      position = end;
    } else {
      const substitution = readSubstitution(text, position, substitutions);
      if (substitution) {
        parts.push(substitution[0]);
        position = substitution[1];
      } else {
        parts.push(char);
        position += 1;
      }
    }
  }
  return [parts.join(""), quoted, position];
}

function readDoubleQuoted(text: string, start: number, substitutions: string[]): [string, number] {
  const parts: string[] = [];
  let position = start;
  while (position < text.length) {
    const char = text[position] ?? "";
    if (char === '"') return [parts.join(""), position + 1];
    if (char === "\\" && position + 1 < text.length) {
      const following = text[position + 1] ?? "";
      parts.push(['"', "\\", "$", "`"].includes(following) ? following : "\\" + following);
      position += 2;
    } else {
      const substitution = readSubstitution(text, position, substitutions);
      if (substitution) {
        parts.push(substitution[0]);
        position = substitution[1];
      } else {
        parts.push(char);
        position += 1;
      }
    }
  }
  return [parts.join(""), position];
}

function readSubstitution(text: string, position: number, substitutions: string[]): [string, number] | null {
  let body: string;
  let verbatim: string;
  let end: number;
  if (text.startsWith("$(", position) && !text.startsWith("$((", position)) {
    [body, end] = readBalanced(text, position + 2);
    verbatim = text.slice(position, end);
  } else if (text[position] === "`") {
    const found = text.indexOf("`", position + 1);
    const close = found < 0 ? text.length : found;
    body = text.slice(position + 1, close);
    verbatim = text.slice(position, close + 1);
    end = close + 1;
  } else {
    return null;
  }
  substitutions.push(body);
  return [verbatim, end];
}

function matchHeredocStart(text: string, position: number): RegExpExecArray | null {
  HEREDOC_START_RE.lastIndex = position;
  return HEREDOC_START_RE.exec(text);
}

function readBalanced(text: string, start: number): [string, number] {
  let depth = 1;
  let position = start;
  let pendingDelimiters: Array<[delimiter: string, stripTabs: boolean]> = [];
  while (position < text.length) {
    const char = text[position];
    const heredoc = matchHeredocStart(text, position);
    if (heredoc) {
      const delimiter = heredoc.slice(2, 5).find((group) => group !== undefined) ?? "";
      pendingDelimiters.push([delimiter, heredoc[1] === "-"]);
      position = heredoc.index + heredoc[0].length;
    } else if (char === "\n" && pendingDelimiters.length > 0) {
      position += 1;
      for (const [delimiter, stripTabs] of pendingDelimiters) {
        [, position] = readHeredocBody(text, position, delimiter, stripTabs);
      }
      pendingDelimiters = [];
    } else if (char === "\\") {
      position += 2;
    } else if (char === "'") {
      const close = text.indexOf("'", position + 1);
      position = close < 0 ? text.length : close + 1;
    } else if (char === '"') {
      [, position] = readDoubleQuoted(text, position + 1, []);
    } else if (char === "(") {
      depth += 1;
      position += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return [text.slice(start, position), position + 1];
      position += 1;
    } else {
      position += 1;
    }
  }
  return [text.slice(start), text.length];
}

function readHeredocBody(text: string, start: number, delimiter: string, stripTabs: boolean): [string, number] {
  const lines: string[] = [];
  let position = start;
  while (position < text.length) {
    const found = text.indexOf("\n", position);
    const end = found < 0 ? text.length : found;
    const line = text.slice(position, end);
    position = end + 1;
    if ((stripTabs ? lstripChar(line, "\t") : line) === delimiter) return [lines.join("\n"), position];
    lines.push(line);
  }
  return [lines.join("\n"), text.length];
}
