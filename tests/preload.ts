import { pathToFileURL } from "node:url";

export function withPreload(moduleFilename: string, variables: Record<string, string>): Record<string, string> {
  const preload = `--import=${pathToFileURL(moduleFilename).href}`;
  const inherited = process.env["NODE_OPTIONS"];
  return { ...variables, NODE_OPTIONS: inherited ? `${inherited} ${preload}` : preload };
}
