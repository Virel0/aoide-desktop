import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './aoide-now-playing-column.module.css';

import { useDJStatus } from '/@/renderer/aoide/features/playback/dj-status-store';
import { Text } from '/@/shared/components/text/text';

/**
 * "Mix ready · 16 bars", then "Mixing", with a bar that means something.
 *
 * Before the mix the bar fills across the wait between the booking and the
 * downbeat it starts on; during the mix it fills across the mix itself, so it
 * reaches the middle as the bass swaps and the end as the outgoing record is
 * gone. The deck publishes the fraction on its own tick, a quarter of a second
 * apart; the bar eases between them. Nothing is shown when nothing is booked,
 * which is most of the time: Auto DJ is a thing that happens sometimes.
 */
export const AoideDJIndicator = memo(() => {
    const { t } = useTranslation();
    const status = useDJStatus();

    if (!status) return null;

    const label =
        status.phase === 'ready'
            ? t('aoide.nowPlaying.mixReady', { count: status.bars })
            : t('aoide.nowPlaying.mixing');

    return (
        <div
            aria-label={label}
            aria-valuemax={1}
            aria-valuemin={0}
            aria-valuenow={status.progress}
            className={styles.djIndicator}
            role="progressbar"
        >
            <Text className={styles.djLabel} isMuted={status.phase === 'ready'} size="xs">
                {label}
            </Text>
            <div className={styles.djBar}>
                <div
                    className={status.phase === 'mixing' ? styles.djFillMixing : styles.djFillReady}
                    style={{ width: `${Math.round(status.progress * 1000) / 10}%` }}
                />
            </div>
        </div>
    );
});
