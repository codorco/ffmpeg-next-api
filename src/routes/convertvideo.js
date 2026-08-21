'use strict';

// POST /convert/video — professional, format-agnostic video transcoding endpoint.
// The caller describes the desired *result* in JSON; every FFmpeg detail (filters,
// codec flags, muxer selection, filter graphs) is decided here. Follows the same
// self-contained-route-file pattern as subtitle.js / addaudio.js: manual Busboy
// parsing, small pure builder functions, then the route handler at the bottom.

const express        = require('express');
const fs             = require('fs');
const path           = require('path');
const ffmpeg         = require('fluent-ffmpeg');
const Busboy         = require('busboy');
const uniqueFilename = require('unique-filename');

const constants     = require('../constants.js');
const logger        = require('../utils/logger.js');
const utils         = require('../utils/utils.js');
const inputresolver = require('../utils/inputresolver.js');
const bitratebudget = require('../utils/bitratebudget.js');

const router = express.Router();

// ── Lookup tables ───────────────────────────────────────────────────────────────

const VIDEO_CODEC_MAP = {
    h264:  'libx264',
    hevc:  'libx265',
    av1:   'libsvtav1',
    vp9:   'libvpx-vp9',
    mpeg4: 'mpeg4',
    prores: 'prores_ks',
};

const AUDIO_CODEC_MAP = {
    aac:  'libfdk_aac', // same encoder already used by the legacy /convert/video/to/mp4
    mp3:  'libmp3lame',
    opus: 'libopus',
    flac: 'flac',
    pcm:  'pcm_s16le',
};

// Named encoder presets → per-codec-family flag. x264/x265 accept the name as-is;
// vp9/av1 use numeric knobs with different scales, so we translate.
const X264_X265_PRESETS = ['ultrafast','superfast','veryfast','faster','fast','medium','slow','slower','veryslow'];
const VP9_SPEED_MAP      = { ultrafast:8, superfast:7, veryfast:6, faster:5, fast:4, medium:3, slow:2, slower:1, veryslow:0 };
const AV1_PRESET_MAP     = { ultrafast:12, superfast:11, veryfast:10, faster:9, fast:8, medium:6, slow:4, slower:3, veryslow:2 };

const RESOLUTION_PRESETS = { // base = horizontal (16:9); swapped when orientation resolves to "vertical" (see computeTargetDimensions)
    '480p':  { width: 854,  height: 480  },
    '720p':  { width: 1280, height: 720  },
    '1080p': { width: 1920, height: 1080 },
    '1440p': { width: 2560, height: 1440 },
    '2160p': { width: 3840, height: 2160 },
};

const LEGACY_NO_HDR_FORMATS = ['gif','apng','wmv','asf','mpeg','mpg','vob','dv','3gp','avi','flv'];

// One entry per supported container. `muxer` is passed as -f when the file
// extension alone isn't enough for ffmpeg to pick the right one. `forceVideoCodec`
// means the container leaves no real choice — the user's video.codec is ignored
// (with a warning) and this label is used for logging only (no explicit -c:v is
// emitted; the muxer's sole encoder is used automatically).
const FORMAT_CAPABILITIES = {
    mp4:  { muxer: null,      videoCodecs: ['h264','hevc','av1','mpeg4','copy'],        audioCodecs: ['aac','mp3','opus','flac','copy'] },
    mov:  { muxer: null,      videoCodecs: ['h264','hevc','prores','mpeg4','copy'],      audioCodecs: ['aac','mp3','pcm','copy'] },
    mkv:  { muxer: 'matroska',videoCodecs: ['h264','hevc','av1','vp9','mpeg4','prores','copy'], audioCodecs: ['aac','mp3','opus','flac','pcm','copy'] },
    avi:  { muxer: null,      videoCodecs: ['h264','mpeg4','copy'],                       audioCodecs: ['mp3','pcm','copy'] },
    webm: { muxer: null,      videoCodecs: ['vp9','av1','copy'],                          audioCodecs: ['opus','copy'] },
    flv:  { muxer: null,      videoCodecs: ['h264','copy'],                               audioCodecs: ['aac','mp3','copy'] },
    wmv:  { muxer: 'asf',     videoCodecs: ['h264','mpeg4','copy'],                        audioCodecs: ['aac','pcm','copy'] },
    mpeg: { muxer: 'mpeg',    videoCodecs: ['mpeg4','copy'],                               audioCodecs: ['mp3','pcm','copy'] },
    mpg:  { muxer: 'mpeg',    videoCodecs: ['mpeg4','copy'],                               audioCodecs: ['mp3','pcm','copy'] },
    ts:   { muxer: 'mpegts',  videoCodecs: ['h264','hevc','mpeg4','copy'],                 audioCodecs: ['aac','mp3','copy'] },
    m2ts: { muxer: 'mpegts',  videoCodecs: ['h264','hevc','mpeg4','copy'],                 audioCodecs: ['aac','mp3','pcm','copy'] },
    mts:  { muxer: 'mpegts',  videoCodecs: ['h264','hevc','mpeg4','copy'],                 audioCodecs: ['aac','mp3','pcm','copy'] },
    '3gp':{ muxer: '3gp',     videoCodecs: ['h264','mpeg4','copy'],                        audioCodecs: ['aac','copy'] },
    ogv:  { muxer: 'ogg',     videoCodecs: ['vp9','copy'],                                 audioCodecs: ['opus','flac','copy'] },
    gif:  { muxer: 'gif',     videoCodecs: ['copy'], forceVideoCodec: 'gif',                audioCodecs: null },
    apng: { muxer: 'apng',    videoCodecs: ['copy'], forceVideoCodec: 'apng',               audioCodecs: null },
    nut:  { muxer: 'nut',     videoCodecs: ['h264','hevc','av1','vp9','mpeg4','prores','copy'], audioCodecs: ['aac','mp3','opus','flac','pcm','copy'] },
    asf:  { muxer: 'asf',     videoCodecs: ['h264','mpeg4','copy'],                        audioCodecs: ['aac','pcm','copy'] },
    vob:  { muxer: 'vob',     videoCodecs: ['mpeg4','copy'],                               audioCodecs: ['mp3','pcm','copy'] },
    dv:   { muxer: 'dv',      videoCodecs: ['copy'], forceVideoCodec: 'dvvideo',            audioCodecs: ['pcm','copy'] },
    f4v:  { muxer: 'mp4',     videoCodecs: ['h264','copy'],                                audioCodecs: ['aac','mp3','copy'] },
    mxf:  { muxer: 'mxf',     videoCodecs: ['prores','mpeg4','copy'],                      audioCodecs: ['pcm','copy'] },
};

