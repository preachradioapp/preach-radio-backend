import type {
    AudioDescription,
    CreateJobRequest,
    JobSettings,
    Output,
    OutputGroup,
} from '@aws-sdk/client-mediaconvert';
import { JOB_APP_TAG, MEDIA_ROOT } from './media.config';

/**
 * The adaptive ladder. Sermons are mostly one person talking, so 720p is the top
 * rung (1080p rarely adds visible quality and doubles the conversion cost).
 * `shortSide` is the height of landscape video and the width of portrait video,
 * so vertical clips keep their 9:16 shape at full sharpness.
 */
export const RENDITIONS = [
    { name: '480p', shortSide: 480, maxBitrate: 1_200_000 },
    { name: '720p', shortSide: 720, maxBitrate: 2_800_000 },
] as const;
export type Rendition = (typeof RENDITIONS)[number];

/** 4-second segments start fast; keyframes every 2 s keep segments aligned. */
export const SEGMENT_SECONDS = 4;
export const GOP_SECONDS = 2;
/** Poster: a frame every 3 s, at most 2 → the frame at ~3 s (the first is often black). */
export const POSTER_EVERY_SECONDS = 3;
export const POSTER_MAX_CAPTURES = 2;

export type Orientation = 'landscape' | 'portrait';

/** Where one conversion run writes. Run folders never overlap, so a re-run can't mix files. */
export const outputLayout = (podcastId: string, runId: string) => {
    const prefix = `${MEDIA_ROOT}/${podcastId}/${runId}/`;
    return {
        prefix,
        hlsDestination: `${prefix}hls/master`,
        hlsMasterKey: `${prefix}hls/master.m3u8`,
        posterDestination: `${prefix}poster/frame`,
        /** MediaConvert names captures frame.0000000.jpg, frame.0000001.jpg, … */
        posterKey: (durationMs?: number | null) => {
            const lastIndex =
                durationMs && durationMs >= POSTER_EVERY_SECONDS * 1000
                    ? POSTER_MAX_CAPTURES - 1
                    : 0;
            return `${prefix}poster/frame.${String(lastIndex).padStart(7, '0')}.jpg`;
        },
    };
};

/**
 * Uses the real size when the uploader sent it. Otherwise clips (reels) are
 * assumed vertical and episodes horizontal.
 */
export const orientationOf = (p: {
    videoWidth?: number | null;
    videoHeight?: number | null;
    type?: string | null;
}): Orientation => {
    if (p.videoWidth && p.videoHeight) {
        return p.videoHeight > p.videoWidth ? 'portrait' : 'landscape';
    }
    return p.type === 'clip' ? 'portrait' : 'landscape';
};

/** Never upscale: a 540p source gets only the 480p rung. Unknown size → full ladder. */
export const renditionsFor = (p: {
    videoWidth?: number | null;
    videoHeight?: number | null;
}): Rendition[] => {
    if (!p.videoWidth || !p.videoHeight) return [...RENDITIONS];
    const shortSide = Math.min(p.videoWidth, p.videoHeight);
    // 10% tolerance: a 704x396 phone export still gets 480p, a 704p source gets 720p.
    const fitting = RENDITIONS.filter((r) => r.shortSide <= shortSide * 1.1);
    return fitting.length ? fitting : [RENDITIONS[0]];
};

const aac = (bitrate: number): AudioDescription => ({
    AudioSourceName: 'Audio Selector 1',
    CodecSettings: {
        Codec: 'AAC',
        AacSettings: {
            Bitrate: bitrate,
            CodingMode: 'CODING_MODE_2_0',
            SampleRate: 48000,
        },
    },
});

const videoOutput = (r: Rendition, orientation: Orientation): Output => ({
    NameModifier: `_${r.name}`,
    ContainerSettings: { Container: 'M3U8', M3u8Settings: {} },
    VideoDescription: {
        // Only one side is set; MediaConvert scales the other evenly.
        ...(orientation === 'portrait'
            ? { Width: r.shortSide }
            : { Height: r.shortSide }),
        ScalingBehavior: 'DEFAULT',
        Sharpness: 50,
        CodecSettings: {
            Codec: 'H_264',
            H264Settings: {
                RateControlMode: 'QVBR',
                QvbrSettings: { QvbrQualityLevel: 7 },
                MaxBitrate: r.maxBitrate,
                QualityTuningLevel: 'SINGLE_PASS',
                CodecProfile: 'MAIN',
                CodecLevel: 'AUTO',
                GopSize: GOP_SECONDS,
                GopSizeUnits: 'SECONDS',
                SceneChangeDetect: 'TRANSITION_DETECTION',
                FramerateControl: 'INITIALIZE_FROM_SOURCE',
                ParControl: 'INITIALIZE_FROM_SOURCE',
            },
        },
    },
    AudioDescriptions: [aac(96_000)],
});

