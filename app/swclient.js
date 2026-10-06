// Service-worker registration and the controlled-update flow.
let userAskedUpdate = false;

export function initSW({ onUpdateReady }) {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js', { scope: './' }).then((reg) => {
    const maybeReady = () => { if (reg.waiting && navigator.serviceWorker.controller) onUpdateReady(reg); };
    maybeReady();
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (nw) nw.addEventListener('statechange', () => { if (nw.state === 'installed') maybeReady(); });
    });
    const check = () => reg.update().catch(() => {});
    check();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    navigator.serviceWorker.ready.then((r) => { if (r.active) r.active.postMessage({ type: 'ENSURE_CACHE' }); });
  }).catch(() => {});
  // Reload only when the user asked for the update, never on the first install.
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (userAskedUpdate) location.reload(); });
}

export function applyUpdate(reg) {
  userAskedUpdate = true;
  if (reg && reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
}
