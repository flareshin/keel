export interface CommandOption {
  flags: readonly string[];
  dest: string;
  takesValue: boolean;
  required?: boolean;
  exclusiveGroup?: string;
}

export interface CommandParser {
  prog: string;
  usage: string;
  help: string;
  options: readonly CommandOption[];
}

export type ParsedArguments = Map<string, string | true>;

export class ExitRequest extends Error {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(code: number, stdout: string, stderr: string) {
    super(`exit ${code}`);
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

interface Candidate {
  option: CommandOption | null;
  flag: string;
  explicit: string | null;
  viaEquals?: boolean;
}

type Classified = { positional: true } | { positional: false; candidate: Candidate | null; text: string; ambiguous?: string[] };

const HELP_OPTION: CommandOption = { flags: ["-h", "--help"], dest: "help", takesValue: false };
const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/;

function optionName(option: CommandOption): string {
  return option.flags.join("/");
}

export function parseArguments(parser: CommandParser, argv: readonly string[]): ParsedArguments {
  const options = [HELP_OPTION, ...parser.options];
  const fail = (message: string): never => {
    throw new ExitRequest(2, "", `${parser.usage}${parser.prog}: error: ${message}\n`);
  };
  const classes: Classified[] = [];
  for (const text of argv) {
    if (text === "--") break;
    classes.push(classifyArgument(options, text));
  }
  const values: ParsedArguments = new Map();
  const seen: CommandOption[] = [];
  const extras: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const text = argv[index] ?? "";
    index += 1;
    const classified = classes[index - 1];
    if (classified === undefined) {
      extras.push(...argv.slice(index - 1));
      break;
    }
    if (classified.positional) {
      extras.push(text);
      continue;
    }
    if (classified.ambiguous !== undefined) fail(`ambiguous option: ${text} could match ${classified.ambiguous.join(", ")}`);
    const { candidate } = classified;
    if (candidate?.option == null) {
      extras.push(text);
      continue;
    }
    const { option, explicit } = candidate;
    if (option === HELP_OPTION) {
      if (explicit !== null && (candidate.viaEquals || candidate.flag !== "-h")) {
        fail(`argument ${optionName(option)}: ignored explicit argument '${explicit}'`);
      }
      throw new ExitRequest(0, parser.help, "");
    }
    let value: string | true = true;
    if (option.takesValue) {
      if (explicit !== null) {
        value = explicit;
      } else {
        const next = classes[index];
        if (next === undefined || !next.positional) fail(`argument ${optionName(option)}: expected one argument`);
        value = argv[index] ?? "";
        index += 1;
      }
    } else if (explicit !== null) {
      fail(`argument ${optionName(option)}: ignored explicit argument '${explicit}'`);
    }
    const conflict = seen.find((other) => other !== option && option.exclusiveGroup !== undefined && other.exclusiveGroup === option.exclusiveGroup);
    if (conflict !== undefined) fail(`argument ${optionName(option)}: not allowed with argument ${optionName(conflict)}`);
    if (!seen.includes(option)) seen.push(option);
    values.set(option.dest, value);
  }
  const missing = parser.options.filter((option) => option.required && !values.has(option.dest));
  if (missing.length > 0) fail(`the following arguments are required: ${missing.map(optionName).join(", ")}`);
  if (extras.length > 0) fail(`unrecognized arguments: ${extras.join(" ")}`);
  return values;
}

function classifyArgument(options: readonly CommandOption[], text: string): Classified {
  if (text === "" || !text.startsWith("-")) return { positional: true };
  const exact = options.find((option) => option.flags.includes(text));
  if (exact !== undefined) return { positional: false, candidate: { option: exact, flag: text, explicit: null }, text };
  if (text.length === 1) return { positional: true };
  if (text.includes("=")) {
    const cut = text.indexOf("=");
    const optionFlag = text.slice(0, cut);
    const named = options.find((option) => option.flags.includes(optionFlag));
    if (named !== undefined) return { positional: false, candidate: { option: named, flag: optionFlag, explicit: text.slice(cut + 1), viaEquals: true }, text };
  }
  const matches = abbreviationMatches(options, text);
  if (matches.length > 1) return { positional: false, candidate: null, text, ambiguous: matches.map((match) => match.flag) };
  if (matches.length === 1) return { positional: false, candidate: matches[0] ?? null, text };
  if (NEGATIVE_NUMBER.test(text) || text.includes(" ")) return { positional: true };
  return { positional: false, candidate: null, text };
}

function abbreviationMatches(options: readonly CommandOption[], text: string): Candidate[] {
  const matches: Candidate[] = [];
  if (text.startsWith("--")) {
    const cut = text.indexOf("=");
    const prefix = cut < 0 ? text : text.slice(0, cut);
    const explicit = cut < 0 ? null : text.slice(cut + 1);
    for (const option of options) {
      for (const flag of option.flags) if (flag.startsWith(prefix)) matches.push({ option, flag, explicit, viaEquals: explicit !== null });
    }
  } else {
    const shortPrefix = text.slice(0, 2);
    for (const option of options) {
      for (const flag of option.flags) {
        if (flag === shortPrefix) matches.push({ option, flag, explicit: text.slice(2) });
        else if (flag.startsWith(text)) matches.push({ option, flag, explicit: null });
      }
    }
  }
  return matches;
}
