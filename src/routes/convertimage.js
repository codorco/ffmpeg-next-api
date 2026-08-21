'use strict';

// POST /convert/image — generic image conversion/processing endpoint. Same
// architecture as convertvideo.js/convertaudio.js: FFmpeg only (no new image
// library — this API already relies entirely on FFmpeg for image I/O, see the
// old /convert/image/to/jpg and image.js), same 4 input sources, same dual
// JSON/multipart transport, same response convention. Replaces the old,
// fixed /convert/image/to/jpg.

const express        = require('express');
const fs             = require('fs');
const path           = require('path');
const ffmpeg         = require('fluent-ffmpeg');
const Busboy         = require('busboy');
const uniqueFilename = require('unique-filename');

const constants      = require('../constants.js');
const logger         = require('../utils/logger.js');
const utils          = require('../utils/utils.js');
const inputresolver  = require('../utils/inputresolver.js');

const router = express.Router();

// ── Lookup tables ────────────────────────────────────────────────────────────

// One entry per supported output format. `lossy: true` formats have a real
// quality knob and are eligible for compression.maxSize/targetReduction;
// everything else is encoded as-is (FFmpeg has no raster encoder for SVG —
// it's a vector format — so it is intentionally not offered here).
const IMAGE_FORMAT_MAP = {
    jpg:  { codec: 'mjpeg',    pixFmt: 'yuv422p', lossy: true },
    jpeg: { codec: 'mjpeg',    pixFmt: 'yuv422p', lossy: true },
    png:  { codec: 'png' },
    webp: { codec: 'libwebp',  lossy: true },
    avif: { codec: 'libaom-av1', muxer: 'avif', lossy: true },
    bmp:  { codec: 'bmp' },
    gif:  { codec: 'gif' },
    tiff: { codec: 'tiff' },
    tif:  { codec: 'tiff' },
    ico:  { codec: 'ico' },
    ppm:  { codec: 'ppm' },
    pgm:  { codec: 'pgm', pixFmt: 'gray' },
    pbm:  { codec: 'pbm', pixFmt: 'monob' },
};

// aspectRatio presets for crop — centralized here so adding a new one later
// is a one-line change.
const CROP_PRESETS = {
    '1:1':  [1, 1],
    '4:5':  [4, 5],
    '16:9': [16, 9],
    '9:16': [9, 16],
    '4:3':  [4, 3],
};

const WATERMARK_MARGIN_PX  = 16;
const DEFAULT_QUALITY       = 85;   // used when no quality/compression is requested
const MIN_QUALITY           = 1;
const MAX_QUALITY           = 100;
const MAX_SEARCH_ITER       = 6;    // binary-search rounds per resolution attempt
const MAX_RESOLUTION_ROUNDS = 4;    // 100% + up to 3 reductions
const RESOLUTION_STEP       = 0.8;  // each round scales down by this factor

function isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

function parseSizeToBytes(str) {
    const m = /^(\d+(?:\.\d+)?)\s*(KB|MB|GB)$/i.exec(String(str || '').trim());
    if (!m) return null;
    const n = parseFloat(m[1]);
    const unit = m[2].toUpperCase();
    const mult = unit === 'KB' ? 1024 : unit === 'MB' ? 1024 * 1024 : 1024 * 1024 * 1024;
    return Math.round(n * mult);
}

// ── Validation & defaults ────────────────────────────────────────────────────

