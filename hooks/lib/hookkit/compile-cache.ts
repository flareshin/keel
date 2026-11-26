import { enableCompileCache } from "node:module";
import { compileCacheDir } from "../../../lib/evidence/compile-cache.ts";

enableCompileCache(compileCacheDir());
