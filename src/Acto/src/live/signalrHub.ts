import { HttpTransportType, HubConnectionBuilder, LogLevel } from '@microsoft/signalr';
import { retryDelay, type HubFactory } from './liveClient';

/** BaseApi's liveness hub, same origin like the API (nginx and vite pass `/api/` through, WebSocket upgrade included). */
export const LIVENESS_HUB_PATH = '/api/hubs/liveness';

/** The keep-alive period on both sides (BaseApi's KeepAliveInterval is the same 15 s). */
const SERVER_PING_MS = 15_000;

/**
 * A SignalR connection to the liveness hub: WebSockets only, no negotiate round trip (one BaseApi, no sticky sessions
 * needed, and nothing but GETs and the socket leave the studio), automatic reconnect with backoff that never gives up.
 * Keep-alive: a ping every 15 s; the server is given up after 60 s of silence (BaseApi pings every 15 s and waits
 * 3 min for the client, so a background tab whose timers Chrome throttles to once a minute stays connected).
 */
export const signalRHub = (url: string = LIVENESS_HUB_PATH): HubFactory => () => new HubConnectionBuilder()
  .withUrl(url, { transport: HttpTransportType.WebSockets, skipNegotiation: true })
  .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (context) => retryDelay(context.previousRetryCount) })
  .withKeepAliveInterval(SERVER_PING_MS)
  .withServerTimeout(4 * SERVER_PING_MS)
  .configureLogging(LogLevel.None)
  .build();