function validateAndNormalize(raw, queryFormat, hasWatermarkFileUpload) {
    raw = isPlainObject(raw) ? raw : {};
    const errors   = [];
    const warnings = [];

    const format = String(raw.format || queryFormat || '').toLowerCase();
    if (!format) {
        errors.push('format é obrigatório (ex: "jpg", "png", "webp"...)');
    } else if (!IMAGE_FORMAT_MAP[format]) {
        errors.push(`format "${format}" não é suportado. Use um destes: ${Object.keys(IMAGE_FORMAT_MAP).join(', ')}` +
            (format === 'svg' ? ' (SVG é um formato vetorial — o FFmpeg não possui codificador de rasterização para ele)' : ''));
    }
    const spec = IMAGE_FORMAT_MAP[format];

    // ── quality (direct, optional) ──
    let quality = DEFAULT_QUALITY;
    if (raw.quality !== undefined) {
        const q = parseInt(raw.quality, 10);
        if (!Number.isFinite(q) || q < MIN_QUALITY || q > MAX_QUALITY) {
            errors.push(`quality deve ser um inteiro entre ${MIN_QUALITY} e ${MAX_QUALITY}`);
        } else if (spec && !spec.lossy) {
            warnings.push(`quality é ignorado para o formato "${format}" (sem controle de qualidade)`);
        } else {
            quality = q;
        }
    }

    // ── compression ──
    const rawCompression = isPlainObject(raw.compression) ? raw.compression : {};
    let compression = null;
    if (rawCompression.maxSize !== undefined) {
        const bytes = parseSizeToBytes(rawCompression.maxSize);
        if (!bytes || bytes <= 0) {
            errors.push('compression.maxSize deve seguir o padrão "500KB", "1MB", "5MB", "20MB"...');
        } else if (rawCompression.targetReduction !== undefined) {
            warnings.push('compression.maxSize tem prioridade sobre compression.targetReduction — targetReduction foi ignorado');
            compression = { mode: 'maxSize', targetBytes: bytes };
        } else {
            compression = { mode: 'maxSize', targetBytes: bytes };
        }
    } else if (rawCompression.targetReduction !== undefined) {
        const pct = parseFloat(rawCompression.targetReduction);
        if (!Number.isFinite(pct) || pct < 10 || pct > 80) {
            errors.push('compression.targetReduction deve ser um número entre 10 e 80');
        } else {
            compression = { mode: 'targetReduction', percent: pct };
        }
    }
    if (compression && spec && !spec.lossy && !rawCompression.allowResolutionReduction) {
        warnings.push(`Formato "${format}" não tem controle de qualidade com perdas — a redução de tamanho só será possível se ` +
            `"compression.allowResolutionReduction" for true; caso contrário o resultado pode não atingir a meta pedida`);
    }
    const allowResolutionReduction = !!rawCompression.allowResolutionReduction;

    // ── resize ──
    const rawResize = isPlainObject(raw.resize) ? raw.resize : {};
    const resizeModesUsed = ['percentage','maxWidth','maxHeight','width'].filter(function (k) { return rawResize[k] !== undefined; });
    let resize = null;
    if (rawResize.percentage !== undefined) {
        const pct = parseFloat(rawResize.percentage);
        if (!Number.isFinite(pct) || pct <= 0 || pct > 500) {
            errors.push('resize.percentage deve ser um número entre 1 e 500');
        } else {
            resize = { mode: 'percentage', percent: pct };
        }
    } else if (rawResize.width !== undefined || rawResize.height !== undefined) {
        const w = parseInt(rawResize.width, 10);
        const h = parseInt(rawResize.height, 10);
        if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
            errors.push('resize.width e resize.height devem ser números positivos quando usados juntos');
        } else {
            const resizeMode = rawResize.resizeMode || 'contain';
            if (!['contain','cover','stretch'].includes(resizeMode)) {
                errors.push(`resize.resizeMode "${resizeMode}" inválido. Use: contain, cover ou stretch`);
            }
            resize = { mode: 'custom', width: w, height: h, resizeMode };
        }
    } else if (rawResize.maxWidth !== undefined || rawResize.maxHeight !== undefined) {
        const maxW = rawResize.maxWidth !== undefined ? parseInt(rawResize.maxWidth, 10) : null;
        const maxH = rawResize.maxHeight !== undefined ? parseInt(rawResize.maxHeight, 10) : null;
        if ((maxW !== null && (!Number.isFinite(maxW) || maxW <= 0)) || (maxH !== null && (!Number.isFinite(maxH) || maxH <= 0))) {
            errors.push('resize.maxWidth e resize.maxHeight devem ser números positivos');
        } else {
            resize = { mode: 'max', maxWidth: maxW, maxHeight: maxH };
        }
    }
    if (resizeModesUsed.length > 1 && resizeModesUsed.some(function (k) { return k !== 'maxWidth' && k !== 'maxHeight'; }) &&
        !(resizeModesUsed.length === 2 && resizeModesUsed.includes('maxWidth') && resizeModesUsed.includes('maxHeight'))) {
        errors.push('use apenas um modo de resize por vez: "percentage", "maxWidth"/"maxHeight", ou "width"+"height"');
    }

    // ── rotation / flip ──
    let rotation = raw.rotation !== undefined ? parseInt(raw.rotation, 10) : 0;
    if (![0,90,180,270].includes(rotation)) {
        errors.push(`rotation "${raw.rotation}" inválido. Use: 0, 90, 180 ou 270`);
    }
    const flip = raw.flip || 'none';
    if (!['none','horizontal','vertical','both'].includes(flip)) {
        errors.push(`flip "${flip}" inválido. Use: none, horizontal, vertical ou both`);
    }

    // ── crop ──
    const rawCrop = isPlainObject(raw.crop) ? raw.crop : null;
    let crop = null;
    if (rawCrop) {
        if (rawCrop.aspectRatio === 'custom') {
            const w = parseFloat(rawCrop.width);
            const h = parseFloat(rawCrop.height);
            if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
                errors.push('crop.width e crop.height devem ser números positivos quando aspectRatio="custom"');
            } else {
                crop = { ratioW: w, ratioH: h };
            }
        } else if (CROP_PRESETS[rawCrop.aspectRatio]) {
            crop = { ratioW: CROP_PRESETS[rawCrop.aspectRatio][0], ratioH: CROP_PRESETS[rawCrop.aspectRatio][1] };
        } else {
            errors.push(`crop.aspectRatio "${rawCrop.aspectRatio}" inválido. Use um destes: ${Object.keys(CROP_PRESETS).join(', ')} ou "custom"`);
        }
    }

    // ── watermark ──
    const rawWatermark = isPlainObject(raw.watermark) ? raw.watermark : null;
    let watermark = null;
    if (rawWatermark) {
        if (!rawWatermark.file && !hasWatermarkFileUpload) {
            errors.push('watermark.file é obrigatório quando "watermark" é usado (ou envie o arquivo no campo multipart "watermark")');
        }
        const position = rawWatermark.position || 'bottom-right';
        const presets = ['top-left','top-right','bottom-left','bottom-right','center'];
        if (position !== 'custom' && !presets.includes(position)) {
            errors.push(`watermark.position "${position}" inválido. Use: ${presets.join(', ')} ou "custom"`);
        }
        let x = null, y = null;
        if (position === 'custom') {
            x = parseInt(rawWatermark.x, 10);
            y = parseInt(rawWatermark.y, 10);
            if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
                errors.push('watermark.x e watermark.y devem ser números >= 0 quando position="custom"');
            }
        }
        const size = rawWatermark.sizePixels !== undefined ? null : (rawWatermark.size !== undefined ? parseFloat(rawWatermark.size) : 20);
        const sizePixels = rawWatermark.sizePixels !== undefined ? parseInt(rawWatermark.sizePixels, 10) : null;
        if (size !== null && (!Number.isFinite(size) || size <= 0 || size > 100)) {
            errors.push('watermark.size deve ser um número entre 1 e 100 (percentual da largura da imagem principal)');
        }
        if (sizePixels !== null && (!Number.isFinite(sizePixels) || sizePixels <= 0)) {
            errors.push('watermark.sizePixels deve ser um número positivo');
        }
        const opacity = rawWatermark.opacity !== undefined ? parseFloat(rawWatermark.opacity) : 1.0;
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
            errors.push('watermark.opacity deve ser um número entre 0 e 1');
        }
        watermark = { file: rawWatermark.file, position, x, y, size, sizePixels, opacity };
    }

    return {
        errors, warnings,
        cfg: { format, spec, quality, compression, allowResolutionReduction, resize, rotation, flip, crop, watermark },
    };
}

