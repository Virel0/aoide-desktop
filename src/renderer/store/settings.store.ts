import isElectron from 'is-electron';
import cloneDeep from 'lodash/cloneDeep';
import mergeWith from 'lodash/mergeWith';
import { nanoid } from 'nanoid';
import { useMemo } from 'react';
import { generatePath } from 'react-router';
import { z } from 'zod';
import { devtools, persist, subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { shallow } from 'zustand/shallow';
import { createWithEqualityFn } from 'zustand/traditional';

import i18n from '/@/i18n/i18n';
import {
    AoideNowPlayingColumnSchema,
    DEFAULT_AOIDE_NOW_PLAYING_COLUMN,
} from '/@/renderer/aoide/features/now-playing/now-playing-column';
import {
    AoideAlbumLockSchema,
    AoideCrossfadeSchema,
    DEFAULT_AOIDE_ALBUM_LOCK,
    DEFAULT_AOIDE_CROSSFADE,
} from '/@/renderer/aoide/features/playback/crossfade';
import {
    AoideLoudnessNormalisationSchema,
    DEFAULT_AOIDE_LOUDNESS_NORMALISATION,
} from '/@/renderer/aoide/features/playback/loudness-normalisation';
import {
    AoideTrimSilenceSchema,
    DEFAULT_AOIDE_TRIM_SILENCE,
} from '/@/renderer/aoide/features/playback/trim-silence';
import {
    AoidePlaylistSurfaceSchema,
    DEFAULT_AOIDE_PLAYLIST_SURFACE,
} from '/@/renderer/aoide/features/settings/playlist-surface';
import {
    ALBUM_ARTIST_TABLE_COLUMNS,
    ALBUM_TABLE_COLUMNS,
    GENRE_TABLE_COLUMNS,
    pickGridRows,
    pickTableColumns,
    PLAYLIST_SONG_TABLE_COLUMNS,
    PLAYLIST_TABLE_COLUMNS,
    SONG_TABLE_COLUMNS,
} from '/@/renderer/components/item-list/item-table-list/default-columns';
import { audiomotionanalyzerPresets } from '/@/renderer/features/visualizer/components/audiomotionanalyzer/presets';
import { AppRoute } from '/@/renderer/router/routes';
import { getEnvSettingsOverrides } from '/@/renderer/store/env-settings-overrides';
import { mergeOverridingColumns } from '/@/renderer/store/utils';
import { FontValueSchema } from '/@/renderer/types/fonts';
import { sanitizeCss } from '/@/renderer/utils/sanitize';
import { AppTheme } from '/@/shared/themes/app-theme-types';
import { LibraryItem, SavedCollection } from '/@/shared/types/domain-types';
import {
    FontType,
    ItemListKey,
    ListDisplayType,
    ListPaginationType,
    Platform,
    TableColumn,
} from '/@/shared/types/types';

const utils = isElectron() ? window.api.utils : null;

type DeepPartial<T> = {
    [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

const deepMergeIntoState = <T extends Record<string, any>>(
    state: T,
    updates: DeepPartial<T>,
): void => {
    // Skip 'actions' property
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { actions, ...updatesWithoutActions } = updates as any;

    // Use mergeWith to replace arrays instead of merging them by index
    mergeWith(state, updatesWithoutActions, (_objValue, srcValue) => {
        // If source value is an array, replace the entire array instead of merging
        if (Array.isArray(srcValue)) {
            return srcValue;
        }

        // Default merge behavior
        return undefined;
    });
};

const SortableItemSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
    z.object({
        disabled: z.boolean(),
        id: itemSchema,
    });

const ItemTableListColumnConfigSchema = z.object({
    align: z.enum(['center', 'end', 'start']),
    autoSize: z.boolean().optional(),
    id: z.nativeEnum(TableColumn),
    isEnabled: z.boolean(),
    pinned: z.union([z.literal('left'), z.literal('right'), z.literal(null)]),
    width: z.number(),
});

export type ItemTableListColumnConfig = z.infer<typeof ItemTableListColumnConfigSchema>;

const ItemGridListRowConfigSchema = z.object({
    align: z.enum(['center', 'end', 'start']),
    id: z.nativeEnum(TableColumn),
    isEnabled: z.boolean(),
});

export type ItemGridListRowConfig = z.infer<typeof ItemGridListRowConfigSchema>;

const ItemTableListPropsSchema = z.object({
    autoFitColumns: z.boolean(),
    columns: z.array(ItemTableListColumnConfigSchema),
    enableAlternateRowColors: z.boolean(),
    enableHeader: z.boolean(),
    enableHorizontalBorders: z.boolean(),
    enableRowHoverHighlight: z.boolean(),
    enableVerticalBorders: z.boolean(),
    size: z.enum(['compact', 'default', 'large']),
});

const ItemDetailListPropsSchema = z.object({
    columns: z.array(ItemTableListColumnConfigSchema),
    enableAlternateRowColors: z.boolean(),
    enableHeader: z.boolean(),
    enableHorizontalBorders: z.boolean(),
    enableRowHoverHighlight: z.boolean(),
    enableVerticalBorders: z.boolean(),
    size: z.enum(['compact', 'default', 'large']),
});

const ItemListConfigSchema = z.object({
    detail: ItemDetailListPropsSchema.optional(),
    display: z.nativeEnum(ListDisplayType),
    grid: z.object({
        itemGap: z.enum(['lg', 'md', 'sm', 'xl', 'xs']),
        itemsPerRow: z.number(),
        itemsPerRowEnabled: z.boolean(),
        rows: z.array(ItemGridListRowConfigSchema),
        size: z.enum(['compact', 'default', 'large']),
    }),
    itemsPerPage: z.number(),
    pagination: z.nativeEnum(ListPaginationType),
    table: ItemTableListPropsSchema,
});

const AlbumGroupItemSchema = z.enum([
    'albumArtists',
    'duration',
    'genres',
    'releaseDate',
    'releaseYear',
    'releaseType',
    'size',
    'songCount',
]);

const BindingActionsSchema = z.enum([
    'browserBack',
    'browserForward',
    'favoriteCurrentAdd',
    'favoriteCurrentRemove',
    'favoriteCurrentToggle',
    'favoritePreviousAdd',
    'favoritePreviousRemove',
    'favoritePreviousToggle',
    'globalSearch',
    'localSearch',
    'volumeMute',
    'navigateHome',
    'next',
    'nextAlbum',
    'pause',
    'play',
    'playPause',
    'previous',
    'previousAlbum',
    'rate0',
    'rate1',
    'rate2',
    'rate3',
    'rate4',
    'rate5',
    'toggleShuffle',
    'skipBackward',
    'skipForward',
    'stop',
    'toggleFullscreenPlayer',
    'toggleQueue',
    'toggleRepeat',
    'volumeDown',
    'volumeUp',
    'zoomIn',
    'zoomOut',
    'listPlayDefault',
    'listPlayNow',
    'listPlayNext',
    'listPlayLast',
    'listNavigateToPage',
    'listShowPlayingSong',
]);

const DiscordDisplayTypeSchema = z.enum(['artist', 'feishin', 'song']);

const DiscordLinkTypeSchema = z.enum(['last_fm', 'musicbrainz', 'musicbrainz_last_fm', 'none']);

const GenreTargetSchema = z.enum(['album', 'track']);

const PlaylistTargetSchema = z.enum(['album', 'track']);

const CollectionSchema = z.object({
    filterQueryString: z.string(),
    id: z.string(),
    name: z.string(),
    type: z.enum([LibraryItem.ALBUM, LibraryItem.SONG]),
});

const AudioMotionAnalyzerSettingsSchema = z.object({
    alphaBars: z
        .boolean()
        .describe(
            'When set to true each bar’s amplitude affects its opacity, i.e., higher bars are rendered more opaque while shorter bars are more transparent. This is similar to the lumiBars effect, but bars’ amplitudes are preserved and it also works on Discrete mode and radial spectrum.',
        ),
    ansiBands: z
        .boolean()
        .describe(
            'When set to true, ANSI/IEC preferred frequencies are used to generate the bands for octave bands modes (see mode). The preferred base-10 scale is used to compute the center and bandedge frequencies, as specified in the ANSI S1.11-2004 standard. When false, bands are based on the equal-tempered scale, so that in 1/12 octave bands the center of each band is perfectly tuned to a musical note.',
        ),
    barSpace: z
        .number()
        .describe(
            'Customize the spacing between bars in frequency bands modes (see mode). Use a value between 0 and 1 for spacing proportional to the band width. Values >= 1 will be considered as a literal number of pixels.',
        ),
    channelLayout: z
        .enum(['single', 'dual-combined', 'dual-horizontal', 'dual-vertical'])
        .describe('Defines the number and layout of analyzer channels.'),
    colorMode: z
        .enum(['gradient', 'bar-index', 'bar-level'])
        .describe('Selects the desired mode for coloring the analyzer bars.'),
    customGradients: z.array(
        z.object({
            colorStops: z.array(
                z.object({
                    color: z.string(),
                    level: z.number().min(0).max(1).optional(),
                    levelEnabled: z.boolean().optional(),
                    pos: z.number().min(0).max(1).optional(),
                    positionEnabled: z.boolean().optional(),
                }),
            ),
            dir: z.string().optional(),
            name: z.string(),
        }),
    ),
    fadePeaks: z
        .boolean()
        .describe(
            'When true, peaks fade out instead of falling down. It has no effect when peakLine is active.',
        ),
    fftSize: z
        .number()
        .describe(
            'Number of samples used for the FFT performed by the AnalyzerNode. It must be a power of 2 between 32 and 32768, so valid values are: 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, and 32768. Higher values provide more detail in the frequency domain, but less detail in the time domain (slower response), so you may need to adjust smoothing accordingly.',
        ),
    fillAlpha: z.number(),
    frequencyScale: z.enum(['bark', 'linear', 'log', 'mel']),
    gradient: z.string(),
    gradientLeft: z.string().optional(),
    gradientRight: z.string().optional(),
    gravity: z.number(),
    ledBars: z.boolean(),
    linearAmplitude: z.boolean(),
    linearBoost: z.number(),
    lineWidth: z.number(),
    loRes: z.boolean(),
    lumiBars: z.boolean(),
    maxDecibels: z.number(),
    maxFPS: z.number(),
    maxFreq: z.number(),
    minDecibels: z.number(),
    minFreq: z.number(),
    mirror: z.number(),
    mode: z.number(),
    noteLabels: z.boolean(),
    opacity: z.number().min(0).max(1),
    outlineBars: z.boolean(),
    peakFadeTime: z.number(),
    peakHoldTime: z.number(),
    peakLine: z.boolean(),
    presets: z.array(
        z.object({
            id: z.string(),
            name: z.string(),
            value: z.any(),
        }),
    ),
    radial: z.boolean(),
    radialInvert: z.boolean(),
    radius: z.number(),
    reflexAlpha: z.number(),
    reflexBright: z.number(),
    reflexFit: z.boolean(),
    reflexRatio: z.number(),
    roundBars: z.boolean(),
    showFPS: z.boolean(),
    showPeaks: z.boolean(),
    showScaleX: z.boolean(),
    showScaleY: z.boolean(),
    smoothing: z.number(),
    spinSpeed: z.number(),
    splitGradient: z.boolean(),
    trueLeds: z.boolean(),
    volume: z.number(),
    weightingFilter: z.enum(['', 'A', 'B', 'C', 'D', 'Z']),
});

const ButterchurnSettingsSchema = z.object({
    blendTime: z.number().min(0).max(10),
    currentPreset: z.string().optional(),
    cyclePresets: z.boolean(),
    cycleTime: z.number().min(1).max(300),
    ignoredPresets: z.array(z.string()),
    includeAllPresets: z.boolean(),
    maxFPS: z.number().min(0),
    opacity: z.number().min(0).max(1),
    randomizeNextPreset: z.boolean(),
    selectedPresets: z.array(z.string()),
});

const TranscodingConfigSchema = z.object({
    bitrate: z.number().optional(),
    enabled: z.boolean(),
    format: z.string().optional(),
});

const EqSettingsSchema = z.object({
    bands: z.array(
        z.object({
            freq: z.number(),
            gain: z.number(),
        }),
    ),
    enabled: z.boolean(),
    preamp: z.number(),
});

const CompressorSettingsSchema = z.object({
    attack: z.number(),
    enabled: z.boolean(),
    knee: z.number(),
    makeup: z.number(),
    ratio: z.number(),
    release: z.number(),
    threshold: z.number(),
});

const CssSettingsSchema = z.object({
    content: z.string().transform((val) => sanitizeCss(`<style>${val}`)),
    enabled: z.boolean(),
});

const DiscordSettingsSchema = z.object({
    clientId: z.string(),
    displayType: DiscordDisplayTypeSchema,
    enabled: z.boolean(),
    linkType: DiscordLinkTypeSchema,
    showAsListening: z.boolean(),
    showPaused: z.boolean(),
    showServerImage: z.boolean(),
    showStateIcon: z.boolean(),
});

const FontSettingsSchema = z.object({
    builtIn: FontValueSchema,
    custom: z.string().nullable(),
    system: z.string().nullable(),
    type: z.nativeEnum(FontType),
});

const VisualizerSettingsSchema = z.object({
    audiomotionanalyzer: AudioMotionAnalyzerSettingsSchema,
    butterchurn: ButterchurnSettingsSchema,
    type: z.enum(['audiomotionanalyzer', 'butterchurn']),
});

export enum HomeFeatureStyle {
    MULTIPLE = 'multiple',
    SINGLE = 'single',
}

export const GeneralSettingsSchema = z.object({
    accent: z
        .string()
        .refine(
            (val) => /^rgb\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*\)$/.test(val),
            {
                message: 'Accent must be a valid rgb() color string',
            },
        ),
    albumGroupImageSize: z.number(),
    albumGroupItems: z.array(SortableItemSchema(AlbumGroupItemSchema)),
    albumGroupShowFavoriteRating: z.boolean(),
    albumGroupVerticalLayout: z.boolean(),
    aoideAlbumLock: AoideAlbumLockSchema,
    aoideCrossfade: AoideCrossfadeSchema,
    aoideLoudnessNormalisation: AoideLoudnessNormalisationSchema,
    aoideNowPlayingColumn: AoideNowPlayingColumnSchema,
    aoidePlaylistSurface: AoidePlaylistSurfaceSchema,
    aoideTrimSilence: AoideTrimSilenceSchema,
    collections: z.array(CollectionSchema),
    combinedLyricsAndVisualizer: z.boolean(),
    followSystemTheme: z.boolean(),
    genreTarget: GenreTargetSchema,
    passwordStore: z.string().optional(),
    playlistTarget: PlaylistTargetSchema,
    showLyricsInSidebar: z.boolean(),
    showQueueInSidebar: z.boolean(),
    showVisualizerInSidebar: z.boolean(),
    // Accepts either a built-in AppTheme id or a custom theme id (the
    // filename, without extension, of a JSON file in the themes folder).
    // Custom theme ids aren't statically known, so this can't be a
    // nativeEnum(AppTheme) any more; getAppTheme() falls back to the
    // default theme if the stored id doesn't resolve to anything.
    theme: z.string(),
    themeDark: z.string(),
    themeLight: z.string(),
});

const HotkeyBindingSchema = z.object({
    allowGlobal: z.boolean(),
    hotkey: z.string(),
    isGlobal: z.boolean(),
});

const HotkeysSettingsSchema = z.object({
    bindings: z
        .record(BindingActionsSchema, HotkeyBindingSchema)
        .refine((obj): obj is Required<typeof obj> =>
            BindingActionsSchema.options.every((key) => obj[key] != null),
        ),
    globalMediaHotkeys: z.boolean(),
});

const LyricsDisplaySettingsSchema = z.object({
    fontSize: z.number(),
    fontSizeUnsync: z.number(),
    gap: z.number(),
    gapUnsync: z.number(),
    opacityNonActive: z.number(),
    paddingLeft: z.number(),
    paddingRight: z.number(),
    scaleNonActive: z.number(),
});

const LyricsSettingsSchema = z.object({
    alignment: z.enum(['center', 'left', 'right']),
    delayMs: z.number(),
    enableFurigana: z.boolean(),
    enableRomaji: z.boolean(),
    fetch: z.boolean(),
    follow: z.boolean(),
    followScrollAlignment: z.number(),
    lineLeadTimeMs: z.number(),
    showMatch: z.boolean(),
    showProvider: z.boolean(),
});

const PlaybackSettingsSchema = z.object({
    audioDeviceId: z.string().nullable().optional(),
    compressor: CompressorSettingsSchema,
    equalizer: EqSettingsSchema,
    mediaSession: z.boolean(),
    transcode: TranscodingConfigSchema,
});

const WindowSettingsSchema = z.object({
    disableAutoUpdate: z.boolean(),
    exitToTray: z.boolean(),
    minimizeToTray: z.boolean(),
    preventSleepOnPlayback: z.boolean(),
    preventSuspendOnPlayback: z.boolean(),
    releaseChannel: z.enum(['alpha', 'beta', 'latest']),
    startMinimized: z.boolean(),
    tray: z.boolean(),
    windowBarStyle: z.nativeEnum(Platform),
    windowBarTrackinfo: z.boolean(),
});

export const AUTO_DJ_MODE = {
    ALBUMS: 'albums',
    SONGS: 'songs',
} as const;

export type AutoDJMode = (typeof AUTO_DJ_MODE)[keyof typeof AUTO_DJ_MODE];

export const AUTO_DJ_STRATEGY = {
    LIBRARY_RANDOM: 'library_random',
    SIMILAR: 'similar',
} as const;

export type AutoDJStrategy = (typeof AUTO_DJ_STRATEGY)[keyof typeof AUTO_DJ_STRATEGY];

const autoDjStrategyEnum = z.enum(['similar', 'library_random']);

const AutoDJSettingsSchema = z.object({
    albumStrategy: autoDjStrategyEnum,
    allowDuplicates: z.boolean(),
    enabled: z.boolean(),
    itemCount: z.number(),
    mode: z.enum(['songs', 'albums']),
    onlySimilar: z.boolean(),
    songStrategy: autoDjStrategyEnum,
    timing: z.number(),
});

/**
 * This schema is used for validation of the imported settings json
 */
export const ValidationSettingsStateSchema = z.object({
    autoDJ: AutoDJSettingsSchema,
    css: CssSettingsSchema,
    discord: DiscordSettingsSchema,
    font: FontSettingsSchema,
    general: GeneralSettingsSchema,
    hotkeys: HotkeysSettingsSchema,
    lists: z.record(z.nativeEnum(ItemListKey), ItemListConfigSchema),
    lyrics: LyricsSettingsSchema,
    lyricsDisplay: z.record(z.string(), LyricsDisplaySettingsSchema),
    playback: PlaybackSettingsSchema,
    tab: z.string(),
    visualizer: VisualizerSettingsSchema,
    window: WindowSettingsSchema,
});

/**
 * This schema is merged below to create the full SettingsSchema but not used during import validation
 */
export const NonValidatedSettingsStateSchema = z.object({});

export const SettingsStateSchema = ValidationSettingsStateSchema.merge(
    NonValidatedSettingsStateSchema,
);

export enum AlbumGroupItem {
    ALBUM_ARTISTS = 'albumArtists',
    DURATION = 'duration',
    GENRES = 'genres',
    RELEASE_DATE = 'releaseDate',
    RELEASE_TYPE = 'releaseType',
    RELEASE_YEAR = 'releaseYear',
    SIZE = 'size',
    SONG_COUNT = 'songCount',
}

export enum ArtistItem {
    BIOGRAPHY = 'biography',
    FAVORITE_SONGS = 'favoriteSongs',
    RECENT_ALBUMS = 'recentAlbums',
    SIMILAR_ARTISTS = 'similarArtists',
    TOP_SONGS = 'topSongs',
}

export enum ArtistReleaseTypeItem {
    APPEARS_ON = 'appearsOn',
    RELEASE_TYPE_ALBUM = 'releaseTypeAlbum',
    RELEASE_TYPE_AUDIO_DRAMA = 'releaseTypeAudioDrama',
    RELEASE_TYPE_AUDIOBOOK = 'releaseTypeAudiobook',
    RELEASE_TYPE_BROADCAST = 'releaseTypeBroadcast',
    RELEASE_TYPE_COMPILATION = 'releaseTypeCompilation',
    RELEASE_TYPE_DEMO = 'releaseTypeDemo',
    RELEASE_TYPE_DJ_MIX = 'releaseTypeDjMix',
    RELEASE_TYPE_EP = 'releaseTypeEp',
    RELEASE_TYPE_FIELD_RECORDING = 'releaseTypeFieldRecording',
    RELEASE_TYPE_INTERVIEW = 'releaseTypeInterview',
    RELEASE_TYPE_LIVE = 'releaseTypeLive',
    RELEASE_TYPE_MIXTAPE_STREET = 'releaseTypeMixtapeStreet',
    RELEASE_TYPE_OTHER = 'releaseTypeOther',
    RELEASE_TYPE_REMIX = 'releaseTypeRemix',
    RELEASE_TYPE_SINGLE = 'releaseTypeSingle',
    RELEASE_TYPE_SOUNDTRACK = 'releaseTypeSoundtrack',
    RELEASE_TYPE_SPOKENWORD = 'releaseTypeSpokenWord',
}

export enum BarAlign {
    BOTTOM = 'bottom',
    CENTER = 'center',
    TOP = 'top',
}

export enum BindingActions {
    BROWSER_BACK = 'browserBack',
    BROWSER_FORWARD = 'browserForward',
    FAVORITE_CURRENT_ADD = 'favoriteCurrentAdd',
    FAVORITE_CURRENT_REMOVE = 'favoriteCurrentRemove',
    FAVORITE_CURRENT_TOGGLE = 'favoriteCurrentToggle',
    FAVORITE_PREVIOUS_ADD = 'favoritePreviousAdd',
    FAVORITE_PREVIOUS_REMOVE = 'favoritePreviousRemove',
    FAVORITE_PREVIOUS_TOGGLE = 'favoritePreviousToggle',
    GLOBAL_SEARCH = 'globalSearch',
    LIST_NAVIGATE_TO_PAGE = 'listNavigateToPage',
    LIST_PLAY_DEFAULT = 'listPlayDefault',
    LIST_PLAY_LAST = 'listPlayLast',
    LIST_PLAY_NEXT = 'listPlayNext',
    LIST_PLAY_NOW = 'listPlayNow',
    LIST_SHOW_PLAYING_SONG = 'listShowPlayingSong',
    LOCAL_SEARCH = 'localSearch',
    MUTE = 'volumeMute',
    NAVIGATE_HOME = 'navigateHome',
    NEXT = 'next',
    NEXT_ALBUM = 'nextAlbum',
    PAUSE = 'pause',
    PLAY = 'play',
    PLAY_PAUSE = 'playPause',
    PREVIOUS = 'previous',
    PREVIOUS_ALBUM = 'previousAlbum',
    RATE_0 = 'rate0',
    RATE_1 = 'rate1',
    RATE_2 = 'rate2',
    RATE_3 = 'rate3',
    RATE_4 = 'rate4',
    RATE_5 = 'rate5',
    SHUFFLE = 'toggleShuffle',
    SKIP_BACKWARD = 'skipBackward',
    SKIP_FORWARD = 'skipForward',
    STOP = 'stop',
    TOGGLE_FULLSCREEN_PLAYER = 'toggleFullscreenPlayer',
    TOGGLE_QUEUE = 'toggleQueue',
    TOGGLE_REPEAT = 'toggleRepeat',
    VOLUME_DOWN = 'volumeDown',
    VOLUME_UP = 'volumeUp',
    ZOOM_IN = 'zoomIn',
    ZOOM_OUT = 'zoomOut',
}

export enum DiscordDisplayType {
    ARTIST_NAME = 'artist',
    FEISHIN = 'feishin',
    SONG_NAME = 'song',
}

export enum DiscordLinkType {
    LAST_FM = 'last_fm',
    MBZ = 'musicbrainz',
    MBZ_LAST_FM = 'musicbrainz_last_fm',
    NONE = 'none',
}

export enum GenreTarget {
    ALBUM = 'album',
    TRACK = 'track',
}

export enum HomeItem {
    GENRES = 'genres',
    MOST_PLAYED = 'mostPlayed',
    RANDOM = 'random',
    RECENTLY_ADDED = 'recentlyAdded',
    RECENTLY_PLAYED = 'recentlyPlayed',
    RECENTLY_RELEASED = 'recentlyReleased',
}

export enum PlayerbarSliderType {
    SLIDER = 'slider',
    WAVEFORM = 'waveform',
}

export enum PlayerItem {
    BIT_DEPTH = 'bit_depth',
    BIT_RATE = 'bit_rate',
    BPM = 'bpm',
    CODEC = 'codec',
    DATE = 'date',
    DISC_NUMBER = 'disc_number',
    GENRES = 'genres',
    RELEASE_DATE = 'release_date',
    RELEASE_TYPE = 'release_type',
    RELEASE_YEAR = 'release_year',
    SAMPLE_RATE = 'sample_rate',
    TRACK_NUMBER = 'track_number',
    YEAR = 'year',
}

export enum PlaylistTarget {
    ALBUM = 'album',
    TRACK = 'track',
}

export enum SidebarItem {
    ALBUMS = 'Albums',
    ARTISTS = 'Artists',
    ARTISTS_ALL = 'Artists-all',
    COLLECTIONS = 'Collections',
    FAVORITES = 'Favorites',
    GENRES = 'Genres',
    HOME = 'Home',
    NOW_PLAYING = 'Now Playing',
    PLAYLISTS = 'Playlists',
    SEARCH = 'Search',
    SETTINGS = 'Settings',
    TRACKS = 'Tracks',
}

export type DataGridProps = {
    itemGap: 'lg' | 'md' | 'sm' | 'xl' | 'xs';
    itemsPerRow: number;
    itemsPerRowEnabled: boolean;
    rows: ItemGridListRowConfig[];
    size: 'compact' | 'default' | 'large';
};

export type DataTableProps = z.infer<typeof ItemTableListPropsSchema>;
export type ItemDetailListProps = z.infer<typeof ItemDetailListPropsSchema>;

export type ItemListSettings = {
    detail?: ItemDetailListProps;
    display: ListDisplayType;
    grid: DataGridProps;
    itemsPerPage: number;
    pagination: ListPaginationType;
    table: DataTableProps;
};

export interface SettingsSlice extends z.infer<typeof SettingsStateSchema> {
    actions: {
        addCollection: (collection: SavedCollection) => void;
        removeCollection: (id: string) => void;
        reset: () => void;
        setAlbumGroupItems: (items: SortableItem<AlbumGroupItem>[]) => void;
        setGenreBehavior: (target: GenreTarget) => void;
        setList: (type: ItemListKey, data: DeepPartial<ItemListSettings>) => void;
        setPlaylistBehavior: (target: PlaylistTarget) => void;
        setSettings: (data: DeepPartial<SettingsState>) => void;
        setTable: (type: ItemListKey, data: DataTableProps) => void;
        setTranscodingConfig: (config: TranscodingConfig) => void;
        toggleMediaSession: () => void;
        updateCollection: (id: string, updates: Partial<Omit<SavedCollection, 'id'>>) => void;
    };
}
export interface SettingsState extends z.infer<typeof SettingsStateSchema> {}

// The list of sidebar entries is fixed now rather than a setting, so this is a
// shape and not a schema — nothing arrives from disk to validate against it.
export type SidebarItemType = {
    disabled: boolean;
    id: string;
    label: string;
    route: AppRoute | string;
};

export type SortableItem<T extends string> = {
    disabled: boolean;
    id: T;
};

export type TranscodingConfig = z.infer<typeof TranscodingConfigSchema>;

export type VersionedSettings = SettingsState & { version: number };

export const playerItems: SortableItem<PlayerItem>[] = [
    {
        disabled: true,
        id: PlayerItem.BIT_DEPTH,
    },
    {
        disabled: true,
        id: PlayerItem.BIT_RATE,
    },
    {
        disabled: true,
        id: PlayerItem.BPM,
    },
    {
        disabled: false,
        id: PlayerItem.CODEC,
    },
    {
        disabled: true,
        id: PlayerItem.DATE,
    },
    {
        disabled: true,
        id: PlayerItem.DISC_NUMBER,
    },
    {
        disabled: true,
        id: PlayerItem.GENRES,
    },
    {
        disabled: true,
        id: PlayerItem.RELEASE_DATE,
    },
    {
        disabled: true,
        id: PlayerItem.RELEASE_TYPE,
    },
    {
        disabled: false,
        id: PlayerItem.RELEASE_YEAR,
    },
    {
        disabled: true,
        id: PlayerItem.SAMPLE_RATE,
    },
    {
        disabled: true,
        id: PlayerItem.TRACK_NUMBER,
    },
    {
        disabled: false,
        id: PlayerItem.YEAR,
    },
];

export const sidebarItems: SidebarItemType[] = [
    {
        disabled: true,
        id: 'Now Playing',
        label: i18n.t('page.sidebar.nowPlaying'),
        route: AppRoute.NOW_PLAYING,
    },
    {
        disabled: true,
        id: 'Search',
        label: i18n.t('page.sidebar.search'),
        route: generatePath(AppRoute.SEARCH, { itemType: LibraryItem.SONG }),
    },
    { disabled: false, id: 'Home', label: i18n.t('page.sidebar.home'), route: AppRoute.HOME },
    {
        disabled: false,
        id: 'Favorites',
        label: i18n.t('page.sidebar.favorites'),
        route: AppRoute.FAVORITES,
    },
    {
        disabled: false,
        id: 'Albums',
        label: i18n.t('page.sidebar.albums'),
        route: AppRoute.LIBRARY_ALBUMS,
    },
    {
        disabled: false,
        id: 'Tracks',
        label: i18n.t('page.sidebar.tracks'),
        route: AppRoute.LIBRARY_SONGS,
    },
    {
        disabled: false,
        id: 'Artists',
        label: i18n.t('page.sidebar.albumArtists'),
        route: AppRoute.LIBRARY_ALBUM_ARTISTS,
    },
    {
        disabled: false,
        id: 'Artists-all',
        label: i18n.t('page.sidebar.artists'),
        route: AppRoute.LIBRARY_ARTISTS,
    },
    {
        disabled: false,
        id: 'Genres',
        label: i18n.t('page.sidebar.genres'),
        route: AppRoute.LIBRARY_GENRES,
    },
    {
        disabled: true,
        id: 'Playlists',
        label: i18n.t('page.sidebar.playlists'),
        route: AppRoute.PLAYLISTS,
    },
    {
        disabled: false,
        id: 'Collections',
        label: i18n.t('page.sidebar.collections'),
        route: '',
    },
    {
        disabled: true,
        id: 'Settings',
        label: i18n.t('page.sidebar.settings'),
        route: AppRoute.SETTINGS,
    },
];

/*
 * The order these pages put their sections in.
 *
 * They used to be drag-reorderable lists in Settings, stored per install. What
 * an album artist page shows and in what order is a layout the app is
 * responsible for, not a decision to hand a listener a sortable list about, so
 * these are now the order — one place, the same on every install.
 */
export const homeItems = Object.values(HomeItem).map((item) => ({
    disabled: false,
    id: item,
}));

export const artistItems = Object.values(ArtistItem).map((item) => ({
    disabled: false,
    id: item,
}));

export const artistReleaseTypeItems = Object.values(ArtistReleaseTypeItem).map((item) => ({
    disabled: false,
    id: item,
}));

const albumGroupItems: SortableItem<AlbumGroupItem>[] = [
    { disabled: false, id: AlbumGroupItem.ALBUM_ARTISTS },
    { disabled: true, id: AlbumGroupItem.RELEASE_DATE },
    { disabled: true, id: AlbumGroupItem.RELEASE_YEAR },
    { disabled: true, id: AlbumGroupItem.SONG_COUNT },
    { disabled: true, id: AlbumGroupItem.DURATION },
    { disabled: true, id: AlbumGroupItem.RELEASE_TYPE },
    { disabled: true, id: AlbumGroupItem.GENRES },
    { disabled: true, id: AlbumGroupItem.SIZE },
];

// Determines the default/initial windowBarStyle value based on the current platform.
const getPlatformDefaultWindowBarStyle = (): Platform => {
    if (utils?.isWindows()) {
        return Platform.WINDOWS;
    }

    if (utils?.isMacOS()) {
        return Platform.MACOS;
    }

    if (utils?.isLinux()) {
        return Platform.WINDOWS;
    }

    return Platform.WEB;
};

const platformDefaultWindowBarStyle: Platform = getPlatformDefaultWindowBarStyle();

const initialState: SettingsState = {
    autoDJ: {
        albumStrategy: AUTO_DJ_STRATEGY.SIMILAR,
        allowDuplicates: false,
        enabled: false,
        itemCount: 5,
        mode: 'songs',
        onlySimilar: false,
        songStrategy: AUTO_DJ_STRATEGY.SIMILAR,
        timing: 1,
    },
    css: {
        content: '',
        enabled: false,
    },
    discord: {
        clientId: '1547687515279069215',
        displayType: DiscordDisplayType.FEISHIN,
        enabled: false,
        linkType: DiscordLinkType.NONE,
        showAsListening: false,
        showPaused: true,
        showServerImage: false,
        showStateIcon: true,
    },
    font: {
        builtIn: 'Inter',
        custom: null,
        system: null,
        type: FontType.BUILT_IN,
    },
    general: {
        // The iOS app's dark-appearance accent, #A593FF. This is a separate
        // setting from the theme's own `primary`, and it is the one that wins:
        // the accent picker is the only thing that decides the primary colour
        // now, so shipping Aoide Dark without changing this would leave the
        // app wearing Feishin's blue.
        accent: 'rgb(165, 147, 255)',
        albumGroupImageSize: 0,
        albumGroupItems,
        albumGroupShowFavoriteRating: true,
        albumGroupVerticalLayout: true,
        aoideAlbumLock: DEFAULT_AOIDE_ALBUM_LOCK,
        aoideCrossfade: DEFAULT_AOIDE_CROSSFADE,
        aoideLoudnessNormalisation: DEFAULT_AOIDE_LOUDNESS_NORMALISATION,
        aoideNowPlayingColumn: DEFAULT_AOIDE_NOW_PLAYING_COLUMN,
        aoidePlaylistSurface: DEFAULT_AOIDE_PLAYLIST_SURFACE,
        aoideTrimSilence: DEFAULT_AOIDE_TRIM_SILENCE,
        collections: [],
        combinedLyricsAndVisualizer: false,
        followSystemTheme: false,
        genreTarget: GenreTarget.TRACK,
        passwordStore: undefined,
        playlistTarget: PlaylistTarget.TRACK,
        showLyricsInSidebar: true,
        showQueueInSidebar: true,
        showVisualizerInSidebar: true,
        // Dark on a fresh install, matching the phone. `themeDark`/`themeLight`
        // are the pair used when "follow system theme" is on, so both sides of
        // that switch have to move too or the app changes identity at sunset.
        theme: AppTheme.AOIDE_DARK,
        themeDark: AppTheme.AOIDE_DARK,
        themeLight: AppTheme.AOIDE_LIGHT,
    },
    hotkeys: {
        bindings: {
            browserBack: { allowGlobal: false, hotkey: '', isGlobal: false },
            browserForward: { allowGlobal: false, hotkey: '', isGlobal: false },
            favoriteCurrentAdd: { allowGlobal: true, hotkey: '', isGlobal: false },
            favoriteCurrentRemove: { allowGlobal: true, hotkey: '', isGlobal: false },
            favoriteCurrentToggle: { allowGlobal: true, hotkey: '', isGlobal: false },
            favoritePreviousAdd: { allowGlobal: true, hotkey: '', isGlobal: false },
            favoritePreviousRemove: { allowGlobal: true, hotkey: '', isGlobal: false },
            favoritePreviousToggle: { allowGlobal: true, hotkey: '', isGlobal: false },
            globalSearch: { allowGlobal: false, hotkey: 'mod+k', isGlobal: false },
            listNavigateToPage: { allowGlobal: false, hotkey: 'mod+g', isGlobal: false },
            listPlayDefault: { allowGlobal: false, hotkey: 'enter', isGlobal: false },
            listPlayLast: { allowGlobal: false, hotkey: '', isGlobal: false },
            listPlayNext: { allowGlobal: false, hotkey: '', isGlobal: false },
            listPlayNow: { allowGlobal: false, hotkey: '', isGlobal: false },
            listShowPlayingSong: { allowGlobal: false, hotkey: 'mod+l', isGlobal: false },
            localSearch: { allowGlobal: false, hotkey: 'mod+f', isGlobal: false },
            navigateHome: { allowGlobal: false, hotkey: '', isGlobal: false },
            next: { allowGlobal: true, hotkey: '', isGlobal: false },
            nextAlbum: { allowGlobal: true, hotkey: '', isGlobal: false },
            pause: { allowGlobal: true, hotkey: '', isGlobal: false },
            play: { allowGlobal: true, hotkey: '', isGlobal: false },
            playPause: { allowGlobal: true, hotkey: 'space', isGlobal: false },
            previous: { allowGlobal: true, hotkey: '', isGlobal: false },
            previousAlbum: { allowGlobal: true, hotkey: '', isGlobal: false },
            rate0: { allowGlobal: true, hotkey: '', isGlobal: false },
            rate1: { allowGlobal: true, hotkey: '', isGlobal: false },
            rate2: { allowGlobal: true, hotkey: '', isGlobal: false },
            rate3: { allowGlobal: true, hotkey: '', isGlobal: false },
            rate4: { allowGlobal: true, hotkey: '', isGlobal: false },
            rate5: { allowGlobal: true, hotkey: '', isGlobal: false },
            skipBackward: { allowGlobal: true, hotkey: '', isGlobal: false },
            skipForward: { allowGlobal: true, hotkey: '', isGlobal: false },
            stop: { allowGlobal: true, hotkey: '', isGlobal: false },
            toggleFullscreenPlayer: { allowGlobal: false, hotkey: '', isGlobal: false },
            toggleQueue: { allowGlobal: false, hotkey: '', isGlobal: false },
            toggleRepeat: { allowGlobal: true, hotkey: '', isGlobal: false },
            toggleShuffle: { allowGlobal: true, hotkey: '', isGlobal: false },
            volumeDown: { allowGlobal: true, hotkey: '', isGlobal: false },
            volumeMute: { allowGlobal: true, hotkey: '', isGlobal: false },
            volumeUp: { allowGlobal: true, hotkey: '', isGlobal: false },
            zoomIn: { allowGlobal: true, hotkey: '', isGlobal: false },
            zoomOut: { allowGlobal: true, hotkey: '', isGlobal: false },
        },
        globalMediaHotkeys: true,
    },
    lists: {
        ['albumDetail']: {
            display: ListDisplayType.TABLE,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: [],
                size: 'default',
            },
            itemsPerPage: 100,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: pickTableColumns({
                    autoSizeColumns: [],
                    columns: SONG_TABLE_COLUMNS,
                    columnWidths: {
                        [TableColumn.DURATION]: 100,
                        [TableColumn.TITLE]: 400,
                        [TableColumn.TRACK_NUMBER]: 50,
                        [TableColumn.USER_FAVORITE]: 60,
                    },
                    enabledColumns: [
                        TableColumn.TRACK_NUMBER,
                        TableColumn.TITLE,
                        TableColumn.DURATION,
                        TableColumn.USER_FAVORITE,
                    ],
                }),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'compact',
            },
        },
        fullScreen: {
            display: ListDisplayType.TABLE,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: [],
                size: 'default',
            },
            itemsPerPage: 100,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: SONG_TABLE_COLUMNS.map((column) => ({
                    align: column.align,
                    autoSize: column.autoSize,
                    id: column.value,
                    isEnabled: column.isEnabled,
                    pinned: column.pinned,
                    width: column.width,
                })),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
        [ItemListKey.PLAYLIST_ALBUM]: {
            detail: {
                columns: pickTableColumns({
                    autoSizeColumns: [],
                    columns: SONG_TABLE_COLUMNS,
                    columnWidths: {
                        [TableColumn.ACTIONS]: 60,
                        [TableColumn.DURATION]: 100,
                        [TableColumn.TITLE]: 400,
                        [TableColumn.TRACK_NUMBER]: 50,
                        [TableColumn.USER_FAVORITE]: 60,
                    },
                    enabledColumns: [
                        TableColumn.TRACK_NUMBER,
                        TableColumn.TITLE,
                        TableColumn.DURATION,
                        TableColumn.USER_FAVORITE,
                        TableColumn.ACTIONS,
                    ],
                }),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'compact',
            },
            display: ListDisplayType.GRID,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: pickGridRows({
                    alignLeftColumns: [
                        TableColumn.TITLE,
                        TableColumn.ALBUM_ARTIST,
                        TableColumn.RELEASE_YEAR,
                    ],
                    columns: ALBUM_TABLE_COLUMNS,
                    enabledColumns: [
                        TableColumn.TITLE,
                        TableColumn.ALBUM_ARTIST,
                        TableColumn.RELEASE_YEAR,
                    ],
                    pickColumns: [
                        TableColumn.TITLE,
                        TableColumn.DURATION,
                        TableColumn.ALBUM_ARTIST,
                        TableColumn.BIT_RATE,
                        TableColumn.BPM,
                        TableColumn.DATE_ADDED,
                        TableColumn.GENRE,
                        TableColumn.PLAY_COUNT,
                        TableColumn.SONG_COUNT,
                        TableColumn.RELEASE_DATE,
                        TableColumn.RELEASE_YEAR,
                        TableColumn.LAST_PLAYED,
                    ],
                }),
                size: 'default',
            },
            itemsPerPage: 100,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: ALBUM_TABLE_COLUMNS.map((column) => ({
                    align: column.align,
                    autoSize: column.autoSize,
                    id: column.value,
                    isEnabled: column.isEnabled,
                    pinned: column.pinned,
                    width: column.width,
                })),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
        [LibraryItem.ALBUM]: {
            detail: {
                columns: pickTableColumns({
                    autoSizeColumns: [],
                    columns: SONG_TABLE_COLUMNS,
                    columnWidths: {
                        [TableColumn.ACTIONS]: 60,
                        [TableColumn.DURATION]: 100,
                        [TableColumn.TITLE]: 400,
                        [TableColumn.TRACK_NUMBER]: 50,
                        [TableColumn.USER_FAVORITE]: 60,
                    },
                    enabledColumns: [
                        TableColumn.TRACK_NUMBER,
                        TableColumn.TITLE,
                        TableColumn.DURATION,
                        TableColumn.USER_FAVORITE,
                        TableColumn.ACTIONS,
                    ],
                }),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'compact',
            },
            display: ListDisplayType.GRID,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: pickGridRows({
                    alignLeftColumns: [
                        TableColumn.TITLE,
                        TableColumn.ALBUM_ARTIST,
                        TableColumn.RELEASE_YEAR,
                    ],
                    columns: ALBUM_TABLE_COLUMNS,
                    enabledColumns: [
                        TableColumn.TITLE,
                        TableColumn.ALBUM_ARTIST,
                        TableColumn.RELEASE_YEAR,
                    ],
                    pickColumns: [
                        TableColumn.TITLE,
                        TableColumn.DURATION,
                        TableColumn.ALBUM_ARTIST,
                        TableColumn.BIT_RATE,
                        TableColumn.BPM,
                        TableColumn.DATE_ADDED,
                        TableColumn.GENRE,
                        TableColumn.PLAY_COUNT,
                        TableColumn.SONG_COUNT,
                        TableColumn.RELEASE_DATE,
                        TableColumn.RELEASE_YEAR,
                        TableColumn.LAST_PLAYED,
                    ],
                }),
                size: 'default',
            },
            itemsPerPage: 100,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: ALBUM_TABLE_COLUMNS.map((column) => ({
                    align: column.align,
                    autoSize: column.autoSize,
                    id: column.value,
                    isEnabled: column.isEnabled,
                    pinned: column.pinned,
                    width: column.width,
                })),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
        [LibraryItem.ALBUM_ARTIST]: {
            display: ListDisplayType.GRID,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: pickGridRows({
                    alignLeftColumns: [TableColumn.TITLE],
                    columns: ALBUM_ARTIST_TABLE_COLUMNS,
                    enabledColumns: [TableColumn.TITLE],
                    pickColumns: [
                        TableColumn.TITLE,
                        TableColumn.PLAY_COUNT,
                        TableColumn.ALBUM_COUNT,
                        TableColumn.SONG_COUNT,
                    ],
                }),
                size: 'default',
            },
            itemsPerPage: 100,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: pickTableColumns({
                    autoSizeColumns: [TableColumn.TITLE],
                    columns: ALBUM_ARTIST_TABLE_COLUMNS,
                    enabledColumns: [
                        TableColumn.ROW_INDEX,
                        TableColumn.IMAGE,
                        TableColumn.TITLE,
                        TableColumn.USER_FAVORITE,
                    ],
                }),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
        [LibraryItem.ARTIST]: {
            display: ListDisplayType.GRID,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: pickGridRows({
                    alignLeftColumns: [TableColumn.TITLE],
                    columns: ALBUM_ARTIST_TABLE_COLUMNS,
                    enabledColumns: [TableColumn.TITLE],
                    pickColumns: [
                        TableColumn.TITLE,
                        TableColumn.PLAY_COUNT,
                        TableColumn.ALBUM_COUNT,
                        TableColumn.SONG_COUNT,
                    ],
                }),
                size: 'default',
            },
            itemsPerPage: 100,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: pickTableColumns({
                    autoSizeColumns: [TableColumn.TITLE],
                    columns: ALBUM_ARTIST_TABLE_COLUMNS,
                    enabledColumns: [
                        TableColumn.ROW_INDEX,
                        TableColumn.IMAGE,
                        TableColumn.TITLE,
                        TableColumn.ALBUM_COUNT,
                        TableColumn.SONG_COUNT,
                        TableColumn.PLAY_COUNT,
                        TableColumn.LAST_PLAYED,
                        TableColumn.USER_FAVORITE,
                        TableColumn.USER_RATING,
                    ],
                }),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
        [LibraryItem.GENRE]: {
            display: ListDisplayType.TABLE,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: pickGridRows({
                    alignLeftColumns: [
                        TableColumn.TITLE,
                        TableColumn.SONG_COUNT,
                        TableColumn.ALBUM_COUNT,
                    ],
                    columns: GENRE_TABLE_COLUMNS,
                    enabledColumns: [
                        TableColumn.TITLE,
                        TableColumn.SONG_COUNT,
                        TableColumn.ALBUM_COUNT,
                    ],
                    pickColumns: [
                        TableColumn.TITLE,
                        TableColumn.ALBUM_COUNT,
                        TableColumn.SONG_COUNT,
                    ],
                }),
                size: 'default',
            },
            itemsPerPage: 100,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: false,
                columns: GENRE_TABLE_COLUMNS.map((column) => ({
                    align: column.align,
                    autoSize: column.autoSize,
                    id: column.value,
                    isEnabled: column.isEnabled,
                    pinned: column.pinned,
                    width: column.width,
                })),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'compact',
            },
        },
        [LibraryItem.PLAYLIST]: {
            display: ListDisplayType.TABLE,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: pickGridRows({
                    alignLeftColumns: [TableColumn.TITLE, TableColumn.SONG_COUNT],
                    columns: PLAYLIST_TABLE_COLUMNS,
                    enabledColumns: [TableColumn.TITLE],
                    pickColumns: [TableColumn.TITLE, TableColumn.SONG_COUNT],
                }),
                size: 'default',
            },
            itemsPerPage: 100,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: pickTableColumns({
                    autoSizeColumns: [TableColumn.TITLE],
                    columns: PLAYLIST_TABLE_COLUMNS,
                    enabledColumns: [
                        TableColumn.ROW_INDEX,
                        TableColumn.TITLE,
                        TableColumn.DURATION,
                        TableColumn.SONG_COUNT,
                    ],
                }),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
        [LibraryItem.PLAYLIST_SONG]: {
            display: ListDisplayType.TABLE,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: pickGridRows({
                    alignLeftColumns: [TableColumn.TITLE, TableColumn.ARTIST],
                    columns: PLAYLIST_SONG_TABLE_COLUMNS,
                    enabledColumns: [TableColumn.TITLE, TableColumn.ARTIST],
                    pickColumns: [
                        TableColumn.TITLE,
                        TableColumn.ARTIST,
                        TableColumn.DURATION,
                        TableColumn.BIT_RATE,
                        TableColumn.BPM,
                        TableColumn.CODEC,
                        TableColumn.DATE,
                        TableColumn.DATE_ADDED,
                        TableColumn.GENRE,
                        TableColumn.LAST_PLAYED,
                        TableColumn.RELEASE_DATE,
                        TableColumn.RELEASE_YEAR,
                        TableColumn.TRACK_NUMBER,
                        TableColumn.YEAR,
                    ],
                }),
                size: 'default',
            },
            itemsPerPage: 100,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: PLAYLIST_SONG_TABLE_COLUMNS.map((column) => ({
                    align: column.align,
                    autoSize: column.autoSize,
                    id: column.value,
                    isEnabled: column.isEnabled,
                    pinned: column.pinned,
                    width: column.width,
                })),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
        [LibraryItem.QUEUE_SONG]: {
            display: ListDisplayType.TABLE,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: [],
                size: 'default',
            },
            itemsPerPage: 100,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: SONG_TABLE_COLUMNS.map((column) => ({
                    align: column.align,
                    autoSize: column.autoSize,
                    id: column.value,
                    isEnabled: column.isEnabled,
                    pinned: column.pinned,
                    width: column.width,
                })),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
        [LibraryItem.SONG]: {
            display: ListDisplayType.TABLE,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: pickGridRows({
                    alignLeftColumns: [TableColumn.TITLE, TableColumn.ARTIST],
                    columns: SONG_TABLE_COLUMNS,
                    enabledColumns: [TableColumn.TITLE, TableColumn.ARTIST],
                    pickColumns: [
                        TableColumn.TITLE,
                        TableColumn.ARTIST,
                        TableColumn.DURATION,
                        TableColumn.BIT_RATE,
                        TableColumn.BPM,
                        TableColumn.CODEC,
                        TableColumn.DATE,
                        TableColumn.DATE_ADDED,
                        TableColumn.GENRE,
                        TableColumn.LAST_PLAYED,
                        TableColumn.RELEASE_DATE,
                        TableColumn.RELEASE_YEAR,
                        TableColumn.TRACK_NUMBER,
                        TableColumn.YEAR,
                    ],
                }),
                size: 'default',
            },
            itemsPerPage: 100,
            pagination: ListPaginationType.PAGINATED,
            table: {
                autoFitColumns: true,
                columns: SONG_TABLE_COLUMNS.map((column) => ({
                    align: column.align,
                    autoSize: column.autoSize,
                    id: column.value,
                    isEnabled: column.isEnabled,
                    pinned: column.pinned,
                    width: column.width,
                })),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
        ['sideQueue']: {
            display: ListDisplayType.TABLE,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: [],
                size: 'default',
            },
            itemsPerPage: 100,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: pickTableColumns({
                    autoSizeColumns: [TableColumn.TITLE_COMBINED],
                    columns: SONG_TABLE_COLUMNS,
                    enabledColumns: [
                        TableColumn.ROW_INDEX,
                        TableColumn.TITLE_COMBINED,
                        TableColumn.DURATION,
                        TableColumn.USER_FAVORITE,
                    ],
                }),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
    },
    lyrics: {
        alignment: 'center',
        delayMs: 0,
        enableFurigana: false,
        enableRomaji: false,
        fetch: true,
        follow: true,
        followScrollAlignment: 0,
        lineLeadTimeMs: 800,
        showMatch: true,
        showProvider: true,
    },
    lyricsDisplay: {
        default: {
            fontSize: 24,
            fontSizeUnsync: 24,
            gap: 24,
            gapUnsync: 24,
            opacityNonActive: 0.2,
            paddingLeft: 0,
            paddingRight: 0,
            scaleNonActive: 0.95,
        },
    },
    playback: {
        audioDeviceId: undefined,
        compressor: {
            attack: 20,
            enabled: false,
            knee: 2.83,
            makeup: 6,
            ratio: 4,
            release: 250,
            threshold: -24,
        },
        equalizer: {
            bands: [
                { freq: 31.5, gain: 0 },
                { freq: 63, gain: 0 },
                { freq: 125, gain: 0 },
                { freq: 250, gain: 0 },
                { freq: 500, gain: 0 },
                { freq: 1000, gain: 0 },
                { freq: 2000, gain: 0 },
                { freq: 3000, gain: 0 },
                { freq: 4000, gain: 0 },
                { freq: 6300, gain: 0 },
                { freq: 10000, gain: 0 },
                { freq: 16000, gain: 0 },
            ],
            enabled: false,
            preamp: 0,
        },
        mediaSession: false,
        transcode: {
            enabled: false,
        },
    },
    tab: 'general',
    visualizer: {
        audiomotionanalyzer: {
            alphaBars: false,
            ansiBands: false,
            barSpace: 0.7,
            channelLayout: 'single',
            colorMode: 'gradient',
            customGradients: [],
            fadePeaks: true,
            fftSize: 16384,
            fillAlpha: 0,
            frequencyScale: 'log',
            gradient: 'prism',
            gravity: 11,
            ledBars: false,
            linearAmplitude: false,
            linearBoost: 4,
            lineWidth: 1.9,
            loRes: false,
            lumiBars: false,
            maxDecibels: -25,
            maxFPS: 0,
            maxFreq: 22050,
            minDecibels: -85,
            minFreq: 20,
            mirror: 0,
            mode: 10,
            noteLabels: false,
            opacity: 1,
            outlineBars: false,
            peakFadeTime: 900,
            peakHoldTime: 500,
            peakLine: true,
            presets: audiomotionanalyzerPresets,
            radial: false,
            radialInvert: false,
            radius: 0.7,
            reflexAlpha: 0.1,
            reflexBright: 1,
            reflexFit: false,
            reflexRatio: 0.5,
            roundBars: false,
            showFPS: false,
            showPeaks: false,
            showScaleX: false,
            showScaleY: false,
            smoothing: 0.6,
            spinSpeed: 0,
            splitGradient: false,
            trueLeds: false,
            volume: 1,
            weightingFilter: '',
        },
        butterchurn: {
            blendTime: 2.5,
            currentPreset: undefined,
            cyclePresets: true,
            cycleTime: 30,
            ignoredPresets: [],
            includeAllPresets: true,
            maxFPS: 0,
            opacity: 1,
            randomizeNextPreset: true,
            selectedPresets: [],
        },
        type: 'audiomotionanalyzer',
    },
    window: {
        disableAutoUpdate: false,
        exitToTray: false,
        minimizeToTray: false,
        preventSleepOnPlayback: false,
        preventSuspendOnPlayback: false,
        releaseChannel: 'latest',
        startMinimized: false,
        tray: true,
        windowBarStyle: platformDefaultWindowBarStyle,
        windowBarTrackinfo: true,
    },
};

