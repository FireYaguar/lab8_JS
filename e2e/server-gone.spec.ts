import { expect, test } from '@playwright/test'
import { startServer } from '../server/scripts/_server.ts'

// Lab 8: сервер зник посеред матчу — гравець сам повертається в лобі.
// Окремий процес сервера на своєму порту (спільний з playwright.config.ts вбивати не можна).
for (const [signal, port, note] of [
  ['SIGTERM', 3121, 'Сервер перезапускається'], // деплой: сервер попереджає (shutdown + 1001)
  ['SIGKILL', 3122, 'Зв’язок із сервером втрачено'], // падіння: лише обрив, після кількох реконектів
] as const) {
  test(`${signal}: гравець повертається в лобі`, async ({ page }) => {
    test.setTimeout(40_000)
    const server = await startServer(port, { NODE_ENV: 'production' })
    try {
      await page.goto(`${server.base}/?room=classic&name=Kim`)
      await page.waitForFunction(() => window.__net !== undefined)
      server.child.kill(signal)
      await expect(page.locator('.lobby')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('.lobby')).toContainText(note)
      expect(await page.evaluate(() => window.__net)).toBeUndefined()
    } finally {
      if (server.child.exitCode === null && server.child.signalCode === null) await server.stop()
    }
  })
}
