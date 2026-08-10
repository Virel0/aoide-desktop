import { describe, expect, it } from 'vitest';

import { buildMixPrompt, parseRules, ruleProblem, SmartRule } from './smart-rules';

const rule = (over: Partial<SmartRule> = {}): SmartRule => ({
    field: 'genre',
    op: 'is',
    value: 'Jazz',
    ...over,
});

describe('which rules both apps can evaluate', () => {
    // The property the phone is most careful about: an illegal pair must be
    // refused, never quietly accepted. "Unsupported" implemented as a predicate
    // that matches nothing gives a silently empty playlist, which looks exactly
    // like one whose rules simply have no hits.
    it('refuses an operator that does not apply to the field', () => {
        expect(ruleProblem(rule({ field: 'duration_ms', op: 'beginsWith', value: 3 }))).toMatch(
            /does not apply/,
        );
        expect(ruleProblem(rule({ field: 'title', op: 'inTheLast', value: '-30d' }))).toMatch(
            /does not apply/,
        );
    });

    it('accepts the pairs the phone accepts', () => {
        expect(ruleProblem(rule({ field: 'genre', op: 'contains', value: 'Jaz' }))).toBeNull();
        expect(ruleProblem(rule({ field: 'play_count', op: 'greaterThan', value: 3 }))).toBeNull();
        expect(
            ruleProblem(rule({ field: 'last_played', op: 'notInTheLast', value: '-6m' })),
        ).toBeNull();
        expect(ruleProblem(rule({ field: 'liked', op: 'is', value: true }))).toBeNull();
    });

    it('insists a number field gets a whole number', () => {
        // Every numeric field counts something or is a millisecond. Accepting 2.5
        // means deciding on somebody's behalf which way to round a bound.
        expect(ruleProblem(rule({ field: 'play_count', op: 'greaterThan', value: 2.5 }))).toMatch(
            /whole number/,
        );
    });

    it('insists a span is a span', () => {
        expect(ruleProblem(rule({ field: 'last_played', op: 'inTheLast', value: 30 }))).toMatch(
            /span/,
        );
        expect(ruleProblem(rule({ field: 'last_played', op: 'inTheLast', value: 'ages' }))).toMatch(
            /span/,
        );
    });

    it('lets before and after name an instant as well as a span', () => {
        expect(
            ruleProblem(rule({ field: 'last_played', op: 'before', value: 1_700_000_000_000 })),
        ).toBeNull();
        expect(ruleProblem(rule({ field: 'last_played', op: 'after', value: '-1y' }))).toBeNull();
    });

    it('insists a flag is a flag', () => {
        expect(ruleProblem(rule({ field: 'liked', op: 'is', value: 'yes' }))).toMatch(
            /true or false/,
        );
    });
});

describe('reading a model’s rules', () => {
    const reply = (body: unknown) => JSON.stringify(body);

    it('keeps the rules that work and says why it dropped the rest', () => {
        const parsed = parseRules(
            reply({
                match: 'all',
                rules: [
                    { field: 'genre', op: 'is', value: 'Jazz' },
                    { field: 'title', op: 'inTheLast', value: '-30d' },
                ],
            }),
        );

        expect(parsed.rules?.rules).toHaveLength(1);
        expect(parsed.rejected).toHaveLength(1);
    });

    it('accepts the camelCase spellings the phone also accepts', () => {
        const parsed = parseRules(
            reply({ match: 'all', rules: [{ field: 'playCount', op: 'greaterThan', value: 3 }] }),
        );

        // Emitted snake_case, because that is what the sidecar is written against.
        expect(parsed.rules?.rules[0].field).toBe('play_count');
    });

    // `any` of nothing can only ever be empty, and an always-empty playlist is
    // indistinguishable from a broken one.
    it('refuses "any" with no usable rules', () => {
        expect(parseRules(reply({ match: 'any', rules: [] })).rules).toBeNull();
    });

    // `all` of nothing is every track, which is a real playlist.
    it('allows "all" with no rules, which is the whole library', () => {
        const parsed = parseRules(reply({ limit: 25, match: 'all', rules: [] }));
        expect(parsed.rules).not.toBeNull();
        expect(parsed.rules?.limit).toBe(25);
    });

    it('ignores a limit that is not a positive whole number', () => {
        expect(
            parseRules(reply({ limit: 0, match: 'all', rules: [] })).rules?.limit,
        ).toBeUndefined();
        expect(
            parseRules(reply({ limit: 2.5, match: 'all', rules: [] })).rules?.limit,
        ).toBeUndefined();
    });

    it('finds JSON wrapped in prose or a fence', () => {
        const body = reply({ match: 'all', rules: [{ field: 'genre', op: 'is', value: 'Jazz' }] });
        expect(parseRules('```json\n' + body + '\n```').rules?.rules).toHaveLength(1);
        expect(parseRules(`Here you go:\n${body}`).rules?.rules).toHaveLength(1);
    });

    it('gives up rather than guessing when there is no JSON', () => {
        expect(parseRules('I cannot help with that.').rules).toBeNull();
    });
});

describe('the mix prompt', () => {
    it('carries the library’s own genres', () => {
        expect(buildMixPrompt('something calm', ['Jazz', 'Ambient'])).toContain('Jazz, Ambient');
    });

    it('tells the model to use the listening history', () => {
        const prompt = buildMixPrompt('something calm', []);
        expect(prompt).toContain('play_count');
        expect(prompt).toContain('last_played');
    });

    it('says the rules select, not the model', () => {
        expect(buildMixPrompt('x', [])).toContain('never choose songs');
    });
});
