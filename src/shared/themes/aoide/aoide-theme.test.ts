import { generateColors } from '@mantine/colors-generator';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { iosRadius } from '/@/shared/themes/aoide/ios-geometry';
import { appTheme, getAppTheme } from '/@/shared/themes/app-theme';
import { AppTheme, AppThemeConfiguration } from '/@/shared/themes/app-theme-types';

type Specificity = [number, number, number];

/** Accepts both spellings this tree uses: `rgb(r, g, b)` in the themes, `#rrggbb` out of generateColors. */
const parseColor = (value: string): [number, number, number] => {
    const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value);

    if (hex) {
        return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
    }

    const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(value);

    if (!rgb) {
        throw new Error(`not a colour this test can read: ${value}`);
    }

    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
};

/** WCAG 2.1 relative luminance. The 0.04045 knee is the sRGB transfer curve. */
const relativeLuminance = ([r, g, b]: [number, number, number]): number => {
    const channel = (c: number) => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };

    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrastRatio = (a: string, b: string): number => {
    const la = relativeLuminance(parseColor(a));
    const lb = relativeLuminance(parseColor(b));
    const [lighter, darker] = la > lb ? [la, lb] : [lb, la];

    return (lighter + 0.05) / (darker + 0.05);
};

/**
 * CSS specificity as the (A, B, C) tuple the cascade actually compares: ids,
 * then classes/attributes/pseudo-classes, then types/pseudo-elements.
 *
 * Hand-written rather than pulled from a package. The guard below exists because
 * a specificity mistake shipped once already, and borrowing another library's
 * answer would only move the question of who is right — so this one is small
 * enough to read, and is itself tested against known tuples further down.
 *
 * It refuses what it cannot score instead of guessing. `:is()`, `:not()` and
 * `:where()` each carry their own rule, and a calculator that quietly counted
 * `:where(.a)` as one B would produce exactly the confident wrong number this
 * test exists to catch. Same for a selector list, whose specificity is per
 * selector and not a single tuple at all.
 */
const computeSpecificity = (selector: string): Specificity => {
    const specificity: Specificity = [0, 0, 0];
    let rest = selector.trim();

    if (rest === '') {
        throw new Error('empty selector');
    }

    const consume = (pattern: RegExp): boolean => {
        const match = pattern.exec(rest);

        if (!match) {
            return false;
        }

        rest = rest.slice(match[0].length);
        return true;
    };

    while (rest.length > 0) {
        if (rest.startsWith(',')) {
            throw new Error(`\`${selector}\` is a selector list, which has no single specificity`);
        }

        const functional = /^:{1,2}[\w-]+\(/.exec(rest);

        if (functional) {
            throw new Error(
                `\`${selector}\` uses ${functional[0]}…), whose specificity rule this calculator does not implement`,
            );
        }

        // Combinators, descendant whitespace and `*` all join or match without
        // contributing to any column.
        if (consume(/^(\s*[>+~]\s*|\s+|\*)/)) {
            continue;
        }

        if (consume(/^#[\w-]+/)) {
            specificity[0] += 1;
            continue;
        }

        // Class, attribute, pseudo-class. `^:[\w-]+` cannot swallow a `::`
        // pseudo-element, because the second colon is not a word character.
        if (consume(/^(\.[\w-]+|\[[^\]]*\]|:[\w-]+)/)) {
            specificity[1] += 1;
            continue;
        }

        if (consume(/^(::[\w-]+|[a-zA-Z][\w-]*)/)) {
            specificity[2] += 1;
            continue;
        }

        throw new Error(`cannot score \`${selector}\`: stuck at \`${rest}\``);
    }

    return specificity;
};

/** Positive when `a` wins the cascade. A, then B, then C — a later column never redeems an earlier one. */
const compareSpecificity = (a: Specificity, b: Specificity): number => {
    for (let column = 0; column < 3; column += 1) {
        if (a[column] !== b[column]) {
            return a[column] > b[column] ? 1 : -1;
        }
    }

    return 0;
};

/**
 * What the override stylesheets have to beat. `src/shared/styles/global.css`
 * sets `--theme-colors-border` inside postcss's `@mixin light-root` /
 * `@mixin dark-root`, which compile to these — transcribed from
 * `out/renderer/assets/*.css` after a build, since `out/` is gitignored and a
 * test on a fresh clone has nothing to read.
 */
const MANTINE_COLOR_SCHEME_SELECTORS = [
    ':root[data-mantine-color-scheme=dark]',
    ':root[data-mantine-color-scheme=light]',
];

const AOIDE_THEMES = [
    {
        id: AppTheme.AOIDE_DARK,
        label: 'Aoide Dark',
        overrides: 'aoide-dark/aoide-dark-overrides.css',
    },
    {
        id: AppTheme.AOIDE_LIGHT,
        label: 'Aoide Light',
        overrides: 'aoide-light/aoide-light-overrides.css',
    },
] as const;

/**
 * Read off disk rather than through the `?inline` import the themes use, so that
 * editing the stylesheet is what this test sees — not a bundler's copy of it.
 */
const readOverrideRule = (overrides: string): { declarations: string; selector: string } => {
    const path = fileURLToPath(new URL(`../${overrides}`, import.meta.url));
    const withoutComments = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)];

    if (rules.length !== 1) {
        throw new Error(`expected exactly one rule in ${overrides}, found ${rules.length}`);
    }

    return { declarations: rules[0][2], selector: rules[0][1].trim() };
};

