import pino from 'pino'

/** Pretty on a terminal; JSON lines under systemd/launchd (pipe through `npx pino-pretty` to read them). */
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.stdout.isTTY
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' } }
    : undefined,
})

export default logger

/** Short form for error logs; algokit errors carry whole transaction dumps, kept for debug level. */
export const describe = (err: unknown) => (err instanceof Error ? err.message.split('\n')[0] : String(err))

/**
 * An error's message and its cause's. When an inner app call fails, algokit may report an unrelated message from the
 * outer app's source map (it matches only the pc) and keep the original error as the cause.
 */
const errorText = (err: unknown) =>
  err instanceof Error ? `${err.message} ${(err as { cause?: unknown }).cause}` : String(err)

/** Group index of the transaction whose simulation failed, from algokit's message (or the error wrapping it). */
export const failedIndex = (err: unknown) => {
  const index = /simulate in transaction (\d+)/.exec(errorText(err))
  return index ? Number(index[1]) : undefined
}

/** The ARC-65 error (`ERR:<code>[:<message>]`) a failed app call logged, as quoted in algod's error details. */
export const errorCode = (err: unknown) => /"((?:ERR|AER):[^"]*)"/.exec(errorText(err))?.[1]
