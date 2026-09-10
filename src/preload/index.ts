import { contextBridge, webUtils } from 'electron';

import { aoide } from './aoide';
import { autodiscover } from './autodiscover';
import { browser } from './browser';
import { customThemes } from './custom-themes';
import { discordRpc } from './discord-rpc';
import { ipc } from './ipc';
import { localSettings } from './local-settings';
import { lyrics } from './lyrics';
import { mpris } from './mpris';
import { playerEvents } from './player-events';
import { remote } from './remote';
import { utils } from './utils';

// Custom APIs for renderer
const api = {
    aoide,
    autodiscover,
    browser,
    customThemes,
    discordRpc,
    getPathForFile: webUtils.getPathForFile,
    ipc,
    localSettings,
    lyrics,
    mpris,
    playerEvents,
    remote,
    utils,
};

export type PreloadApi = typeof api;

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
    try {
        contextBridge.exposeInMainWorld('api', api);
    } catch (error) {
        console.error(error);
    }
} else {
    // @ts-ignore (define in dts)
    window.api = api;
}
