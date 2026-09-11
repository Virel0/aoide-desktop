import isElectron from 'is-electron';
import { memo } from 'react';
import { Fragment } from 'react/jsx-runtime';

import { ExportImportSettings } from '/@/renderer/features/settings/components/advanced/export-import-settings';
import { LoggerSettings } from '/@/renderer/features/settings/components/advanced/logger-settings';
import { CacheSettings } from '/@/renderer/features/settings/components/window/cache-settngs';
import { DiscordSettings } from '/@/renderer/features/settings/components/window/discord-settings';
import { MediaKeysSettings } from '/@/renderer/features/settings/components/window/media-keys-settings';
import { PasswordSettings } from '/@/renderer/features/settings/components/window/password-settings';
import { UpdateSettings } from '/@/renderer/features/settings/components/window/update-settings';
import { WindowSettings } from '/@/renderer/features/settings/components/window/window-settings';
import { Divider } from '/@/shared/components/divider/divider';
import { Stack } from '/@/shared/components/stack/stack';

const utils = isElectron() ? window.api.utils : null;

/**
 * What the app is on this computer rather than what it plays.
 *
 * The window and the tray, the media keys, Discord, the keyring, updates, and
 * the two things worth having when something goes wrong: the settings file and
 * the log level. The Advanced tab used to hold that last group; it was a tab
 * whose name told a person nothing about what was inside it.
 */
const sections = [
    { component: WindowSettings, key: 'window' },
    { component: MediaKeysSettings, key: 'media-keys' },
    { component: DiscordSettings, key: 'discord' },
    { component: PasswordSettings, hidden: !utils?.isLinux(), key: 'password' },
    { component: UpdateSettings, key: 'update' },
    { component: ExportImportSettings, key: 'export-import' },
    { component: LoggerSettings, key: 'logger' },
    { component: CacheSettings, key: 'cache' },
];

export const SystemTab = memo(() => {
    return (
        <Stack gap="md">
            {sections.map(({ component: Section, hidden, key }, index) => (
                <Fragment key={key}>
                    {!hidden && <Section />}
                    {index < sections.length - 1 && <Divider />}
                </Fragment>
            ))}
        </Stack>
    );
});
