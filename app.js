'use strict';

// ---------- Settings ----------
const CLIENT_ID = (window.CONFIG || {}).clientId || '';
// The page's own address is the redirect address, so local testing and GitHub Pages both work.
const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');
const SCOPES = [
  'playlist-read-private', 'playlist-read-collaborative',
  'playlist-modify-private', 'playlist-modify-public',
  'user-read-playback-state', 'user-modify-playback-state',
].join(' ');
const API = 'https://api.spotify.com/v1';
const $ = s => document.querySelector(s);

// ---------- Login (Authorization Code + PKCE, tokens stay in this browser) ----------
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function login() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  localStorage.setItem('pkce_verifier', verifier);
  localStorage.setItem('pkce_state', state);
  location.assign('https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT_URI, scope: SCOPES,
    state, code_challenge_method: 'S256', code_challenge: challenge,
  }));
}

async function tokenRequest(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error_description || j.error || 'Login failed'), { status: r.status });
  localStorage.setItem('access_token', j.access_token);
  localStorage.setItem('expires_at', Date.now() + j.expires_in * 1000);
  if (j.refresh_token) localStorage.setItem('refresh_token', j.refresh_token);
}

async function handleCallback() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return;
  history.replaceState(null, '', REDIRECT_URI); // drop the one-time code from the address bar
  const state = localStorage.getItem('pkce_state');
  const verifier = localStorage.getItem('pkce_verifier');
  localStorage.removeItem('pkce_state');
  localStorage.removeItem('pkce_verifier');
  if (q.has('error')) throw new Error('Spotify login was cancelled (' + q.get('error') + ').');
  if (!state || q.get('state') !== state) throw new Error('Login check failed. Please try again.');
  await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: REDIRECT_URI, code_verifier: verifier });
}

const loggedIn = () => !!localStorage.getItem('refresh_token');
let refreshing = null;

async function getToken() {
  if (Date.now() < +localStorage.getItem('expires_at') - 60000) return localStorage.getItem('access_token');
  if (!loggedIn()) { showLogin(); throw new Error('Please log in.'); }
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: localStorage.getItem('refresh_token') })
    .finally(() => { refreshing = null; });
  try {
    await refreshing;
  } catch (e) {
    // 400 = Spotify rejected the saved login; anything else (e.g. offline) keeps it for a retry
    if (e.status === 400) { logout('Your login expired. Please log in again.'); }
    throw e;
  }
  return localStorage.getItem('access_token');
}

function logout(msg) {
  ['access_token', 'refresh_token', 'expires_at'].forEach(k => localStorage.removeItem(k));
  showLogin(msg);
}

// ---------- Spotify Web API ----------
async function api(path, { method = 'GET', body } = {}, retried = false) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + await getToken(), ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  if (r.status === 401 && !retried) {
    localStorage.removeItem('expires_at');
    return api(path, { method, body }, true);
  }
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch { /* some player calls answer with plain text */ }
  if (!r.ok) {
    throw Object.assign(new Error(j?.error?.message || `Spotify error ${r.status}`), { status: r.status, reason: j?.error?.reason });
  }
  return j;
}

let mePromise = null;
const getMe = () => mePromise ??= api('/me').catch(e => { mePromise = null; throw e; });
const canEdit = (p, me) => p.owner?.id === me.id || p.collaborative;

// ---------- Small DOM helpers (text is always set as text, never as HTML) ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter(k => k != null && k !== false));
  return el;
}

const names = list => (list || []).filter(Boolean).map(a => a.name).join(', ');

function thumb(images) {
  const url = images?.at(-1)?.url; // Spotify lists images largest first
  return url ? h('img', { src: url, alt: '', loading: 'lazy' }) : h('span', { className: 'noimg' });
}

function row(images, title, sub, onclick, ...extra) {
  return h('li', { className: 'row' },
    images !== false && thumb(images),
    h('button', { className: 'main', onclick }, h('b', {}, title), h('small', {}, sub || '')),
    ...extra);
}