const ALLOWED_FPS            = ['source', 24, 25, 30, 50, 60];
const ALLOWED_CHANNELS       = [1, 2, 6, 8];
const ALLOWED_SAMPLE_RATES   = [22050, 32000, 44100, 48000, 96000];
const ALLOWED_COLOR_SPACES   = ['source', 'bt601', 'bt709', 'bt2020'];
const COLORSPACE_FILTER_MAP  = { bt601: 'bt601-6-625', bt709: 'bt709', bt2020: 'bt2020' };
const ALLOWED_RESIZE_MODES   = ['contain','cover','stretch','fitWidth','fitHeight','original'];
const ALLOWED_ROTATIONS      = ['auto', 0, 90, 180, 270];
const ALLOWED_FLIPS          = ['none','horizontal','vertical','both'];

// ── Small helpers ─────────────────────────────────────────────────────────────

function isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

function evenify(n) { n = Math.round(n); return n % 2 === 0 ? n : n + 1; }

function normalizeHexColor(hex) {
    if (typeof hex !== 'string') return null;
    let h = hex.trim();
    if (!h.startsWith('#')) h = '#' + h;
    if (/^#[0-9a-fA-F]{3}$/.test(h)) {
        h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
    }
    return /^#[0-9a-fA-F]{6}$/.test(h) ? h.toUpperCase() : null;
}

