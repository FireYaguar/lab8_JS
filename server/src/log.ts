import { pino } from 'pino'
import type { LogLevel } from './config.ts'

// Lab 8: логи — рядки JSON через pino (stdout; хостинг сам збирає stdout контейнера).
// Синхронний запис: після SIGTERM чи фатальної помилки останні рядки не загубляться в буфері.
// redact — паролі, ключі й токени в лог не потрапляють, навіть якщо їх випадково передали в полях.
export const logger = pino(
  {
    level: 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { pid: process.pid },
    formatters: { level: (label) => ({ level: label }) }, // "level":"info", а не 30
    redact: {
      paths: [
        'password',
        'token',
        'key',
        'secret',
        'authorization',
        'cookie',
        '*.password',
        '*.token',
        '*.key',
        '*.secret',
        '*.authorization',
        '*.cookie',
      ],
      censor: '[redacted]',
    },
  },
  pino.destination({ dest: 1, sync: true }),
)

export function setLogLevel(level: LogLevel): void {
  logger.level = level
}

// Той самий виклик, що й з Lab 4: log('info', 'player.joined', { room, player }) → {"level":30,"event":…}
export function log(
  level: Exclude<LogLevel, 'silent'> | 'fatal',
  event: string,
  fields: Record<string, unknown> = {},
): void {
  logger[level]({ event, ...fields }, event)
}

// catch (err: unknown): з unknown не можна просто взяти .message — спершу звузити
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
