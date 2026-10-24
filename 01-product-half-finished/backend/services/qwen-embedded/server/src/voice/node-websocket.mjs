// Pinned direct dependency (ws 8.21.3). Node's global WebSocket lacks the .on/.once/.terminate/headers ABI used by the core.
export { WebSocket } from 'ws'
