import { enableCompileCache } from "node:module";
import { dataDir } from "./env.ts";
import { joinPath } from "./paths.ts";

enableCompileCache(joinPath(dataDir(), "state", "keel", "node-compile-cache"));
