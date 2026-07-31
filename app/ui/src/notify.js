// Desktop and Android notifications, via the Tauri notification plugin.
//
// Called through `invoke` rather than the plugin's JS package so the UI keeps
// no build-time dependency on it — the commands are stable and this is three
// of them.

const invoke = () => window.__TAURI__?.core?.invoke ?? null;

let permission = 'unknown'; // 'granted' | 'denied' | 'unknown'

/** True once the platform will actually show a notification. */
export function canNotify() {
  return permission === 'granted';
}

/**
 * Ask for permission if we do not already have it.
 *
 * Deliberately called after the first successful connection rather than at
 * launch: a permission prompt before someone has even joined a server is a
 * prompt with no context, and gets denied.
 */
export async function ensurePermission() {
  const inv = invoke();
  if (!inv) return false;
  try {
    const granted = await inv('plugin:notification|is_permission_granted');
    if (granted === true) {
      permission = 'granted';
      return true;
    }
    if (granted === false) {
      permission = 'denied';
      return false;
    }
    // null means "not asked yet".
    const state = await inv('plugin:notification|request_permission');
    permission = state === 'granted' ? 'granted' : 'denied';
    return permission === 'granted';
  } catch {
    permission = 'denied';
    return false;
  }
}

/** Show one notification. Silently does nothing when unavailable. */
export async function notify(title, body) {
  const inv = invoke();
  if (!inv || permission !== 'granted') return;
  try {
    await inv('plugin:notification|notify', { options: { title, body } });
  } catch {
    // A failed notification must never interrupt the chat.
  }
}
