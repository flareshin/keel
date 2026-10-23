import { emit } from "../lib/command.ts";
import { main } from "../lib/config_policy.ts";

if (import.meta.main) emit(main(process.argv.slice(2)));
