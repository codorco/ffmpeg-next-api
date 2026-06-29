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

const MAX_TRACKS = 5;

// ── Defaults ──────────────────────────────────────────────────────────────────

const TRACK_DEFAULTS = {
    volume:       1.0,
    delay:        0,
    loop:         false,
    mute:         false,
    fadeIn:       0,
    fadeOut:      0,
    playbackRate: 1.0,
    trim:         { start: 0, end: null },
};

// ── Validation ────────────────────────────────────────────────────────────────

function validateConfig(cfg, trackPaths) {
    var errors = [];

    if (['mix', 'streams'].indexOf(cfg.mode) === -1) {
        errors.push('mode must be "mix" or "streams"');
    }
    if (['keep', 'remove', 'mute'].indexOf(cfg.originalAudio) === -1) {
        errors.push('originalAudio must be "keep", "remove", or "mute"');
    }
    if (['video', 'audio', 'longest', 'shortest'].indexOf(cfg.duration) === -1) {
        errors.push('duration must be "video", "audio", "longest", or "shortest"');
    }
    if ((cfg.tracks || []).length > MAX_TRACKS) {
        errors.push('Maximum ' + MAX_TRACKS + ' tracks allowed');
    }

    (cfg.tracks || []).forEach(function (t, i) {
        var track = Object.assign({}, TRACK_DEFAULTS, t);
        var vol   = parseFloat(track.volume);
        if (isNaN(vol) || vol < 0 || vol > 10) {
            errors.push('tracks[' + i + '].volume must be 0–10');
        }
        if (parseFloat(track.delay) < 0) {
            errors.push('tracks[' + i + '].delay must be >= 0');
        }
        if (parseFloat(track.fadeIn) < 0) {
            errors.push('tracks[' + i + '].fadeIn must be >= 0');
        }
        if (parseFloat(track.fadeOut) < 0) {
            errors.push('tracks[' + i + '].fadeOut must be >= 0');
        }
        var rate = parseFloat(track.playbackRate);
        if (isNaN(rate) || rate < 0.5 || rate > 2.0) {
            errors.push('tracks[' + i + '].playbackRate must be 0.5–2.0');
        }
        var ts = track.trim && track.trim.start != null ? parseFloat(track.trim.start) : 0;
        var te = track.trim && track.trim.end   != null ? parseFloat(track.trim.end)   : null;
        if (ts < 0) {
            errors.push('tracks[' + i + '].trim.start must be >= 0');
        }
        if (te !== null && te <= ts) {
            errors.push('tracks[' + i + '].trim.end must be > trim.start');
        }
        if (!track.mute && !trackPaths[i]) {
            errors.push('Track ' + i + ' has no uploaded file — upload as field "track' + i + '"');
        }
    });

    return errors;
}

// ── Per-track filter chain ────────────────────────────────────────────────────

function buildTrackChain(track, inputIdx, trackIdx, targetDuration) {
    var parts = [];
    var src   = '[' + inputIdx + ':a]';
    var lbl   = '[at' + trackIdx + ']';

    var ts = (track.trim && track.trim.start != null) ? parseFloat(track.trim.start) : 0;
    var te = (track.trim && track.trim.end   != null) ? parseFloat(track.trim.end)   : null;

    if (ts > 0 || te !== null) {
        var tp = 'atrim=';
        if (ts > 0) tp += 'start=' + ts;
        if (te !== null) tp += (ts > 0 ? ':' : '') + 'end=' + te;
        parts.push(tp);
        parts.push('asetpts=PTS-STARTPTS');
    }

    var rate = parseFloat(track.playbackRate) || 1.0;
    if (Math.abs(rate - 1.0) > 0.001) {
        parts.push('atempo=' + rate);
    }

    // Loop — cap immediately to targetDuration so ffmpeg doesn't run forever
    if (track.loop && targetDuration > 0) {
        parts.push('aloop=loop=-1:size=2000000000');
        parts.push('atrim=0:' + targetDuration);
        parts.push('asetpts=PTS-STARTPTS');
    }

    var delay = parseInt(track.delay) || 0;
    if (delay > 0) {
        parts.push('adelay=' + delay + '|' + delay);
    }

    var vol = parseFloat(track.volume);
    if (!isNaN(vol) && Math.abs(vol - 1.0) > 0.001) {
        parts.push('volume=' + vol);
    }

    if (track.fadeIn > 0) {
        parts.push('afade=t=in:st=0:d=' + track.fadeIn);
    }

    if (track.fadeOut > 0 && targetDuration > 0) {
        // Effective length after trim
        var effectiveDur = te !== null ? (te - ts) : targetDuration;
        var foStart = Math.max(0, effectiveDur - track.fadeOut);
        parts.push('afade=t=out:st=' + foStart + ':d=' + track.fadeOut);
    }

    if (parts.length === 0) {
        return src + 'anull' + lbl;
    }
    return src + parts.join(',') + lbl;
}

