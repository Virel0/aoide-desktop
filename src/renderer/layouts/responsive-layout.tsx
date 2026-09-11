import { useMemo } from 'react';
import { useNavigate } from 'react-router';

import { CommandPalette } from '/@/renderer/features/search/components/command-palette';
import { useGarbageCollection } from '/@/renderer/hooks/use-garbage-collection';
import { HotkeyItem, useHotkeys } from '/@/renderer/hooks/use-hotkeys';
import { useIsMobile } from '/@/renderer/hooks/use-is-mobile';
import { DefaultLayout } from '/@/renderer/layouts/default-layout';
import { MobileLayout } from '/@/renderer/layouts/mobile-layout/mobile-layout';
import { AppRoute } from '/@/renderer/router/routes';
import { useCommandPaletteState, useLayoutHotkeyBindings } from '/@/renderer/store';

interface ResponsiveLayoutProps {
    shell?: boolean;
}

const ResponsiveLayoutBase = ({ shell }: ResponsiveLayoutProps) => {
    const isMobile = useIsMobile();

    if (isMobile) {
        return <MobileLayout shell={shell} />;
    }

    return <DefaultLayout shell={shell} />;
};

export const ResponsiveLayout = ({ shell }: ResponsiveLayoutProps) => {
    return (
        <>
            <ResponsiveLayoutBase shell={shell} />
            <LayoutHotkeys />
            <GarbageCollection />
        </>
    );
};

const LayoutHotkeys = () => {
    const navigate = useNavigate();
    const bindings = useLayoutHotkeyBindings();
    const { close, open, opened, toggle } = useCommandPaletteState();

    const handlers = useMemo(
        () => ({
            close,
            open,
            toggle,
        }),
        [close, open, toggle],
    );

    const hotkeys = useMemo<HotkeyItem[]>(
        () => [
            [bindings.globalSearch.hotkey, open],
            [bindings.browserBack.hotkey, () => navigate(-1)],
            [bindings.browserForward.hotkey, () => navigate(1)],
            [bindings.navigateHome.hotkey, () => navigate(AppRoute.HOME)],
        ],
        [bindings, navigate, open],
    );

    const modalProps = useMemo(
        () => ({
            handlers,
            opened,
        }),
        [handlers, opened],
    );

    useHotkeys(hotkeys);

    return <CommandPalette modalProps={modalProps} />;
};

const GarbageCollection = () => {
    useGarbageCollection();
    return null;
};
