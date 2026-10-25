import { spawn, spawnSync } from "node:child_process"
import os from "node:os"

export interface RunOptions {
  input?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutSeconds?: number
  shell?: boolean
  stdin?: "inherit" | "ignore"
}

export interface RunResult {
  returncode: number
  stdout: string
  stderr: string
}

export class TimeoutExpired extends Error {
  readonly partialStdout: string

  constructor(command: string[] | string, timeoutSeconds: number, partialStdout: string) {
    super(`command ${JSON.stringify(command)} timed out after ${timeoutSeconds} seconds`)
    this.partialStdout = partialStdout
  }
}

export function runProcess(command: string[] | string, options: RunOptions = {}): RunResult {
  const useShell = options.shell === true
  const argv = typeof command === "string" ? [command] : command
  const program = argv[0] ?? ""
  const inputGiven = options.input !== undefined
  const result = spawnSync(program, useShell ? [] : argv.slice(1), {
    input: options.input,
    cwd: options.cwd,
    env: options.env,
    shell: useShell,
    encoding: "utf8",
    timeout: options.timeoutSeconds === undefined ? undefined : options.timeoutSeconds * 1000,
    killSignal: "SIGKILL",
    maxBuffer: Infinity,
    stdio: [inputGiven ? "pipe" : options.stdin ?? "inherit", "pipe", "pipe"],
  })
  const error = result.error as NodeJS.ErrnoException | undefined
  if (error?.code === "ETIMEDOUT") throw new TimeoutExpired(command, options.timeoutSeconds ?? 0, result.stdout ?? "")
  if (error) throw error
  return { returncode: exitCode(result.status, result.signal), stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

export function runProcessAsync(command: string[], options: Pick<RunOptions, "timeoutSeconds" | "stdin"> = {}): Promise<RunResult> {
  const [program = "", ...args] = command
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { detached: true, stdio: [options.stdin ?? "inherit", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    const timer = options.timeoutSeconds === undefined ? undefined : setTimeout(() => {
      try {
        killProcessGroup(child.pid as number)
      } catch (error) {
        reject(error)
        return
      }
      child.stdout.destroy()
      child.stderr.destroy()
      reject(new TimeoutExpired(command, options.timeoutSeconds ?? 0, stdout))
    }, options.timeoutSeconds * 1000)
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("close", (status, signal) => {
      clearTimeout(timer)
      resolve({ returncode: exitCode(status, signal), stdout, stderr })
    })
  })
}

function killProcessGroup(leader: number): void {
  try {
    process.kill(-leader, "SIGKILL")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

function exitCode(status: number | null, signal: NodeJS.Signals | null): number {
  return status ?? -(os.constants.signals[signal as NodeJS.Signals] ?? 0)
}
