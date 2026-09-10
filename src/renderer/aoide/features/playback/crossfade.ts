import { z } from 'zod';

/**
 * The two preferences behind Crossfade, kept apart from the markup and the store
 * for the same reason as loudness normalisation's: `settings.store.ts` imports
 * the schemas and the defaults, and cannot itself be imported under the test
 * runner, so the defaults are pinned here.
 */
export const AoideCrossfadeSchema = z.boolean();

export const AoideAlbumLockSchema = z.boolean();

/**
 * Off. A crossfade changes how every record in the library sounds, and a
 * player that starts doing it uninvited is a player that broke. The phone
 * ships it off for the same reason, and the two apps having different answers
 * to "does my music fade?" would be worse than either answer.
 */
export const DEFAULT_AOIDE_CROSSFADE = false;

/**
 * On. This is what makes Crossfade safe to leave on: a record sequenced to run
 * continuously still does. It is the mixer's off-switch for the albums that
 * need one, never a second mixer — with Crossfade off, an unlocked album run is
 * still an ordinary handover.
 */
export const DEFAULT_AOIDE_ALBUM_LOCK = true;
