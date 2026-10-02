// Account + saved dashboards (Phase 1).
//
// Handles Supabase auth (email/password, magic link, Google) and the
// save/load/duplicate/delete UI for dashboards. Dashboard layouts are stored
// as versioned JSON (see window.LunarDashboard in app.js). Guests keep using
// the default dashboard from localStorage; trying to save prompts sign-in.
//
// app.js is a classic script; it hands us the layout get/apply API via
// window.LunarDashboard since this ES module can't share its closures.
import { getSupabase } from '/supabase-client.js';

const LD = window.LunarDashboard;
const ACTIVE_KEY = 'finapp.activeDashboardId';

// --- Element refs ---
const accountBtn = document.getElementById('account-btn');
const saveBtn = document.getElementById('save-dashboard-btn');
const dashboardsBtn = document.getElementById('dashboards-btn');
const dashboardNameEl = document.getElementById('dashboard-name');

const authOverlay = document.getElementById('auth-modal-overlay');
const authClose = document.getElementById('auth-modal-close');
const authTitle = document.getElementById('auth-modal-title');
const authMessage = document.getElementById('auth-message');
const googleBtn = document.getElementById('google-signin');
const authForm = document.getElementById('auth-form');
const authEmail = document.getElementById('auth-email');
const authPassword = document.getElementById('auth-password');
const authSubmit = document.getElementById('auth-submit');
const authSwitchText = document.getElementById('auth-switch-text');
const authSwitchBtn = document.getElementById('auth-switch-btn');
const authMagicBtn = document.getElementById('auth-magic-btn');

const dashOverlay = document.getElementById('dashboards-modal-overlay');
const dashClose = document.getElementById('dashboards-modal-close');
const newNameInput = document.getElementById('new-dashboard-name');
const saveCurrentBtn = document.getElementById('save-current-btn');
const dashMessage = document.getElementById('dashboards-message');
const dashList = document.getElementById('dashboards-list');

// --- State ---
let supabase = null;
let currentUser = null;
let currentToken = null;
let dashboards = [];
let activeId = localStorage.getItem(ACTIVE_KEY) || null;
let dirty = false;
let authMode = 'signin'; // 'signin' | 'signup'

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Published so app.js can gate charts/details behind sign-in and open the auth
// modal from its "Sign in" prompts. Dispatches 'lunar:auth-changed' only when
// the configured/signedIn state actually flips, so app.js isn't re-rendered on
// unrelated updateHeader() calls (e.g. after saving a dashboard).
window.LunarAuth = {
  configured: false,
  signedIn: false,
  token: null,
  requireSignIn: () => openAuthModal(),
  startCheckout: () => startCheckout(),
  openBillingPortal: () => openPortal(),
};
let lastAuthKey = null;
function broadcastAuth() {
  const configured = !!supabase;
  const signedIn = !!currentUser;
  window.LunarAuth = {
    configured,
    signedIn,
    token: currentToken,
    requireSignIn: openAuthModal,
    startCheckout,
    openBillingPortal: openPortal,
  };
  const key = `${configured}:${signedIn}`;
  if (key === lastAuthKey) return;
  lastAuthKey = key;
  window.dispatchEvent(new CustomEvent('lunar:auth-changed'));
  refreshFeatures();
}

// --- Entitlements / feature flags (what the server allows) ---
async function authedFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (currentToken) headers.Authorization = `Bearer ${currentToken}`;
  return fetch(url, { ...options, headers });
}

async function refreshFeatures() {
  try {
    const res = await authedFetch('/api/features');
    if (res.ok) window.LunarFeatures = await res.json();
  } catch {
    /* keep whatever we had */
  }
  window.dispatchEvent(new CustomEvent('lunar:features-changed'));
  updateHeader();
}

async function startCheckout() {
  if (!currentUser) { openAuthModal(); return; }
  try {
    const res = await authedFetch('/api/billing/checkout', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.url) throw new Error(body.error || 'Could not start checkout');
    window.location.href = body.url;
  } catch (err) {
    toast(err.message || 'Checkout failed', 'error');
  }
}

async function openPortal() {
  if (!currentUser) { openAuthModal(); return; }
  try {
    const res = await authedFetch('/api/billing/portal', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.url) throw new Error(body.error || 'Could not open billing portal');
    window.location.href = body.url;
  } catch (err) {
    toast(err.message || 'Could not open billing portal', 'error');
  }
}

function setActiveId(id) {
  activeId = id || null;
  if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
  else localStorage.removeItem(ACTIVE_KEY);
}

function activeDashboard() {
  return dashboards.find((d) => d.id === activeId) || null;
}

