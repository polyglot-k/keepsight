/**
 * @file KeepSight Electron main process. Creates the window, menu bar item, and shortcuts, and handles renderer requests (IPC) as file operations.
 * Every path from the renderer is used only after {@link resolveInsideRoot} confirms it is inside root.
 */
const { app, BrowserWindow, ipcMain, shell, session, Menu, screen, Tray, nativeImage, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');
const { readClaudeCookies } = require('./chrome-cookies');

const ASSETS_DIRECTORY = path.join(__dirname, '..', 'assets');
const ROOT = path.resolve(process.env.ARTIFACTS_ROOT || store.DEFAULT_ROOT);

// claude.ai login (SSO) opens in a popup, so popups are allowed only for auth domains, as windows in the same session
const CLAUDE_PARTITION = 'persist:claude';
const AUTH_HOSTS = /(^|\.)(claude\.ai|anthropic\.com|google\.com|apple\.com|okta\.com|microsoftonline\.com)$/;

/** Minimum window size. Lowered only in mini window mode so it can shrink further */
const NORMAL_MIN_SIZE = [720, 420];
const MINI_MIN_SIZE = [240, 160];
const MINI_DEFAULT_SIZE = { width: 400, height: 300 };
const MINI_SCREEN_MARGIN = 16;

/** Zoom direction for each key pressed with ⌘ */
const ZOOM_DIRECTION_BY_KEY = { '=': 1, '+': 1, '-': -1, '0': 0 };

/**
 * @param {string} filePath
 * @returns {string} absolute path inside root
 * @throws {Error} if the path is outside root
 */
const resolveInsideRoot = filePath => store.resolveInsideRoot(ROOT, filePath);

/**
 * @param {string} url
 * @returns {boolean} true for http and https URLs
 */
const isWebUrl = url => /^https?:\/\//.test(url);

/**
 * @param {string} url
 * @returns {boolean} true if the popup belongs to a sign-in domain
 */
const isAuthPopup = url => {
  try {
    return AUTH_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

/**
 * Opens files in the default app and `.url` bookmarks in the browser.
 * @param {string} filePath
 * @returns {Promise<string | void>}
 * @throws {Error} if the bookmark has no https URL
 */
function openExternally(filePath) {
  filePath = resolveInsideRoot(filePath);
  if (!filePath.endsWith('.url')) return shell.openPath(filePath);
  const { url } = store.readLink(filePath);
  if (!store.isHttpsUrl(url)) throw new Error('This link file has no https URL');
  return shell.openExternal(url);
}

/**
 * Opens in VS Code (`code`). Falls back to the default app if it is missing.
 * @param {string} filePath
 */
function openInEditor(filePath) {
  filePath = resolveInsideRoot(filePath);
  execFile('code', [filePath], error => error && shell.openPath(filePath));
}

// Closing the window only hides it; the app stays in the menu bar. To really quit, use ⌘Q or "Quit" in the menu bar
let mainWindow = null;
let tray = null;
let isQuitting = false;

/**
 * Brings the hidden or minimized main window to the front.
 */
function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Shows the main window and opens quick open.
 */
function openPalette() {
  showMainWindow();
  mainWindow.webContents.send('openPalette');
}

app.on('before-quit', () => { isQuitting = true; });

// Only one window even if launch-at-login and a manual launch overlap: the second launch focuses the existing window
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', showMainWindow);
app.on('activate', showMainWindow);

app.on('web-contents-created', (_event, contents) => {
  // With the default menu, ⌘+/⌘-/⌘0 zoom the whole app UI, and the keys never reach the app while the preview has focus.
  // So intercept them here first and route them to the active pane's zoom. ⌘. (zen mode), ⌘⇧. (mini window), and ⌘K (quick open) are handled here for the same reason
  contents.on('before-input-event', (keyEvent, input) => {
    const isPeriodKey = input.code === 'Period' || input.key === '.' || input.key === '>';
    const isPaletteKey = input.key.toLowerCase() === 'k' && !input.shift && !input.alt;
    if (input.type !== 'keyDown' || !input.meta || !(input.key in ZOOM_DIRECTION_BY_KEY || isPeriodKey || isPaletteKey)) return;
    const windowContents = contents.getType() === 'webview' ? contents.hostWebContents : contents;
    if (!windowContents || windowContents.getType() !== 'window') return;
    keyEvent.preventDefault();
    if (isPeriodKey) windowContents.send(input.shift ? 'toggleMini' : 'toggleZen');
    else if (isPaletteKey) windowContents.send('openPalette');
    else windowContents.send('zoom', ZOOM_DIRECTION_BY_KEY[input.key]);
  });
  if (contents.getType() !== 'webview' && contents.session !== session.fromPartition(CLAUDE_PARTITION)) return;
  contents.setWindowOpenHandler(({ url }) => {
    if (isAuthPopup(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, webPreferences: { partition: CLAUDE_PARTITION } } };
    }
    if (isWebUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.whenReady().then(() => {
  fs.mkdirSync(ROOT, { recursive: true });

  // Google and others block login as an "insecure browser" if the user agent contains Electron
  const claudeSession = session.fromPartition(CLAUDE_PARTITION);
  claudeSession.setUserAgent(claudeSession.getUserAgent().replace(/ Electron\/\S+/, '').replace(/ keepsight\/\S+/, ''));

  /**
   * Copies Chrome's claude.ai cookies into the app session. Cookie values are never sent back to the renderer.
   * @returns {Promise<{ profile: { name?: string, email?: string }, imported: number, failed: string[] }>}
   */
  async function importChromeLogin() {
    const { profile, cookies } = await readClaudeCookies();
    // Clear first so cookies and storage left by failed in-app login attempts don't mix with the imported cookies
    for (const cookie of await claudeSession.cookies.get({ domain: 'claude.ai' })) {
      await claudeSession.cookies.remove(`https://${cookie.domain.replace(/^\./, '')}${cookie.path}`, cookie.name);
    }
    await claudeSession.clearStorageData({ origin: 'https://claude.ai', storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] });
    const failed = [];
    for (const cookie of cookies) {
      try {
        await claudeSession.cookies.set(cookie);
      } catch (error) {
        failed.push(`${cookie.name}: ${error.message}`);
      }
    }
    await claudeSession.cookies.flushStore();
    return { profile, imported: cookies.length - failed.length, failed };
  }

  // When a claude.ai link is opened without a login, import it automatically. Only once per run so the Keychain prompt doesn't repeat
  let autoImportAttempted = false;

  /**
   * Imports the Chrome login unless the session already has one or an automatic import was already tried.
   * @returns {Promise<object | null>}
   */
  async function ensureClaudeLogin() {
    const hasLogin = (await claudeSession.cookies.get({ domain: 'claude.ai', name: 'sessionKey' })).length > 0;
    if (hasLogin || autoImportAttempted) return null;
    autoImportAttempted = true;
    return importChromeLogin();
  }

  // Mini window: small, in a corner, above other apps. On exit, the mini window bounds are returned so the renderer can remember them
  // ponytail: shows on the current Space only. To follow across all Spaces use setVisibleOnAllWorkspaces (watch for Dock icon flicker)
  let normalBounds = null;
  let isMiniWindow = false;

  /**
   * @param {Electron.Rectangle | null} bounds
   * @returns {boolean} true if the bounds fit entirely on one connected display
   */
  const isFullyOnScreen = bounds => !!bounds && screen.getAllDisplays().some(({ workArea }) =>
    bounds.x >= workArea.x && bounds.y >= workArea.y &&
    bounds.x + bounds.width <= workArea.x + workArea.width && bounds.y + bounds.height <= workArea.y + workArea.height);

  /**
   * Turns the mini window on or off.
   * @param {BrowserWindow} targetWindow
   * @param {boolean} enabled
   * @param {Electron.Rectangle | null} savedBounds bounds remembered from the last mini window
   * @returns {Electron.Rectangle | null} the mini window bounds when turning it off
   */
  function setMiniWindow(targetWindow, enabled, savedBounds) {
    isMiniWindow = enabled;
    targetWindow.setWindowButtonVisibility(!enabled); // hide the traffic-light buttons in the mini window so they don't cover content
    if (enabled) {
      normalBounds = targetWindow.getBounds();
      targetWindow.setMinimumSize(...MINI_MIN_SIZE);
      const { workArea } = screen.getDisplayMatching(normalBounds);
      const cornerBounds = {
        ...MINI_DEFAULT_SIZE,
        x: workArea.x + workArea.width - MINI_DEFAULT_SIZE.width - MINI_SCREEN_MARGIN,
        y: workArea.y + workArea.height - MINI_DEFAULT_SIZE.height - MINI_SCREEN_MARGIN,
      };
      targetWindow.setBounds(isFullyOnScreen(savedBounds) ? savedBounds : cornerBounds);
      targetWindow.setAlwaysOnTop(true, 'floating');
      return null;
    }
    const miniBounds = targetWindow.getBounds();
    targetWindow.setAlwaysOnTop(false);
    targetWindow.setMinimumSize(...NORMAL_MIN_SIZE);
    if (normalBounds) targetWindow.setBounds(normalBounds);
    return miniBounds;
  }

  /**
   * Shows the list context menu and resolves with the chosen action name, which the renderer handles like a toolbar action.
   * @param {BrowserWindow} targetWindow
   * @returns {Promise<'open' | 'editor' | 'reveal' | 'edit' | 'trash' | null>}
   */
  function showContextMenu(targetWindow) {
    return new Promise(resolve => {
      const menuItem = (label, action) => ({ label, click: () => resolve(action) });
      Menu.buildFromTemplate([
        menuItem('Open in Browser', 'open'), menuItem('Open in Editor', 'editor'), menuItem('Reveal in Finder', 'reveal'),
        { type: 'separator' }, menuItem('Edit…', 'edit'), { type: 'separator' }, menuItem('Move to Trash', 'trash'),
      ]).popup({ window: targetWindow, callback: () => setTimeout(() => resolve(null), 0) });
    });
  }

  /**
   * @param {Electron.IpcMainInvokeEvent} invokeEvent
   * @returns {BrowserWindow} the window that sent the request
   */
  const senderWindow = invokeEvent => BrowserWindow.fromWebContents(invokeEvent.sender);
  ipcMain.handle('scan', () => ({ root: ROOT, items: store.scan(ROOT) }));
  ipcMain.handle('listVersions', (_event, filePath) => store.listVersions(ROOT, filePath));
  ipcMain.handle('restoreVersion', (_event, filePath, versionPath) => store.restoreVersion(ROOT, filePath, versionPath));
  ipcMain.handle('open', (_event, filePath) => openExternally(filePath));
  ipcMain.handle('editor', (_event, filePath) => openInEditor(filePath));
  ipcMain.handle('reveal', (_event, filePath) => shell.showItemInFolder(resolveInsideRoot(filePath)));
  ipcMain.handle('trash', (_event, filePath) => shell.trashItem(resolveInsideRoot(filePath)));
  ipcMain.handle('addLink', (_event, link) => store.addLink(ROOT, link));
  ipcMain.handle('updateMeta', (_event, filePath, changes) => store.updateMeta(ROOT, filePath, changes));
  ipcMain.handle('importChromeLogin', importChromeLogin);
  ipcMain.handle('ensureClaudeLogin', ensureClaudeLogin);
  ipcMain.handle('showContextMenu', invokeEvent => showContextMenu(senderWindow(invokeEvent)));
  // Zen mode: covers the title bar and menu bar too. "Simple" full screen skips the new-Space transition animation
  ipcMain.handle('setFullScreen', (invokeEvent, enabled) => senderWindow(invokeEvent).setSimpleFullScreen(!!enabled));
  ipcMain.handle('setMiniWindow', (invokeEvent, enabled, savedBounds) => setMiniWindow(senderWindow(invokeEvent), enabled, savedBounds));

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: NORMAL_MIN_SIZE[0],
    minHeight: NORMAL_MIN_SIZE[1],
    title: 'KeepSight',
    // Remove the title bar and keep only the traffic-light buttons above the sidebar. The sidebar shows what's behind the window (vibrancy)
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, webviewTag: true },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('close', closeEvent => {
    if (isQuitting) return;
    closeEvent.preventDefault();
    mainWindow.hide();
  });

  // ⌘⇧. shows and hides the mini window even while using another app. It does not steal focus
  // (If registration fails, e.g. another app already owns it, the in-app before-input-event path still works)
  globalShortcut.register('CommandOrControl+Shift+.', () => {
    if (!mainWindow.isVisible()) {
      mainWindow.showInactive();
      if (isMiniWindow) return;
    }
    mainWindow.webContents.send('toggleMini');
  });
  // ⌥⌘K opens quick open from anywhere (⌘K is avoided globally because many other apps use it)
  globalShortcut.register('Alt+CommandOrControl+K', openPalette);

  // The menu bar icon is a Template image, so macOS tints it for light and dark mode
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS_DIRECTORY, 'trayTemplate.png')));
  tray.setToolTip('KeepSight');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open KeepSight', click: showMainWindow },
    { label: 'Quick Open…', accelerator: 'Alt+Command+K', click: openPalette },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]));
  // Show the app icon in the Dock in development runs (npm start) too. The packaged app uses the icns
  if (!app.isPackaged) app.dock?.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));

  // On startup, save the current content of every HTML file as a version, so even the pre-first-edit content can be restored
  // ponytail: compares every file to its latest version on each startup. If thousands of files make it slow, compare modification times instead
  for (const item of store.scan(ROOT)) {
    if (item.kind !== 'file') continue;
    try { store.saveVersion(ROOT, item.path); } catch {}
  }

  // Save changed HTML as a version and refresh the list. Changes inside hidden folders (including .history) are ignored
  let refreshTimer = null;
  const changedPaths = new Set();
  fs.watch(ROOT, { recursive: true }, (_eventType, relativePath) => {
    if (!relativePath || relativePath.split(path.sep).some(segment => segment.startsWith('.'))) return;
    changedPaths.add(path.join(ROOT, relativePath));
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      for (const changedPath of changedPaths) {
        if (!changedPath.endsWith('.html')) continue;
        try { store.saveVersion(ROOT, changedPath); } catch {}
      }
      changedPaths.clear();
      mainWindow.webContents.send('libraryChanged');
    }, 200);
  });
});

app.on('window-all-closed', () => app.quit());
