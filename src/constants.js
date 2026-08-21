const path = require('path');

exports.fileSizeLimit = parseInt(process.env.FILE_SIZE_LIMIT_BYTES || "536870912"); //536870912 = 512MB
exports.defaultFFMPEGProcessPriority=10;
exports.serverPort = 3000;//port to listen, NOTE: if using Docker/Kubernetes this port may not be the one clients are using
exports.externalPort = process.env.EXTERNAL_PORT;//external port that server listens, set this if using for example docker container and binding port is other than 3000
exports.keepAllFiles = process.env.KEEP_ALL_FILES || "false"; //if true, do not delete any uploaded/generated files

//base directory for the "local file" input source (POST /convert/video). Mounted as a
//Docker volume so files can be shared with other containers (e.g. n8n) without uploading.
//Uses process.cwd() rather than __dirname: this app runs as a pkg-compiled single
//binary, where __dirname resolves inside pkg's virtual snapshot instead of the
//real Docker WORKDIR — process.cwd() reflects the real filesystem path.
exports.uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
//timeouts/limits for fetching a video from a remote URL (POST /convert/video source: "url")
exports.urlFetchTimeoutMs = parseInt(process.env.URL_FETCH_TIMEOUT_MS || "30000");
exports.urlMaxRedirects = parseInt(process.env.URL_MAX_REDIRECTS || "5");
