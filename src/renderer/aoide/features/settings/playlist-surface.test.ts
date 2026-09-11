import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    AoidePlaylistSurfaceSchema,
    DEFAULT_AOIDE_PLAYLIST_SURFACE,
    showsAoidePlaylists,
    showsJellyfinPlaylists,
} from './playlist-surface';

const read = (relative: string) => readFileSync(join(import.meta.dirname, relative), 'utf8');

describe('the playlist surface preference', () => {
    // An install that exists today must look exactly as it did. The person
    // who wants only Aoide picks that themselves.
    it('defaults to both, so nobody sees a change they did not ask for', () => {
        expect(DEFAULT_AOIDE_PLAYLIST_SURFACE).toBe('both');
        expect(AoidePlaylistSurfaceSchema.parse(DEFAULT_AOIDE_PLAYLIST_SURFACE)).toBe('both');
    });

    it('offers exactly the three choices', () => {
        expect([...AoidePlaylistSurfaceSchema.options].sort()).toEqual([
            'aoide',
            'both',
            'jellyfin',
        ]);
    });

    it('shows both kinds under both', () => {
        expect(showsAoidePlaylists('both')).toBe(true);
        expect(showsJellyfinPlaylists('both')).toBe(true);
    });

    it('hides exactly the other kind under each single choice', () => {
        expect(showsAoidePlaylists('aoide')).toBe(true);
        expect(showsJellyfinPlaylists('aoide')).toBe(false);
        expect(showsAoidePlaylists('jellyfin')).toBe(false);
        expect(showsJellyfinPlaylists('jellyfin')).toBe(true);
    });
});

describe('the settings store carries the preference', () => {
    // The store cannot be imported here — it pulls in i18n and half the
    // renderer — so the wiring is read from its source. The default itself is
    // pinned above; this pins that the store uses that default and no other.
    const store = read('../../../store/settings.store.ts');

    it('validates it with the shared schema', () => {
        expect(store).toContain('aoidePlaylistSurface: AoidePlaylistSurfaceSchema,');
    });

    it('starts from the shared default rather than a literal of its own', () => {
        expect(store).toContain('aoidePlaylistSurface: DEFAULT_AOIDE_PLAYLIST_SURFACE,');
    });
});

describe('the sidebar honours the preference', () => {
    const sidebar = read('../../../features/sidebar/components/sidebar.tsx');

    it('gates the Aoide section', () => {
        expect(sidebar).toContain('{showAoidePlaylists && <AoideSidebarList />}');
    });

    // On top of Feishin's own toggle, never instead of it.
    // Feishin's own "show the playlist list in the sidebar" switch is gone —
    // the sidebar is where playlists live — so this preference is the only
    // thing left that can hide the Jellyfin section.
    it('gates the Jellyfin section', () => {
        expect(sidebar).toContain('{showJellyfinPlaylists && <SidebarPlaylistSection />}');
    });

    it('drops the Playlists library entry, but never the route', () => {
        expect(sidebar).toContain('(showJellyfinPlaylists || item.route !== AppRoute.PLAYLISTS)');

        const router = read('../../../router/app-router.tsx');
        expect(router).toMatch(
            /element=\{<PlaylistListRoute \/>\}\s*\n\s*path=\{AppRoute\.PLAYLISTS\}/,
        );
    });

    it('is settable from the general settings tab', () => {
        const generalTab = read('../../../features/settings/components/general/general-tab.tsx');
        expect(generalTab).toContain('PlaylistSurfaceSettings');
    });
});
