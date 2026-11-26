#!/usr/bin/env node
import path from "node:path"
import { fileURLToPath } from "node:url"

import { runMain } from "../measure/lib/measurekit/cli.ts"
import { main } from "../lib/changelog/cli.ts"

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

runMain((argv) => main(argv, repoRoot))
