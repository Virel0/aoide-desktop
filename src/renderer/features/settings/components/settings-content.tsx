import isElectron from 'is-electron';
import { useTranslation } from 'react-i18next';

import styles from './settings-content.module.css';

import { AccountTab } from '/@/renderer/features/settings/components/account/account-tab';
import { GeneralTab } from '/@/renderer/features/settings/components/general/general-tab';
import { PlaybackTab } from '/@/renderer/features/settings/components/playback/playback-tab';
import { SystemTab } from '/@/renderer/features/settings/components/window/system-tab';
import { LibraryContainer } from '/@/renderer/features/shared/components/library-container';
import { useSettingsStore, useSettingsStoreActions } from '/@/renderer/store/settings.store';
import { Tabs } from '/@/shared/components/tabs/tabs';

export const SettingsContent = () => {
    const { t } = useTranslation();
    const currentTab = useSettingsStore((state) => state.tab);
    const { setSettings } = useSettingsStoreActions();

    return (
        <LibraryContainer>
            <div className={styles.scrollContainer}>
                <Tabs
                    keepMounted={false}
                    onChange={(e) => e && setSettings({ tab: e })}
                    orientation="horizontal"
                    value={currentTab}
                    variant="default"
                >
                    <Tabs.List>
                        <Tabs.Tab value="general">{t('page.setting.generalTab')}</Tabs.Tab>
                        <Tabs.Tab value="playback">{t('page.setting.playbackTab')}</Tabs.Tab>
                        {isElectron() && (
                            <Tabs.Tab value="system">{t('page.setting.systemTab')}</Tabs.Tab>
                        )}
                        <Tabs.Tab value="account">{t('page.setting.account')}</Tabs.Tab>
                    </Tabs.List>
                    <Tabs.Panel value="general">
                        <GeneralTab />
                    </Tabs.Panel>
                    <Tabs.Panel value="playback">
                        <PlaybackTab />
                    </Tabs.Panel>
                    {isElectron() && (
                        <Tabs.Panel value="system">
                            <SystemTab />
                        </Tabs.Panel>
                    )}
                    <Tabs.Panel value="account">
                        <AccountTab />
                    </Tabs.Panel>
                </Tabs>
            </div>
        </LibraryContainer>
    );
};
