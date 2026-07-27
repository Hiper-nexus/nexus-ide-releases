// Keep the upstream 5.x named-export contract for modern minimatch consumers.
import upstream from './upstream/dist/commonjs/index.js';

export const EXPANSION_MAX = upstream.EXPANSION_MAX;
export const EXPANSION_MAX_LENGTH = upstream.EXPANSION_MAX_LENGTH;
export const expand = upstream.expand;
export default upstream.expand;
