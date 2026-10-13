/**
 * Injectable "now" so the circuit breaker and verification cache can be driven
 * by simulated time in tests (and later, the demo clock) without a real sleep.
 * Runtime code always gets systemClock; tests pass a fake that they advance by hand.
 */

export type Clock = () => Date;

export const systemClock: Clock = () => new Date();
