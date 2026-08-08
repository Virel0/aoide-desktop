import { AoidePlaylistList } from '/@/renderer/aoide/features/playlists/aoide-playlist-list';
import { AnimatedPage } from '/@/renderer/features/shared/components/animated-page';
import { PageErrorBoundary } from '/@/renderer/features/shared/components/page-error-boundary';

/**
 * Feishin's route shape, followed exactly: an `AnimatedPage` inside a
 * `PageErrorBoundary`, default-exported so `app-router.tsx` can `lazy()` it.
 *
 * The boundary is not decoration. Everything on this page comes over IPC from a
 * SQLite database, and a schema this build cannot read throws on the first
 * query; the boundary turns that into a page saying so rather than a white
 * window with a console message nobody sees.
 */
const AoidePlaylistListRoute = () => (
    <AnimatedPage>
        <AoidePlaylistList />
    </AnimatedPage>
);

const AoidePlaylistListRouteWithBoundary = () => (
    <PageErrorBoundary>
        <AoidePlaylistListRoute />
    </PageErrorBoundary>
);

export default AoidePlaylistListRouteWithBoundary;
