import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The OpenRouter key must not be reachable from the renderer.
 *
 * A renderer runs third-party-ish code — Feishin's own dependencies, a custom
 * theme's CSS, anything an extension injects — and an API key that is merely
 * *inconvenient* to read from there is a key that leaks. Keeping it in the main
 * process and answering only "is one set?" is the whole protection, so it is
 * worth a test that fails when somebody adds the convenient getter.
 *
 * These read source rather than run it: the boundary is a build-time property of
 * which module holds what, and `safeStorage` needs a real Electron process.
 */

const main = readFileSync(join(import.meta.dirname, 'smart-search.ts'), 'utf8');
const preload = readFileSync(join(import.meta.dirname, '../../../preload/aoide.ts'), 'utf8');

describe('the OpenRouter key stays in the main process', () => {
    it('is never published through the preload bridge', () => {
        // `isConfigured` is a boolean and is fine. A channel that returns the
        // key itself is not.
        expect(preload).not.toMatch(/smart-search-(get-)?key\b(?!.*set)/);
        expect(preload).toContain('smart-search-configured');
    });

    it('has no handler that returns it', () => {
        const handlers = [...main.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]);

        expect(handlers).toContain('aoide:smart-search-configured');
        expect(handlers).not.toContain('aoide:smart-search-get-key');
        // Every handler is either a setter, the boolean, the model, or the
        // translation — none of them hand back a secret.
        expect(new Set(handlers)).toEqual(
            new Set([
                'aoide:smart-search-configured',
                'aoide:smart-search-model',
                'aoide:smart-search-set-key',
                'aoide:smart-search-set-model',
                'aoide:smart-search-translate',
            ]),
        );
    });

    it('answers whether a key exists with a boolean, not with the key', () => {
        expect(main).toMatch(/smart-search-configured',\s*\(\)\s*=>\s*readKey\(\)\s*!==\s*null/);
    });

    it('refuses to store a key when it cannot be encrypted', () => {
        // Writing it in plain text would be worse than not supporting the
        // feature: a key in a config file outlives the session that made it.
        expect(main).toContain('Refusing to store an OpenRouter key without encryption');
        expect(main).toContain('safeStorage.encryptString');
    });

    it('keeps the service’s own words on a refusal', () => {
        // OpenRouter says useful things here — out of credit, unknown model,
        // invalid key — and a generic "search failed" throws away the only thing
        // that tells somebody what to do.
        expect(main).toMatch(/OpenRouter returned HTTP \$\{response\.status\}/);
    });
});
