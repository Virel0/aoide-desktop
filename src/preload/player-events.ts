import { ipcRenderer } from 'electron';

import { PlayerData } from '/@/shared/types/domain-types';

/**
 * The renderer's end of the `renderer-player-*` channels.
 *
 * These used to live in `mpv-player.ts` beside the commands that drove the mpv
 * process, which read as though they were mpv's. They are not, and never were:
 * every one of them is the desktop asking the renderer to do something the
 * person just asked for somewhere outside the window — a media key, the tray,
 * the dock, the app menu, a global hotkey, MPRIS, or the remote server. The
 * commands went with mpv; this stayed, under its own name.
 */

const rendererNext = (cb: (data: PlayerData) => void) => {
    ipcRenderer.on('renderer-player-next', (_, data) => cb(data));
};

const rendererNextAlbum = (cb: (data: PlayerData) => void) => {
    ipcRenderer.on('renderer-player-next-album', (_, data) => cb(data));
};

const rendererPause = (cb: (data: PlayerData) => void) => {
    ipcRenderer.on('renderer-player-pause', (_, data) => cb(data));
};

const rendererPlay = (cb: (data: PlayerData) => void) => {
    ipcRenderer.on('renderer-player-play', (_, data) => cb(data));
};

const rendererPlayPause = (cb: (data: PlayerData) => void) => {
    ipcRenderer.on('renderer-player-play-pause', (_, data) => cb(data));
};

const rendererPrevious = (cb: (data: PlayerData) => void) => {
    ipcRenderer.on('renderer-player-previous', (_, data) => cb(data));
};

const rendererPreviousAlbum = (cb: (data: PlayerData) => void) => {
    ipcRenderer.on('renderer-player-previous-album', (_, data) => cb(data));
};

const rendererSkipBackward = (cb: (data: PlayerData) => void) => {
    ipcRenderer.on('renderer-player-skip-backward', (_, data) => cb(data));
};

const rendererSkipForward = (cb: (data: PlayerData) => void) => {
    ipcRenderer.on('renderer-player-skip-forward', (_, data) => cb(data));
};

const rendererStop = (cb: (data: PlayerData) => void) => {
    ipcRenderer.on('renderer-player-stop', (_, data) => cb(data));
};

const rendererToggleRepeat = (cb: (data: PlayerData) => void) => {
    ipcRenderer.on('renderer-player-toggle-repeat', (_, data) => cb(data));
};

const rendererToggleShuffle = (cb: (data: PlayerData) => void) => {
    ipcRenderer.on('renderer-player-toggle-shuffle', (_, data) => cb(data));
};

const rendererVolumeDown = (cb: (data: PlayerData) => void) => {
    ipcRenderer.on('renderer-player-volume-down', (_, data) => cb(data));
};

const rendererVolumeMute = (cb: (data: PlayerData) => void) => {
    ipcRenderer.on('renderer-player-volume-mute', (_, data) => cb(data));
};

const rendererVolumeUp = (cb: (data: PlayerData) => void) => {
    ipcRenderer.on('renderer-player-volume-up', (_, data) => cb(data));
};

export const playerEvents = {
    rendererNext,
    rendererNextAlbum,
    rendererPause,
    rendererPlay,
    rendererPlayPause,
    rendererPrevious,
    rendererPreviousAlbum,
    rendererSkipBackward,
    rendererSkipForward,
    rendererStop,
    rendererToggleRepeat,
    rendererToggleShuffle,
    rendererVolumeDown,
    rendererVolumeMute,
    rendererVolumeUp,
};

export type PlayerEvents = typeof playerEvents;
