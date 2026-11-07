import type { Command, Turn } from 'shared/sim/types.ts'

// Клавіатура як замикання: стан клавіш приватний, назовні — лише функції.

export interface Input {
  isDown(code: string): boolean
  justPressed(code: string): boolean
  consume(): void // викликати після кожного кроку симуляції, щоб «щойно натиснуто» спрацювало рівно один раз
  dispose(): void
}

// Lab 8 (PWA на телефоні): екранні кнопки «натискають» ті самі коди клавіш — решта гри їх не розрізняє.
const TOUCH_KEYS: readonly [code: string, label: string, side: 'left' | 'right'][] = [
  ['KeyA', '◀', 'left'],
  ['KeyD', '▶', 'left'],
  ['KeyW', '▲', 'right'],
  ['Space', '●', 'right'],
]

function mountTouch(root: HTMLElement, down: Set<string>, pressed: Set<string>): HTMLElement {
  const pad = document.createElement('div')
  pad.className = 'touch-pad'
  pad.innerHTML = `<style>
    .touch-pad { position: fixed; inset: auto 0 16px 0; display: flex; justify-content: space-between; padding: 0 16px; pointer-events: none; user-select: none; touch-action: none }
    .touch-pad { z-index: 10; align-items: flex-end }
    .touch-pad div { display: flex; gap: 12px; pointer-events: auto }
    .touch-pad [data-side=left] { margin-bottom: 32vh } /* над панеллю чату */
    .touch-pad button { width: 64px; height: 64px; border-radius: 50%; border: 2px solid #9fd8ff88; background: #0a0d1acc; color: #9fd8ff; font-size: 24px }
  </style><div data-side="left"></div><div data-side="right"></div>`
  for (const [code, label, side] of TOUCH_KEYS) {
    const b = document.createElement('button')
    b.textContent = label
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      down.add(code)
      pressed.add(code)
    })
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave'])
      b.addEventListener(ev, () => down.delete(code))
    pad.querySelector(`[data-side=${side}]`)?.append(b)
  }
  root.append(pad)
  return pad
}

export function createInput(target: Window = window, touchRoot?: HTMLElement): Input {
  const down = new Set<string>()
  const pressed = new Set<string>() // натиснуті з моменту останнього consume()

  // текстові поля (чат, ім’я) — не керування кораблем
  const typing = (e: KeyboardEvent): boolean =>
    e.target instanceof Element && e.target.closest('input, textarea') !== null

  function onKeyDown(e: KeyboardEvent): void {
    if (e.repeat || typing(e)) return // ОС шле повторні keydown, поки клавіша затиснута
    down.add(e.code)
    pressed.add(e.code)
  }
  function onKeyUp(e: KeyboardEvent): void {
    down.delete(e.code)
  }
  function onBlur(): void {
    // вікно втратило фокус — keyup може не прийти, інакше корабель «залипне» з газом
    down.clear()
    pressed.clear()
  }

  target.addEventListener('keydown', onKeyDown)
  target.addEventListener('keyup', onKeyUp)
  target.addEventListener('blur', onBlur)
  // сенсорний екран без миші — показати кнопки
  const pad =
    touchRoot && target.matchMedia('(pointer: coarse)').matches
      ? mountTouch(touchRoot, down, pressed)
      : null

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressed.has(code),
    consume: () => pressed.clear(),
    dispose() {
      target.removeEventListener('keydown', onKeyDown)
      target.removeEventListener('keyup', onKeyUp)
      target.removeEventListener('blur', onBlur)
      pad?.remove()
    },
  }
}

// Клавіші → команда для симуляції. Сим бачить лише { thrust, turn, fire }, не знає про клавіатуру.
// TS знайшов: раніше turn рахувався як (right ? 1 : 0) - (left ? 1 : 0), тобто number — а протокол приймає лише −1 | 0 | 1.
export function readControls(input: Input): Command {
  const left = input.isDown('ArrowLeft') || input.isDown('KeyA')
  const right = input.isDown('ArrowRight') || input.isDown('KeyD')
  const turn: Turn = left === right ? 0 : right ? 1 : -1
  return {
    thrust: input.isDown('ArrowUp') || input.isDown('KeyW'),
    turn,
    fire: input.isDown('Space'), // затиснув — стріляє з кулдауном (Ship.fire)
  }
}