// ── Probe helper ──────────────────────────────────────────────────────────────

function probeAudioDuration(filePath, cb) {
    ffmpeg.ffprobe(filePath, function (err, data) {
        if (err) return cb(0);
        cb(parseFloat((data.format || {}).duration) || 0);
    });
}

// ── Route handler ─────────────────────────────────────────────────────────────

router.post('/add/audio', function (req, res, next) {
    var videoPath     = null;
    var trackPaths    = [];
    var imagePath     = null;
    var configStr     = '{}';
    var pendingWrites = 0;
    var busboyDone    = false;

    var bb;
    try {
        bb = new Busboy({
            headers: req.headers,
            limits:  { files: 10, fields: 5, fileSize: constants.fileSizeLimit },
        });
    } catch (e) {
        return fail(400, 'Invalid multipart request');
    }

    bb.on('field', function (fieldname, val) {
        if (fieldname === 'config') configStr = val;
    });

    bb.on('file', function (fieldname, file, filename) {
        pendingWrites++;
        var savePath = uniqueFilename('/tmp/') + '-' + path.basename(filename || fieldname);
        var ws = fs.createWriteStream(savePath);

        file.on('limit', function () {
            logger.error('addaudio: size limit for ' + (filename || fieldname));
        });

        file.pipe(ws);

        ws.on('finish', function () {
            if (fieldname === 'video') {
                videoPath = savePath;
            } else {
                var m = fieldname.match(/^track([0-4])$/);
                if (m) trackPaths[parseInt(m[1])] = savePath;
                else if (fieldname === 'image') imagePath = savePath;
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
        if (busboyDone && pendingWrites === 0) start();
    }

    function getAllPaths() {
        return [videoPath, imagePath].concat(trackPaths).filter(Boolean);
    }

    function cleanup(paths) {
        (paths || []).forEach(function (p) {
            if (p) try { utils.deleteFile(p); } catch (_) {}
        });
    }

    function fail(code, msg) {
        cleanup(getAllPaths());
        res.writeHead(code, { 'Connection': 'close' });
        res.end(JSON.stringify({ error: msg }));
    }

    // ── Step 1: parse & validate config ──────────────────────────────────────

    function start() {
        var cfg;
        try { cfg = JSON.parse(configStr); } catch (e) {
            return fail(400, 'Invalid JSON in "config" field');
        }

        cfg.mode          = (cfg.mode          || 'mix').toLowerCase();
        cfg.originalAudio = (cfg.originalAudio || 'keep').toLowerCase();
        cfg.duration      = (cfg.duration      || 'video').toLowerCase();
        cfg.normalize     = !!cfg.normalize;
        cfg.crossfade     = parseFloat(cfg.crossfade) || 0;
        cfg.tracks        = cfg.tracks || [];

        if (!videoPath) return fail(400, 'Missing required field: "video"');

        var errors = validateConfig(cfg, trackPaths);
        if (errors.length > 0) return fail(400, errors.join('; '));

        probeAndBuild(cfg);
    }

    // ── Step 2: probe video (always) + audio (when needed) ───────────────────

    function probeAndBuild(cfg) {
        ffmpeg.ffprobe(videoPath, function (probeErr, videoMeta) {
            if (probeErr) return fail(500, 'Could not probe video: ' + probeErr);

            var videoDuration = parseFloat((videoMeta.format || {}).duration) || 0;
            var streams       = videoMeta.streams || [];

            var vs = streams.find(function (s) { return s.codec_type === 'video'; }) || {};
            var fpsParts = (vs.r_frame_rate || '30/1').split('/');
            var fpsNum   = parseFloat(fpsParts[0]) || 30;
            var fpsDen   = parseFloat(fpsParts[1]) || 1;

            var videoInfo = {
                width:  vs.width  || 1920,
                height: vs.height || 1080,
                fps:    fpsDen > 0 ? fpsNum / fpsDen : fpsNum,
                pixFmt: vs.pix_fmt || 'yuv420p',
            };

            var hasVideoAudio = streams.some(function (s) { return s.codec_type === 'audio'; });

            var needAudioProbe = cfg.duration !== 'video' ||
                (cfg.afterVideo && cfg.afterVideo.duration === 'audio') ||
                cfg.tracks.some(function (t) { return t.loop; });

            var activeIndices = cfg.tracks.reduce(function (acc, t, i) {
                if (!t.mute && trackPaths[i]) acc.push(i);
                return acc;
            }, []);

            if (!needAudioProbe || activeIndices.length === 0) {
                return assemble(cfg, videoDuration, videoDuration,
                    new Array(MAX_TRACKS).fill(0), videoInfo, hasVideoAudio);
            }

            var audioDurations = new Array(MAX_TRACKS).fill(0);
            var done = 0;

            activeIndices.forEach(function (i) {
                probeAudioDuration(trackPaths[i], function (dur) {
                    audioDurations[i] = dur;
                    done++;
                    if (done === activeIndices.length) {
                        var maxAudio = activeIndices.reduce(function (m, idx) {
                            return Math.max(m, audioDurations[idx]);
                        }, 0);

                        var target;
                        switch (cfg.duration) {
                            case 'audio':    target = maxAudio; break;
                            case 'longest':  target = Math.max(videoDuration, maxAudio); break;
                            case 'shortest': target = Math.min(videoDuration, maxAudio || videoDuration); break;
                            default:         target = videoDuration; break;
                        }

                        assemble(cfg, videoDuration, target, audioDurations, videoInfo, hasVideoAudio);
                    }
                });
            });
        });
    }

    // ── Step 3: build filter_complex and run ffmpeg ───────────────────────────

    function assemble(cfg, videoDuration, targetDuration, audioDurations, videoInfo, hasVideoAudio) {
        var startTime = Date.now();
        var warnings  = [];
        var filters   = [];

        // Degrade originalAudio if video has no audio stream
        var origMode = cfg.originalAudio;
        if ((origMode === 'keep' || origMode === 'mute') && !hasVideoAudio) {
            warnings.push('Video has no audio stream — originalAudio set to "remove"');
            origMode = 'remove';
        }

        // Build active track map: trackIdx → ffmpeg input index
        var activeMap  = [];
        var nextInput  = 1; // input 0 = video

        cfg.tracks.forEach(function (t, i) {
            if (t.mute || !trackPaths[i]) return;
            activeMap.push({
                trackIdx: i,
                inputIdx: nextInput++,
                cfg:      Object.assign({}, TRACK_DEFAULTS, t),
            });
        });

        // afterVideo image gets its own input index
        var afterVideoCfg = cfg.afterVideo || {};
        var extraDuration = 0;

        if (afterVideoCfg.mode) {
            if (typeof afterVideoCfg.duration === 'number') {
                extraDuration = afterVideoCfg.duration;
            } else if (cfg.duration !== 'video') {
                extraDuration = Math.max(0, targetDuration - videoDuration);
            }
        }

        var imageInputIdx = -1;
        if (extraDuration > 0 && afterVideoCfg.mode === 'image' && imagePath) {
            imageInputIdx = nextInput++;
        }

        // Per-track chains
        activeMap.forEach(function (m) {
            filters.push(buildTrackChain(m.cfg, m.inputIdx, m.trackIdx, targetDuration));
        });

        // Label map (may be mutated by ducking)
        var labelMap = {};
        activeMap.forEach(function (m) { labelMap[m.trackIdx] = '[at' + m.trackIdx + ']'; });

        // Ducking
        var dk = cfg.ducking || {};
        if (dk.enabled && activeMap.length >= 2) {
            var vIdx = dk.voiceTrack != null ? parseInt(dk.voiceTrack) : 0;
            var mIdx = dk.musicTrack != null ? parseInt(dk.musicTrack) : 1;
            var vLbl = labelMap[vIdx];
            var mLbl = labelMap[mIdx];
            if (vLbl && mLbl) {
                var duckOut = '[atducked]';
                // signal=music, sidechain=voice → voice triggers ducking on music
                filters.push(mLbl + vLbl + 'sidechaincompress=threshold=0.015:ratio=8:attack=5:release=100' + duckOut);
                labelMap[mIdx] = duckOut;
            } else {
                warnings.push('ducking.voiceTrack or ducking.musicTrack not found in active tracks');
            }
        }

        // Crossfade between consecutive tracks
        var crossfadeResultLabel = null;
        if (cfg.crossfade > 0 && activeMap.length > 1) {
            var cfChain = labelMap[activeMap[0].trackIdx];
            for (var ci = 1; ci < activeMap.length; ci++) {
                var cfIn  = labelMap[activeMap[ci].trackIdx];
                var cfOut = ci === activeMap.length - 1 ? '[cfout]' : '[cf' + ci + ']';
                filters.push(cfChain + cfIn + 'acrossfade=d=' + cfg.crossfade + ':o=0' + cfOut);
                cfChain = cfOut;
            }
            crossfadeResultLabel = cfChain;
        }

        // Collect all audio labels for mixing
        var allAudioLabels = [];

        if (origMode === 'keep') {
            allAudioLabels.push('[0:a]');
        } else if (origMode === 'mute') {
            filters.push('[0:a]volume=0[origmuted]');
            allAudioLabels.push('[origmuted]');
        }

        if (crossfadeResultLabel) {
            allAudioLabels.push(crossfadeResultLabel);
        } else {
            activeMap.forEach(function (m) {
                allAudioLabels.push(labelMap[m.trackIdx]);
            });
        }

        // Mix or streams
        var finalAudioMaps = [];

        if (allAudioLabels.length === 0) {
            warnings.push('No audio sources configured — output will be silent');
            filters.push('aevalsrc=0:d=' + (targetDuration || 1) + '[silenceout]');
            finalAudioMaps = ['[silenceout]'];

        } else if (cfg.mode === 'streams') {
            // Each label becomes a separate -map
            finalAudioMaps = allAudioLabels.slice();

        } else {
            // mix mode
            var audioOut = cfg.normalize ? '[prenorm]' : '[mixout]';

            if (allAudioLabels.length === 1) {
                filters.push(allAudioLabels[0] + 'anull' + audioOut);
            } else {
                var amixDur = (cfg.duration === 'shortest') ? 'shortest' : 'longest';
                filters.push(
                    allAudioLabels.join('') +
                    'amix=inputs=' + allAudioLabels.length + ':normalize=0:duration=' + amixDur +
                    audioOut
                );
            }

            if (cfg.normalize) {
                filters.push('[prenorm]dynaudnorm[mixout]');
            }

            finalAudioMaps = ['[mixout]'];
        }

        // afterVideo video filter
        var videoFilters     = [];
        var videoMapLabel    = null; // null → use direct -map 0:v
        var needsVideoEncode = false;

        if (extraDuration > 0 && afterVideoCfg.mode) {
            needsVideoEncode = true;
            var aw  = videoInfo.width;
            var ah  = videoInfo.height;
            var ar  = Math.max(1, Math.round(videoInfo.fps)) || 30;
            var apf = videoInfo.pixFmt || 'yuv420p';

            switch (afterVideoCfg.mode) {
                case 'freeze':
                    videoFilters.push('[0:v]tpad=stop_mode=clone:stop_duration=' + extraDuration + '[vout]');
                    videoMapLabel = '[vout]';
                    break;

                case 'color': {
                    var color = (afterVideoCfg.color || 'black').replace(/[^a-zA-Z0-9#]/g, '');
                    videoFilters.push('[0:v]scale=' + aw + ':' + ah + '[v0bkup]');
                    videoFilters.push('color=c=' + color + ':s=' + aw + 'x' + ah + ':r=' + ar + ':d=' + extraDuration + '[colorsrc]');
                    videoFilters.push('[colorsrc]format=' + apf + '[colorfrm]');
                    videoFilters.push('[v0bkup][colorfrm]concat=n=2:v=1:a=0[vout]');
                    videoMapLabel = '[vout]';
                    break;
                }

                case 'image':
                    if (imageInputIdx > 0) {
                        videoFilters.push('[0:v]scale=' + aw + ':' + ah + '[v0bkup]');
                        videoFilters.push(
                            '[' + imageInputIdx + ':v]' +
                            'scale=' + aw + ':' + ah + ':force_original_aspect_ratio=decrease,' +
                            'pad=' + aw + ':' + ah + ':(ow-iw)/2:(oh-ih)/2:black,' +
                            'setsar=1,format=' + apf + ',' +
                            'loop=loop=-1:size=1,' +
                            'trim=duration=' + extraDuration + ',setpts=PTS-STARTPTS[imgfrm]'
                        );
                        videoFilters.push('[v0bkup][imgfrm]concat=n=2:v=1:a=0[vout]');
                        videoMapLabel = '[vout]';
                    } else {
                        warnings.push('afterVideo mode "image" requires uploading an "image" field — falling back to freeze');
                        videoFilters.push('[0:v]tpad=stop_mode=clone:stop_duration=' + extraDuration + '[vout]');
                        videoMapLabel = '[vout]';
                    }
                    break;

                default:
                    warnings.push('Unknown afterVideo mode "' + afterVideoCfg.mode + '"');
                    needsVideoEncode = false;
                    break;
            }
        }

        // Combine all filter parts
        var allFilterParts = videoFilters.concat(
            filters.filter(function (f) { return f && f.trim().length > 0; })
        );
        var filterComplex = allFilterParts.join(';');

        // Build output file path
        var outFile = uniqueFilename('/tmp/') + '-addaudio.mp4';

        // Build ffmpeg command
        var cmd = ffmpeg().renice(constants.defaultFFMPEGProcessPriority);

        cmd.input(videoPath);

        cfg.tracks.forEach(function (t, i) {
            if (t.mute || !trackPaths[i]) return;
            cmd.input(trackPaths[i]);
        });

        if (imageInputIdx > 0 && imagePath) {
            cmd.input(imagePath);
        }

        // Output options array
        var outOpts = [];

        if (filterComplex.length > 0) {
            outOpts.push('-filter_complex', filterComplex);
        }

        outOpts.push('-map', videoMapLabel || '0:v');

        finalAudioMaps.forEach(function (m) {
            outOpts.push('-map', m);
        });

        if (needsVideoEncode) {
            outOpts.push('-c:v libx264', '-crf 20', '-preset medium', '-pix_fmt yuv420p');
        } else {
            outOpts.push('-c:v copy');
        }

        outOpts.push('-c:a aac', '-b:a 192k');

        if (cfg.duration === 'video' && videoDuration > 0) {
            outOpts.push('-t ' + videoDuration);
        } else if (cfg.duration === 'shortest') {
            outOpts.push('-shortest');
        }

        outOpts.push('-threads 8');

        cmd.outputOptions(outOpts);

        var allInputPaths = getAllPaths();

        logger.debug(
            'addaudio filter_complex: ' + filterComplex
        );

        cmd
            .on('error', function (err) {
                logger.error('addaudio error: ' + err);
                cleanup(allInputPaths.concat([outFile]));
                res.writeHead(500, { 'Connection': 'close' });
                res.end(JSON.stringify({ error: String(err) }));
            })
            .on('end', function () {
                var elapsed   = ((Date.now() - startTime) / 1000).toFixed(2) + 's';
                var nActive   = activeMap.length;
                logger.info(
                    'addaudio done' +
                    ' mode=' + cfg.mode +
                    ' tracks=' + nActive +
                    ' original=' + origMode +
                    ' duration=' + cfg.duration +
                    ' normalize=' + cfg.normalize +
                    ' elapsed=' + elapsed
                );
                warnings.forEach(function (w) { logger.warn('addaudio: ' + w); });
                cleanup(allInputPaths);
                return utils.downloadFile(outFile, null, req, res, next);
            })
            .save(outFile);
    }
});

module.exports = router;
