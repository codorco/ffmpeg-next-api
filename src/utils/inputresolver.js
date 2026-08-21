'use strict';

// Resolves the 4 supported input sources (multipart file, base64, url, local file)
// into a local filesystem path that can be handed to fluent-ffmpeg. Kept separate
// from any single route so future endpoints can reuse the same input methods.

const fs             = require('fs');
const path           = require('path');
const http           = require('http');
const https          = require('https');
const uniqueFilename = require('unique-filename');

const constants = require('../constants.js');
const logger    = require('../utils/logger.js');

// ── Local file (mounted "uploads" volume) ──────────────────────────────────────

// Resolves a user-supplied relative path against constants.uploadsDir and refuses
// anything that escapes it (path traversal). Returns the absolute path or throws.
function resolveLocalFile(relPath) {
    if (!relPath || typeof relPath !== 'string') {
        throw new Error('localFile must be a non-empty string');
    }
    const base     = path.resolve(constants.uploadsDir);
    const resolved = path.resolve(base, relPath);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
        throw new Error('localFile must point inside the uploads directory');
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error(`localFile not found: ${relPath}`);
    }
    return resolved;
}

// ── Base64 ──────────────────────────────────────────────────────────────────────

// Accepts a raw base64 string or a data-URI ("data:video/mp4;base64,...."), decodes
// it to a new temp file, and calls back with (err, path). Rejects payloads larger
// than the configured file size limit before writing anything to disk.
function resolveBase64(data, cb) {
    if (!data || typeof data !== 'string') {
        return cb(new Error('base64 must be a non-empty string'));
    }
    const commaIdx = data.indexOf(',');
    const payload  = data.slice(0, 20).indexOf('data:') === 0 && commaIdx !== -1
        ? data.slice(commaIdx + 1)
        : data;

    let buffer;
    try {
        buffer = Buffer.from(payload, 'base64');
    } catch (e) {
        return cb(new Error('base64 could not be decoded: ' + e.message));
    }
    if (buffer.length === 0) {
        return cb(new Error('base64 decoded to an empty file'));
    }
    if (buffer.length > constants.fileSizeLimit) {
        return cb(new Error(`base64 payload exceeds max file size (${constants.fileSizeLimit} bytes)`));
    }

    const outPath = uniqueFilename('/tmp/') + '-base64-input';
    fs.writeFile(outPath, buffer, function (err) {
        if (err) return cb(err);
        cb(null, outPath);
    });
}

// ── URL ───────────────────────────────────────────────────────────────────────

// Downloads a remote http(s) URL to a temp file, enforcing the configured size
// limit and timeout, following a bounded number of redirects manually (no shell,
// no third-party HTTP client — built-in http/https only). Calls back (err, path).
function resolveUrl(urlString, cb) {
    let parsed;
    try {
        parsed = new URL(urlString);
    } catch (e) {
        return cb(new Error('url is not a valid URL'));
    }
    fetch(parsed, 0);

    function fetch(target, redirectCount) {
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            return cb(new Error('url must use http or https'));
        }

        const client   = target.protocol === 'https:' ? https : http;
        const outPath  = uniqueFilename('/tmp/') + '-url-input';
        let bytes      = 0;
        let settled    = false;
        let writeStream;

        const req = client.get(target, function (response) {
            const status = response.statusCode || 0;

            if (status >= 300 && status < 400 && response.headers.location) {
                response.resume();
                if (redirectCount >= constants.urlMaxRedirects) {
                    return fail(new Error('url exceeded maximum number of redirects'));
                }
                let nextTarget;
                try {
                    nextTarget = new URL(response.headers.location, target);
                } catch (e) {
                    return fail(new Error('url redirected to an invalid location'));
                }
                return fetch(nextTarget, redirectCount + 1);
            }

            if (status < 200 || status >= 300) {
                response.resume();
                return fail(new Error(`url returned HTTP ${status}`));
            }

            writeStream = fs.createWriteStream(outPath);

            response.on('data', function (chunk) {
                bytes += chunk.length;
                if (bytes > constants.fileSizeLimit) {
                    fail(new Error(`url content exceeds max file size (${constants.fileSizeLimit} bytes)`));
                    req.destroy();
                    response.destroy();
                }
            });

            response.pipe(writeStream);

            writeStream.on('finish', function () {
                if (!settled) {
                    settled = true;
                    cb(null, outPath);
                }
            });

            writeStream.on('error', fail);
        });

        req.setTimeout(constants.urlFetchTimeoutMs, function () {
            req.destroy(new Error(`url fetch timed out after ${constants.urlFetchTimeoutMs}ms`));
        });

        req.on('error', fail);

        function fail(err) {
            if (settled) return;
            settled = true;
            if (writeStream) writeStream.destroy();
            fs.unlink(outPath, function () {});
            logger.debug(`inputresolver: url fetch failed: ${err}`);
            cb(err);
        }
    }
}

module.exports = {
    resolveLocalFile,
    resolveBase64,
    resolveUrl,
};
