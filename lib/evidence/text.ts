const WHITESPACE_EITHER_WAY = '\\s\\x1c-\\x1f\\x85';
const STRIP_EDGES = new RegExp(`^[${WHITESPACE_EITHER_WAY}]+|[${WHITESPACE_EITHER_WAY}]+$`, 'g');
const WHITESPACE_BOTH_WAYS = /^[^\S\ufeff]*$/;

export const SPACE_EITHER_WAY = `[${WHITESPACE_EITHER_WAY}]`;

export function stripEitherWay(text: string): string {
  return text.replace(STRIP_EDGES, '');
}

export function isBlankEitherWay(text: string): boolean {
  return stripEitherWay(text) === '';
}

export function isWhitespaceBothWays(text: string): boolean {
  return WHITESPACE_BOTH_WAYS.test(text);
}
