const OUTSIDE_CLASS_SPECIALS = new Set('\\^$.*+?()[]{}|/');
const INSIDE_CLASS_SPECIALS = new Set('\\^[]-');
const RANGE_MARK = '-';
const NEGATION = '!';
const CLASS_END = ']';

export function globMatches(name: string, pattern: string): boolean {
  return new RegExp(`^(?:${translate(Array.from(pattern))})$`, 'su').test(name);
}

function translate(chars: string[]): string {
  let source = '';
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!;
    if (char === '*') {
      source += '.*';
      while (chars[index + 1] === '*') index++;
    } else if (char === '?') {
      source += '.';
    } else if (char === '[') {
      const end = classEnd(chars, index + 1);
      if (end === null) {
        source += '\\[';
      } else {
        source += characterClass(chars.slice(index + 1, end));
        index = end;
      }
    } else {
      source += OUTSIDE_CLASS_SPECIALS.has(char) ? '\\' + char : char;
    }
  }
  return source;
}

function classEnd(chars: string[], start: number): number | null {
  let end = start;
  if (chars[end] === NEGATION) end++;
  if (chars[end] === CLASS_END) end++;
  while (end < chars.length && chars[end] !== CLASS_END) end++;
  return end < chars.length ? end : null;
}

function characterClass(body: string[]): string {
  const negated = body[0] === NEGATION;
  const members = negated ? body.slice(1) : body;
  let source = '';
  for (let index = 0; index < members.length; index++) {
    const first = escapeInClass(members[index]!);
    const isRange = members[index + 1] === RANGE_MARK && index + 2 < members.length;
    source += isRange ? `${first}-${escapeInClass(members[index + 2]!)}` : first;
    if (isRange) index += 2;
  }
  return `[${negated ? '^' : ''}${source}]`;
}

function escapeInClass(char: string): string {
  return INSIDE_CLASS_SPECIALS.has(char) ? '\\' + char : char;
}
