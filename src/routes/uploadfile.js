var express = require('express')
const fs = require('fs');
const Busboy = require('busboy');
const uniqueFilename = require('unique-filename');

var router = express.Router()
const logger = require('../utils/logger.js')
const utils = require('../utils/utils.js')

//route to handle file upload in all POST requests
//file is saved to res.locals.savedFile and can be used in subsequent routes.
router.use(function (req, res,next) {
    
    // Routes that manage their own multi-file upload bypass this middleware
    // req.path preserves the client's exact trailing slash (Express's non-strict
    // routing only affects route matching later on, not this raw value) — list
    // both forms for any route whose documented examples use a trailing slash.
    const multiFileRoutes = ['/image/to/images-to-video', '/subtitle/ass', '/video/add/audio', '/convert/video', '/convert/audio', '/convert/image', '/convert/image/'];
    if (req.method === 'POST' && multiFileRoutes.indexOf(req.path) !== -1) {
        return next();
    }

    if(req.method == "POST")
    {
        logger.debug(`${__filename} path: ${req.path}`);

        let bytes = 0;
        let hitLimit = false;
        let fileName = '';
        var savedFile = uniqueFilename('/tmp/');
        let busboy = new Busboy({
            headers: req.headers,
            limits: {
                fields: 0, //no non-files allowed
                files: 1,
                fileSize: fileSizeLimit,
        }});
        busboy.on('filesLimit', function() {
            logger.error(`upload file size limit hit. max file size ${fileSizeLimit} bytes.`)
        });
        busboy.on('fieldsLimit', function() {
            let msg="Non-file field detected. Only files can be POSTed.";
            logger.error(msg);
            let err = new Error(msg);
            err.statusCode = 400;
            next(err);
        });

        let writeStream = null;

        busboy.on('file', function(
            fieldname,
            file,
            filename,
            encoding,
            mimetype
        ) {
            file.on('limit', function(file) {
                hitLimit = true;
                let msg = `${filename} exceeds max size limit. max file size ${fileSizeLimit} bytes.`
                logger.error(msg);
                res.writeHead(500, {'Connection': 'close'});
                res.end(JSON.stringify({error: msg}));
                // Clean up the partial upload here, not in busboy's 'finish' handler:
                // the client's connection is torn down by 'Connection: close' above
                // before the (oversized) request body finishes draining, so 'finish'
                // never fires and the temp file would otherwise leak on every
                // rejected oversized upload.
                if (writeStream) writeStream.destroy();
                try { utils.deleteFile(savedFile); } catch (e) { /* best effort */ }
            });
            let log = {
                file: filename,
                encoding: encoding,
                mimetype: mimetype,
            };
            logger.debug(`file:${log.file}, encoding: ${log.encoding}, mimetype: ${log.mimetype}`);
            file.on('data', function(data) {
                bytes += data.length;
            });
            file.on('end', function(data) {
                log.bytes = bytes;
                logger.debug(`file: ${log.file}, encoding: ${log.encoding}, mimetype: ${log.mimetype}, bytes: ${log.bytes}`);
            });

            fileName = filename;
            savedFile = savedFile + "-" + fileName;
            logger.debug(`uploading ${fileName}`)
            writeStream = file.pipe(fs.createWriteStream(savedFile));
            if (writeStream) {
                logger.debug(`${fileName} saved, path: ${savedFile}`)
            }
        });
        busboy.on('finish', function() {
            if (hitLimit) {
                // Already cleaned up in the 'limit' handler above.
                return;
            }
            logger.debug(`upload complete. file: ${fileName}`)
            res.locals.savedFile = savedFile;
            next();
        });
        return req.pipe(busboy);
    }
    next();
});

module.exports = router;