// --- Toast ---
let toastTimer = null;
function toast(text, kind = 'info') {
  let el = document.getElementById('lunar-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'lunar-toast';
    el.className = 'lunar-toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.dataset.kind = kind;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 3200);
}

// --- Modal helpers ---
function openModal(overlay) { overlay.hidden = false; }
function closeModal(overlay) { overlay.hidden = true; }

function showAuthMessage(text, kind = 'error') {
  if (!text) { authMessage.hidden = true; return; }
  authMessage.textContent = text;
  authMessage.dataset.kind = kind;
  authMessage.hidden = false;
}

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  authTitle.textContent = signup ? 'Create account' : 'Sign in';
  authSubmit.textContent = signup ? 'Create account' : 'Sign in';
  authSwitchText.textContent = signup ? 'Already have an account?' : "Don't have an account?";
  authSwitchBtn.textContent = signup ? 'Sign in' : 'Create one';
  authPassword.autocomplete = signup ? 'new-password' : 'current-password';
  showAuthMessage('');
}

function openAuthModal() {
  setAuthMode('signin');
  showAuthMessage('');
  openModal(authOverlay);
  authEmail.focus();
}

// --- Header UI ---
function updateHeader() {
  const configured = !!supabase;
  broadcastAuth();
  // No Supabase config -> hide all account controls, app stays guest-only.
  accountBtn.hidden = !configured;
  saveBtn.hidden = !configured;
  dashboardsBtn.hidden = !configured || !currentUser;

  if (!configured) return;

  if (currentUser) {
    const label = currentUser.email || 'Account';
    accountBtn.textContent = label;
    accountBtn.title = `Signed in as ${label}`;
  } else {
    accountBtn.textContent = 'Sign in';
    accountBtn.title = 'Sign in to save dashboards';
  }

  const active = activeDashboard();
  if (currentUser && active) {
    dashboardNameEl.hidden = false;
    dashboardNameEl.textContent = active.name + (dirty ? ' •' : '');
  } else {
    dashboardNameEl.hidden = true;
  }

  saveBtn.textContent = dirty && currentUser && active ? 'Save*' : 'Save';
}

// --- Account dropdown (signed-in menu) ---
let accountMenu = null;
function closeAccountMenu() {
  if (accountMenu) { accountMenu.remove(); accountMenu = null; }
}
function toggleAccountMenu() {
  if (accountMenu) { closeAccountMenu(); return; }
  accountMenu = document.createElement('div');
  accountMenu.className = 'account-menu';

  const feats = window.LunarFeatures || {};
  const premium = !!(feats.entitlement && feats.entitlement.premium);
  const billing = !!feats.billingEnabled;
  const planLabel = premium ? 'Premium' : 'Free';
  let billingItem = '';
  if (billing) {
    billingItem = premium
      ? '<button type="button" class="account-menu-item" data-action="portal">Manage billing</button>'
      : '<button type="button" class="account-menu-item account-menu-upgrade" data-action="upgrade">Upgrade to Premium ⭐</button>';
  }

  accountMenu.innerHTML = `
    <p class="account-menu-email">${escapeHtml(currentUser.email || 'Signed in')}</p>
    <p class="account-menu-plan">Plan: <span class="plan-badge ${premium ? 'premium' : ''}">${planLabel}</span></p>
    <button type="button" class="account-menu-item" data-action="dashboards">My dashboards</button>
    ${billingItem}
    <button type="button" class="account-menu-item" data-action="signout">Sign out</button>
  `;
  document.body.appendChild(accountMenu);
  const rect = accountBtn.getBoundingClientRect();
  accountMenu.style.top = `${rect.bottom + 6}px`;
  accountMenu.style.right = `${window.innerWidth - rect.right}px`;

  accountMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    closeAccountMenu();
    if (action === 'signout') signOut();
    else if (action === 'dashboards') openDashboardsModal();
    else if (action === 'upgrade') startCheckout();
    else if (action === 'portal') openPortal();
  });
}
document.addEventListener('click', (e) => {
  if (accountMenu && !accountMenu.contains(e.target) && e.target !== accountBtn) closeAccountMenu();
});

// --- Auth actions ---
async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
  toast('Signed out');
}

async function handleEmailSubmit(e) {
  e.preventDefault();
  if (!supabase) return;
  const email = authEmail.value.trim();
  const password = authPassword.value;
  if (!email || !password) return;
  authSubmit.disabled = true;
  showAuthMessage('');
  try {
    if (authMode === 'signup') {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
      showAuthMessage('Account created. Check your email to confirm, then sign in.', 'info');
      setAuthMode('signin');
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      closeModal(authOverlay);
    }
  } catch (err) {
    showAuthMessage(err.message || 'Something went wrong.');
  } finally {
    authSubmit.disabled = false;
  }
}

