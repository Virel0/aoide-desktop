import { Client, SetActivity } from '@xhayper/discord-rpc';
import { ipcMain } from 'electron';

import log from '/@/main/logger';

/**
 * Aoide's own registered Discord application.
 *
 * A Discord application id belongs to whoever registered it, and the name
 * Discord shows beside your status is that application's name — which is why
 * this was the one place the rename could not reach from inside the code:
 * until an Aoide application existed, presence announced the project this is
 * forked from, whatever the window said.
 *
 * Not a secret. An application id travels in every Rich Presence payload and is
 * readable by anyone who sees the status; the token that could act as the
 * application is not in this repository and is not needed here.
 */
const FALLBACK_DISCORD_APPLICATION_ID = '1547687515279069215';

let client: Client | null = null;

const createClient = async (clientId?: string) => {
    client = new Client({
        clientId: clientId || FALLBACK_DISCORD_APPLICATION_ID,
    });

    await client.login();

    return client;
};

const isConnected = () => {
    return client?.isConnected;
};

const setActivity = (activity: SetActivity) => {
    if (client) {
        void client.user?.setActivity({ ...activity }).catch((error) => {
            log.warn('Discord RPC set activity failed', error);
        });
    }
};

const clearActivity = () => {
    if (client) {
        void client.user?.clearActivity().catch((error) => {
            log.warn('Discord RPC clear activity failed', error);
        });
    }
};

const quit = () => {
    if (client) {
        void client.destroy().catch((error) => {
            log.error('Discord RPC destroy failed', error);
        });
    }
};

ipcMain.handle('discord-rpc-initialize', async (_event, clientId?: string) => {
    try {
        await createClient(clientId);
        log.info('Discord RPC initialized');
    } catch (error) {
        log.error('Discord RPC initialize failed', error);
        throw error;
    }
});

ipcMain.handle('discord-rpc-is-connected', () => {
    return isConnected();
});

ipcMain.handle('discord-rpc-set-activity', (_event, activity: SetActivity) => {
    setActivity(activity);
});

ipcMain.handle('discord-rpc-clear-activity', () => {
    clearActivity();
});

ipcMain.handle('discord-rpc-quit', () => {
    quit();
    client = null;
    log.info('Discord RPC quit');
});

export const discordRpc = {
    clearActivity,
    createClient,
    isConnected,
    quit,
    setActivity,
};
