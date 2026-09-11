import { closeAllModals, openModal } from '@mantine/modals';
import { useQueryClient } from '@tanstack/react-query';
import isElectron from 'is-electron';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { isServerLock } from '/@/renderer/features/action-required/utils/window-properties';
import { ServerList } from '/@/renderer/features/servers/components/server-list';
import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useAuthStoreActions, useCurrentServer } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { ConfirmModal } from '/@/shared/components/modal/modal';
import { Text } from '/@/shared/components/text/text';

const localSettings = isElectron() ? window.api.localSettings : null;

/**
 * Who is signed in, where, and the way out.
 *
 * The phone's Account section. Signing out was previously only reachable from
 * the server dropdown in the sidebar, which is where you go to *switch*
 * servers — a different intention, and not where anybody looks for it.
 */
export const AccountTab = memo(() => {
    const { t } = useTranslation();
    const currentServer = useCurrentServer();
    const { logout } = useAuthStoreActions();
    const queryClient = useQueryClient();

    const handleLogout = async () => {
        const serverId = currentServer?.id;

        // Cancel in-flight requests before clearing credentials, or they retry
        // with an empty token and surface auth errors on the way out.
        await queryClient.cancelQueries();
        if (serverId) localSettings?.passwordRemove(serverId);
        logout();
        closeAllModals();

        // Deferred until the authenticated routes have unmounted.
        setTimeout(() => queryClient.clear(), 0);
    };

    const options: SettingOption[] = [
        {
            control: (
                <Text isMuted size="sm">
                    {currentServer?.username ?? ''}
                </Text>
            ),
            description: currentServer?.url ?? '',
            title: currentServer?.name ?? '',
        },
        {
            control: (
                <Button
                    onClick={() =>
                        openModal({
                            children: <ServerList />,
                            title: t('page.manageServers.title'),
                        })
                    }
                    variant="default"
                >
                    {t('page.appMenu.manageServers')}
                </Button>
            ),
            description: t('page.appMenu.manageServers', { context: 'description' }),
            isHidden: isServerLock(),
            title: t('page.appMenu.manageServers'),
        },
        {
            control: (
                <Button
                    onClick={() =>
                        openModal({
                            children: (
                                <ConfirmModal onConfirm={handleLogout}>
                                    <Text>{t('setting.signOut', { context: 'confirm' })}</Text>
                                </ConfirmModal>
                            ),
                            title: t('page.appMenu.logout'),
                        })
                    }
                    variant="state-error"
                >
                    {t('page.appMenu.logout')}
                </Button>
            ),
            description: t('setting.signOut', { context: 'description' }),
            isHidden: isServerLock(),
            title: t('page.appMenu.logout'),
        },
    ];

    return <SettingsSection options={options} title={t('page.setting.account')} />;
});
