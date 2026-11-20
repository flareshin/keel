### Fixed

- `npm run typecheck` passes again. 1.1.7 failed it with one error: `tests/measure/review_tokens.test.ts(52,13)` passed a token helper typed `object` where `Record<string, unknown>` is expected. The test helpers now return `Record<string, number>`. Only that test file changed, so plugin behavior is unchanged.
