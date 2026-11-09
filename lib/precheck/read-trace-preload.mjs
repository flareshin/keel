import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const READ_LOG_ENV = 'PRECHECK_READ_LOG'
const READING_FUNCTIONS = ['readFileSync', 'readFile', 'openSync', 'open', 'createReadStream', 'copyFileSync', 'copyFile', 'cpSync', 'cp']
const READING_PROMISE_FUNCTIONS = ['readFile', 'open', 'copyFile', 'cp']
const LOADER_OR_FS_FRAME = /(?:\(|at )node:(?:internal\/modules|internal\/fs|fs)\b/u
const INSTALLED = Symbol.for('keel.precheck.readTrace')
const CALLER_STACK_LINE = 4

const logFile = process.env[READ_LOG_ENV]
if (logFile && !globalThis[INSTALLED]) {
  globalThis[INSTALLED] = true
  traceReads(logFile)
}

function traceReads(log) {
  const { appendFileSync, realpathSync } = fs
  const logged = new Set()
  const logRead = (target) => {
    const path = absolutePath(target, realpathSync)
    if (path === null || logged.has(path) || calledByLoaderOrFs()) return
    logged.add(path)
    appendFileSync(log, path + '\n')
  }
  for (const name of READING_FUNCTIONS) wrap(fs, name, logRead)
  for (const name of READING_PROMISE_FUNCTIONS) wrap(fs.promises, name, logRead)
  syncBuiltinESMExports()
}

function wrap(owner, name, logRead) {
  const original = owner[name]
  owner[name] = {
    [name](target, ...rest) {
      logRead(target)
      return Reflect.apply(original, this, [target, ...rest])
    },
  }[name]
}

function absolutePath(target, realpathSync) {
  const path = pathText(target)
  if (path === null) return null
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

function pathText(target) {
  if (typeof target === 'string') return target
  if (target instanceof URL) return target.protocol === 'file:' ? fileURLToPath(target) : null
  if (Buffer.isBuffer(target)) return target.toString()
  return null
}

function calledByLoaderOrFs() {
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = CALLER_STACK_LINE
  const { stack } = new Error()
  Error.stackTraceLimit = limit
  const caller = String(stack).split('\n')[CALLER_STACK_LINE] ?? ''
  return LOADER_OR_FS_FRAME.test(caller)
}
