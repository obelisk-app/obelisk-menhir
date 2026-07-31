// Modal, confirmation and toast plumbing.
//
// Every panel in the app is a `.modal` overlay holding one `.modal-card`. This
// module is what makes them behave like dialogs rather than divs: Escape and a
// click on the backdrop close the topmost one, focus goes into the panel and
// comes back out to whatever opened it, and a panel can register cleanup that
// runs however it was closed — which is how the host poll stops when the host
// panel goes away, whether it was closed with the button, the backdrop or Esc.
//
// `confirmAsk` exists because `window.confirm` cannot be relied on inside an
// app webview: on some platforms it never draws and returns false immediately,
// which turns "Revoke all invites" into a button that silently does nothing.
// An in-app dialog also lets a destructive action look destructive.

const $ = (id) => document.getElementById(id);

/** Open modals, innermost last. */
const stack = [];

/** id -> function to run when it closes. */
const onCloseHooks = new Map();

/**
 * Register cleanup for a panel, replacing any previous registration.
 * Runs exactly once, whichever way the panel is closed.
 */
export function onModalClose(id, fn) {
  onCloseHooks.set(id, fn);
}

export function isModalOpen(id) {
  return stack.some((m) => m.id === id);
}

export function openModal(id, { focus } = {}) {
  const el = $(id);
  if (!el || isModalOpen(id)) return;
  stack.push({ id, returnFocus: document.activeElement });
  el.classList.remove('hidden');
  const target = focus ? $(focus) : el.querySelector('input, textarea, button.primary');
  // A phone popping the keyboard open the moment a panel appears hides half of
  // it; on a desktop, landing in the first field is exactly what you want.
  if (target && !isCoarsePointer()) target.focus();
}

export function closeModal(id) {
  const at = stack.findIndex((m) => m.id === id);
  if (at === -1) {
    $(id)?.classList.add('hidden'); // already closed, or never registered
    return;
  }
  const [entry] = stack.splice(at, 1);
  $(id)?.classList.add('hidden');
  const hook = onCloseHooks.get(id);
  if (hook) {
    onCloseHooks.delete(id);
    hook();
  }
  entry.returnFocus?.focus?.();
}

const isCoarsePointer = () => window.matchMedia?.('(pointer: coarse)').matches ?? false;

/**
 * Wire the behaviour every panel shares. Call once at boot.
 *
 * `data-close="<modal-id>"` on a button closes that panel; `beforeClose` lets
 * the app veto or divert a close (the QR scanner needs to stop the camera
 * first, and it hands that back through `closeModal`).
 */
export function wireModals(beforeClose = () => true) {
  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.onclick = () => {
      const id = btn.dataset.close;
      if (beforeClose(id) !== false) closeModal(id);
    };
  }

  for (const el of document.querySelectorAll('.modal')) {
    el.addEventListener('mousedown', (e) => {
      // Only a press that both starts and ends on the backdrop counts, so a
      // text selection dragged out of a field does not close the panel.
      if (e.target !== el) return;
      const up = (ev) => {
        el.removeEventListener('mouseup', up);
        if (ev.target === el && beforeClose(el.id) !== false) closeModal(el.id);
      };
      el.addEventListener('mouseup', up);
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !stack.length) return;
    const top = stack[stack.length - 1].id;
    e.preventDefault();
    if (beforeClose(top) !== false) closeModal(top);
  });
}

/**
 * Ask before doing something irreversible. Resolves true when confirmed.
 *
 * Deliberately not `window.confirm`: see the note at the top of this file.
 */
export function confirmAsk({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body || '';
    $('confirm-body').classList.toggle('hidden', !body);
    const go = $('confirm-go');
    go.textContent = confirmLabel;
    go.classList.toggle('danger-inline', danger);
    go.classList.toggle('primary', !danger);

    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      go.onclick = null;
      $('confirm-cancel').onclick = null;
      onCloseHooks.delete('confirm-modal');
      closeModal('confirm-modal');
      resolve(answer);
    };
    go.onclick = () => finish(true);
    $('confirm-cancel').onclick = () => finish(false);
    // Backdrop or Escape means "no".
    onModalClose('confirm-modal', () => { if (!settled) { settled = true; resolve(false); } });
    openModal('confirm-modal', { focus: 'confirm-cancel' });
  });
}

/**
 * A short-lived message in the corner.
 *
 * Feedback for an action whose result is otherwise invisible — a revoked
 * invite, a copied link — used instead of writing into a panel's error slot,
 * which on a long panel is often scrolled out of sight.
 */
export function toast(message, kind = 'info') {
  const stackEl = $('toast-stack');
  if (!stackEl) return;
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'error' ? ' error' : '');
  el.textContent = message;
  stackEl.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  }, kind === 'error' ? 5000 : 2600);
}

/** Show (or clear) an inline error paragraph. Returns false, to `return` from. */
export function showError(id, e) {
  const el = $(id);
  if (!el) return false;
  const text = String(e?.message || e || '');
  el.textContent = text;
  el.classList.toggle('hidden', !text);
  return false;
}