// ── Geometry math (pure functions — easy to extend later) ───────────────────

function rotatedDims(w, h, rotation) {
    return (rotation === 90 || rotation === 270) ? { width: h, height: w } : { width: w, height: h };
}

function computeCropRect(ratioW, ratioH, curW, curH) {
    const targetRatio = ratioW / ratioH;
    const curRatio = curW / curH;
    let cropW, cropH;
    if (curRatio > targetRatio) {
        cropH = curH;
        cropW = Math.max(1, Math.round(curH * targetRatio));
    } else {
        cropW = curW;
        cropH = Math.max(1, Math.round(curW / targetRatio));
    }
    return { width: cropW, height: cropH, x: Math.round((curW - cropW) / 2), y: Math.round((curH - cropH) / 2) };
}

// Resolves resize config into concrete target {width,height}, or null when no
// resize should happen. `mode` distinguishes contain/cover/stretch for the
// "custom width+height" case; percentage/max always preserve aspect ratio.
function computeResizeDims(resize, curW, curH) {
    if (!resize) return null;
    if (resize.mode === 'percentage') {
        return { width: Math.max(1, Math.round(curW * resize.percent / 100)), height: Math.max(1, Math.round(curH * resize.percent / 100)), mode: 'stretch' };
    }
    if (resize.mode === 'max') {
        let scale = 1;
        if (resize.maxWidth && curW > resize.maxWidth) scale = Math.min(scale, resize.maxWidth / curW);
        if (resize.maxHeight && curH > resize.maxHeight) scale = Math.min(scale, resize.maxHeight / curH);
        if (scale === 1) return null; // already within bounds — no-op, preserves original as much as possible
        return { width: Math.max(1, Math.round(curW * scale)), height: Math.max(1, Math.round(curH * scale)), mode: 'stretch' };
    }
    // custom width+height
    return { width: resize.width, height: resize.height, mode: resize.resizeMode };
}

// ── Filter graph builder ─────────────────────────────────────────────────────

