import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BufferDeck } from './buffer-deck';
import { MixBooking, planMixBooking } from './dj-schedule';

import { DJTransition } from '/@/shared/aoide/dj-planner';

/** The slot's pitch-stretch, as the deck sees it: a node and a latency. */
const fakeStretch = () => ({
    latencySec: 0.12,
    node: {
        connect: vi.fn(),
        disconnect: vi.fn(),
    },
    scheduleSemitones: vi.fn(),
});
let stretches: ReturnType<typeof fakeStretch>[] = [];
let stretchAvailable = true;

vi.mock('./pitch-stretch', () => ({
    createPitchStretch: () => {
        if (!stretchAvailable) return Promise.resolve(null);
        const stretch = fakeStretch();
        stretches.push(stretch);
        return Promise.resolve(stretch);
    },
}));

/**
 * The deck is Web Audio glue and the arithmetic it serves lives next door, so
 * almost nothing here is worth a test. One thing is: *which track the deck says
 * it is playing*, because a join is committed to the audio clock up to two
 * seconds before it is heard and everything above reads the answer during those
 * two seconds — the progress bar, and the hand-back that decides where to put
 * the `<audio>` element down.
 *
 * A deck that answered "the incoming track" for those two seconds told a
 * hand-back that the element beside it held some other song, so the hand-back
 * skipped its seek and pressed play on an element `takeOver` had parked at
 * zero. That is a track restarting from the top in the last seconds of itself,
 * and it is the whole reason this file exists.
 *
 * The fakes below are the smallest thing `BufferDeck` will accept: nodes that
 * record what was asked of them and a clock that does not move unless a test
 * moves it.
 */

interface FakeNode {
    buffer: null | { duration: number };
    connect: (destination: unknown) => void;
    connectedTo: unknown[];
    disconnected: number;
    onended: (() => void) | null;
    playbackRate: ReturnType<typeof gainParam>;
    started: [number, number][];
    stopped: number[];
}

/** An AudioParam that remembers every event it was given. */
const gainParam = () => ({
    cancelScheduledValues: vi.fn(),
    events: [] as Array<[string, number, number]>,
    exponentialRampToValueAtTime: vi.fn(function (this: unknown, value: number, time: number) {
        (this as { events: Array<[string, number, number]> }).events.push(['exp', time, value]);
    }),
    linearRampToValueAtTime: vi.fn(function (this: unknown, value: number, time: number) {
        (this as { events: Array<[string, number, number]> }).events.push(['linear', time, value]);
    }),
    setValueAtTime: vi.fn(function (this: unknown, value: number, time: number) {
        (this as { events: Array<[string, number, number]> }).events.push(['set', time, value]);
    }),
    value: 1,
});

const makeContext = () => {
    const nodes: FakeNode[] = [];
    const gainNodes: ReturnType<typeof gainParam>[] = [];
    const filters: Array<{
        frequency: ReturnType<typeof gainParam>;
        Q: { value: number };
        type: string;
    }> = [];
    const context = {
        createBiquadFilter: () => {
            const filter = {
                connect: () => {},
                disconnect: () => {},
                frequency: gainParam(),
                Q: { value: 0 },
                type: '',
            };
            filters.push(filter);
            return filter;
        },
        createBufferSource: () => {
            const node: FakeNode = {
                buffer: null,
                connect: () => {},
                connectedTo: [],
                disconnected: 0,
                onended: null,
                playbackRate: gainParam(),
                started: [],
                stopped: [],
            };
            const source = {
                ...node,
                connect: (destination: unknown) => {
                    node.connectedTo.push(destination);
                },
                disconnect: () => {
                    node.disconnected += 1;
                },
                start: (when: number, offset: number) => node.started.push([when, offset]),
                stop: (when?: number) => node.stopped.push(when ?? -1),
            };
            // `onended` is assigned by the deck after construction, so the
            // recorded node and the returned node have to be one object.
            Object.defineProperty(source, 'onended', {
                get: () => node.onended,
                set: (value) => {
                    node.onended = value;
                },
            });
            nodes.push(node);
            return source;
        },
        createGain: () => {
            const gain = gainParam();
            gainNodes.push(gain);
            return { connect: () => {}, disconnect: () => {}, gain };
        },
        currentTime: 0,
        decodeAudioData: () => Promise.resolve({ duration: decodedLength }),
        sampleRate: 44100,
    };
    return { context, filters, gainNodes, nodes };
};

