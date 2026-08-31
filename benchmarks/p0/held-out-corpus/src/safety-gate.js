export function authorize(change, risk){ if (risk === 'high' && !change.reviewed) throw new Error('review required'); return true; }
