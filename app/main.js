/**
 * @file KeepSight Electron 메인 프로세스. 창·메뉴 막대·단축키를 만들고, renderer 요청(IPC)을 파일 작업으로 처리한다.
 * renderer가 넘긴 경로는 모두 {@link inRoot}로 root 안인지 확인한 뒤에만 쓴다.
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
 * @returns {string} root 안의 절대 경로
 * @throws {Error} root 밖 경로일 때
 */
const inRoot = p => store.inRoot(ROOT, p);

/**
 * 파일은 기본 앱으로, `.url`은 브라우저로 연다.
 * @param {string} p
 * @returns {Promise<string | void>}
 * @throws {Error} 링크 파일에 https URL이 없을 때
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
 * VS Code(`code`)로 연다. 없으면 기본 앱으로 연다.
 * @param {string} p
 */
function openInEditor(p) {
  p = inRoot(p);
  execFile('code', [p], err => err && shell.openPath(p));
}

// 창을 닫으면 숨기기만 하고 앱은 메뉴 막대에 남는다. 진짜 종료는 ⌘Q나 메뉴 막대의 "종료"
let mainWin = null, tray = null, quitting = false;

/**
 * 숨겨지거나 최소화된 메인 창을 앞으로 가져온다.
 */
const showMain = () => { if (!mainWin) return; if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); };
app.on('before-quit', () => { quitting = true; });

// 로그인 자동 실행 + 수동 실행이 겹쳐도 창은 하나만: 두 번째 실행은 기존 창을 앞으로
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', showMain);
app.on('activate', showMain);

// claude.ai 로그인(SSO)은 팝업으로 열리므로, 인증 도메인 팝업만 같은 세션 창으로 허용한다
const PARTITION = 'persist:claude';
const AUTH_HOSTS = /(^|\.)(claude\.ai|anthropic\.com|google\.com|apple\.com|okta\.com|microsoftonline\.com)$/;
const isAuthPopup = url => { try { return AUTH_HOSTS.test(new URL(url).hostname); } catch { return false; } };

/** 창 최소 크기. 미니 창일 때만 더 작게 줄일 수 있게 낮춘다 */
const MIN_SIZE = [720, 420], MINI_MIN_SIZE = [240, 160];

const ZOOM_KEYS = { '=': 1, '+': 1, '-': -1, '0': 0 };

app.on('web-contents-created', (_, wc) => {
  // ⌘+/⌘-/⌘0은 기본 메뉴가 앱 UI 전체를 확대하고, 미리보기에 포커스가 있으면 키가 앱까지 안 온다.
  // 그래서 여기서 먼저 가로채 활성 칸 줌으로 보낸다. ⌘.(젠 모드)·⌘⇧.(미니 창)·⌘K(빠른 열기)도 같은 이유로 여기서 처리한다
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

  // Google 등은 UA에 Electron이 있으면 "안전하지 않은 브라우저"로 로그인을 막는다
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
  // 젠 모드: 제목 표시줄·메뉴 막대까지 덮는다. simple은 새 Space 전환 애니메이션이 없다
  ipcMain.handle('fullScreen', (e, on) => BrowserWindow.fromWebContents(e.sender).setSimpleFullScreen(!!on));
  // 미니 창: 구석에 작게, 다른 앱 위에 띄운다. 끌 때 미니 창 위치를 돌려줘 renderer가 기억한다
  // ponytail: 현재 Space에만 뜬다. 모든 Space를 따라다니게 하려면 setVisibleOnAllWorkspaces (Dock 아이콘 깜빡임 주의)
  let normalBounds = null, isMini = false;
  const onScreen = b => b && screen.getAllDisplays().some(({ workArea: a }) =>
    b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height);
  ipcMain.handle('mini', (e, on, saved) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    isMini = on;
    w.setWindowButtonVisibility(!on); // 미니 창에서는 신호등 버튼이 내용을 가리지 않게 숨긴다
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
   * 크롬의 claude.ai 쿠키를 앱 세션으로 복사한다. 쿠키 값은 renderer로 돌려보내지 않는다.
   * @returns {Promise<{ profile: { name?: string, email?: string }, imported: number, failed: string[] }>}
   */
  async function importChrome() {
    const { profile, cookies } = await readClaudeCookies();
    // 앱 안에서 실패한 로그인 시도가 남긴 쿠키·저장소가 가져온 쿠키와 섞이지 않게 먼저 비운다
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

  // 목록 우클릭 메뉴. 고른 동작 이름을 돌려주면 renderer가 기존 act()로 처리한다
  ipcMain.handle('contextMenu', e => new Promise(resolve => {
    const item = (label, action) => ({ label, click: () => resolve(action) });
    Menu.buildFromTemplate([
      item('Open in Browser', 'open'), item('Open in Editor', 'editor'), item('Reveal in Finder', 'reveal'),
      { type: 'separator' }, item('Edit…', 'edit'), { type: 'separator' }, item('Move to Trash', 'trash'),
    ]).popup({ window: BrowserWindow.fromWebContents(e.sender), callback: () => setTimeout(() => resolve(null), 0) });
  }));

  // claude.ai 링크를 열 때 로그인이 없으면 자동으로 가져온다. 키체인 창이 반복되지 않게 실행당 1회만
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
    // 제목 표시줄을 없애고 신호등 버튼만 사이드바 위에 둔다. 사이드바는 창 뒤가 비치게(vibrancy)
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
  // 다른 앱을 쓰는 중에도 ⌘⇧.로 미니 창을 꺼내고 넣는다. 포커스는 뺏지 않는다
  // (등록에 실패하면, 예컨대 다른 앱이 이미 쓰고 있으면, 앱 안에서만 동작하는 before-input-event 경로가 남는다)
  globalShortcut.register('CommandOrControl+Shift+.', () => {
    if (!win.isVisible()) {
      win.showInactive();
      if (isMini) return;
    }
    win.webContents.send('mini');
  });
  // 어디서든 ⌥⌘K로 빠른 열기를 띄운다 (⌘K는 다른 앱들이 많이 써서 전역으로는 피했다)
  globalShortcut.register('Alt+CommandOrControl+K', () => { showMain(); win.webContents.send('palette'); });
  // 메뉴 막대 아이콘은 Template 이미지라 macOS가 밝기·다크 모드에 맞춰 색을 입힌다
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png')));
  tray.setToolTip('KeepSight');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open KeepSight', click: showMain },
    { label: 'Quick Open…', accelerator: 'Alt+Command+K', click: () => { showMain(); win.webContents.send('palette'); } },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]));
  // 개발 실행(npm start)에서도 Dock에 앱 아이콘이 보이게 한다. 패키징한 앱은 icns를 쓴다
  if (!app.isPackaged) app.dock?.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));

  // 시작할 때 모든 HTML의 현재 내용을 버전으로 남겨 둔다. 그래야 첫 수정 전 내용으로도 되돌릴 수 있다
  // ponytail: 시작마다 전체 파일을 최신 버전과 비교한다. 수천 개로 느려지면 mtime 비교로 바꾼다
  for (const i of store.scan(ROOT)) if (i.kind === 'file') { try { store.snapshot(ROOT, i.path); } catch {} }

  // 바뀐 HTML은 버전으로 남기고 목록을 갱신한다. 버전 폴더(.history) 자체의 변화는 무시한다
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
