var express = require('express')
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const Busboy = require('busboy');
const uniqueFilename = require('unique-filename');

const constants = require('../constants.js');
const logger = require('../utils/logger.js')
const utils = require('../utils/utils.js')

var router = express.Router()

// POST /image/to/scroll-video
// Receives an image and creates a top-to-bottom scroll video.
//
// Query params (all optional):
//   velocidade  - scroll speed in pixels/second (default: 180)
//   crf         - quality 0-51, lower=better (default: 20)
//   largura     - output width in pixels (default: 1080)
//   altura      - output/screen height in pixels (default: 1920)
//   fps         - frames per second (default: 30)
router.post('/to/scroll-video', function (req, res, next) {
    let savedFile = res.locals.savedFile;
    let outputFile = savedFile + '-output.mp4';

    const velocidade = Math.max(1, parseInt(req.query.velocidade) || 180);
    const crf        = Math.min(51, Math.max(0, parseInt(req.query.crf) || 20));
    const largura    = Math.max(1, parseInt(req.query.largura) || 1080);
    const altura     = Math.max(1, parseInt(req.query.altura) || 1920);
    const fps        = Math.max(1, parseInt(req.query.fps) || 30);

    logger.debug(`scroll-video params: velocidade=${velocidade} crf=${crf} largura=${largura} altura=${altura} fps=${fps}`);

    ffmpeg.ffprobe(savedFile, function (err, metadata) {
        if (err) {
            logger.error(`ffprobe error: ${err}`);
            utils.deleteFile(savedFile);
            res.writeHead(500, {'Connection': 'close'});
            res.end(JSON.stringify({error: `${err}`}));
            return;
        }

        const stream = metadata.streams.find(s => s.codec_type === 'video');
        if (!stream) {
            utils.deleteFile(savedFile);
            res.writeHead(400, {'Connection': 'close'});
            res.end(JSON.stringify({error: 'No image/video stream found in uploaded file'}));
            return;
        }

        // Scale image to target width, then calculate scroll distance
        const alturaEscalada = Math.floor(stream.height * largura / stream.width);
        const percurso = Math.max(alturaEscalada - altura, 1);
        const duracao  = (percurso / velocidade).toFixed(3);

        logger.debug(`scroll-video: original=${stream.width}x${stream.height} scaled=${largura}x${alturaEscalada} percurso=${percurso}px duracao=${duracao}s`);

        // Scroll filter: scale to target width, then pan crop window from top to bottom
        const vf = `scale=${largura}:-1,crop=${largura}:${altura}:0:'(ih-${altura})*t/${duracao}'`;

        ffmpeg(savedFile)
            .renice(constants.defaultFFMPEGProcessPriority)
            .inputOptions(['-loop 1'])
            .outputOptions([
                `-vf ${vf}`,
                `-t ${duracao}`,
                `-r ${fps}`,
                '-c:v libx264',
                `-crf ${crf}`,
                '-pix_fmt yuv420p',
                '-threads 8',
            ])
            .on('error', function (err) {
                logger.error(`scroll-video error: ${err}`);
                utils.deleteFile(savedFile);
                res.writeHead(500, {'Connection': 'close'});
                res.end(JSON.stringify({error: `${err}`}));
            })
            .on('end', function () {
                utils.deleteFile(savedFile);
                return utils.downloadFile(outputFile, null, req, res, next);
            })
            .save(outputFile);
    });
});

