export type CommentSpan = [start: number, end: number, body: string];

const TAB_WIDTH = 8;
const STRING_PREFIXES = new Set(['r', 'u', 'b', 'f', 'br', 'rb', 'fr', 'rf']);
const WORD_CHARACTER = /[\p{L}\p{N}_\p{M}]|[^\x00-\x7f]/u;
const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);
const INVALID_CHARACTERS = new Set(['$', '?', '`']);
const LINE_SEPARATORS_OTHER_THAN_NEWLINE = /[\x0b\x0c\x1c-\x1e\x85]/;

class LexicalError extends Error {}

class Lexer {
  readonly spans: CommentSpan[] = [];
  private readonly source: string;
  private position = 0;
  private readonly brackets: string[] = [];
  private readonly indents = [0];
  private readonly alternateIndents = [0];

  constructor(source: string) {
    this.source = source;
  }

  run(): CommentSpan[] {
    this.lexLogicalLines();
    if (this.brackets.length > 0) throw new LexicalError('unclosed bracket');
    return this.spans;
  }

  private lexLogicalLines(): void {
    const length = this.source.length;
    while (this.position < length) {
      if (this.brackets.length === 0 && this.startsLine()) {
        if (this.skipBlankOrCommentLine()) continue;
        this.checkIndentation();
      }
      this.lexRestOfLine();
    }
  }

  private startsLine(): boolean {
    return this.position === 0 || this.source[this.position - 1] === '\n';
  }

  private skipBlankOrCommentLine(): boolean {
    let index = this.position;
    while (this.source[index] === ' ' || this.source[index] === '\t' || this.source[index] === '\f') index++;
    const character = this.source[index];
    if (character === '#') {
      this.position = index;
      this.lexComment();
      return true;
    }
    if (character === '\n' || (character === '\r' && this.source[index + 1] === '\n')) {
      this.position = index + (character === '\r' ? 2 : 1);
      return true;
    }
    return index >= this.source.length ? ((this.position = index), true) : false;
  }

  private checkIndentation(): void {
    let column = 0;
    let alternate = 0;
    for (;; this.position++) {
      const character = this.source[this.position];
      if (character === ' ') {
        column++;
        alternate++;
      } else if (character === '\t') {
        column = (Math.floor(column / TAB_WIDTH) + 1) * TAB_WIDTH;
        alternate++;
      } else if (character === '\f') {
        column = 0;
        alternate = 0;
      } else {
        break;
      }
    }
    const top = this.indents.length - 1;
    if (column === this.indents[top]) {
      if (alternate !== this.alternateIndents[top]) throw new LexicalError('inconsistent tabs');
    } else if (column > this.indents[top]!) {
      if (alternate <= this.alternateIndents[top]!) throw new LexicalError('inconsistent tabs');
      this.indents.push(column);
      this.alternateIndents.push(alternate);
    } else {
      while (this.indents.length > 1 && column < this.indents[this.indents.length - 1]!) {
        this.indents.pop();
        this.alternateIndents.pop();
      }
      const kept = this.indents.length - 1;
      if (column !== this.indents[kept]) throw new LexicalError('unindent does not match');
      if (alternate !== this.alternateIndents[kept]) throw new LexicalError('inconsistent tabs');
    }
  }

  private lexRestOfLine(): void {
    const length = this.source.length;
    while (this.position < length) {
      const character = this.source[this.position]!;
      if (character === '\n') {
        this.position++;
        if (this.brackets.length === 0) return;
      } else if (character === '#') {
        this.lexComment();
      } else if (character === '\\') {
        this.lexLineContinuation();
      } else if (character === '"' || character === "'") {
        this.position = this.endOfString(this.position, false, false);
      } else if (WORD_CHARACTER.test(character)) {
        this.lexWord();
      } else {
        this.lexOperator(character);
      }
    }
  }

  private lexLineContinuation(): void {
    const next = this.source[this.position + 1];
    if (next === '\n') this.position += 2;
    else if (next === '\r' && this.source[this.position + 2] === '\n') this.position += 3;
    else throw new LexicalError('unexpected character after line continuation');
  }

  private lexComment(): void {
    const start = this.position;
    let end = start;
    while (end < this.source.length && this.source[end] !== '\n' && this.source[end] !== '\r') end++;
    this.spans.push([start, end, this.source.slice(start + 1, end)]);
    this.position = end;
  }

  private lexWord(): void {
    const start = this.position;
    let end = start;
    while (end < this.source.length && WORD_CHARACTER.test(this.source[end]!)) end++;
    const word = this.source.slice(start, end);
    const quote = this.source[end];
    if ((quote === '"' || quote === "'") && STRING_PREFIXES.has(word.toLowerCase())) {
      const lowered = word.toLowerCase();
      this.position = this.endOfString(end, lowered.includes('f'), lowered.includes('r'));
    } else {
      this.position = end;
    }
  }

