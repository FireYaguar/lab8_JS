import { resolve } from 'node:path'
import { z } from 'zod'

// Конфіг лише з оточення (process.env), перевірка схемою Zod ОДИН раз на старті:
// краще впасти зараз із зрозумілим повідомленням, ніж о 3-й ночі з undefined.

const SERVER_ROOT = resolve(import.meta.dirname, '..') // у ESM немає __dirname

// '' в оточенні = «не задано» → значення за замовчуванням
const blank = (v: unknown): unknown => (v === '' ? undefined : v)
const int = (min: number, max: number, def: number) =>
  z.preprocess(blank, z.coerce.number().int().min(min).max(max).default(def))
const str = (def: string) => z.preprocess(blank, z.string().default(def))
const bool = (def: boolean) =>
  z
    .preprocess(blank, z.enum(['0', '1', 'true', 'false']).default(def ? '1' : '0'))
    .transform((v) => v === '1' || v === 'true')
// "https://a.com, http://localhost:5173" → ['https://a.com', 'http://localhost:5173']; кожен — валідний origin
const origins = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : v,
  z.array(z.url().transform((u) => new URL(u).origin)).default([]),
)

const Env = z.object({
  PORT: int(0, 65535, 3000), // 0 — випадковий вільний порт (тести)
  HOST: str('0.0.0.0'),
  LOG_DIR: str('logs'),
  CLIENT_DIST: str('../client/dist'),
  LOG_LEVEL: z.preprocess(
    blank,
    z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  ),
  // Lab 8: хостинг. Дозволені Origin для WebSocket (свій хост дозволений завжди), ліміт з'єднань з IP,
  // довіра до X-Forwarded-For (за проксі хостингу remoteAddress — це проксі), версія збірки для /health.
  ALLOWED_ORIGINS: origins,
  MAX_CONN_PER_IP: int(1, 1000, 8),
  TRUST_PROXY: bool(false),
  GIT_SHA: str('dev'),
  APP_VERSION: str('dev'),
  MAX_ROOMS: int(1, 1000, 20),
  MAX_PLAYERS_PER_ROOM: int(2, 512, 4),
  JOIN_TIMEOUT_MS: int(50, 60_000, 5000),
  HEARTBEAT_MS: int(50, 120_000, 15_000),
  RATE_LIMIT_PER_SEC: int(1, 1000, 10),
  RATE_LIMIT_BURST: int(1, 1000, 20),
  // Lab 7: «до» для заміру навантаження — кодувати знімок окремо для кожного клієнта
  SNAPSHOT_ENCODE: z.enum(['shared', 'per-client']).default('shared'),
  NODE_ENV: z.string().optional(),
})

export type LogLevel = z.infer<typeof Env>['LOG_LEVEL']

export interface ServerConfig {
  readonly port: number
  readonly host: string
  readonly logDir: string
  readonly clientDist: string
  readonly logLevel: LogLevel
  readonly allowedOrigins: readonly string[]
  readonly maxConnPerIp: number
  readonly trustProxy: boolean
  readonly gitSha: string
  readonly version: string
  readonly maxRooms: number
  readonly maxPlayersPerRoom: number
  readonly joinTimeoutMs: number
  readonly heartbeatMs: number
  readonly rateLimitPerSec: number
  readonly rateLimitBurst: number
  readonly maxPayloadBytes: number
  readonly maxBodyBytes: number
  readonly softBufferBytes: number // вище — не шлемо клієнту некритичне (чат, знімки)
  readonly hardBufferBytes: number // вище — клієнт безнадійно відстав, розриваємо
  readonly snapshotEncode: 'shared' | 'per-client'
  readonly debugRoutes: boolean // /api/debug/* і штучна мережа — лише в розробці
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const parsed = Env.safeParse(env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    throw new Error(`Невалідний конфіг:\n  ${lines.join('\n  ')}`)
  }
  const e = parsed.data
  return Object.freeze({
    port: e.PORT,
    host: e.HOST,
    logDir: resolve(SERVER_ROOT, e.LOG_DIR),
    clientDist: resolve(SERVER_ROOT, e.CLIENT_DIST),
    logLevel: e.LOG_LEVEL,
    // у розробці клієнт живе на Vite (:5173) і ходить на :3000 через проксі
    allowedOrigins:
      e.NODE_ENV === 'production'
        ? e.ALLOWED_ORIGINS
        : [...e.ALLOWED_ORIGINS, 'http://localhost:5173', 'http://127.0.0.1:5173'],
    maxConnPerIp: e.MAX_CONN_PER_IP,
    trustProxy: e.TRUST_PROXY,
    gitSha: e.GIT_SHA,
    version: e.APP_VERSION,
    maxRooms: e.MAX_ROOMS,
    maxPlayersPerRoom: e.MAX_PLAYERS_PER_ROOM,
    joinTimeoutMs: e.JOIN_TIMEOUT_MS,
    heartbeatMs: e.HEARTBEAT_MS,
    rateLimitPerSec: e.RATE_LIMIT_PER_SEC,
    rateLimitBurst: e.RATE_LIMIT_BURST,
    maxPayloadBytes: 4096,
    maxBodyBytes: 4096,
    softBufferBytes: 64 * 1024,
    hardBufferBytes: 1024 * 1024,
    snapshotEncode: e.SNAPSHOT_ENCODE,
    debugRoutes: e.NODE_ENV !== 'production',
  })
}
