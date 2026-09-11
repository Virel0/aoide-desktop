import type { StretchNode } from 'signalsmith-stretch';

import SignalsmithStretch from 'signalsmith-stretch';
import workletUrl from 'signalsmith-stretch?url';

/**
 * The thing that lets a record be bent without being detuned.
 *
 * `playbackRate` on a buffer source shifts pitch with speed: a 3.7% bend is
 * 62 cents, most of a semitone, and against a record in another key that is
 * simply out of tune. The phone made this mistake with varispeed and
 * reversed it; here the pitch is held from the start. Signalsmith Stretch is
 * the one maintained pitch-preserving stretch that ships as an
 * `AudioWorklet`: MIT, an official release of the library the C++ world
 * uses, WASM embedded, updated in 2025.
 *
 * **Live input, not buffer mode.** The library can also hold a buffer and
 * play it at a rate itself, but that would make it the source, a second copy
 * of the decoded audio in the worklet's heap, and a start time compensated by
 * the library rather than one on `AudioBufferSourceNode.start(when)`. So the
 * source keeps the sample-accurate start and the memory model, `playbackRate`
 * does the tempo on the clock, and this node undoes the pitch by
 * `−12·log₂(rate)` semitones. In live mode its output is the input delayed
 * by a constant — `latency()` — which the booking arithmetic subtracts from
 * every source-side time.
 *
 * **A silent source is kept connected.** The worklet has two code paths, one
 * for live input and one for its own buffers, and picks by whether the input
 * has channels this quantum. A buffer source that has not started yet
 * contributes none, and the library's buffer path would run instead, seeking
 * its history every quantum. A `ConstantSourceNode` at zero keeps the live
 * path selected from the moment the node exists, so the delay is the same
 * delay throughout.
 *
 * **Nodes are reused, never discarded.** The worklet's `process` always
 * returns true, and the specification keeps such a node alive even once it
 * is disconnected, so a node per mix would be a WASM instance per mix for
 * the life of the context. The deck keeps one per slot instead.
 *
 * **Loaded as a file, not a Blob.** The library builds its worklet module
 * from `Function.prototype.toString` into a Blob URL, which a minifier can
 * break and which the app's content-security policy (`script-src 'self'`)
 * refuses anyway. `moduleUrl` points it at the shipped script as a bundled
 * asset instead — the package's own entry, which registers the processor
 * when it finds itself evaluated inside a worklet.
 */
export interface PitchStretch {
    /** What it adds between input and output, in seconds. Constant. */
    latencySec: number;
    /** The node to connect a voice into and out of. */
    node: AudioNode;
    /** Set the pitch shift at an output (audible) time, ahead of it. */
    scheduleSemitones: (outputTime: number, semitones: number) => void;
}

let moduleUrlSet = false;

/**
 * A stretch node on this context, or null when the worklet cannot be had —
 * an older Chromium, a context that is closed, a script that failed to load.
 * Null means no mix; the deck crossfades, and nothing is broken.
 */
export const createPitchStretch = async (context: AudioContext): Promise<null | PitchStretch> => {
    if (typeof context.audioWorklet === 'undefined') return null;
    if (!moduleUrlSet) {
        SignalsmithStretch.moduleUrl = workletUrl;
        moduleUrlSet = true;
    }

    let node: StretchNode;
    try {
        node = await SignalsmithStretch(context, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
        });
    } catch {
        return null;
    }

    const keepLive = context.createConstantSource();
    keepLive.offset.value = 0;
    keepLive.connect(node);
    keepLive.start();

    const latencySec = await node.latency();
    if (!Number.isFinite(latencySec) || latencySec < 0) return null;
    await node.start();

    return {
        latencySec,
        node,
        scheduleSemitones: (outputTime, semitones) => {
            void node.schedule({ output: outputTime, outputTime, semitones });
        },
    };
};
