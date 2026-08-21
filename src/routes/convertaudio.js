'use strict';

// POST /convert/audio — converts any FFmpeg-supported audio input to any
// supported output audio format. Mirrors convertvideo.js: same 4 input
// sources (multipart file / base64 / url / localFile), same dual JSON/
// multipart transport, same response convention (binary file + X-* headers).
// Replaces the old, fixed /convert/audio/to/mp3 and /convert/audio/to/wav.

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
const bitratebudget  = require('../utils/bitratebudget.js');

const router = express.Router();

// ── Lookup table ─────────────────────────────────────────────────────────────

// One entry per supported output format. `lossless` formats have no bitrate
// concept, so quality.mode "reduce"/"maxSize" don't apply to them. `muxer` is
// only needed when the file extension alone isn't enough for FFmpeg to pick
// the right container (wma files are really an ASF container).
const AUDIO_FORMAT_MAP = {
    mp3:  { codec: 'libmp3lame' },
    wav:  { codec: 'pcm_s16le', lossless: true },
    aac:  { codec: 'libfdk_aac' },              // same encoder already used elsewhere in this API
    m4a:  { codec: 'libfdk_aac' },
    flac: { codec: 'flac', lossless: true },
    ogg:  { codec: 'libvorbis' },
    opus: { codec: 'libopus' },
    wma:  { codec: 'wmav2', muxer: 'asf' },
    aiff: { codec: 'pcm_s16be', lossless: true },
};

const REFERENCE_BITRATE_BPS   = 192000; // this API's standard "no quality loss" default (see convertvideo.js)
const MIN_REDUCE_BITRATE_BPS  = 32000;
const MIN_MAXSIZE_BITRATE_BPS = 32000;
const MAXSIZE_MARGIN          = 0.95;   // headroom for container/muxing overhead

function isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

// ── Validation & defaults ────────────────────────────────────────────────────

function validateAndNormalize(raw) {
    raw = isPlainObject(raw) ? raw : {};
    const errors   = [];
    const warnings = [];

    const format = (raw.format || 'mp3').toLowerCase();
    const spec = AUDIO_FORMAT_MAP[format];
    if (!spec) {
        errors.push(`format "${format}" não é suportado. Use um destes: ${Object.keys(AUDIO_FORMAT_MAP).join(', ')}`);
    }

    const rawQuality = isPlainObject(raw.quality) ? raw.quality : {};
    const mode = rawQuality.mode || 'default';
    if (!['default','reduce','maxSize'].includes(mode)) {
        errors.push(`quality.mode "${mode}" inválido. Use "default", "reduce" ou "maxSize"`);
    }

    let quality = { mode: 'default' };
    if (spec && mode === 'reduce') {
        if (spec.lossless) {
            errors.push(`quality.mode="reduce" não se aplica ao formato "${format}" (sem perdas)`);
        } else {
            const pct = parseFloat(rawQuality.value);
            if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
                errors.push('quality.value deve ser um número entre 1 e 99 (percentual de redução) quando mode="reduce"');
            } else {
                quality = { mode: 'reduce', percent: pct };
            }
        }
    } else if (spec && mode === 'maxSize') {
        if (spec.lossless) {
            errors.push(`quality.mode="maxSize" não se aplica ao formato "${format}" (sem perdas) — escolha mp3, aac, m4a, ogg, opus ou wma`);
        } else {
            const mb = parseFloat(rawQuality.value);
            if (!Number.isFinite(mb) || mb <= 0) {
                errors.push('quality.value deve ser um número positivo (megabytes) quando mode="maxSize"');
            } else {
                quality = { mode: 'maxSize', targetMegabytes: mb };
            }
        }
    }

    return { errors, warnings, cfg: { format, spec, quality } };
}

// ── Quality resolution (needs the probed source duration) ───────────────────