const initialStateWithEnv = mergeWith(
    cloneDeep(initialState),
    getEnvSettingsOverrides(),
) as SettingsState;

export const useSettingsStore = createWithEqualityFn<SettingsSlice>()(
    persist(
        devtools(
            subscribeWithSelector(
                immer((set) => ({
                    actions: {
                        addCollection: (collection: SavedCollection) => {
                            set((state) => {
                                state.general.collections.push(collection);
                            });
                        },
                        removeCollection: (id: string) => {
                            set((state) => {
                                state.general.collections = state.general.collections.filter(
                                    (c) => c.id !== id,
                                );
                            });
                        },
                        reset: () => {
                            localStorage.removeItem('store_settings');
                            window.location.reload();
                        },
                        setAlbumGroupItems: (items: SortableItem<AlbumGroupItem>[]) => {
                            set((state) => {
                                state.general.albumGroupItems = items;
                            });
                        },
                        setGenreBehavior: (target: GenreTarget) => {
                            set((state) => {
                                state.general.genreTarget = target;
                            });
                        },
                        setList: (type: ItemListKey, data: DeepPartial<ItemListSettings>) => {
                            set((state) => {
                                const listState = state.lists[type];

                                if (listState && data.table) {
                                    Object.assign(listState.table, data.table);
                                    delete data.table;
                                }

                                if (listState && data.detail) {
                                    if (!listState.detail) {
                                        const t = listState.table;
                                        listState.detail = {
                                            columns: t.columns,
                                            enableAlternateRowColors: false,
                                            enableHeader: t.enableHeader,
                                            enableHorizontalBorders: t.enableHorizontalBorders,
                                            enableRowHoverHighlight: t.enableRowHoverHighlight,
                                            enableVerticalBorders: t.enableVerticalBorders,
                                            size: t.size,
                                        };
                                    }
                                    Object.assign(listState.detail, data.detail);
                                    delete data.detail;
                                }

                                if (listState && data.grid) {
                                    Object.assign(listState.grid, data.grid);
                                    delete data.grid;
                                }

                                if (listState) {
                                    Object.assign(listState, data);
                                }
                            });
                        },
                        setPlaylistBehavior: (target: PlaylistTarget) => {
                            set((state) => {
                                state.general.playlistTarget = target;
                            });
                        },
                        setSettings: (data) => {
                            set((state) => {
                                deepMergeIntoState(state, data);
                            });
                        },
                        setTable: (type: ItemListKey, data: DataTableProps) => {
                            set((state) => {
                                const listState = state.lists[type];
                                if (listState) {
                                    listState.table = data;
                                }
                            });
                        },
                        setTranscodingConfig: (config) => {
                            set((state) => {
                                state.playback.transcode = config;
                            });
                        },
                        toggleMediaSession: () => {
                            set((state) => {
                                state.playback.mediaSession = !state.playback.mediaSession;
                            });
                        },
                        updateCollection: (
                            id: string,
                            updates: Partial<Omit<SavedCollection, 'id'>>,
                        ) => {
                            set((state) => {
                                const idx = state.general.collections.findIndex((c) => c.id === id);
                                if (idx !== -1) {
                                    Object.assign(state.general.collections[idx], updates);
                                }
                            });
                        },
                    },
                    ...initialStateWithEnv,
                })),
            ),
            { name: 'store_settings' },
        ),
        {
            merge: mergeOverridingColumns,
            migrate(persistedState, version) {
                const state = persistedState as SettingsSlice;

                if (version <= 9) {
                    if (!state.window.releaseChannel) {
                        state.window.releaseChannel = initialState.window.releaseChannel;
                    }

                    if (!state.playback.mediaSession) {
                        state.playback.mediaSession = initialState.playback.mediaSession;
                    }

                    state.window.windowBarStyle = Platform.LINUX;

                    return state;
                }

                if (version <= 11) {
                    return {};
                }

                if (version <= 14) {
                    // Add bitDepth and sampleRate columns to song lists

                    const bitDepthColumn: ItemTableListColumnConfig = {
                        align: 'center',
                        autoSize: false,
                        id: TableColumn.BIT_DEPTH,
                        isEnabled: false,
                        pinned: null,
                        width: 100,
                    };

                    const sampleRateColumn: ItemTableListColumnConfig = {
                        align: 'center',
                        autoSize: false,
                        id: TableColumn.SAMPLE_RATE,
                        isEnabled: false,
                        pinned: null,
                        width: 100,
                    };

                    const columns = [bitDepthColumn, sampleRateColumn];

                    state.lists[LibraryItem.SONG]?.table.columns.push(...columns);
                    state.lists[LibraryItem.PLAYLIST_SONG]?.table.columns.push(...columns);
                    state.lists[LibraryItem.QUEUE_SONG]?.table.columns.push(...columns);
                    state.lists['albumDetail']?.table.columns.push(...columns);
                    state.lists['fullscreen']?.table.columns.push(...columns);
                    state.lists['sidequeue']?.table.columns.push(...columns);
                }

                // Version 16 introduced a bug where the release channel may have been reset
                // to the latest channel. This is to revert it.
                if (version === 16) {
                    state.window.releaseChannel = 'beta';
                }

                if (version <= 17) {
                    // Migrate lyrics settings from record structure to separate lyrics and lyricsDisplay
                    if (
                        state.lyrics &&
                        typeof state.lyrics === 'object' &&
                        'default' in state.lyrics
                    ) {
                        const oldLyrics = state.lyrics as any;
                        const defaultSettings = oldLyrics.default || oldLyrics;

                        // Extract display settings
                        const displaySettings = {
                            fontSize: defaultSettings.fontSize || 24,
                            fontSizeUnsync: defaultSettings.fontSizeUnsync || 24,
                            gap: defaultSettings.gap || 24,
                            gapUnsync: defaultSettings.gapUnsync || 24,
                        };

                        // Remove display properties from main settings
                        // eslint-disable-next-line @typescript-eslint/no-unused-vars
                        const { fontSize, fontSizeUnsync, gap, gapUnsync, ...mainSettings } =
                            defaultSettings;

                        state.lyrics = mainSettings;
                        state.lyricsDisplay = {
                            default: {
                                ...state.lyricsDisplay.default,
                                ...displaySettings,
                            },
                        };
                    }
                }

                if (version <= 19) {
                    // Add IDs to presets that don't have them
                    if (
                        state.visualizer?.audiomotionanalyzer?.presets &&
                        Array.isArray(state.visualizer.audiomotionanalyzer.presets)
                    ) {
                        state.visualizer.audiomotionanalyzer.presets =
                            state.visualizer.audiomotionanalyzer.presets.map((preset) => {
                                if (!preset.id) {
                                    return {
                                        ...preset,
                                        id: nanoid(),
                                    };
                                }
                                return preset;
                            });
                    }
                }

                if (version <= 20) {
                    // Add TITLE_ARTIST column to SONG and ALBUM table configs
                    const titleArtistColumn: ItemTableListColumnConfig = {
                        align: 'start',
                        autoSize: false,
                        id: TableColumn.TITLE_ARTIST,
                        isEnabled: false,
                        pinned: null,
                        width: 300,
                    };

                    const listKeysToUpdate: (LibraryItem | string)[] = [
                        LibraryItem.SONG,
                        LibraryItem.ALBUM,
                        LibraryItem.PLAYLIST_SONG,
                        LibraryItem.QUEUE_SONG,
                        ItemListKey.ALBUM_DETAIL,
                        ItemListKey.FULL_SCREEN,
                        ItemListKey.SIDE_QUEUE,
                    ];

                    listKeysToUpdate.forEach((listKey) => {
                        const listConfig = state.lists[listKey];
                        if (listConfig?.table?.columns) {
                            const columns = listConfig.table.columns;
                            const hasTitleArtist = columns.some(
                                (col) => col.id === TableColumn.TITLE_ARTIST,
                            );
                            if (!hasTitleArtist) {
                                const titleCombinedIndex = columns.findIndex(
                                    (col) => col.id === TableColumn.TITLE_COMBINED,
                                );
                                if (titleCombinedIndex >= 0) {
                                    columns.splice(titleCombinedIndex + 1, 0, titleArtistColumn);
                                } else {
                                    columns.push(titleArtistColumn);
                                }
                            }
                        }
                    });
                }

                if (version <= 21) {
                    // Add COMPOSER column to SONG and ALBUM table configs
                    const composerColumn: ItemTableListColumnConfig = {
                        align: 'start',
                        autoSize: false,
                        id: TableColumn.COMPOSER,
                        isEnabled: false,
                        pinned: null,
                        width: 300,
                    };

                    const listKeysToUpdate: (LibraryItem | string)[] = [
                        LibraryItem.SONG,
                        LibraryItem.ALBUM,
                        LibraryItem.PLAYLIST_SONG,
                        LibraryItem.QUEUE_SONG,
                        ItemListKey.ALBUM_DETAIL,
                        ItemListKey.FULL_SCREEN,
                        ItemListKey.SIDE_QUEUE,
                    ];

                    listKeysToUpdate.forEach((listKey) => {
                        const listConfig = state.lists[listKey];
                        if (listConfig?.table?.columns) {
                            const columns = listConfig.table.columns;
                            const hasComposer = columns.some(
                                (col) => col.id === TableColumn.COMPOSER,
                            );
                            if (!hasComposer) {
                                const artistIndex = columns.findIndex(
                                    (col) => col.id === TableColumn.ARTIST,
                                );
                                if (artistIndex >= 0) {
                                    columns.splice(artistIndex + 1, 0, composerColumn);
                                } else {
                                    columns.push(composerColumn);
                                }
                            }
                        }
                    });
                }

                if (version <= 22) {
                    // Add enableHeader to all list table configs
                    Object.keys(state.lists).forEach((listKey) => {
                        const listConfig = state.lists[listKey as keyof typeof state.lists];
                        if (
                            listConfig?.table &&
                            typeof listConfig.table === 'object' &&
                            !('enableHeader' in listConfig.table)
                        ) {
                            (listConfig.table as any).enableHeader = true;
                        }
                    });
                }

                if (version <= 26) {
                    // Add ALBUM_GROUP column to the song table config
                    const listKeysToUpdate: ItemListKey[] = [
                        ItemListKey.SONG,
                        ItemListKey.FOLDER,
                        ItemListKey.PLAYLIST_SONG,
                        ItemListKey.ALBUM_ARTIST_SONG,
                        ItemListKey.GENRE_SONG,
                        ItemListKey.QUEUE_SONG,
                        ItemListKey.FULL_SCREEN,
                        ItemListKey.SIDE_QUEUE,
                    ];

                    listKeysToUpdate.forEach((listKey) => {
                        const listConfig = state.lists[listKey as keyof typeof state.lists];
                        if (listConfig?.table?.columns) {
                            const columns = listConfig.table.columns;
                            const hasAlbumGroup = columns.some(
                                (col) => col.id === TableColumn.ALBUM_GROUP,
                            );
                            if (!hasAlbumGroup) {
                                columns.push({
                                    align: 'start',
                                    autoSize: false,
                                    id: TableColumn.ALBUM_GROUP,
                                    isEnabled: false,
                                    pinned: 'left',
                                    width: 240,
                                });
                            }
                        }
                    });
                }

                if (version < 28) {
                    if (!state.autoDJ) {
                        state.autoDJ = { ...initialState.autoDJ };
                    }

                    if (state.autoDJ.mode !== 'albums' && state.autoDJ.mode !== 'songs') {
                        state.autoDJ.mode = initialState.autoDJ.mode;
                    }

                    const normalizeAutoDjStrategy = (stored: unknown) => {
                        if (stored === 'library_random') {
                            return AUTO_DJ_STRATEGY.LIBRARY_RANDOM;
                        }

                        if (
                            stored === 'similar' ||
                            stored === 'default' ||
                            stored === 'similar_forward'
                        ) {
                            return AUTO_DJ_STRATEGY.SIMILAR;
                        }

                        return initialState.autoDJ.songStrategy;
                    };

                    state.autoDJ.songStrategy = normalizeAutoDjStrategy(state.autoDJ.songStrategy);
                    state.autoDJ.albumStrategy = normalizeAutoDjStrategy(
                        state.autoDJ.albumStrategy,
                    );
                }

                if (version < 29) {
                    const dateColumn: ItemTableListColumnConfig = {
                        align: 'center',
                        autoSize: false,
                        id: TableColumn.DATE,
                        isEnabled: false,
                        pinned: null,
                        width: 240,
                    };
                    const yearColumn: ItemTableListColumnConfig = {
                        align: 'center',
                        autoSize: false,
                        id: TableColumn.YEAR,
                        isEnabled: false,
                        pinned: null,
                        width: 200,
                    };

                    const listKeysToUpdate: ItemListKey[] = [
                        ItemListKey.SONG,
                        ItemListKey.ALBUM_DETAIL,
                        ItemListKey.FOLDER,
                        ItemListKey.PLAYLIST_SONG,
                        ItemListKey.ALBUM_ARTIST_SONG,
                        ItemListKey.GENRE_SONG,
                        ItemListKey.QUEUE_SONG,
                        ItemListKey.FULL_SCREEN,
                        ItemListKey.SIDE_QUEUE,
                    ];

                    listKeysToUpdate.forEach((listKey) => {
                        const listConfig = state.lists[listKey];
                        if (listConfig?.table?.columns) {
                            const columns = listConfig.table.columns;
                            const hasYear = columns.some((col) => col.id === TableColumn.YEAR);
                            if (!hasYear) {
                                const releaseYearIndex = columns.findIndex(
                                    (col) => col.id === TableColumn.RELEASE_YEAR,
                                );
                                if (releaseYearIndex >= 0) {
                                    columns.splice(releaseYearIndex, 0, yearColumn);
                                } else {
                                    columns.push(yearColumn);
                                }
                            }
                            const hasDate = columns.some((col) => col.id === TableColumn.DATE);
                            if (!hasDate) {
                                const releaseDateIndex = columns.findIndex(
                                    (col) => col.id === TableColumn.RELEASE_DATE,
                                );
                                if (releaseDateIndex >= 0) {
                                    columns.splice(releaseDateIndex, 0, dateColumn);
                                } else {
                                    columns.push(dateColumn);
                                }
                            }
                        }
                    });
                    const listConfig = state.lists[ItemListKey.ALBUM];
                    if (listConfig?.detail?.columns) {
                        const columns = listConfig.detail.columns;
                        const hasYear = columns.some((col) => col.id === TableColumn.YEAR);
                        if (!hasYear) {
                            const releaseYearIndex = columns.findIndex(
                                (col) => col.id === TableColumn.RELEASE_YEAR,
                            );
                            if (releaseYearIndex >= 0) {
                                columns.splice(releaseYearIndex, 0, yearColumn);
                            } else {
                                columns.push(yearColumn);
                            }
                        }
                        const hasDate = columns.some((col) => col.id === TableColumn.DATE);
                        if (!hasDate) {
                            const releaseDateIndex = columns.findIndex(
                                (col) => col.id === TableColumn.RELEASE_DATE,
                            );
                            if (releaseDateIndex >= 0) {
                                columns.splice(releaseDateIndex, 0, dateColumn);
                            } else {
                                columns.push(dateColumn);
                            }
                        }
                    }
                }

                if (version < 30) {
                    for (const [key, displaySettings] of Object.entries(state.lyricsDisplay)) {
                        const legacySettings = displaySettings as typeof displaySettings & {
                            paddingX?: number;
                        };
                        const legacyPaddingX = legacySettings.paddingX ?? 0;

                        state.lyricsDisplay[key] = {
                            ...displaySettings,
                            paddingLeft: displaySettings.paddingLeft ?? legacyPaddingX,
                            paddingRight: displaySettings.paddingRight ?? legacyPaddingX,
                        };
                    }
                }

                if (version < 31) {
                    if (state.lyrics.followScrollAlignment === undefined) {
                        state.lyrics.followScrollAlignment = 0;
                    }
                }

                if (version < 32) {
                    // The tag editor is gone, and this step is the only thing
                    // that still names it: it has to keep running, because a
                    // store old enough to need it is old enough to need every
                    // step after it too.
                    const tagConfigs = (
                        state as SettingsSlice & {
                            tagEditor?: { tagConfigs?: Record<string, { multiValue: boolean }> };
                        }
                    ).tagEditor?.tagConfigs;
                    if (tagConfigs) {
                        for (const key of [
                            'albumArtistSort',
                            'ALBUMARTISTSSORT',
                            'artistSort',
                            'ARTISTSSORT',
                        ] as const) {
                            if (tagConfigs[key]) {
                                tagConfigs[key].multiValue = false;
                            }
                        }
                    }
                }

                if (version < 33) {
                    if (state.general.showQueueInSidebar === undefined) {
                        state.general.showQueueInSidebar = true;
                    }
                }

                if (version < 35) {
                    // Aoide has a Discord application of its own now. Anyone who
                    // never touched this field was announcing the upstream project
                    // by name, because the id is what Discord reads the name from;
                    // a field somebody edited themselves is left alone.
                    if (state.discord.clientId === '1165957668758900787') {
                        state.discord.clientId = '1547687515279069215';
                    }
                }

                if (version < 34) {
                    // The MPV backend went, and its keys are deleted so an
                    // exported settings file does not carry them forward. This
                    // step used to carry the sample rate and ReplayGain across
                    // the rename as well; both have since gone the same way as
                    // mpv, and step 43 below would only delete what this one
                    // wrote.
                    const playback = state.playback as typeof state.playback & {
                        mpvAudioDeviceId?: null | string;
                        mpvExtraParameters?: string[];
                        mpvProperties?: unknown;
                        type?: string;
                    };

                    delete playback.mpvProperties;
                    delete playback.mpvAudioDeviceId;
                    delete playback.mpvExtraParameters;
                    delete playback.type;
                }

                // Steps 8, 10, 13, 23, 27, 36 and 37 stood here. Every one of
                // them reshaped a stored list — the sidebar's rows, the home
                // page's, an artist page's — or a field the settings page no
                // longer offers, and step 48 below deletes the lot. Keeping
                // them would only mean editing something on its way to the bin.

                if (version < 38) {
                    // The tag editor's own settings — every tag's autocomplete
                    // source, its custom values and whether it takes more than
                    // one — have nothing left to configure. Deleted here rather
                    // than left to rot, so an exported settings file does not
                    // hand them to the next install.
                    delete (state as SettingsSlice & { tagEditor?: unknown }).tagEditor;
                }

                if (version < 39) {
                    // The 0.5x-2x control is gone, and with it the two settings
                    // that only meant anything while the rate was not 1.
                    delete (state.general as { microtonalPitchControls?: boolean })
                        .microtonalPitchControls;
                    delete (state.playback as { preservePitch?: boolean }).preservePitch;
                }

                if (version < 40) {
                    // "Show ratings" is gone. Every rating surface was already
                    // gated on the server type behind it, and this build signs
                    // in to Jellyfin, which has no star ratings at all.
                    delete (state.general as { showRatings?: boolean }).showRatings;
                }

                if (version < 41) {
                    // Sharing is gone; the default expiry it stored has nobody
                    // left to ask it.
                    delete (state.general as { shareExpiration?: unknown }).shareExpiration;
                }

                if (version < 42) {
                    // `disabledContextMenu` never had a reader or a writer.
                    delete (state.general as { disabledContextMenu?: unknown }).disabledContextMenu;
                }

                if (version < 43) {
                    // "Use web audio" turned the audio graph off, and with it
                    // the equaliser, the compressor, the visualiser, loudness
                    // levelling and the buffer deck. Nobody wants that; it is
                    // the only player now, and the switch went.
                    //
                    // ReplayGain's four fields went with it. There is one
                    // loudness switch, Level Volume, and it governs both halves
                    // — the tags a file carries and the measurement the server
                    // made — so a mode, a preamp, a clipping toggle and a
                    // fallback are four ways to disagree with a switch that is
                    // already on. The sample rate went too: the AudioContext
                    // takes the device's own rate, which is the one answer that
                    // never resamples. And the play/pause fade is simply always
                    // on now.
                    const playback = state.playback as typeof state.playback & {
                        audioFadeOnStatusChange?: boolean;
                        audioProperties?: unknown;
                        webAudio?: boolean;
                    };

                    delete playback.audioProperties;
                    delete playback.audioFadeOnStatusChange;
                    delete playback.webAudio;
                }

                if (version < 44) {
                    // Scrobbling had a definition of "a play" of its own — a
                    // percentage and a duration, either of them movable — while
                    // Aoide has one shared with the phone and with the SQL that
                    // recomputes play counts. Two definitions is a library where
                    // the count printed beside a track and the smart playlist
                    // that selects on it disagree, which nobody ever reports as
                    // a bug. Aoide's is the only one now, so the four fields go:
                    // the two thresholds it no longer sets, the switch (play
                    // counts are the point, and private mode already stops
                    // them), and the desktop notification on every song change.
                    delete (state.playback as { scrobble?: unknown }).scrobble;
                }

                if (version < 46) {
                    // The queue-filter rule builder is gone. Twelve fields and
                    // seventeen operators, to keep songs out of the queue —
                    // which is what "Hidden from Mixes" does in one tap, on
                    // both devices, from the track itself. The custom query
                    // tags went with the smart-playlist builder that read them;
                    // Jellyfin has no smart playlists, so that screen was
                    // already unreachable here.
                    delete (state.playback as { filters?: unknown }).filters;
                    delete (state as { queryBuilder?: unknown }).queryBuilder;

                    // Whoever had Hotkeys open when they last closed Settings
                    // would reopen it onto a tab strip with nothing selected.
                    if (state.tab === 'hotkeys') {
                        state.tab = 'general';
                    }
                }

                if (version < 48) {
                    // Everything the General tab used to hold beyond the three
                    // rows a person actually decides — appearance, the accent,
                    // custom CSS. Background blurs and aspect ratios and image
                    // resolutions and a play-button behaviour and four
                    // drag-reorderable lists and eleven ways to tune the
                    // playlist tree in the sidebar. None of it was a question
                    // anybody could answer better than the app can.
                    for (const key of [
                        'albumBackground',
                        'albumBackgroundBlur',
                        'artistBackground',
                        'artistBackgroundBlur',
                        'artistItems',
                        'artistRadioCount',
                        'artistReleaseTypeItems',
                        'autoSave',
                        'blurExplicitImages',
                        'buttonSize',
                        'confirmQueueChanges',
                        'enableGridMultiSelect',
                        'followCurrentSong',
                        'homeFeature',
                        'homeFeatureStyle',
                        'homeItems',
                        'imageRes',
                        'language',
                        'nativeAspectRatio',
                        'pathReplace',
                        'pathReplaceWith',
                        'playButtonBehavior',
                        'playerbarOpenDrawer',
                        'playerbarSlider',
                        'playerItems',
                        'primaryShade',
                        'resume',
                        'showFavorites',
                        'sideQueueLayout',
                        'sideQueueType',
                        'sidebarCollapseShared',
                        'sidebarCollapsedNavigation',
                        'sidebarItems',
                        'sidebarPanelOrder',
                        'sidebarPlaylistFolderSeparator',
                        'sidebarPlaylistFolderTreeIndent',
                        'sidebarPlaylistFolderTreeLineColor',
                        'sidebarPlaylistFolderView',
                        'sidebarPlaylistFolders',
                        'sidebarPlaylistList',
                        'sidebarPlaylistListFilterRegex',
                        'sidebarPlaylistMode',
                        'sidebarPlaylistSorting',
                        'skipButtons',
                        'useThemeAccentColor',
                        'useThemePrimaryShade',
                        'volumeWheelStep',
                        'volumeWidth',
                        'zoomFactor',
                    ] as const) {
                        delete (state.general as Record<string, unknown>)[key];
                    }
                }

                if (version < 49) {
                    // Five tabs became four, and two of them were renamed:
                    // "Window" is System now, and Advanced folded into it.
                    // Whoever had either open last would come back to a strip
                    // with nothing selected.
                    if (state.tab === 'window' || state.tab === 'advanced') {
                        state.tab = 'system';
                    }
                }

                if (version < 47) {
                    // The external-link row of icons under an album — Last.fm,
                    // ListenBrainz, MusicBrainz, Qobuz, Spotify — and the seven
                    // switches that decided which of them showed. Nobody here
                    // opens a track on Spotify from a page that is already
                    // playing it. The Last.fm API key went with them: it only
                    // ever fetched album art for Discord, which the server's
                    // own image covers.
                    for (const key of [
                        'externalLinks',
                        'lastFM',
                        'lastfmApiKey',
                        'listenBrainz',
                        'musicBrainz',
                        'nativeSpotify',
                        'qobuz',
                        'spotify',
                    ] as const) {
                        delete (state.general as Record<string, unknown>)[key];
                    }
                }

                if (version < 45) {
                    // Lyrics are two rows now, the phone's: whether to look
                    // them up and how far ahead of the music they run. Which
                    // provider to ask is not a decision anybody has the
                    // information to make — every source is asked and the first
                    // answer wins — and a file's own lyrics were always going
                    // to be the right ones, so both of those go. The rest was a
                    // machine-translation panel with an API key of its own; a
                    // library that ships translated lyrics still shows them.
                    for (const key of [
                        'enableAutoTranslation',
                        'enableNeteaseTranslation',
                        'preferLocalLyrics',
                        'sources',
                        'translationApiKey',
                        'translationApiProvider',
                        'translationTargetLanguage',
                    ] as const) {
                        delete (state.lyrics as Record<string, unknown>)[key];
                    }

                    // Furigana and romaji are properties of the lyrics on
                    // screen rather than of the app, and they moved to the
                    // lyrics view's own overlay controls. An older store may
                    // not have them at all, since both were optional.
                    state.lyrics.enableFurigana ??= initialState.lyrics.enableFurigana;
                    state.lyrics.enableRomaji ??= initialState.lyrics.enableRomaji;
                }

                return persistedState;
            },
            name: 'store_settings',
            version: 49,
        },
    ),
);