const playButton = (label, onclick) =>
  h('button', { className: 'icon playbtn', 'aria-label': label, onclick }, h('span', { className: 'tri' }));

function trackRow(t, onPlay) {
  if (!t) return h('li', { className: 'row' }, h('span', { className: 'noimg' }), h('span', { className: 'main note' }, 'Song no longer available'));
  const li = row(t.album?.images ?? t.images, t.name, names(t.artists ?? [t.show]), () => onPlay(li));
  li.dataset.uri = t.uri;
  if (t.type === 'track' && !t.is_local) {
    li.append(h('button', { className: 'icon add', 'aria-label': 'Add to a playlist', onclick: e => addSong(t, e.currentTarget) }, '+'));
  }
  return li;
}

let toastTimer;
function toast(msg, bad = false, ms = bad ? 5000 : 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

window.addEventListener('unhandledrejection', e => {
  e.preventDefault();
  const err = e.reason || {};
  if (err.status === 429) return toast('Spotify says too many requests. Wait a minute and try again.', true);
  if (err.status === 403) return toast('Spotify refused: ' + err.message, true);
  toast(err.message === 'Load failed' || err.message === 'Failed to fetch' ? 'Could not reach Spotify. Check your connection.' : err.message || String(err), true);
});

// Loads a list page by page. The offset is the number of rows already shown, so it stays right after removals.
async function pager(list, url, render, { pick = j => j, max = Infinity } = {}) {
  const more = h('button', { className: 'wide' }, 'Load more');
  const load = async () => {
    more.remove();
    let page;
    try {
      page = pick(await api(`${url}&offset=${list.children.length}`));
    } catch (e) {
      list.after(more);
      throw e;
    }
    page.items.forEach(it => list.append(render(it)));
    if (!page.total) list.after(h('p', { className: 'note' }, 'Nothing here.'));
    else if (page.next && list.children.length <= max) list.after(more);
  };
  more.onclick = load;
  return load();
}

// ---------- Pop-up panel from the bottom (devices, add to playlist) ----------
const sheet = $('#sheet');
let sheetBuild = null;

function openSheet(title, build) {
  sheetBuild = build;
  $('#sheet-title').textContent = title;
  const body = h('div');
  $('#sheet-body').replaceChildren(body);
  if (!sheet.open) sheet.showModal();
  return build(body);
}
sheet.addEventListener('click', e => { if (e.target === sheet) sheet.close(); }); // tap outside closes
$('#sheet-close').onclick = () => sheet.close();

// ---------- Screens (a simple stack, so Back keeps scroll position) ----------
const main = $('#view');
const stack = [];

function showHeader() {
  const top = stack.at(-1);
  $('#title').textContent = top.title;
  $('#back').hidden = stack.length < 2;
  $('#settings').hidden = stack.length > 1;
}

function push(title, build, reload = false) {
  const top = stack.at(-1);
  if (top) { top.y = scrollY; top.el.hidden = true; }
  const el = h('section');
  stack.push({ title, build, el, reload });
  main.append(el);
  showHeader();
  scrollTo(0, 0);
  return build(el);
}

function back() {
  stack.pop().el.remove();
  const top = stack.at(-1);
  top.el.hidden = false;
  showHeader();
  if (top.stale) {
    top.stale = false;
    top.el.replaceChildren();
    top.build(top.el);
  } else {
    scrollTo(0, top.y);
  }
}

// After an edit, playlist screens underneath reload when you go back to them.
const changed = () => {
  lastWrite = Date.now(); // our own playlist edits can shift the play queue
  stack.slice(0, -1).forEach(v => { v.stale = v.reload; });
};

const tabs = {
  playlists: ['Playlists', playlistsView, true],
  search: ['Search', searchView],
};

function openTab(name) {
  if (name !== 'search') setAddTarget(null);
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  stack.splice(0).forEach(v => v.el.remove());
  return push(...tabs[name]);
}

// ---------- Adding songs ----------
let addTarget = null; // set by a playlist's "Add songs": then + adds straight to it

function setAddTarget(p) {
  addTarget = p;
  $('#adding').hidden = !p;
  $('#adding-name').textContent = p?.name || '';
}

$('#adding-done').onclick = () => {
  const p = addTarget;
  openTab('playlists');
  push(p.name, el => playlistView(el, p), true);
};

async function addSong(t, btn) {
  if (!addTarget) return openSheet('Add to playlist', el => pickPlaylistSheet(el, t));
  btn.disabled = true;
  try {
    await addTo(addTarget, t);
    btn.textContent = '✓';
  } catch (e) {
    btn.disabled = false;
    throw e;
  }
}

async function addTo(p, t) {
  await api(`/playlists/${p.id}/items`, { method: 'POST', body: { uris: [t.uri] } });
  localStorage.setItem('last_playlist_id', p.id);
  localStorage.setItem('last_playlist_name', p.name);
  toast(`Added to ${p.name}`);
  changed();
}

async function pickPlaylistSheet(el, t) {
  el.append(h('p', { className: 'note' }, t.name));
  const choose = p => async e => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      await addTo(p, t);
      sheet.close();
    } finally {
      b.disabled = false;
    }
  };
  const lastId = localStorage.getItem('last_playlist_id');
  if (lastId) {
    const last = { id: lastId, name: localStorage.getItem('last_playlist_name') };
    el.append(h('ul', { className: 'list' }, row(null, last.name, 'Last used', choose(last))));
  }
  const ul = el.appendChild(h('ul', { className: 'list' }));
  const me = await getMe();
  await pager(ul, '/me/playlists?limit=50', p => canEdit(p, me)
    ? row(p.images, p.name, '', choose(p))
    : h('li', { hidden: true })); // hidden placeholder keeps paging offsets right
}

