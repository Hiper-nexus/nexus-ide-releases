'use strict';

// Keep legacy minimatch 3/5 consumers callable while delegating every
// expansion to the unmodified upstream 5.0.12 implementation.
const upstream = require('./upstream/dist/commonjs/index.js');

module.exports = upstream.expand;
module.exports.expand = upstream.expand;
module.exports.EXPANSION_MAX = upstream.EXPANSION_MAX;
module.exports.EXPANSION_MAX_LENGTH = upstream.EXPANSION_MAX_LENGTH;
module.exports.EXPANSION_MAX_DEPTH = upstream.EXPANSION_MAX_DEPTH;
module.exports.EXPANSION_MAX_REWRITES = upstream.EXPANSION_MAX_REWRITES;
