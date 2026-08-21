'use strict';

// Shared "target output file size → bitrate" math. Used by any quality.mode
// that lets the caller specify a maximum file size (in megabytes) instead of a
// manual CRF/bitrate value — currently POST /convert/video and POST /convert/audio.

// Converts a target size (MB, decimal) and a duration (seconds) into the total
// bits/sec budget available for the output, after reserving `marginRatio` of
// it as headroom for container/muxing overhead (so the real file lands under,
// not over, the target).
function computeBudgetBps(targetMegabytes, durationSeconds, marginRatio) {
    const targetBytes = targetMegabytes * 1000000; // MB → bytes (decimal)
    return (targetBytes * 8 * marginRatio) / durationSeconds;
}

module.exports = { computeBudgetBps };
