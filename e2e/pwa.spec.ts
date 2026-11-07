import { expect, test } from '@playwright/test'

// Lab 8: гру можна встановити — є маніфест з іконками і активний service worker з обробником fetch
test('PWA: маніфест, іконки, service worker', async ({ page, request }) => {
  await page.goto('/')
  const href = await page.locator('link[rel=manifest]').getAttribute('href')
  const manifest = await (await request.get(href ?? '')).json()
  expect(manifest).toMatchObject({
    short_name: 'Spacefight',
    display: 'fullscreen',
    start_url: '/',
  })
  for (const icon of manifest.icons) expect((await request.get(icon.src)).ok()).toBe(true)
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(['192x192', '512x512'])
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)
  expect(new URL(scope).pathname).toBe('/')
})
