// Keep the upstream 5.x named-export contract for modern minimatch consumers.
import upstream from './upstream/dist/commonjs/index.js';

export const EXPANSION_MAX = upstream.EXPANSION_MAX;
export const EXPANSION_MAX_LENGTH = upstream.EXPANSION_MAX_LENGTH;
export const EXPANSION_MAX_DEPTH = upstream.EXPANSION_MAX_DEPTH;
export const EXPANSION_MAX_REWRITES = upstream.EXPANSION_MAX_REWRITES;
export const expand = upstream.expand;
export default upstream.expand;
