import type { QueueSong } from '/@/shared/types/domain-types';

import { useAudioAnalysis } from '/@/renderer/aoide/features/playback/audio-analysis-store';
import { useAoideLoudnessNormalisationEnabled } from '/@/renderer/aoide/features/playback/use-loudness-normalisation';
import { hasReplayGain, linearGain, normalisationGainDb } from '/@/shared/aoide/loudness';

/**
 * Loudness normalisation for Feishin's web player, as a factor for the slot's
 * gain node.
 *
 * The web player already has a `GainNode` per `<audio>` slot, which is where it
 * applies ReplayGain; this is a second factor into that same node, so the two
 * multiply and neither has to know about the other. That node sits *before* the
 * EQ, the compressor and the destination, and is entirely separate from the
 * element volume the person's own slider, the fades and the crossfade all
 * drive — so this composes with the volume control rather than fighting it, and
 * a track being levelled never moves the slider.
 *
 * `1` whenever there is nothing to do: normalisation off, nothing measured yet,
 * a file with its own ReplayGain, or a track already at the reference. A caller
 * can multiply by it unconditionally.
 */
export const useLoudnessGain = (song: QueueSong | undefined): number => {
    const enabled = useAoideLoudnessNormalisationEnabled();
    const analysis = useAudioAnalysis(song?.id);

    return linearGain(
        normalisationGainDb({
            analysis,
            enabled,
            hasOwnReplayGain: hasReplayGain(song?.gain),
        }),
    );
};
