/**
 * @file KeepSight Electron main process. Creates the window, menu bar item, and shortcuts, and handles renderer requests (IPC) as file operations.
 * Every path from the renderer is used only after {@link inRoot} confirms it is inside root.
 */
const { app, BrowserWindow, ipcMain, shell, session, Menu, screen, Tray, nativeImage, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');
const { readClaudeCookies } = require('./chrome-cookies');

const ASSETS = path.join(__dirname, '..', 'assets');
const ROOT = path.resolve(process.env.ARTIFACTS_ROOT || path.join(app.getPath('home'), 'artifacts'));

/**
 * @param {string} p
 * @returns {string} absolute path inside root
 * @throws {Error} if the path is outside root
 */
const inRoot = p => store.inRoot(ROOT, p);

/**
 * Opens files in the default app and `.url` files in the browser.
 * @param {string} p
 * @returns {Promise<string | void>}
 * @throws {Error} if the link file has no https URL
 */
function open(p) {
  p = inRoot(p);
  if (p.endsWith('.url')) {
    const { url } = store.readLink(p);
    if (/^https:\/\//.test(url || '')) return shell.openExternal(url);
    throw new Error('This link file has no https URL');
  }
  return shell.openPath(p);
}

/**
 * Opens in VS Code (`code`). Falls back to the default app if it is missing.
 * @param {string} p
 */
function openInEditor(p) {
  p = inRoot(p);
  execFile('code', [p], err => err && shell.openPath(p));
}

// Closing the window only hides it; the app stays in the menu bar. To really quit, use ⌘Q or "Quit" in the menu bar
let mainWin = null, tray = null, quitting = false;

/**
 * Brings the hidden or minimized main window to the front.
 */
const showMain = () => { if (!mainWin) return; if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); };
app.on('before-quit', () => { quitting = true; });

// Only one window even if launch-at-login and a manual launch overlap: the second launch focuses the existing window
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', showMain);
app.on('activate', showMain);

// claude.ai login (SSO) opens in a popup, so allow popups only for auth domains, as windows in the same session
const PARTITION = 'persist:claude';
const AUTH_HOSTS = /(^|\.)(claude\.ai|anthropic\.com|google\.com|apple\.com|okta\.com|microsoftonline\.com)$/;
const isAuthPopup = url => { try { return AUTH_HOSTS.test(new URL(url).hostname); } catch { return false; } };

/** Minimum window size. Lowered only in mini window mode so it can shrink further */
const MIN_SIZE = [720, 420], MINI_MIN_SIZE = [240, 160];

const ZOOM_KEYS = { '=': 1, '+': 1, '-': -1, '0': 0 };

app.on('web-contents-created', (_, wc) => {
  // With the default menu, ⌘+/⌘-/⌘0 zoom the whole app UI, and the keys never reach the app while the preview has focus.
  // So intercept them here first and route them to the active pane's zoom. ⌘. (zen mode), ⌘⇧. (mini window), and ⌘K (quick open) are handled here for the same reason
  wc.on('before-input-event', (e, input) => {
    const period = input.code === 'Period' || input.key === '.' || input.key === '>';
    const palette = input.key.toLowerCase() === 'k' && !input.shift && !input.alt;
    if (input.type !== 'keyDown' || !input.meta || !(input.key in ZOOM_KEYS || period || palette)) return;
    const host = wc.getType() === 'webview' ? wc.hostWebContents : wc;
    if (!host || host.getType() !== 'window') return;
    e.preventDefault();
    if (period) host.send(input.shift ? 'mini' : 'zen');
    else if (palette) host.send('palette');
    else host.send('zoom', ZOOM_KEYS[input.key]);
  });
  if (wc.getType() !== 'webview' && wc.session !== session.fromPartition(PARTITION)) return;
  wc.setWindowOpenHandler(({ url }) => {
    if (isAuthPopup(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, webPreferences: { partition: PARTITION } } };
    }
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.whenReady().then(() => {
  fs.mkdirSync(ROOT, { recursive: true });

  // Google and others block login as an "insecure browser" if the UA contains Electron
  const s = session.fromPartition(PARTITION);
  s.setUserAgent(s.getUserAgent().replace(/ Electron\/\S+/, '').replace(/ keepsight\/\S+/, ''));

  ipcMain.handle('scan', () => ({ root: ROOT, items: store.scan(ROOT) }));
  ipcMain.handle('history', (_, p) => store.listHistory(ROOT, p));
  ipcMain.handle('restore', (_, p, version) => store.restore(ROOT, p, version));
  ipcMain.handle('open', (_, p) => open(p));
  ipcMain.handle('editor', (_, p) => openInEditor(p));
  ipcMain.handle('reveal', (_, p) => shell.showItemInFolder(inRoot(p)));
  ipcMain.handle('trash', (_, p) => shell.trashItem(inRoot(p)));
  ipcMain.handle('addLink', (_, a) => store.addLink(ROOT, a));
  // Zen mode: covers the title bar and menu bar too. simple skips the new-Space transition animation
  ipcMain.handle('fullScreen', (e, on) => BrowserWindow.fromWebContents(e.sender).setSimpleFullScreen(!!on));
  // Mini window: small, in a corner, above other apps. On exit, returns the mini window position so the renderer can remember it
  // ponytail: shows on the current Space only. To follow across all Spaces use setVisibleOnAllWorkspaces (watch for Dock icon flicker)
  let normalBounds = null, isMini = false;
  const onScreen = b => b && screen.getAllDisplays().some(({ workArea: a }) =>
    b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height);
  ipcMain.handle('mini', (e, on, saved) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    isMini = on;
    w.setWindowButtonVisibility(!on); // hide the traffic-light buttons in the mini window so they don't cover content
    if (on) {
      normalBounds = w.getBounds();
      w.setMinimumSize(...MINI_MIN_SIZE);
      const { workArea: a } = screen.getDisplayMatching(normalBounds);
      w.setBounds(onScreen(saved) ? saved : { width: 400, height: 300, x: a.x + a.width - 416, y: a.y + a.height - 316 });
      w.setAlwaysOnTop(true, 'floating');
      return null;
    }
    const mini = w.getBounds();
    w.setAlwaysOnTop(false);
    w.setMinimumSize(...MIN_SIZE);
    if (normalBounds) w.setBounds(normalBounds);
    return mini;
  });
  ipcMain.handle('updateMeta', (_, p, meta) => store.updateMeta(ROOT, p, meta));

  /**
   * Copies Chrome's claude.ai cookies into the app session. Cookie values are never sent back to the renderer.
   * @returns {Promise<{ profile: { name?: string, email?: string }, imported: number, failed: string[] }>}
   */
  async function importChrome() {
    const { profile, cookies } = await readClaudeCookies();
    // Clear first so cookies/storage left by failed in-app login attempts don't mix with the imported cookies
    for (const c of await s.cookies.get({ domain: 'claude.ai' })) {
      await s.cookies.remove(`https://${c.domain.replace(/^\./, '')}${c.path}`, c.name);
    }
    await s.clearStorageData({ origin: 'https://claude.ai', storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] });
    const failed = [];
    for (const c of cookies) {
      try { await s.cookies.set(c); } catch (e) { failed.push(`${c.name}: ${e.message}`); }
    }
    await s.cookies.flushStore();
    return { profile, imported: cookies.length - failed.length, failed };
  }
  ipcMain.handle('importChrome', importChrome);

  // List context menu. Returns the chosen action name, which the renderer handles with its existing act()
  ipcMain.handle('contextMenu', e => new Promise(resolve => {
    const item = (label, action) => ({ label, click: () => resolve(action) });
    Menu.buildFromTemplate([
      item('Open in Browser', 'open'), item('Open in Editor', 'editor'), item('Reveal in Finder', 'reveal'),
      { type: 'separator' }, item('Edit…', 'edit'), { type: 'separator' }, item('Move to Trash', 'trash'),
    ]).popup({ window: BrowserWindow.fromWebContents(e.sender), callback: () => setTimeout(() => resolve(null), 0) });
  }));

  // When opening a claude.ai link without a login, import it automatically. Only once per run so the Keychain prompt doesn't repeat
  let autoTried = false;
  ipcMain.handle('ensureClaudeLogin', async () => {
    if ((await s.cookies.get({ domain: 'claude.ai', name: 'sessionKey' })).length || autoTried) return null;
    autoTried = true;
    return importChrome();
  });

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: MIN_SIZE[0],
    minHeight: MIN_SIZE[1],
    title: 'KeepSight',
    // Remove the title bar and keep only the traffic-light buttons above the sidebar. The sidebar shows what's behind the window (vibrancy)
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, webviewTag: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  mainWin = win;
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
  // ⌘⇧. shows and hides the mini window even while using another app. It does not steal focus
  // (If registration fails, e.g. another app already owns it, the in-app before-input-event path still works)
  globalShortcut.register('CommandOrControl+Shift+.', () => {
    if (!win.isVisible()) {
      win.showInactive();
      if (isMini) return;
    }
    win.webContents.send('mini');
  });
  // ⌥⌘K opens quick open from anywhere (⌘K is avoided globally because many other apps use it)
  globalShortcut.register('Alt+CommandOrControl+K', () => { showMain(); win.webContents.send('palette'); });
  // The menu bar icon is a Template image, so macOS tints it for light/dark mode
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png')));
  tray.setToolTip('KeepSight');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open KeepSight', click: showMain },
    { label: 'Quick Open…', accelerator: 'Alt+Command+K', click: () => { showMain(); win.webContents.send('palette'); } },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]));
  // Show the app icon in the Dock in dev runs (npm start) too. The packaged app uses the icns
  if (!app.isPackaged) app.dock?.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));

  // On startup, save the current content of every HTML file as a version, so even the pre-first-edit content can be restored
  // ponytail: compares every file to its latest version on each startup. If thousands of files make it slow, switch to an mtime check
  for (const i of store.scan(ROOT)) if (i.kind === 'file') { try { store.snapshot(ROOT, i.path); } catch {} }

  // Save changed HTML as a version and refresh the list. Changes inside the version folder (.history) itself are ignored
  let t;
  const changed = new Set();
  fs.watch(ROOT, { recursive: true }, (_, rel) => {
    if (!rel || rel.split(path.sep).some(seg => seg.startsWith('.'))) return;
    changed.add(path.join(ROOT, rel));
    clearTimeout(t);
    t = setTimeout(() => {
      for (const p of changed) if (p.endsWith('.html')) { try { store.snapshot(ROOT, p); } catch {} }
      changed.clear();
      win.webContents.send('changed');
    }, 200);
  });
});

app.on('window-all-closed', () => app.quit());
