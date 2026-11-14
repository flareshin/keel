#!/usr/bin/env node
import path from "node:path"

import { runMain } from "../measure/lib/measurekit/cli.ts"
import { main } from "../lib/changelog/cli.ts"

const repoRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname))

runMain((argv) => main(argv, repoRoot))
