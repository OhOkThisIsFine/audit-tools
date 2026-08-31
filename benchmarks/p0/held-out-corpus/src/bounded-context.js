// Intentional duplication: billing and identity have separate validation policy.
export function validateBilling(value){ return billingRules(value); }
export function validateIdentity(value){ return identityRules(value); }
