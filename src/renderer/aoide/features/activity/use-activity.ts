import { persist } from 'zustand/middleware';
import { createWithEqualityFn } from 'zustand/traditional';

import { Activity, parseActivity } from '/@/shared/aoide/activity';

/**
 * What the listener is doing, right now, on this machine.
 *
 * **Device-local, and deliberately not synced.** The *tag on a play event*
 * travels — it is a column on `play_events`, so it rides the ordinary op log to
 * the phone like everything else on that row — but the selection itself is a
 * property of where somebody is sitting, not of their account. Syncing it would
 * mean putting the desk into Commute because the phone is in a car, and tagging
 * an evening of desk listening as a commute; the two devices are in two places
 * at once, which is the entire reason there are two of them. There is no entity
 * for it in `SYNC_ENTITIES` and no op is ever written when it changes.
 *
 * Persisted the way the renderer's other Aoide state is: a Zustand store under
 * a name of its own in localStorage. Persisted rather than reset per session
 * because the thing being recorded is a session — somebody who sits down to a
 * long gaming evening should not have to re-arm the tag every time the app is
 * reopened. The other side of that is the picker showing what is set, so a tag
 * left on overnight is visible rather than silently colouring a week of
 * listening.
 *
 * Untagged is the default, and nothing here ever chooses an activity on the
 * listener's behalf.
 */
interface ActivityState {
    /**
     * The raw stored value. Read through `useActivity` or `currentActivity`
     * rather than directly — localStorage is a file on disk, and what comes back
     * out of it has to be parsed before it can be believed.
     */
    activity: Activity | null;
    setActivity: (activity: Activity | null) => void;
}

export const useActivityStore = createWithEqualityFn<ActivityState>()(
    persist(
        (set) => ({
            activity: null,
            setActivity: (activity) => set({ activity: parseActivity(activity) }),
        }),
        { name: 'aoide-activity', version: 1 },
    ),
);

/** The selected activity, or null for untagged. */
export const useActivity = (): Activity | null =>
    useActivityStore((state) => parseActivity(state.activity));

/**
 * The selected activity, read outside React.
 *
 * The play recorder is an effect holding a plain state machine, so it takes the
 * value the same way it takes `Date.now()`: by asking, at the one moment the
 * answer matters.
 */
export const currentActivity = (): Activity | null =>
    parseActivity(useActivityStore.getState().activity);
