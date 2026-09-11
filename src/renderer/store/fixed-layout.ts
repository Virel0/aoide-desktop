import { Play } from '/@/shared/types/types';

/**
 * The figures the settings page used to ask about.
 *
 * Every one of these was a stored preference with a row of its own — an image
 * resolution, a blur radius, a volume-slider width, whether the play button
 * plays. They are the values the app shipped with, which is what almost
 * everybody had, and they live here as names rather than as numbers scattered
 * through the components that read them: one place to look, and one place to
 * change if any of them ever turns out to have been worth asking about.
 */

/** Pressing play plays. The alternative was to queue it and carry on. */
export const PLAY_BUTTON_BEHAVIOR = Play.NOW;

/** How many tracks a radio built from an artist, album or song comes back with. */
export const RADIO_TRACK_COUNT = 20;

/** Pixel widths the covers are requested at, per surface. 0 means the original. */
export const IMAGE_RES = {
    fullScreenPlayer: 0,
    header: 300,
    itemCard: 300,
    sidebar: 400,
    table: 80,
} as const;

/** The player bar's transport buttons, in pixels. */
export const PLAYER_BUTTON_SIZE = 15;

/** How far one notch of the scroll wheel moves the volume. */
export const VOLUME_WHEEL_STEP = 5;

/** The volume slider's width in the player bar, in pixels. */
export const VOLUME_WIDTH = 70;

/** How far the artist page's background image is blurred, in rem. */
export const ARTIST_BACKGROUND_BLUR = 3;
