# Mobile build & store submission

Lunar Logic ships to iOS and Android via [Capacitor](https://capacitorjs.com/),
wrapping the same web app in `public/`. In-app purchases use
[RevenueCat](https://www.revenuecat.com/) and sync to the same `entitlements`
table that Stripe (web) writes to, so a user's Premium status is shared across
web, iOS and Android.

## Architecture recap

- **Web**: served by the Express app; upgrades via **Stripe Checkout**.
- **iOS/Android**: Capacitor shell loading the bundled `public/` assets; API
  calls target the deployed backend (`public/env.js` → `NATIVE_API_ORIGIN`);
  upgrades via **RevenueCat** (Apple/Google IAP). Apple/Google **require** IAP
  for digital goods — Stripe Checkout is intentionally disabled in the app.
- Both providers post webhooks that update one `entitlements` row per user:
  - Stripe → `POST /api/stripe/webhook`
  - RevenueCat → `POST /api/revenuecat/webhook`

## One-time local setup

```bash
npm install
# set NATIVE_API_ORIGIN in public/env.js to your deployed API origin
npx cap add ios        # macOS + Xcode required
npx cap add android    # Android Studio required
npm run cap:sync
```

Then open the native projects:

```bash
npm run cap:ios        # opens Xcode
npm run cap:android    # opens Android Studio
```

### Env vars (server)

See `.env.example`. Mobile adds:

```
REVENUECAT_WEBHOOK_AUTH=        # shared secret you set on the RC webhook
REVENUECAT_IOS_KEY=             # public SDK key (appl_...)  -> sent to the app
REVENUECAT_ANDROID_KEY=         # public SDK key (goog_...)  -> sent to the app
REVENUECAT_ENTITLEMENT_ID=premium
```

Run `supabase/phase3-mobile.sql` in Supabase (adds `push_tokens` +
entitlement provider columns).

## RevenueCat setup

1. Create a RevenueCat project; add the App Store and Play Store apps.
2. Create a **Premium** entitlement and attach your subscription products
   (configured in App Store Connect / Google Play Console first).
3. Build an **Offering** with a package (the app buys `current.availablePackages[0]`).
4. Copy the **public SDK keys** into the server env (`REVENUECAT_IOS_KEY` /
   `REVENUECAT_ANDROID_KEY`). These are exposed to the app via `/api/config`.
5. Add a **webhook** → URL `https://<your-api>/api/revenuecat/webhook`, and set
   the Authorization header value to match `REVENUECAT_WEBHOOK_AUTH`.
6. The app calls `Purchases.logIn(<supabase user id>)`, so webhook
   `app_user_id` maps straight to our `entitlements.user_id`.

## Push notifications

- Plugin: `@capacitor/push-notifications`. The app requests permission,
  registers, and POSTs the device token to `/api/push/register` (stored in
  `push_tokens`, scoped by RLS).
- **iOS**: enable the Push Notifications + Background Modes capabilities in
  Xcode; upload an APNs key to your push provider (e.g. Firebase/your sender).
- **Android**: add `google-services.json` (Firebase) to the Android project.

## Deep links

- Custom scheme: `lunarlogic://` and/or Universal/App Links on your domain.
- Handled in `public/native.js` via `App.appUrlOpen`: `…?tab=news` (or
  `lunarlogic://tab/news`) switches tabs. Extend as needed.
- **iOS**: add the URL scheme + Associated Domains (`applinks:yourdomain`).
- **Android**: add an intent filter for the scheme/host in `AndroidManifest.xml`.

---

# Store submission checklist

### Accounts & data
- [ ] **Account deletion flow** — in-app (account menu → *Delete account* →
      `DELETE /api/account`, cascades all user data) **and** a public web URL that
      explains/initiates deletion (Apple & Google both require this).
- [ ] Sign-in works with at least email/password; if offering Google sign-in,
      Apple requires **Sign in with Apple** as an alternative on iOS.
- [ ] Confirm cascade deletes remove: profile, dashboards, entitlements, push tokens.

### Privacy policy & data disclosures
- [ ] **Privacy policy URL** (publicly hosted) linked in both stores and in-app.
- [ ] **Apple App Privacy** ("nutrition label") — declare data collected:
      email (account), identifiers (user id, device push token), purchases,
      usage/diagnostics; link each to purpose and whether it's linked to identity.
- [ ] **Google Play Data safety form** — mirror the same: data types collected,
      shared, encryption in transit, deletion request method.
- [ ] Disclose third parties that receive data: Supabase, Stripe, RevenueCat,
      Apple/Google, Finnhub/Yahoo (market data), and any push provider.
- [ ] Not financial advice disclaimer kept visible (already in the footer).

### In-app purchases / subscriptions
- [ ] Products created in **App Store Connect** and **Google Play Console** and
      attached to the RevenueCat Premium entitlement.
- [ ] Subscription details shown before purchase: price, billing period,
      auto-renew terms, and links to **Terms of Use (EULA)** + Privacy Policy.
- [ ] **Restore purchases** available (account menu → *Restore purchases*).
- [ ] No external purchase links/mentions inside the iOS app (Stripe hidden on native).
- [ ] "Manage subscription" routes to the OS store (implemented).

### Assets
- [ ] **App icon**: 1024×1024 (iOS), adaptive icon (Android). Generate platform
      sets with `@capacitor/assets` from a source icon (see `App Icons/`).
- [ ] **Splash screen** for both platforms.
- [ ] **Screenshots**: iPhone 6.7" & 6.5" (and iPad if supported); Android phone
      + 7"/10" tablet. Show prices, a chart, and the upgrade screen.
- [ ] App name, subtitle/short description, full description, keywords, category
      (Finance), support URL, marketing URL.
- [ ] Age rating questionnaire completed.

### Technical / review
- [ ] Bump version + build number for each submission.
- [ ] Test on a physical device: sign-in, purchase (sandbox), restore, push,
      deep link, account deletion.
- [ ] Apple **sandbox** IAP tested; Google **license testers** / internal track tested.
- [ ] Crash-free launch; no references to beta/test services in UI.
- [ ] Demo account credentials provided to reviewers (if sign-in is required to
      see gated content).
- [ ] Export compliance (encryption) answered — HTTPS only.
