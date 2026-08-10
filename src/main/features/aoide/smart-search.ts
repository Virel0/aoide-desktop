import { ipcMain, safeStorage } from 'electron';

import { store } from '../core/settings';

import log from '/@/main/logger';
import { buildPrompt, MusicQuery, parseQuery } from '/@/shared/aoide/smart-search';

/**
 * The OpenRouter side of natural-language search.
 *
 * **The key never leaves this process.** The renderer asks for a translation and
 * gets filters back; it cannot read the key, and neither can anything that ends
 * up running in the renderer — which is the whole reason the call lives here
 * rather than beside the search box. The renderer can ask whether a key is set,
 * because a settings screen has to say, and that is all.
 *
 * Stored through Electron's `safeStorage`, the same encrypted store Feishin
 * already uses for server passwords. Never in the repository, never in a plain
 * config file: this repository is meant to be publishable.
 */

const KEY_SETTING = 'openrouter_key';
const MODEL_SETTING = 'openrouter_model';

/**
 * A small, cheap, fast model by default.
 *
 * The task is translation into six fields from a closed vocabulary, which is
 * about the easiest thing a language model does. Paying for a frontier model per
 * search would be paying for reasoning this deliberately does not use.
 */
export const DEFAULT_MODEL = 'openai/gpt-4o-mini';

/** Long enough for a slow cold start, short enough that a search still feels like one. */
const REQUEST_TIMEOUT_MS = 15_000;

const readKey = (): null | string => {
    const encrypted = store.get(KEY_SETTING) as string | undefined;
    if (!encrypted) return null;

    if (!safeStorage.isEncryptionAvailable()) {
        log.warn('OpenRouter key present but encryption is unavailable');
        return null;
    }

    try {
        return safeStorage.decryptString(Buffer.from(encrypted, 'hex'));
    } catch (error) {
        // A key encrypted under a keyring this session cannot open is not
        // recoverable and not worth crashing a search over. Say so once.
        log.error('OpenRouter key could not be decrypted', error);
        return null;
    }
};

export interface SmartSearchOutcome {
    /** Null when there was no usable answer. The caller falls back to a plain search. */
    query: MusicQuery | null;
    /** Present only when something went wrong, in the service's own words. */
    reason?: string;
}

/**
 * Ask OpenRouter to translate a phrase into filters.
 *
 * Never throws at the caller. Every failure — no key, a refusal, a timeout, a
 * reply that is not JSON — comes back as `query: null` with a reason, because
 * the plain search is always available and a search box that throws is worse
 * than one that quietly does the ordinary thing.
 */
export const translate = async (phrase: string, genres: string[]): Promise<SmartSearchOutcome> => {
    const key = readKey();
    if (!key) return { query: null, reason: 'No OpenRouter key is set.' };

    const model = (store.get(MODEL_SETTING) as string | undefined) || DEFAULT_MODEL;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            body: JSON.stringify({
                messages: [{ content: buildPrompt(phrase, genres), role: 'user' }],
                model,
                // Translation, not composition. The same phrase should give the
                // same filters twice, or a search becomes a slot machine.
                temperature: 0,
            }),
            headers: {
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
                // OpenRouter attributes requests with these. Sending the app's
                // own name rather than upstream's is the honest answer.
                'HTTP-Referer': 'https://github.com/Virel0/aoide-desktop',
                'X-Title': 'Aoide',
            },
            method: 'POST',
            signal: controller.signal,
        });

        const body = await response.text();

        if (!response.ok) {
            // The service's own words, bounded. OpenRouter says useful things
            // here — out of credit, unknown model, invalid key — and replacing
            // them with "search failed" throws away the only thing that would
            // tell somebody what to do about it.
            log.error('OpenRouter refused a translation', { body, status: response.status });
            return {
                query: null,
                reason: `OpenRouter returned HTTP ${response.status}: ${body.slice(0, 200)}`,
            };
        }

        const content = readContent(body);
        if (content === null) {
            return { query: null, reason: 'OpenRouter returned a reply in an unfamiliar shape.' };
        }

        return { query: parseQuery(content, genres) };
    } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        return {
            query: null,
            reason: aborted
                ? 'OpenRouter did not answer in time.'
                : `Could not reach OpenRouter: ${error instanceof Error ? error.message : String(error)}`,
        };
    } finally {
        clearTimeout(timeout);
    }
};

const readContent = (body: string): null | string => {
    try {
        const parsed = JSON.parse(body) as {
            choices?: Array<{ message?: { content?: unknown } }>;
        };
        const content = parsed.choices?.[0]?.message?.content;
        return typeof content === 'string' ? content : null;
    } catch {
        return null;
    }
};

export const registerSmartSearchHandlers = (): void => {
    // Deliberately answers whether a key exists, never what it is.
    ipcMain.handle('aoide:smart-search-configured', () => readKey() !== null);

    ipcMain.handle(
        'aoide:smart-search-model',
        () => (store.get(MODEL_SETTING) as string | undefined) || DEFAULT_MODEL,
    );

    ipcMain.handle('aoide:smart-search-set-model', (_event, model: string) => {
        store.set(MODEL_SETTING, model.trim() || DEFAULT_MODEL);
    });

    ipcMain.handle('aoide:smart-search-set-key', (_event, key: string) => {
        const trimmed = key.trim();

        if (trimmed.length === 0) {
            store.delete(KEY_SETTING as never);
            log.info('OpenRouter key cleared');
            return true;
        }

        if (!safeStorage.isEncryptionAvailable()) {
            log.warn('Refusing to store an OpenRouter key without encryption');
            return false;
        }

        store.set(KEY_SETTING, safeStorage.encryptString(trimmed).toString('hex'));
        log.info('OpenRouter key saved');
        return true;
    });

    ipcMain.handle('aoide:smart-search-translate', (_event, phrase: string, genres: string[]) =>
        translate(phrase, genres),
    );
};
