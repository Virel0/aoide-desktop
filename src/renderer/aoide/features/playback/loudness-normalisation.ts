import { z } from 'zod';

/**
 * The preference behind loudness normalisation, kept apart from the markup and
 * the store for the same reason as silence trimming's: `settings.store.ts`
 * imports the schema and the default, and cannot itself be imported under the
 * test runner, so the default is pinned here.
 */
export const AoideLoudnessNormalisationSchema = z.boolean();

/**
 * On. A library mastered across four decades is a volume lottery, and the
 * correction only ever attenuates, so the worst it can do is make a loud
 * remaster sit where everything else does. A track whose loudness is not known
 * plays unmodified, so the setting being on costs nothing until the sidecar
 * answers — which today it cannot, the endpoint not being built yet.
 */
export const DEFAULT_AOIDE_LOUDNESS_NORMALISATION = true;
