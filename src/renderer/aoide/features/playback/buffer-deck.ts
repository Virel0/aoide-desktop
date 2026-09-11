import type {
    AutomationEvent,
    MixBooking,
    RatePlan,
} from '/@/renderer/aoide/features/playback/dj-schedule';
import type { BufferPlayback } from '/@/renderer/aoide/features/playback/gapless-schedule';
import type { PitchStretch } from '/@/renderer/aoide/features/playback/pitch-stretch';

import {
    blendAutomation,
    HIGH_PASS_Q_DB,
    mixProgress,
    settledPlayback,
    voicePositionAt,
} from '/@/renderer/aoide/features/playback/dj-schedule';
import { fitsInMemory } from '/@/renderer/aoide/features/playback/gapless-schedule';
import { createPitchStretch } from '/@/renderer/aoide/features/playback/pitch-stretch';
import { BASS_OPEN_HZ } from '/@/shared/aoide/dj-automation';

/**
 * The Web Audio side of a hand-over: fetch a track, decode it, and hand the
 * arithmetic next door a source it can start on a named sample.
 *
 * Everything here is plumbing. The decision of *when* is arithmetic and lives
 * in `gapless-schedule.ts` and `dj-schedule.ts`, tested; this holds the two
 * things that arithmetic cannot be given in a test — an `AudioContext` and a
 * network — and does as little as possible with them.
 *
 * **Three kinds of hand-over on one pair of voices**, exactly as the phone's
 * `DJSession` performs `.joined`, `.blended` and `.mixed` on one pair of
 * decks. A *join* starts the next track on the sample the last one stops. A
 * *blend* overlaps the two on the equal-power curve. A *mix* starts the next
 * track bent to the tempo of the one playing, on a downbeat, with the low end
 * handed from one to the other halfway through, and eases the bend back
 * afterwards. All three are booked once, on the audio clock, and the render
 * thread carries them out; nothing on the main thread can make them late or
 * coarse.
 *
 * **Where it plugs in.** `audio-players.tsx` builds one gain node per player
 * slot and wires both into the preamp, the equalizer and the compressor on
 * their way to the output; `web-player.tsx` sets each slot's gain from that
 * slot's ReplayGain and Aoide's loudness figure. A voice that connects into
 * the gain node belonging to *its own slot* inherits the level the track was
 * going to be played at, the tone controls, and the visualiser, with nothing
 * restated. In front of that each voice has, from the sound backwards: a
 * fader standing in for the `<audio>` element's `volume` property, which the
 * person's slider and the play/pause fade ride; a mix gain the hand-over's
 * curves are booked on, so the two never fight; with Auto DJ on, a high-pass
 * parked at 20 Hz until a mix swaps the bass; and, for the incoming side of
 * a mix only, the pitch-stretch that undoes what `playbackRate` does to the
 * pitch.
 *
 * **What it holds.** At most two decoded buffers: the one being played and the
 * one about to be. A decode is only started when the boundary is close, and a
 * buffer is dropped as soon as its source has ended. A mix holds both for the
 * length of the mix rather than an instant, and no further hand-over is
 * booked while the outgoing record is still sounding, so the peak is the same
 * two. `fitsInMemory` refuses a track too long to be worth holding.
 */
export interface DeckVoice {
    durationSec: number;
    /** The person's volume, in front of everything else. */
    fader: GainNode;
    /** The bass swap's high-pass, when the voice was made with Auto DJ on. */
    filter: BiquadFilterNode | null;
    /** The queue song's `_uniqueId`, so a voice can be matched to a slot. */
    id: string;
    /** What sits between this voice's source and its sound. */
    latencySec: number;
    /** What the hand-over's curves are booked on. */
    mixGain: GainNode;
    node: AudioBufferSourceNode;
    /** Where the buffer was started from, on its own clock. */
    offsetSec: number;
    /** How the rate moved after the start, when the voice came in bent. */
    ratePlan: null | RatePlan;
    /** When the voice became audible, on the context clock. */
    startedAtContextTime: number;
    /** The slot's pitch-stretch, when this voice runs through it. */
    stretch: null | PitchStretch;
}

