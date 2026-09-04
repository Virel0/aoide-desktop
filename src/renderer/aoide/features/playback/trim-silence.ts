import { z } from 'zod';

/**
 * The preference behind silence trimming, kept apart from the markup and the
 * store for the same reason as the Now Playing column's: `settings.store.ts`
 * imports the schema and the default, and cannot itself be imported under the
 * test runner, so the default is pinned here.
 */
export const AoideTrimSilenceSchema = z.boolean();

/**
 * On. The point of gapless is no gap, and the silence inside the recordings
 * is the part gapless cannot remove. A track whose bounds are not known plays
 * whole, so the setting being on costs nothing until the sidecar answers.
 */
export const DEFAULT_AOIDE_TRIM_SILENCE = true;
