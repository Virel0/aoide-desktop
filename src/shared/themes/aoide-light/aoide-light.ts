import aoideLightOverridesCss from './aoide-light-overrides.css?inline';

import { iosRadius } from '/@/shared/themes/aoide/ios-geometry';
import { AppThemeConfiguration } from '/@/shared/themes/app-theme-types';

/**
 * The iOS app's light appearance. `background` #F6F7F9 and `primary` #6244E5 are
 * the asset catalogue's own sRGB values; the rest is chosen to sit with them.
 *
 * Body-text contrast, computed rather than assumed — all clear WCAG AA (4.5:1)
 * against both the page and a card:
 *
 *   foreground        #171820   16.49:1 on background, 17.68:1 on surface
 *   foreground-muted  #5C5F70    5.89:1 /  6.31:1
 *   primary           #6244E5    5.63:1 /  6.04:1
 *   state-error       #C72030    5.33:1 /  5.71:1
 *   state-success     #168048    4.65:1 /  4.98:1
 *   state-warning     #A25C06    4.81:1 /  5.16:1
 *
 * The states are darker than their dark-theme counterparts on purpose. A red that
 * reads well on #0B0B10 lands near 3:1 on a near-white page, and "the error text
 * is the one you cannot read" is a poor joke to ship.
 *
 * **`surface` is lighter than `background` here, which inverts what every other
 * Feishin light theme does** — they put cards a shade darker than the page. This
 * follows iOS instead: a grouped page in the systemGroupedBackground grey with
 * white cards on top. It is only a 1.07:1 step, near enough iOS's own 1.12:1
 * between #F2F2F7 and #FFFFFF, so a card edge is soft by design and the accented
 * hairline in the accompanying stylesheet is what actually draws panel bounds.
 */
export const aoideLight: AppThemeConfiguration = {
    app: {
        'overlay-header':
            'linear-gradient(rgb(246 247 249 / 50%) 0%, rgb(246 247 249 / 80%)), var(--theme-background-noise)',
        'overlay-subheader':
            'linear-gradient(180deg, rgba(246, 247, 249, 5%) 0%, var(--theme-colors-background)), var(--theme-background-noise)',
        // See the note in the dark theme about setting all three handle states.
        'scrollbar-handle-active-background': 'rgba(98, 68, 229, 65%)',
        'scrollbar-handle-background': 'rgba(98, 68, 229, 25%)',
        // Matches the dark theme; see the note there.
        'scrollbar-handle-border-radius': '999px',
        'scrollbar-handle-hover-background': 'rgba(98, 68, 229, 50%)',
    },
    colors: {
        background: 'rgb(246, 247, 249)',
        // The layer behind the page. Darker than the page in both Aoide themes,
        // so "further back" means the same thing in each.
        'background-alternate': 'rgb(236, 238, 242)',
        black: 'rgb(0, 0, 0)',
        foreground: 'rgb(23, 24, 32)',
        'foreground-muted': 'rgb(92, 95, 112)',
        primary: 'rgb(98, 68, 229)',
        'state-error': 'rgb(199, 32, 48)',
        'state-info': 'rgb(98, 68, 229)',
        'state-success': 'rgb(22, 128, 72)',
        'state-warning': 'rgb(162, 92, 6)',
        surface: 'rgb(255, 255, 255)',
        'surface-foreground': 'rgb(23, 24, 32)',
        white: 'rgb(255, 255, 255)',
    },
    mantineOverride: {
        // generateColors('#6244E5') reproduces the accent exactly at index 4,
        // which is also where the other light themes point. Feishin's light
        // default of 9 would render #2811A0 — near-black, and not the phone's.
        primaryShade: { light: 4 },
        radius: iosRadius,
    },
    mode: 'light',
    stylesheets: [aoideLightOverridesCss],
};
