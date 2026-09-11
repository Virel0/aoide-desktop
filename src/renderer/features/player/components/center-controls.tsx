import { useTranslation } from 'react-i18next';

import styles from './center-controls.module.css';

import { MainPlayButton, PlayerButton } from '/@/renderer/features/player/components/player-button';
import { PlayerbarSlider } from '/@/renderer/features/player/components/playerbar-slider';
import { openShuffleAllModal } from '/@/renderer/features/player/components/shuffle-all-modal';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import {
    PLAYER_BUTTON_SIZE,
    usePlayerRepeat,
    usePlayerShuffle,
    usePlayerSongProperties,
    usePlayerStatus,
} from '/@/renderer/store';
import { Icon } from '/@/shared/components/icon/icon';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { PlayerRepeat, PlayerShuffle, PlayerStatus } from '/@/shared/types/types';

export const CenterControls = () => {
    return (
        <>
            <div className={styles.controlsContainer}>
                <div className={styles.buttonsContainer}>
                    <StopButton />
                    <ShuffleButton />
                    <PreviousButton />
                    <CenterPlayButton />
                    <NextButton />
                    <RepeatButton />
                    <ShuffleAllButton />
                </div>
            </div>
            <PlayerbarSlider />
        </>
    );
};

const StopButton = ({ disabled }: { disabled?: boolean }) => {
    const { t } = useTranslation();
    const { mediaStop } = usePlayer();

    return (
        <PlayerButton
            disabled={disabled}
            icon={<Icon fill="default" icon="mediaStop" size={PLAYER_BUTTON_SIZE - 2} />}
            onClick={() => mediaStop()}
            tooltip={{
                label: t('player.stop'),
                openDelay: 0,
            }}
            variant="tertiary"
        />
    );
};

const ShuffleButton = ({ disabled }: { disabled?: boolean }) => {
    const { t } = useTranslation();
    const shuffle = usePlayerShuffle();
    const { toggleShuffle } = usePlayer();

    return (
        <PlayerButton
            disabled={disabled}
            icon={
                <Icon
                    color={shuffle === PlayerShuffle.NONE ? 'default' : 'primary'}
                    icon="mediaShuffle"
                    size={PLAYER_BUTTON_SIZE}
                />
            }
            isActive={shuffle !== PlayerShuffle.NONE}
            onClick={toggleShuffle}
            tooltip={{
                label:
                    shuffle === PlayerShuffle.NONE
                        ? t('player.shuffle', {
                              context: 'off',
                          })
                        : t('player.shuffle'),
                openDelay: 0,
            }}
            variant="tertiary"
        />
    );
};

const PreviousButton = ({ disabled }: { disabled?: boolean }) => {
    const { t } = useTranslation();
    const { mediaPrevious } = usePlayer();

    return (
        <PlayerButton
            disabled={disabled}
            icon={<Icon fill="default" icon="mediaPrevious" size={PLAYER_BUTTON_SIZE} />}
            onClick={(e) => mediaPrevious(e.altKey)}
            tooltip={{
                label: (
                    <Stack gap="xs" justify="center">
                        <Text fw={500} ta="center">
                            {t('player.previous')}
                        </Text>
                        <Text fw={500} isMuted size="xs" ta="center">
                            {t('player.previousAlbum')}
                        </Text>
                    </Stack>
                ),
                openDelay: 0,
            }}
            variant="secondary"
        />
    );
};

const CenterPlayButton = ({ disabled }: { disabled?: boolean }) => {
    const { id: currentSongId } = usePlayerSongProperties(['id']) ?? {};

    const status = usePlayerStatus();
    const { mediaTogglePlayPause } = usePlayer();

    return (
        <MainPlayButton
            disabled={disabled || currentSongId === undefined}
            isPaused={status !== PlayerStatus.PLAYING}
            onClick={mediaTogglePlayPause}
        />
    );
};

const NextButton = ({ disabled }: { disabled?: boolean }) => {
    const { t } = useTranslation();
    const { mediaNext } = usePlayer();

    return (
        <PlayerButton
            disabled={disabled}
            icon={<Icon fill="default" icon="mediaNext" size={PLAYER_BUTTON_SIZE} />}
            onClick={(e) => mediaNext(e.altKey)}
            tooltip={{
                label: (
                    <Stack gap="xs" justify="center">
                        <Text fw={500} ta="center">
                            {t('player.next')}
                        </Text>
                        <Text fw={500} isMuted size="xs" ta="center">
                            {t('player.nextAlbum')}
                        </Text>
                    </Stack>
                ),
                openDelay: 0,
            }}
            variant="secondary"
        />
    );
};

const RepeatButton = ({ disabled }: { disabled?: boolean }) => {
    const { t } = useTranslation();
    const repeat = usePlayerRepeat();
    const { toggleRepeat } = usePlayer();

    return (
        <PlayerButton
            disabled={disabled}
            icon={
                repeat === PlayerRepeat.ONE ? (
                    <Icon fill="primary" icon="mediaRepeatOne" size={PLAYER_BUTTON_SIZE} />
                ) : (
                    <Icon
                        fill={repeat === PlayerRepeat.NONE ? 'default' : 'primary'}
                        icon="mediaRepeat"
                        size={PLAYER_BUTTON_SIZE}
                    />
                )
            }
            isActive={repeat !== PlayerRepeat.NONE}
            onClick={toggleRepeat}
            tooltip={{
                label: `${
                    repeat === PlayerRepeat.NONE
                        ? t('player.repeat', {
                              context: 'off',
                          })
                        : repeat === PlayerRepeat.ALL
                          ? t('player.repeat', {
                                context: 'all',
                            })
                          : t('player.repeat', {
                                context: 'one',
                            })
                }`,
                openDelay: 0,
            }}
            variant="tertiary"
        />
    );
};

const ShuffleAllButton = ({ disabled }: { disabled?: boolean }) => {
    const { t } = useTranslation();

    return (
        <PlayerButton
            disabled={disabled}
            icon={<Icon fill="default" icon="mediaRandom" size={PLAYER_BUTTON_SIZE} />}
            onClick={() => openShuffleAllModal()}
            tooltip={{
                label: t('form.shuffleAll.title'),
                openDelay: 0,
            }}
            variant="tertiary"
        />
    );
};
