import { useEffect, useImperativeHandle, useMemo } from 'react';

import { sectionHeaderRowsBefore } from '/@/renderer/aoide/features/queue/manual-lane';
import { ItemListStateActions } from '/@/renderer/components/item-list/helpers/item-list-state';
import { ItemListHandle } from '/@/renderer/components/item-list/types';

interface UseTableImperativeHandleProps {
    autoScrollToActiveRow: boolean;
    enableHeader: boolean;
    /**
     * How many items each group holds, when the table is grouped. Callers ask
     * to scroll to an *item*, and a grouped table has a heading row in front of
     * each group, so the row that item sits on is further down by exactly the
     * number of headings above it.
     */
    groupItemCounts?: number[];
    handleRef: React.RefObject<ItemListHandle | null>;
    internalState: ItemListStateActions;
    ref?: React.Ref<ItemListHandle>;
    scrollToTableIndex: (
        index: number,
        options?: { align?: 'bottom' | 'center' | 'top'; followActiveRow?: boolean },
    ) => void;
    scrollToTableOffset: (offset: number) => void;
}

/**
 * Hook to set up the imperative handle for ItemTableList, providing scroll methods and internal state.
 */
export const useTableImperativeHandle = ({
    autoScrollToActiveRow,
    enableHeader,
    groupItemCounts,
    handleRef,
    internalState,
    ref,
    scrollToTableIndex,
    scrollToTableOffset,
}: UseTableImperativeHandleProps) => {
    const imperativeHandle: ItemListHandle = useMemo(
        () => ({
            internalState,
            scrollToIndex: (index: number, options?: { align?: 'bottom' | 'center' | 'top' }) => {
                const row = groupItemCounts
                    ? index + sectionHeaderRowsBefore(index, groupItemCounts)
                    : index;

                scrollToTableIndex(enableHeader ? row + 1 : row, {
                    ...options,
                    followActiveRow: autoScrollToActiveRow,
                });
            },
            scrollToOffset: (offset: number) => {
                scrollToTableOffset(offset);
            },
        }),
        [
            autoScrollToActiveRow,
            enableHeader,
            groupItemCounts,
            internalState,
            scrollToTableIndex,
            scrollToTableOffset,
        ],
    );

    useImperativeHandle(ref, () => imperativeHandle);

    useEffect(() => {
        handleRef.current = imperativeHandle;
    }, [handleRef, imperativeHandle]);
};