/** How the incoming voice takes over from the one playing. */
export type Handover =
    | { booking: MixBooking; kind: 'mix' }
    | { kind: 'blend'; seconds: number }
    | { kind: 'join' };

/** What the indicator shows. */
export interface MixStatus {
    bars: number;
    phase: 'mixing' | 'ready';
    progress: number;
}

export interface ScheduleArgs {
    /** Which of `webAudio.gains` carries this track's ReplayGain. */
    gainIndex: number;
    handover: Handover;
    id: string;
    offsetSec: number;
    /** When the incoming voice becomes audible. */
    startAtContextTime: number;
}

/**
 * A ramp short enough to be instant and long enough not to click. A gain node
 * set with a step change pops; the `<audio>` element's own `volume` does not,
 * so the deck has to buy that back.
 */
const MINIMUM_FADE_SECONDS = 0.02;

const quietly = (run: () => void) => {
    try {
        run();
    } catch {
        // Already disconnected.
    }
};

export class BufferDeck {
    private autoDj = false;
    private readonly context: AudioContext;
    /** The voice that is audible now, which is never the one about to be. */
    private current: DeckVoice | null = null;
    private decoded: null | { buffer: AudioBuffer; id: string } = null;
    private decoding: null | { controller: AbortController; id: string } = null;
    private readonly gains: GainNode[];
    /** The mix booked or under way, for the indicator. */
    private mix: null | { bookedAt: number; booking: MixBooking } = null;
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
    /**
     * One pitch-stretch per slot, made on first need and kept: the worklet
     * cannot be destroyed, so it is reused rather than leaked.
     */
    private readonly stretches: Array<null | PitchStretch> = [];
    private readonly stretching: Array<null | Promise<null | PitchStretch>> = [];
    private volume = 1;

    constructor(context: AudioContext, gains: GainNode[]) {
        this.context = context;
        this.gains = gains;
    }

