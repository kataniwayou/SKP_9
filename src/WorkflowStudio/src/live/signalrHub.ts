import { HttpTransportType, HubConnectionBuilder, LogLevel } from '@microsoft/signalr';
import { retryDelay, type HubFactory } from './liveClient';

/** BaseApi's liveness hub, same origin like the API (nginx and vite pass `/api/` through, WebSocket upgrade included). */
export const LIVENESS_HUB_PATH = '/api/hubs/liveness';

/**
 * A SignalR connection to the liveness hub: WebSockets only, no negotiate round trip (one BaseApi, no sticky sessions
 * needed, and nothing but GETs and the socket leave the studio), automatic reconnect with backoff that never gives up.
 */
export const signalRHub = (url: string = LIVENESS_HUB_PATH): HubFactory => () => new HubConnectionBuilder()
  .withUrl(url, { transport: HttpTransportType.WebSockets, skipNegotiation: true })
  .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (context) => retryDelay(context.previousRetryCount) })
  .configureLogging(LogLevel.None)
  .build();
