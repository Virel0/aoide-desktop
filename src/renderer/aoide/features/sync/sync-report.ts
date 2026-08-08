import type { SyncResult } from '/@/renderer/aoide/sync/sync-engine';
import type { SyncStatus } from '/@/shared/aoide/sync-types';

import { SyncError } from '/@/renderer/aoide/sync/errors';

/**
 * What a finished sync is entitled to claim, and in whose words.
 *
 * Separated from the panel because the panel cannot be tested here — the runner
 * is `node` with no jsdom, deliberately, since Feishin's renderer is not ours to
 * stand up. Everything below is therefore the part with rules in it, and the
 * component is left as markup over these results.
 */

export type AoideSyncPhase = 'error' | 'idle' | 'running' | 'success';

export interface AoideSyncState {
    /**
     * What failed outright, in the server's own words wherever the server said
     * any.
     *
     * `SyncError.displayMessage` deliberately carries the response body, and
     * three faults in this project were only ever diagnosed by reading it. It is
     * passed through, not summarised. Only failures that make the run an
     * `error` land here — see `warning` for the rest, because text in the error
     * colour under a line that says the sync succeeded is a contradiction the
     * reader has to resolve on the app's behalf.
     */
    error?: string;
    finishedAt?: number;
    phase: AoideSyncPhase;
    /** Present after a real sync — absent when only the reachability check ran. */
    result?: SyncResult;
    /** The server's own cursor, read when there was no local op log to push. */
    status?: SyncStatus;
    /** Something the run survived and the user should still know about. */
    warning?: string;
}

/**
 * Which claim the status line is allowed to make.
 *
 * `synced` and `checked` are the two that used to be one. A run with no op-log
 * bridge does nothing but ask the sidecar where it is; reporting that as "Last
 * synced" tells the user their edits went out when not one of them moved, and a
 * status line that claims work it did not do is worse than one that says
 * nothing. The distinction is drawn on evidence — a `result` only exists when
 * the loop really ran, a `status` only when the reachability check did — rather
 * than on `finishedAt`, which every path sets.
 */
export type SyncOutcome = 'checked' | 'failed' | 'idle' | 'running' | 'synced';

/**
 * One line of the run report: a counted headline and, where the server gave
 * one, its reason.
 */
export interface SyncReportEntry {
    /** How many ops or covers the headline is about, for the plural form. */
    count: number;
    /**
     * Why, verbatim, one distinct reason per line.
     *
     * Absent only when the server offered no words at all. Quarantine destroys
     * the user's edit permanently, so the one screen that reports it must say
     * what the server said — the same reason `displayMessage` is passed through
     * whole everywhere else in this panel.
     */
    detail?: string;
    /** i18n key, plural-aware on `count`. */
    key: string;
    tone: SyncReportTone;
}

/** A tone rather than a colour: the panel owns the theme variables, this does not. */
export type SyncReportTone = 'muted' | 'warning';

/** What a `SyncError` is worth saying, keeping the server's words when it gave any. */
export const describeSyncError = (error: unknown): string => {
    if (error instanceof SyncError) return error.displayMessage;
    return error instanceof Error ? error.message : String(error);
};

/**
 * Split a finished run's failures into the fatal and the survivable.
 *
 * `shareError` is the reason this is not one string. It means the push and the
 * pull both worked but the share list could not be re-read afterwards, so the
 * run is a success — while the old code, which put every error in one bucket,
 * drew it in the error colour underneath. The panel then said the sync
 * succeeded and showed an error for it in the same breath.
 */
export const syncMessages = (result: SyncResult): { error?: string; warning?: string } => ({
    error: joinLines([result.pushError, result.pullError].map(displayMessageOf)),
    warning: joinLines([displayMessageOf(result.shareError)]),
});

/**
 * Everything a finished run has to report beyond its counts.
 *
 * Ordered so that the destructive news comes first and `imageErrors` sits
 * directly under the held-back line it explains — that line has always said
 * changes are waiting on a cover upload and never once said why.
 */
export const syncReportEntries = (result: SyncResult): SyncReportEntry[] => {
    const entries: SyncReportEntry[] = [];

    if (result.quarantined.length > 0) {
        entries.push({
            count: result.quarantined.length,
            detail: joinLines(result.quarantined.map((outcome) => outcome.reason)),
            key: 'aoide.sync.quarantined',
            tone: 'warning',
        });
    }

    /*
     * `blocked`, not `revoked`. The two agree on the run that saw the refusal
     * and diverge on every run after it: a blocked op is never pushed again, so
     * it can never be refused again, and `revoked` — a report of what happened
     * *here* — is empty from then on. Reporting that one would name the person's
     * stuck edit exactly once and never mention it again.
     */
    if (result.blocked.length > 0) {
        entries.push({
            count: result.blocked.length,
            detail: joinLines(result.blocked.map((edit) => edit.reason)),
            key: 'aoide.sync.blocked',
            tone: 'warning',
        });
    }

    if (result.heldBack.length > 0) {
        entries.push({
            count: result.heldBack.length,
            key: 'aoide.sync.heldBack',
            tone: 'muted',
        });
    }

    if (result.imageErrors.length > 0) {
        entries.push({
            count: result.imageErrors.length,
            detail: joinLines(result.imageErrors.map(displayMessageOf)),
            key: 'aoide.sync.imageErrors',
            tone: 'warning',
        });
    }

    return entries;
};

/**
 * Which claim the status line may make about `state`.
 *
 * A failed run is never "synced". The engine sets `result` on every run it
 * completes, including one where the push and the pull both failed and nothing
 * moved, so keying off its presence alone printed "Last synced at 09:14" over a
 * run that synced nothing — the same false claim the reachability-only path was
 * already fixed for, arriving through the other door.
 */
export const syncOutcome = (state: AoideSyncState): SyncOutcome => {
    if (state.phase === 'running') return 'running';
    if (state.phase === 'error') return 'failed';
    if (state.result) return 'synced';
    if (state.status) return 'checked';
    return 'idle';
};

const displayMessageOf = (error: SyncError | undefined): string =>
    error === undefined ? '' : error.displayMessage;

/**
 * Distinct non-empty lines, in the order they were first said.
 *
 * Bisecting a 5xx quarantines each op alone, so ten refusals routinely carry one
 * sentence ten times; repeating it buries the count that is the actual news.
 * Empty strings are dropped rather than shown as blank lines — the server is
 * entitled to refuse without explaining, and the count still stands on its own.
 */
const joinLines = (lines: string[]): string | undefined => {
    const distinct = [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
    return distinct.length > 0 ? distinct.join('\n') : undefined;
};
