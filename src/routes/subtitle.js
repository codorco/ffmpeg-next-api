'use strict';

const express        = require('express');
const fs             = require('fs');
const path           = require('path');
const ffmpeg         = require('fluent-ffmpeg');
const Busboy         = require('busboy');
const uniqueFilename = require('unique-filename');

const constants = require('../constants.js');
const logger    = require('../utils/logger.js');
const utils     = require('../utils/utils.js');

const router = express.Router();

// ── Colour helpers ────────────────────────────────────────────────────────────

function hexToASS(hex, alpha) {
    hex = (hex || '#FFFFFF').replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    const r = hex.slice(0, 2);
    const g = hex.slice(2, 4);
    const b = hex.slice(4, 6);
    const a = Math.min(255, Math.max(0, alpha || 0))
                  .toString(16).padStart(2, '0').toUpperCase();
    return `&H${a}${b}${g}${r}`.toUpperCase();
}

function transToAlpha(t) {
    return Math.round(Math.min(1, Math.max(0, parseFloat(t) || 0)) * 255);
}

// ── Time helpers ──────────────────────────────────────────────────────────────

function pad2(n) { return String(Math.floor(n)).padStart(2, '0'); }

function toASSTime(secs) {
    secs = Math.max(0, secs);
    const h  = Math.floor(secs / 3600);
    const m  = Math.floor((secs % 3600) / 60);
    const s  = Math.floor(secs % 60);
    const cs = Math.round((secs - Math.floor(secs)) * 100);
    return `${h}:${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

// ── SRT parser ────────────────────────────────────────────────────────────────

function parseSRT(content) {
    return content.trim()
        .split(/\n\s*\n/)
        .filter(Boolean)
        .reduce(function (acc, block) {
            const lines    = block.trim().split('\n');
            const timeLine = lines.find(function (l) { return /-->/.test(l); });
            if (!timeLine) return acc;
            const textStart = lines.indexOf(timeLine) + 1;
            const m = timeLine.match(
                /(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})/
            );
            if (!m) return acc;
            function parseT(t) {
                var clean = t.replace(',', '.');
                var parts = clean.split('.');
                var hms   = parts[0].split(':');
                return +hms[0]*3600 + +hms[1]*60 + +hms[2] + +(parts[1]||'0')/1000;
            }
            acc.push({
                start: parseT(m[1]),
                end:   parseT(m[2]),
                text:  lines.slice(textStart).join('\n').replace(/<[^>]+>/g, '').trim(),
            });
            return acc;
        }, []);
}

function looksLikeSRT(content) {
    return /^\d+\s*\n\d{2}:\d{2}:\d{2}[,\.]\d{3}\s*-->/m.test((content || '').trim());
}

function hasASSStyles(content) {
    return /^\[V4\+?\s*Styles\]/m.test(content);
}

function hasKaraokeTags(content) {
    return /\{[^}]*\\k[fo]?\d+/i.test(content);
}

function parseASSTime(t) {
    var m = t.match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/);
    if (!m) return 0;
    return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 100;
}

function parseASSDialogues(content) {
    var entries = [];
    content.split('\n').forEach(function (line) {
        if (!/^Dialogue\s*:/i.test(line)) return;
        var rest  = line.replace(/^Dialogue\s*:\s*/i, '');
        var parts = rest.split(',');
        if (parts.length < 10) return;
        entries.push({
            start: parseASSTime(parts[1].trim()),
            end:   parseASSTime(parts[2].trim()),
            text:  parts.slice(9).join(','),
        });
    });
    return entries;
}

// ── Words-per-line splitter ───────────────────────────────────────────────────

function splitKaraokeEntry(entry, n) {
    var re = /\{\\(k[fo]?)(\d+)\}([^{]*)/g, syls = [], m;
    while ((m = re.exec(entry.text)) !== null)
        syls.push({ mode: m[1], k: parseInt(m[2]), text: m[3] });
    if (!syls.length) return [entry];
    var result = [], startSecs = entry.start;
    for (var i = 0; i < syls.length; i += n) {
        var chunk   = syls.slice(i, i + n);
        var durSecs = chunk.reduce(function (s, x) { return s + x.k; }, 0) / 100;
        var endSecs = (i + n >= syls.length) ? entry.end : startSecs + durSecs;
        var text    = chunk.map(function (s) { return '{\\' + s.mode + s.k + '}' + s.text; }).join('');
        result.push({ start: startSecs, end: endSecs, text: text.trim() });
        startSecs = endSecs;
    }
    return result;
}

function splitPlainEntry(entry, n) {
    var words = entry.text.trim().split(/\s+/).filter(Boolean);
    if (words.length <= n) return [entry];
    var result = [], dur = entry.end - entry.start, total = words.length;
    for (var i = 0; i < words.length; i += n) {
        var chunk = words.slice(i, i + n);
        var t0 = entry.start + (i / total) * dur;
        var t1 = (i + n >= total) ? entry.end : entry.start + ((i + n) / total) * dur;
        result.push({ start: t0, end: t1, text: chunk.join(' ') });
    }
    return result;
}

function splitEntriesByWords(entries, wordsPerLine) {
    var n = parseInt(wordsPerLine) || 0;
    if (n <= 0) return entries;
    var result = [];
    entries.forEach(function (entry) {
        var hasK  = /\{\\k[fo]?\d+\}/.test(entry.text || '');
        var split = hasK ? splitKaraokeEntry(entry, n) : splitPlainEntry(entry, n);
        split.forEach(function (e) { result.push(e); });
    });
    return result;
}

// ── ASS style builder ─────────────────────────────────────────────────────────

const STYLE_DEFAULTS = {
    fontname:     'FreeSans',
    fontsize:     60,
    primaryColor: '#FFFFFF',
    outlineColor: '#000000',
    shadowColor:  '#000000',
    backColor:    '#000000',
    primaryAlpha: 0,
    outlineAlpha: 0,
    shadowAlpha:  0,
    backAlpha:    0.5,
    bold:         false,
    italic:       false,
    underline:    false,
    strikeout:    false,
    scaleX:       100,
    scaleY:       100,
    spacing:      0,
    angle:        0,
    borderStyle:  1,
    outline:      2,
    shadow:       1,
    alignment:    2,
    marginL:      20,
    marginR:      20,
    marginV:      80,
};

function resolveAlignment(s) {
    if (s.position && typeof s.position === 'string') {
        if (s.position === 'top')    return 8;
        if (s.position === 'upper')  return 8;
        if (s.position === 'center') return 5;
        if (s.position === 'lower')  return 2;
        if (s.position === 'bottom') return 2;
    }
    if (s.position && typeof s.position === 'object') return 5;
    return parseInt(s.alignment) || STYLE_DEFAULTS.alignment;
}

function buildStyleLine(styleCfg) {
    const s = Object.assign({}, STYLE_DEFAULTS, styleCfg || {});
    s.alignment = resolveAlignment(s);

    const primary   = hexToASS(s.primaryColor,  transToAlpha(s.primaryAlpha));
    const secondary = hexToASS(s.secondaryColor || '#FFFF00', 0);
    const outline   = hexToASS(s.outlineColor,   transToAlpha(s.outlineAlpha));
    const back      = hexToASS(s.backColor,       transToAlpha(s.backAlpha));

    return [
        'Style: Default',
        s.fontname,
        Math.round(s.fontsize),
        primary, secondary, outline, back,
        s.bold      ? -1 : 0,
        s.italic    ? -1 : 0,
        s.underline ? -1 : 0,
        s.strikeout ? -1 : 0,
        Math.round(s.scaleX),
        Math.round(s.scaleY),
        s.spacing,
        s.angle,
        s.borderStyle,
        s.outline,
        s.shadow,
        s.alignment,
        s.marginL, s.marginR, s.marginV,
        1,
    ].join(',');
}

// ── Effect tags ───────────────────────────────────────────────────────────────

const PLAY_W = 1920;
const PLAY_H = 1080;

function basePos(alignment, mL, mR, mV) {
    const col = (alignment - 1) % 3;
    const row = Math.floor((alignment - 1) / 3);
    const x   = col === 0 ? (mL || 20) : col === 1 ? PLAY_W / 2 : PLAY_W - (mR || 20);
    const y   = row === 0 ? PLAY_H - (mV || 80) : row === 1 ? PLAY_H / 2 : (mV || 80);
    return { x: Math.round(x), y: Math.round(y) };
}

function effectTags(preset, animCfg, styleCfg) {
    preset = (preset || 'none').toLowerCase();
    const d  = Math.round(animCfg.duration  || 250);
    const iv = parseFloat(animCfg.intensity) || 1.0;
    const dl = Math.round(animCfg.delay     || 0);
    const s  = Object.assign({}, STYLE_DEFAULTS, styleCfg || {});
    s.alignment = resolveAlignment(s);
    const { x, y } = basePos(s.alignment, s.marginL, s.marginR, s.marginV);
    const t0 = dl, t1 = dl + d;
    const pct = function (v) { return Math.round(v * iv); };

    switch (preset) {
        case 'none':       return '';
        case 'fade':       return '{\\fad(' + d + ',' + d + ')}';
        case 'blur-in':    return '{\\blur' + pct(30) + '\\t(' + t0 + ',' + t1 + ',\\blur0)}';
        case 'blur-out':   return '{\\t(' + t0 + ',' + t1 + ',\\blur' + pct(30) + ')}';
        case 'scale-up':   return '{\\fscx10\\fscy10\\t(' + t0 + ',' + t1 + ',\\fscx100\\fscy100)}';
        case 'scale-down': return '{\\fscx' + pct(180) + '\\fscy' + pct(180) + '\\t(' + t0 + ',' + t1 + ',\\fscx100\\fscy100)}';
        case 'pop': {
            const over = pct(120), mid = Math.round(t0 + d * 0.7);
            return '{\\fscx5\\fscy5\\t(' + t0 + ',' + mid + ',\\fscx' + over + '\\fscy' + over + ')\\t(' + mid + ',' + t1 + ',\\fscx100\\fscy100)}';
        }
        case 'zoom': {
            return '{\\fscx' + pct(180) + '\\fscy' + pct(180) + '\\t(' + t0 + ',' + t1 + ',\\fscx100\\fscy100)}';
        }
        case 'bounce': {
            const over = 100 + pct(25), mid = Math.round(t0 + d * 0.65);
            return '{\\fscx5\\fscy5\\t(' + t0 + ',' + mid + ',\\fscx' + over + '\\fscy' + over + ')\\t(' + mid + ',' + t1 + ',\\fscx100\\fscy100)}';
        }
        case 'slide-left':   return '{\\move(' + (PLAY_W + 200) + ',' + y + ',' + x + ',' + y + ',' + t0 + ',' + t1 + ')}';
        case 'slide-right':  return '{\\move(-200,' + y + ',' + x + ',' + y + ',' + t0 + ',' + t1 + ')}';
        case 'slide-top':    return '{\\move(' + x + ',' + (PLAY_H + 100) + ',' + x + ',' + y + ',' + t0 + ',' + t1 + ')}';
        case 'slide-bottom': return '{\\move(' + x + ',-100,' + x + ',' + y + ',' + t0 + ',' + t1 + ')}';
        case 'glow':         return '{\\blur' + pct(8) + '\\t(' + t0 + ',' + t1 + ',\\blur0)}';
        case 'neon':         return '{\\blur' + pct(6) + '\\fad(' + d + ',0)}';
        case 'shake': {
            const a = pct(8);
            return '{\\t(0,' + Math.round(d/4) + ',\\frz' + a + ')' +
                   '\\t(' + Math.round(d/4) + ',' + Math.round(d/2) + ',\\frz-' + a + ')' +
                   '\\t(' + Math.round(d/2) + ',' + Math.round(d*3/4) + ',\\frz' + Math.round(a/2) + ')' +
                   '\\t(' + Math.round(d*3/4) + ',' + t1 + ',\\frz0)}';
        }
        case 'pulse': {
            const over = 100 + pct(15);
            return '{\\fscx' + over + '\\fscy' + over +
                   '\\t(0,' + Math.round(d/2) + ',\\fscx100\\fscy100)' +
                   '\\t(' + Math.round(d/2) + ',' + d + ',\\fscx' + over + '\\fscy' + over + ')' +
                   '\\t(' + d + ',' + (d*2) + ',\\fscx100\\fscy100)}';
        }
        case 'cinematic': return '{\\fad(' + d + ',' + d + ')\\blur2}';
        case 'typewriter': return '';
        case 'karaoke':    return '';
        default:           return '';
    }
}

// ── Karaoke ───────────────────────────────────────────────────────────────────

function wrapKaraoke(text, durationSecs, kMode) {
    var words = text.replace(/\\N/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return text;
    var cs = Math.max(1, Math.round((durationSecs * 100) / words.length));
    return words.map(function (w) { return '{\\' + kMode + cs + '}' + w; }).join(' ');
}

// ── Typewriter ────────────────────────────────────────────────────────────────

function typewriterDialogues(entry, animCfg) {
    var chars    = entry.text.split('');
    var n        = chars.length;
    if (!n) return [entry];
    var speed    = ((animCfg || {}).speed || 'normal');
    var nomMs    = speed === 'fast' ? 30 : speed === 'slow' ? 120 : 60;
    var totalMs  = (entry.end - entry.start) * 1000;
    var animMs   = Math.min(nomMs * n, totalMs * 0.85);
    var charMs   = animMs / n;
    var result   = [];
    var partial  = '';
    chars.forEach(function (c, i) {
        partial += c;
        var startMs = i * charMs;
        var endMs   = i < n - 1 ? (i + 1) * charMs : totalMs;
        result.push({
            start: entry.start + startMs / 1000,
            end:   entry.start + endMs   / 1000,
            text:  partial,
        });
    });
    return result;
}

// ── ASS generator ─────────────────────────────────────────────────────────────

const FORMAT_STYLE  = 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding';
const FORMAT_EVENTS = 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';

function generateASS(entries, cfg, preserveText) {
    cfg = cfg || {};
    var styleCfg  = cfg.style     || {};
    var effectCfg = cfg.effects   || {};
    var animCfg   = cfg.animation || {};
    var karaoke   = cfg.karaoke   || {};

    var preset   = ((effectCfg.preset || 'none') + '').toLowerCase();
    var kEnabled = karaoke.enabled === true || karaoke.enabled === 'true';
    var kMode    = karaoke.mode || 'kf';

    var mergedStyle = Object.assign({}, styleCfg);
    if (kEnabled) {
        mergedStyle.primaryColor   = karaoke.highlightColor || '#FFFF00';
        mergedStyle.secondaryColor = karaoke.textColor      || '#FFFFFF';
        if (karaoke.outlineColor) mergedStyle.outlineColor = karaoke.outlineColor;
        if (karaoke.shadowColor)  mergedStyle.shadowColor  = karaoke.shadowColor;
    }

    var playResX = cfg.playResX || PLAY_W;
    var playResY = cfg.playResY || PLAY_H;

    // Position override tag per-dialogue
    var manualPos = '';
    var pos = styleCfg.position;
    if (pos && typeof pos === 'object' && pos.x != null && pos.y != null) {
        // Custom {x, y}: \an5 anchors the text center at the given coordinates
        manualPos = '{\\an5\\pos(' + pos.x + ',' + pos.y + ')}';
    } else if (pos === 'lower') {
        // Between center and bottom (~75% from top), bottom-center anchor
        manualPos = '{\\an2\\pos(' + Math.round(playResX / 2) + ',' + Math.round(playResY * 0.75) + ')}';
    } else if (pos === 'upper') {
        // Between center and top (~25% from top), top-center anchor
        manualPos = '{\\an8\\pos(' + Math.round(playResX / 2) + ',' + Math.round(playResY * 0.25) + ')}';
    }

    var dialogues = [];
    entries.forEach(function (entry) {
        if (preset === 'typewriter') {
            typewriterDialogues(entry, animCfg).forEach(function (sub) {
                dialogues.push('Dialogue: 0,' + toASSTime(sub.start) + ',' + toASSTime(sub.end) +
                    ',Default,,0,0,0,,' + manualPos + sub.text.replace(/\n/g, '\\N'));
            });
        } else {
            var text = entry.text.replace(/\n/g, '\\N');
            if (kEnabled && !preserveText) text = wrapKaraoke(text, entry.end - entry.start, kMode);
            var fx = effectTags(preset, animCfg, mergedStyle);
            dialogues.push('Dialogue: 0,' + toASSTime(entry.start) + ',' + toASSTime(entry.end) +
                ',Default,,0,0,0,,' + manualPos + fx + text);
        }
    });

    return [
        '[Script Info]',
        'ScriptType: v4.00+',
        'PlayResX: ' + playResX,
        'PlayResY: ' + playResY,
        'ScaledBorderAndShadow: yes',
        '',
        '[V4+ Styles]',
        FORMAT_STYLE,
        buildStyleLine(mergedStyle),
        '',
        '[Events]',
        FORMAT_EVENTS,
    ].concat(dialogues).join('\n');
}

// ── Transcript → entries ──────────────────────────────────────────────────────

function transcriptToEntries(content, videoDuration) {
    if (looksLikeSRT(content)) return parseSRT(content);
    var lines = content.trim().split(/\n\s*\n/).filter(Boolean);
    var segs  = lines.length > 1 ? lines : content.trim().split('\n').filter(Boolean);
    if (!segs.length) return [];
    var dur = videoDuration / segs.length;
    return segs.map(function (seg, i) {
        return { start: i * dur, end: (i + 1) * dur, text: seg.trim() };
    });
}

// ── FFmpeg runner ─────────────────────────────────────────────────────────────

function escapeFP(p) {
    return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function runFFmpeg(videoPath, assPath, mode, cfg, fontDir, onSuccess, onError) {
    var output    = cfg.output || {};
    var crf       = Math.min(51, Math.max(0, parseInt(output.crf) || 20));
    var vpreset   = output.preset  || 'medium';
    var threads   = parseInt(output.threads) || 8;
    var ext       = mode === 'soft' ? '.mkv' : '.mp4';
    var outFile   = uniqueFilename('/tmp/') + '-subtitle' + ext;

    var cmd = ffmpeg(videoPath).renice(constants.defaultFFMPEGProcessPriority);

    if (mode === 'soft') {
        cmd.input(assPath)
           .outputOptions(['-c:v copy', '-c:a copy', '-c:s ass']);
    } else {
        var vf = "subtitles='" + escapeFP(assPath) + "'";
        if (fontDir) vf += ":fontsdir='" + escapeFP(fontDir) + "'";
        cmd.outputOptions([
            '-vf ' + vf,
            '-c:v libx264',
            '-crf ' + crf,
            '-preset ' + vpreset,
            '-pix_fmt yuv420p',
            '-c:a copy',
            '-threads ' + threads,
        ]);
    }

    if (output.fps) cmd.outputOptions(['-r ' + parseInt(output.fps)]);

    cmd
        .on('error', function (err) { onError(err, outFile); })
        .on('end',   function ()    { onSuccess(outFile);    })
        .save(outFile);
}

// ── Route handler ─────────────────────────────────────────────────────────────

router.post('/ass', function (req, res, next) {
    var videoPath     = null;
    var subtitlePath  = null;
    var transcriptStr = null;
    var configStr     = '{}';
    var fontPaths     = [];
    var pendingWrites = 0;
    var busboyDone    = false;

    var bb;
    try {
        bb = new Busboy({
            headers: req.headers,
            limits:  { files: 60, fields: 10, fileSize: constants.fileSizeLimit },
        });
    } catch (e) {
        return fail(400, 'Invalid multipart request');
    }

    bb.on('field', function (fieldname, val) {
        if (fieldname === 'config')     configStr     = val;
        if (fieldname === 'transcript') transcriptStr = val;
    });

    bb.on('file', function (fieldname, file, filename) {
        pendingWrites++;
        var savePath = uniqueFilename('/tmp/') + '-' + path.basename(filename || fieldname);
        var ws = fs.createWriteStream(savePath);

        file.on('limit', function () {
            logger.error('subtitle: file size limit hit for ' + (filename || fieldname));
        });

        file.pipe(ws);
        ws.on('finish', function () {
            if (fieldname === 'video') {
                videoPath = savePath;
            } else if (['subtitle','ass','srt','transcript'].indexOf(fieldname) !== -1) {
                subtitlePath = savePath;
            } else if (/^font/.test(fieldname)) {
                fontPaths.push(savePath);
            }
            pendingWrites--;
            tryProcess();
        });
        ws.on('error', function (err) {
            logger.error('Write error [' + fieldname + ']: ' + err);
            pendingWrites--;
            tryProcess();
        });
    });

    bb.on('finish', function () { busboyDone = true; tryProcess(); });
    bb.on('error',  function (err) {
        logger.error('Busboy error: ' + err);
        fail(500, 'Upload error: ' + err);
    });

    req.pipe(bb);

    function tryProcess() {
        if (busboyDone && pendingWrites === 0) buildVideo();
    }

    function fail(code, msg) {
        cleanup([videoPath, subtitlePath].concat(fontPaths));
        res.writeHead(code, { 'Connection': 'close' });
        res.end(JSON.stringify({ error: msg }));
    }

    function cleanup(paths) {
        (paths || []).forEach(function (p) {
            if (p) try { utils.deleteFile(p); } catch (_) {}
        });
    }

    function cleanFontDir(fontDir) {
        if (!fontDir) return;
        try {
            fs.readdirSync(fontDir).forEach(function (f) {
                fs.unlinkSync(path.join(fontDir, f));
            });
            fs.rmdirSync(fontDir);
        } catch (_) {}
    }

    function buildVideo() {
        var cfg;
        try { cfg = JSON.parse(configStr); } catch (e) {
            return fail(400, 'Invalid JSON in "config" field');
        }

        if (!videoPath) return fail(400, 'Missing required file field: "video"');

        if (cfg.advanced && typeof cfg.advanced === 'object') {
            Object.assign(cfg, cfg.advanced);
        }

        var mode = ((cfg.mode || 'burn') + '').toLowerCase();

        // Setup font directory
        var fontDir = null;
        if (fontPaths.length > 0) {
            fontDir = uniqueFilename('/tmp/') + '-fonts';
            try {
                fs.mkdirSync(fontDir);
                fontPaths.forEach(function (fp) {
                    fs.copyFileSync(fp, path.join(fontDir, path.basename(fp)));
                });
            } catch (e) {
                logger.error('Font dir setup error: ' + e);
            }
        }

        function finish(assPath, isGenerated) {
            logger.debug('subtitle/ass: mode=' + mode + ' ass=' + assPath);
            runFFmpeg(videoPath, assPath, mode, cfg, fontDir,
                function onSuccess(outFile) {
                    var toDelete = [videoPath].concat(fontPaths);
                    if (isGenerated) toDelete.push(assPath);
                    if (subtitlePath && subtitlePath !== assPath) toDelete.push(subtitlePath);
                    cleanup(toDelete);
                    cleanFontDir(fontDir);
                    return utils.downloadFile(outFile, null, req, res, next);
                },
                function onError(err, outFile) {
                    logger.error('subtitle/ass ffmpeg error: ' + err);
                    var toDelete = [videoPath, assPath].concat(fontPaths);
                    if (subtitlePath && subtitlePath !== assPath) toDelete.push(subtitlePath);
                    if (outFile) toDelete.push(outFile);
                    cleanup(toDelete);
                    cleanFontDir(fontDir);
                    res.writeHead(500, { 'Connection': 'close' });
                    res.end(JSON.stringify({ error: '' + err }));
                }
            );
        }

        // Path A: subtitle file uploaded (ASS or SRT)
        if (subtitlePath) {
            var content;
            try { content = fs.readFileSync(subtitlePath, 'utf8'); } catch (e) {
                return fail(500, 'Could not read subtitle file: ' + e);
            }
            if (looksLikeSRT(content)) {
                var entries    = parseSRT(content);
                entries        = splitEntriesByWords(entries, cfg.wordsPerLine);
                var assContent = generateASS(entries, cfg);
                var genPath    = uniqueFilename('/tmp/') + '-generated.ass';
                fs.writeFileSync(genPath, assContent, 'utf8');
                return finish(genPath, true);
            }
            // ASS without styles — inject style from config
            if (!hasASSStyles(content)) {
                var assEntries      = parseASSDialogues(content);
                assEntries          = splitEntriesByWords(assEntries, cfg.wordsPerLine);
                var assCfg          = cfg;
                if (hasKaraokeTags(content)) {
                    var k  = cfg.karaoke || {};
                    assCfg = Object.assign({}, cfg, { karaoke: Object.assign({}, k, { enabled: true }) });
                }
                var injectedContent = generateASS(assEntries, assCfg, true);
                var injectedPath    = uniqueFilename('/tmp/') + '-generated.ass';
                fs.writeFileSync(injectedPath, injectedContent, 'utf8');
                return finish(injectedPath, true);
            }
            // Already ASS with styles — use directly
            return finish(subtitlePath, false);
        }

        // Path B: inline transcript text (field or cfg.transcript)
        var txtContent = transcriptStr || cfg.transcript || null;
        if (!txtContent) {
            return fail(400,
                'Missing subtitle: provide field "subtitle" (ASS/SRT file), ' +
                '"transcript" (text field), or config.transcript (JSON key)');
        }

        if (looksLikeSRT(txtContent)) {
            var entries2    = parseSRT(txtContent);
            entries2        = splitEntriesByWords(entries2, cfg.wordsPerLine);
            var assContent2 = generateASS(entries2, cfg);
            var genPath2    = uniqueFilename('/tmp/') + '-generated.ass';
            fs.writeFileSync(genPath2, assContent2, 'utf8');
            return finish(genPath2, true);
        }

        // Plain text — needs video duration
        ffmpeg.ffprobe(videoPath, function (probeErr, metadata) {
            if (probeErr) {
                return fail(500, 'Could not read video metadata: ' + probeErr);
            }
            var duration = (metadata.format && metadata.format.duration) || 10;
            var entries3 = transcriptToEntries(txtContent, duration);
            if (!entries3.length) return fail(400, 'Transcript produced no subtitle entries');
            entries3        = splitEntriesByWords(entries3, cfg.wordsPerLine);
            var assContent3 = generateASS(entries3, cfg);
            var genPath3    = uniqueFilename('/tmp/') + '-generated.ass';
            fs.writeFileSync(genPath3, assContent3, 'utf8');
            return finish(genPath3, true);
        });
    }
});

module.exports = router;