  private lexOperator(character: string): void {
    if (OPENERS[character] !== undefined) this.brackets.push(OPENERS[character]!);
    else if (CLOSERS.has(character)) {
      if (this.brackets.pop() !== character) throw new LexicalError('unmatched bracket');
    } else if (INVALID_CHARACTERS.has(character)) {
      throw new LexicalError('invalid character');
    }
    this.position++;
  }

  private endOfString(quoteIndex: number, formatted: boolean, raw: boolean): number {
    const quote = this.source[quoteIndex]!;
    const triple = this.source.startsWith(quote.repeat(3), quoteIndex);
    const bodyStart = quoteIndex + (triple ? 3 : 1);
    return formatted ? this.endOfFormattedString(bodyStart, quote, triple, raw) : this.endOfPlainString(bodyStart, quote, triple);
  }

  private endOfPlainString(start: number, quote: string, triple: boolean): number {
    let index = start;
    while (index < this.source.length) {
      const character = this.source[index]!;
      if (character === '\\') index += this.source[index + 1] === '\r' && this.source[index + 2] === '\n' ? 3 : 2;
      else if (triple ? this.source.startsWith(quote.repeat(3), index) : character === quote) return index + (triple ? 3 : 1);
      else if (!triple && (character === '\n' || character === '\r')) throw new LexicalError('unterminated string');
      else index++;
    }
    throw new LexicalError('unterminated string');
  }

  private endOfFormattedString(start: number, quote: string, triple: boolean, raw: boolean): number {
    let index = start;
    while (index < this.source.length) {
      const character = this.source[index]!;
      if (triple ? this.source.startsWith(quote.repeat(3), index) : character === quote) return index + (triple ? 3 : 1);
      if (character === '\\') index = this.afterEscape(index, raw);
      else if (character === '{') index = this.source[index + 1] === '{' ? index + 2 : this.endOfField(index + 1);
      else if (character === '}') index = this.consumeClosingBrace(index);
      else if (!triple && (character === '\n' || character === '\r')) throw new LexicalError('unterminated string');
      else index++;
    }
    throw new LexicalError('unterminated string');
  }

  private afterEscape(index: number, raw: boolean): number {
    if (!raw && this.source.startsWith('\\N{', index)) {
      const close = this.source.indexOf('}', index);
      if (close < 0) throw new LexicalError('unterminated name escape');
      return close + 1;
    }
    return index + (this.source[index + 1] === '\r' && this.source[index + 2] === '\n' ? 3 : 2);
  }

  private consumeClosingBrace(index: number): number {
    if (this.source[index + 1] !== '}') throw new LexicalError('single closing brace');
    return index + 2;
  }

  private endOfField(start: number): number {
    const depth: string[] = [];
    let index = start;
    while (index < this.source.length) {
      const character = this.source[index]!;
      if (character === '}' && depth.length === 0) return index + 1;
      if (character === '!' && depth.length === 0 && this.source[index + 1] !== '=') index = this.afterConversion(index + 1);
      else if (character === ':' && depth.length === 0) return this.endOfFormatSpec(index + 1);
      else if (character === '"' || character === "'") index = this.endOfString(index, false, false);
      else if (character === '#') index = this.commentInField(index);
      else if (OPENERS[character] !== undefined) {
        depth.push(OPENERS[character]!);
        index++;
      } else if (CLOSERS.has(character)) {
        if (depth.pop() !== character) throw new LexicalError('unmatched bracket in field');
        index++;
      } else if (WORD_CHARACTER.test(character)) index = this.wordInField(index);
      else index++;
    }
    throw new LexicalError('unterminated field');
  }

  private afterConversion(index: number): number {
    let cursor = index;
    while (cursor < this.source.length && this.source[cursor] !== ':' && this.source[cursor] !== '}') cursor++;
    return cursor;
  }

  private endOfFormatSpec(start: number): number {
    let index = start;
    while (index < this.source.length) {
      const character = this.source[index]!;
      if (character === '}') return index + 1;
      if (character === '{') index = this.endOfField(index + 1);
      else index++;
    }
    throw new LexicalError('unterminated format spec');
  }

  private commentInField(index: number): number {
    this.position = index;
    this.lexComment();
    return this.position;
  }

  private wordInField(start: number): number {
    const saved = this.position;
    this.position = start;
    this.lexWord();
    const end = this.position;
    this.position = saved;
    return end;
  }
}

export function pythonCommentSpans(source: string): CommentSpan[] | null {
  if (LINE_SEPARATORS_OTHER_THAN_NEWLINE.test(source)) return null;
  try {
    return new Lexer(source).run();
  } catch (error) {
    if (error instanceof LexicalError) return null;
    throw error;
  }
}
