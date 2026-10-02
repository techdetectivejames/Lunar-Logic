// Haptic feedback — Capacitor Haptics on native, Vibration API on the mobile web,
// and a harmless no-op on desktop. Exposed as window.LunarHaptics.
(function () {
  function plugin() {
    var cap = window.Capacitor;
    return cap && cap.Plugins ? cap.Plugins.Haptics : null;
  }
  function vibrate(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
  }

  function impact(style) {
    var s = (style || 'MEDIUM').toUpperCase();
    var H = plugin();
    if (H && H.impact) { H.impact({ style: s }).catch(function () {}); return; }
    vibrate(s === 'LIGHT' ? 8 : s === 'HEAVY' ? 22 : 12);
  }
  function selection() {
    var H = plugin();
    if (H && H.impact) { H.impact({ style: 'LIGHT' }).catch(function () {}); return; }
    vibrate(6);
  }
  function notify(type) {
    var t = (type || 'SUCCESS').toUpperCase();
    var H = plugin();
    if (H && H.notification) { H.notification({ type: t }).catch(function () {}); return; }
    vibrate(t === 'ERROR' ? [20, 60, 20] : [10, 40, 10]);
  }

  window.LunarHaptics = {
    impact: impact,
    selection: selection,
    success: function () { notify('SUCCESS'); },
    error: function () { notify('ERROR'); },
  };

  // Light tap on every button press (capture phase so stopPropagation can't hide it).
  document.addEventListener('click', function (e) {
    if (e.target.closest('button, [role="button"], .tab-btn')) impact('LIGHT');
  }, true);
})();
