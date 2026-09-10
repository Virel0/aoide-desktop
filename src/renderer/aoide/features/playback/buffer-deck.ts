import type { BufferPlayback } from '/@/renderer/aoide/features/playback/gapless-schedule';

import { fitsInMemory } from '/@/renderer/aoide/features/playback/gapless-schedule';

/**
 * The Web Audio side of an exact join: fetch a track, decode it, and hand
 * `gapless-schedule.ts` a source it can start on a named sample.
 *
 * Everything here is plumbing. The decision of *when* is arithmetic and lives
 * next door, tested; this holds the two things that arithmetic cannot be given
 * in a test — an `AudioContext` and a network — and does as little as possible
 * with them.
 *
 * **Where it plugs in.** `audio-players.tsx` builds one gain node per player
 * slot and wires both into the preamp, the equalizer and the compressor on
 * their way to the output; `web-player.tsx` sets each slot's gain from that
 * slot's ReplayGain and Aoide's loudness figure, and `getVisualizerAudioNodes`
 * reads those same two nodes. So a source that connects into the gain node
 * belonging to *its own slot* inherits the level the track was going to be
 * played at, the tone controls, and the visualiser, with nothing restated. Each
 * voice gets one gain node of its own in front of that, standing in for the
 * `<audio>` element's `volume` property — the person's slider and the
 * play/pause fade ride it, and neither touches the levelling underneath.
 *
 * **What it holds.** At most two decoded buffers: the one being played and the
 * one about to be. A decode is only started when the boundary is close, and a
 * buffer is dropped as soon as its source has ended. `fitsInMemory` refuses a
 * track too long to be worth holding — that boundary is then joined the old
 * way, which is the fallback for everything here.
 */
export interface DeckVoice {
    durationSec: number;
    gain: GainNode;
    /** The queue song's `_uniqueId`, so a voice can be matched to a slot. */
    id: string;
    node: AudioBufferSourceNode;
    offsetSec: number;
    startedAtContextTime: number;
}

export interface ScheduleArgs {
    /** Which of `webAudio.gains` carries this track's ReplayGain. */
    gainIndex: number;
    id: string;
    offsetSec: number;
    startAtContextTime: number;
}

/**
 * A ramp short enough to be instant and long enough not to click. A gain node
 * set with a step change pops; the `<audio>` element's own `volume` does not,
 * so the deck has to buy that back.
 */
const MINIMUM_FADE_SECONDS = 0.02;

export class BufferDeck {
    private readonly context: AudioContext;
    /** The voice that is audible now, which is never the one about to be. */
    private current: DeckVoice | null = null;
    private decoded: null | { buffer: AudioBuffer; id: string } = null;
    private decoding: null | { controller: AbortController; id: string } = null;
    private readonly gains: GainNode[];
    /**
     * A voice committed to the audio clock whose `when` has not arrived.
     *
     * Held apart from `current` because a join is committed up to two seconds
     * before it is heard, and for those two seconds every question about what
     * is playing still has the outgoing track as its answer. A deck that
     * answered with the incoming one would tell the progress bar the next
     * track's position, and would tell a hand-back that the element beside it
     * is holding some other song — which is how a hand-back inside that window
     * came to leave the element parked at zero and play the track again.
     */
    private pending: DeckVoice | null = null;
    /** Voices that have been handed over from but have not yet ended. */
    private retired: DeckVoice[] = [];
    private volume = 1;

    constructor(context: AudioContext, gains: GainNode[]) {
        this.context = context;
        this.gains = gains;
    }

    /** The decoded length of the track playing, which is not the library's. */
    currentDurationSec(): null | number {
        return this.current?.durationSec ?? null;
    }

    /** The track playing from a buffer, if one is. */
    currentId(): null | string {
        return this.current?.id ?? null;
    }

    /** The decoded length of the track waiting to play. */
    decodedDurationSec(): null | number {
        return this.decoded?.buffer.duration ?? null;
    }

    /** Whether a decode for this track is already under way. */
    isPreparing(id: string): boolean {
        return this.decoding?.id === id;
    }

    /** The playing track as `planJoin` wants it: exact, not sampled. */
    outgoing(): BufferPlayback | null {
        if (!this.current) return null;
        return {
            kind: 'buffer',
            offsetSec: this.current.offsetSec,
            startedAtContextTime: this.current.startedAtContextTime,
        };
    }

    /** Where the playing track has got to, for the progress bar and for a hand-back. */
    positionSec(now: number): null | number {
        const voice = this.current;
        if (!voice || !Number.isFinite(now)) return null;
        const raw = voice.offsetSec + (now - voice.startedAtContextTime);
        return Math.min(voice.durationSec, Math.max(voice.offsetSec, raw));
    }