// ---------- Search ----------
const search = { q: '', type: 'track' };
const searchTypes = { track: 'Songs', album: 'Albums', artist: 'Artists' };
const rowFor = {
  track: t => trackRow(t, () => play({ uris: [t.uri] })),
  album: a => row(a.images, a.name, names(a.artists), () => push(a.name, el => albumView(el, a))),
  artist: a => row(a.images, a.name, 'Artist', () => push(a.name, el => artistView(el, a))),
};

function searchView(el) {
  const input = h('input', { type: 'search', placeholder: 'Search Spotify', value: search.q, enterKeyHint: 'search', autocomplete: 'off' });
  const results = h('div');
  const run = () => {
    search.q = input.value.trim();
    const ul = h('ul', { className: 'list' });
    results.replaceChildren(ul);
    if (!search.q) return;
    return pager(ul, `/search?type=${search.type}&limit=10&q=${encodeURIComponent(search.q)}`, rowFor[search.type],
      { pick: j => j[search.type + 's'], max: 1000 }); // Spotify caps search offset at 1000
  };
  el.append(
    h('form', { onsubmit: e => { e.preventDefault(); input.blur(); run(); } }, input),
    h('div', { className: 'seg' }, Object.entries(searchTypes).map(([type, label]) =>
      h('button', {
        type: 'button', 'aria-pressed': String(type === search.type),
        onclick: () => { search.type = type; search.q = input.value.trim(); el.replaceChildren(); searchView(el); },
      }, label))),
    results);
  if (!search.q) input.focus();
  return run();
}

async function albumView(el, a) {
  el.append(h('div', { className: 'actions' }, h('button', { className: 'primary', onclick: () => play({ context_uri: a.uri }) }, 'Play album')));
  const ul = el.appendChild(h('ul', { className: 'list' }));
  await pager(ul, `/albums/${a.id}/tracks?limit=50`,
    t => trackRow({ ...t, album: a }, () => play({ context_uri: a.uri, offset: { uri: t.uri } })));
}

