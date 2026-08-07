import { Client, SetActivity } from '@xhayper/discord-rpc';
import { ipcMain } from 'electron';

import log from '/@/main/logger';

/**
 * Upstream Feishin's registered Discord application, kept as the fallback.
 *
 * A Discord application id belongs to whoever registered it, and the name
 * Discord shows beside your status is that application's name — so with this
 * id, Rich Presence announces "Feishin" no matter what the window says. It is
 * the one place the rename cannot reach from inside the code: fixing it means
 * registering an Aoide application at discord.com/developers and putting its id
 * in Settings, which is a human step with an account behind it.
 *
 * Left working rather than blanked. Presence under the wrong name is a smaller
 * problem than a feature that silently stops, and the setting to override it is
 * already there.
 */
const FALLBACK_DISCORD_APPLICATION_ID = '1165957668758900787';

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
