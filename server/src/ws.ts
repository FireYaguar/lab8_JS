import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { type Codec, codecs, SnapshotEncoder } from 'shared/net/codec.ts'
import type { ClientMessage, ServerMessage } from 'shared/net/protocol.ts'
import { assertNever } from 'shared/sim/types.ts'
import { type WebSocket, WebSocketServer } from 'ws'
import type { ServerConfig } from './config.ts'
import { log } from './log.ts'
import type { Metrics } from './metrics.ts'
import { byteLength, CLOSE, type CloseCode, parseClientMessage } from './protocol.ts'
import { createTokenBucket, type TokenBucket } from './ratelimit.ts'
import type { Room, RoomManager } from './rooms.ts'
import type { Player, SendOptions } from './types.ts'

// Життєвий цикл WebSocket-з’єднання: join за 5 с, перевірка кожного повідомлення, rate limit,
// heartbeat (ping раз на 15 с, два пропущені pong → розрив), політика повільного клієнта.
// Lab 5: input → черга Match; знімки — кодеком клієнта; у розробці — штучна затримка/розкид/втрата.

let nextPlayerId = 1

interface Netsim {
  lag: number
  jitter: number
  drop: number
}

interface ConnState {
  readonly codec: Codec
  netsim: Netsim
  readonly bucket: TokenBucket
  readonly inputBucket: TokenBucket
  // гравець і кімната з’являються РАЗОМ після join — один nullable-об’єкт, а не два окремі поля
  // (TS змусив: з двома полями state.room міг бути не null, а state.player — null)
  joined: { player: Player; room: Room } | null
  missedPongs: number
  dropped: number
}

const snapshots = new SnapshotEncoder() // Lab 7: один encode на тік кімнати, не на клієнта
export interface WebSocketHub {
  readonly connections: number
  readonly accepting: boolean
  close(graceMs?: number): Promise<void>
}

