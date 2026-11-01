import { isSystemError } from "../../hooks/lib/hookkit/files.ts";
import { OSError } from "../../hooks/lib/hookkit/subprocess.ts";
import { InvalidUtf8Error } from "../../measure/lib/measurekit/files.ts";
import { TimeoutExpired } from "../../measure/lib/measurekit/timeout.ts";

export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

export function refusalMessage(error: unknown): string | null {
  if (error instanceof Refusal || error instanceof InvalidUtf8Error || error instanceof OSError || error instanceof TimeoutExpired) return error.message;
  return isSystemError(error) ? error.message : null;
}