const hlsGroup = (destination: string, outputs: Output[]): OutputGroup => ({
    Name: 'HLS',
    OutputGroupSettings: {
        Type: 'HLS_GROUP_SETTINGS',
        HlsGroupSettings: {
            Destination: destination,
            SegmentLength: SEGMENT_SECONDS,
            MinSegmentLength: 0,
            SegmentControl: 'SEGMENTED_FILES',
            DirectoryStructure: 'SINGLE_DIRECTORY',
            ManifestDurationFormat: 'INTEGER',
            OutputSelection: 'MANIFESTS_AND_SEGMENTS',
            CodecSpecification: 'RFC_4281',
            StreamInfResolution: 'INCLUDE',
            ClientCache: 'ENABLED',
            ProgramDateTime: 'EXCLUDE',
            ManifestCompression: 'NONE',
            CaptionLanguageSetting: 'OMIT',
        },
    },
    Outputs: outputs,
});

const posterGroup = (
    destination: string,
    orientation: Orientation
): OutputGroup => ({
    Name: 'Poster',
    OutputGroupSettings: {
        Type: 'FILE_GROUP_SETTINGS',
        FileGroupSettings: { Destination: destination },
    },
    Outputs: [
        {
            ContainerSettings: { Container: 'RAW' },
            Extension: 'jpg',
            VideoDescription: {
                ...(orientation === 'portrait' ? { Width: 720 } : { Height: 720 }),
                CodecSettings: {
                    Codec: 'FRAME_CAPTURE',
                    FrameCaptureSettings: {
                        FramerateNumerator: 1,
                        FramerateDenominator: POSTER_EVERY_SECONDS,
                        MaxCaptures: POSTER_MAX_CAPTURES,
                        Quality: 80,
                    },
                },
            },
        },
    ],
});

export type JobInput = {
    bucket: string;
    inputKey: string;
    podcastId: string;
    runId: string;
    mediaType: 'audio' | 'video';
    orientation: Orientation;
    renditions: Rendition[];
};

/**
 * Video → HLS 480p + 720p (each with AAC audio) + a poster frame.
 * Audio → HLS audio-only (AAC 128 kbps), so both kinds play from one `hlsUrl`.
 * Uses Basic-tier features only (single-pass QVBR, no acceleration).
 */
export const buildJobSettings = (input: JobInput): JobSettings => {
    const layout = outputLayout(input.podcastId, input.runId);
    const s3 = (key: string) => `s3://${input.bucket}/${key}`;
    const isVideo = input.mediaType === 'video';

    const outputGroups: OutputGroup[] = isVideo
        ? [
              hlsGroup(
                  s3(layout.hlsDestination),
                  input.renditions.map((r) => videoOutput(r, input.orientation))
              ),
              posterGroup(s3(layout.posterDestination), input.orientation),
          ]
        : [
              hlsGroup(s3(layout.hlsDestination), [
                  {
                      NameModifier: '_audio',
                      ContainerSettings: { Container: 'M3U8', M3u8Settings: {} },
                      AudioDescriptions: [aac(128_000)],
                  },
              ]),
          ];

    return {
        TimecodeConfig: { Source: 'ZEROBASED' },
        Inputs: [
            {
                FileInput: s3(input.inputKey),
                TimecodeSource: 'ZEROBASED',
                AudioSelectors: {
                    'Audio Selector 1': { DefaultSelection: 'DEFAULT' },
                },
                // Phone videos store rotation as metadata; apply it.
                ...(isVideo ? { VideoSelector: { Rotate: 'AUTO' } } : {}),
            },
        ],
        OutputGroups: outputGroups,
    };
};

export const buildCreateJobRequest = (
    input: JobInput & { roleArn: string; queueArn?: string }
): CreateJobRequest => ({
    Role: input.roleArn,
    ...(input.queueArn ? { Queue: input.queueArn } : {}),
    Settings: buildJobSettings(input),
    // The EventBridge rule matches `app`; the webhook reads podcastId + runId.
    UserMetadata: {
        app: JOB_APP_TAG,
        podcastId: input.podcastId,
        runId: input.runId,
    },
    StatusUpdateInterval: 'SECONDS_60',
    AccelerationSettings: { Mode: 'DISABLED' },
    Priority: 0,
});
