import type { SmartRule, SmartRules } from '/@/shared/aoide/smart-rules';

import { CurationDatabase } from './database';

import { countsAsPlaySql, countsAsSkipSql } from '/@/shared/aoide/play-definition';

interface TrackStats {
    firstPlayed: null | number;
    lastPlayed: null | number;
    playCount: number;
    skipCount: number;
}

/**
 * The half of a mix that only this device can answer.
 *
 * A rule set spans two worlds. `genre`, `year`, `title` and the rest describe
 * the *library*, which Jellyfin holds and answers exactly — so the renderer asks
 * Jellyfin for candidates. `play_count`, `skip_count`, `last_played` and
 * `first_played` describe *listening*, which only the curation store knows,
 * because Jellyfin counts a four-second skip as a play and this does not.
 *
 * So the renderer brings candidates and this narrows them. Splitting it that way
 * is not a compromise: it is the reason the history was built. It also means a
 * mix never asks a model to pick a track, and never can.
 */
export class Mix {
    private readonly db: CurationDatabase['db'];

    constructor(database: CurationDatabase) {
        this.db = database.db;
    }

    /**
     * The candidates that satisfy the history rules, most recently played first.
     *
     * Order is deliberate and is not the model's to choose: a mix built from a
     * mood should open on something familiar rather than on whatever sorted
     * first alphabetically. `random` is available through the rule set's own
     * sort when somebody asks for it.
     */
    narrow(candidateIds: readonly string[], rules: SmartRules): string[] {
        const historyRules = rules.rules.filter((rule) => HISTORY_FIELDS.has(rule.field));

        if (candidateIds.length === 0) return [];

        // No history rules means the library filters already said everything
        // there was to say, and every candidate qualifies.
        if (historyRules.length === 0) {
            return rules.limit ? [...candidateIds].slice(0, rules.limit) : [...candidateIds];
        }

        const stats = this.statsFor(candidateIds);
        const matches = candidateIds.filter((id) => {
            const row = stats.get(id) ?? EMPTY_STATS;
            const verdicts = historyRules.map((rule) => satisfies(rule, row));

            // `any` and `all` mean what they mean; a mix of both is what the
            // rule set's own `match` is for.
            return rules.match === 'any' ? verdicts.some(Boolean) : verdicts.every(Boolean);
        });

        matches.sort((a, b) => (stats.get(b)?.lastPlayed ?? 0) - (stats.get(a)?.lastPlayed ?? 0));

        return rules.limit ? matches.slice(0, rules.limit) : matches;
    }

    /**
     * Play counts, skips and timings for a set of tracks.
     *
     * Chunked, because a mix can offer more candidates than SQLite will take
     * host parameters for, and a query that silently answered for the first
     * 32,766 would produce a mix missing its tail with nothing to say so.
     */
    private statsFor(ids: readonly string[]): Map<string, TrackStats> {
        const stats = new Map<string, TrackStats>();

        for (let start = 0; start < ids.length; start += MAX_PARAMETERS) {
            const chunk = ids.slice(start, start + MAX_PARAMETERS);
            const placeholders = chunk.map(() => '?').join(', ');

            const rows = this.db
                .prepare(
                    `SELECT e.jellyfinId AS jellyfinId,
                            SUM(CASE WHEN ${countsAsPlaySql('t', 'e')} THEN 1 ELSE 0 END) AS playCount,
                            SUM(CASE WHEN ${countsAsSkipSql('t', 'e')} THEN 1 ELSE 0 END) AS skipCount,
                            MAX(CASE WHEN ${countsAsPlaySql('t', 'e')} THEN e.startedAt END) AS lastPlayed,
                            MIN(CASE WHEN ${countsAsPlaySql('t', 'e')} THEN e.startedAt END) AS firstPlayed
                     FROM play_events e
                     LEFT JOIN tracks t ON t.jellyfinId = e.jellyfinId
                     WHERE e.jellyfinId IN (${placeholders})
                     GROUP BY e.jellyfinId`,
                )
                .all(...chunk) as Array<Record<string, null | number | string>>;

            for (const row of rows) {
                stats.set(String(row.jellyfinId), {
                    firstPlayed: row.firstPlayed === null ? null : Number(row.firstPlayed),
                    lastPlayed: row.lastPlayed === null ? null : Number(row.lastPlayed),
                    playCount: Number(row.playCount ?? 0),
                    skipCount: Number(row.skipCount ?? 0),
                });
            }
        }

        return stats;
    }
}

/** A track nobody has played: zero counts and no dates, not "unknown". */
const EMPTY_STATS: TrackStats = {
    firstPlayed: null,
    lastPlayed: null,
    playCount: 0,
    skipCount: 0,
};

const HISTORY_FIELDS = new Set<SmartRule['field']>([
    'first_played',
    'last_played',
    'play_count',
    'skip_count',
]);

/** Well below SQLite's 32,766 host-parameter ceiling, matching the phone's chunking. */
const MAX_PARAMETERS = 400;

const satisfies = (rule: SmartRule, stats: TrackStats): boolean => {
    if (rule.field === 'play_count' || rule.field === 'skip_count') {
        const actual = rule.field === 'play_count' ? stats.playCount : stats.skipCount;
        const bound = Number(rule.value);

        switch (rule.op) {
            case 'greaterThan':
                return actual > bound;
            case 'is':
                return actual === bound;
            case 'isNot':
                return actual !== bound;
            case 'lessThan':
                return actual < bound;
            default:
                return false;
        }
    }

    const when = rule.field === 'last_played' ? stats.lastPlayed : stats.firstPlayed;
    const instant = resolveInstant(rule.value);
    if (instant === null) return false;

    switch (rule.op) {
        case 'after':
            return when !== null && when > instant;
        case 'before':
            // Never played counts as before any instant, which is what "has not
            // been played since" means to a person. Treating null as "no" makes
            // "songs I have not touched in a year" quietly exclude the songs
            // never touched at all — the ones most worth surfacing.
            return when === null || when < instant;
        case 'inTheLast':
            return when !== null && when >= instant;
        case 'notInTheLast':
            return when === null || when < instant;
        default:
            return false;
    }
};

/**
 * A rule's value as a moment in time.
 *
 * A number is already an epoch millisecond. A string is a span like `-30d`,
 * resolved against now — stored relative rather than absolute, because an
 * absolute date would freeze "not played in a month" to one particular month.
 */
const resolveInstant = (value: boolean | number | string, now = Date.now()): null | number => {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string') return null;

    const match = /^-?(\d+)([dwmy])$/.exec(value);
    if (!match) return null;

    const amount = Number(match[1]);
    const day = 24 * 60 * 60 * 1000;
    const spans: Record<string, number> = { d: day, m: 30 * day, w: 7 * day, y: 365 * day };

    return now - amount * spans[match[2]];
};
