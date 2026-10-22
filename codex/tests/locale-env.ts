const LOCALE_PREFIXES = ["LC_", "LANG"];
const PYTHON_TEXT_VARIABLES = ["PYTHONUTF8", "PYTHONIOENCODING", "PYTHONCOERCECLOCALE"];

export function withoutLocale(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!LOCALE_PREFIXES.some((prefix) => name.startsWith(prefix)) && !PYTHON_TEXT_VARIABLES.includes(name)) kept[name] = value;
  }
  return kept;
}
