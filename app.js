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

function trackRow(t, onPlay) {
  if (!t) return h('li', { className: 'row' }, h('span', { className: 'noimg' }), h('span', { className: 'main note' }, 'Song no longer available'));
  const li = row(t.album?.images ?? t.images, t.name, names(t.artists ?? [t.show]), () => onPlay(li));
  li.dataset.uri = t.uri;
  if (t.type === 'track' && !t.is_local) {
    li.append(h('button', { className: 'add', 'aria-label': 'Add to a playlist', onclick: () => push('Add to playlist', el => pickPlaylistView(el, t)) }, '+'));
  }
  return li;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

window.addEventListener('unhandledrejection', e => {
  e.preventDefault();
  const err = e.reason || {};
  if (err.status === 429) return toast('Spotify says too many requests. Wait a minute and try again.');
  if (err.status === 403) return toast('Spotify refused: ' + err.message);
  toast(err.message === 'Load failed' || err.message === 'Failed to fetch' ? 'Could not reach Spotify. Check your connection.' : err.message || String(err));
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

// ---------- Screens (a simple stack, so Back keeps scroll position) ----------
const main = $('#view');
const stack = [];

function showHeader() {
  const top = stack.at(-1);
  $('#title').textContent = top.title;
  $('#back').hidden = stack.length < 2;
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
const changed = () => stack.slice(0, -1).forEach(v => { v.stale = v.reload; });

const tabs = {
  search: ['Search', searchView],
  playlists: ['Playlists', playlistsView, true],
  devices: ['Devices', devicesView],
};

function openTab(name) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  stack.splice(0).forEach(v => v.el.remove());
  return push(...tabs[name]);
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
  el.append(h('button', { className: 'wide', onclick: createPlaylist }, '+ New playlist'));
  const ul = el.appendChild(h('ul', { className: 'list' }));
  await pager(ul, '/me/playlists?limit=50', p => row(p.images, p.name,
    p.items ? `${p.items.total} songs` : p.owner?.display_name,
    () => push(p.name, el => playlistView(el, p), true)));
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
  el.append(h('div', { className: 'actions' },
    h('button', { className: 'primary', onclick: () => play({ context_uri: p.uri }) }, 'Play'),
    editable && h('button', { onclick: rename }, 'Rename'),
    editable && h('button', {
      'aria-pressed': 'false',
      onclick: e => e.currentTarget.setAttribute('aria-pressed', String(ul.classList.toggle('editing'))),
    }, 'Edit songs')));
  if (!editable) {
    el.append(h('p', { className: 'note' }, 'Spotify only lets apps list the songs in playlists you own or collaborate on. You can still play it.'));
    return;
  }
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

async function pickPlaylistView(el, t) {
  el.append(h('p', { className: 'note' }, `Add "${t.name}" to:`));
  const ul = el.appendChild(h('ul', { className: 'list' }));
  const me = await getMe();
  await pager(ul, '/me/playlists?limit=50', p => canEdit(p, me)
    ? row(p.images, p.name, '', async e => {
      e.currentTarget.disabled = true;
      await api(`/playlists/${p.id}/items`, { method: 'POST', body: { uris: [t.uri] } });
      toast(`Added to ${p.name}`);
      changed();
      back();
    })
    : h('li', { hidden: true })); // hidden placeholder keeps paging offsets right
}

// ---------- Playback ----------
let state = null;
let pendingPlay = null;

async function command(method, path, body) {
  try {
    await api(path, { method, body });
  } catch (e) {
    if (e.status !== 404 || !(e.reason === 'NO_ACTIVE_DEVICE' || /device/i.test(e.message))) throw e;
    // No device is playing: let the user pick one, then play what they tapped there
    pendingPlay = path === '/me/player/play' ? body || {} : null;
    toast('Choose a device to play on.');
    openTab('devices');
    return;
  }
  setTimeout(refreshPlayer, 700);
}

const play = body => command('PUT', '/me/player/play', body);

async function devicesView(el) {
  el.append(
    h('p', { className: 'note' }, 'Open Spotify on the phone, computer or speaker you want, then tap Refresh.'),
    h('button', { className: 'wide', onclick: () => openTab('devices') }, 'Refresh'));
  const ul = el.appendChild(h('ul', { className: 'list' }));
  const { devices } = await api('/me/player/devices');
  devices.forEach(d => {
    const r = row(false, d.name, (d.is_active ? 'Playing here · ' : '') + d.type, async () => {
      if (pendingPlay) await api(`/me/player/play?device_id=${encodeURIComponent(d.id)}`, { method: 'PUT', body: pendingPlay });
      else await api('/me/player', { method: 'PUT', body: { device_ids: [d.id] } });
      pendingPlay = null;
      toast(`Now using ${d.name}`);
      setTimeout(() => { refreshPlayer(); if (stack.at(-1)?.title === 'Devices') openTab('devices'); }, 700);
    });
    r.querySelector('.main').disabled = !d.id || d.is_restricted;
    ul.append(r);
  });
  if (!devices.length) el.append(h('p', { className: 'note' }, 'No devices found. Open the Spotify app somewhere first.'));
  el.append(h('button', { className: 'wide', onclick: () => logout() }, 'Log out'));
}

async function refreshPlayer() {
  if (document.hidden || !loggedIn()) return;
  try {
    state = await api('/me/player?additional_types=episode'); // empty when nothing is active
  } catch {
    return; // background check; a failed one just waits for the next
  }
  const t = state?.item;
  $('#np-art').replaceChildren(thumb(t?.album?.images ?? t?.images));
  $('#np-title').textContent = t?.name || 'Nothing playing';
  $('#np-sub').textContent = t ? `${names(t.artists ?? [t.show])} · ${state.device?.name || ''}` : 'Pick a device under Devices';
  $('#play').classList.toggle('playing', !!state?.is_playing);
  $('#play').setAttribute('aria-label', state?.is_playing ? 'Pause' : 'Play');
  $('#shuffle').classList.toggle('on', !!state?.shuffle_state);
  $('#shuffle').setAttribute('aria-pressed', String(!!state?.shuffle_state));
  $('#repeat').dataset.state = state?.repeat_state || 'off';
  $('#repeat').classList.toggle('on', !!state && state.repeat_state !== 'off');
  $('#repeat').setAttribute('aria-label', `Repeat: ${state?.repeat_state || 'off'}`);
}

const nextRepeat = { off: 'context', context: 'track', track: 'off' };
$('#play').onclick = () => command('PUT', state?.is_playing ? '/me/player/pause' : '/me/player/play');
$('#next').onclick = () => command('POST', '/me/player/next');
$('#prev').onclick = () => command('POST', '/me/player/previous');
$('#shuffle').onclick = () => command('PUT', `/me/player/shuffle?state=${!state?.shuffle_state}`);
$('#repeat').onclick = () => command('PUT', `/me/player/repeat?state=${nextRepeat[state?.repeat_state || 'off']}`);
$('#back').onclick = back;
document.querySelectorAll('nav button').forEach(b => { b.onclick = () => openTab(b.dataset.tab); });
setInterval(refreshPlayer, 10000);
document.addEventListener('visibilitychange', refreshPlayer);

// ---------- Start ----------
function showLogin(msg) {
  stack.length = 0;
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
  refreshPlayer();
}

start();