export const useSettingsStoreActions = () => useSettingsStore((state) => state.actions);

export const usePlaybackSettings = () => useSettingsStore((state) => state.playback, shallow);

export const useTableSettings = (type: ItemListKey) =>
    useSettingsStore((state) => state.lists[type as keyof typeof state.lists]);

export const useGeneralSettings = () => useSettingsStore((state) => state.general, shallow);

export const useWindowSettings = () => useSettingsStore((state) => state.window, shallow);

export const useWindowBarStyle = () =>
    useSettingsStore((state) => state.window.windowBarStyle, shallow);

export const useWindowBarTrackinfo = () =>
    useSettingsStore((state) => state.window.windowBarTrackinfo, shallow);

export const useHotkeySettings = () => useSettingsStore((state) => state.hotkeys, shallow);

export const useHotkeyBindings = () => useSettingsStore((state) => state.hotkeys.bindings, shallow);

export const useLayoutHotkeyBindings = () =>
    useSettingsStore(
        (state) => ({
            browserBack: state.hotkeys.bindings.browserBack,
            browserForward: state.hotkeys.bindings.browserForward,
            globalSearch: state.hotkeys.bindings.globalSearch,
            navigateHome: state.hotkeys.bindings.navigateHome,
            zoomIn: state.hotkeys.bindings.zoomIn,
            zoomOut: state.hotkeys.bindings.zoomOut,
        }),
        shallow,
    );

