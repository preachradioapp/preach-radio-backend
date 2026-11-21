/**
 * Reads a video's display size (width × height after rotation) from its MP4/MOV
 * header — no ffmpeg and no full download. Only the `moov` box is fetched with
 * HTTP Range requests (usually one or two requests of a few KB).
 *
 * Why: the apps decide between full-screen (portrait reels) and letterboxed
 * (landscape videos) from `videoWidth` / `videoHeight`. MediaConvert fills them in
 * after conversion, but when conversion is off, skipped or still running the
 * podcast had no size at all. Phones store most portrait recordings as landscape
 * frames plus a 90° rotation flag, so the rotation matrix must be applied here —
 * players report the raw (unrotated) frame size.
 */

export type VideoDims = { width: number; height: number };

/** Reads bytes [start, end] (inclusive). Returns fewer bytes at end of file, or null past it. */
// eslint-disable-next-line no-unused-vars -- parameter names in a type
export type RangeReader = (start: number, end: number) => Promise<Buffer | null>;

const FIRST_CHUNK = 64 * 1024;
/** A moov box for a long video is a few MB at most; anything bigger is not worth reading. */
const MAX_MOOV_BYTES = 16 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 64;

type Box = { type: string; start: number; headerSize: number; size: number };

/** Box header at `offset` in `buf`, or null if it doesn't fit. `size` 0 = "to end of file". */
const readBoxHeader = (buf: Buffer, offset: number): Box | null => {
    if (offset + 8 > buf.length) return null;
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
        if (offset + 16 > buf.length) return null;
        size = Number(buf.readBigUInt64BE(offset + 8));
        headerSize = 16;
    }
    if (size !== 0 && size < headerSize) return null;
    return { type, start: offset, headerSize, size };
};

/** Direct children of a container box held in `buf` (from `from` to `to`). */
const children = (buf: Buffer, from: number, to: number): Box[] => {
    const out: Box[] = [];
    let offset = from;
    while (offset < to) {
        const box = readBoxHeader(buf, offset);
        if (!box) break;
        const size = box.size || to - offset;
        if (offset + size > to) break;
        out.push({ ...box, size });
        offset += size;
    }
    return out;
};

const fixed16 = (buf: Buffer, at: number) => buf.readInt32BE(at) / 65536;

/** Parses a `tkhd` box: presentation size with the rotation in its matrix applied. */
export const parseTkhd = (buf: Buffer, box: Box): VideoDims | null => {
    const p = box.start + box.headerSize;
    if (p + 4 > box.start + box.size) return null;
    const version = buf.readUInt8(p);
    // version/flags (4) + times/ids/duration (20 or 32) + reserved/layer/group/volume (16)
    const matrixAt = p + 4 + (version === 1 ? 32 : 20) + 16;
    const widthAt = matrixAt + 36;
    if (widthAt + 8 > box.start + box.size) return null;
    const a = fixed16(buf, matrixAt);
    const d = fixed16(buf, matrixAt + 16);
    let width = Math.round(fixed16(buf, widthAt));
    let height = Math.round(fixed16(buf, widthAt + 4));
    if (width <= 0 || height <= 0) return null;
    // A 90° / 270° rotation has a = d = 0 (b, c = ±1): the picture is shown sideways.
    if (Math.abs(a) < 0.01 && Math.abs(d) < 0.01) [width, height] = [height, width];
    return { width, height };
};

/** Finds the first video track (`hdlr` = vide) in a complete `moov` buffer. */
export const parseMoov = (moov: Buffer): VideoDims | null => {
    const root = readBoxHeader(moov, 0);
    if (!root || root.type !== 'moov') return null;
    for (const trak of children(moov, root.headerSize, moov.length).filter((b) => b.type === 'trak')) {
        const parts = children(moov, trak.start + trak.headerSize, trak.start + trak.size);
        const tkhd = parts.find((b) => b.type === 'tkhd');
        const mdia = parts.find((b) => b.type === 'mdia');
        if (!tkhd || !mdia) continue;
        const hdlr = children(moov, mdia.start + mdia.headerSize, mdia.start + mdia.size).find((b) => b.type === 'hdlr');
        // hdlr payload: version/flags (4) + pre_defined (4) + handler_type (4)
        const handlerAt = hdlr ? hdlr.start + hdlr.headerSize + 8 : -1;
        if (!hdlr || handlerAt + 4 > moov.length) continue;
        if (moov.toString('latin1', handlerAt, handlerAt + 4) !== 'vide') continue;
        const dims = parseTkhd(moov, tkhd);
        if (dims) return dims;
    }
    return null;
};

/**
 * Walks the top-level boxes (ftyp, moov, mdat…) to the `moov` box, wherever it is
 * — at the start for "fast start" files, after the media data for others.
 */
export const probeMp4 = async (read: RangeReader): Promise<VideoDims | null> => {
    const first = await read(0, FIRST_CHUNK - 1);
    if (!first) return null;

    let offset = 0;
    for (let i = 0; i < MAX_TOP_LEVEL_BOXES; i++) {
        const head = offset + 16 <= first.length ? first.subarray(offset, offset + 16) : await read(offset, offset + 15);
        if (!head || head.length < 8) return null;
        const box = readBoxHeader(head, 0);
        if (!box) return null;
        if (box.type === 'moov') {
            if (box.size === 0 || box.size > MAX_MOOV_BYTES) return null;
            const moov = offset + box.size <= first.length ? first.subarray(offset, offset + box.size) : await read(offset, offset + box.size - 1);
            return moov && moov.length === box.size ? parseMoov(moov) : null;
        }
        if (box.size === 0) return null; // last box runs to end of file and wasn't moov
        offset += box.size;
    }
    return null;
};

/** Range reader over HTTP (CloudFront / S3 URLs both honour `Range`). */
export const httpRangeReader =
    (url: string, timeoutMs: number): RangeReader =>
    async (start, end) => {
        const res = await fetch(url, {
            headers: { Range: `bytes=${start}-${end}` },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 416) {
            await res.body?.cancel();
            return null;
        }
        // A 200 means the server ignored Range and is sending the whole file — never download that.
        if (res.status !== 206) {
            await res.body?.cancel();
            throw new Error(`Range request not honoured (HTTP ${res.status})`);
        }
        return Buffer.from(await res.arrayBuffer());
    };

/** Display size of the video at `url`, or null when it can't be determined (never throws). */
export const probeVideoDimensions = async (url: string | null | undefined, timeoutMs = 5000): Promise<VideoDims | null> => {
    if (!url || !/^https?:\/\//i.test(url) || /\.m3u8(\?|$)/i.test(url)) return null;
    try {
        return await probeMp4(httpRangeReader(url, timeoutMs));
    } catch {
        return null;
    }
};