// Every colour a body-sized string is ever painted in. Backgrounds, borders and
// the black/white anchors are excluded: none of them carries text.
const TEXT_COLOR_KEYS = [
    'foreground',
    'foreground-muted',
    'primary',
    'state-error',
    'state-info',
    'state-success',
    'state-warning',
] as const;

// The two surfaces every one of the above is measured against.
const CONTRAST_SURFACE_KEYS = ['background', 'surface'] as const;

describe('aoide themes', () => {
    it('are registered under both ids', () => {
        expect(appTheme[AppTheme.AOIDE_DARK]).toBeDefined();
        expect(appTheme[AppTheme.AOIDE_LIGHT]).toBeDefined();
    });

    // A theme added to the enum but not to the registry type-checks fine —
    // Record<AppTheme, …> is satisfied by the object literal, but nothing stops
    // a later refactor from dropping an entry through a spread. This catches it.
    it('leave no enum member without a configuration', () => {
        for (const value of Object.values(AppTheme)) {
            expect(appTheme[value], `no configuration registered for ${value}`).toBeDefined();
        }
    });

    it('carry the exact colours read from the iOS asset catalogue', () => {
        const dark = getAppTheme(AppTheme.AOIDE_DARK);
        const light = getAppTheme(AppTheme.AOIDE_LIGHT);

        // sRGB(0.043, 0.043, 0.063) and sRGB(0.647, 0.576, 1.000).
        expect(dark.colors?.background).toBe('rgb(11, 11, 16)');
        expect(dark.colors?.primary).toBe('rgb(165, 147, 255)');
        expect(dark.mode).toBe('dark');

        // sRGB(0.965, 0.969, 0.976) and sRGB(0.384, 0.267, 0.898).
        expect(light.colors?.background).toBe('rgb(246, 247, 249)');
        expect(light.colors?.primary).toBe('rgb(98, 68, 229)');
        expect(light.mode).toBe('light');
    });

    it('align the radius scale to the iOS design system', () => {
        for (const theme of [AppTheme.AOIDE_DARK, AppTheme.AOIDE_LIGHT]) {
            expect(getAppTheme(theme).mantineOverride?.radius).toEqual(iosRadius);
        }
    });

    // The accent Mantine actually paints is `primary` expanded into a ten-step
    // scale and indexed by primaryShade, not `primary` itself. Point it at the
    // wrong step and the shipped accent is a different colour from the measured
    // one while every assertion about `colors.primary` still passes.
    //
    // The step is derived here, not restated: `use-app-theme.ts` renders
    // `generateColors(primary)[shade]`, so the only index worth asserting is the
    // one where that expression reproduces the accent. Writing `2` and `4` by
    // hand would agree with the source without ever checking the relationship.
    it.each(AOIDE_THEMES)(
        '$label points primaryShade at the step that reproduces the accent',
        ({ id, label }) => {
            const configuration = appTheme[id];
            const primary = configuration.colors?.primary as string;
            const scale = generateColors(primary);
            const step = scale.findIndex(
                (candidate) => parseColor(candidate).join() === parseColor(primary).join(),
            );

            expect(
                step,
                `${label}: no step of generateColors(${primary}) equals the accent, so no primaryShade can reproduce it`,
            ).toBeGreaterThanOrEqual(0);

            expect(configuration.mantineOverride?.primaryShade).toEqual({
                [configuration.mode as string]: step,
            });
        },
    );

    /**
     * The override stylesheets exist only to win a cascade fight, and losing one
     * is silent: the declaration is valid, applies to nothing, and the app keeps
     * Feishin's neutral hairline. This is what that fight looks like in numbers.
     */
    describe('border override stylesheets', () => {
        it.each([
            ['#a', [1, 0, 0]],
            ['*', [0, 0, 0]],
            ['html', [0, 0, 1]],
            ['ul li::before', [0, 0, 3]],
            ['.a.b', [0, 2, 0]],
            ['div > p.note:hover', [0, 2, 2]],
            // The two selectors this whole guard is about.
            [':root[data-mantine-color-scheme=dark]', [0, 2, 0]],
            ["html:root[data-theme='aoideDark']", [0, 2, 1]],
            // And the form that shipped broken: a type selector where a B-column
            // one was needed.
            ["html[data-theme='aoideDark']", [0, 1, 1]],
        ] as [string, Specificity][])('scores %s as %j', (selector, expected) => {
            expect(computeSpecificity(selector)).toEqual(expected);
        });

        it('refuses selectors it cannot score rather than guessing', () => {
            expect(() => computeSpecificity(':where(.a)')).toThrow(/does not implement/);
            expect(() => computeSpecificity('html, body')).toThrow(/selector list/);
        });

        it('compares columns left to right, so B beats C outright', () => {
            expect(compareSpecificity([0, 1, 1], [0, 2, 0])).toBeLessThan(0);
            expect(compareSpecificity([0, 2, 1], [0, 2, 0])).toBeGreaterThan(0);
            expect(compareSpecificity([1, 0, 0], [0, 9, 9])).toBeGreaterThan(0);
            expect(compareSpecificity([0, 2, 1], [0, 2, 1])).toBe(0);
        });

        it.each(AOIDE_THEMES)(
            '$label outranks global.css on the border variable',
            ({ id, label, overrides }) => {
                const { declarations, selector } = readOverrideRule(overrides);

                // Nothing else in the rule matters if it is not the variable
                // global.css is holding.
                expect(
                    declarations,
                    `${label}: ${overrides} no longer sets the border variable`,
                ).toMatch(/--theme-colors-border\s*:/);

                // `data-theme` is written by use-app-theme.ts straight from the
                // stored theme id, so an attribute value that drifts from the
                // enum selects nothing at all.
                const attribute = /\[data-theme='([^']*)'\]/.exec(selector);

                expect(
                    attribute?.[1],
                    `${label}: \`${selector}\` does not match on the AppTheme id the renderer writes to data-theme`,
                ).toBe(id);

                const override = computeSpecificity(selector);

                for (const competitor of MANTINE_COLOR_SCHEME_SELECTORS) {
                    const beaten = computeSpecificity(competitor);

                    expect(
                        compareSpecificity(override, beaten),
                        `${label}: \`${selector}\` is (${override.join()}) and loses or ties \`${competitor}\` at (${beaten.join()}), so --theme-colors-border is silently never applied`,
                    ).toBeGreaterThan(0);
                }
            },
        );
    });

    /**
     * A fresh install has to land on Aoide, and nothing else in the tree says so:
     * `initialState` in settings.store.ts is a plain object literal that
     * type-checks identically with Feishin's values in it.
     *
     * Asserted against the file's text rather than by importing the module. The
     * store cannot be imported under this runner at all — it reaches
     * `/@/i18n/i18n`, which vitest.config.ts does not alias, and beyond that
     * pulls in DOMPurify, which calls `addHook` at module scope and needs a DOM
     * the `node` environment does not have. `initialState` is not exported
     * either, so even a jsdom run would have to read the built store instead of
     * the defaults. Matching the source is the only thing here that fails when
     * somebody reverts the values.
     */
    describe('fresh-install defaults', () => {
        const settingsStorePath = fileURLToPath(
            new URL('../../../renderer/store/settings.store.ts', import.meta.url),
        );

        // Narrowed to `general` inside `initialState` so a match cannot come
        // from a migration, a comment or an env override elsewhere in the file.
        const generalDefaults = (() => {
            const source = readFileSync(settingsStorePath, 'utf8');
            const start = source.indexOf('const initialState: SettingsState = {');

            if (start === -1) {
                throw new Error(
                    'settings.store.ts no longer declares `initialState: SettingsState`',
                );
            }

            const marker = source.indexOf('general: {', start);

            if (marker === -1) {
                throw new Error('`initialState` no longer has a `general` block');
            }

            let depth = 0;

            for (let i = source.indexOf('{', marker); i < source.length; i += 1) {
                if (source[i] === '{') {
                    depth += 1;
                } else if (source[i] === '}') {
                    depth -= 1;

                    if (depth === 0) {
                        return source.slice(marker, i + 1);
                    }
                }
            }

            throw new Error('`general` block in `initialState` has unbalanced braces');
        })();

        it.each([
            // All three theme slots move together: themeDark/themeLight are the
            // pair used when "follow system theme" is on, so leaving either on a
            // Feishin value changes the app's identity at sunset.
            ['theme', /^\s*theme: AppTheme\.AOIDE_DARK,$/m],
            ['themeDark', /^\s*themeDark: AppTheme\.AOIDE_DARK,$/m],
            ['themeLight', /^\s*themeLight: AppTheme\.AOIDE_LIGHT,$/m],
            // `useThemeAccentColor` defaults to false, which makes this setting —
            // not the theme's own `primary` — the accent that actually ships.
            ['accent', /^\s*accent: 'rgb\(165, 147, 255\)',$/m],
        ])('set general.%s to the Aoide value', (_key, pattern) => {
            expect(generalDefaults).toMatch(pattern);
        });

        it('name theme ids that resolve to a registered theme', () => {
            expect(appTheme[AppTheme.AOIDE_DARK].mode).toBe('dark');
            expect(appTheme[AppTheme.AOIDE_LIGHT].mode).toBe('light');
        });
    });

    describe.each(AOIDE_THEMES)('$label', ({ id, label }) => {
        // Deliberately the theme's own configuration, not getAppTheme(). That
        // merges defaultTheme.colors underneath, so a colour deleted from an
        // Aoide theme would quietly be measured as Feishin's fallback and pass.
        const theme: AppThemeConfiguration = appTheme[id];
        const colors = theme.colors ?? {};

        it('define every colour the contrast checks read', () => {
            for (const key of [...CONTRAST_SURFACE_KEYS, ...TEXT_COLOR_KEYS]) {
                expect(
                    theme.colors?.[key],
                    `${label} does not set \`${key}\` itself, so the contrast checks below would measure Feishin's merged-in default instead`,
                ).toBeTypeOf('string');
            }
        });

        // 4.5:1 is WCAG AA for body text. Checked against the card surface as
        // well as the page, because Feishin paints the same foreground on both
        // and a value tuned only to the page can fail on a lifted panel.
        it.each(TEXT_COLOR_KEYS)('%s meets AA on background and surface', (key) => {
            const value = colors[key] as string;

            for (const surfaceKey of CONTRAST_SURFACE_KEYS) {
                const against = colors[surfaceKey] as string;
                const ratio = contrastRatio(value, against);

                expect(
                    ratio,
                    `${label}: ${key} ${value} on ${surfaceKey} ${against} measures ${ratio.toFixed(2)}:1, under the 4.5:1 AA floor`,
                ).toBeGreaterThanOrEqual(4.5);
            }
        });
    });
});