// Builds the geometry stage (rotate → flip → crop → resize [→ watermark]) as
// either a simple "-vf" chain or a "-filter_complex" graph (when a watermark
// needs a second input). Mirrors the {simpleVf, filterComplex, videoMapLabel,
// extraInputs} shape used by convertvideo.js's buildVideoFilterPlan.
function buildImageFilterPlan(cfg, sourceW, sourceH) {
    const parts = [];

    if (cfg.rotation === 90)  parts.push('transpose=1');
    if (cfg.rotation === 180) parts.push('transpose=1,transpose=1');
    if (cfg.rotation === 270) parts.push('transpose=2');
    if (cfg.flip === 'horizontal' || cfg.flip === 'both') parts.push('hflip');
    if (cfg.flip === 'vertical'   || cfg.flip === 'both') parts.push('vflip');

    let curDims = rotatedDims(sourceW, sourceH, cfg.rotation);

    if (cfg.crop) {
        const rect = computeCropRect(cfg.crop.ratioW, cfg.crop.ratioH, curDims.width, curDims.height);
        parts.push(`crop=${rect.width}:${rect.height}:${rect.x}:${rect.y}`);
        curDims = { width: rect.width, height: rect.height };
    }

    const target = computeResizeDims(cfg.resize, curDims.width, curDims.height);
    if (target) {
        if (target.mode === 'stretch') {
            parts.push(`scale=${target.width}:${target.height}`);
        } else if (target.mode === 'cover') {
            parts.push(`scale=${target.width}:${target.height}:force_original_aspect_ratio=increase`, `crop=${target.width}:${target.height}`);
        } else { // contain
            parts.push(`scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease`,
                `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2:black`);
        }
        curDims = { width: target.width, height: target.height };
    }

    if (!cfg.watermark) {
        return { simpleVf: parts.length ? parts.join(',') : null, filterComplex: null, videoMapLabel: null, extraInputs: [], finalWidth: curDims.width, finalHeight: curDims.height };
    }

    // Watermark needs a second ffmpeg input → filter_complex.
    const base = parts.length ? '[0:v]' + parts.join(',') + '[base];' : '';
    const baseLabel = parts.length ? '[base]' : '[0:v]';

    const wm = cfg.watermark;
    const wmWidth = wm.sizePixels || Math.max(1, Math.round(curDims.width * wm.size / 100));
    let wmChain = `[1:v]scale=${wmWidth}:-2`;
    if (wm.opacity < 1) wmChain += `,format=rgba,colorchannelmixer=aa=${wm.opacity}`;
    wmChain += '[wm]';

    let x, y;
    if (wm.position === 'custom') {
        x = wm.x; y = wm.y;
    } else {
        const m = WATERMARK_MARGIN_PX;
        const xExpr = { 'top-left': m, 'bottom-left': m, 'top-right': `(W-w-${m})`, 'bottom-right': `(W-w-${m})`, center: '(W-w)/2' };
        const yExpr = { 'top-left': m, 'top-right': m, 'bottom-left': `(H-h-${m})`, 'bottom-right': `(H-h-${m})`, center: '(H-h)/2' };
        x = xExpr[wm.position]; y = yExpr[wm.position];
    }

    const overlay = `${baseLabel}[wm]overlay=${x}:${y}[vout]`;
    const filterComplex = base + wmChain + ';' + overlay;

    return { simpleVf: null, filterComplex, videoMapLabel: '[vout]', extraInputs: ['watermark'], finalWidth: curDims.width, finalHeight: curDims.height };
}

function qualityToFfmpegArgs(format, quality) {
    if (format === 'jpg' || format === 'jpeg') {
        const q = Math.max(2, Math.min(31, Math.round(31 - (quality / 100) * 29)));
        return ['-q:v', String(q)];
    }
    if (format === 'webp') {
        return ['-quality', String(Math.max(0, Math.min(100, Math.round(quality))))];
    }
    if (format === 'avif') {
        const crf = Math.max(0, Math.min(63, Math.round(63 - (quality / 100) * 63)));
        return ['-crf', String(crf), '-b:v', '0'];
    }
    return [];
}

function buildFormatOutputOptions(spec, quality, formatKey) {
    const opts = [`-c:v ${spec.codec}`];
    if (spec.pixFmt) opts.push(`-pix_fmt ${spec.pixFmt}`);
    if (spec.lossy) opts.push.apply(opts, qualityToFfmpegArgs(formatKey, quality));
    if (spec.muxer) opts.push('-f', spec.muxer);
    return opts;
}

// ── One-pass FFmpeg run (shared by the direct path and the compression search) ──

function runFfmpeg(inputPath, extraInputPaths, filterPlan, outOpts, outFile, cb) {
    const cmd = ffmpeg(inputPath).renice(constants.defaultFFMPEGProcessPriority);
    (extraInputPaths || []).forEach(function (p) { cmd.input(p); });

    const opts = [];
    if (filterPlan.filterComplex) {
        opts.push('-filter_complex', filterPlan.filterComplex, '-map', filterPlan.videoMapLabel);
    } else if (filterPlan.simpleVf) {
        opts.push('-vf', filterPlan.simpleVf);
    }
    opts.push.apply(opts, outOpts);
    opts.push('-frames:v', '1', '-y');

    cmd.outputOptions(opts)
        .on('error', function (err) { cb(err); })
        .on('end', function () { cb(null); })
        .save(outFile);
}

// ── Compression search (maxSize / targetReduction) ───────────────────────────

