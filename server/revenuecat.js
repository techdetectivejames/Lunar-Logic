'use strict';

const { getAdmin } = require('./supabaseAdmin');
const { upsertEntitlement } = require('./entitlements');

// RevenueCat event types that mean the user currently has access.
const ACTIVE_EVENTS = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'UNCANCELLATION',
  'PRODUCT_CHANGE',
  'NON_RENEWING_PURCHASE',
  'SUBSCRIPTION_EXTENDED',
]);
// Types that revoke access immediately.
const INACTIVE_EVENTS = new Set([
  'EXPIRATION',
  'SUBSCRIPTION_PAUSED',
  'BILLING_ISSUE',
]);
// CANCELLATION = auto-renew turned off but still active until expiration, so we
// keep access and rely on EXPIRATION to revoke later.

function webhookConfigured() {
  return !!process.env.REVENUECAT_WEBHOOK_AUTH && !!getAdmin();
}

// RevenueCat authenticates webhooks with a static value in the Authorization
// header that you set when creating the webhook. Compare against our secret.
function verifyAuth(authHeader) {
  const expected = process.env.REVENUECAT_WEBHOOK_AUTH;
  if (!expected) return false;
  return authHeader === expected || authHeader === `Bearer ${expected}`;
}

// Decide the entitlement from an event. We treat the subscription as premium
// when the event grants access OR the entitlement hasn't expired yet.
function deriveState(event) {
  const type = event.type;
  const expMs = event.expiration_at_ms || null;
  const notExpired = expMs ? expMs > Date.now() : false;

  let active;
  if (ACTIVE_EVENTS.has(type)) active = true;
  else if (INACTIVE_EVENTS.has(type)) active = false;
  else if (type === 'CANCELLATION') active = notExpired; // still valid until period end
  else active = notExpired; // TRANSFER / TEST / unknown: fall back to expiry

  return {
    plan: active ? 'premium' : 'free',
    status: active ? 'active' : 'inactive',
    currentPeriodEnd: expMs ? new Date(expMs).toISOString() : null,
  };
}

async function handleWebhook(payload, authHeader) {
  if (!getAdmin()) throw new Error('Supabase admin not configured');
  if (!verifyAuth(authHeader)) {
    const err = new Error('Invalid webhook authorization');
    err.status = 401;
    throw err;
  }
  const event = payload && payload.event;
  if (!event) return 'ignored';

  // We configure RevenueCat so app_user_id === the Supabase user id (via
  // Purchases.logIn on the client). original_app_user_id is the fallback.
  const userId = event.app_user_id || event.original_app_user_id;
  if (!userId || userId.startsWith('$RCAnonymousID')) return 'no-user';

  const { plan, status, currentPeriodEnd } = deriveState(event);
  await upsertEntitlement({
    user_id: userId,
    provider: 'revenuecat',
    revenuecat_app_user_id: event.app_user_id || null,
    plan,
    status,
    current_period_end: currentPeriodEnd,
  });
  return event.type;
}

module.exports = { webhookConfigured, handleWebhook };
