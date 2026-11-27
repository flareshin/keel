export function withNodePreload<Variables extends Record<string, string>>(
  preload: URL,
  variables: Variables,
  inheritedNodeOptions = process.env['NODE_OPTIONS'],
): Variables & { NODE_OPTIONS: string } {
  const preloadOption = `--import=${preload.href}`;
  return { ...variables, NODE_OPTIONS: inheritedNodeOptions ? `${inheritedNodeOptions} ${preloadOption}` : preloadOption };
}