// Binary-searches the quality (1-100) for the highest value whose encoded size
// stays within targetBytes, on an already-geometry-processed intermediate
// image. Bounded to MAX_SEARCH_ITER passes — never loops indefinitely.
function searchQualityForSize(intermediatePath, spec, formatKey, targetBytes, cb) {
    let lo = MIN_QUALITY, hi = MAX_QUALITY;
    let best = null; // { path, quality, size }
    let iterations = 0;

    function tryQuality(q, next) {
        const outPath = uniqueFilename('/tmp/') + `-qsearch.${formatKey}`;
        const outOpts = buildFormatOutputOptions(spec, q, formatKey);
        runFfmpeg(intermediatePath, [], { simpleVf: null, filterComplex: null }, outOpts, outPath, function (err) {
            if (err) return next(err);
            let size;
            try { size = fs.statSync(outPath).size; } catch (e) { return next(e); }
            next(null, outPath, size);
        });
    }

    function step() {
        if (iterations >= MAX_SEARCH_ITER || lo > hi) return finish();
        const q = Math.round((lo + hi) / 2);
        iterations++;
        tryQuality(q, function (err, outPath, size) {
            if (err) return cb(err);
            if (size <= targetBytes) {
                if (best) utils.deleteFile(best.path);
                best = { path: outPath, quality: q, size };
                lo = q + 1;
            } else {
                utils.deleteFile(outPath);
                hi = q - 1;
            }
            step();
        });
    }

    function finish() {
        if (best) return cb(null, best);
        // Nothing fit even at the lowest quality tested — fall back to the
        // absolute floor as the best-effort result; caller decides whether to
        // also retry at a smaller resolution.
        tryQuality(MIN_QUALITY, function (err, outPath, size) {
            if (err) return cb(err);
            cb(null, { path: outPath, quality: MIN_QUALITY, size, missedTarget: true });
        });
    }

    step();
}

// Outer loop: run the quality search, and if the target still isn't met and
// the caller allowed it, shrink the intermediate image and try again — up to
// MAX_RESOLUTION_ROUNDS total attempts (never unbounded).
function compressToTarget(intermediatePath, spec, formatKey, targetBytes, allowResolutionReduction, curW, curH, warnings, cb) {
    let round = 0;
    let currentPath = intermediatePath;
    let currentIsIntermediate = false; // true once we've made our own scaled-down copy

    function attempt() {
        searchQualityForSize(currentPath, spec, formatKey, targetBytes, function (err, result) {
            if (err) return cb(err);
            const metQuota = !result.missedTarget;
            round++;
            if (metQuota || !allowResolutionReduction || round >= MAX_RESOLUTION_ROUNDS) {
                if (!metQuota) {
                    warnings.push(
                        `Não foi possível atingir o tamanho máximo pedido sem degradar demais a imagem` +
                        (allowResolutionReduction ? ' mesmo reduzindo a resolução' : ' — habilite "compression.allowResolutionReduction" para permitir reduzir a resolução também') +
                        `. Resultado: ${(result.size / 1024).toFixed(0)}KB`
                    );
                }
                if (currentIsIntermediate) utils.deleteFile(currentPath);
                return cb(null, Object.assign({ width: curW, height: curH }, result));
            }
            // Shrink and try again.
            if (currentIsIntermediate) utils.deleteFile(currentPath);
            curW = Math.max(1, Math.round(curW * RESOLUTION_STEP));
            curH = Math.max(1, Math.round(curH * RESOLUTION_STEP));
            const shrunkPath = uniqueFilename('/tmp/') + '-shrink.png';
            runFfmpeg(intermediatePath, [], { simpleVf: `scale=${curW}:${curH}`, filterComplex: null },
                ['-c:v png'], shrunkPath, function (shrinkErr) {
                    if (shrinkErr) return cb(shrinkErr);
                    currentPath = shrunkPath;
                    currentIsIntermediate = true;
                    attempt();
                });
        });
    }

    attempt();
}

// ── Route handler ────────────────────────────────────────────────────────────

const jsonBodyLimit  = Math.ceil(constants.fileSizeLimit * 1.4) + 65536; // base64 overhead
const jsonBodyParser = express.json({ limit: jsonBodyLimit });