export const useLyricsSettings = () => useSettingsStore((state) => state.lyrics, shallow);

export const useLyricsDisplaySettings = (key: string = 'default') =>
    useSettingsStore((state) => state.lyricsDisplay[key] || state.lyricsDisplay.default, shallow);

export const useFontSettings = () => useSettingsStore((state) => state.font, shallow);

export const useDiscordSettings = () => useSettingsStore((state) => state.discord, shallow);

export const useCssSettings = () => useSettingsStore((state) => state.css, shallow);

const getSettingsStoreVersion = () => useSettingsStore.persist.getOptions().version!;

export const useSettingsForExport = (): SettingsState & { version: number } =>
    useSettingsStore((state) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- actions needs to be omitted from the export as it contains store functions
        const { actions, ...otherSettings } = state;
        return {
            ...otherSettings,
            version: getSettingsStoreVersion(),
        };
    });

export const migrateSettings = (settings: SettingsState, settingsVersion: number): SettingsState =>
    useSettingsStore.persist.getOptions().migrate!(settings, settingsVersion) as SettingsState;

export const useListSettings = (type: ItemListKey) =>
    useSettingsStore(
        (state) => state.lists[type as keyof typeof state.lists],
        shallow,
    ) as ItemListSettings;

export const usePrimaryColor = () => useSettingsStore((store) => store.general.accent, shallow);

