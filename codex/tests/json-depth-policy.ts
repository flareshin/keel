export const JSON_DEPTH_BOUND = 10000;

export interface JsonDepthDivergence {
  kind: "json-depth";
}

export const JSON_DEPTH_DIVERGENCE: JsonDepthDivergence = { kind: "json-depth" };

export const EXPECTED_DEPTH_DENY_REASON =
  "keel Codex guard: [F-attribution] git-guard: internal error on a guarded command; refusing it\n" +
  "- [F-attribution] The guard could not check this commit, push, PR text or protected write (RecursionError).\n" +
  "Stop and ask the user.";

export function divergenceForDepth(depth: number): JsonDepthDivergence | undefined {
  return depth > JSON_DEPTH_BOUND ? JSON_DEPTH_DIVERGENCE : undefined;
}