async function artistView(el, a) {
  const ul = el.appendChild(h('ul', { className: 'list' }));
  await pager(ul, `/artists/${a.id}/albums?include_groups=album,single&limit=10`, rowFor.album);
}

// ---------- Playlists ----------
async function playlistsView(el) {
  el.append(h('ul', { className: 'list' }, h('li', { className: 'row' },
    h('span', { className: 'noimg plus' }, '+'),
    h('button', { className: 'main', onclick: createPlaylist }, h('b', {}, 'New playlist')))));
  const ul = el.appendChild(h('ul', { className: 'list' }));
  await pager(ul, '/me/playlists?limit=50', p => row(p.images, p.name,
    p.items ? `${p.items.total} songs` : p.owner?.display_name,
    () => push(p.name, el => playlistView(el, p), true),
    playButton(`Play ${p.name}`, () => play({ context_uri: p.uri }))));
}

async function createPlaylist() {
  const name = prompt('Name for the new playlist')?.trim();
  if (!name) return;
  const p = await api('/me/playlists', { method: 'POST', body: { name, public: false } });
  toast(`Created "${p.name}"`);
  await openTab('playlists');
  push(p.name, el => playlistView(el, p), true);
}

async function playlistView(el, p) {
  const view = stack.at(-1);
  const editable = canEdit(p, await getMe());
  const ul = h('ul', { className: 'list' });
  const playBtn = h('button', { className: 'primary', onclick: () => play({ context_uri: p.uri }) }, 'Play');
  const bar = el.appendChild(h('div', { className: 'actions' }, playBtn));
  if (!editable) {
    el.append(h('p', { className: 'note' }, 'Spotify only lets apps list the songs in playlists you own or collaborate on. You can still play it.'));
    return;
  }
  const addBtn = h('button', { onclick: () => { setAddTarget(p); openTab('search'); } }, 'Add songs');
  const renameBtn = h('button', { hidden: true, onclick: rename }, 'Rename');
  const editBtn = h('button', {
    onclick: () => {
      const on = ul.classList.toggle('editing');
      editBtn.textContent = on ? 'Done' : 'Edit';
      editBtn.classList.toggle('primary', on);
      playBtn.hidden = addBtn.hidden = on;
      renameBtn.hidden = !on;
    },
  }, 'Edit');
  bar.append(addBtn, renameBtn, editBtn);
  el.append(ul);

  const idx = li => [...ul.children].indexOf(li);
  let busy = false;
  const edit = fn => async () => {
    if (busy) return; // one change at a time so positions stay right
    busy = true;
    try { await fn(); changed(); } finally { busy = false; }
  };

  async function rename() {
    const name = prompt('New name', p.name)?.trim();
    if (!name || name === p.name) return;
    await api(`/playlists/${p.id}`, { method: 'PUT', body: { name } });
    p.name = view.title = name;
    showHeader();
    changed();
  }

  async function move(li, dir) {
    const i = idx(li);
    const sib = dir < 0 ? li.previousElementSibling : li.nextElementSibling;
    if (!sib) return;
    await api(`/playlists/${p.id}/items`, { method: 'PUT', body: { range_start: i, insert_before: dir < 0 ? i - 1 : i + 2 } });
    if (dir < 0) sib.before(li); else sib.after(li);
  }

  async function remove(t) {
    const copies = ul.querySelectorAll(`[data-uri="${CSS.escape(t.uri)}"]`);
    if (!confirm(`Remove "${t.name}"${copies.length > 1 ? ` (all ${copies.length} copies)` : ''} from this playlist?`)) return;
    await api(`/playlists/${p.id}/items`, { method: 'DELETE', body: { items: [{ uri: t.uri }] } });
    copies.forEach(r => r.remove()); // Spotify removes every copy of that song
  }

  await pager(ul, `/playlists/${p.id}/items?limit=50&additional_types=episode`, ({ item }) => {
    const li = trackRow(item, () => play({ context_uri: p.uri, offset: { position: idx(li) } }));
    li.append(h('span', { className: 'edit' },
      h('button', { 'aria-label': 'Move up', onclick: edit(() => move(li, -1)) }, '↑'),
      h('button', { 'aria-label': 'Move down', onclick: edit(() => move(li, 1)) }, '↓'),
      h('button', { 'aria-label': 'Remove', className: 'danger', disabled: !item, onclick: edit(() => remove(item)) }, '✕')));
    return li;
  });
}

