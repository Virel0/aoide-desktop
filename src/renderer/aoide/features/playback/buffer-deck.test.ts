import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BufferDeck } from './buffer-deck';

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
    disconnected: number;
    onended: (() => void) | null;
    started: [number, number][];
    stopped: number[];
}

const gainParam = () => ({
    cancelScheduledValues: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    setValueAtTime: vi.fn(),
    value: 1,
});

const makeContext = () => {
    const nodes: FakeNode[] = [];
    const gainNodes: ReturnType<typeof gainParam>[] = [];
    const context = {
        createBufferSource: () => {
            const node: FakeNode = {
                buffer: null,
                connect: () => {},
                disconnected: 0,
                onended: null,
                started: [],
                stopped: [],
            };
            const source = {
                ...node,
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
    return { context, gainNodes, nodes };
};

let decodedLength = 200;

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
        deck.schedule({ gainIndex: 0, id, offsetSec: 0, startAtContextTime: at });
        deck.promote();
    };

    it('a committed join does not become the playing track until it starts', async () => {
        await engage('a', 200, 0);
        fake.context.currentTime = 198;

        await decode(deck, 'b', 240);
        const voice = deck.schedule({
            gainIndex: 1,
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
        deck.schedule({ gainIndex: 1, id: 'b', offsetSec: 3, startAtContextTime: 200 });

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
        deck.schedule({ gainIndex: 1, id: 'b', offsetSec: 0, startAtContextTime: 200 });

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
        deck.schedule({ gainIndex: 1, id: 'b', offsetSec: 0, startAtContextTime: 200 });

        deck.release();

        expect(fake.nodes[1].stopped.length).toBeGreaterThan(0);
        expect(fake.nodes[1].stopped.at(-1)).toBeLessThan(200);
        expect(deck.currentId()).toBeNull();
    });

    it('stopping disconnects a committed join as well as the playing one', async () => {
        await engage('a', 200, 0);
        await decode(deck, 'b', 240);
        deck.schedule({ gainIndex: 1, id: 'b', offsetSec: 0, startAtContextTime: 200 });

        deck.stop();

        expect(fake.nodes[1].stopped.length).toBeGreaterThan(0);
        expect(deck.currentId()).toBeNull();
    });

    // The person's slider moves while a join is already armed more often than
    // not — it is the last two seconds of every exact handover.
    it('the volume reaches a committed join before it is heard', async () => {
        await engage('a', 200, 0);
        await decode(deck, 'b', 240);
        deck.schedule({ gainIndex: 1, id: 'b', offsetSec: 0, startAtContextTime: 200 });

        deck.setVolume(0.25);

        // The gain node the deck built for the committed voice, not the one it
        // built for the track that was playing.
        expect(fake.gainNodes.at(-1)?.linearRampToValueAtTime).toHaveBeenCalledWith(
            0.25,
            expect.any(Number),
        );
    });

    it('a cancelled join ending does not take the playing track with it', async () => {
        await engage('a', 200, 0);
        await decode(deck, 'b', 240);
        deck.schedule({ gainIndex: 1, id: 'b', offsetSec: 0, startAtContextTime: 200 });

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
        deck.schedule({ gainIndex: 1, id: 'b', offsetSec: 0, startAtContextTime: 200 });

        deck.release(0.3);
        deck.stop();

        expect(fake.nodes[1].disconnected).toBeGreaterThan(0);
    });

    it('the join still stops the outgoing source on the sample the next one starts', async () => {
        await engage('a', 200, 0);
        await decode(deck, 'b', 240);
        deck.schedule({ gainIndex: 1, id: 'b', offsetSec: 4, startAtContextTime: 200 });

        expect(fake.nodes[0].stopped).toEqual([200]);
        expect(fake.nodes[1].started).toEqual([[200, 4]]);
    });
});