async function handleMagicLink() {
  if (!supabase) return;
  const email = authEmail.value.trim();
  if (!email) { showAuthMessage('Enter your email first.'); return; }
  authMagicBtn.disabled = true;
  try {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) throw error;
    showAuthMessage('Magic link sent — check your email.', 'info');
  } catch (err) {
    showAuthMessage(err.message || 'Could not send magic link.');
  } finally {
    authMagicBtn.disabled = false;
  }
}

async function handleGoogle() {
  if (!supabase) return;
  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (error) throw error;
  } catch (err) {
    showAuthMessage(err.message || 'Google sign-in failed.');
  }
}

// --- Dashboards data layer (RLS scopes every query to the current user) ---
async function fetchDashboards() {
  const { data, error } = await supabase
    .from('dashboards')
    .select('id, name, layout, created_at, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function createDashboard(name, layout) {
  const { data, error } = await supabase
    .from('dashboards')
    .insert({ user_id: currentUser.id, name, layout })
    .select('id, name, layout, created_at, updated_at')
    .single();
  if (error) throw error;
  return data;
}

async function updateDashboard(id, patch) {
  const { data, error } = await supabase
    .from('dashboards')
    .update(patch)
    .eq('id', id)
    .select('id, name, layout, created_at, updated_at')
    .single();
  if (error) throw error;
  return data;
}

async function removeDashboard(id) {
  const { error } = await supabase.from('dashboards').delete().eq('id', id);
  if (error) throw error;
}

// --- Dashboards UI ---
function showDashMessage(text) {
  if (!text) { dashMessage.hidden = true; return; }
  dashMessage.textContent = text;
  dashMessage.hidden = false;
}

function renderDashboardsList() {
  if (!dashboards.length) {
    dashList.innerHTML = '<li class="dashboards-empty muted small">No saved dashboards yet. Save your current layout to get started.</li>';
    return;
  }
  dashList.innerHTML = dashboards.map((d) => {
    const when = new Date(d.updated_at).toLocaleString();
    const isActive = d.id === activeId;
    return `
      <li class="dashboard-item${isActive ? ' active' : ''}" data-id="${escapeHtml(d.id)}">
        <div class="dashboard-item-main">
          <span class="dashboard-item-name">${escapeHtml(d.name)}</span>
          ${isActive ? '<span class="dashboard-item-badge">Active</span>' : ''}
          <span class="dashboard-item-meta muted small">Updated ${escapeHtml(when)}</span>
        </div>
        <div class="dashboard-item-actions">
          <button type="button" data-action="load" title="Load">Load</button>
          <button type="button" data-action="duplicate" title="Duplicate">Duplicate</button>
          <button type="button" data-action="rename" title="Rename">Rename</button>
          <button type="button" data-action="delete" class="danger" title="Delete">Delete</button>
        </div>
      </li>`;
  }).join('');
}

async function refreshDashboards() {
  try {
    dashboards = await fetchDashboards();
    renderDashboardsList();
    updateHeader();
  } catch (err) {
    showDashMessage(err.message || 'Could not load dashboards.');
  }
}

async function openDashboardsModal() {
  if (!currentUser) { openAuthModal(); return; }
  showDashMessage('');
  newNameInput.value = '';
  openModal(dashOverlay);
  await refreshDashboards();
}

async function saveCurrentAsNew() {
  const name = newNameInput.value.trim() || 'My Dashboard';
  try {
    const created = await createDashboard(name, LD.getLayout());
    dashboards.unshift(created);
    setActiveId(created.id);
    dirty = false;
    newNameInput.value = '';
    renderDashboardsList();
    updateHeader();
    toast(`Saved “${created.name}”`);
  } catch (err) {
    showDashMessage(err.message || 'Could not save dashboard.');
  }
}

async function loadDashboard(id) {
  const d = dashboards.find((x) => x.id === id);
  if (!d) return;
  LD.applyLayout(d.layout);
  setActiveId(id);
  dirty = false;
  renderDashboardsList();
  updateHeader();
  closeModal(dashOverlay);
  toast(`Loaded “${d.name}”`);
}

async function duplicateDashboard(id) {
  const d = dashboards.find((x) => x.id === id);
  if (!d) return;
  try {
    const copy = await createDashboard(`${d.name} (copy)`, d.layout);
    dashboards.unshift(copy);
    renderDashboardsList();
    toast(`Duplicated “${d.name}”`);
  } catch (err) {
    showDashMessage(err.message || 'Could not duplicate.');
  }
}

async function renameDashboard(id) {
  const d = dashboards.find((x) => x.id === id);
  if (!d) return;
  const name = prompt('Rename dashboard', d.name);
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    const updated = await updateDashboard(id, { name: trimmed });
    Object.assign(d, updated);
    renderDashboardsList();
    updateHeader();
  } catch (err) {
    showDashMessage(err.message || 'Could not rename.');
  }
}

