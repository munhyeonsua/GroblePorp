# GroblePorp

A small Spotify remote for iPhone: search, playlists, playlist editing, and playback controls. No recommendations.

Plain HTML/CSS/JS. No server, no build step, no trackers. Your Spotify login stays in your browser.

## Setup checklist

### 1. Spotify dashboard
1. Go to https://developer.spotify.com/dashboard and open your app (Client ID `44c6094b2fe04ddaa101419c7fc0aad9`).
2. Click **Settings**, then **Edit**.
3. Under **Redirect URIs**, add these two lines exactly, then click **Save**:
   ```
   http://127.0.0.1:8000/
   https://munhyeonsua.github.io/GroblePorp/
   ```
4. Under **APIs used**, make sure **Web API** is ticked.
5. Under **User Management**, add your own Spotify account email if it isn't listed. Development Mode apps only work for up to 5 listed users, and the app owner needs Premium.

### 2. Client ID
This is already done: it's in `config.js`. If you ever make a new Spotify app, paste its Client ID there.

### 3. Put it on GitHub Pages (using the website)
1. Open https://github.com/munhyeonsua/GroblePorp
2. Click **Add file → Upload files**. Drag in these files from the GroblePorp folder:
   `index.html`, `style.css`, `app.js`, `config.js`, `manifest.webmanifest`, `icon-180.png`, `icon-512.png`, `README.md`
3. Click **Commit changes**.
4. Go to **Settings → Pages**. Under **Build and deployment**, set Source to **Deploy from a branch**, Branch to **main** and **/ (root)**, then click **Save**.
5. Wait a minute or two. The app will be at **https://munhyeonsua.github.io/GroblePorp/**

### 4. Add to your iPhone Home Screen
1. Open **https://munhyeonsua.github.io/GroblePorp/** in **Safari** on your iPhone.
2. Tap **Share → Add to Home Screen → Add**.
3. Open it from the new Home Screen icon and tap **Log in with Spotify**. Log in from the icon, not from Safari: the icon keeps its own login.

### 5. Turn off Spotify's suggestions
The app never asks for suggestions, but the Spotify app can add them by itself. In the Spotify app, go to **Settings → Playback** and turn off **Autoplay**. Also don't use Smart Shuffle.

## How to test it

**On your Mac (local test):**
1. Open Terminal and run:
   ```
   cd ~/GroblePorp
   python3 -m http.server 8000 --bind 127.0.0.1
   ```
2. In your browser, go to **http://127.0.0.1:8000/** exactly (not "localhost").
3. Log in, then try it:
   - **Playlists**: open one, tap **Play**, tap a song.
   - **Edit songs**: move one up or down, remove one (it asks first), **Rename**, **+ New playlist**.
   - **Search**: switch between Songs, Albums and Artists, tap **Load more**, tap **+** on a song to add it to a playlist.
   - **Devices**: open Spotify on your phone or computer, tap **Refresh**, pick a device.
   - The bottom buttons: shuffle, previous, play/pause, next, repeat (tap repeat again to cycle off → all → one song).
4. Press Ctrl+C in Terminal to stop.

**On iPhone:** do the same checks from the Home Screen icon.

## Good to know
- If something says "Choose a device", open the Spotify app on the device you want to play on, then pick it under **Devices**.
- Spotify only lets this app list the songs in playlists **you own or collaborate on**. Other playlists can still be played.
- Removing a song removes **every copy** of it from that playlist (that's how Spotify's API works).
- New playlists are created as private.
- Search shows 10 results at a time (Spotify's limit). Use **Load more**.
- Log out is at the bottom of the **Devices** tab.
