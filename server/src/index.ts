import { createApp } from './app.ts'
import { loadConfig, type ServerConfig } from './config.ts'
import { log } from './log.ts'

let config: ServerConfig
try {
  config = loadConfig(process.env)
} catch (err: unknown) {
  log('fatal', 'config.invalid', { err: err instanceof Error ? err.message : String(err) })
  process.exit(1)
}

// Lab 8: необроблена помилка — у лог і вихід з кодом 1. Порожній обробник «глушив» би її, а процес
// жив би далі в невідомому стані (напівзакриті кімнати, зламані таймери). Хостинг перезапустить контейнер.
function fatal(kind: string, err: unknown): never {
  log('fatal', kind, {
    err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
  })
  process.exit(1)
}
process.on('uncaughtException', (err) => fatal('process.uncaught_exception', err))
process.on('unhandledRejection', (reason) => fatal('process.unhandled_rejection', reason))

const app = createApp(config)
await app.listen()

let shuttingDown = false
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log('info', 'server.shutdown', {
    signal,
    connections: app.hub.connections,
    players: app.rooms.playerCount,
  })
  // якщо щось зависло — не чекаємо вічно (supervisor однаково вб’є через ~10 с)
  setTimeout(() => {
    log('error', 'server.shutdown.timeout')
    process.exit(1)
  }, 8000).unref()
  await app.shutdown()
  log('info', 'server.stopped', { code: 0 })
  process.exit(0)
}
// no-floating-promises: обробник сигналу не може бути async — помилку shutdown логуємо явно
const onSignal = (signal: NodeJS.Signals): void => {
  shutdown(signal).catch((err: unknown) => {
    log('error', 'server.shutdown.failed', { err: String(err) })
    process.exit(1)
  })
}
process.on('SIGINT', onSignal)
process.on('SIGTERM', onSignal)
