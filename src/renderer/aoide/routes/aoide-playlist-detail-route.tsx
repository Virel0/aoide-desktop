import { useParams } from 'react-router';

import { AoidePlaylistDetail } from '/@/renderer/aoide/features/playlists/aoide-playlist-detail';
import { AnimatedPage } from '/@/renderer/features/shared/components/animated-page';
import { PageErrorBoundary } from '/@/renderer/features/shared/components/page-error-boundary';

const AoidePlaylistDetailRoute = () => {
    const { playlistId } = useParams() as { playlistId: string };

    return (
        // Keyed by the playlist, so navigating between two of them remounts
        // rather than animating one playlist's tracks into another's.
        <AnimatedPage key={`aoide-playlist-${playlistId}`}>
            <AoidePlaylistDetail playlistId={playlistId} />
        </AnimatedPage>
    );
};

const AoidePlaylistDetailRouteWithBoundary = () => (
    <PageErrorBoundary>
        <AoidePlaylistDetailRoute />
    </PageErrorBoundary>
);

export default AoidePlaylistDetailRouteWithBoundary;
