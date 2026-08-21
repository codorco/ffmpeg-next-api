var express = require('express')
const ffmpeg = require('fluent-ffmpeg');

const constants = require('../constants.js');
const logger = require('../utils/logger.js')
const utils = require('../utils/utils.js')

var router = express.Router()

// convert image to jpg
// (audio and video conversion now live in convertaudio.js / convertvideo.js)
router.post('/image/to/jpg', function (req, res,next) {

    let savedFile = res.locals.savedFile;
    let outputFile = savedFile + '-output.jpg';
    logger.debug(`begin conversion from ${savedFile} to ${outputFile}`)

    //ffmpeg processing... converting file...
    let ffmpegConvertCommand = ffmpeg(savedFile);
    ffmpegConvertCommand
            .renice(constants.defaultFFMPEGProcessPriority)
            .outputOptions(['-pix_fmt yuv422p'])
            .on('error', function(err) {
                logger.error(`${err}`);
                utils.deleteFile(savedFile);
                res.writeHead(500, {'Connection': 'close'});
                res.end(JSON.stringify({error: `${err}`}));
            })
            .on('end', function() {
                utils.deleteFile(savedFile);
                return utils.downloadFile(outputFile,null,req,res,next);
            })
            .save(outputFile);

});

module.exports = router
