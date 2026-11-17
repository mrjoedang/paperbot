import { BASE, h, ic, toast, pendingWrites } from './dom.js';
const STORAGE = 'paperbot-refresh-state';
export function consumeRefreshState() {
  try {
    const state = JSON.parse(sessionStorage.getItem(STORAGE));
    sessionStorage.removeItem(STORAGE);
    return state && Date.now() - state.savedAt < 10 * 60_000 && state.path === location.pathname + location.search && state.hash === location.hash ? state : null;
  } catch { return null; }
}
export function setupAppUpdates({ getState, isBusy, restored }) {
  const current = document.querySelector('meta[name="app-version"]')?.content;
  let available = null, checking = null, refreshing = false, lastCheck = 0;
  const icon = h('span', { class:'update-icon', 'aria-hidden':'true' }, ic('redo',20));
  const title = h('strong', null, 'Update available');
  const refreshButton = h('button', { type:'button', onclick:refresh }, 'Refresh');
  const notice = h('aside', { class:'app-update', hidden:true, role:'status', 'aria-live':'polite' }, icon, title, refreshButton);
  document.body.append(notice);
  const badge = h('span', { class:'setting-value' });
  const setting = h('button', { type:'button', class:'icon-btn', id:'btn-refresh', onclick:refresh }, ic('redo',20), h('span',null,'Refresh app'), badge);
  document.querySelector('.settings-menu').append(setting);
  function show(label, success = false) {
    title.textContent = label; icon.replaceChildren(ic(success ? 'check' : 'redo',20));
    notice.hidden = false;
  }
  async function check(force = false) {
    if (checking) return checking;
    if (!navigator.onLine || (!force && Date.now() - lastCheck < 30_000)) return null;
    lastCheck = Date.now();
    checking = (async () => {
      const response = await fetch(BASE + 'version.json', { cache:'no-store', credentials:'same-origin', signal:AbortSignal.timeout(10_000), headers:{accept:'application/json'} });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Version unavailable');
      const data = await response.json();
      if (!/^[a-f0-9]{16}$/.test(data.version)) throw new Error('Invalid version');
      available = data.version !== current ? data.version : null;
      badge.textContent = available ? 'Update' : '';
      if (available && !refreshing) show('Update available');
      else if (!available && title.textContent === 'Update available') notice.hidden = true;
      return data.version;
    })();
    try { return await checking; } finally { checking = null; }
  }
  async function refresh() {
    if (refreshing) return;
    if (isBusy() || pendingWrites()) { show('Finish editing or saving, then refresh'); return; }
    if (!navigator.onLine) { show('You’re offline. Reconnect to refresh.'); return; }
    refreshing = true; refreshButton.disabled = true; setting.disabled = true;
    show('Refreshing…');
    try {
      const targetVersion = await check(true);
      // A save may have begun while checking connectivity/version.
      if (isBusy() || pendingWrites()) { show('Finish editing or saving, then refresh'); return; }
      const state = { ...getState(), savedAt:Date.now(), path:location.pathname + location.search, hash:location.hash, targetVersion };
      sessionStorage.setItem(STORAGE, JSON.stringify(state));
      window.paperbotBoot?.show();
      location.reload();
    } catch {
      show('Couldn’t refresh. Please try again.');
    } finally {
      refreshing = false; refreshButton.disabled = false; setting.disabled = false;
    }
  }
  const quietCheck = () => { if (!document.hidden) check().catch(() => {}); };
  document.addEventListener('visibilitychange', quietCheck);
  window.addEventListener('pageshow', quietCheck);
  window.addEventListener('online', quietCheck);
  setInterval(quietCheck, 5 * 60_000);
  quietCheck();
  let confirmed = false;
  return { onReady() {
    if (!restored || confirmed) return;
    confirmed = true;
    if (restored.targetVersion === current) toast('You’re up to date');
    else show('Update available');
  } };
}
