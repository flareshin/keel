import ts from 'typescript';
import { SCRIPT_FILE } from './consumers.ts';

export type Operator =
  | 'call-removal'
  | 'logic-term'
  | 'condition-negation'
  | 'boundary'
  | 'return-constant'
  | 'catch-swallow'
  | 'aggregate-swap'
  | 'text-removal';

export interface Mutant {
  priority: number;
  operator: Operator;
  line: number;
  start: number;
  end: number;
  replacement: string;
}

interface Splice {
  operator: Operator;
  start: number;
  end: number;
  replacement: string;
}

const PRIORITY: Record<Operator, number> = {
  'call-removal': 1,
  'logic-term': 2,
  'condition-negation': 3,
  'boundary': 4,
  'return-constant': 5,
  'catch-swallow': 6,
  'aggregate-swap': 7,
  'text-removal': 8,
};
const EMPTY_STATEMENT = ';';
const EMPTY_BLOCK = '{}';
const RETURN_CONSTANTS = ['null', '[]', 'false'];
const BOUNDARY_SWAPS = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.GreaterThanToken, '>='],
  [ts.SyntaxKind.GreaterThanEqualsToken, '>'],
  [ts.SyntaxKind.LessThanToken, '<='],
  [ts.SyntaxKind.LessThanEqualsToken, '<'],
]);
const LOGIC_OPERATORS = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken]);
const AGGREGATE_SWAPS = new Map([['find', 'filter'], ['filter', 'find']]);
const SENTENCE_GAP = /(?<=[.!?])\s+/gu;
const QUOTE_LENGTH = 1;

