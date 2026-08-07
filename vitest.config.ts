import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

// Only the Aoide code is under test. Feishin ships no tests, and pulling its
// renderer under a test runner would mean standing up jsdom, Electron's preload
// bridge and i18n for code that is not ours to verify. The sync client is
// deliberately written to need none of that.
export default defineConfig({
    resolve: {
        alias: {
            '/@/renderer': resolve('src/renderer'),
            '/@/shared': resolve('src/shared'),
        },
    },
    test: {
        environment: 'node',
        include: ['src/renderer/aoide/**/*.test.ts'],
    },
});
