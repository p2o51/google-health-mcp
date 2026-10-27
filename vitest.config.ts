import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          PUBLIC_BASE_URL: 'https://localhost:8787',
          ACCESS_TEAM_DOMAIN: '',
          ACCESS_AUD: '',
          LOCAL_DEV_IDENTITY: '1',
          DEBUG_TOOLS: '0',
          ENABLE_WRITES: '1',
          OWNER_EMAIL: 'owner@example.com',
          GOOGLE_CLIENT_ID: 'test-client',
          GOOGLE_CLIENT_SECRET: 'test-secret',
          GOOGLE_REFRESH_TOKEN: 'test-refresh',
          GOOGLE_TOKEN_URL: 'http://127.0.0.1:1/token',
          GOOGLE_API_BASE: 'http://127.0.0.1:1',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.oauth.test.ts'],
    maxWorkers: 1,
    testTimeout: 30_000,
  },
});