export function generateMutants(fileName: string, source: string, changedLines: Set<number>): Mutant[] {
  if (!SCRIPT_FILE.test(fileName)) return [];
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const splices: Splice[] = [];
  const visit = (node: ts.Node): void => {
    splices.push(...splicesFor(node, file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return splices
    .filter((splice) => splice.replacement !== source.slice(splice.start, splice.end))
    .filter((splice) => touchesChangedLine(file, splice, changedLines))
    .map((splice) => ({ ...splice, priority: PRIORITY[splice.operator], line: lineOf(file, splice.start) }))
    .sort((a, b) => a.priority - b.priority);
}

export function applyMutant(source: string, mutant: Mutant): string {
  return source.slice(0, mutant.start) + mutant.replacement + source.slice(mutant.end);
}

function splicesFor(node: ts.Node, file: ts.SourceFile): Splice[] {
  if (ts.isExpressionStatement(node)) return callRemoval(node, file);
  if (ts.isBinaryExpression(node)) return [...logicTerms(node, file), ...boundary(node, file)];
  if (ts.isIfStatement(node)) return negation(node.expression, file);
  if (ts.isConditionalExpression(node)) return negation(node.condition, file);
  if (ts.isReturnStatement(node)) return returnConstants(node, file);
  if (ts.isCatchClause(node)) return catchSwallow(node, file);
  if (ts.isPropertyAccessExpression(node)) return aggregateSwap(node, file);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return sentenceRemovals(node, file);
  if (ts.isArrayLiteralExpression(node)) return stringElementRemovals(node, file);
  return [];
}

function callRemoval(statement: ts.ExpressionStatement, file: ts.SourceFile): Splice[] {
  const expression = ts.isAwaitExpression(statement.expression) ? statement.expression.expression : statement.expression;
  if (!ts.isCallExpression(expression)) return [];
  return [splice('call-removal', statement, file, EMPTY_STATEMENT)];
}

function logicTerms(expression: ts.BinaryExpression, file: ts.SourceFile): Splice[] {
  if (!LOGIC_OPERATORS.has(expression.operatorToken.kind)) return [];
  return [expression.left, expression.right].map((term) => splice('logic-term', expression, file, term.getText(file)));
}

function boundary(expression: ts.BinaryExpression, file: ts.SourceFile): Splice[] {
  const swapped = BOUNDARY_SWAPS.get(expression.operatorToken.kind);
  return swapped === undefined ? [] : [splice('boundary', expression.operatorToken, file, swapped)];
}

function negation(condition: ts.Expression, file: ts.SourceFile): Splice[] {
  return [splice('condition-negation', condition, file, `!(${condition.getText(file)})`)];
}

function returnConstants(statement: ts.ReturnStatement, file: ts.SourceFile): Splice[] {
  const value = statement.expression;
  if (value === undefined) return [];
  return RETURN_CONSTANTS.map((constant) => splice('return-constant', value, file, constant));
}

function catchSwallow(clause: ts.CatchClause, file: ts.SourceFile): Splice[] {
  const statements = clause.block.statements;
  if (statements.length === 0) return [];
  const onlyRethrows = statements.length === 1 && ts.isThrowStatement(statements[0] as ts.Statement);
  const rethrows = onlyRethrows ? [] : rethrowsIn(clause.block);
  return [
    splice('catch-swallow', clause.block, file, EMPTY_BLOCK),
    ...rethrows.map((rethrow) => splice('catch-swallow', rethrow, file, EMPTY_STATEMENT)),
  ];
}

function rethrowsIn(block: ts.Block): ts.ThrowStatement[] {
  const found: ts.ThrowStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isCatchClause(node)) return;
    if (ts.isThrowStatement(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(block, visit);
  return found;
}

function aggregateSwap(access: ts.PropertyAccessExpression, file: ts.SourceFile): Splice[] {
  const swapped = AGGREGATE_SWAPS.get(access.name.text);
  const called = ts.isCallExpression(access.parent) && access.parent.expression === access;
  return swapped === undefined || !called ? [] : [splice('aggregate-swap', access.name, file, swapped)];
}

function sentenceRemovals(literal: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral, file: ts.SourceFile): Splice[] {
  const bodyStart = literal.getStart(file) + QUOTE_LENGTH;
  const body = file.text.slice(bodyStart, literal.getEnd() - QUOTE_LENGTH);
  const gaps = [...body.matchAll(SENTENCE_GAP)]
    .map((gap) => ({ start: gap.index, end: gap.index + gap[0].length }))
    .filter((gap) => gap.end < body.length);
  if (gaps.length === 0) return [];
  const sentenceStarts = [0, ...gaps.map((gap) => gap.end)];
  return sentenceStarts.map((start, index): Splice => {
    const isLast = index === gaps.length;
    const removedStart = isLast ? (gaps.at(-1)?.start ?? start) : start;
    const removedEnd = isLast ? body.length : (sentenceStarts[index + 1] ?? body.length);
    return { operator: 'text-removal', start: bodyStart + removedStart, end: bodyStart + removedEnd, replacement: '' };
  });
}

function stringElementRemovals(array: ts.ArrayLiteralExpression, file: ts.SourceFile): Splice[] {
  const elements = array.elements;
  if (!elements.every(ts.isStringLiteral)) return [];
  return elements.map((element, index): Splice => {
    const next = elements[index + 1];
    const previous = elements[index - 1];
    const start = next === undefined && previous !== undefined ? previous.getEnd() : element.getStart(file);
    const end = next === undefined ? element.getEnd() : next.getStart(file);
    return { operator: 'text-removal', start, end, replacement: '' };
  });
}

function splice(operator: Operator, node: ts.Node, file: ts.SourceFile, replacement: string): Splice {
  return { operator, start: node.getStart(file), end: node.getEnd(), replacement };
}

function touchesChangedLine(file: ts.SourceFile, splice: Splice, changedLines: Set<number>): boolean {
  const last = lineOf(file, Math.max(splice.start, splice.end - 1));
  for (let line = lineOf(file, splice.start); line <= last; line++) {
    if (changedLines.has(line)) return true;
  }
  return false;
}

function lineOf(file: ts.SourceFile, position: number): number {
  return file.getLineAndCharacterOfPosition(position).line + 1;
}
