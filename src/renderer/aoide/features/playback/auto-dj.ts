import { z } from 'zod';

/**
 * The preference behind Auto DJ, kept apart from the markup and the store for
 * the same reason as Crossfade's: `settings.store.ts` imports the schema and
 * the default, and cannot itself be imported under the test runner, so the
 * default is pinned here.
 */
export const AoideAutoDjSchema = z.boolean();

/**
 * Off. A mix bends a record's tempo and takes the bass out of another, and a
 * player that starts doing that uninvited is a player that broke. The phone
 * ships it off for the same reason. Auto DJ is a thing that happens sometimes,
 * not a mode: with it on, a pair the server has gridded and read is mixed,
 * and every other pair hands over exactly as it did before.
 */
export const DEFAULT_AOIDE_AUTO_DJ = false;
