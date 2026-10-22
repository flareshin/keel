import { emit } from "../lib/command.ts";
import { main } from "../lib/install.ts";

if (import.meta.main) emit(main(process.argv.slice(2)));
