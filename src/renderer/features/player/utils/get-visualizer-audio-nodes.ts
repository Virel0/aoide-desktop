import type { WebAudio } from '/@/shared/types/types';

/**
 * What the visualizers listen to.
 *
 * The two per-slot gain nodes: every source the web player creates — both
 * player slots and the radio player — connects into one of them on its way to
 * the EQ, the compressor and the output. Reading them rather than the
 * destination means the visualizer sees the audio after ReplayGain and Aoide's
 * loudness levelling, which is what the person is actually hearing.
 *
 * This used to fork on the playback engine: mpv decoded out of process, so
 * there was nothing in this graph to read and a system-audio loopback capture
 * stood in. That went with mpv.
 */
export function getVisualizerAudioNodes(webAudio: undefined | WebAudio): AudioNode[] {
    if (!webAudio) return [];
    return webAudio.gains;
}
