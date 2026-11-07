import { createServer, type Server } from 'node:http'
import type { ServerConfig } from './config.ts'
import { createHttpHandler, type Readiness } from './http.ts'
import { log, setLogLevel } from './log.ts'
import { Metrics } from './metrics.ts'
import { RoomManager } from './rooms.ts'
import { attachWebSocket, type WebSocketHub } from './ws.ts'

export interface App {
  readonly server: Server
  readonly rooms: RoomManager
  readonly hub: WebSocketHub
  readonly metrics: Metrics
  listen(): Promise<number>
  shutdown(): Promise<void>
}

// Збирає сервер з частин. Окремо від index.ts, щоб тести могли підняти його на випадковому порту.
export function createApp(config: ServerConfig): App {
  setLogLevel(config.logLevel)
  const rooms = new RoomManager(config)
  rooms.createDefaults()
  const metrics = new Metrics()
  let hub: WebSocketHub | null = null
  // /ready: процес приймає гравців — не вимикається і в кімнатах ще є місця
  const readiness = (): Readiness => {
    if (!hub?.accepting) return { ready: false, reason: 'shutting down' }
    if (rooms.playerCount >= config.maxRooms * config.maxPlayersPerRoom)
      return { ready: false, reason: 'full' }
    return { ready: true, reason: 'ok' }
  }
  const server = createServer(createHttpHandler({ config, rooms, metrics, readiness }))
  server.on('clientError', (err, socket) => socket.destroy(err)) // кривий HTTP від клієнта ≠ падіння
  hub = attachWebSocket(server, { config, rooms, metrics })
  const ws = hub

  return {
    server,
    rooms,
    hub: ws,
    metrics,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject) // EADDRINUSE тощо
        server.listen(config.port, config.host, () => {
          const address = server.address()
          // address() — string | AddressInfo | null; для TCP-сервера це AddressInfo, але TS цього не знає
          const port = typeof address === 'object' && address !== null ? address.port : config.port
          log('info', 'server.listening', { host: config.host, port })
          resolve(port)
        })
      })
    },
    // Порядок: перестати приймати → попередити й закрити сокети → дописати логи матчів.
    async shutdown() {
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeIdleConnections()
      await ws.close()
      await rooms.closeAll()
      metrics.stop()
      server.closeAllConnections()
      await stopped
    },
  }
}
