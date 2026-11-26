export const MAX_FAILED_TESTS = 20;
export const MAX_FAILED_TEST_NAME_LENGTH = 200;
const ANSI_STYLE = /\x1b\[[0-9;]*m/gu;
const FAILED_TEST_LINES: RegExp[] = [
  /^[ \t]*not ok [0-9]+ - (.+?)(?<! # (?:TODO|SKIP)\b.*)\r?$/gmu,
  /^[ \t]*✖ (?!failing tests:)(.+?)(?: \([0-9.]+m?s\))?\r?$/gmu,
  /^(?:FAILED|ERROR) (\S+::\S+)/gmu,
  /^(?:FAIL|ERROR): (\S+ \([^)\r\n]+\))/gmu,
  /^[ \t]*● (?!Console\r?$)(.+?)\r?$/gmu,
  /^[ \t]*FAIL {2}(\S.*? > .+?)\r?$/gmu,
  /^(?:\[ERROR\] )?(\S+?)\s+(?:-- )?Time elapsed:[^\r\n]*<<< (?:FAILURE|ERROR)!/gmu,
];

export function failedTests(output: string): string[] {
  const plain = output.replace(ANSI_STYLE, '');
  const found = FAILED_TEST_LINES.flatMap((pattern) => [...plain.matchAll(pattern)])
    .sort((first, second) => first.index - second.index)
    .map((match) => match[1]!.slice(0, MAX_FAILED_TEST_NAME_LENGTH));
  return [...new Set(found)].slice(0, MAX_FAILED_TESTS);
}
