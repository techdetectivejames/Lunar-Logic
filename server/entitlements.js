'use strict';

const { getAdmin } = require('./supabaseAdmin');

// Stripe subscription statuses that grant premium access.
const ACTIVE_STATUSES = new Set(['active', 'trialing']);

async function getEntitlement(userId) {
  const admin = getAdmin();
  if (!admin) return null;
  const { data, error } = await admin
    .from('entitlements')
    .select('user_id, plan, status, stripe_customer_id, stripe_subscription_id, current_period_end')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return null;
  // Default to a free/inactive shape when no row exists yet.
  return data || { user_id: userId, plan: 'free', status: 'inactive' };
}

function isPremiumActive(ent) {
  return !!ent && ent.plan === 'premium' && ACTIVE_STATUSES.has(ent.status);
}

async function upsertEntitlement(row) {
  const admin = getAdmin();
  if (!admin) throw new Error('Supabase admin not configured');
  const { error } = await admin.from('entitlements').upsert(row, { onConflict: 'user_id' });
  if (error) throw error;
}

async function findUserIdByCustomer(customerId) {
  const admin = getAdmin();
  if (!admin || !customerId) return null;
  const { data } = await admin
    .from('entitlements')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  return data ? data.user_id : null;
}

async function getCustomerId(userId) {
  const admin = getAdmin();
  if (!admin) return null;
  const { data } = await admin
    .from('entitlements')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .maybeSingle();
  return data ? data.stripe_customer_id : null;
}

module.exports = {
  ACTIVE_STATUSES,
  getEntitlement,
  isPremiumActive,
  upsertEntitlement,
  findUserIdByCustomer,
  getCustomerId,
};
