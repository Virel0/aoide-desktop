import type { MusicQuery } from '/@/shared/aoide/smart-search';

import { useCallback, useEffect, useState } from 'react';

import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import { looksLikeAPhrase } from '/@/shared/aoide/smart-search';

export interface SmartSearchState {
    /** True while OpenRouter is being asked. */
    interpreting: boolean;
    /** What the phrase was understood to mean, or null before anything was asked. */
    query: MusicQuery | null;
    /** Why there is no query, in the service's own words. */
    reason: null | string;
}

const IDLE: SmartSearchState = { interpreting: false, query: null, reason: null };

/**
 * Translating a description into filters, on demand.
 *
 * **Never on a keystroke.** Every call is a paid request, and a search box that
 * asked a hosted model per character would cost real money to type a sentence
 * into. The caller decides when — on Enter, or on a button — which is also the
 * only moment a person has finished saying what they meant.
 *
 * Available only when a key is set and only for a real phrase. One or two words
 * is a name, and the plain search already handles names better than any
 * interpretation of them would.
 */
export const useSmartSearch = () => {
    const [configured, setConfigured] = useState(false);
    const [state, setState] = useState<SmartSearchState>(IDLE);

    useEffect(() => {
        if (!isAoideAvailable()) return;
        void window.api.aoide.smartSearch.isConfigured().then(setConfigured);
    }, []);

    const interpret = useCallback(
        async (phrase: string, genreNames: string[]) => {
            if (!configured || !looksLikeAPhrase(phrase)) return;

            setState({ interpreting: true, query: null, reason: null });

            const outcome = await window.api.aoide.smartSearch.translate(phrase, genreNames);

            setState({
                interpreting: false,
                query: outcome.query,
                // A translation that produced nothing is not an error worth a red
                // box — the plain results are already on screen underneath. It is
                // worth saying, though, or the button looks broken.
                reason: outcome.reason ?? null,
            });
        },
        [configured],
    );

    const clear = useCallback(() => setState(IDLE), []);

    return {
        /** Whether the description path can be offered at all. */
        canInterpret: configured,
        clear,
        interpret,
        ...state,
    };
};
