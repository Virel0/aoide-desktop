import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isAoideAvailable } from '/@/renderer/aoide/features/shared/aoide-bridge';
import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Select } from '/@/shared/components/select/select';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { toast } from '/@/shared/components/toast/toast';

/**
 * Where the OpenRouter key is entered, and the only place it is ever typed.
 *
 * The field never shows a key back. There is no channel that returns one — the
 * key lives in the main process behind `safeStorage`, and this screen can only
 * ask whether one is set. So the input is always empty on open and a saved key
 * shows as a state, not as characters: nothing here can leak what it cannot
 * read.
 */
export const SmartSearchSettings = memo(() => {
    const { t } = useTranslation();
    const [configured, setConfigured] = useState(false);
    const [key, setKey] = useState('');
    const [model, setModel] = useState('');
    const [models, setModels] = useState<Array<{ label: string; value: string }>>([]);

    useEffect(() => {
        if (!isAoideAvailable()) return;

        void window.api.aoide.smartSearch.isConfigured().then(setConfigured);
        void window.api.aoide.smartSearch.model().then(setModel);

        void window.api.aoide.smartSearch.listModels().then((available) => {
            setModels(
                available.map((entry) => ({
                    // The price is the useful part of the label. The job here is
                    // turning a phrase into six fields, and the difference
                    // between models for that is mostly what it costs.
                    label: entry.promptPrice
                        ? `${entry.name} — $${(entry.promptPrice * 1_000_000).toFixed(2)}/M tokens`
                        : entry.name,
                    value: entry.id,
                })),
            );
        });
    }, []);

    // The web and remote builds have no main process, so there is nowhere safe
    // to keep a key and nothing to make the request. Offering the field there
    // would be offering a feature that cannot work.
    if (!isAoideAvailable()) return null;

    const saveKey = async () => {
        const stored = await window.api.aoide.smartSearch.setKey(key);

        if (!stored) {
            // The main process refuses to write a key it cannot encrypt. On
            // Linux that means no keyring is running, which is a real situation
            // and worth naming rather than failing silently.
            toast.error({ message: t('aoide.settings.keyNotEncrypted') });
            return;
        }

        setKey('');
        setConfigured(key.trim().length > 0);
        toast.success({
            message:
                key.trim().length > 0
                    ? t('aoide.settings.keySaved')
                    : t('aoide.settings.keyCleared'),
        });
    };

    const options: SettingOption[] = [
        {
            control: (
                <Group gap="sm">
                    <TextInput
                        aria-label={t('aoide.settings.key')}
                        onChange={(event) => setKey(event.currentTarget.value)}
                        placeholder={
                            configured
                                ? t('aoide.settings.keyStored')
                                : t('aoide.settings.keyPlaceholder')
                        }
                        type="password"
                        value={key}
                    />
                    <Button onClick={() => void saveKey()} variant="filled">
                        {key.trim().length === 0 && configured
                            ? t('aoide.settings.clear')
                            : t('common.save')}
                    </Button>
                </Group>
            ),
            description: t('aoide.settings.key', { context: 'description' }),
            title: t('aoide.settings.key'),
        },
        {
            control: (
                <Select
                    aria-label={t('aoide.settings.model')}
                    data={models}
                    onChange={(value) => {
                        if (!value) return;
                        setModel(value);
                        void window.api.aoide.smartSearch.setModel(value);
                    }}
                    // Typing is still allowed: OpenRouter adds models faster
                    // than any list is fetched, and somebody who knows the id
                    // they want should not be blocked by a stale catalogue.
                    searchable
                    value={model}
                />
            ),
            description: t('aoide.settings.model', { context: 'description' }),
            title: t('aoide.settings.model'),
        },
    ];

    return <SettingsSection options={options} />;
});
