// Resolves the API origin for both web and native (Capacitor) builds.
//
// On the web the page is served by the same origin as the API, so API calls use
// relative URLs (base = ''). Inside the Capacitor native shell the web assets
// are bundled into the app, so relative "/api/..." would hit local files — those
// calls must target the deployed backend instead.
(function () {
  // TODO: set this to your deployed API origin (same place the web app is hosted).
  var NATIVE_API_ORIGIN = 'https://lunar-logic.vercel.app';

  var cap = window.Capacitor;
  var isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());

  window.LUNAR_IS_NATIVE = isNative;
  window.LUNAR_API_BASE = isNative ? NATIVE_API_ORIGIN : '';
  window.apiUrl = function (path) {
    if (/^https?:\/\//i.test(path)) return path; // already absolute (e.g. external APIs)
    return window.LUNAR_API_BASE + path;
  };
})();
