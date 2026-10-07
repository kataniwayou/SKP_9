/** React Flow node ids (canvas/toFlow.ts), shared with the pure design core. */
export const SPHERE_NODE_ID = 'wf';
export const CACHE_NODE_PREFIX = 'cache:';
export const cacheNodeId = (id: string): string => `${CACHE_NODE_PREFIX}${id}`;
