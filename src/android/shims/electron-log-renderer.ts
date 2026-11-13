/** Stand-in for `electron-log/renderer`: keeps the native console and a ring buffer. */
const original = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console)
}

export const logBuffer: string[] = []
const MAX_LINES = 2000

function record(level: string, args: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${level}] ${args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message
      if (typeof a === 'object') {
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      }
      return String(a)
    })
    .join(' ')}`
  logBuffer.push(line)
  if (logBuffer.length > MAX_LINES) logBuffer.splice(0, logBuffer.length - MAX_LINES)
}

const wrap =
  (level: keyof typeof original) =>
  (...args: unknown[]): void => {
    record(level, args)
    original[level](...args)
  }

const functions = {
  log: wrap('log'),
  info: wrap('info'),
  warn: wrap('warn'),
  error: wrap('error'),
  debug: wrap('debug')
}

const log = {
  functions,
  ...functions,
  errorHandler: {
    startCatching(): void {
      window.addEventListener('error', (e) => record('error', [e.message]))
      window.addEventListener('unhandledrejection', (e) => record('error', [String(e.reason)]))
    }
  }
}

export default log
