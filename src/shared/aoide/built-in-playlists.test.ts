import { describe, expect, it } from 'vitest';

import { BUILT_IN_PLAYLISTS } from './built-in-playlists';
import { ruleProblem } from './smart-rules';

/** Sorted-key JSON, the form the phone's test pins; the strings must be identical. */
const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
            ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
            : item,
    );

describe('built-in playlists', () => {
    it('carries exactly the rules the phone pins', () => {
        const byId = new Map(BUILT_IN_PLAYLISTS.map((p) => [p.id, canonical(p.rules)]));
        expect(byId.get('builtin:rediscover')).toBe(
            '{"limit":40,"match":"all","rules":[{"field":"last_played","op":"notInTheLast","value":"-6m"},{"field":"play_count","op":"greaterThan","value":2}],"sort":{"dir":"desc","field":"play_count"}}',
        );
        expect(byId.get('builtin:heavy-rotation')).toBe(
            '{"limit":25,"match":"all","rules":[{"field":"last_played","op":"inTheLast","value":"-1m"},{"field":"play_count","op":"greaterThan","value":1}],"sort":{"dir":"desc","field":"play_count"}}',
        );
    });

    it('uses only field/operator pairs this client can evaluate', () => {
        for (const playlist of BUILT_IN_PLAYLISTS) {
            for (const rule of playlist.rules.rules) {
                expect(ruleProblem(rule), `${playlist.id}: ${JSON.stringify(rule)}`).toBeNull();
            }
        }
    });

    it('has fixed, distinct ids under the builtin prefix', () => {
        const ids = BUILT_IN_PLAYLISTS.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.every((id) => id.startsWith('builtin:'))).toBe(true);
    });
});