// Escapes a value for safe interpolation inside an ffmpeg filtergraph string
// (colons, backslashes, quotes, commas, brackets all have meaning there).
function escapeFilterValue(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

// ── Validation & defaults ──────────────────────────────────────────────────────

// Validates the raw user config against the rules in the spec and returns
// { errors, warnings, cfg } — cfg is the fully-defaulted, normalized config.
// Errors are collected (not thrown one-at-a-time) so the caller gets one clear
// friendly message per problem, mirroring addaudio.js's validateConfig style.
function validateAndNormalize(raw) {
    raw = isPlainObject(raw) ? raw : {};
    const errors   = [];
    const warnings = [];

    // ── format ──
    const format = (raw.format || 'mp4').toLowerCase();
    if (!FORMAT_CAPABILITIES[format]) {
        errors.push(`format "${format}" não é suportado. Use um destes: ${Object.keys(FORMAT_CAPABILITIES).join(', ')}`);
    }
    const caps = FORMAT_CAPABILITIES[format] || FORMAT_CAPABILITIES.mp4;

    // ── resolution ──
    const rawRes = isPlainObject(raw.resolution) ? raw.resolution : {};
    const preset = rawRes.preset || 'original';
    if (!['original','480p','720p','1080p','1440p','2160p','custom'].includes(preset)) {
        errors.push(`resolution.preset "${preset}" inválido. Use: original, 480p, 720p, 1080p, 1440p, 2160p ou custom`);
    }
    let orientation = rawRes.orientation || 'auto';
    if (!['horizontal','vertical','auto'].includes(orientation)) {
        errors.push(`resolution.orientation "${orientation}" inválido. Use "horizontal", "vertical" ou "auto"`);
    }
    if (preset === 'custom' && rawRes.orientation) {
        warnings.push('resolution.orientation é ignorado quando preset="custom" (use width/height diretamente)');
    }
    let customWidth = null, customHeight = null;
    if (preset === 'custom') {
        const custom = isPlainObject(rawRes.custom) ? rawRes.custom : rawRes;
        customWidth  = parseInt(custom.width, 10);
        customHeight = parseInt(custom.height, 10);
        if (!Number.isFinite(customWidth) || customWidth <= 0) {
            errors.push('resolution.custom.width deve ser um número positivo quando preset="custom"');
        }
        if (!Number.isFinite(customHeight) || customHeight <= 0) {
            errors.push('resolution.custom.height deve ser um número positivo quando preset="custom"');
        }
    }
    const resizeMode = rawRes.resizeMode || 'contain';
    if (!ALLOWED_RESIZE_MODES.includes(resizeMode)) {
        errors.push(`resolution.resizeMode "${resizeMode}" inválido. Use: ${ALLOWED_RESIZE_MODES.join(', ')}`);
    }
    const keepAspectRatio = rawRes.keepAspectRatio !== undefined ? !!rawRes.keepAspectRatio : true;

    const rawBg  = isPlainObject(rawRes.background) ? rawRes.background : {};
    const bgMode = rawBg.mode || 'color';
    if (!['color','blur','image'].includes(bgMode)) {
        errors.push(`resolution.background.mode "${bgMode}" inválido. Use: color, blur ou image`);
    }
    const bgColor = normalizeHexColor(rawBg.color || '#000000');
    if (!bgColor) {
        errors.push(`resolution.background.color "${rawBg.color}" inválido. Use um hexadecimal, ex: "#000000"`);
    }
    const bgStrength = rawBg.strength !== undefined ? parseFloat(rawBg.strength) : 20;
    if (!Number.isFinite(bgStrength) || bgStrength < 0 || bgStrength > 100) {
        errors.push('resolution.background.strength deve ser um número entre 0 e 100');
    }
    if (bgMode === 'image' && !isPlainObject(rawBg.image) && !rawBg.image) {
        errors.push('resolution.background.mode="image" requer resolution.background.image (ou o campo multipart "backgroundImage")');
    }

    // ── video ──
    const rawVideo = isPlainObject(raw.video) ? raw.video : {};
    const videoCodec = rawVideo.codec || 'h264';
    if (!VIDEO_CODEC_MAP[videoCodec] && videoCodec !== 'copy') {
        errors.push(`video.codec "${videoCodec}" inválido. Use: ${Object.keys(VIDEO_CODEC_MAP).concat('copy').join(', ')}`);
    }
    if (caps.forceVideoCodec) {
        if (rawVideo.codec && rawVideo.codec !== 'copy') {
            warnings.push(`Container "${format}" exige o codec "${caps.forceVideoCodec}" — video.codec "${rawVideo.codec}" foi ignorado`);
        }
    } else if (VIDEO_CODEC_MAP[videoCodec] || videoCodec === 'copy') {
        if (!caps.videoCodecs.includes(videoCodec)) {
            errors.push(`Container "${format}" não suporta o codec de vídeo "${videoCodec}". Use: ${caps.videoCodecs.join(', ')}`);
        }
    }

    const rawQuality = isPlainObject(rawVideo.quality) ? rawVideo.quality : null;
    let quality = null;
    const qualityCapableCodec = ['h264','hevc','av1','vp9','mpeg4'].includes(videoCodec);
    if (rawQuality) {
        const mode = rawQuality.mode || 'crf';
        if (!['crf','bitrate','maxSize'].includes(mode)) {
            errors.push(`video.quality.mode "${mode}" inválido. Use "crf", "bitrate" ou "maxSize"`);
        } else if (mode === 'crf') {
            if (!qualityCapableCodec) {
                errors.push(`video.quality.mode="crf" não se aplica ao codec "${videoCodec}"`);
            } else {
                const max = ['vp9','av1'].includes(videoCodec) ? 63 : 51;
                const value = parseInt(rawQuality.value, 10);
                if (!Number.isFinite(value) || value < 0 || value > max) {
                    errors.push(`video.quality.value deve ser um inteiro entre 0 e ${max} para o codec "${videoCodec}"`);
                } else {
                    quality = { mode: 'crf', value };
                }
            }
        } else if (mode === 'bitrate') {
            if (videoCodec === 'copy' || videoCodec === 'prores') {
                errors.push(`video.quality.mode="bitrate" não se aplica ao codec "${videoCodec}"`);
            } else if (!/^\d+[kKmM]$/.test(String(rawQuality.value || ''))) {
                errors.push('video.quality.value deve seguir o padrão "8M" ou "800k" quando mode="bitrate"');
            } else {
                quality = { mode: 'bitrate', value: String(rawQuality.value) };
            }
        } else { // maxSize — target maximum output file size, in megabytes
            if (videoCodec === 'copy' || videoCodec === 'prores') {
                errors.push(`video.quality.mode="maxSize" não se aplica ao codec "${videoCodec}"`);
            } else {
                const megabytes = parseFloat(rawQuality.value);
                if (!Number.isFinite(megabytes) || megabytes <= 0) {
                    errors.push('video.quality.value deve ser um número positivo (megabytes) quando mode="maxSize"');
                } else {
                    quality = { mode: 'maxSize', targetMegabytes: megabytes };
                }
            }
        }
    } else if (qualityCapableCodec) {
        quality = { mode: 'crf', value: 20 }; // smart default — matches other endpoints in this API
    }

    const encoderPreset = rawVideo.preset || 'medium';
    if (!X264_X265_PRESETS.includes(encoderPreset)) {
        errors.push(`video.preset "${encoderPreset}" inválido. Use: ${X264_X265_PRESETS.join(', ')}`);
    }
    if (rawVideo.preset && !['h264','hevc','vp9','av1'].includes(videoCodec)) {
        warnings.push(`video.preset é ignorado para o codec "${videoCodec}"`);
    }

    let fps = rawVideo.fps !== undefined ? rawVideo.fps : 'source';
    if (fps !== 'source') fps = parseInt(fps, 10);
    if (!ALLOWED_FPS.includes(fps)) {
        errors.push(`video.fps "${rawVideo.fps}" inválido. Use: ${ALLOWED_FPS.join(', ')}`);
    }

    const colorSpace = rawVideo.colorSpace || 'source';
    if (!ALLOWED_COLOR_SPACES.includes(colorSpace)) {
        errors.push(`video.colorSpace "${colorSpace}" inválido. Use: ${ALLOWED_COLOR_SPACES.join(', ')}`);
    }

    const hdr = rawVideo.hdr || 'auto';
    if (!['auto','keep','remove'].includes(hdr)) {
        errors.push(`video.hdr "${hdr}" inválido. Use: auto, keep ou remove`);
    }
    if (hdr === 'remove' && !['source','bt709'].includes(colorSpace)) {
        errors.push('video.hdr="remove" converte para bt709 — combine com video.colorSpace "source" ou "bt709", não "bt601"/"bt2020"');
    }

    let rotation = rawVideo.rotation !== undefined ? rawVideo.rotation : 'auto';
    if (rotation !== 'auto') rotation = parseInt(rotation, 10);
    if (!ALLOWED_ROTATIONS.includes(rotation)) {
        errors.push(`video.rotation "${rawVideo.rotation}" inválido. Use: ${ALLOWED_ROTATIONS.join(', ')}`);
    }

    const flip = rawVideo.flip || 'none';
    if (!ALLOWED_FLIPS.includes(flip)) {
        errors.push(`video.flip "${flip}" inválido. Use: ${ALLOWED_FLIPS.join(', ')}`);
    }

    // copy is only ever used when explicitly requested, and never silently
    // combined with a filter that would make "no re-encode" impossible.
    if (videoCodec === 'copy') {
        const needsFilterForScale = preset !== 'original' && resizeMode !== 'original';
        const conflicts = [];
        if (needsFilterForScale) conflicts.push('resolution (preset/resizeMode diferente de "original")');
        if (rotation !== 'auto' && rotation !== 0) conflicts.push('video.rotation');
        if (flip !== 'none') conflicts.push('video.flip');
        if (fps !== 'source') conflicts.push('video.fps');
        if (colorSpace !== 'source') conflicts.push('video.colorSpace');
        if (hdr === 'remove') conflicts.push('video.hdr="remove"');
        if (conflicts.length) {
            errors.push(`video.codec="copy" é incompatível com: ${conflicts.join(', ')}. Remova essas opções ou escolha outro codec`);
        }
    }

    // ── audio ──
    const rawAudio  = isPlainObject(raw.audio) ? raw.audio : {};
    const audioRemoveRequested = !!rawAudio.remove;
    const audioRemove = audioRemoveRequested || caps.audioCodecs === null;
    if (caps.audioCodecs === null && rawAudio && Object.keys(rawAudio).length && !audioRemoveRequested) {
        warnings.push(`Container "${format}" não suporta áudio — trilha de áudio será removida`);
    }

    let audioCodec = null, audioBitrate = null, audioChannels = null, audioSampleRate = null;
    if (!audioRemove) {
        audioCodec = rawAudio.codec || 'aac';
        if (!AUDIO_CODEC_MAP[audioCodec] && audioCodec !== 'copy') {
            errors.push(`audio.codec "${audioCodec}" inválido. Use: ${Object.keys(AUDIO_CODEC_MAP).concat('copy').join(', ')}`);
        } else if (caps.audioCodecs && !caps.audioCodecs.includes(audioCodec)) {
            errors.push(`Container "${format}" não suporta o codec de áudio "${audioCodec}". Use: ${caps.audioCodecs.join(', ')}`);
        }

        if (audioCodec === 'copy' && (rawAudio.channels !== undefined || rawAudio.sampleRate !== undefined)) {
            errors.push('audio.codec="copy" é incompatível com audio.channels/audio.sampleRate (removeria a possibilidade de copiar o stream sem reencodar)');
        }

        const bitrateApplies = ['aac','mp3','opus'].includes(audioCodec);
        if (rawAudio.bitrate !== undefined) {
            if (!bitrateApplies) {
                warnings.push(`audio.bitrate é ignorado para o codec "${audioCodec}"`);
            } else if (!/^\d+[kKmM]$/.test(String(rawAudio.bitrate))) {
                errors.push('audio.bitrate deve seguir o padrão "192k"');
            } else {
                audioBitrate = String(rawAudio.bitrate);
            }
        } else if (bitrateApplies) {
            audioBitrate = '192k';
        }

        if (rawAudio.channels !== undefined) {
            audioChannels = parseInt(rawAudio.channels, 10);
            if (!ALLOWED_CHANNELS.includes(audioChannels)) {
                errors.push(`audio.channels "${rawAudio.channels}" inválido. Use: ${ALLOWED_CHANNELS.join(', ')}`);
            }
        }
        if (rawAudio.sampleRate !== undefined) {
            audioSampleRate = parseInt(rawAudio.sampleRate, 10);
            if (!ALLOWED_SAMPLE_RATES.includes(audioSampleRate)) {
                errors.push(`audio.sampleRate "${rawAudio.sampleRate}" inválido. Use: ${ALLOWED_SAMPLE_RATES.join(', ')}`);
            }
        }
    }

    // ── metadata ──
    const rawMetadata = isPlainObject(raw.metadata) ? raw.metadata : {};
    const metadataMode = rawMetadata.mode || 'copy';
    if (!['copy','remove'].includes(metadataMode)) {
        errors.push(`metadata.mode "${metadataMode}" inválido. Use "copy" ou "remove"`);
    }

    return {
        errors,
        warnings,
        cfg: {
            format, caps,
            resolution: {
                preset, orientation, customWidth, customHeight, resizeMode, keepAspectRatio,
                background: { mode: bgMode, color: bgColor, strength: bgStrength, image: rawBg.image || null },
            },
            video: { codec: videoCodec, quality, preset: encoderPreset, fps, colorSpace, hdr, rotation, flip },
            audio: { remove: audioRemove, codec: audioCodec, bitrate: audioBitrate, channels: audioChannels, sampleRate: audioSampleRate },
            metadata: { mode: metadataMode },
        },
    };
}

// ── Resolution math ─────────────────────────────────────────────────────────────

// Resolves preset+orientation+custom into concrete {width,height}, or null when
// no scaling should happen at all (preset "original" / resizeMode "original").
// orientation:"auto" (the default) keeps the source's own portrait/landscape
// shape instead of forcing every preset into landscape — a 9:16 source asking
// for "720p" gets 720x1280, not 1280x720 with the sides padded/cropped away.
function computeTargetDimensions(cfg, sourceW, sourceH) {
    if (cfg.resolution.resizeMode === 'original' || cfg.resolution.preset === 'original') {
        return null;
    }
    if (cfg.resolution.preset === 'custom') {
        return { width: evenify(cfg.resolution.customWidth), height: evenify(cfg.resolution.customHeight) };
    }
    const base = RESOLUTION_PRESETS[cfg.resolution.preset];
    const orientation = cfg.resolution.orientation;
    const vertical = orientation === 'vertical' || (orientation === 'auto' && sourceH > sourceW);
    return {
        width:  evenify(vertical ? base.height : base.width),
        height: evenify(vertical ? base.width  : base.height),
    };
}

// ── Filter graph builders ───────────────────────────────────────────────────────

function buildRotateFlipFilters(rotation, flip) {
    const parts = [];
    if (rotation === 90)  parts.push('transpose=1');
    if (rotation === 180) parts.push('transpose=1', 'transpose=1');
    if (rotation === 270) parts.push('transpose=2');
    if (flip === 'horizontal' || flip === 'both') parts.push('hflip');
    if (flip === 'vertical'   || flip === 'both') parts.push('vflip');
    return parts;
}

function buildColorspaceFilter(colorSpace) {
    if (colorSpace === 'source') return null;
    return `colorspace=all=${COLORSPACE_FILTER_MAP[colorSpace]}`;
}

// SDR tonemap-down chain for HDR sources going to a target that won't carry HDR
// well. Requires zscale (libzimg) support in the FFmpeg build.
const HDR_TO_SDR_FILTER = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

function isSourceHDR(videoStream) {
    const transfer = (videoStream && videoStream.color_transfer || '').toLowerCase();
    return transfer === 'smpte2084' || transfer === 'arib-std-b67';
}

// Resolves hdr:"auto" into a concrete "keep"/"remove" decision. Computed once in
// process_() and threaded through to both the filter graph and the pix_fmt
// choice, so the two can never disagree about whether tonemap-to-SDR happened.
function resolveEffectiveHdr(cfg, sourceInfo) {
    if (cfg.video.hdr !== 'auto') return cfg.video.hdr;
    const sourceHDR = isSourceHDR(sourceInfo.videoStream);
    return sourceHDR && LEGACY_NO_HDR_FORMATS.includes(cfg.format) ? 'remove' : 'keep';
}

// Builds either a simple "-vf" chain (string) or a full filter_complex graph
// (string + explicit video map label + extra ffmpeg inputs), depending on
// whether background compositing needs a second/derived video source.
function buildVideoFilterPlan(cfg, sourceInfo, effectiveHdr) {
    const rotateFlip = buildRotateFlipFilters(cfg.video.rotation === 'auto' ? 0 : cfg.video.rotation, cfg.video.flip);
    const hdrFilter  = effectiveHdr === 'remove' ? [HDR_TO_SDR_FILTER] : [];

    const colorspaceFilter = effectiveHdr === 'remove' ? null : buildColorspaceFilter(cfg.video.colorSpace);

    const target = computeTargetDimensions(cfg, sourceInfo.width, sourceInfo.height);
    let resizeMode = cfg.resolution.resizeMode;
    if (cfg.resolution.keepAspectRatio === false && (resizeMode === 'contain' || resizeMode === 'cover')) {
        resizeMode = 'stretch';
    }

    const preScale = hdrFilter.concat(rotateFlip);

    if (!target) {
        // No scaling requested — just rotate/flip/tonemap/colorspace if needed.
        const chain = preScale.concat(colorspaceFilter ? [colorspaceFilter] : []);
        return { simpleVf: chain.length ? chain.join(',') : null, filterComplex: null, videoMapLabel: null, extraInputs: [] };
    }

    const w = target.width, h = target.height;

    if (resizeMode === 'stretch') {
        const chain = preScale.concat([`scale=${w}:${h}`]).concat(colorspaceFilter ? [colorspaceFilter] : []);
        return { simpleVf: chain.join(','), filterComplex: null, videoMapLabel: null, extraInputs: [] };
    }
    if (resizeMode === 'cover') {
        const chain = preScale.concat([`scale=${w}:${h}:force_original_aspect_ratio=increase`, `crop=${w}:${h}`]).concat(colorspaceFilter ? [colorspaceFilter] : []);
        return { simpleVf: chain.join(','), filterComplex: null, videoMapLabel: null, extraInputs: [] };
    }
    if (resizeMode === 'fitWidth') {
        const chain = preScale.concat([`scale=${w}:-2`]).concat(colorspaceFilter ? [colorspaceFilter] : []);
        return { simpleVf: chain.join(','), filterComplex: null, videoMapLabel: null, extraInputs: [] };
    }
    if (resizeMode === 'fitHeight') {
        const chain = preScale.concat([`scale=-2:${h}`]).concat(colorspaceFilter ? [colorspaceFilter] : []);
        return { simpleVf: chain.join(','), filterComplex: null, videoMapLabel: null, extraInputs: [] };
    }

    // resizeMode === 'contain' — may need letterbox/pillarbox background.
    const pre = preScale.length ? '[0:v]' + preScale.join(',') + '[rf];' : '';
    const mainLabel = preScale.length ? '[rf]' : '[0:v]';
    const post = colorspaceFilter ? ',' + colorspaceFilter : '';

    if (cfg.resolution.background.mode === 'color') {
        const color = escapeFilterValue(cfg.resolution.background.color);
        const chain = pre + mainLabel + `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${color}${post}[vout]`;
        return { simpleVf: null, filterComplex: chain, videoMapLabel: '[vout]', extraInputs: [] };
    }

    if (cfg.resolution.background.mode === 'blur') {
        const sigma = Math.max(1, Math.round((cfg.resolution.background.strength / 100) * 30));
        const graph = [
            pre.slice(0, -1), // drop trailing ';' — re-added below when joined
            mainLabel + 'split=2[bgsrc][fgsrc]',
            `[bgsrc]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=${sigma}[bgblur]`,
            `[fgsrc]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg]`,
            `[bgblur][fg]overlay=(W-w)/2:(H-h)/2${post}[vout]`,
        ].filter(Boolean).join(';');
        return { simpleVf: null, filterComplex: graph, videoMapLabel: '[vout]', extraInputs: [] };
    }

    // background.mode === 'image' — background is fed in as an extra ffmpeg input.
    const graph = [
        pre.slice(0, -1),
        mainLabel + `scale=${w}:${h}:force_original_aspect_ratio=decrease[fg]`,
        `[1:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1[bgimg]`,
        `[bgimg][fg]overlay=(W-w)/2:(H-h)/2${post}[vout]`,
    ].filter(Boolean).join(';');
    return { simpleVf: null, filterComplex: graph, videoMapLabel: '[vout]', extraInputs: ['backgroundImage'] };
}

// ── Target file-size quality mode ───────────────────────────────────────────────

const MIN_MAXSIZE_VIDEO_BITRATE_BPS = 100000; // floor — avoids an unusably low encode
const MAXSIZE_MARGIN = 0.95;                  // headroom for container/muxing overhead

// Estimates the audio track's contribution to the output size, in bits/sec, so
// resolveMaxSizeQuality() can reserve that much of the size budget and hand the
// rest to the video stream.
function estimateAudioBitrateBps(cfg, audioStream, warnings) {
    if (cfg.audio.remove) return 0;
    if (cfg.audio.codec === 'copy') {
        const probedBps = audioStream && parseInt(audioStream.bit_rate, 10);
        if (Number.isFinite(probedBps) && probedBps > 0) return probedBps;
        warnings.push('Não foi possível detectar o bitrate do áudio original para o cálculo de video.quality.mode="maxSize" — assumindo 128k');
        return 128000;
    }
    if (cfg.audio.bitrate) {
        const m = /^(\d+)([kKmM])$/.exec(cfg.audio.bitrate);
        const n = parseInt(m[1], 10);
        return m[2].toLowerCase() === 'm' ? n * 1000000 : n * 1000;
    }
    // Lossless codecs (flac/pcm) have no fixed bitrate — estimate from PCM math.
    warnings.push(`audio.codec="${cfg.audio.codec}" não tem bitrate fixo — o tamanho final com video.quality.mode="maxSize" pode variar mais do que o esperado`);
    const channels   = cfg.audio.channels   || (audioStream && audioStream.channels) || 2;
    const sampleRate = cfg.audio.sampleRate || parseInt(audioStream && audioStream.sample_rate, 10) || 48000;
    const pcmBps = sampleRate * channels * 16;
    return cfg.audio.codec === 'pcm' ? pcmBps : Math.round(pcmBps * 0.5);
}

// Resolves video.quality.mode="maxSize" (a target *file* size in MB) into a
// concrete video bitrate/maxrate/bufsize, using the probed source duration and
// an estimate of how much of the size budget the audio track will consume.
function resolveMaxSizeQuality(cfg, sourceDuration, hasAudio, audioStream, warnings) {
    if (!cfg.video.quality || cfg.video.quality.mode !== 'maxSize') return;

    if (!sourceDuration || sourceDuration <= 0) {
        warnings.push('Não foi possível determinar a duração do vídeo para calcular video.quality.mode="maxSize" — usando bitrate padrão de 2M');
        cfg.video.quality = { mode: 'maxSize', videoBitrateBps: 2000000, maxrateBps: 3000000, bufsizeBps: 4000000 };
        return;
    }

    const totalBudgetBps  = bitratebudget.computeBudgetBps(cfg.video.quality.targetMegabytes, sourceDuration, MAXSIZE_MARGIN);
    const audioBps        = hasAudio ? estimateAudioBitrateBps(cfg, audioStream, warnings) : 0;
    let videoBps           = Math.round(totalBudgetBps - audioBps);

    if (videoBps < MIN_MAXSIZE_VIDEO_BITRATE_BPS) {
        warnings.push(
            `O tamanho máximo pedido (${cfg.video.quality.targetMegabytes}MB) é muito baixo para ${sourceDuration.toFixed(1)}s de vídeo — ` +
            `usando o bitrate mínimo viável, o arquivo final pode ficar maior que o solicitado`
        );
        videoBps = MIN_MAXSIZE_VIDEO_BITRATE_BPS;
    }

    cfg.video.quality = {
        mode: 'maxSize',
        videoBitrateBps: videoBps,
        maxrateBps: Math.round(videoBps * 1.5),
        bufsizeBps: Math.round(videoBps * 2),
    };
}

function describeQuality(quality) {
    if (!quality) return 'source';
    if (quality.mode === 'crf') return `crf${quality.value}`;
    if (quality.mode === 'bitrate') return `bitrate${quality.value}`;
    if (quality.mode === 'maxSize') return `maxSize(video~${Math.round(quality.videoBitrateBps / 1000)}k)`;
    return quality.mode;
}

// ── FFmpeg output-options builders ──────────────────────────────────────────────

function buildVideoOptions(cfg, strategy) {
    const opts = [];
    const codec = cfg.video.codec;

    if (strategy.copyVideo) {
        opts.push('-c:v copy');
        return opts;
    }

    if (cfg.caps.forceVideoCodec) {
        // gif/apng/dv — the muxer only accepts one encoder; dv needs it explicit.
        if (cfg.caps.forceVideoCodec === 'dvvideo') opts.push('-c:v dvvideo');
        // gif/apng: no explicit -c:v, let the muxer pick its only valid encoder.
    } else {
        opts.push(`-c:v ${VIDEO_CODEC_MAP[codec]}`);
    }

    const skipQualityAndPreset = !!cfg.caps.forceVideoCodec;
    if (!skipQualityAndPreset && cfg.video.quality) {
        if (cfg.video.quality.mode === 'crf') {
            opts.push(`-crf ${cfg.video.quality.value}`);
        } else if (cfg.video.quality.mode === 'maxSize') {
            opts.push(
                `-b:v ${cfg.video.quality.videoBitrateBps}`,
                `-maxrate ${cfg.video.quality.maxrateBps}`,
                `-bufsize ${cfg.video.quality.bufsizeBps}`
            );
        } else {
            opts.push(`-b:v ${cfg.video.quality.value}`);
        }
    }
    if (!skipQualityAndPreset) {
        if (codec === 'h264' || codec === 'hevc') {
            opts.push(`-preset ${cfg.video.preset}`);
        } else if (codec === 'vp9') {
            opts.push(`-speed ${VP9_SPEED_MAP[cfg.video.preset]}`);
            if (cfg.video.quality && cfg.video.quality.mode === 'crf') opts.push('-b:v 0');
        } else if (codec === 'av1') {
            opts.push(`-preset ${AV1_PRESET_MAP[cfg.video.preset]}`);
        } else if (codec === 'prores') {
            opts.push('-profile:v 2'); // "standard" ProRes 422
        }
    }

    if (cfg.video.fps !== 'source') opts.push(`-r ${cfg.video.fps}`);

    if (!['gif','apng'].includes(cfg.format)) {
        if (codec === 'prores') opts.push('-pix_fmt yuv422p10le');
        else if ((codec === 'hevc' || codec === 'av1' || codec === 'vp9') && strategy.keepHdrDepth) opts.push('-pix_fmt yuv420p10le');
        else opts.push('-pix_fmt yuv420p');
    }

    return opts;
}

function buildAudioOptions(cfg, strategy) {
    if (cfg.audio.remove) return ['-an'];
    const opts = [];
    if (strategy.copyAudio) {
        opts.push('-c:a copy');
        return opts;
    }
    opts.push(`-c:a ${AUDIO_CODEC_MAP[cfg.audio.codec]}`);
    if (cfg.audio.bitrate) opts.push(`-b:a ${cfg.audio.bitrate}`);
    if (cfg.audio.channels) opts.push(`-ac ${cfg.audio.channels}`);
    if (cfg.audio.sampleRate) opts.push(`-ar ${cfg.audio.sampleRate}`);
    return opts;
}

function buildMetadataOptions(cfg) {
    return cfg.metadata.mode === 'remove' ? ['-map_metadata -1', '-map_chapters -1'] : ['-map_metadata 0'];
}

// ── Route handler ────────────────────────────────────────────────────────────────

const jsonBodyLimit  = Math.ceil(constants.fileSizeLimit * 1.4) + 65536; // base64 overhead
const jsonBodyParser = express.json({ limit: jsonBodyLimit });

router.post('/video', function (req, res, next) {
    const contentType = req.headers['content-type'] || '';
    if (contentType.indexOf('multipart/form-data') !== -1) {
        return handleMultipart(req, res, next);
    }
    return jsonBodyParser(req, res, function (err) {
        if (err) return fail(res, 400, 'JSON inválido no corpo da requisição: ' + err.message);
        return handleJson(req, res, next);
    });
});

function fail(res, code, msg) {
    res.writeHead(code, { 'Connection': 'close', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}

function cleanup(paths) {
    (paths || []).forEach(function (p) {
        if (p) try { utils.deleteFile(p); } catch (_) {}
    });
}

// ── JSON transport (base64 / url / localFile only — no native binary upload) ────

function handleJson(req, res, next) {
    const body = req.body || {};
    resolveSource(body, function (err, videoPath, isPersistent) {
        if (err) return fail(res, 400, 'Não foi possível obter o vídeo de entrada: ' + err.message);
        resolveBackgroundImage(body.resolution, function (bgErr, bgPath) {
            if (bgErr) {
                if (!isPersistent) cleanup([videoPath]);
                return fail(res, 400, 'Não foi possível obter a imagem de fundo: ' + bgErr.message);
            }
            process_(req, res, next, body, videoPath, isPersistent, bgPath);
        });
    });
}

// resolves body.base64 / body.url / body.localFile (exactly one expected)
function resolveSource(body, cb) {
    const sources = ['base64', 'url', 'localFile'].filter(function (k) { return body[k]; });
    if (sources.length === 0) return cb(new Error('informe exatamente uma fonte: "base64", "url" ou "localFile"'));
    if (sources.length > 1)  return cb(new Error('informe apenas uma fonte de vídeo por requisição (' + sources.join(', ') + ' foram enviados)'));

    const key = sources[0];
    if (key === 'base64')    return inputresolver.resolveBase64(body.base64, function (e, p) { cb(e, p, false); });
    if (key === 'url')       return inputresolver.resolveUrl(body.url, function (e, p) { cb(e, p, false); });
    try {
        const p = inputresolver.resolveLocalFile(body.localFile);
        return cb(null, p, true);
    } catch (e) {
        return cb(e);
    }
}

function resolveBackgroundImage(resolution, cb) {
    const img = resolution && isPlainObject(resolution.background) ? resolution.background.image : null;
    if (!img || !isPlainObject(img)) return cb(null, null);
    if (img.base64)    return inputresolver.resolveBase64(img.base64, cb);
    if (img.url)        return inputresolver.resolveUrl(img.url, cb);
    if (img.localFile) {
        try { return cb(null, inputresolver.resolveLocalFile(img.localFile)); }
        catch (e) { return cb(e); }
    }
    return cb(null, null);
}

// ── Multipart transport ──────────────────────────────────────────────────────────

function handleMultipart(req, res, next) {
    let videoPath = null;
    let backgroundImagePath = null;
    let configStr = '{}';
    let base64Field = null, urlField = null, localFileField = null;
    let pendingWrites = 0, busboyDone = false;

    let bb;
    try {
        bb = new Busboy({ headers: req.headers, limits: { files: 2, fields: 10, fileSize: constants.fileSizeLimit } });
    } catch (e) {
        return fail(res, 400, 'Requisição multipart inválida');
    }

    bb.on('field', function (fieldname, val) {
        if (fieldname === 'config')    configStr      = val;
        if (fieldname === 'base64')    base64Field    = val;
        if (fieldname === 'url')       urlField       = val;
        if (fieldname === 'localFile') localFileField = val;
    });

    bb.on('file', function (fieldname, file, filename) {
        pendingWrites++;
        const savePath = uniqueFilename('/tmp/') + '-' + path.basename(filename || fieldname);
        const ws = fs.createWriteStream(savePath);
        file.on('limit', function () {
            logger.error(`convertvideo: file size limit hit for ${filename || fieldname}`);
        });
        file.pipe(ws);
        ws.on('finish', function () {
            if (fieldname === 'video') videoPath = savePath;
            else if (fieldname === 'backgroundImage') backgroundImagePath = savePath;
            pendingWrites--;
            tryProcess();
        });
        ws.on('error', function (err) {
            logger.error(`convertvideo: write error [${fieldname}]: ${err}`);
            pendingWrites--;
            tryProcess();
        });
    });

    bb.on('finish', function () { busboyDone = true; tryProcess(); });
    bb.on('error', function (err) {
        logger.error(`convertvideo: busboy error: ${err}`);
        fail(res, 500, 'Erro no upload: ' + err);
    });

    req.pipe(bb);

    function tryProcess() {
        if (busboyDone && pendingWrites === 0) finalizeMultipartSource();
    }

    function finalizeMultipartSource() {
        let cfg;
        try { cfg = JSON.parse(configStr); } catch (e) {
            return fail(res, 400, 'JSON inválido no campo "config"');
        }

        const sourcesGiven = [videoPath && 'video', base64Field && 'base64', urlField && 'url', localFileField && 'localFile'].filter(Boolean);
        if (sourcesGiven.length === 0) {
            return fail(res, 400, 'informe exatamente uma fonte: arquivo "video", ou os campos "base64", "url" ou "localFile"');
        }
        if (sourcesGiven.length > 1) {
            cleanup([videoPath]);
            return fail(res, 400, 'informe apenas uma fonte de vídeo por requisição (' + sourcesGiven.join(', ') + ' foram enviados)');
        }

        function withResolvedBackground(finalVideoPath, isPersistent) {
            // An uploaded "backgroundImage" file always wins over a config-supplied
            // base64/url/localFile reference — no need to resolve the latter at all.
            if (backgroundImagePath) {
                return process_(req, res, next, cfg, finalVideoPath, isPersistent, backgroundImagePath);
            }
            resolveBackgroundImage(cfg.resolution, function (bgErr, bgPathFromCfg) {
                if (bgErr) {
                    if (!isPersistent) cleanup([finalVideoPath]);
                    return fail(res, 400, 'Não foi possível obter a imagem de fundo: ' + bgErr.message);
                }
                process_(req, res, next, cfg, finalVideoPath, isPersistent, bgPathFromCfg);
            });
        }

        if (videoPath) return withResolvedBackground(videoPath, false);

        const cb = function (err, p) {
            if (err) return fail(res, 400, 'Não foi possível obter o vídeo de entrada: ' + err.message);
            withResolvedBackground(p, sourcesGiven[0] === 'localFile');
        };
        if (base64Field)    return inputresolver.resolveBase64(base64Field, cb);
        if (urlField)        return inputresolver.resolveUrl(urlField, cb);
        try { return cb(null, inputresolver.resolveLocalFile(localFileField)); }
        catch (e) { return cb(e); }
    }
}

// ── Shared processing (both transports converge here) ───────────────────────────

function process_(req, res, next, rawCfg, videoPath, videoIsPersistent, backgroundImagePath) {
    const startTime = Date.now();
    const { errors, warnings, cfg } = validateAndNormalize(rawCfg);

    if (errors.length) {
        if (!videoIsPersistent) cleanup([videoPath]);
        cleanup([backgroundImagePath]);
        return fail(res, 400, errors.join('; '));
    }

    ffmpeg.ffprobe(videoPath, function (probeErr, metadata) {
        if (probeErr) {
            if (!videoIsPersistent) cleanup([videoPath]);
            cleanup([backgroundImagePath]);
            return fail(res, 400, 'Não foi possível ler o arquivo de vídeo (pode estar corrompido ou em formato não suportado): ' + probeErr.message);
        }

        const streams    = metadata.streams || [];
        const videoStream = streams.find(function (s) { return s.codec_type === 'video'; });
        const audioStream = streams.find(function (s) { return s.codec_type === 'audio'; });
        const hasAudio    = !!audioStream;

        if (!videoStream) {
            if (!videoIsPersistent) cleanup([videoPath]);
            cleanup([backgroundImagePath]);
            return fail(res, 400, 'Nenhuma faixa de vídeo encontrada no arquivo de entrada');
        }

        if (!hasAudio && !cfg.audio.remove) {
            warnings.push('Arquivo de entrada não possui áudio — nenhuma faixa de áudio será gerada');
        }

        const sourceInfo = {
            width:  videoStream.width  || 0,
            height: videoStream.height || 0,
            videoStream: videoStream,
        };
        const sourceFormat = (metadata.format && metadata.format.format_name) || 'unknown';
        const sourceDuration = parseFloat((metadata.format || {}).duration) || 0;

        resolveMaxSizeQuality(cfg, sourceDuration, hasAudio, audioStream, warnings);

        const effectiveHdr = resolveEffectiveHdr(cfg, sourceInfo);
        const filterPlan = buildVideoFilterPlan(cfg, sourceInfo, effectiveHdr);

        // Safety net: never silently drop a filter the user asked for just to
        // honor codec:"copy" — if a filter really is needed, fall back to h264.
        let strategy = { copyVideo: cfg.video.codec === 'copy', copyAudio: cfg.audio.codec === 'copy' };
        if (strategy.copyVideo && (filterPlan.simpleVf || filterPlan.filterComplex)) {
            warnings.push('video.codec="copy" não pôde ser usado porque uma conversão (HDR/orientação) era necessária — usando h264');
            cfg.video.codec = 'h264';
            if (!cfg.video.quality) cfg.video.quality = { mode: 'crf', value: 20 };
            strategy.copyVideo = false;
        }
        strategy.keepHdrDepth = isSourceHDR(videoStream) && effectiveHdr !== 'remove';

        const target = computeTargetDimensions(cfg, sourceInfo.width, sourceInfo.height);
        const outFormat  = cfg.format;
        const outFile    = uniqueFilename('/tmp/') + '-convertvideo.' + outFormat;

        const cmd = ffmpeg().renice(constants.defaultFFMPEGProcessPriority);
        cmd.input(videoPath);
        if (filterPlan.extraInputs.indexOf('backgroundImage') !== -1) {
            if (!backgroundImagePath) {
                if (!videoIsPersistent) cleanup([videoPath]);
                return fail(res, 400, 'resolution.background.mode="image" requer uma imagem de fundo válida');
            }
            cmd.input(backgroundImagePath);
        }

        const outOpts = [];
        if (cfg.caps.muxer) outOpts.push('-f', cfg.caps.muxer);

        if (filterPlan.filterComplex) {
            outOpts.push('-filter_complex', filterPlan.filterComplex, '-map', filterPlan.videoMapLabel);
            if (!cfg.audio.remove && hasAudio) outOpts.push('-map', '0:a');
        } else if (filterPlan.simpleVf) {
            outOpts.push('-vf', filterPlan.simpleVf);
        }

        outOpts.push.apply(outOpts, buildVideoOptions(cfg, strategy));
        if (hasAudio) outOpts.push.apply(outOpts, buildAudioOptions(cfg, strategy));
        outOpts.push.apply(outOpts, buildMetadataOptions(cfg));
        outOpts.push('-threads 8');

        logger.debug(`convertvideo: outputOptions=${JSON.stringify(outOpts)}`);

        cmd.outputOptions(outOpts)
            .on('error', function (err) {
                logger.error(`convertvideo error: ${err}`);
                if (!videoIsPersistent) cleanup([videoPath]);
                cleanup([backgroundImagePath, outFile]);
                fail(res, 500, String(err));
            })
            .on('end', function () {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(2) + 's';
                ffmpeg.ffprobe(outFile, function (outErr, outMeta) {
                    const outVideoStream = !outErr && (outMeta.streams || []).find(function (s) { return s.codec_type === 'video'; });
                    const finalWidth  = outVideoStream ? outVideoStream.width  : (target ? target.width  : sourceInfo.width);
                    const finalHeight = outVideoStream ? outVideoStream.height : (target ? target.height : sourceInfo.height);
                    const finalDuration = !outErr ? parseFloat((outMeta.format || {}).duration) || sourceDuration : sourceDuration;

                    const qualityDesc = strategy.copyVideo ? 'copy' : describeQuality(cfg.video.quality);

                    logger.info(
                        `convertvideo done sourceFormat=${sourceFormat} outputFormat=${outFormat} ` +
                        `sourceResolution=${sourceInfo.width}x${sourceInfo.height} outputResolution=${finalWidth}x${finalHeight} ` +
                        `videoCodec=${strategy.copyVideo ? 'copy' : cfg.video.codec} quality=${qualityDesc} ` +
                        `audioCodec=${cfg.audio.remove ? 'none' : (strategy.copyAudio ? 'copy' : cfg.audio.codec)} ` +
                        `fps=${cfg.video.fps} duration=${finalDuration} strategy=${strategy.copyVideo ? 'stream-copy' : 're-encode'} elapsed=${elapsed}`
                    );
                    warnings.forEach(function (w) { logger.warn(`convertvideo: ${w}`); });

                    res.set('X-Original-Format', sourceFormat);
                    res.set('X-Original-Resolution', `${sourceInfo.width}x${sourceInfo.height}`);
                    res.set('X-Output-Format', outFormat);
                    res.set('X-Output-Resolution', `${finalWidth}x${finalHeight}`);
                    res.set('X-Video-Codec', strategy.copyVideo ? 'copy' : cfg.video.codec);
                    res.set('X-Video-Quality', qualityDesc);
                    res.set('X-Audio-Codec', cfg.audio.remove ? 'none' : (strategy.copyAudio ? 'copy' : cfg.audio.codec));
                    res.set('X-Output-Fps', String(cfg.video.fps));
                    res.set('X-Output-Duration', String(finalDuration));
                    res.set('X-Warnings', JSON.stringify(warnings));

                    if (!videoIsPersistent) cleanup([videoPath]);
                    cleanup([backgroundImagePath]);
                    return utils.downloadFile(outFile, null, req, res, next);
                });
            })
            .save(outFile);
    });
}

module.exports = router;
