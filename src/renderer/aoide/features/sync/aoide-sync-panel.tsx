import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import styles from './aoide-sync-panel.module.css';

import { syncOutcome, syncReportEntries } from '/@/renderer/aoide/features/sync/sync-report';
import { useAoideSync } from '/@/renderer/aoide/features/sync/use-aoide-sync';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';

/**
 * Where a sync is started and what it did afterwards.
 *
 * Said plainly, and only what happened: never run, running, *checked* the server
 * was reachable, synced at a time, or failed with the server's own words. The
 * last one is the whole reason this panel is not a spinner in a corner — a sync
 * fails for reasons only the server knows ("playlist 'p1' belongs to another
 * user…", a proxy's login page arriving where JSON was expected), and every one
 * of those is in the text below, unsummarised.
 *
 * The fourth state is the one that had to be added. A build with no op-log
 * bridge does nothing but ask the sidecar where it is, and the panel used to
 * call that "Last synced" — a claim about the user's edits having gone out when
 * none of them had moved.
 */
export const AoideSyncPanel = () => {
    const { t } = useTranslation();
    const { canPushLocalEdits, hasServer, state, sync } = useAoideSync();

    const outcome = syncOutcome(state);
    const isRunning = outcome === 'running';
    const result = state.result;
    const finishedAt = state.finishedAt ? new Date(state.finishedAt).toLocaleTimeString() : '';

    return (
        <div className={styles.panel}>
            <div className={styles.header}>
                <div className={styles.status}>
                    <Icon
                        animate={isRunning ? 'spin' : undefined}
                        color={state.phase === 'error' ? 'error' : 'muted'}
                        icon={state.phase === 'error' ? 'error' : 'refresh'}
                    />
                    <Stack gap={0}>
                        <Text fw={600} size="md">
                            {t('aoide.sync.title')}
                        </Text>
                        <Text isMuted size="sm">
                            {outcome === 'running' && t('aoide.sync.running')}
                            {outcome === 'synced' &&
                                t('aoide.sync.lastSynced', { time: finishedAt })}
                            {outcome === 'checked' &&
                                t('aoide.sync.lastChecked', { time: finishedAt })}
                            {outcome === 'failed' &&
                                t('aoide.sync.lastFailed', { time: finishedAt })}
                            {outcome === 'idle' && t('aoide.sync.idle')}
                        </Text>
                    </Stack>
                </div>
                <Button
                    disabled={!hasServer}
                    leftSection={<Icon icon="refresh" />}
                    loading={isRunning}
                    onClick={() => void sync()}
                    variant="filled"
                >
                    {t('aoide.sync.now')}
                </Button>
            </div>

            {!hasServer && <Text className={styles.warning}>{t('aoide.sync.noServer')}</Text>}

            {hasServer && !canPushLocalEdits && (
                <Text className={styles.warning} size="sm">
                    {t('aoide.sync.noStoreBridge')}
                </Text>
            )}

            {result && (
                <Group gap="lg">
                    <Text isMuted size="sm">
                        {t('aoide.sync.summary', {
                            applied: result.applied,
                            pulled: result.pulled,
                            pushed: result.pushed,
                        })}
                    </Text>
                </Group>
            )}

            {/*
             * Each headline with the server's reason under it. Quarantine
             * destroys the user's edit and will not be retried, so a bare count
             * is the one thing this line must not be: whatever the server said
             * is the only evidence anybody will ever have about why.
             */}
            {result &&
                syncReportEntries(result).map((entry) => (
                    <Stack gap={0} key={entry.key}>
                        <Text
                            className={entry.tone === 'warning' ? styles.warning : undefined}
                            isMuted={entry.tone === 'muted'}
                            size="sm"
                        >
                            {t(entry.key, { count: entry.count })}
                        </Text>
                        {entry.detail && (
                            <Text className={clsx(styles.reason, styles.verbatim)} size="sm">
                                {entry.detail}
                            </Text>
                        )}
                    </Stack>
                ))}

            {state.status && (
                <Text isMuted size="sm">
                    {t('aoide.sync.serverCursor', { cursor: state.status.cursor })}
                </Text>
            )}

            {/*
             * A survivable failure, in its own colour. It used to be joined onto
             * `state.error` and drawn in the error colour beneath a line saying
             * the sync had succeeded — both at once, and the reader left to work
             * out which was true.
             */}
            {state.warning && (
                <Text className={clsx(styles.warning, styles.verbatim)} size="sm">
                    {state.warning}
                </Text>
            )}

            {state.error && (
                <Text className={clsx(styles.error, styles.verbatim)} size="sm">
                    {state.error}
                </Text>
            )}
        </div>
    );
};