let decodedLength = 200;

const JOIN = { kind: 'join' as const };

/** Decode `id` into the deck, so that `schedule` has something to schedule. */
const decode = async (deck: BufferDeck, id: string, durationSec: number) => {
    decodedLength = durationSec;
    await deck.prepare(id, `https://example.invalid/${id}`, durationSec);
};

describe('the buffer deck says what is audible, not what is committed', () => {
    let fake: ReturnType<typeof makeContext>;
    let deck: BufferDeck;
    let gains: GainNode[];

    beforeEach(() => {
        vi.stubGlobal('fetch', () =>
            Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)), ok: true }),
        );
        fake = makeContext();
        gains = [{} as GainNode, {} as GainNode];
        deck = new BufferDeck(fake.context as unknown as AudioContext, gains);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    /** Put `first` on the deck, playing from `at` on the context clock. */
    const engage = async (id: string, durationSec: number, at: number) => {
        await decode(deck, id, durationSec);
        deck.schedule({ gainIndex: 0, handover: JOIN, id, offsetSec: 0, startAtContextTime: at });
        deck.promote();
    };

    it('a committed join does not become the playing track until it starts', async () => {
        await engage('a', 200, 0);
        fake.context.currentTime = 198;

        await decode(deck, 'b', 240);
        const voice = deck.schedule({
            gainIndex: 1,
            handover: JOIN,
            id: 'b',
            offsetSec: 0,
            startAtContextTime: 200,
        });

        expect(voice).not.toBeNull();
        expect(deck.currentId()).toBe('a');
        expect(deck.positionSec(198)).toBe(198);
        expect(deck.currentDurationSec()).toBe(200);
        expect(deck.outgoing()).toEqual({
            kind: 'buffer',
            offsetSec: 0,
            startedAtContextTime: 0,
        });
    });

    it('the committed join becomes the playing track when it is promoted', async () => {
        await engage('a', 200, 0);
        await decode(deck, 'b', 240);
        deck.schedule({
            gainIndex: 1,
            handover: JOIN,
            id: 'b',
            offsetSec: 3,
            startAtContextTime: 200,
        });

        deck.promote();

        expect(deck.currentId()).toBe('b');
        expect(deck.currentDurationSec()).toBe(240);
        expect(deck.positionSec(210)).toBe(13);
    });

    // The join is a time on the audio clock and `promote` is called from a
    // timer, which can be a frame behind it. The deck must not spend that frame
    // saying nothing is playing: a quarter-second tick that caught it there
    // would read the deck as finished and hand the boundary back.
    it('the outgoing voice ending promotes the committed one by itself', async () => {
        await engage('a', 200, 0);
        await decode(deck, 'b', 240);
        deck.schedule({
            gainIndex: 1,
            handover: JOIN,
            id: 'b',
            offsetSec: 0,
            startAtContextTime: 200,
        });

        fake.nodes[0].onended?.();

        expect(deck.currentId()).toBe('b');
        expect(deck.outgoing()).not.toBeNull();
    });

    it('a track that ends with nothing committed leaves the deck empty', async () => {
        await engage('a', 200, 0);

        fake.nodes[0].onended?.();

        expect(deck.currentId()).toBeNull();
        expect(deck.outgoing()).toBeNull();
        expect(deck.positionSec(200)).toBeNull();
    });

    // Cancelling the join is most of what a hand-back is for: the element is
    // about to take the boundary and a source still armed for it would play the
    // next track over the top.
    it('releasing cancels a join that has been committed but not heard', async () => {
        await engage('a', 200, 0);
        fake.context.currentTime = 199;
        await decode(deck, 'b', 240);
        deck.schedule({
            gainIndex: 1,
            handover: JOIN,
            id: 'b',
            offsetSec: 0,
            startAtContextTime: 200,
        });

        deck.release();

        expect(fake.nodes[1].stopped.length).toBeGreaterThan(0);
        expect(fake.nodes[1].stopped.at(-1)).toBeLessThan(200);
        expect(deck.currentId()).toBeNull();
    });

    it('stopping disconnects a committed join as well as the playing one', async () => {
        await engage('a', 200, 0);
        await decode(deck, 'b', 240);
        deck.schedule({
            gainIndex: 1,
            handover: JOIN,
            id: 'b',
            offsetSec: 0,
            startAtContextTime: 200,
        });

        deck.stop();

        expect(fake.nodes[1].stopped.length).toBeGreaterThan(0);
        expect(deck.currentId()).toBeNull();
    });

    // The person's slider moves while a join is already armed more often than
    // not — it is the last two seconds of every exact handover.
    it('the volume reaches a committed join before it is heard', async () => {
        await engage('a', 200, 0);
        await decode(deck, 'b', 240);
        deck.schedule({
            gainIndex: 1,
            handover: JOIN,
            id: 'b',
            offsetSec: 0,
            startAtContextTime: 200,
        });

        deck.setVolume(0.25);

        // The fader the deck built for the committed voice — made before its
        // mix gain — not the one it built for the track that was playing, and
        // never the mix gain, which is the hand-over's.
        expect(fake.gainNodes.at(-2)?.linearRampToValueAtTime).toHaveBeenCalledWith(
            0.25,
            expect.any(Number),
        );
        expect(fake.gainNodes.at(-1)?.linearRampToValueAtTime).not.toHaveBeenCalled();
    });

    it('a cancelled join ending does not take the playing track with it', async () => {
        await engage('a', 200, 0);
        await decode(deck, 'b', 240);
        deck.schedule({
            gainIndex: 1,
            handover: JOIN,
            id: 'b',
            offsetSec: 0,
            startAtContextTime: 200,
        });

        fake.nodes[1].onended?.();
        deck.promote();

        expect(deck.currentId()).toBe('a');
        expect(deck.positionSec(100)).toBe(100);
    });

    // A released voice is still sounding — it has a fade to get through — so
    // the deck keeps hold of it until its own `ended` says it is gone. A
    // teardown before that has to find it and disconnect it, or the node
    // outlives the deck still wired to the output.
    it('a cancelled join is still the deck’s to tear down while it fades', async () => {
        await engage('a', 200, 0);
        fake.context.currentTime = 199;
        await decode(deck, 'b', 240);
        deck.schedule({
            gainIndex: 1,
            handover: JOIN,
            id: 'b',
            offsetSec: 0,
            startAtContextTime: 200,
        });

        deck.release(0.3);
        deck.stop();

        expect(fake.nodes[1].disconnected).toBeGreaterThan(0);
    });

    it('the join still stops the outgoing source on the sample the next one starts', async () => {
        await engage('a', 200, 0);
        await decode(deck, 'b', 240);
        deck.schedule({
            gainIndex: 1,
            handover: JOIN,
            id: 'b',
            offsetSec: 4,
            startAtContextTime: 200,
        });

        expect(fake.nodes[0].stopped).toEqual([200]);
        expect(fake.nodes[1].started).toEqual([[200, 4]]);
    });
});

