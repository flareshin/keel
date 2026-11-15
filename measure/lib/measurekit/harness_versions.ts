import fs from "node:fs"
import path from "node:path"

import * as store from "../../../lib/evidence/store.ts"
import { readJsonl } from "./datafiles.ts"
import { compareCodePoints, isJsonObject } from "./json.ts"

const CONTRACT_FIXTURES = path.join("tests", "hooks", "fixtures", "harness-contract")
const NUMERIC_SEGMENT = /^[0-9]+$/

export interface HarnessVersions {
  recorded: string[]
  observed: Record<string, number>
  unrecorded_newer: string[]
  unversioned: number
}

export function summarizeHarnessVersions(keelHome: string): HarnessVersions | { error: string } {
  let transcripts: string[]
  try {
    transcripts = reviewTranscripts()
  } catch (error) {
    if (!(error instanceof store.EvidenceError || error instanceof store.EvidenceTooDeepError)) throw error
    return { error: error.message }
  }
  const recorded = [...new Set(contractFixtures(keelHome).flatMap(versionsIn))].sort(compareVersions)
  const observed = new Map<string, number>()
  let unversioned = 0
  for (const transcript of transcripts) {
    const version = fs.existsSync(transcript) ? versionsIn(transcript).at(-1) : undefined
    if (version === undefined) unversioned++
    else observed.set(version, (observed.get(version) ?? 0) + 1)
  }
  const newestRecorded = recorded.at(-1)
  const versions = [...observed.keys()].sort(compareVersions)
  return {
    recorded,
    observed: Object.fromEntries(versions.map((version) => [version, observed.get(version) ?? 0])),
    unrecorded_newer: versions.filter((version) => newestRecorded === undefined || compareVersions(version, newestRecorded) > 0),
    unversioned,
  }
}

export function compareVersions(left: string, right: string): number {
  const leftSegments = left.split(".")
  const rightSegments = right.split(".")
  for (let index = 0; index < Math.max(leftSegments.length, rightSegments.length); index++) {
    const order = compareSegments(leftSegments[index] ?? "", rightSegments[index] ?? "")
    if (order !== 0) return order
  }
  return 0
}

function compareSegments(left: string, right: string): number {
  if (NUMERIC_SEGMENT.test(left) && NUMERIC_SEGMENT.test(right)) return Number(left) - Number(right)
  return compareCodePoints(left, right)
}

function reviewTranscripts(): string[] {
  const paths = store.repoKeys("review").flatMap((repoKey) => store.loadReviews(repoKey)).map((review) => review["source"])
    .map((source) => (isJsonObject(source) ? source["agent_transcript_path"] : undefined))
  return [...new Set(paths.filter((transcript) => typeof transcript === "string"))]
}

function contractFixtures(keelHome: string): string[] {
  const directory = path.join(keelHome, CONTRACT_FIXTURES)
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory).filter((name) => name.endsWith(".jsonl")).sort(compareCodePoints).map((name) => path.join(directory, name))
}

function versionsIn(transcript: string): string[] {
  return [...new Set(readJsonl(transcript).records.map((entry) => entry["version"]).filter((version) => typeof version === "string"))]
}
