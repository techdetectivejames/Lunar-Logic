// Capacitor native bootstrap: RevenueCat in-app purchases, push notifications,
// and deep links. This is a NO-OP on the web.
//
// It talks to plugins through the Capacitor bridge (window.Capacitor.Plugins) so
// it works without a JS bundler. Install the matching plugins and run
// `npx cap sync` for the native builds. If you later add a bundler, you can swap
// these bridge calls for the official typed imports.
(function () {
  const cap = window.Capacitor;
  const isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  if (!isNative) { window.LunarNative = { isNative: false }; return; }

  const Plugins = cap.Plugins || {};
  const platform = cap.getPlatform ? cap.getPlatform() : 'ios';
  let rcConfigured = false;

  const getPurchases = () => Plugins.Purchases || Plugins.PurchasesPlugin || null;
  const uid = () => (window.LunarAuth && window.LunarAuth.userId) || null;
  const token = () => (window.LunarAuth && window.LunarAuth.token) || null;

  async function loadConfig() {
    try { return await (await fetch(window.apiUrl('/api/config'))).json(); }
    catch { return null; }
  }

  // --- RevenueCat (IAP) ---
  async function configureRevenueCat() {
    const P = getPurchases();
    if (!P || rcConfigured) return;
    const cfg = await loadConfig();
    const rc = cfg && cfg.revenuecat;
    const apiKey = rc && (platform === 'android' ? rc.android : rc.ios);
    if (!apiKey) return;
    try {
      await P.configure({ apiKey });
      rcConfigured = true;
      if (uid()) await P.logIn({ appUserID: uid() });
    } catch (e) { console.warn('[native] RevenueCat configure failed', e); }
  }

  async function purchasePremium() {
    if (!(window.LunarAuth && window.LunarAuth.signedIn)) { window.LunarAuth?.requireSignIn?.(); return; }
    const P = getPurchases();
    if (!P) { alert('In-app purchases are unavailable on this device.'); return; }
    try {
      await configureRevenueCat();
      if (uid()) await P.logIn({ appUserID: uid() });
      const offerings = await P.getOfferings();
      const current = offerings && (offerings.current || (offerings.all && offerings.all.default));
      const pkg = current && current.availablePackages && current.availablePackages[0];
      if (!pkg) throw new Error('No subscription offering is configured in RevenueCat.');
      await P.purchasePackage({ aPackage: pkg });
      // Entitlement is reconciled server-side via the RevenueCat webhook; re-pull.
      setTimeout(() => window.LunarAuth?.refreshFeatures?.(), 1500);
      setTimeout(() => window.LunarAuth?.refreshFeatures?.(), 5000);
    } catch (e) {
      if (!(e && (e.userCancelled || e.code === 'PURCHASE_CANCELLED'))) {
        alert('Purchase failed: ' + (e && e.message ? e.message : 'unknown error'));
      }
    }
  }

  async function restorePurchases() {
    const P = getPurchases();
    if (!P) return;
    try {
      await configureRevenueCat();
      await P.restorePurchases();
      setTimeout(() => window.LunarAuth?.refreshFeatures?.(), 1200);
    } catch (e) { console.warn('[native] restore failed', e); }
  }

  function manageSubscriptions() {
    // Subscriptions bought via IAP are managed by the OS store, not Stripe.
    const url = platform === 'android'
      ? 'https://play.google.com/store/account/subscriptions'
      : 'itms-apps://apps.apple.com/account/subscriptions';
    window.open(url, '_system');
  }

  // Keep the RevenueCat identity in sync with sign-in state.
  window.addEventListener('lunar:auth-changed', async () => {
    const P = getPurchases();
    if (!P) return;
    await configureRevenueCat();
    try { if (uid()) await P.logIn({ appUserID: uid() }); else await P.logOut(); }
    catch (e) { console.warn('[native] RevenueCat identity sync failed', e); }
  });

  // --- Push notifications ---
  async function initPush() {
    const Push = Plugins.PushNotifications;
    if (!Push) return;
    try {
      let perm = await Push.checkPermissions();
      if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await Push.requestPermissions();
      if (perm.receive !== 'granted') return;
      Push.addListener('registration', async (t) => {
        try {
          await fetch(window.apiUrl('/api/push/register'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token() ? { Authorization: 'Bearer ' + token() } : {}),
            },
            body: JSON.stringify({ token: t.value, platform }),
          });
        } catch (e) { console.warn('[native] push register failed', e); }
      });
      Push.addListener('registrationError', (e) => console.warn('[native] push reg error', e));
      await Push.register();
    } catch (e) { console.warn('[native] push init failed', e); }
  }
  // (Re)register the device token after the user signs in.
  window.addEventListener('lunar:auth-changed', () => { if (uid()) initPush(); });

  // --- Deep links ---
  function initDeepLinks() {
    const App = Plugins.App;
    if (!App) return;
    App.addListener('appUrlOpen', (data) => {
      try {
        const url = new URL(data.url);
        // lunarlogic://tab/<name>  or  https://<host>/?tab=<name>
        const tab = url.searchParams.get('tab') || (url.host === 'tab' ? url.pathname.replace(/^\//, '') : '');
        if (tab) document.querySelector(`.tab-btn[data-tab="${tab}"]`)?.click();
      } catch (e) { console.warn('[native] deep link parse failed', e); }
    });
  }

  window.LunarNative = { isNative: true, purchasePremium, restorePurchases, manageSubscriptions };

  configureRevenueCat();
  initPush();
  initDeepLinks();
})();
