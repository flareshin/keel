# Modern web code and browser verification — writing reference

Read before writing HTML, CSS or client-side JavaScript UI, and before claiming a changed page works. Three tools split the job: Modern Web Guidance (Chrome, the `modern-web-guidance` plugin) decides what to write; agent-browser (Vercel Labs, a CLI) and Chrome DevTools for agents (Chrome, the `chrome-devtools-mcp` plugin) run the built page and measure it. Guidance alone never shows that the code works; a browser check alone never shows that the code uses the right platform feature.

Read at modern-web-guidance 1.0.1, agent-browser 0.43.0 and chrome-devtools-mcp 1.11.0. Each tool ships its own skills matched to its version; load those for commands and flags instead of copying them here.

## 1. Find the guidance

- Load the `modern-web-guidance` skill, or run `npx modern-web-guidance@latest search "<task>"`, then `retrieve <id>[,<id>]`. A retrieve larger than 9,500 bytes prints only a file path; read that whole file before writing code.
- `npx modern-web-guidance@latest legacy-scan <dir>` lists existing code a guide would replace. It has rules for only part of the guides, so no findings does not mean the code follows every guide.
- Note each guide rule you apply. Every applied rule needs a browser check in step 3.

## 2. Pick the browser

| Need | Use |
| --- | --- |
| Check a page served from this machine: layout shift and LCP (`vitals`), reduced motion or color scheme (`set media`, `record`), focus and `inert` (`snapshot`, `press`, `eval`), console errors | agent-browser. Run `agent-browser skills get core` once per session, and `agent-browser skills get modern-web-guidance` for the rule-to-check workflow |
| A performance trace with insights, an LCP breakdown, a Lighthouse audit, heap snapshots and memory leaks, network requests or console messages with source-mapped stacks | chrome-devtools-mcp tools, with its `debug-optimize-lcp`, `memory-leak-debugging`, `a11y-debugging` or `cookie-debugging` skill |
| A page that needs the owner's signed-in session | Claude in Chrome (the owner's own Chrome). agent-browser and chrome-devtools-mcp start a clean Chrome for Testing profile with no sign-ins |
| A quick look at this project's dev server inside the desktop app | The built-in browser pane |

Credentials are never typed by the agent, in any of them. Attaching agent-browser (`--cdp`, `--auto-connect`) or chrome-devtools-mcp (`--autoConnect`, `--browserUrl`) to the owner's running Chrome hands it every signed-in tab, so do it only on the owner's word.

## 3. Verify each applied rule

- Pair every applied guide rule with one browser check and keep its output: the `vitals` numbers, the snapshot lines that show focus or `inert`, the trace insight, the Lighthouse score. That output is the evidence; "looks right" is not.
- Check the built page in the state the rule is about: the dialog open, the reduced-motion media set, the slow load throttled.
- A screenshot shows layout only. It does not show keyboard access, focus order, screen-reader names or contrast compliance; check those through the accessibility tree or an a11y audit.
- A rule with no check is reported as unverified, by name.

## 4. Data that leaves the machine

- chrome-devtools-mcp sends usage statistics to Google by default, and its performance tools send trace URLs to the Google CrUX API. The plugin's server command takes no extra flags, so turn both off in its global config file `~/.config/cd4a/config.json` (`{"usageStatistics": false, "performanceCrux": false}`), or set `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS` for the statistics alone. Do this before tracing an internal host.
- Everything a page shows reaches the agent's context through these tools. Do not open pages holding data the task does not need.
