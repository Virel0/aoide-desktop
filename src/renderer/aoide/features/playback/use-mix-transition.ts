import type { AudioAnalysis } from '/@/shared/aoide/loudness';
import type { SoundBounds } from '/@/shared/aoide/trim-plan';
import type { QueueSong } from '/@/shared/types/domain-types';

import { useMemo } from 'react';

import { useMixAnalysis } from '/@/renderer/aoide/features/playback/audio-analysis-store';
import { useSoundBounds } from '/@/renderer/aoide/features/playback/sound-bounds-store';
import {
    useAoideAlbumLockEnabled,
    useAoideCrossfadeEnabled,
} from '/@/renderer/aoide/features/playback/use-crossfade';
import { MixTrack, MixTransition, planTransition } from '/@/shared/aoide/mix-transition';

/**
 * The plan for the handover the player is about to make, or null when Crossfade
 * is switched off.
 *
 * Null rather than a plan, because the planner has no answer meaning "however
 * this player was already configured": its `cut` is a specific handover — this
 * track ends, the next one starts — and someone who set Feishin's own
 * crossfade to nine seconds and never turned Crossfade on is owed those nine
 * seconds, not a cut. So the mixer either decides the whole handover or does
 * not exist.
 *
 * Every number it decides on comes from a cache the app already fills: the
 * tempo from the audio-analysis store the leveller reads, the sound's bounds
 * from the store the trimmer reads. Nothing here fetches.
 */
export const useMixTransition = (
    outgoing: QueueSong | undefined,
    incoming: QueueSong | undefined,
): MixTransition | null => {
    const automix = useAoideCrossfadeEnabled();
    const albumLock = useAoideAlbumLockEnabled();

    const outgoingAnalysis = useMixAnalysis(outgoing?.id);
    const incomingAnalysis = useMixAnalysis(incoming?.id);
    const outgoingBounds = useSoundBounds(outgoing?.id);
    const incomingBounds = useSoundBounds(incoming?.id);

    return useMemo(() => {
        if (!automix || !outgoing || !incoming) return null;

        return planTransition({
            albumLock,
            automix,
            incoming: mixTrack(incoming, incomingAnalysis, incomingBounds),
            outgoing: mixTrack(outgoing, outgoingAnalysis, outgoingBounds),
        });
    }, [
        albumLock,
        automix,
        incoming,
        incomingAnalysis,
        incomingBounds,
        outgoing,
        outgoingAnalysis,
        outgoingBounds,
    ]);
};

/**
 * A queue song as the planner wants it: seconds rather than the library's
 * milliseconds, and absent measurements as null rather than as a zero the
 * planner would take for a fact.
 *
 * The album is its id where there is one, because the planner compares two
 * albums for identity and two records can be called the same thing — a
 * self-titled reissue following a self-titled debut is not one record running
 * on. The name is the fallback for a server that names an album without
 * giving it an id.
 *
 * Track numbers are one-based, so a zero is a track whose number the server
 * did not report, not the track before the first.
 */
const mixTrack = (
    song: QueueSong,
    analysis: AudioAnalysis | null | undefined,
    bounds: null | SoundBounds | undefined,
): MixTrack => ({
    album: song.albumId || song.album || '',
    bpm: analysis?.bpm ?? null,
    bpmStability: analysis?.bpmStability ?? null,
    durationSeconds: song.duration > 0 ? song.duration / 1000 : null,
    sound: bounds
        ? {
              soundEndSeconds: bounds.soundEndMs / 1000,
              soundStartSeconds: bounds.soundStartMs / 1000,
          }
        : null,
    trackNumber: song.trackNumber > 0 ? song.trackNumber : null,
});