    /**
     * Whether the voice playing can be the outgoing side of a mix: it has a
     * high-pass to swap the bass out through. A voice made before Auto DJ was
     * switched on has none, and that pair crossfades; the one after it mixes.
     */
    canMixOut(): boolean {
        return this.current !== null && this.current.filter !== null;
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

    /**
     * Whether a record handed over from is still sounding — the outgoing side
     * of a mix or a blend that has not reached its stop. Nothing new is
     * decoded or booked while it is, which is what keeps the deck to two
     * buffers.
     */
    isSettling(): boolean {
        return this.retired.length > 0;
    }

    /** What the indicator shows now, or nothing. */
    mixStatus(now: number): MixStatus | null {
        if (!this.mix) return null;
        const progress = mixProgress(
            {
                bookedAt: this.mix.bookedAt,
                endAtContextTime: this.mix.booking.endAtContextTime,
                startAtContextTime: this.mix.booking.startAtContextTime,
            },
            now,
        );
        if (!progress) {
            this.mix = null;
            return null;
        }
        return { bars: this.mix.booking.plan.bars, ...progress };
    }

    /**
     * The playing track as `planJoin` and `planMixBooking` want it: a pair
     * that advances in real time. Null while a bend is still easing back,
     * because until then there is no such pair.
     */
    outgoing(): BufferPlayback | null {
        if (!this.current) return null;
        const settled = settledPlayback(
            this.current.offsetSec,
            this.current.startedAtContextTime,
            this.current.ratePlan,
            this.context.currentTime,
        );
        return settled ? { kind: 'buffer', ...settled } : null;
    }

    /** Where the playing track has got to, for the progress bar and for a hand-back. */
    positionSec(now: number): null | number {
        const voice = this.current;
        if (!voice || !Number.isFinite(now)) return null;
        const raw = voicePositionAt(
            voice.offsetSec,
            voice.startedAtContextTime,
            voice.ratePlan,
            now,
        );
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
     * Have the slot's pitch-stretch ready for a mix into it. Made once per
     * slot; a slot whose worklet cannot be had stays null, and no mix is
     * booked into it.
     */
    async prepareStretch(gainIndex: number): Promise<null | PitchStretch> {
        const existing = this.stretches[gainIndex];
        if (existing) return existing;
        const making = this.stretching[gainIndex];
        if (making) return making;

        const promise = createPitchStretch(this.context).then((stretch) => {
            this.stretches[gainIndex] = stretch;
            this.stretching[gainIndex] = null;
            return stretch;
        });
        this.stretching[gainIndex] = promise;
        return promise;
    }

    /**
     * The committed voice becomes the audible one.
     *
     * Called at the hand-over from `takeOver`, and again by `forget` when the
     * outgoing voice reaches the `stop` the hand-over gave it — whichever
     * notices first, because a timer set against the audio clock can be a
     * frame behind it and the deck must not spend that frame claiming nothing
     * is playing.
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
        this.mix = null;

        const now = this.context.currentTime;
        const silentAt = now + Math.max(MINIMUM_FADE_SECONDS, fadeSeconds);

        for (const voice of this.voices()) {
            try {
                voice.fader.gain.cancelScheduledValues(now);
                voice.fader.gain.setValueAtTime(voice.fader.gain.value, now);
                voice.fader.gain.linearRampToValueAtTime(0, silentAt);
                voice.node.stop(silentAt - voice.latencySec);
            } catch {
                // Already stopped; the sound is gone either way.
            }
            if (this.current === voice || this.pending === voice) this.retired.push(voice);
        }

        this.current = null;
        this.pending = null;
    }

    /**
     * Start the decoded track at a named time, and stop whatever was playing
     * when the hand-over says it is done with: on that same sample for a
     * join, at the end of the overlap for a blend or a mix.
     *
     * The stop is the hand-over's other half: the outgoing buffer is cut where
     * the plan says rather than being left to play its tail over the top of
     * the incoming track. A mix books every curve it will follow here, on the
     * audio clock, before either voice has moved.
     */
    schedule({
        gainIndex,
        handover,
        id,
        offsetSec,
        startAtContextTime,
    }: ScheduleArgs): DeckVoice | null {
        const decoded = this.decoded;
        const sink = this.gains[gainIndex];
        if (!decoded || decoded.id !== id || !sink) return null;

        const stretch = handover.kind === 'mix' ? (this.stretches[gainIndex] ?? null) : null;
        if (handover.kind === 'mix' && (!stretch || !this.canMixOut())) return null;
        const latencySec = stretch?.latencySec ?? 0;

        const fader = this.context.createGain();
        fader.gain.value = this.volume;
        fader.connect(sink);

        const mixGain = this.context.createGain();
        mixGain.gain.value = handover.kind === 'join' ? 1 : 0;
        mixGain.connect(fader);

        let filter: BiquadFilterNode | null = null;
        let tail: AudioNode = mixGain;
        if (this.autoDj) {
            filter = this.context.createBiquadFilter();
            filter.type = 'highpass';
            filter.Q.value = HIGH_PASS_Q_DB;
            filter.frequency.value = BASS_OPEN_HZ;
            filter.connect(mixGain);
            tail = filter;
        }

        const node = this.context.createBufferSource();
        node.buffer = decoded.buffer;
        if (stretch) {
            node.connect(stretch.node);
            stretch.node.connect(tail);
        } else {
            node.connect(tail);
        }

        const voice: DeckVoice = {
            durationSec: decoded.buffer.duration,
            fader,
            filter,
            id,
            latencySec,
            mixGain,
            node,
            offsetSec,
            ratePlan: null,
            startedAtContextTime: startAtContextTime,
            stretch,
        };

        let stopOutgoingAt = startAtContextTime;
        if (handover.kind === 'mix') {
            const { booking } = handover;
            voice.ratePlan = {
                mixEndAt: booking.endAtContextTime,
                rate: booking.plan.incomingRate,
                restoreSeconds: booking.plan.restoreSeconds,
            };
            stopOutgoingAt = booking.endAtContextTime;
            this.apply(booking.events, voice);
            this.mix = { bookedAt: this.context.currentTime, booking };
        } else if (handover.kind === 'blend') {
            stopOutgoingAt = startAtContextTime + handover.seconds;
            this.apply(
                blendAutomation(startAtContextTime, handover.seconds, this.current !== null),
                voice,
            );
        }

        node.onended = () => this.forget(voice);
        node.start(startAtContextTime - latencySec, offsetSec);

        if (this.current) {
            try {
                this.current.node.stop(stopOutgoingAt - this.current.latencySec);
            } catch {
                // Already stopped, which is the same outcome.
            }
        }

        this.decoded = null;
        this.pending = voice;
        return voice;
    }

    /**
     * Whether voices made from now on carry a high-pass. Only voices made
     * with it on can take part in a mix; the setting is read once per voice
     * rather than on every tick.
     */
    setAutoDj(enabled: boolean) {
        this.autoDj = enabled;
    }

    /** The person's volume and their mute. */
    setVolume(value: number, rampSeconds: number = MINIMUM_FADE_SECONDS) {
        this.volume = Math.max(0, Number.isFinite(value) ? value : 0);
        const now = this.context.currentTime;
        for (const voice of this.voices()) {
            try {
                voice.fader.gain.cancelScheduledValues(now);
                voice.fader.gain.setValueAtTime(voice.fader.gain.value, now);
                voice.fader.gain.linearRampToValueAtTime(
                    this.volume,
                    now + Math.max(0, rampSeconds),
                );
            } catch {
                voice.fader.gain.value = this.volume;
            }
        }
    }

    /** Silence, disconnect and forget everything. The deck is a deck again. */
    stop() {
        this.abortDecode();
        this.decoded = null;
        this.mix = null;
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

    /** What the slot's stretch adds, once it has been made; null until then. */
    stretchLatencySec(gainIndex: number): null | number {
        return this.stretches[gainIndex]?.latencySec ?? null;
    }

    private abortDecode() {
        this.decoding?.controller.abort();
        this.decoding = null;
    }

    /**
     * Book a hand-over's events on the params they name. The outgoing side is
     * the voice playing; the incoming side is `voice`. The stretch takes its
     * schedule in its own words. Nothing here decides a value or a time.
     */
    private apply(events: AutomationEvent[], voice: DeckVoice) {
        const outgoing = this.current;
        for (const event of events) {
            if (event.target === 'incomingSemitones') {
                voice.stretch?.scheduleSemitones(event.time, event.value);
                continue;
            }
            const param = this.paramFor(event.target, voice, outgoing);
            if (!param) continue;
            try {
                switch (event.shape) {
                    case 'exponential':
                        param.exponentialRampToValueAtTime(event.value, event.time);
                        break;
                    case 'linear':
                        param.linearRampToValueAtTime(event.value, event.time);
                        break;
                    case 'set':
                        param.setValueAtTime(event.value, event.time);
                        break;
                }
            } catch {
                // A value or a time the param refuses; the mix runs with the
                // rest of its schedule, which is the honest failure here.
            }
        }
    }

    private forget(voice: DeckVoice) {
        // Each on its own, because a node already disconnected throws and the
        // ones after it still have to go. The slot's stretch is shared and
        // stays; only its edge into this voice is cut.
        quietly(() => voice.node.disconnect());
        quietly(() => voice.stretch?.node.disconnect(voice.filter ?? voice.mixGain));
        quietly(() => voice.filter?.disconnect());
        quietly(() => voice.mixGain.disconnect());
        quietly(() => voice.fader.disconnect());
        this.retired = this.retired.filter((retired) => retired !== voice);
        if (this.pending === voice) {
            this.pending = null;
        } else if (this.current === voice) {
            this.current = this.pending;
            this.pending = null;
        }
    }

    private paramFor(
        target: AutomationEvent['target'],
        voice: DeckVoice,
        outgoing: DeckVoice | null,
    ): AudioParam | null {
        switch (target) {
            case 'incomingGain':
                return voice.mixGain.gain;
            case 'incomingHz':
                return voice.filter?.frequency ?? null;
            case 'incomingRate':
                return voice.node.playbackRate;
            case 'incomingSemitones':
                return null;
            case 'outgoingGain':
                return outgoing?.mixGain.gain ?? null;
            case 'outgoingHz':
                return outgoing?.filter?.frequency ?? null;
        }
    }

    private voices(): DeckVoice[] {
        return [...this.retired, this.current, this.pending].filter(
            (voice): voice is DeckVoice => voice !== null,
        );
    }
}