router.post('/image', function (req, res, next) {
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

function resolveSource(body, cb) {
    const sources = ['base64', 'url', 'localFile'].filter(function (k) { return body[k]; });
    if (sources.length === 0) return cb(new Error('informe exatamente uma fonte: "base64", "url" ou "localFile"'));
    if (sources.length > 1)  return cb(new Error('informe apenas uma fonte de imagem por requisição (' + sources.join(', ') + ' foram enviados)'));

    const key = sources[0];
    if (key === 'base64') return inputresolver.resolveBase64(body.base64, function (e, p) { cb(e, p, false); });
    if (key === 'url')    return inputresolver.resolveUrl(body.url, function (e, p) { cb(e, p, false); });
    try {
        return cb(null, inputresolver.resolveLocalFile(body.localFile), true);
    } catch (e) {
        return cb(e);
    }
}

// resolves the watermark.file shorthand: a plain string means "localFile",
// an object means {base64|url|localFile} — same convention used for
// resolution.background.image on POST /convert/video.
function resolveWatermarkFile(watermark, cb) {
    if (!watermark || !watermark.file) return cb(null, null);
    const file = watermark.file;
    if (typeof file === 'string') {
        try { return cb(null, inputresolver.resolveLocalFile(file)); }
        catch (e) { return cb(e); }
    }
    if (isPlainObject(file)) {
        if (file.base64) return inputresolver.resolveBase64(file.base64, cb);
        if (file.url)    return inputresolver.resolveUrl(file.url, cb);
        if (file.localFile) {
            try { return cb(null, inputresolver.resolveLocalFile(file.localFile)); }
            catch (e) { return cb(e); }
        }
    }
    return cb(new Error('watermark.file deve ser um caminho (localFile) ou um objeto {base64|url|localFile}'));
}

function handleJson(req, res, next) {
    const body = req.body || {};
    resolveSource(body, function (err, imagePath, isPersistent) {
        if (err) return fail(res, 400, 'Não foi possível obter a imagem de entrada: ' + err.message);
        process_(req, res, next, body, req.query.format, imagePath, isPersistent, null);
    });
}

function handleMultipart(req, res, next) {
    let imagePath = null, watermarkPath = null;
    let configStr = '{}';
    let base64Field = null, urlField = null, localFileField = null;
    let pendingWrites = 0, busboyDone = false;

    let bb;
    try {
        bb = new Busboy({ headers: req.headers, limits: { files: 2, fields: 8, fileSize: constants.fileSizeLimit } });
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
            logger.error(`convertimage: file size limit hit for ${filename || fieldname}`);
        });

        file.pipe(ws);
        ws.on('finish', function () {
            if (fieldname === 'file') imagePath = savePath;
            else if (fieldname === 'watermark') watermarkPath = savePath;
            pendingWrites--;
            tryProcess();
        });
        ws.on('error', function (err) {
            logger.error(`convertimage: write error [${fieldname}]: ${err}`);
            pendingWrites--;
            tryProcess();
        });
    });

    bb.on('finish', function () { busboyDone = true; tryProcess(); });
    bb.on('error', function (err) {
        logger.error(`convertimage: busboy error: ${err}`);
        fail(res, 500, 'Erro no upload: ' + err);
    });

    req.pipe(bb);

    function tryProcess() {
        if (busboyDone && pendingWrites === 0) finalize();
    }

    function finalize() {
        let cfg;
        try { cfg = JSON.parse(configStr); } catch (e) {
            return fail(res, 400, 'JSON inválido no campo "config"');
        }

        const sourcesGiven = [imagePath && 'file', base64Field && 'base64', urlField && 'url', localFileField && 'localFile'].filter(Boolean);
        if (sourcesGiven.length === 0) {
            return fail(res, 400, 'informe exatamente uma fonte: arquivo "file", ou os campos "base64", "url" ou "localFile"');
        }
        if (sourcesGiven.length > 1) {
            cleanup([imagePath, watermarkPath]);
            return fail(res, 400, 'informe apenas uma fonte de imagem por requisição (' + sourcesGiven.join(', ') + ' foram enviados)');
        }

        function withImagePath(finalPath, isPersistent) {
            process_(req, res, next, cfg, req.query.format, finalPath, isPersistent, watermarkPath);
        }

        if (imagePath) return withImagePath(imagePath, false);

        const cb = function (err, p) {
            if (err) return fail(res, 400, 'Não foi possível obter a imagem de entrada: ' + err.message);
            withImagePath(p, sourcesGiven[0] === 'localFile');
        };
        if (base64Field) return inputresolver.resolveBase64(base64Field, cb);
        if (urlField)    return inputresolver.resolveUrl(urlField, cb);
        try { return cb(null, inputresolver.resolveLocalFile(localFileField)); }
        catch (e) { return cb(e); }
    }
}

// ── Shared processing (both transports converge here) ───────────────────────

function process_(req, res, next, rawCfg, queryFormat, imagePath, imageIsPersistent, watermarkFileFromMultipart) {
    const startTime = Date.now();
    const { errors, warnings, cfg } = validateAndNormalize(rawCfg, queryFormat, !!watermarkFileFromMultipart);

    if (errors.length) {
        if (!imageIsPersistent) cleanup([imagePath]);
        cleanup([watermarkFileFromMultipart]);
        return fail(res, 400, errors.join('; '));
    }
    resolveWatermarkFile(cfg.watermark, function (wmErr, wmPathFromCfg) {
        if (wmErr) {
            if (!imageIsPersistent) cleanup([imagePath]);
            cleanup([watermarkFileFromMultipart]);
            return fail(res, 400, 'Não foi possível obter a marca d\'água: ' + wmErr.message);
        }
        const watermarkPath = watermarkFileFromMultipart || wmPathFromCfg;
        if (cfg.watermark && !watermarkPath) {
            if (!imageIsPersistent) cleanup([imagePath]);
            return fail(res, 400, 'watermark.file não pôde ser resolvido para um arquivo válido');
        }
        continueProcessing(req, res, next, cfg, imagePath, imageIsPersistent, watermarkPath, warnings, startTime);
    });
}

