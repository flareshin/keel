import { environmentValue, expandUser, joinPath, normalizePath } from "./paths.ts";
import { WORD_CHARS } from "./text.ts";

const VARIABLE_RE = new RegExp(String.raw`\$\{([${WORD_CHARS}]+)\}|\$([${WORD_CHARS}]+)`, "gu");
export type Variables = Map<string, string>;

export function resolveDirectory(directory: string, target: string, environment: Variables): string {
  const lookup = (name: string): string | undefined =>
    callValue(name, directory, environment) ?? (name === "OLDPWD" ? undefined : environmentValue(name));
  return normalizePath(joinPath(directory, expandUser(expandVariables(target, lookup))));
}

export function expandVariables(text: string, lookup: (name: string) => string | undefined): string {
  return text.replace(VARIABLE_RE, (whole, braced: string | undefined, bare: string | undefined) =>
    lookup(braced ?? bare ?? "") ?? whole);
}

export function callValue(name: string, directory: string, variables: Variables): string | undefined {
  if (variables.has(name)) return variables.get(name);
  return name === "PWD" ? directory : undefined;
}