async function deleteDashboard(id) {
  const d = dashboards.find((x) => x.id === id);
  if (!d) return;
  if (!confirm(`Delete “${d.name}”? This can't be undone.`)) return;
  try {
    await removeDashboard(id);
    dashboards = dashboards.filter((x) => x.id !== id);
    if (activeId === id) { setActiveId(null); dirty = false; }
    renderDashboardsList();
    updateHeader();
    toast(`Deleted “${d.name}”`);
  } catch (err) {
    showDashMessage(err.message || 'Could not delete.');
  }
}

// Save button in the header: update the active dashboard, or save-as when none.
async function handleSaveClick() {
  if (!currentUser) { openAuthModal(); return; } // guests must sign in to save
  const active = activeDashboard();
  if (!active) { openDashboardsModal(); return; }
  try {
    const updated = await updateDashboard(active.id, { name: active.name, layout: LD.getLayout() });
    Object.assign(active, updated);
    dirty = false;
    updateHeader();
    toast(`Saved “${active.name}”`);
  } catch (err) {
    toast(err.message || 'Could not save.', 'error');
  }
}

dashList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  const action = btn.dataset.action;
  if (action === 'load') loadDashboard(id);
  else if (action === 'duplicate') duplicateDashboard(id);
  else if (action === 'rename') renameDashboard(id);
  else if (action === 'delete') deleteDashboard(id);
});

// --- Wire up static handlers ---
accountBtn.addEventListener('click', () => {
  if (currentUser) toggleAccountMenu();
  else openAuthModal();
});
saveBtn.addEventListener('click', handleSaveClick);
dashboardsBtn.addEventListener('click', openDashboardsModal);

authClose.addEventListener('click', () => closeModal(authOverlay));
authOverlay.addEventListener('click', (e) => { if (e.target === authOverlay) closeModal(authOverlay); });
authForm.addEventListener('submit', handleEmailSubmit);
authSwitchBtn.addEventListener('click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));
authMagicBtn.addEventListener('click', handleMagicLink);
googleBtn.addEventListener('click', handleGoogle);

dashClose.addEventListener('click', () => closeModal(dashOverlay));
dashOverlay.addEventListener('click', (e) => { if (e.target === dashOverlay) closeModal(dashOverlay); });
saveCurrentBtn.addEventListener('click', saveCurrentAsNew);
newNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveCurrentAsNew(); });

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeModal(authOverlay);
  closeModal(dashOverlay);
  closeAccountMenu();
});

// Editing watchlists/settings after loading a dashboard marks it dirty.
window.addEventListener('lunar:layout-changed', () => {
  if (currentUser && activeDashboard()) { dirty = true; updateHeader(); }
});

// --- Auth state / bootstrap ---
async function onSignedIn() {
  await refreshDashboards();
  // Restore the last-used dashboard on this device, if it still exists.
  const active = activeDashboard();
  if (active) {
    LD.applyLayout(active.layout);
    dirty = false;
  }
  updateHeader();
}

async function init() {
  supabase = await getSupabase();
  updateHeader();
  if (!supabase) {
    refreshFeatures(); // guests still need the feature map for upgrade prompts
    return;
  }

  const { data: { session } } = await supabase.auth.getSession();
  currentUser = session?.user || null;
  currentToken = session?.access_token || null;
  if (currentUser) await onSignedIn();
  else updateHeader();

  // Returning from Stripe Checkout: entitlement updates arrive via webhook, so
  // re-pull features a couple of times to catch the just-activated subscription.
  const params = new URLSearchParams(window.location.search);
  if (params.get('checkout') === 'success') {
    toast('Thanks for subscribing! Unlocking Premium…');
    setTimeout(refreshFeatures, 1500);
    setTimeout(refreshFeatures, 4500);
  }
  if (params.has('checkout')) {
    params.delete('checkout');
    const qs = params.toString();
    history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
  }

  supabase.auth.onAuthStateChange((event, session) => {
    const prevId = currentUser?.id || null;
    currentUser = session?.user || null;
    currentToken = session?.access_token || null;
    closeAccountMenu();
    if (currentUser && currentUser.id !== prevId) {
      closeModal(authOverlay);
      onSignedIn();
    } else if (!currentUser) {
      dashboards = [];
      setActiveId(null);
      dirty = false;
      dashboardNameEl.hidden = true;
      window.LunarFeatures = null;
    }
    updateHeader();
  });
}

init();
