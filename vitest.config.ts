import { defineConfig } from 'vitest/config';

// Unit tests cover the pure parts of the Worker (unit scaling, vendor payload
// normalisation, plant filtering). Anything that needs the Workers runtime
// (D1, crypto.subtle MD5) is exercised by the probe scripts and e2e instead.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    reporters: 'default',
  },
});
