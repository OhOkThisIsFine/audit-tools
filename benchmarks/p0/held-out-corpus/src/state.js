export function advanceAudit(state){ return {...state, phase: next(state.phase)}; }
export function advanceRemediation(state){ return {...state, phase: next(state.phase)}; }
function next(phase){ return phase === 'open' ? 'done' : phase; }
