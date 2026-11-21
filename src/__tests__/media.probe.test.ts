/* eslint-env node */
/**
 * MP4 header probe: display size with rotation applied, moov before or after mdat.
 * Files are synthesised in memory; no network.
 *
 *   npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { probeMp4, type RangeReader } from '../app/modules/media/media.probe';

const box = (type: string, ...payload: Buffer[]) => {
    const body = Buffer.concat(payload);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
};

const fixed = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(Math.round(n * 65536), 0);
    return b;
};

/** tkhd v0 with a rotation matrix (`deg`) and raw (encoded) width × height. */
const tkhd = (width: number, height: number, deg: 0 | 90 | 180 | 270 = 0, version: 0 | 1 = 0) => {
    const verFlags = Buffer.from([version, 0, 0, 7]);
    const times = Buffer.alloc(version === 1 ? 32 : 20);
    const misc = Buffer.alloc(16);
    const cos = Math.round(Math.cos((deg * Math.PI) / 180));
    const sin = Math.round(Math.sin((deg * Math.PI) / 180));
    const m = [cos, sin, 0, -sin, cos, 0, 0, 0, 1];
    const matrix = Buffer.concat(m.map((v, i) => (i === 8 ? (() => { const b = Buffer.alloc(4); b.writeInt32BE(0x40000000, 0); return b; })() : fixed(v))));
    return box('tkhd', verFlags, times, misc, matrix, fixed(width), fixed(height));
};

const hdlr = (handler: string) => box('hdlr', Buffer.alloc(4), Buffer.alloc(4), Buffer.from(handler, 'latin1'), Buffer.alloc(12));
const trak = (t: Buffer, handler: string) => box('trak', t, box('mdia', hdlr(handler)));
const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2mp41', 'latin1'));

const reader = (file: Buffer, log: [number, number][] = []): RangeReader => async (start, end) => {
    log.push([start, end]);
    if (start >= file.length) return null;
    return file.subarray(start, Math.min(end + 1, file.length));
};

describe('media probe', () => {
    it('reads a landscape video (fast start: moov before mdat)', async () => {
        const file = Buffer.concat([ftyp, box('moov', trak(tkhd(1280, 720), 'vide')), box('mdat', Buffer.alloc(1000))]);
        assert.deepEqual(await probeMp4(reader(file)), { width: 1280, height: 720 });
    });

    it('applies a 90° rotation (phone portrait recording stored as landscape frames)', async () => {
        const file = Buffer.concat([ftyp, box('moov', trak(tkhd(1920, 1080, 90), 'vide'))]);
        assert.deepEqual(await probeMp4(reader(file)), { width: 1080, height: 1920 });
    });

    it('keeps the size for 180° and handles tkhd version 1', async () => {
        const file = Buffer.concat([ftyp, box('moov', trak(tkhd(720, 1280, 180, 1), 'vide'))]);
        assert.deepEqual(await probeMp4(reader(file)), { width: 720, height: 1280 });
    });

    it('skips the audio track and finds the video track', async () => {
        const file = Buffer.concat([ftyp, box('moov', trak(tkhd(0, 0), 'soun'), trak(tkhd(720, 1280), 'vide'))]);
        assert.deepEqual(await probeMp4(reader(file)), { width: 720, height: 1280 });
    });

    it('finds moov after a large mdat without reading the media data', async () => {
        const mdat = box('mdat', Buffer.alloc(300 * 1024));
        const file = Buffer.concat([ftyp, mdat, box('moov', trak(tkhd(1080, 1920), 'vide'))]);
        const log: [number, number][] = [];
        assert.deepEqual(await probeMp4(reader(file, log)), { width: 1080, height: 1920 });
        const bytesRead = log.reduce((n, [s, e]) => n + (Math.min(e, file.length - 1) - s + 1), 0);
        assert.ok(bytesRead < 70 * 1024, `read ${bytesRead} bytes`);
    });

    it('returns null for audio-only and non-MP4 files', async () => {
        assert.equal(await probeMp4(reader(Buffer.concat([ftyp, box('moov', trak(tkhd(0, 0), 'soun'))]))), null);
        assert.equal(await probeMp4(reader(Buffer.from('ID3\x04 not an mp4 file at all', 'latin1'))), null);
    });
});
