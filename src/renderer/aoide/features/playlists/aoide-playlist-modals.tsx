import type { PlaylistSummary, TrackInput } from '/@/main/features/aoide/playlists';

import { useTranslation } from 'react-i18next';

import i18n from '/@/i18n/i18n';
import { AoidePlaylistForm } from '/@/renderer/aoide/features/playlists/aoide-playlist-form';
import {
    notifyAoideError,
    useAddAoideTracks,
    useCreateAoidePlaylist,
    useDeleteAoidePlaylist,
    useRenameAoidePlaylist,
    useSetAoideNotes,
} from '/@/renderer/aoide/features/playlists/aoide-playlists-api';
import { closeAllModals, ConfirmModal, openModal } from '/@/shared/components/modal/modal';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';

/**
 * The three modals a playlist needs, and the functions that open them.
 *
 * Opened through `@mantine/modals` rather than by holding `opened` state in
 * every caller: the sidebar, the list page, the detail page and the track
 * context menu all offer "new playlist", and four copies of a disclosure hook
 * is four places for the form to drift.
 *
 * The bodies are ordinary components, so they can use the mutation hooks — the
 * modals provider renders them inside the app's React tree, which is the whole
 * reason this indirection is safe.
 */

export const openCreateAoidePlaylistModal = (options: CreateModalOptions = {}) => {
    openModal({
        children: <CreateAoidePlaylistModal {...options} />,
        title: i18n.t('aoide.form.createTitle'),
    });
};

/**
 * Confirm before soft-deleting.
 *
 * The wording names the consequence that is not obvious: the delete is an op,
 * so it reaches every device that syncs with this one. "Delete playlist" on a
 * local-sounding list reads like it only affects this machine.
 */
export const openDeleteAoidePlaylistModal = (playlist: PlaylistSummary, onDeleted?: () => void) => {
    openModal({
        children: <DeleteAoidePlaylistModal onDeleted={onDeleted} playlist={playlist} />,
        title: i18n.t('aoide.form.deleteTitle'),
    });
};

export const openEditAoidePlaylistModal = (playlist: PlaylistSummary) => {
    openModal({
        children: <EditAoidePlaylistModal playlist={playlist} />,
        title: i18n.t('aoide.form.editTitle'),
    });
};

interface CreateModalOptions {
    /** Called with the new playlist, after any tracks have been added to it. */
    onCreated?: (playlist: PlaylistSummary) => void;
    /** Tracks to put in it immediately — "add to a playlist that does not exist yet". */
    tracks?: TrackInput[];
}

const CreateAoidePlaylistModal = ({ onCreated, tracks }: CreateModalOptions) => {
    const { t } = useTranslation();
    const createMutation = useCreateAoidePlaylist();
    const addTracksMutation = useAddAoideTracks();

    const handleSubmit = async (values: { name: string; notes: null | string }) => {
        try {
            const playlist = await createMutation.mutateAsync({
                name: values.name,
                options: { notes: values.notes },
            });

            // Awaited rather than fired off, so the modal closes on a playlist
            // that already holds its tracks. Closing first and adding after is
            // how somebody sees an empty playlist and adds them a second time.
            if (tracks && tracks.length > 0) {
                await addTracksMutation.mutateAsync({ playlistId: playlist.id, tracks });
                toast.success({
                    message: t('aoide.toast.added', { count: tracks.length, name: playlist.name }),
                });
            }

            closeAllModals();
            onCreated?.(playlist);
        } catch (error) {
            notifyAoideError(error, t('aoide.form.createTitle'));
        }
    };

    return (
        <AoidePlaylistForm
            isPending={createMutation.isPending || addTracksMutation.isPending}
            onCancel={closeAllModals}
            onSubmit={(values) => void handleSubmit(values)}
            showNotes
            submitLabel={t('common.create')}
        />
    );
};

const DeleteAoidePlaylistModal = ({
    onDeleted,
    playlist,
}: {
    onDeleted?: () => void;
    playlist: PlaylistSummary;
}) => {
    const { t } = useTranslation();
    const deleteMutation = useDeleteAoidePlaylist();

    const handleConfirm = async () => {
        try {
            await deleteMutation.mutateAsync(playlist.id);
            closeAllModals();
            onDeleted?.();
        } catch (error) {
            notifyAoideError(error, t('aoide.form.deleteTitle'));
        }
    };

    return (
        <ConfirmModal
            labels={{ cancel: t('common.cancel'), confirm: t('common.delete') }}
            loading={deleteMutation.isPending}
            onConfirm={() => void handleConfirm()}
        >
            <Stack gap="sm">
                <Text>{t('aoide.form.deleteConfirm', { name: playlist.name })}</Text>
                <Text isMuted size="sm">
                    {t('aoide.form.deleteEverywhere')}
                </Text>
            </Stack>
        </ConfirmModal>
    );
};

/**
 * Name and notes, each written only if it changed.
 *
 * Two mutations rather than one, because the store has two calls and neither
 * takes the other's field. Skipping the unchanged one is not an optimisation:
 * every write is an op that every other device merges, and an op that changes
 * nothing still competes with a real edit somebody else made to that field in
 * the meantime — and wins it, being newer.
 */
const EditAoidePlaylistModal = ({ playlist }: { playlist: PlaylistSummary }) => {
    const { t } = useTranslation();
    const renameMutation = useRenameAoidePlaylist();
    const notesMutation = useSetAoideNotes();

    const handleSubmit = async (values: { name: string; notes: null | string }) => {
        try {
            if (values.name !== playlist.name) {
                await renameMutation.mutateAsync({ name: values.name, playlistId: playlist.id });
            }

            if (values.notes !== (playlist.notes ?? null)) {
                await notesMutation.mutateAsync({ notes: values.notes, playlistId: playlist.id });
            }

            closeAllModals();
        } catch (error) {
            notifyAoideError(error, t('aoide.form.editTitle'));
        }
    };

    return (
        <AoidePlaylistForm
            initialName={playlist.name}
            initialNotes={playlist.notes ?? ''}
            isPending={renameMutation.isPending || notesMutation.isPending}
            onCancel={closeAllModals}
            onSubmit={(values) => void handleSubmit(values)}
            showNotes
            submitLabel={t('common.save')}
        />
    );
};
