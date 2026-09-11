/**
 * The shape of `signalsmith-stretch`, which ships no types. Only the parts
 * the deck uses; the rest of the node's remote methods (`addBuffers`,
 * `dropBuffers`, `configure`) belong to its buffer mode, which the deck does
 * not use — see `pitch-stretch.ts` for why.
 */
declare module 'signalsmith-stretch' {
    export interface StretchNode extends AudioWorkletNode {
        latency(): Promise<number>;
        schedule(change: StretchSchedule): Promise<unknown>;
        start(when?: number): Promise<unknown>;
        stop(when?: number): Promise<unknown>;
    }

    /** A change to make at an output time, on the audible clock. */
    export interface StretchSchedule {
        active?: boolean;
        input?: number;
        output?: number;
        /**
         * The library prunes later changes against this field, not `output`,
         * so a caller scheduling ahead has to pass both.
         */
        outputTime?: number;
        rate?: number;
        semitones?: number;
        tonalityHz?: number;
    }

    interface CreateStretch {
        (context: BaseAudioContext, options?: AudioWorkletNodeOptions): Promise<StretchNode>;
        /** Where to load the worklet from instead of a Blob built from source. */
        moduleUrl?: string;
    }

    const SignalsmithStretch: CreateStretch;
    export default SignalsmithStretch;
}

declare module 'signalsmith-stretch?url' {
    const url: string;
    export default url;
}
