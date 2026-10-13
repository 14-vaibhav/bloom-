/** Forced-failure hook for the demo ("Break citation"): the next first-attempt answer gets one invented chunk id. */
let armed = 0;
export function armBreakCitation(times = 1): void { armed = times; }
export function disarmBreakCitation(): void { armed = 0; }
export function breakCitationArmed(): boolean { return armed > 0; }
export function consumeBreakCitation(): boolean {
  if (armed <= 0) return false;
  armed -= 1;
  return true;
}
