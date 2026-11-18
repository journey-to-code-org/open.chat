// The components' tests run in a real browser (Vitest browser mode, Chromium), each through plain
// HTML, React and Vue, the way apps on each would use them. CHROMIUM=<path> uses a Chromium of
// your own instead of Playwright's download.
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import zubra from '@zubra/unplugin/vite';

export default defineConfig({
  plugins: [zubra()],
  // Found up front, so Vite doesn't reload the page halfway through with a second copy of the
  // runtime (the test helper imports React and Vue only once it's asked for them).
  optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'vue', '@zubra/runtime', '@zubra/runtime/testing', '@zubra/runtime/motion', '@zubra/runtime/react', '@zubra/runtime/vue', '@zubra/sync'] },
  test: {
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] } : {} }),
      instances: [{ browser: 'chromium' }],
    },
  },
});
