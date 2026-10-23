import { constants } from "node:os";
import { isSystemError } from "../../hooks/lib/hookkit/pycompat.ts";
import { OSError, TimeoutExpired } from "../../hooks/lib/hookkit/subprocess.ts";
import { pythonRepr } from "./pyrepr.ts";

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

export class UnicodeEncodeError extends ValueError {
  constructor(message: string) {
    super(message);
    this.name = "UnicodeEncodeError";
  }
}

const ERROR_TEXT: Record<string, string> = {
  EPERM: "Operation not permitted",
  ENOENT: "No such file or directory",
  EIO: "Input/output error",
  EACCES: "Permission denied",
  EEXIST: "File exists",
  EXDEV: "Invalid cross-device link",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  EINVAL: "Invalid argument",
  EMFILE: "Too many open files",
  ENOSPC: "No space left on device",
  EROFS: "Read-only file system",
  ENAMETOOLONG: "File name too long",
  ENOTEMPTY: "Directory not empty",
  ELOOP: "Too many levels of symbolic links",
  EAGAIN: "Resource temporarily unavailable",
  EBADF: "Bad file descriptor",
};

export function osErrorMessage(code: string | undefined, filename?: string, secondFilename?: string): string {
  const number = code === undefined ? undefined : (constants.errno as Record<string, number>)[code];
  const text = code === undefined ? undefined : ERROR_TEXT[code];
  if (number === undefined || text === undefined) return filename === undefined ? "OS error" : `OS error: ${pythonRepr(filename)}`;
  const names = filename === undefined ? "" : `: ${pythonRepr(filename)}` + (secondFilename === undefined ? "" : ` -> ${pythonRepr(secondFilename)}`);
  return `[Errno ${number}] ${text}${names}`;
}

export function pythonFailureMessage(error: unknown): string | null {
  if (error instanceof ValueError || error instanceof OSError || error instanceof TimeoutExpired) return error.message;
  if (isSystemError(error)) {
    const { path, dest } = error as NodeJS.ErrnoException & { dest?: string };
    return osErrorMessage(error.code, path, dest);
  }
  return null;
}

export function pythonExceptionName(error: unknown): string {
  if (isSystemError(error)) {
    switch (error.code) {
      case "ENOENT": return "FileNotFoundError";
      case "EACCES": case "EPERM": return "PermissionError";
      case "EISDIR": return "IsADirectoryError";
      case "ENOTDIR": return "NotADirectoryError";
      case "EEXIST": return "FileExistsError";
      default: return "OSError";
    }
  }
  return error instanceof Error ? error.constructor.name : "Exception";
}
