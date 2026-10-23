export interface LexerCase {
  before: string;
  after: string;
  refused: boolean;
}

const COMMENT_LINE = '# hello there\n';
const F_PREFIXES = ['f', 'F', 'rf', 'fr', 'Rf', 'fR', 'RF', 'FR'];
const T_PREFIXES = ['t', 'T', 'tr', 'rt', 'Tr', 'tR', 'RT', 'rT'];
const PLAIN_PREFIXES = ['', 'r', 'b', 'u', 'rb', 'BR'];
const FIELD_FRAGMENTS = [
  '{x}', '{{', '}}', '{{{x}}}', '{x!r}', '{x!r:>10}', '{x:>10}', '{x:{w}}', '{x:#x}', '{x:%Y-%m}', '{x=}', "{'a'}", '{d["k"]}', "{f'{y}'}",
  '{(lambda: 1)()}', '{x # note\n}', '{\n    x\n}', '{\n    # whole line\n    x\n}', '\\N{EM DASH}', '\\n', 'plain # text',
];
const BRACE_ESCAPE_FRAGMENTS = ['\\{x}', '\\\\{x}', '\\{{x}}', '\\{'];

function insideTripleQuotes(prefix: string, quote: string, first: string, second: string): LexerCase {
  const triple = quote.repeat(3);
  const open = `s = ${prefix}${triple}${first}\n`;
  const close = `${second}${triple}\nprint(s)\n`;
  return { before: open + COMMENT_LINE + close, after: open + close, refused: false };
}

function afterTheString(prefix: string, quote: string, body: string): LexerCase {
  const statement = `s = ${prefix}${quote}${body}${quote}\n`;
  return { before: statement + COMMENT_LINE, after: statement, refused: false };
}

function casesFor(prefixes: string[], fragments: string[], refusedPrefix: boolean, refusedFragment: boolean): LexerCase[] {
  const found: LexerCase[] = [];
  for (const prefix of prefixes) {
    for (const quote of ['"', "'"]) {
      for (const first of fragments) {
        const refused = refusedPrefix || refusedFragment;
        found.push({ ...insideTripleQuotes(prefix, quote, first, ''), refused });
        found.push({ ...insideTripleQuotes(prefix, quote, first, first), refused });
        found.push({ ...afterTheString(prefix, quote, first.includes('\n') ? 'x' : first), refused });
      }
    }
  }
  return found;
}

const NESTED_QUOTES = '"""\n# hello there\n"""';

function nestedStringInField(prefix: string, lead: string, refused: boolean): LexerCase {
  const open = `s = ${prefix}"""${lead}{`;
  const close = '}"""\nprint(s)\n';
  return { before: `${open}${NESTED_QUOTES}${close}`, after: `${open}"""\n"""${close}`, refused };
}

function explicitCases(): LexerCase[] {
  const found: LexerCase[] = [];
  for (const prefix of [...F_PREFIXES, ...T_PREFIXES]) {
    const refusedPrefix = T_PREFIXES.includes(prefix);
    found.push(nestedStringInField(prefix, '', refusedPrefix));
    found.push(nestedStringInField(prefix, 'a ', refusedPrefix));
    found.push(nestedStringInField(prefix, '\\', true));
    found.push(nestedStringInField(prefix, '\\\\', true));
  }
  return found;
}

export function pythonLexerCases(): LexerCase[] {
  return [
    ...explicitCases(),
    ...casesFor(F_PREFIXES, FIELD_FRAGMENTS, false, false),
    ...casesFor(F_PREFIXES, BRACE_ESCAPE_FRAGMENTS, false, true),
    ...casesFor(PLAIN_PREFIXES, [...FIELD_FRAGMENTS, ...BRACE_ESCAPE_FRAGMENTS], false, false),
    ...casesFor(T_PREFIXES, FIELD_FRAGMENTS, true, false),
    ...casesFor(T_PREFIXES, BRACE_ESCAPE_FRAGMENTS, true, true),
  ];
}
