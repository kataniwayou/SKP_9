import { connect } from 'node:net';

/**
 * A few Redis commands over the RealStack forward (localhost:6380, `SKP_REDIS_PORT`), for live.spec only: it writes and
 * stops the heartbeats of its own throwaway `e2e-` processor in the processors' own key format, never a real one's.
 * RESP by hand (a handful of lines; the studio has no Redis client and needs none).
 */
const PORT = Number(process.env.SKP_REDIS_PORT ?? 6380);
const HOST = process.env.SKP_REDIS_HOST ?? 'localhost';

function encode(args: string[]): string {
  return `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`;
}

/** Sends one command and resolves with the first reply line (enough for SET / SADD / EXPIRE / DEL / SREM). */
export function redis(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(PORT, HOST, () => socket.write(encode(args)));
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error(`redis ${args[0]}: timed out`)); });
    socket.once('data', (data) => {
      socket.end();
      const line = data.toString().split('\r\n')[0]!;
      if (line.startsWith('-')) reject(new Error(`redis ${args[0]}: ${line}`)); else resolve(line);
    });
    socket.once('error', reject);
  });
}

/** The processor's keys (Messaging.Contracts L2ProjectionKeys). */
const instances = (processorId: string) => `skp:proc:${processorId}:instances`;
const perInstance = (processorId: string, instanceId: string) => `skp:proc:${processorId}:${instanceId}`;

/** One heartbeat as ProcessorLivenessWriter writes it: the entry, the instance index, both with TTL 4 x interval. */
export async function beat(processorId: string, instanceId: string, interval = 1): Promise<void> {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(), interval, status: 'Healthy',
    summary: { inputSchema: 'SUCCESS', outputSchema: 'SUCCESS', configSchema: 'SUCCESS' },
  });
  const ttl = String(interval * 4);
  await redis('SET', perInstance(processorId, instanceId), entry, 'EX', ttl);
  await redis('SADD', instances(processorId), instanceId);
  await redis('EXPIRE', instances(processorId), ttl);
}

/** Removes what `beat` wrote. */
export async function forget(processorId: string, instanceId: string): Promise<void> {
  await redis('DEL', perInstance(processorId, instanceId));
  await redis('SREM', instances(processorId), instanceId);
}

/** Beats every 500 ms until the returned stop is called (which waits for the beat in flight). */
export function heartbeats(processorId: string, instanceId: string): () => Promise<void> {
  let on = true;
  const loop = (async () => {
    while (on) {
      await beat(processorId, instanceId);
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  return async () => { on = false; await loop; };
}
