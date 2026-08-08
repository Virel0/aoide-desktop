import { useTranslation } from 'react-i18next';

import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Stack } from '/@/shared/components/stack/stack';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Textarea } from '/@/shared/components/textarea/textarea';
import { useForm } from '/@/shared/hooks/use-form';

interface AoidePlaylistFormProps {
    initialName?: string;
    initialNotes?: string;
    isPending?: boolean;
    onCancel: () => void;
    onSubmit: (values: { name: string; notes: null | string }) => void;
    /** Rename reuses this form without the notes field, which it does not change. */
    showNotes?: boolean;
    submitLabel: string;
}

/**
 * Name — and optionally notes — for a playlist being made or renamed.
 *
 * One component for both because the two differ only in which fields they show
 * and what the button says. A second, nearly identical form is how the two
 * quietly stop validating the same way.
 *
 * The name is trimmed and required. An empty name is accepted by the store —
 * it has no opinion about names — and produces a row that is impossible to
 * pick out of a sidebar afterwards.
 */
export const AoidePlaylistForm = ({
    initialName = '',
    initialNotes = '',
    isPending,
    onCancel,
    onSubmit,
    showNotes,
    submitLabel,
}: AoidePlaylistFormProps) => {
    const { t } = useTranslation();

    const form = useForm({
        initialValues: { name: initialName, notes: initialNotes },
        validate: {
            name: (value: string) =>
                value.trim().length > 0 ? null : t('aoide.form.nameRequired'),
        },
    });

    const handleSubmit = form.onSubmit((values) => {
        const notes = values.notes.trim();
        onSubmit({ name: values.name.trim(), notes: notes.length > 0 ? notes : null });
    });

    return (
        <form onSubmit={handleSubmit}>
            <Stack gap="md">
                <TextInput
                    autoFocus
                    label={t('aoide.form.nameLabel')}
                    maxLength={200}
                    placeholder={t('aoide.form.namePlaceholder')}
                    {...form.getInputProps('name')}
                />
                {showNotes && (
                    <Textarea
                        autosize
                        label={t('aoide.form.notesLabel')}
                        maxLength={2000}
                        minRows={2}
                        {...form.getInputProps('notes')}
                    />
                )}
                <Group gap="sm" justify="flex-end">
                    <Button onClick={onCancel} type="button" variant="subtle">
                        {t('common.cancel')}
                    </Button>
                    <Button loading={isPending} type="submit" variant="filled">
                        {submitLabel}
                    </Button>
                </Group>
            </Stack>
        </form>
    );
};
