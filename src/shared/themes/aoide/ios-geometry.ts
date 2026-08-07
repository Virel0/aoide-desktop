import { rem } from '@mantine/core';

/**
 * The corner radii the iOS app draws, transcribed from
 * `Aoide/Features/Shared/DesignSystem.swift` in the `~/Jelly music` checkout.
 *
 * This directory is not a theme — it holds the constants both Aoide themes
 * share, so the two cannot drift apart while claiming to be the same design.
 *
 * The mapping onto Mantine's five-step scale is not arbitrary. Feishin re-exports
 * every Mantine radius as `--theme-radius-*` (see `src/shared/styles/global.css`)
 * and its components then reach for `md` on cards and artwork containers, `sm` on
 * list-row thumbnails and small chips, and `lg` on the large drag preview. Those
 * three land exactly on iOS's card, thumbnail and hero values, so overriding the
 * scale is the whole job — no component file needs touching.
 *
 * Kept in rem rather than px because the base Mantine theme is, and because
 * Feishin exposes a `root-font-size` theme token: a px radius beside a rem one
 * would stop scaling with it, and the corners would drift apart at any zoom
 * other than 100%.
 */
export const iosRadius = {
    // Design.Radius.hero — the large artwork on a detail page.
    lg: rem('12px'),
    // Design.Radius.card — album art in a carousel or grid cell.
    md: rem('8px'),
    // Design.Radius.thumbnail — artwork in a list row.
    sm: rem('5px'),
    // iOS has no equivalent: this is Feishin's pill radius, used for the round
    // play button, and it has no business tracking a card corner.
    xl: rem('16px'),
    xs: rem('5px'),
};