/**
 * The three hand-overs, as the deck books them. The curves themselves are
 * `dj-schedule.ts`'s and tested there; what is checked here is that the deck
 * puts each event on the param it names, starts and stops the sources where
 * the booking says, and keeps telling the truth about what is playing while
 * a bent record settles.
 */
describe('the three hand-overs on one pair of voices', () => {
    let fake: ReturnType<typeof makeContext>;
    let deck: BufferDeck;

    /** Sixteen bars at 128 from 150 s, the incoming in at 15 s, bent up 2%. */
    const plan: DJTransition = {
        bars: 16,
        incomingRate: 1.02,
        incomingStartMs: 15_000,
        isKeyCompatible: true,
        outgoingRate: 1,
        outgoingStartMs: 150_000,
        restoreSeconds: 8,
        score: { energy: 1, key: 1, sections: 1, tempo: 1, vocals: 1 },
        seconds: 30,
        style: 'blend',
        targetBpm: 128,
    };

    beforeEach(() => {
        vi.stubGlobal('fetch', () =>
            Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)), ok: true }),
        );
        stretches = [];
        stretchAvailable = true;
        fake = makeContext();
        deck = new BufferDeck(fake.context as unknown as AudioContext, [
            {} as GainNode,
            {} as GainNode,
        ]);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const engage = async (id: string, durationSec: number, at: number) => {
        await decode(deck, id, durationSec);
        deck.schedule({ gainIndex: 0, handover: JOIN, id, offsetSec: 0, startAtContextTime: at });
        deck.promote();
    };

    /** The booking for `plan` against a record that started at 0 from 0. */
    const booking = (latency: number): MixBooking => {
        const result = planMixBooking({
            incomingDurationSec: 240,
            now: 148,
            outgoing: { kind: 'buffer', offsetSec: 0, startedAtContextTime: 0 },
            plan,
            stretchLatencySec: latency,
        });
        if (result.kind !== 'mix') throw new Error(result.reason);
        return result.booking;
    };

    it('a join starts the incoming voice at full mix gain and stops the outgoing on the sample', async () => {
        await engage('a', 200, 0);
        await decode(deck, 'b', 240);
        deck.schedule({
            gainIndex: 1,
            handover: JOIN,
            id: 'b',
            offsetSec: 4,
            startAtContextTime: 200,
        });

        expect(fake.nodes[1].started).toEqual([[200, 4]]);
        expect(fake.nodes[0].stopped).toEqual([200]);
        // Fader, mix gain, in that order, per voice; the join's mix gain is 1.
        expect(fake.gainNodes.at(-1)?.value).toBe(1);
        // No high-pass without Auto DJ: the graph is exactly what it was.
        expect(fake.filters).toHaveLength(0);
    });

    it('a blend overlaps the two on the clock and stops the outgoing at the end of it', async () => {
        await engage('a', 200, 0);
        await decode(deck, 'b', 240);
        deck.schedule({
            gainIndex: 1,
            handover: { kind: 'blend', seconds: 8 },
            id: 'b',
            offsetSec: 0,
            startAtContextTime: 192,
        });

        expect(fake.nodes[1].started).toEqual([[192, 0]]);
        expect(fake.nodes[0].stopped).toEqual([200]);
        // The incoming voice's mix gain starts silent and is ramped up; the
        // outgoing voice's mix gain is ramped down. Neither fader is touched.
        const incomingMix = fake.gainNodes.at(-1)!;
        const outgoingMix = fake.gainNodes[1];
        expect(incomingMix.value).toBe(0);
        expect(incomingMix.events[0]).toEqual(['set', 192, 0]);
        expect(incomingMix.events.at(-1)).toEqual(['linear', 200, 1]);
        expect(outgoingMix.events[0]).toEqual(['set', 192, 1]);
        expect(outgoingMix.events.at(-1)?.[0]).toBe('linear');
        expect(outgoingMix.events.at(-1)?.[1]).toBe(200);
        expect(outgoingMix.events.at(-1)?.[2]).toBeLessThan(1e-9);
        expect(fake.gainNodes[0].events).toEqual([]);
    });

    it('a blend from an element leaves the outgoing fader to the hook', async () => {
        await decode(deck, 'b', 240);
        deck.schedule({
            gainIndex: 1,
            handover: { kind: 'blend', seconds: 8 },
            id: 'b',
            offsetSec: 0,
            startAtContextTime: 192,
        });
        expect(fake.gainNodes.at(-1)?.events.length).toBeGreaterThan(1);
        expect(fake.gainNodes).toHaveLength(2);
    });

    it('with Auto DJ on every new voice carries a Butterworth high-pass parked at 20 Hz', async () => {
        deck.setAutoDj(true);
        await engage('a', 200, 0);
        expect(fake.filters).toHaveLength(1);
        expect(fake.filters[0].type).toBe('highpass');
        expect(fake.filters[0].Q.value).toBeCloseTo(-3.0103, 3);
        expect(fake.filters[0].frequency.value).toBe(20);
        // The source runs into the filter, not the mix gain.
        expect(fake.nodes[0].connectedTo).toEqual([fake.filters[0]]);
        expect(deck.canMixOut()).toBe(true);
    });

    it('a voice made before Auto DJ was switched on cannot be mixed out of', async () => {
        await engage('a', 200, 0);
        deck.setAutoDj(true);
        expect(deck.canMixOut()).toBe(false);
        await decode(deck, 'b', 240);
        await deck.prepareStretch(1);
        expect(
            deck.schedule({
                gainIndex: 1,
                handover: { booking: booking(0.12), kind: 'mix' },
                id: 'b',
                offsetSec: 15,
                startAtContextTime: 150,
            }),
        ).toBeNull();
    });

    it('a mix needs the slot’s stretch, and a stretch that cannot be had refuses the mix', async () => {
        deck.setAutoDj(true);
        await engage('a', 200, 0);
        await decode(deck, 'b', 240);
        // Not prepared: nothing to hold the pitch with.
        expect(
            deck.schedule({
                gainIndex: 1,
                handover: { booking: booking(0.12), kind: 'mix' },
                id: 'b',
                offsetSec: 15,
                startAtContextTime: 150,
            }),
        ).toBeNull();
        expect(deck.stretchLatencySec(1)).toBeNull();

        stretchAvailable = false;
        expect(await deck.prepareStretch(1)).toBeNull();
        expect(deck.stretchLatencySec(1)).toBeNull();
    });

    it('makes one stretch per slot and keeps it', async () => {
        const first = await deck.prepareStretch(1);
        const again = await deck.prepareStretch(1);
        expect(again).toBe(first);
        expect(stretches).toHaveLength(1);
        expect(deck.stretchLatencySec(1)).toBe(0.12);
        await deck.prepareStretch(0);
        expect(stretches).toHaveLength(2);
    });

    describe('a mix', () => {
        let mix: MixBooking;

        beforeEach(async () => {
            deck.setAutoDj(true);
            await engage('a', 200, 0);
            await decode(deck, 'b', 240);
            await deck.prepareStretch(1);
            mix = booking(0.12);
            fake.context.currentTime = 148;
            const voice = deck.schedule({
                gainIndex: 1,
                handover: { booking: mix, kind: 'mix' },
                id: 'b',
                offsetSec: mix.offsetSec,
                startAtContextTime: mix.startAtContextTime,
            });
            expect(voice).not.toBeNull();
        });

        it('starts the incoming source early by the stretch’s latency, through the stretch', () => {
            expect(fake.nodes[1].started).toEqual([[150 - 0.12, 15]]);
            expect(fake.nodes[1].connectedTo).toEqual([stretches[0].node]);
            expect(stretches[0].node.connect).toHaveBeenCalledWith(fake.filters[1]);
        });

        it('stops the outgoing record at the end of the mix, on its own clock', () => {
            // The outgoing voice has no stretch, so its stop is not shifted.
            expect(fake.nodes[0].stopped).toEqual([180]);
        });

        it('books the faders, the filters and the bend on the params they name', () => {
            const outgoingMix = fake.gainNodes[1];
            const incomingMix = fake.gainNodes[3];
            expect(outgoingMix.events[0]).toEqual(['set', 150, 1]);
            expect(outgoingMix.events.at(-1)?.[1]).toBe(180);
            expect(incomingMix.events[0]).toEqual(['set', 150, 0]);
            expect(incomingMix.events.at(-1)).toEqual(['linear', 165, 1]);

            const outgoingHz = fake.filters[0].frequency;
            const incomingHz = fake.filters[1].frequency;
            expect(outgoingHz.events).toEqual([
                ['set', 150, 20],
                ['set', 150 + 30 * 0.46, 20],
                ['exp', 150 + 30 * 0.54, 220],
            ]);
            expect(incomingHz.events).toEqual([
                ['set', 150, 220],
                ['set', 150 + 30 * 0.46, 220],
                ['exp', 150 + 30 * 0.54, 20],
            ]);

            const rate = fake.nodes[1].playbackRate;
            expect(rate.events).toEqual([
                ['set', 0, 1.02],
                ['set', 180 - 0.12, 1.02],
                ['linear', 188 - 0.12, 1],
            ]);

            expect(stretches[0].scheduleSemitones).toHaveBeenCalledTimes(65);
            expect(stretches[0].scheduleSemitones.mock.calls[0]).toEqual([
                150,
                -12 * Math.log2(1.02),
            ]);
            expect(stretches[0].scheduleSemitones.mock.calls.at(-1)).toEqual([188, 0]);
        });

        it('is the outgoing record until the mix starts, whatever the clock says', () => {
            expect(deck.currentId()).toBe('a');
            expect(deck.positionSec(149)).toBe(149);
        });

        it('once promoted, its position is the integral of the bend', () => {
            deck.promote();
            expect(deck.currentId()).toBe('b');
            expect(deck.positionSec(150)).toBe(15);
            expect(deck.positionSec(160)).toBeCloseTo(15 + 10.2, 12);
            expect(deck.positionSec(180)).toBeCloseTo(15 + 30.6, 12);
            expect(deck.positionSec(184)).toBeCloseTo(15 + 30.6 + 4 * 1.015, 12);
            expect(deck.positionSec(198)).toBeCloseTo(15 + 30.6 + 8 * 1.01 + 10, 12);
        });

        it('has no pair to plan the next hand-over against until the bend has settled', () => {
            deck.promote();
            fake.context.currentTime = 170;
            expect(deck.outgoing()).toBeNull();
            fake.context.currentTime = 187.999;
            expect(deck.outgoing()).toBeNull();
            fake.context.currentTime = 190;
            expect(deck.outgoing()).toEqual({
                kind: 'buffer',
                offsetSec: 15 + 30.6 + 8 * 1.01,
                startedAtContextTime: 188,
            });
        });

        it('is settling while the outgoing record is still sounding, and not after', () => {
            deck.promote();
            expect(deck.isSettling()).toBe(true);
            fake.nodes[0].onended?.();
            expect(deck.isSettling()).toBe(false);
            expect(deck.currentId()).toBe('b');
        });

        it('tells the indicator how far along it is, then nothing', () => {
            expect(deck.mixStatus(148)).toEqual({ bars: 16, phase: 'ready', progress: 0 });
            expect(deck.mixStatus(149)).toEqual({ bars: 16, phase: 'ready', progress: 0.5 });
            expect(deck.mixStatus(165)).toEqual({ bars: 16, phase: 'mixing', progress: 0.5 });
            expect(deck.mixStatus(180)).toBeNull();
            expect(deck.mixStatus(170)).toBeNull();
        });

        it('a release stops the stretched voice early by its latency and forgets the mix', () => {
            deck.promote();
            fake.context.currentTime = 160;
            deck.release(0.3);
            expect(fake.nodes[1].stopped.at(-1)).toBeCloseTo(160.3 - 0.12, 9);
            expect(fake.nodes[0].stopped.at(-1)).toBeCloseTo(160.3, 9);
            expect(deck.mixStatus(161)).toBeNull();
        });

        it('cuts only its own edge out of the shared stretch when it ends', () => {
            deck.promote();
            fake.nodes[1].onended?.();
            expect(stretches[0].node.disconnect).toHaveBeenCalledWith(fake.filters[1]);
            expect(stretches[0].node.disconnect).toHaveBeenCalledTimes(1);
        });
    });
});
