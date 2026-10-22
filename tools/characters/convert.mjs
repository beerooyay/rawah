import { chromium } from 'playwright-core';
import fs from 'fs';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('console', (m) => console.log('page:', m.text().slice(0, 200)));
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 300)));
await page.goto('http://localhost:5190/conv.html');
await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
for (const n of process.argv.slice(2)) {
  const r = await page.evaluate((n) => window.convert(n), n);
  console.log(n, r.info.join('\n  '));
  fs.writeFileSync(`/tmp/conv/${n}_out.glb`, Buffer.from(r.b64, 'base64'));
}
await browser.close();
