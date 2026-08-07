import aoideDarkOverridesCss from './aoide-dark-overrides.css?inline';

import { iosRadius } from '/@/shared/themes/aoide/ios-geometry';
import { AppThemeConfiguration } from '/@/shared/themes/app-theme-types';

/**
 * The iOS app's dark appearance, as close as this stack gets to it.
 *
 * `background` and `primary` are not chosen here — they are the literal sRGB
 * values from the phone's asset catalogue, #0B0B10 and #A593FF. Everything else
 * is picked to sit with them, and every colour that carries body text clears
 * WCAG AA (4.5:1) against both the page and a card:
 *
 *   foreground        #EDECF6   16.76:1 on background, 15.21:1 on surface
 *   foreground-muted  #9E9CB2    7.34:1 /  6.66:1
 *   primary           #A593FF    7.68:1 /  6.97:1
 *   state-error       #FF6974    7.04:1 /  6.38:1
 *   state-success     #46D682   10.47:1 /  9.50:1
 *   state-warning     #FFB052   10.83:1 /  9.83:1
 *
 * The neutrals are not grey. Each carries a few points more blue than red, which
 * is what stops a violet accent reading as a stain on an otherwise neutral page —
 * the same trick the iOS background does by being #0B0B10 rather than #0B0B0B.
 *
 * Feishin has no hover colour of its own: hovers are drawn per component out of
 * `surface`, `background` or an opacity ramp over the artwork. Choosing those
 * two well is therefore most of choosing the hover states, and `surface` sits
 * 1.10:1 above the page — deliberately faint, in the range iOS itself works in
 * between systemBackground and secondarySystemBackground (1.23:1, though that
 * is measured from a true black and so flatters itself).
 */
export const aoideDark: AppThemeConfiguration = {
    app: {
        'overlay-header':
            'linear-gradient(transparent 0%, rgb(11 11 16 / 85%) 100%), var(--theme-background-noise)',
        'overlay-subheader':
            'linear-gradient(180deg, rgb(11 11 16 / 5%) 0%, var(--theme-colors-background) 100%), var(--theme-background-noise)',
        // All three handle states, not just the two the other themes set: the
        // active one falls back to a neutral grey from `default.ts`, so a themed
        // handle that is not also themed here turns grey the moment it is
        // dragged, which is exactly when it is being looked at.
        'scrollbar-handle-active-background': 'rgba(165, 147, 255, 60%)',
        'scrollbar-handle-background': 'rgba(165, 147, 255, 22%)',
        // A capsule scrollbar rather than Feishin's square one, which is the
        // detail that stops a desktop window reading as a web page beside the
        // phone. Design.Radius.round is 999 on iOS for the same reason.
        'scrollbar-handle-border-radius': '999px',
        'scrollbar-handle-hover-background': 'rgba(165, 147, 255, 45%)',
    },
    colors: {
        background: 'rgb(11, 11, 16)',
        // The layer *behind* the page, seen in the sidebar and behind sticky
        // headers. Darker than the page, so depth reads the way it does on iOS.
        'background-alternate': 'rgb(7, 7, 11)',
        black: 'rgb(0, 0, 0)',
        foreground: 'rgb(237, 236, 246)',
        'foreground-muted': 'rgb(158, 156, 178)',
        primary: 'rgb(165, 147, 255)',
        'state-error': 'rgb(255, 105, 116)',
        'state-info': 'rgb(165, 147, 255)',
        'state-success': 'rgb(70, 214, 130)',
        'state-warning': 'rgb(255, 176, 82)',
        surface: 'rgb(23, 23, 31)',
        'surface-foreground': 'rgb(237, 236, 246)',
        white: 'rgb(255, 255, 255)',
    },
    mantineOverride: {
        // Mantine does not use `primary` directly — it expands it into a ten-step
        // scale and then renders whichever step `primaryShade` names. Feishin's
        // dark default is 5, which for this accent is #401AFD: a saturated blue
        // nothing like the phone. generateColors('#A593FF') puts the accent
        // itself at index 2, so that is where this has to point for the colour
        // that ships to actually be the colour that was measured.
        primaryShade: { dark: 2 },
        radius: iosRadius,
    },
    mode: 'dark',
    stylesheets: [aoideDarkOverridesCss],
};