// POST /image/to/images-to-video
// Receives multiple images and assembles a video where each image is displayed
// for an equal duration so the total matches totalDuration exactly.
//
// Query params:
//   totalDuration - total video length in seconds (required)
//   width         - output width in pixels (default: 1920)
//   height        - output height in pixels (default: 1080)
//   fps           - frames per second (default: 30)
//   crf           - quality 0-51, lower=better (default: 20)
//   scale         - cover | contain | stretch | fill  (default: contain)
//   transition    - true | false  — fade between images (default: false)
router.post('/to/images-to-video', function (req, res, next) {

    const totalDuration = parseFloat(req.query.totalDuration);
    // H.264 requires even pixel dimensions
    const width      = Math.max(2, Math.round((parseInt(req.query.width)  || 1920) / 2) * 2);
    const height     = Math.max(2, Math.round((parseInt(req.query.height) || 1080) / 2) * 2);
    const fps        = Math.max(1, parseInt(req.query.fps)  || 30);
    const crf        = Math.min(51, Math.max(0, parseInt(req.query.crf) || 20));
    const scaleMode  = (req.query.scale || 'contain').toLowerCase();
    const transition = req.query.transition === 'true';
    const TRANS_DUR  = 0.5; // fixed fade duration in seconds

    if (!totalDuration || isNaN(totalDuration) || totalDuration <= 0) {
        res.writeHead(400, {'Connection': 'close'});
        res.end(JSON.stringify({error: 'totalDuration must be a positive number (seconds)'}));
        return;
    }

    // --- multi-file upload (busboy 0.3.x API) ---
    let uploadedFiles = [];
    let pendingWrites = 0;
    let busboyDone   = false;

    let bb;
    try {
        bb = new Busboy({
            headers: req.headers,
            limits: { files: 50, fileSize: fileSizeLimit }
        });
    } catch (e) {
        res.writeHead(400, {'Connection': 'close'});
        res.end(JSON.stringify({error: 'Invalid multipart request'}));
        return;
    }

    bb.on('file', function (fieldname, file, filename) {
        pendingWrites++;
        const savePath = uniqueFilename('/tmp/') + '-' + path.basename(filename || 'img');
        const ws = fs.createWriteStream(savePath);

        file.on('limit', function () {
            logger.error(`${filename} exceeded size limit`);
        });

        file.pipe(ws);

        ws.on('finish', function () {
            uploadedFiles.push(savePath);
            pendingWrites--;
            if (busboyDone && pendingWrites === 0) buildVideo();
        });

        ws.on('error', function (err) {
            logger.error(`Write error for ${filename}: ${err}`);
            pendingWrites--;
            if (busboyDone && pendingWrites === 0) buildVideo();
        });
    });

    bb.on('finish', function () {
        busboyDone = true;
        if (pendingWrites === 0) buildVideo();
    });

    bb.on('error', function (err) {
        logger.error(`Busboy error: ${err}`);
        res.writeHead(500, {'Connection': 'close'});
        res.end(JSON.stringify({error: `Upload error: ${err}`}));
    });

    req.pipe(bb);

    // --- ffmpeg processing ---
    function buildVideo() {
        const N = uploadedFiles.length;

        if (N === 0) {
            res.writeHead(400, {'Connection': 'close'});
            res.end(JSON.stringify({error: 'No images were uploaded'}));
            return;
        }

        // Use transition only when there are at least 2 images and the
        // total duration is long enough so clip duration > fade duration.
        const useTransition = transition && N > 1 && totalDuration > TRANS_DUR;
        const clipDur = useTransition
            ? (totalDuration + (N - 1) * TRANS_DUR) / N
            : totalDuration / N;

        logger.debug(`images-to-video: N=${N} totalDuration=${totalDuration}s clipDur=${clipDur.toFixed(3)}s transition=${useTransition} scale=${scaleMode} ${width}x${height} fps=${fps} crf=${crf}`);

        const outputFile = uniqueFilename('/tmp/') + '-output.mp4';
        const filterParts = [];

        // Scale filter chain for each image input
        uploadedFiles.forEach(function (_, i) {
            filterParts.push(scaleFilter(i, scaleMode, width, height));
        });

        // Assemble clips: concat (no transition) or xfade chain
        let finalLabel;
        if (N === 1) {
            finalLabel = 'vs0';
        } else if (!useTransition) {
            const labels = uploadedFiles.map(function (_, i) { return `[vs${i}]`; }).join('');
            filterParts.push(`${labels}concat=n=${N}:v=1:a=0[outv]`);
            finalLabel = 'outv';
        } else {
            // xfade: for clip i (1-indexed), offset = i*(clipDur - TRANS_DUR)
            let prevLabel = 'vs0';
            for (let i = 1; i < N; i++) {
                const offset   = (i * (clipDur - TRANS_DUR)).toFixed(3);
                const outLabel = (i === N - 1) ? 'outv' : `xf${i}`;
                filterParts.push(`[${prevLabel}][vs${i}]xfade=transition=fade:duration=${TRANS_DUR}:offset=${offset}[${outLabel}]`);
                prevLabel = outLabel;
            }
            finalLabel = 'outv';
        }

        const filterComplex = filterParts.join(';');
        logger.debug(`filter_complex: ${filterComplex}`);

        const cmd = ffmpeg();
        cmd.renice(constants.defaultFFMPEGProcessPriority);

        // Each image loops for clipDur seconds
        uploadedFiles.forEach(function (imgPath) {
            cmd.input(imgPath).inputOptions(['-loop 1', `-t ${clipDur.toFixed(3)}`]);
        });

        cmd
            .outputOptions([
                '-filter_complex', filterComplex,
                '-map', `[${finalLabel}]`,
                `-r ${fps}`,
                '-c:v libx264',
                `-crf ${crf}`,
                '-pix_fmt yuv420p',
                '-threads 8',
            ])
            .on('error', function (err) {
                logger.error(`images-to-video error: ${err}`);
                uploadedFiles.forEach(function (f) { utils.deleteFile(f); });
                res.writeHead(500, {'Connection': 'close'});
                res.end(JSON.stringify({error: `${err}`}));
            })
            .on('end', function () {
                uploadedFiles.forEach(function (f) { utils.deleteFile(f); });
                return utils.downloadFile(outputFile, null, req, res, next);
            })
            .save(outputFile);
    }
});

// Returns the filter_complex chain string that scales image input [i:v] into [vsi]
function scaleFilter(i, mode, w, h) {
    switch (mode) {
        case 'stretch':
            return `[${i}:v]scale=${w}:${h},setsar=1,format=yuv420p[vs${i}]`;

        case 'cover':
            return `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,format=yuv420p[vs${i}]`;

        case 'fill':
            // Blurred cover as background, contained image centered on top
            return [
                `[${i}:v]split[a${i}][b${i}]`,
                `[a${i}]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=20[bg${i}]`,
                `[b${i}]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg${i}]`,
                `[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[vs${i}]`,
            ].join(';');

        case 'contain':
        default:
            return `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[vs${i}]`;
    }
}

module.exports = router