    /**
     * Fetch and decode a track, unless it is already decoded, already being
     * decoded, or too large to hold. False means this boundary will not be
     * exact — never that anything is broken.
     */
    async prepare(id: string, url: string, durationSec: number): Promise<boolean> {
        if (this.decoded?.id === id) return true;
        if (this.decoding?.id === id) return false;
        if (!fitsInMemory(durationSec, this.context.sampleRate)) return false;

        this.abortDecode();
        this.decoded = null;

        const controller = new AbortController();
        this.decoding = { controller, id };

        try {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) return false;
            const encoded = await response.arrayBuffer();
            const buffer = await this.context.decodeAudioData(encoded);
            // The queue moved while this was in flight; the buffer is for a
            // track nobody is waiting for any more.
            if (this.decoding?.controller !== controller) return false;
            this.decoded = { buffer, id };
            return true;
        } catch {
            return false;
        } finally {
            if (this.decoding?.controller === controller) this.decoding = null;
        }
    }

    /**
     * The committed voice becomes the audible one.
     *
     * Called at the join from `takeOver`, and again by `forget` when the
     * outgoing voice reaches the `stop` the join gave it — whichever notices
     * first, because a timer set against the audio clock can be a frame behind
     * it and the deck must not spend that frame claiming nothing is playing.
     */
    promote() {
        const voice = this.pending;
        if (!voice) return;
        this.pending = null;
        if (this.current) this.retired.push(this.current);
        this.current = voice;
    }

    /** Whether the track is decoded and waiting. */
    ready(id: string): boolean {
        return this.decoded?.id === id;
    }

    /**
     * Give the audio back: fade what is playing down and let it stop on the
     * audio clock rather than on a timer.
     *
     * The deck is empty the instant this returns — nothing can be scheduled
     * against a voice that is on its way out — but the sound takes the length
     * of the fade to go, which is what stops a hand-back from clicking. Twenty
     * milliseconds is instant to a listener and an age to a gain node.
     */
    release(fadeSeconds = MINIMUM_FADE_SECONDS) {
        this.abortDecode();
        this.decoded = null;

        const now = this.context.currentTime;
        const silentAt = now + Math.max(MINIMUM_FADE_SECONDS, fadeSeconds);

        for (const voice of this.voices()) {
            try {
                voice.gain.gain.cancelScheduledValues(now);
                voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
                voice.gain.gain.linearRampToValueAtTime(0, silentAt);
                voice.node.stop(silentAt);
            } catch {
                // Already stopped; the sound is gone either way.
            }
            if (this.current === voice || this.pending === voice) this.retired.push(voice);
        }

        this.current = null;
        this.pending = null;
    }

    /**
     * Start the decoded track at a named time, and stop whatever was playing at
     * exactly that time.
     *
     * The stop is the join's other half: the outgoing buffer is cut at the
     * sound's end rather than being left to play its measured-away tail over
     * the top of the incoming track.
     */
    schedule({ gainIndex, id, offsetSec, startAtContextTime }: ScheduleArgs): DeckVoice | null {
        const decoded = this.decoded;
        const sink = this.gains[gainIndex];
        if (!decoded || decoded.id !== id || !sink) return null;

        const gain = this.context.createGain();
        gain.gain.value = this.volume;
        gain.connect(sink);

        const node = this.context.createBufferSource();
        node.buffer = decoded.buffer;
        node.connect(gain);

        const voice: DeckVoice = {
            durationSec: decoded.buffer.duration,
            gain,
            id,
            node,
            offsetSec,
            startedAtContextTime: startAtContextTime,
        };
        node.onended = () => this.forget(voice);
        node.start(startAtContextTime, offsetSec);

        if (this.current) {
            try {
                this.current.node.stop(startAtContextTime);
            } catch {
                // Already stopped, which is the same outcome.
            }
        }

        this.decoded = null;
        this.pending = voice;
        return voice;
    }

    /** The person's volume and their mute. */
    setVolume(value: number, rampSeconds: number = MINIMUM_FADE_SECONDS) {
        this.volume = Math.max(0, Number.isFinite(value) ? value : 0);
        const now = this.context.currentTime;
        for (const voice of this.voices()) {
            try {
                voice.gain.gain.cancelScheduledValues(now);
                voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
                voice.gain.gain.linearRampToValueAtTime(
                    this.volume,
                    now + Math.max(0, rampSeconds),
                );
            } catch {
                voice.gain.gain.value = this.volume;
            }
        }
    }

    /** Silence, disconnect and forget everything. The deck is a deck again. */
    stop() {
        this.abortDecode();
        this.decoded = null;
        for (const voice of this.voices()) {
            voice.node.onended = null;
            try {
                voice.node.stop();
            } catch {
                // Never started, or already stopped.
            }
            this.forget(voice);
        }
        this.current = null;
        this.pending = null;
        this.retired = [];
    }

    private abortDecode() {
        this.decoding?.controller.abort();
        this.decoding = null;
    }

    private forget(voice: DeckVoice) {
        try {
            voice.node.disconnect();
            voice.gain.disconnect();
        } catch {
            // Already disconnected.
        }
        this.retired = this.retired.filter((retired) => retired !== voice);
        if (this.pending === voice) {
            this.pending = null;
        } else if (this.current === voice) {
            this.current = this.pending;
            this.pending = null;
        }
    }

    private voices(): DeckVoice[] {
        return [...this.retired, this.current, this.pending].filter(
            (voice): voice is DeckVoice => voice !== null,
        );
    }
}