export function attachWebSocket(
  server: Server,
  { config, rooms, metrics }: { config: ServerConfig; rooms: RoomManager; metrics: Metrics },
): WebSocketHub {
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayloadBytes })
  const conns = new Map<WebSocket, ConnState>()
  const perIp = new Map<string, number>()
  let closing = false

  // Lab 8: за проксі хостингу remoteAddress — адреса проксі; справжня — перша в X-Forwarded-For
  function clientIp(req: IncomingMessage): string {
    const fwd = req.headers['x-forwarded-for']
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim()
    return (config.trustProxy && first) || req.socket.remoteAddress || 'unknown'
  }

  // Origin: браузер завжди шле його в рукостисканні. Чужа сторінка не має відкривати сокет від імені
  // гравця (cross-site WebSocket hijacking). Свій хост дозволений завжди, решта — ALLOWED_ORIGINS.
  // Без Origin приходять лише не-браузерні клієнти (боти навантаження, тести) — їх пускаємо.
  function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin
    if (origin === undefined) return true
    const host = req.headers['x-forwarded-host'] ?? req.headers.host
    try {
      if (new URL(origin).host === host) return true
    } catch {
      return false
    }
    return config.allowedOrigins.includes(origin)
  }

  function refuse(
    socket: Duplex,
    status: string,
    reason: string,
    fields: Record<string, unknown>,
  ): void {
    metrics.rejected += 1
    log('warn', 'ws.handshake.rejected', { reason, ...fields })
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost')
    if (pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      return
    }
    const ip = clientIp(req)
    if (closing) return refuse(socket, '503 Service Unavailable', 'shutting down', { ip })
    if (!originAllowed(req))
      return refuse(socket, '403 Forbidden', 'origin not allowed', {
        ip,
        origin: req.headers.origin,
      })
    const n = perIp.get(ip) ?? 0
    if (n >= config.maxConnPerIp)
      return refuse(socket, '429 Too Many Requests', 'too many connections from ip', { ip, n })
    perIp.set(ip, n + 1)
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.once('close', () => {
        const left = (perIp.get(ip) ?? 1) - 1
        if (left > 0) perIp.set(ip, left)
        else perIp.delete(ip)
      })
      onConnection(ws, req)
    })
  })
  wss.on('error', (err) => log('error', 'wss.error', { err: err.message }))

  function closeWith(ws: WebSocket, code: CloseCode, reason: string): void {
    const joined = conns.get(ws)?.joined
    if (code !== CLOSE.normal) metrics.kicked += 1
    log('warn', 'ws.rejected', { code, reason, room: joined?.room.id, player: joined?.player.id })
    ws.close(code, reason)
  }

  // Повільний клієнт: bufferedAmount — скільки байт ще не пішло в мережу для цього сокета.
  function send(
    ws: WebSocket,
    state: ConnState,
    data: string | ArrayBuffer,
    { critical = true }: SendOptions = {},
  ): void {
    if (ws.readyState !== ws.OPEN) return
    if (ws.bufferedAmount > config.hardBufferBytes) {
      log('warn', 'ws.slow_client.terminated', {
        player: state.joined?.player.id,
        buffered: ws.bufferedAmount,
      })
      ws.terminate()
      return
    }
    if (!critical && ws.bufferedAmount > config.softBufferBytes) {
      state.dropped += 1 // некритичне почекає — роздувати чергу в пам’яті сервера не будемо
      return
    }
    metrics.totals.messagesOut += 1
    metrics.totals.bytesOut += typeof data === 'string' ? data.length : data.byteLength
    ws.send(data)
  }

  function onConnection(ws: WebSocket, req: IncomingMessage): void {
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams
    const num = (k: string, max: number): number =>
      Math.min(max, Math.max(0, Number(query.get(k)) || 0))
    const state: ConnState = {
      codec: query.get('codec') === 'json' ? codecs.json : codecs.binary,
      // штучна мережа лише в розробці; у production завжди нулі
      netsim: config.debugRoutes
        ? { lag: num('lag', 1000), jitter: num('jitter', 500), drop: num('drop', 0.5) }
        : { lag: 0, jitter: 0, drop: 0 },
      bucket: createTokenBucket({ rate: config.rateLimitPerSec, burst: config.rateLimitBurst }),
      inputBucket: createTokenBucket({ rate: 45, burst: 45 }), // 30 input/с + запас на розкид
      joined: null,
      missedPongs: 0,
      dropped: 0,
    }
    conns.set(ws, state)
    metrics.connections = conns.size
    log('debug', 'ws.connected', { ip: clientIp(req) })

    // 'error' без слухача = виняток = падіння ВСЬОГО сервера, тому слухач на кожному сокеті
    ws.on('error', (err) => log('warn', 'ws.error', { err: err.message }))
    ws.on('pong', () => {
      state.missedPongs = 0
    })

    const joinTimer = setTimeout(
      () => closeWith(ws, CLOSE.joinTimeout, 'join timeout'),
      config.joinTimeoutMs,
    )

    // Штучна мережа: кожен напрямок отримує lag/2 ± jitter/2 (разом RTT ≈ lag); розкид може переставити порядок.
    const later = (fn: () => void): void => {
      const { lag, jitter } = state.netsim
      if (lag === 0 && jitter === 0) {
        fn()
        return
      }
      setTimeout(fn, Math.max(0, lag / 2 + (Math.random() * 2 - 1) * (jitter / 2)))
    }
    const lost = (): boolean => state.netsim.drop > 0 && Math.random() < state.netsim.drop
    const reply = (msg: ServerMessage): void => send(ws, state, JSON.stringify(msg))

    function join(msg: Extract<ClientMessage, { type: 'join' }>): void {
      if (state.joined) {
        closeWith(ws, CLOSE.badMessage, 'already joined')
        return
      }
      const room = rooms.get(msg.room)
      if (!room) {
        closeWith(ws, CLOSE.roomNotFound, 'room not found')
        return
      }
      if (room.size >= room.maxPlayers) {
        closeWith(ws, CLOSE.roomFull, 'room is full')
        return
      }
      clearTimeout(joinTimer)
      const player: Player = {
        id: `p${nextPlayerId++}`,
        name: msg.name,
        shipId: null,
        send: (message, options) => send(ws, state, JSON.stringify(message), options),
        sendRaw: (data, options) => send(ws, state, data, options),
        // знімок некритичний: повільному клієнту його можна пропустити, наступний однаково прийде
        sendSnapshot: (base, ack) => {
          if (lost()) return
          const data =
            config.snapshotEncode === 'shared'
              ? snapshots.encode(state.codec, base, ack)
              : state.codec.encodeSnapshot({ ...base, ack })
          later(() => send(ws, state, data, { critical: false }))
        },
      }
      state.joined = { player, room }
      reply({ type: 'welcome', playerId: player.id, room: room.toJSON() })
      room.join(player)
      log('info', 'player.joined', { room: room.id, player: player.id })
    }

    ws.on('message', (data, isBinary) => {
      if (ws.readyState !== ws.OPEN) return // уже закриваємо — хвіст повідомлень ігноруємо
      metrics.totals.messagesIn += 1
      metrics.totals.bytesIn += byteLength(data)
      const parsed = parseClientMessage(data, isBinary, config.maxPayloadBytes)
      const bucket = parsed.ok && parsed.msg.type === 'input' ? state.inputBucket : state.bucket
      if (!bucket.take()) {
        closeWith(ws, CLOSE.rateLimited, 'rate limit exceeded')
        return
      }
      if (!parsed.ok) return closeWith(ws, parsed.code, parsed.reason) // битий JSON / форма → лог + закриття
      const { msg } = parsed
      const joined = state.joined

      switch (msg.type) {
        case 'join':
          return join(msg)
        case 'input':
          if (!joined) {
            closeWith(ws, CLOSE.badMessage, 'join first')
            return
          }
          if (lost()) return // «втрачений пакет»: сервер цього input не побачить
          return later(() => joined.room.match?.pushInput(joined.player.id, msg))
        case 'chat':
          if (!joined) {
            closeWith(ws, CLOSE.badMessage, 'join first')
            return
          }
          return joined.room.chat(joined.player.id, msg.text)
        case 'ping':
          return later(() => later(() => reply({ type: 'pong', t: msg.t })))
        case 'netsim':
          if (config.debugRoutes)
            state.netsim = { lag: msg.lag, jitter: msg.jitter, drop: msg.drop }
          return
        case 'leave':
          return ws.close(CLOSE.normal, 'bye')
        default:
          return assertNever(msg) // новий тип у схемі без обробника → помилка tsc
      }
    })

    ws.on('close', (code) => {
      clearTimeout(joinTimer)
      if (state.joined) {
        const { room, player } = state.joined
        room.leave(player.id, code === CLOSE.normal ? 'leave' : 'disconnect')
        log('info', 'player.left', { room: room.id, player: player.id, code })
      }
      conns.delete(ws)
      metrics.connections = conns.size
    })
  }

  // Heartbeat: мертвий TCP (вимкнений Wi-Fi, NAT забув з’єднання) сам 'close' не надішле.
  const heartbeat = setInterval(() => {
    for (const [ws, state] of conns) {
      if (state.missedPongs >= 2) {
        log('warn', 'ws.heartbeat.timeout', { player: state.joined?.player.id })
        ws.terminate()
        continue
      }
      state.missedPongs += 1
      ws.ping()
    }
  }, config.heartbeatMs)

  return {
    get connections() {
      return conns.size
    },
    get accepting() {
      return !closing
    },
    // Graceful: попередити клієнтів (shutdown + 1001), дочекатися закриття, решту — terminate.
    async close(graceMs = 2000) {
      closing = true
      clearInterval(heartbeat)
      const closed = [...conns.keys()].map(
        (ws) =>
          new Promise<void>((resolve) => {
            ws.once('close', () => resolve())
            if (ws.readyState === ws.OPEN)
              ws.send(JSON.stringify({ type: 'shutdown' } satisfies ServerMessage))
            ws.close(CLOSE.goingAway, 'server shutdown')
          }),
      )
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref())
      await Promise.race([Promise.all(closed), timeout])
      for (const ws of conns.keys()) ws.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}