// Resolves quality.mode into a concrete bitrate, or null for a lossless
// (bitrate-less) encode.
function resolveBitrateBps(cfg, sourceDuration, warnings) {
    if (cfg.spec.lossless) return null;

    if (cfg.quality.mode === 'default') {
        return REFERENCE_BITRATE_BPS;
    }

    if (cfg.quality.mode === 'reduce') {
        const bps = Math.round(REFERENCE_BITRATE_BPS * (1 - cfg.quality.percent / 100));
        if (bps < MIN_REDUCE_BITRATE_BPS) {
            warnings.push(`Redução de ${cfg.quality.percent}% ficaria abaixo do bitrate mínimo viável — usando ${MIN_REDUCE_BITRATE_BPS / 1000}k`);
            return MIN_REDUCE_BITRATE_BPS;
        }
        return bps;
    }

    // maxSize
    if (!sourceDuration || sourceDuration <= 0) {
        warnings.push('Não foi possível determinar a duração do áudio para calcular quality.mode="maxSize" — usando bitrate padrão de 192k');
        return REFERENCE_BITRATE_BPS;
    }
    let bps = Math.round(bitratebudget.computeBudgetBps(cfg.quality.targetMegabytes, sourceDuration, MAXSIZE_MARGIN));
    if (bps < MIN_MAXSIZE_BITRATE_BPS) {
        warnings.push(
            `O tamanho máximo pedido (${cfg.quality.targetMegabytes}MB) é muito baixo para ${sourceDuration.toFixed(1)}s de áudio — ` +
            `usando o bitrate mínimo viável, o arquivo final pode ficar maior que o solicitado`
        );
        bps = MIN_MAXSIZE_BITRATE_BPS;
    }
    return bps;
}

function describeQuality(cfg, bitrateBps) {
    if (cfg.spec.lossless) return 'lossless';
    if (cfg.quality.mode === 'reduce') return `reduce${cfg.quality.percent}%(${Math.round(bitrateBps / 1000)}k)`;
    if (cfg.quality.mode === 'maxSize') return `maxSize(~${Math.round(bitrateBps / 1000)}k)`;
    return `default(${Math.round(bitrateBps / 1000)}k)`;
}

// ── Route handler ────────────────────────────────────────────────────────────

const jsonBodyLimit  = Math.ceil(constants.fileSizeLimit * 1.4) + 65536; // base64 overhead
const jsonBodyParser = express.json({ limit: jsonBodyLimit });

router.post('/audio', function (req, res, next) {
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

// resolves body.base64 / body.url / body.localFile (exactly one expected)
function resolveSource(body, cb) {
    const sources = ['base64', 'url', 'localFile'].filter(function (k) { return body[k]; });
    if (sources.length === 0) return cb(new Error('informe exatamente uma fonte: "base64", "url" ou "localFile"'));
    if (sources.length > 1)  return cb(new Error('informe apenas uma fonte de áudio por requisição (' + sources.join(', ') + ' foram enviados)'));

    const key = sources[0];
    if (key === 'base64') return inputresolver.resolveBase64(body.base64, function (e, p) { cb(e, p, false); });
    if (key === 'url')    return inputresolver.resolveUrl(body.url, function (e, p) { cb(e, p, false); });
    try {
        return cb(null, inputresolver.resolveLocalFile(body.localFile), true);
    } catch (e) {
        return cb(e);
    }
}

// ── JSON transport (base64 / url / localFile only — no native binary upload) ────

function handleJson(req, res, next) {
    const body = req.body || {};
    resolveSource(body, function (err, audioPath, isPersistent) {
        if (err) return fail(res, 400, 'Não foi possível obter o áudio de entrada: ' + err.message);
        process_(req, res, next, body, audioPath, isPersistent);
    });
}

// ── Multipart transport ──────────────────────────────────────────────────────

function handleMultipart(req, res, next) {
    let audioPath = null;
    let configStr = '{}';
    let base64Field = null, urlField = null, localFileField = null;
    let pendingWrites = 0, busboyDone = false;

    let bb;
    try {
        bb = new Busboy({ headers: req.headers, limits: { files: 1, fields: 5, fileSize: constants.fileSizeLimit } });
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
            logger.error(`convertaudio: file size limit hit for ${filename || fieldname}`);
        });

        file.pipe(ws);
        ws.on('finish', function () {
            if (fieldname === 'audio') audioPath = savePath;
            pendingWrites--;
            tryProcess();
        });
        ws.on('error', function (err) {
            logger.error(`convertaudio: write error [${fieldname}]: ${err}`);
            pendingWrites--;
            tryProcess();
        });
    });

    bb.on('finish', function () { busboyDone = true; tryProcess(); });
    bb.on('error', function (err) {
        logger.error(`convertaudio: busboy error: ${err}`);
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

        const sourcesGiven = [audioPath && 'audio', base64Field && 'base64', urlField && 'url', localFileField && 'localFile'].filter(Boolean);
        if (sourcesGiven.length === 0) {
            return fail(res, 400, 'informe exatamente uma fonte: arquivo "audio", ou os campos "base64", "url" ou "localFile"');
        }
        if (sourcesGiven.length > 1) {
            cleanup([audioPath]);
            return fail(res, 400, 'informe apenas uma fonte de áudio por requisição (' + sourcesGiven.join(', ') + ' foram enviados)');
        }

        if (audioPath) return process_(req, res, next, cfg, audioPath, false);

        const cb = function (err, p) {
            if (err) return fail(res, 400, 'Não foi possível obter o áudio de entrada: ' + err.message);
            process_(req, res, next, cfg, p, sourcesGiven[0] === 'localFile');
        };
        if (base64Field) return inputresolver.resolveBase64(base64Field, cb);
        if (urlField)    return inputresolver.resolveUrl(urlField, cb);
        try { return cb(null, inputresolver.resolveLocalFile(localFileField)); }
        catch (e) { return cb(e); }
    }
}

