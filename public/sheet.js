// Vaul-style bottom-sheet behavior in vanilla JS (vaul itself is React-only and
// this app has no bundler). Adds swipe-down-to-dismiss to any `.modal-overlay`
// whose panel has the `.sheet` class — used for the chart detail view, auth, and
// dashboards sheets. Drag starts from the grab handle, or from the content when
// it's already scrolled to the top (matching vaul). Only active in bottom-sheet
// (mobile) layout; desktop keeps centered dialogs.
(function () {
  var DISMISS_PX = 110;      // drag distance that triggers dismiss
  var DISMISS_VELOCITY = 0.6; // px/ms flick velocity that triggers dismiss
  var isMobile = function () { return window.matchMedia('(max-width: 768px)').matches; };

  function setup(overlay) {
    var sheet = overlay.querySelector('.modal.sheet');
    if (!sheet) return;
    var scroller = function () { return sheet.querySelector('.sheet-scroll') || sheet; };

    var dragging = false, startY = 0, dy = 0, lastY = 0, lastT = 0, vy = 0;

    function onDown(e) {
      if (overlay.hidden || !isMobile() || e.button === 1 || e.button === 2) return;
      var fromHandle = !!e.target.closest('.sheet-handle');
      var sc = scroller();
      // From content: only when scrolled to the very top (so normal scroll still works).
      if (!fromHandle && sc && sc.scrollTop > 0) return;
      // Don't hijack drags that start on interactive controls (unless the handle).
      if (!fromHandle && e.target.closest('button, a, input, textarea, select, canvas')) return;
      dragging = true; dy = 0; startY = lastY = e.clientY; lastT = e.timeStamp; vy = 0;
      sheet.style.transition = 'none';
      try { sheet.setPointerCapture(e.pointerId); } catch (_) {}
    }

    function onMove(e) {
      if (!dragging) return;
      var delta = e.clientY - startY;
      if (delta <= 0) { // pulling up — snap back to rest, no drag
        dy = 0; sheet.style.transform = ''; overlay.style.removeProperty('--sheet-progress');
        return;
      }
      var now = e.timeStamp;
      vy = (e.clientY - lastY) / Math.max(1, now - lastT);
      lastY = e.clientY; lastT = now;
      dy = delta;
      sheet.style.transform = 'translateY(' + dy + 'px)';
      var h = sheet.offsetHeight || 600;
      overlay.style.setProperty('--sheet-progress', String(Math.max(0, 1 - dy / h)));
      if (e.cancelable) e.preventDefault();
    }

    function settle() {
      dragging = false;
      if (dy > DISMISS_PX || vy > DISMISS_VELOCITY) { dismiss(); return; }
      sheet.style.transition = '';
      sheet.style.transform = '';
      overlay.style.removeProperty('--sheet-progress');
    }

    function dismiss() {
      if (window.LunarHaptics) window.LunarHaptics.impact('LIGHT');
      sheet.style.transition = 'transform 0.2s ease';
      sheet.style.transform = 'translateY(100%)';
      var closer = overlay.querySelector('.modal-close');
      setTimeout(function () {
        if (closer) closer.click(); else overlay.hidden = true;
        sheet.style.transition = '';
        sheet.style.transform = '';
        overlay.style.removeProperty('--sheet-progress');
      }, 190);
    }

    sheet.addEventListener('pointerdown', onDown);
    sheet.addEventListener('pointermove', onMove);
    sheet.addEventListener('pointerup', settle);
    sheet.addEventListener('pointercancel', settle);
  }

  document.querySelectorAll('.modal-overlay').forEach(setup);
})();
