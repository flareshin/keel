export const UNRELEASED_HEADING = "## [Unreleased]"
export const UNRELEASED_POINTER = "New entries go in `changelog.d/`, one file per branch; `changelog.d/README.md` explains the format."

const CATEGORY_ORDER = ["Added", "Changed", "Fixed", "Removed", "Upgrading"]
const CATEGORY_PREFIX = "### "
const VERSION_PREFIX = "## "
const VERSION = /^\d+\.\d+\.\d+$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export interface Fragment {
  readonly name: string
  readonly text: string
}

export interface Release {
  readonly section: string
  readonly changelog: string
}

export class ReleaseRefused extends Error {}

interface ParsedFragment {
  readonly lead: string
  readonly categories: ReadonlyMap<string, string>
}

export function assembleRelease(changelog: string, fragments: readonly Fragment[], version: string, date: string): Release {
  if (!VERSION.test(version)) throw new ReleaseRefused(`version must look like 1.2.3, got ${JSON.stringify(version)}`)
  if (!ISO_DATE.test(date)) throw new ReleaseRefused(`date must be YYYY-MM-DD, got ${JSON.stringify(date)}`)
  if (fragments.length === 0) throw new ReleaseRefused("changelog.d/ holds no fragment; nothing to release")
  if (changelog.includes(`\n## [${version}]`)) throw new ReleaseRefused(`CHANGELOG.md already has a ${version} section`)

  const { before, after } = splitAfterUnreleased(changelog)
  const ordered = [...fragments].sort((left, right) => left.name.localeCompare(right.name))
  const section = renderSection(version, date, ordered.map(parseFragment))
  return { section, changelog: `${before}\n${section}\n${after}` }
}

export function unreleasedBody(changelog: string): string {
  const start = changelog.indexOf(`${UNRELEASED_HEADING}\n`)
  if (start < 0) throw new ReleaseRefused(`CHANGELOG.md has no "${UNRELEASED_HEADING}" heading`)
  const bodyStart = start + UNRELEASED_HEADING.length + 1
  const next = changelog.indexOf(`\n${VERSION_PREFIX}`, bodyStart)
  return changelog.slice(bodyStart, next < 0 ? changelog.length : next + 1).trim()
}

function splitAfterUnreleased(changelog: string): { before: string; after: string } {
  const body = unreleasedBody(changelog)
  if (body !== UNRELEASED_POINTER) {
    throw new ReleaseRefused("the Unreleased section must hold only the changelog.d/ pointer; move its entries into a fragment")
  }
  const pointerEnd = changelog.indexOf(UNRELEASED_POINTER) + UNRELEASED_POINTER.length
  const before = changelog.slice(0, pointerEnd) + "\n"
  const after = changelog.slice(pointerEnd).replace(/^\n+/, "")
  return { before, after }
}

function parseFragment(fragment: Fragment): ParsedFragment {
  const leadLines: string[] = []
  const categories = new Map<string, string[]>()
  let current: string[] = leadLines
  for (const line of fragment.text.split("\n")) {
    if (line.startsWith(CATEGORY_PREFIX)) {
      const category = line.slice(CATEGORY_PREFIX.length).trim()
      current = categories.get(category) ?? []
      categories.set(category, current)
    } else if (line.startsWith("#")) {
      throw new ReleaseRefused(`${fragment.name}: only "${CATEGORY_PREFIX}<category>" headings are allowed, got ${JSON.stringify(line)}`)
    } else {
      current.push(line)
    }
  }
  const parsed = {
    lead: joinTrimmed(leadLines),
    categories: new Map([...categories].map(([category, lines]) => [category, joinTrimmed(lines)])),
  }
  if (parsed.lead === "" && [...parsed.categories.values()].every((body) => body === "")) {
    throw new ReleaseRefused(`${fragment.name}: the fragment is empty`)
  }
  return parsed
}

function renderSection(version: string, date: string, fragments: readonly ParsedFragment[]): string {
  const blocks = [`## [${version}] - ${date}`]
  blocks.push(...fragments.map((fragment) => fragment.lead).filter((lead) => lead !== ""))
  for (const category of categoriesInReleaseOrder(fragments)) {
    const bodies = fragments.map((fragment) => fragment.categories.get(category) ?? "").filter((body) => body !== "")
    if (bodies.length > 0) blocks.push(`${CATEGORY_PREFIX}${category}`, ...bodies)
  }
  return blocks.join("\n\n") + "\n"
}

function categoriesInReleaseOrder(fragments: readonly ParsedFragment[]): string[] {
  const seen = fragments.flatMap((fragment) => [...fragment.categories.keys()])
  const others = [...new Set(seen)].filter((category) => !CATEGORY_ORDER.includes(category))
  return [...CATEGORY_ORDER, ...others]
}

function joinTrimmed(lines: readonly string[]): string {
  return lines.join("\n").trim()
}
