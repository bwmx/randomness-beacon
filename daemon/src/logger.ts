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

/** The ARC-65 error (`ERR:<code>[:<message>]`) a failed app call logged, as quoted in algod's error details. */
export const errorCode = (err: unknown) =>
  /"((?:ERR|AER):[^"]*)"/.exec(err instanceof Error ? err.message : String(err))?.[1]