// ---------- Settings ----------
function settingsView(el) {
  el.append(
    h('ul', { className: 'list' }, row(false, 'Privacy', 'Stop other people controlling your music', () => push('Privacy', privacyView))),
    h('button', { className: 'quiet wide', onclick: () => logout() }, 'Log out'));
}

// Spotify's Web API has no Jam setting (checked October 2026), so this explains the phone settings instead.
function privacyView(el) {
  el.append(
    h('p', {}, 'Spotify Jam can let people nearby join and control what plays. Spotify gives apps like GroblePorp no way to switch Jam off, so do it on your iPhone:'),
    h('ol', { className: 'steps' },
      h('li', {}, h('b', {}, 'Local Network: off'), h('br'), 'Settings › Apps › Spotify › Local Network'),
      h('li', {}, h('b', {}, 'SharePlay: off for Spotify'), h('br'), 'Can’t find it? Search “SharePlay” in the Settings app.'),
      h('li', {}, h('b', {}, 'Bluetooth: off'), h('br'), 'Settings › Apps › Spotify › Bluetooth'),
      h('li', {}, h('b', {}, 'Auto-invite: off'), h('br'),
        'In the Spotify app, open the device picker and turn off “Auto-invite people nearby to a Jam”. It can turn itself back on, so check it now and then.')),
    h('p', { className: 'note' }, 'Turning off Local Network or Bluetooth may stop Spotify on your phone from finding some speakers nearby.'),
    h('p', { className: 'note' }, 'The bar at the bottom always shows which device is playing. While GroblePorp is open, it tells you if playback is changed from somewhere else.'));
}

// ---------- Playback ----------
let state = null; // last known player state (or the instant guess after a tap)
let inFlight = 0; // commands Spotify hasn't answered yet
let cmdSeq = 0;   // goes up with every command, so older state checks get ignored
let pending = null; // a command waiting for you to choose a device
let lastWrite = 0;  // when GroblePorp last changed something at Spotify
let seen = null;    // last player check, to spot changes made somewhere else
const GRACE = 10000; // changes this soon after something we did count as ours

const isNoDevice = e => e.status === 404 && (e.reason === 'NO_ACTIVE_DEVICE' || /device/i.test(e.message));
const withDevice = (path, id) => `${path}${path.includes('?') ? '&' : '?'}device_id=${encodeURIComponent(id)}`;

// Updates the buttons at once, then tells Spotify. Switches back with an error if Spotify says no.
async function command(method, path, body, optimistic) {
  const before = state;
  if (optimistic) { state = { ...state }; optimistic(state); renderPlayer(); }
  inFlight++;
  cmdSeq++;
  lastWrite = Date.now();
  try {
    await api(path, { method, body });
  } catch (e) {
    state = before;
    renderPlayer();
    if (!isNoDevice(e)) throw e;
    // Nothing is active: use the device you last played on if it's still online, otherwise ask
    const d = !path.includes('device_id=') && await usableDevice();
    if (d) return command(method, withDevice(path, d.id), body, optimistic);
    return openDevices({ method, path, body, optimistic });
  } finally {
    inFlight--;
    lastWrite = Date.now();
  }
  setTimeout(refreshPlayer, 1000);
}

