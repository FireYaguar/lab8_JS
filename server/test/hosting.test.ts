import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSeq } from 'shared/brand.ts'
import { encodeInput } from 'shared/net/binary.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { type App, createApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'

// Lab 8: поведінка процесу на хостингу. Кожен тест — свій сервер на випадковому порту.
let app: App | null = null
let dir = ''
afterEach(async () => {
  await app?.shutdown()
  app = null
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function start(env: Record<string, string> = {}): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'sf-host-'))
  app = createApp(
    loadConfig({
      PORT: '0',
      HOST: '127.0.0.1',
      LOG_DIR: join(dir, 'logs'),
      CLIENT_DIST: dir,
      LOG_LEVEL: 'silent',
      NODE_ENV: 'production',
      ...env,
    }),
  )
  return `127.0.0.1:${await app.listen()}`
}

// рукостискання: 'open' або HTTP-статус відмови
function handshake(
  base: string,
  headers: Record<string, string> = {},
): Promise<{ ws: WebSocket; status: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${base}/ws`, { headers })
    ws.once('open', () => resolve({ ws, status: 101 }))
    ws.once('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode ?? 0 }))
    ws.once('error', () => {})
  })
}

const joinRoom = (ws: WebSocket, room: string, name: string) =>
  ws.send(JSON.stringify({ v: 1, type: 'join', room, name }))
const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('хостинг: /health, /ready, /metrics', () => {
  it('/health показує версію і git SHA збірки; /ready = 200, поки приймаємо гравців', async () => {
    const base = await start({ GIT_SHA: 'abc1234', APP_VERSION: 'v1.0.0' })
    const health = await fetch(`http://${base}/health`).then((r) => r.json())
    expect(health).toMatchObject({ status: 'ok', sha: 'abc1234', version: 'v1.0.0' })
    expect((await fetch(`http://${base}/ready`)).status).toBe(200)
  })

  it('/metrics — формат Prometheus з гравцями, кімнатами, трафіком, кроком, циклом подій, пам’яттю', async () => {
    const base = await start()
    const { ws } = await handshake(base)
    joinRoom(ws, 'classic', 'm')
    await until(() => app?.rooms.playerCount === 1)
    const text = await fetch(`http://${base}/metrics`).then((r) => r.text())
    for (const name of [
      'players',
      'rooms',
      'messages_in_per_second',
      'bytes_out_per_second',
      'tick_ms_p99',
      'event_loop_utilization',
      'memory_rss_bytes',
    ])
      expect(text).toMatch(new RegExp(`^spacefight_${name} [0-9.e+-]+$`, 'm'))
    expect(text).toMatch(/^spacefight_players 1$/m)
    ws.close()
  })
})

describe('хостинг: рукостискання WebSocket', () => {
  it('Origin: свій хост і дозволений — пускаємо, чужий — 403', async () => {
    const base = await start({ ALLOWED_ORIGINS: 'https://spacefight.example' })
    const own = await handshake(base, { Origin: `http://${base}` })
    const allowed = await handshake(base, { Origin: 'https://spacefight.example' })
    const evil = await handshake(base, { Origin: 'https://evil.example' })
    expect([own.status, allowed.status, evil.status]).toEqual([101, 101, 403])
    own.ws.close()
    allowed.ws.close()
  })

  it('ліміт з’єднань з однієї IP (за проксі — з X-Forwarded-For)', async () => {
    const base = await start({ MAX_CONN_PER_IP: '2', TRUST_PROXY: '1' })
    const ip = { 'X-Forwarded-For': '203.0.113.7, 10.0.0.1' }
    const a = await handshake(base, ip)
    const b = await handshake(base, ip)
    const c = await handshake(base, ip)
    const other = await handshake(base, { 'X-Forwarded-For': '198.51.100.1' })
    expect([a.status, b.status, c.status, other.status]).toEqual([101, 101, 429, 101])
    a.ws.close()
    await until(() => (app?.hub.connections ?? 0) === 2) // місце звільнилось
    expect((await handshake(base, ip)).status).toBe(101)
  })
})

describe('хостинг: збої', () => {
  it('клієнт зник посеред матчу (TCP обірвано без close) — кімната прибирає гравця', async () => {
    const base = await start()
    const { ws } = await handshake(base)
    joinRoom(ws, 'classic', 'ghost')
    await until(() => app?.rooms.get('classic')?.match !== null && app?.rooms.playerCount === 1)
    ws.terminate() // без close-кадру, як вимкнений Wi-Fi
    await until(() => app?.rooms.playerCount === 0)
    expect(app?.rooms.get('classic')?.match).toBeNull() // порожня кімната зупинила матч
  })

  it('тисяча битих кадрів: нападника відключено, крок у сусідній кімнаті не зріс', async () => {
    const base = await start({ MAX_PLAYERS_PER_ROOM: '8' })
    // чесні гравці в belt
    const players = await Promise.all([1, 2].map(() => handshake(base)))
    players.forEach(({ ws }, i) => {
      joinRoom(ws, 'belt', `p${i}`)
      let seq = 0
      const t = setInterval(
        () =>
          ws.readyState === ws.OPEN &&
          ws.send(
            encodeInput({
              v: 1,
              type: 'input',
              seq: asSeq(++seq),
              thrust: true,
              turn: 1,
              fire: true,
            }),
          ),
        33,
      )
      ws.once('close', () => clearInterval(t))
    })
    await new Promise((r) => setTimeout(r, 600))
    const before = app?.rooms.get('belt')?.match?.stats().tickMs.p99 ?? 0

    // нападник: 1000 битих кадрів, перепідключається після кожного розриву
    let kicked = 0
    const garbage = new Uint8Array([0xff, 0x00, 0x13, 0x37])
    for (let sent = 0; sent < 1000; ) {
      const { ws, status } = await handshake(base)
      if (status !== 101) break
      const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)))
      while (ws.readyState === ws.OPEN && sent < 1000) {
        ws.send(garbage)
        sent++
        if (sent % 50 === 0) await new Promise((r) => setImmediate(r))
      }
      ws.close()
      if ((await closed) === 4400) kicked++
    }
    await new Promise((r) => setTimeout(r, 300))
    const after = app?.rooms.get('belt')?.match?.stats().tickMs.p99 ?? 0
    expect(kicked).toBeGreaterThan(0)
    expect(app?.metrics.kicked).toBeGreaterThan(0)
    expect(after).toBeLessThan(Math.max(5, before * 3)) // крок belt лишився мілісекундним
    for (const { ws } of players) ws.close()
  })

  it('SIGTERM-шлях: гравцю — shutdown і код 1001, /ready → 503 вже на початку, усе за < 3 с', async () => {
    const base = await start()
    const { ws } = await handshake(base)
    const got: string[] = []
    ws.on('message', (d, bin) => !bin && got.push(JSON.parse(String(d)).type))
    joinRoom(ws, 'classic', 'last')
    await until(() => got.includes('match'))
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)))
    const t0 = performance.now()
    const down = app?.shutdown()
    expect(app?.hub.accepting).toBe(false) // readiness уже «не готовий»
    expect(await closed).toBe(1001)
    await down
    app = null
    expect(got).toContain('shutdown')
    expect(performance.now() - t0).toBeLessThan(3000)
  })
})
