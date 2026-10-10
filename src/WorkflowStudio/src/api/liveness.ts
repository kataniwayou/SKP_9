/** What a processor's image shows (spec §5.1): green and spinning, red and still, grey and blinking. */
export type Health = 'healthy' | 'unhealthy' | 'undetermined';

/** A processor's health by id; ids compare without case. */
export type HealthOf = (processorId: string) => Health;

/** No data: every processor is undetermined. The liveness store (live/liveState.ts) gives the verdicts. */
export const NO_VERDICT: HealthOf = () => 'undetermined';