function continueProcessing(req, res, next, cfg, imagePath, imageIsPersistent, watermarkPath, warnings, startTime) {
    ffmpeg.ffprobe(imagePath, function (probeErr, metadata) {
        if (probeErr) {
            if (!imageIsPersistent) cleanup([imagePath]);
            cleanup([watermarkPath]);
            return fail(res, 400, 'Não foi possível ler o arquivo de imagem (pode estar corrompido ou em formato não suportado): ' + probeErr.message);
        }

        const streams = metadata.streams || [];
        const imgStream = streams.find(function (s) { return s.codec_type === 'video'; });
        if (!imgStream) {
            if (!imageIsPersistent) cleanup([imagePath]);
            cleanup([watermarkPath]);
            return fail(res, 400, 'Nenhuma imagem/frame válido encontrado no arquivo de entrada');
        }

        if (cfg.watermark && cfg.watermark.position === 'custom' &&
            (cfg.watermark.x >= (imgStream.width || 0) || cfg.watermark.y >= (imgStream.height || 0))) {
            if (!imageIsPersistent) cleanup([imagePath]);
            cleanup([watermarkPath]);
            return fail(res, 400, 'watermark.x/watermark.y colocam a marca d\'água totalmente fora da imagem');
        }

        const sourceFormat = (imgStream.codec_name) || 'unknown';
        const sourceWidth  = imgStream.width  || 0;
        const sourceHeight = imgStream.height || 0;
        let originalSize = 0;
        try { originalSize = fs.statSync(imagePath).size; } catch (e) { /* best effort */ }

        const filterPlan = buildImageFilterPlan(cfg, sourceWidth, sourceHeight);
        const extraInputs = filterPlan.extraInputs.indexOf('watermark') !== -1 ? [watermarkPath] : [];

        const outFile = uniqueFilename('/tmp/') + '-convertimage.' + cfg.format;

        function respond(finalPath, finalQuality, finalSize, finalWidth, finalHeight) {
            finalWidth  = finalWidth  || filterPlan.finalWidth;
            finalHeight = finalHeight || filterPlan.finalHeight;
            fs.rename(finalPath, outFile, function (renameErr) {
                if (renameErr) {
                    logger.error(`convertimage: rename error: ${renameErr}`);
                    if (!imageIsPersistent) cleanup([imagePath]);
                    cleanup([watermarkPath, finalPath]);
                    return fail(res, 500, String(renameErr));
                }

                const elapsed = ((Date.now() - startTime) / 1000).toFixed(2) + 's';
                const reductionPct = originalSize > 0 ? Math.round((1 - finalSize / originalSize) * 100) : null;

                logger.info(
                    `convertimage done sourceFormat=${sourceFormat} outputFormat=${cfg.format} ` +
                    `sourceResolution=${sourceWidth}x${sourceHeight} outputResolution=${finalWidth}x${finalHeight} ` +
                    `originalSize=${originalSize} finalSize=${finalSize} rotation=${cfg.rotation} flip=${cfg.flip} ` +
                    `crop=${!!cfg.crop} watermark=${!!cfg.watermark} elapsed=${elapsed}`
                );
                warnings.forEach(function (w) { logger.warn(`convertimage: ${w}`); });

                res.set('X-Original-Format', sourceFormat);
                res.set('X-Output-Format', cfg.format);
                res.set('X-Original-Size', String(originalSize));
                res.set('X-Output-Size', String(finalSize));
                if (reductionPct !== null) res.set('X-Size-Reduction-Percent', String(reductionPct));
                res.set('X-Original-Resolution', `${sourceWidth}x${sourceHeight}`);
                res.set('X-Output-Resolution', `${finalWidth}x${finalHeight}`);
                res.set('X-Rotation-Applied', String(cfg.rotation));
                res.set('X-Watermark-Applied', String(!!cfg.watermark));
                res.set('X-Crop-Applied', String(!!cfg.crop));
                res.set('X-Warnings', JSON.stringify(warnings));

                if (!imageIsPersistent) cleanup([imagePath]);
                cleanup([watermarkPath]);
                return utils.downloadFile(outFile, null, req, res, next);
            });
        }

        function onError(err) {
            logger.error(`convertimage error: ${err}`);
            if (!imageIsPersistent) cleanup([imagePath]);
            cleanup([watermarkPath, outFile]);
            fail(res, 500, String(err));
        }

        if (!cfg.compression) {
            // Direct single-pass path — no quality search needed.
            const outOpts = buildFormatOutputOptions(cfg.spec, cfg.quality, cfg.format);
            logger.debug(`convertimage: direct outputOptions=${JSON.stringify(outOpts)}`);
            return runFfmpeg(imagePath, extraInputs, filterPlan, outOpts, outFile, function (err) {
                if (err) return onError(err);
                let size = 0;
                try { size = fs.statSync(outFile).size; } catch (e) { /* best effort */ }
                respond(outFile, cfg.quality, size);
            });
        }

        if (!cfg.spec.lossy && !cfg.allowResolutionReduction) {
            // Lossless format, no resolution reduction allowed — nothing we
            // can adjust; just produce the normal output and warn.
            warnings.push(`Formato "${cfg.format}" é sem perdas e a redução de resolução não foi permitida — compression foi ignorado`);
            const outOpts = buildFormatOutputOptions(cfg.spec, cfg.quality, cfg.format);
            return runFfmpeg(imagePath, extraInputs, filterPlan, outOpts, outFile, function (err) {
                if (err) return onError(err);
                let size = 0;
                try { size = fs.statSync(outFile).size; } catch (e) { /* best effort */ }
                respond(outFile, cfg.quality, size);
            });
        }

        // Two-stage: apply geometry once into a lossless PNG intermediate,
        // then binary-search quality (and optionally resolution) against it.
        const intermediatePath = uniqueFilename('/tmp/') + '-intermediate.png';
        runFfmpeg(imagePath, extraInputs, filterPlan, ['-c:v png'], intermediatePath, function (err) {
            if (err) return onError(err);

            if (cfg.compression.mode === 'targetReduction' && !originalSize) {
                warnings.push('Não foi possível medir o tamanho original — compression.targetReduction ignorado');
                cleanup([intermediatePath]);
                const outOpts = buildFormatOutputOptions(cfg.spec, cfg.quality, cfg.format);
                return runFfmpeg(imagePath, extraInputs, filterPlan, outOpts, outFile, function (err2) {
                    if (err2) return onError(err2);
                    let size = 0;
                    try { size = fs.statSync(outFile).size; } catch (e) { /* best effort */ }
                    respond(outFile, cfg.quality, size);
                });
            }

            const targetBytes = cfg.compression.mode === 'maxSize'
                ? cfg.compression.targetBytes
                : Math.max(1, Math.round(originalSize * (1 - cfg.compression.percent / 100)));

            if (!cfg.spec.lossy) {
                // Lossless + allowResolutionReduction: only lever is scaling
                // the intermediate down until the (still lossless) size fits.
                return shrinkLosslessToTarget(intermediatePath, cfg.spec, cfg.format, targetBytes,
                    filterPlan.finalWidth, filterPlan.finalHeight, warnings, function (shrinkErr, result) {
                        cleanup([intermediatePath]); // the search only cleans up its own shrunk copies
                        if (shrinkErr) return onError(shrinkErr);
                        respond(result.path, null, result.size, result.width, result.height);
                    });
            }

            compressToTarget(intermediatePath, cfg.spec, cfg.format, targetBytes, cfg.allowResolutionReduction,
                filterPlan.finalWidth, filterPlan.finalHeight, warnings, function (err2, result) {
                    cleanup([intermediatePath]); // the search only cleans up its own shrunk copies
                    if (err2) return onError(err2);
                    respond(result.path, result.quality, result.size, result.width, result.height);
                });
        });
    });
}

