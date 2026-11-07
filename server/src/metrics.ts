import { performance } from 'node:perf_hooks'
import type { RoomManager } from './rooms.ts'

// Lab 8: /metrics у текстовому форматі Prometheus. Лічильники ростуть у ws.ts, а швидкості
// (повідомлень/с, байт/с) і зайнятість циклу подій рахуються за останнє вікно WINDOW_MS.
const WINDOW_MS = 5000

interface Totals {
  messagesIn: number
  messagesOut: number
  bytesIn: number
  bytesOut: number
}

export class Metrics {
  readonly totals: Totals = { messagesIn: 0, messagesOut: 0, bytesIn: 0, bytesOut: 0 }
  connections = 0
  rejected = 0 // відхилені рукостискання (Origin, ліміт IP, вимкнення)
  kicked = 0 // відключені за битий кадр / rate limit
  #rates: Totals = { messagesIn: 0, messagesOut: 0, bytesIn: 0, bytesOut: 0 }
  #prev: Totals = { ...this.totals }
  #elu = performance.eventLoopUtilization()
  #loopUtil = 0
  readonly #timer = setInterval(() => this.#sample(), WINDOW_MS)

  constructor() {
    this.#timer.unref() // метрики не тримають процес живим
  }

  #sample(): void {
    const k = 1000 / WINDOW_MS
    for (const key of [
      'messagesIn',
      'messagesOut',
      'bytesIn',
      'bytesOut',
    ] satisfies (keyof Totals)[]) {
      this.#rates[key] = Math.round((this.totals[key] - this.#prev[key]) * k)
      this.#prev[key] = this.totals[key]
    }
    // частка часу, коли цикл подій чимось зайнятий (1 = 100 %, нових подій уже ніхто не обробляє вчасно)
    this.#loopUtil = performance.eventLoopUtilization(this.#elu).utilization
    this.#elu = performance.eventLoopUtilization()
  }

  stop(): void {
    clearInterval(this.#timer)
  }

  render(rooms: RoomManager): string {
    const matches = rooms.list().flatMap((r) => (r.match ? [r.match.stats()] : []))
    const tickP50 = Math.max(0, ...matches.map((m) => m.tickMs.p50))
    const tickP99 = Math.max(0, ...matches.map((m) => m.tickMs.p99))
    const mem = process.memoryUsage()
    const lines: [name: string, type: 'gauge' | 'counter', help: string, value: number][] = [
      ['spacefight_players', 'gauge', 'Гравців у кімнатах', rooms.playerCount],
      ['spacefight_rooms', 'gauge', 'Кімнат', rooms.size],
      ['spacefight_matches', 'gauge', 'Кімнат з активним матчем', matches.length],
      ['spacefight_connections', 'gauge', "Відкритих WebSocket-з'єднань", this.connections],
      [
        'spacefight_messages_in_per_second',
        'gauge',
        'Вхідних повідомлень/с (вікно 5 с)',
        this.#rates.messagesIn,
      ],
      [
        'spacefight_messages_out_per_second',
        'gauge',
        'Вихідних повідомлень/с (вікно 5 с)',
        this.#rates.messagesOut,
      ],
      [
        'spacefight_bytes_in_per_second',
        'gauge',
        'Вхідних байт/с (вікно 5 с)',
        this.#rates.bytesIn,
      ],
      [
        'spacefight_bytes_out_per_second',
        'gauge',
        'Вихідних байт/с (вікно 5 с)',
        this.#rates.bytesOut,
      ],
      [
        'spacefight_messages_in_total',
        'counter',
        'Вхідних повідомлень усього',
        this.totals.messagesIn,
      ],
      ['spacefight_bytes_out_total', 'counter', 'Вихідних байт усього', this.totals.bytesOut],
      ['spacefight_ws_rejected_total', 'counter', 'Відхилених рукостискань', this.rejected],
      [
        'spacefight_ws_kicked_total',
        'counter',
        'Відключених за битий кадр або rate limit',
        this.kicked,
      ],
      ['spacefight_tick_ms_p50', 'gauge', 'Час кроку матчу p50, мс (найгірша кімната)', tickP50],
      ['spacefight_tick_ms_p99', 'gauge', 'Час кроку матчу p99, мс (найгірша кімната)', tickP99],
      [
        'spacefight_event_loop_utilization',
        'gauge',
        'Зайнятість циклу подій 0..1 (вікно 5 с)',
        this.#loopUtil,
      ],
      ['spacefight_memory_rss_bytes', 'gauge', "Пам'ять процесу (RSS)", mem.rss],
      ['spacefight_memory_heap_used_bytes', 'gauge', 'Зайнята купа V8', mem.heapUsed],
    ]
    return `${lines.map(([n, t, h, v]) => `# HELP ${n} ${h}\n# TYPE ${n} ${t}\n${n} ${Number(v.toFixed(4))}`).join('\n')}\n`
  }
}