async function usableDevice() {
  const { devices } = await api('/me/player/devices');
  const last = localStorage.getItem('last_device');
  return devices.find(d => d.is_active) || devices.find(d => d.id && d.id === last && !d.is_restricted);
}

function openDevices(cmd = null) {
  pending = cmd;
  return openSheet('Play on', devicesSheet);
}

async function devicesSheet(el) {
  const ul = el.appendChild(h('ul', { className: 'list' }));
  const { devices } = await api('/me/player/devices');
  const last = localStorage.getItem('last_device');
  const rank = d => (d.is_active ? 2 : d.id && d.id === last ? 1 : 0);
  devices.sort((a, b) => rank(b) - rank(a)).forEach(d => {
    const r = row(false, d.name, d.is_active ? 'Playing here' : d.id === last ? `Last used · ${d.type}` : d.type, () => chooseDevice(d));
    r.classList.toggle('current', d.is_active);
    r.querySelector('.main').disabled = !d.id || d.is_restricted;
    ul.append(r);
  });
  if (!devices.length) ul.append(h('li', { className: 'note' }, 'No devices are online right now.'));
  el.append(
    h('p', { className: 'note' }, 'Phone not in the list? Open the Spotify app on it, then come back here.'),
    h('div', { className: 'actions' },
      h('a', { className: 'button primary', href: 'spotify:' }, 'Open Spotify'),
      h('button', { onclick: () => openSheet('Play on', devicesSheet) }, 'Refresh')));
}

function chooseDevice(d) {
  const cmd = pending;
  sheet.close();
  localStorage.setItem('last_device', d.id);
  const showDevice = s => { s.device = d; cmd?.optimistic?.(s); };
  if (cmd) return command(cmd.method, withDevice(cmd.path, d.id), cmd.body, showDevice);
  return command('PUT', '/me/player', { device_ids: [d.id] }, showDevice);
}

async function refreshPlayer() {
  if (document.hidden || !loggedIn() || inFlight) return;
  const seq = cmdSeq;
  let s;
  try {
    s = await api('/me/player?additional_types=episode'); // empty when nothing is active
  } catch {
    return; // background check; the next one will try again
  }
  if (inFlight || seq !== cmdSeq) return; // a newer tap is on its way; don't undo its instant update
  state = s;
  renderPlayer();
  watchOutside(s);
}

const outsideNotice = () => toast('Playback was changed from somewhere else.', false, 6000);

// True if the device, song or play/pause changed in a way a song simply ending can't explain.
function changedElsewhere(prev, s, elapsed) {
  if (!prev?.item || !s?.item) return false;
  if (prev.device?.id !== s.device?.id) return true;
  const ended = prev.is_playing && prev.item.duration_ms - prev.progress_ms - elapsed < 2000;
  if (prev.item.uri !== s.item.uri) return !ended;
  return prev.is_playing !== s.is_playing && !ended;
}

async function watchOutside(s) {
  const now = Date.now();
  const prev = seen;
  seen = { ...prev, s, at: now };
  // Only compare back-to-back checks taken well after anything GroblePorp did
  if (prev && now - prev.at < 12000 && prev.at - lastWrite > GRACE && changedElsewhere(prev.s, s, now - prev.at)) {
    return outsideNotice();
  }
  // Every 15s, see if the next few queued songs changed while the same song kept playing
  if (!s?.item || now - (prev?.queueAt || 0) < 15000) return;
  let q;
  try {
    q = (await api('/me/player/queue'))?.queue?.slice(0, 3).map(i => i?.uri).join(' ') || '';
  } catch {
    return;
  }
  const before = seen;
  const ours = before.queueAt - lastWrite <= GRACE || Date.now() - lastWrite <= GRACE;
  if (q && before.queue && before.queueFor === s.item.uri && before.queue !== q && !ours && now - before.queueAt < 30000) outsideNotice();
  Object.assign(seen, { queue: q, queueFor: s.item.uri, queueAt: Date.now() });
}