// Lossless formats have no quality knob — the only way to shrink is
// resolution, and only when the caller explicitly allowed it. Bounded to the
// same MAX_RESOLUTION_ROUNDS as the lossy path.
function shrinkLosslessToTarget(intermediatePath, spec, formatKey, targetBytes, curW, curH, warnings, cb) {
    let round = 0;
    let currentPath = intermediatePath;
    let currentIsCopy = false;

    function attempt() {
        const outPath = uniqueFilename('/tmp/') + `-lossless.${formatKey}`;
        const outOpts = buildFormatOutputOptions(spec, null, formatKey);
        runFfmpeg(currentPath, [], { simpleVf: null, filterComplex: null }, outOpts, outPath, function (err) {
            if (err) return cb(err);
            let size;
            try { size = fs.statSync(outPath).size; } catch (e) { return cb(e); }
            round++;
            if (size <= targetBytes || round >= MAX_RESOLUTION_ROUNDS) {
                if (size > targetBytes) {
                    warnings.push(`Não foi possível atingir o tamanho máximo mesmo reduzindo a resolução. Resultado: ${(size / 1024).toFixed(0)}KB`);
                }
                if (currentIsCopy) utils.deleteFile(currentPath);
                return cb(null, { path: outPath, size, width: curW, height: curH });
            }
            utils.deleteFile(outPath);
            if (currentIsCopy) utils.deleteFile(currentPath);
            curW = Math.max(1, Math.round(curW * RESOLUTION_STEP));
            curH = Math.max(1, Math.round(curH * RESOLUTION_STEP));
            const shrunkPath = uniqueFilename('/tmp/') + '-shrink.png';
            runFfmpeg(intermediatePath, [], { simpleVf: `scale=${curW}:${curH}`, filterComplex: null },
                ['-c:v png'], shrunkPath, function (shrinkErr) {
                    if (shrinkErr) return cb(shrinkErr);
                    currentPath = shrunkPath;
                    currentIsCopy = true;
                    attempt();
                });
        });
    }

    attempt();
}

module.exports = router;
