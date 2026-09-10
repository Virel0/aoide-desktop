import isElectron from 'is-electron';
import { useEffect } from 'react';

import { useIsRadioActive } from '/@/renderer/features/radio/hooks/use-radio-player';
import { usePlayerActions, useVolumeWheelStep } from '/@/renderer/store';

const playerEvents = isElectron() ? window.api.playerEvents : null;
const ipc = isElectron() ? window.api.ipc : null;

export const useMainPlayerListener = () => {
    const isRadioActive = useIsRadioActive();
    const volumeWheelStep = useVolumeWheelStep();
    const {
        decreaseVolume,
        increaseVolume,
        mediaNext,
        mediaPause,
        mediaPlay,
        mediaPrevious,
        mediaSkipBackward,
        mediaSkipForward,
        mediaStop,
        mediaToggleMute,
        mediaTogglePlayPause,
        toggleRepeat,
        toggleShuffle,
    } = usePlayerActions();

    useEffect(() => {
        if (!playerEvents) {
            return;
        }

        playerEvents.rendererPlayPause(() => {
            if (!isRadioActive) {
                mediaTogglePlayPause();
            }
        });

        playerEvents.rendererNext(() => {
            if (!isRadioActive) {
                mediaNext(false);
            }
        });

        playerEvents.rendererNextAlbum(() => {
            if (!isRadioActive) {
                mediaNext(true);
            }
        });

        playerEvents.rendererPrevious(() => {
            if (!isRadioActive) {
                mediaPrevious(false);
            }
        });

        playerEvents.rendererPreviousAlbum(() => {
            if (!isRadioActive) {
                mediaPrevious(true);
            }
        });

        playerEvents.rendererPlay(() => {
            if (!isRadioActive) {
                mediaPlay();
            }
        });

        playerEvents.rendererPause(() => {
            if (!isRadioActive) {
                mediaPause();
            }
        });

        playerEvents.rendererStop(() => {
            if (!isRadioActive) {
                // `reset: false` here was mpv's: it had already stopped itself
                // by the time this arrived, so the seek was redundant. The web
                // player has not, and without the seek Stop leaves the element
                // parked mid-track for the next Play to resume from.
                mediaStop();
            }
        });

        playerEvents.rendererSkipForward(() => {
            mediaSkipForward();
        });

        playerEvents.rendererSkipBackward(() => {
            mediaSkipBackward();
        });

        playerEvents.rendererToggleShuffle(() => {
            toggleShuffle();
        });

        playerEvents.rendererToggleRepeat(() => {
            toggleRepeat();
        });

        playerEvents.rendererVolumeMute(() => {
            mediaToggleMute();
        });

        playerEvents.rendererVolumeUp(() => {
            increaseVolume(volumeWheelStep);
        });

        playerEvents.rendererVolumeDown(() => {
            decreaseVolume(volumeWheelStep);
        });

        return () => {
            ipc?.removeAllListeners('renderer-player-play-pause');
            ipc?.removeAllListeners('renderer-player-next');
            ipc?.removeAllListeners('renderer-player-previous');
            ipc?.removeAllListeners('renderer-player-play');
            ipc?.removeAllListeners('renderer-player-pause');
            ipc?.removeAllListeners('renderer-player-stop');
            ipc?.removeAllListeners('renderer-player-skip-forward');
            ipc?.removeAllListeners('renderer-player-skip-backward');
            ipc?.removeAllListeners('renderer-player-toggle-shuffle');
            ipc?.removeAllListeners('renderer-player-toggle-repeat');
            ipc?.removeAllListeners('renderer-player-volume-mute');
            ipc?.removeAllListeners('renderer-player-volume-up');
            ipc?.removeAllListeners('renderer-player-volume-down');
        };
    }, [
        decreaseVolume,
        increaseVolume,
        isRadioActive,
        mediaNext,
        mediaPause,
        mediaPlay,
        mediaPrevious,
        mediaSkipForward,
        mediaSkipBackward,
        mediaStop,
        mediaToggleMute,
        mediaTogglePlayPause,
        toggleRepeat,
        toggleShuffle,
        volumeWheelStep,
    ]);
};

const MainPlayerListenerHookInner = () => {
    useMainPlayerListener();
    return null;
};

export const MainPlayerListenerHook = () => {
    if (!isElectron()) {
        return null;
    }

    return <MainPlayerListenerHookInner />;
};