function renderPlayer() {
  const t = state?.item;
  if (state?.device?.id) localStorage.setItem('last_device', state.device.id);
  const art = t?.album?.images ?? t?.images;
  const url = art?.at(-1)?.url || '';
  if ($('#np-art').dataset.url !== url) { // only swap the picture when the song changes
    $('#np-art').dataset.url = url;
    $('#np-art').replaceChildren(thumb(art));
  }
  $('#np-title').textContent = t?.name || 'Nothing playing';
  $('#np-sub').textContent = t ? names(t.artists ?? [t.show]) : '';
  $('#np-device').textContent = state?.device?.name || 'No device · tap to choose';
  $('#now').classList.toggle('nodev', !state?.device);
  $('#now').classList.toggle('pending', !!state?.pending);
  $('#play').classList.toggle('playing', !!state?.is_playing);
  $('#play').setAttribute('aria-label', state?.is_playing ? 'Pause' : 'Play');
  $('#shuffle').classList.toggle('on', !!state?.shuffle_state);
  $('#shuffle').setAttribute('aria-pressed', String(!!state?.shuffle_state));
  $('#repeat').dataset.state = state?.repeat_state || 'off';
  $('#repeat').classList.toggle('on', !!state && state.repeat_state !== 'off');
  $('#repeat').setAttribute('aria-label', `Repeat: ${state?.repeat_state || 'off'}`);
}

const nextRepeat = { off: 'context', context: 'track', track: 'off' };
const starting = s => { s.is_playing = true; s.pending = true; };
const play = body => command('PUT', '/me/player/play', body, starting);

$('#play').onclick = () => (state?.is_playing
  ? command('PUT', '/me/player/pause', null, s => { s.is_playing = false; })
  : command('PUT', '/me/player/play', null, s => { s.is_playing = true; }));
$('#next').onclick = () => command('POST', '/me/player/next', null, starting);
$('#prev').onclick = () => command('POST', '/me/player/previous', null, starting);
$('#shuffle').onclick = () => {
  const on = !state?.shuffle_state;
  return command('PUT', `/me/player/shuffle?state=${on}`, null, s => { s.shuffle_state = on; });
};
$('#repeat').onclick = () => {
  const next = nextRepeat[state?.repeat_state || 'off'];
  return command('PUT', `/me/player/repeat?state=${next}`, null, s => { s.repeat_state = next; });
};
$('#now').onclick = () => openDevices();
$('#back').onclick = back;
$('#settings').onclick = () => push('Settings', settingsView);
document.querySelectorAll('nav button').forEach(b => { b.onclick = () => openTab(b.dataset.tab); });
setInterval(refreshPlayer, 5000);
document.addEventListener('visibilitychange', () => {
  refreshPlayer();
  // Back from the Spotify app: show the phone in the list
  if (!document.hidden && sheet.open && sheetBuild === devicesSheet) openSheet('Play on', devicesSheet);
});

// ---------- Start ----------
function showLogin(msg) {
  stack.length = 0;
  sheet.close();
  document.body.classList.add('out');
  const ready = CLIENT_ID && !CLIENT_ID.startsWith('PASTE');
  main.replaceChildren(h('div', { className: 'login' },
    h('h1', {}, 'GroblePorp'),
    msg && h('p', {}, msg),
    ready
      ? h('button', { className: 'primary wide', onclick: login }, 'Log in with Spotify')
      : h('p', {}, 'Paste your Spotify Client ID into config.js first.'),
    h('p', { className: 'note' }, 'Redirect address for this page (it must be listed in your Spotify app settings):'),
    h('code', {}, REDIRECT_URI)));
}

async function start() {
  try {
    await handleCallback();
  } catch (e) {
    return showLogin(e.message);
  }
  if (!loggedIn()) return showLogin();
  document.body.classList.remove('out');
  main.replaceChildren();
  openTab('playlists');
  renderPlayer();
  refreshPlayer();
}

start();