export const useGenreTarget = () => useSettingsStore((store) => store.general.genreTarget, shallow);

export const usePlaylistTarget = () =>
    useSettingsStore((store) => store.general.playlistTarget, shallow);

export const useAccent = () => useSettingsStore((state) => state.general.accent, shallow);

export const useAlbumGroupImageSize = () =>
    useSettingsStore((state) => state.general.albumGroupImageSize);

export const useAlbumGroupShowFavoriteRating = () =>
    useSettingsStore((state) => state.general.albumGroupShowFavoriteRating);

export const useAlbumGroupVerticalLayout = () =>
    useSettingsStore((state) => state.general.albumGroupVerticalLayout);

export const useThemeSettings = () =>
    useSettingsStore(
        (state) => ({
            followSystemTheme: state.general.followSystemTheme,
            theme: state.general.theme,
            themeDark: state.general.themeDark,
            themeLight: state.general.themeLight,
        }),
        shallow,
    );

export const useCollections = () => {
    const collections = useSettingsStore((state) => state.general.collections, shallow);

    return useMemo(
        () => [...(collections ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
        [collections],
    );
};

export const useAlbumGroupItems = () =>
    useSettingsStore((state) => state.general.albumGroupItems, shallow);

export const useCombinedLyricsAndVisualizer = () =>
    useSettingsStore((state) => state.general.combinedLyricsAndVisualizer, shallow);

export const useShowLyricsInSidebar = () =>
    useSettingsStore((state) => state.general.showLyricsInSidebar, shallow);

export const useShowQueueInSidebar = () =>
    useSettingsStore((state) => state.general.showQueueInSidebar, shallow);

export const useShowVisualizerInSidebar = () =>
    useSettingsStore((state) => state.general.showVisualizerInSidebar, shallow);

export const useAutoDJSettings = () => useSettingsStore((store) => store.autoDJ, shallow);

export const useVisualizerSettings = () => useSettingsStore((store) => store.visualizer, shallow);

export const subscribeButterchurnPreset = (
    onChange: (preset: string | undefined, prevPreset: string | undefined) => void,
) => {
    return useSettingsStore.subscribe(
        (state) => state.visualizer.butterchurn.currentPreset,
        (preset, prevPreset) => {
            onChange(preset, prevPreset);
        },
    );
};

export const useButterchurnSettings = () => {
    return useSettingsStore((store) => {
        return {
            blendTime: store.visualizer.butterchurn.blendTime,
            cyclePresets: store.visualizer.butterchurn.cyclePresets,
            cycleTime: store.visualizer.butterchurn.cycleTime,
            ignoredPresets: store.visualizer.butterchurn.ignoredPresets,
            includeAllPresets: store.visualizer.butterchurn.includeAllPresets,
            maxFPS: store.visualizer.butterchurn.maxFPS,
            opacity: store.visualizer.butterchurn.opacity,
            randomizeNextPreset: store.visualizer.butterchurn.randomizeNextPreset,
            selectedPresets: store.visualizer.butterchurn.selectedPresets,
        };
    }, shallow);
};