// ── Shared processing (both transports converge here) ───────────────────────

function process_(req, res, next, rawCfg, audioPath, audioIsPersistent) {
    const startTime = Date.now();
    const { errors, warnings, cfg } = validateAndNormalize(rawCfg);

    if (errors.length) {
        if (!audioIsPersistent) cleanup([audioPath]);
        return fail(res, 400, errors.join('; '));
    }

    ffmpeg.ffprobe(audioPath, function (probeErr, metadata) {
        if (probeErr) {
            if (!audioIsPersistent) cleanup([audioPath]);
            return fail(res, 400, 'Não foi possível ler o arquivo de áudio (pode estar corrompido ou em formato não suportado): ' + probeErr.message);
        }

        const streams     = metadata.streams || [];
        const audioStream = streams.find(function (s) { return s.codec_type === 'audio'; });
        if (!audioStream) {
            if (!audioIsPersistent) cleanup([audioPath]);
            return fail(res, 400, 'Nenhuma faixa de áudio encontrada no arquivo de entrada');
        }

        const sourceFormat   = (metadata.format && metadata.format.format_name) || 'unknown';
        const sourceDuration = parseFloat((metadata.format || {}).duration) || 0;

        const bitrateBps = resolveBitrateBps(cfg, sourceDuration, warnings);
        const outFile = uniqueFilename('/tmp/') + '-convertaudio.' + cfg.format;

        // -vn: drop any embedded cover-art/video stream (common in mp3/m4a) so
        // it never gets pulled into an output container that can't carry it.
        const outOpts = ['-vn', `-c:a ${cfg.spec.codec}`];
        if (bitrateBps) outOpts.push(`-b:a ${bitrateBps}`);
        if (cfg.spec.muxer) outOpts.push('-f', cfg.spec.muxer);

        logger.debug(`convertaudio: outputOptions=${JSON.stringify(outOpts)}`);

        ffmpeg(audioPath)
            .renice(constants.defaultFFMPEGProcessPriority)
            .outputOptions(outOpts)
            .on('error', function (err) {
                logger.error(`convertaudio error: ${err}`);
                if (!audioIsPersistent) cleanup([audioPath]);
                cleanup([outFile]);
                fail(res, 500, String(err));
            })
            .on('end', function () {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(2) + 's';
                const qualityDesc = describeQuality(cfg, bitrateBps);

                logger.info(
                    `convertaudio done sourceFormat=${sourceFormat} outputFormat=${cfg.format} ` +
                    `codec=${cfg.spec.codec} quality=${qualityDesc} duration=${sourceDuration} elapsed=${elapsed}`
                );
                warnings.forEach(function (w) { logger.warn(`convertaudio: ${w}`); });

                res.set('X-Original-Format', sourceFormat);
                res.set('X-Output-Format', cfg.format);
                res.set('X-Audio-Codec', cfg.spec.codec);
                res.set('X-Audio-Quality', qualityDesc);
                res.set('X-Output-Duration', String(sourceDuration));
                res.set('X-Warnings', JSON.stringify(warnings));

                if (!audioIsPersistent) cleanup([audioPath]);
                return utils.downloadFile(outFile, null, req, res, next);
            })
            .save(outFile);
    });
}

module.exports = router;
