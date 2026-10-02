'use strict';

const Stripe = require('stripe');
const { getAdmin } = require('./supabaseAdmin');
const {
  upsertEntitlement,
  findUserIdByCustomer,
  getCustomerId,
} = require('./entitlements');

let stripe = null;

function getStripe() {
  if (stripe) return stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  stripe = new Stripe(key, { apiVersion: '2024-06-20' });
  return stripe;
}

function billingEnabled() {
  return !!getStripe() && !!process.env.STRIPE_PRICE_ID;
}

function appUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

// Reuse the user's existing Stripe customer, or create one and stash its id on
// the entitlement row so future checkouts/portal sessions map back to this user.
async function getOrCreateCustomer(user) {
  const s = getStripe();
  if (!s) throw new Error('Stripe not configured');

  const existing = await getCustomerId(user.id);
  if (existing) return existing;

  const customer = await s.customers.create({
    email: user.email || undefined,
    metadata: { supabase_user_id: user.id },
  });
  await upsertEntitlement({
    user_id: user.id,
    stripe_customer_id: customer.id,
    plan: 'free',
    status: 'inactive',
  });
  return customer.id;
}

async function createCheckoutSession(req, user) {
  const s = getStripe();
  const price = process.env.STRIPE_PRICE_ID;
  if (!s || !price) throw new Error('Stripe not configured');

  const customerId = await getOrCreateCustomer(user);
  const base = appUrl(req);
  const session = await s.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    allow_promotion_codes: true,
    client_reference_id: user.id,
    subscription_data: { metadata: { supabase_user_id: user.id } },
    success_url: `${base}/?checkout=success`,
    cancel_url: `${base}/?checkout=cancel`,
  });
  return session.url;
}

async function createPortalSession(req, user) {
  const s = getStripe();
  if (!s) throw new Error('Stripe not configured');

  const customerId = await getOrCreateCustomer(user);
  const session = await s.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${appUrl(req)}/`,
  });
  return session.url;
}

const ACTIVE_STATUSES = new Set(['active', 'trialing']);

// Persist a Stripe subscription's current state onto the matching entitlement row.
async function syncSubscription(sub) {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id;
  let userId = (sub.metadata && sub.metadata.supabase_user_id) || null;
  if (!userId) userId = await findUserIdByCustomer(customerId);
  if (!userId) return; // can't map this subscription to a user — ignore

  const status = sub.status;
  const plan = ACTIVE_STATUSES.has(status) ? 'premium' : 'free';
  await upsertEntitlement({
    user_id: userId,
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    plan,
    status,
    current_period_end: sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null,
  });
}

// Verifies the Stripe signature (throws on mismatch) and reconciles entitlements.
async function handleWebhook(rawBody, signature) {
  const s = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s || !secret) throw new Error('Stripe webhook not configured');
  if (!getAdmin()) throw new Error('Supabase admin not configured');

  const event = s.webhooks.constructEvent(rawBody, signature, secret);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.subscription) {
        const sub = await s.subscriptions.retrieve(session.subscription);
        if ((!sub.metadata || !sub.metadata.supabase_user_id) && session.client_reference_id) {
          sub.metadata = { ...(sub.metadata || {}), supabase_user_id: session.client_reference_id };
        }
        await syncSubscription(sub);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await syncSubscription(event.data.object);
      break;
    default:
      break;
  }
  return event.type;
}

module.exports = {
  getStripe,
  billingEnabled,
  createCheckoutSession,
  createPortalSession,
  handleWebhook,
};
