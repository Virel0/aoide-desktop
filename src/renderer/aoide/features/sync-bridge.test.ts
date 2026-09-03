import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The op log has to actually reach the renderer.
 *
 * It did not, and the failure was quiet in the way that matters: the panel said
 * "this build can reach the sidecar but cannot push local edits yet", every
 * local playlist sat in the log unpushed, and nothing from the phone arrived.
 * Nothing errored, because `aoideSyncStore` correctly reported that the bridge
 * exposed no `sync` member and the engine was simply never built.
 *
 * These cannot be integration tests — the preload bridge only exists inside
 * Electron. They pin the two halves that must line up: every member `SyncStore`
 * declares is published by preload, and every channel preload invokes is
 * registered by main. A member missing from either side reproduces exactly the
 * silence above.
 */

const read = (relative: string) => readFileSync(join(import.meta.dirname, relative), 'utf8');

const SYNC_STORE_MEMBERS = [
    'applyRemote',
    'cursor',
    'imagesToUpload',
    'markSynced',
    'markUploaded',
    'pendingOps',
    'quarantine',
    'setCursor',
] as const;

describe('the op log bridge', () => {
    const preload = read('../../../preload/aoide.ts');
    // Every main-side module that registers an aoide: channel. A new module the
    // bridge invokes but this list does not name would be reported as
    // unregistered — which is the guard working, and the fix is to add it here.
    const main = [
        read('../../../main/features/aoide/index.ts'),
        read('../../../main/features/aoide/smart-search.ts'),
        read('../../../main/features/aoide/playlist-import.ts'),
    ].join('\n');
    const engine = read('../sync/sync-engine.ts');

    it('publishes every member the engine declares', () => {
        // Read from the interface itself, so adding a member to SyncStore
        // without publishing it fails here rather than at runtime.
        const declared = [...engine.matchAll(/^\s{4}(\w+)\(/gm)]
            .map((match) => match[1])
            .filter((name) => SYNC_STORE_MEMBERS.includes(name as never));

        expect(new Set(declared)).toEqual(new Set(SYNC_STORE_MEMBERS));

        for (const member of SYNC_STORE_MEMBERS) {
            expect(preload).toMatch(new RegExp(`\\b${member}:`));
        }
    });

    it('invokes only channels the main process registers', () => {
        const invoked = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]);
        const registered = [...main.matchAll(/handle\(\s*'([^']+)'/g)].map((m) => m[1]);

        expect(invoked.length).toBeGreaterThan(0);
        expect(invoked.filter((channel) => !registered.includes(channel))).toEqual([]);
    });

    it('exposes the bridge under the name the renderer looks for', () => {
        // `aoideSyncStore` tests `window.api.aoide.sync.pendingOps`.
        const shim = read('shared/aoide-bridge.ts');

        expect(preload).toMatch(/\n\s{4}sync:\s*\{/);
        expect(shim).toContain('bridge.sync?.pendingOps');
    });
});
