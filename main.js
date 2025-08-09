const { app, BrowserWindow, globalShortcut, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

let mainWindow;

// 应用可写的数据目录（用户目录下）
function getAppDataDir() {
  const dir = path.join(app.getPath('userData'), 'soundpp');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function getAppSoundsDir() {
  const dir = path.join(getAppDataDir(), 'sounds');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function resolveAppIcon() {
  const png = path.join(__dirname, 'assets', 'icon.png');
  const ico = path.join(__dirname, 'assets', 'icon.ico');
  const svg = path.join(__dirname, 'assets', 'icon.svg');
  if (fs.existsSync(ico)) return ico;
  if (fs.existsSync(png)) return png;
  if (fs.existsSync(svg)) return svg;
  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: resolveAppIcon(),
    frame: false,
    show: false
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 具体的全局快捷键注册由渲染进程根据用户配置动态请求注册
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    globalShortcut.unregisterAll();
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

ipcMain.handle('play-audio', async (event, audioPath) => {
  try {
    const fullPath = path.isAbsolute(audioPath) ? audioPath : path.join(__dirname, audioPath);
    
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('play-audio-file', fullPath);
    }
    
    return { success: true, path: fullPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('register-shortcut', async (event, shortcut, audioId) => {
  try {
    // 如果已被占用或注册失败，返回错误
    if (globalShortcut.isRegistered(shortcut)) {
      return { success: false, error: '快捷键已被占用或已注册' };
    }

    const ok = globalShortcut.register(shortcut, () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('shortcut-triggered', audioId);
      }
    });
    if (!ok) {
      return { success: false, error: '快捷键注册失败' };
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 注销所有全局快捷键
ipcMain.handle('unregister-all-shortcuts', async () => {
  try {
    globalShortcut.unregisterAll();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 设置存储路径
function getSettingsPath() {
  ensureDataDir();
  return path.join(DATA_DIR, 'soundpp-settings.json');
}

function getDefaultSettings() {
  return {
    enableHotkeys: true,
    defaultVolume: 70,
    muteHotkey: '',
    defaultOutputDeviceId: 'default'
  };
}

// 数据目录（用户数据目录下）
const DATA_DIR = getAppDataDir();

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

// 读取设置
ipcMain.handle('get-settings', async () => {
  try {
    const filePath = getSettingsPath();
    if (!fs.existsSync(filePath)) {
      // 兼容旧位置：从开发目录迁移（__dirname/data）或旧 userData 根迁移
      const oldDevPath = path.join(__dirname, 'data', 'soundpp-settings.json');
      const oldUserPath = path.join(app.getPath('userData'), 'soundpp-settings.json');
      if (fs.existsSync(oldDevPath)) {
        ensureDataDir();
        fs.copyFileSync(oldDevPath, filePath);
      } else if (fs.existsSync(oldUserPath)) {
        ensureDataDir();
        fs.copyFileSync(oldUserPath, filePath);
      } else {
        return { success: true, settings: getDefaultSettings() };
      }
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    return { success: true, settings: { ...getDefaultSettings(), ...parsed } };
  } catch (error) {
    return { success: false, error: error.message, settings: getDefaultSettings() };
  }
});

// 保存设置
ipcMain.handle('save-settings', async (event, settings) => {
  try {
    ensureDataDir();
    const filePath = getSettingsPath();
    const merged = { ...getDefaultSettings(), ...(settings || {}) };
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf-8');
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ========= 音频库持久化 =========
function getLibraryPath() {
  ensureDataDir();
  return path.join(DATA_DIR, 'soundpp-library.json');
}

function tryStat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function buildDefaultLibrary() {
  const items = [];
  const sampleVictory = path.join(__dirname, 'sounds', 'victory.mp3');
  const sampleFailure = path.join(__dirname, 'sounds', 'failure.mp3');
  const destVictory = copyIntoUserSoundsIfExists(sampleVictory);
  const destFailure = copyIntoUserSoundsIfExists(sampleFailure);
  if (destVictory) {
    items.push({
      id: Date.now(),
      name: '胜利音效',
      description: '示例：胜利音效',
      duration: '未知',
      shortcut: 'Ctrl+Shift+1',
      group: 'game',
      path: destVictory
    });
  }
  if (destFailure) {
    items.push({
      id: Date.now() + 1,
      name: '失败音效',
      description: '示例：失败音效',
      duration: '未知',
      shortcut: 'Ctrl+Shift+2',
      group: 'game',
      path: destFailure
    });
  }
  const groups = buildDefaultGroups();
  return { items, groups };
}

function buildDefaultGroups() {
  return [
    { id: 'ungrouped', key: 'ungrouped', name: '未分组', description: '' },
    { id: 'game', key: 'game', name: '游戏音效', description: '' },
    { id: 'meeting', key: 'meeting', name: '会议专用', description: '' },
    { id: 'entertainment', key: 'entertainment', name: '娱乐搞笑', description: '' }
  ];
}

ipcMain.handle('get-audio-library', async () => {
  try {
    const libPath = getLibraryPath();
    if (!fs.existsSync(libPath)) {
      // 若旧位置存在则迁移；否则写入默认
      const oldDevPath = path.join(__dirname, 'data', 'soundpp-library.json');
      const oldUserPath = path.join(app.getPath('userData'), 'soundpp-library.json');
      if (fs.existsSync(oldDevPath)) {
        ensureDataDir();
        fs.copyFileSync(oldDevPath, libPath);
      } else if (fs.existsSync(oldUserPath)) {
        ensureDataDir();
        fs.copyFileSync(oldUserPath, libPath);
      } else {
        const defaults = buildDefaultLibrary();
        fs.writeFileSync(libPath, JSON.stringify(defaults, null, 2), 'utf-8');
        return { success: true, items: defaults.items, groups: defaults.groups };
      }
    }
    const content = fs.readFileSync(libPath, 'utf-8');
    const parsed = JSON.parse(content);
    // 兼容旧格式（纯数组）
    if (Array.isArray(parsed)) {
      const migrated = migrateDevPathsToUserData(parsed);
      if (migrated.changed) saveLibrarySafe(migrated.items, buildDefaultGroups());
      return { success: true, items: migrated.items, groups: buildDefaultGroups() };
    }
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const groups = Array.isArray(parsed.groups) ? parsed.groups : buildDefaultGroups();
    const migrated = migrateDevPathsToUserData(items);
    if (migrated.changed) saveLibrarySafe(migrated.items, groups);
    return { success: true, items: migrated.items, groups };
  } catch (error) {
    return { success: false, error: error.message, items: [], groups: buildDefaultGroups() };
  }
});

ipcMain.handle('save-audio-library', async (event, payload) => {
  try {
    const libPath = getLibraryPath();
    // 允许两种格式：仅 items 数组；或 { items, groups }
    let toWrite;
    if (Array.isArray(payload)) {
      // 读取现有 groups
      let existingGroups = buildDefaultGroups();
      try {
        const existing = JSON.parse(fs.readFileSync(libPath, 'utf-8'));
        if (Array.isArray(existing.groups)) existingGroups = existing.groups;
      } catch {}
      toWrite = { items: payload, groups: existingGroups };
    } else if (payload && typeof payload === 'object') {
      const items = Array.isArray(payload.items) ? payload.items : [];
      const groups = Array.isArray(payload.groups) ? payload.groups : buildDefaultGroups();
      toWrite = { items, groups };
    } else {
      toWrite = { items: [], groups: buildDefaultGroups() };
    }
    ensureDataDir();
    fs.writeFileSync(libPath, JSON.stringify(toWrite, null, 2), 'utf-8');
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});


ipcMain.handle('window-minimize', () => {
  if (mainWindow) {
    mainWindow.minimize();
  }
});

ipcMain.handle('window-close', () => {
  if (mainWindow) {
    mainWindow.close();
  }
});

// ========= 分组导入/导出/分享（ZIP） =========
function ensureSoundsDirMain() {
  return getAppSoundsDir();
}

function loadLibrarySafe() {
  try {
    const libPath = getLibraryPath();
    if (!fs.existsSync(libPath)) {
      const defaults = buildDefaultLibrary();
      fs.writeFileSync(libPath, JSON.stringify(defaults, null, 2), 'utf-8');
      return defaults;
    }
    const parsed = JSON.parse(fs.readFileSync(libPath, 'utf-8'));
    if (Array.isArray(parsed)) {
      return { items: parsed, groups: buildDefaultGroups() };
    }
    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      groups: Array.isArray(parsed.groups) ? parsed.groups : buildDefaultGroups()
    };
  } catch (_) {
    return buildDefaultLibrary();
  }
}

function saveLibrarySafe(items, groups) {
  const libPath = getLibraryPath();
  const toWrite = { items: Array.isArray(items) ? items : [], groups: Array.isArray(groups) ? groups : buildDefaultGroups() };
  ensureDataDir();
  fs.writeFileSync(libPath, JSON.stringify(toWrite, null, 2), 'utf-8');
}

ipcMain.handle('export-group-zip', async (event, { groupKey }) => {
  return await exportGroupZipInternal(groupKey);
});

ipcMain.handle('import-group-zip', async (event, { targetGroupKey }) => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择要导入的分组 ZIP',
      properties: ['openFile'],
      filters: [{ name: 'ZIP 文件', extensions: ['zip'] }]
    });
    if (canceled || !filePaths || !filePaths[0]) return { success: false, canceled: true };
    const zipPath = filePaths[0];
    const zip = new AdmZip(zipPath);
    const entry = zip.getEntry('manifest.json');
    let manifest = null;
    if (entry) {
      try { manifest = JSON.parse(zip.readAsText(entry)); } catch (_) { manifest = null; }
    }
    const { items, groups } = loadLibrarySafe();
    const soundsDir = ensureSoundsDirMain();

    // 确定目标分组
    let groupKey = targetGroupKey || (manifest?.group?.key) || 'ungrouped';
    if (groupKey !== 'all' && !groups.some(g => g.key === groupKey)) {
      groups.push({ id: groupKey, key: groupKey, name: manifest?.group?.name || groupKey, description: manifest?.group?.description || '' });
    }

    // 收集 zip 中的音频文件条目
    const audioEntries = zip.getEntries().filter(e => !e.isDirectory && /^sounds\//i.test(e.entryName));
    const baseNameUsed = new Set();
    const uniqueName = (name) => {
      const parsed = path.parse(name);
      let cand = name; let i = 1;
      while (baseNameUsed.has(cand) || fs.existsSync(path.join(soundsDir, cand))) {
        cand = `${parsed.name} (${i})${parsed.ext}`; i += 1;
      }
      baseNameUsed.add(cand);
      return cand;
    };

    const mapEntryToFilePath = new Map();
    audioEntries.forEach(e => {
      const base = path.basename(e.entryName);
      const outName = uniqueName(base);
      const outPath = path.join(soundsDir, outName);
      fs.writeFileSync(outPath, e.getData());
      mapEntryToFilePath.set(base, outPath);
    });

    // 根据 manifest 或仅音频文件生成 items
    const imported = [];
    if (manifest && Array.isArray(manifest.items)) {
      manifest.items.forEach((it, idx) => {
        const base = it.src ? path.basename(it.src) : '';
        const outPath = base ? (mapEntryToFilePath.get(base) || '') : '';
        if (!outPath) return;
        imported.push({
          id: Date.now() + idx,
          name: it.name || base,
          description: it.description || '导入的音频文件',
          duration: it.duration || '未知',
          shortcut: '',
          group: groupKey,
          path: outPath
        });
      });
    } else {
      // 无 manifest，按文件名导入
      Array.from(mapEntryToFilePath.entries()).forEach(([base, outPath], i) => {
        imported.push({
          id: Date.now() + i,
          name: path.parse(base).name,
          description: '导入的音频文件',
          duration: '未知',
          shortcut: '',
          group: groupKey,
          path: outPath
        });
      });
    }

    if (imported.length === 0) {
      return { success: false, error: 'ZIP 中未找到可导入的音频' };
    }

    // 合并并保存
    const newItems = items.concat(imported);
    saveLibrarySafe(newItems, groups);
    return { success: true, count: imported.length };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('share-group-zip', async (event, { groupKey }) => {
  const result = await exportGroupZipInternal(groupKey);
  if (result && result.success && result.path) {
    try { shell.showItemInFolder(result.path); } catch (_) {}
  }
  return result || { success: false, error: '分享失败' };
});

// 将导出逻辑抽出，供 share 复用
async function exportGroupZipInternal(groupKey) {
  try {
    const { items, groups } = loadLibrarySafe();
    if (!groupKey || groupKey === 'all') {
      return { success: false, error: '请选择具体分组后再导出' };
    }
    const list = items.filter(it => (it.group || 'ungrouped') === groupKey);
    if (list.length === 0) {
      return { success: false, error: '该分组暂无音频可导出' };
    }
    const grp = (groups || []).find(g => g.key === groupKey) || { key: groupKey, name: groupKey };
    const defaultFileName = `SoundPP-${grp.key}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0,14)}.zip`;
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出分组为 ZIP',
      defaultPath: defaultFileName,
      filters: [{ name: 'ZIP 文件', extensions: ['zip'] }]
    });
    if (canceled || !filePath) return { success: false, canceled: true };

    const zip = new AdmZip();
    const manifest = {
      app: 'soundpp',
      version: app.getVersion ? app.getVersion() : '0.0.0',
      exportedAt: new Date().toISOString(),
      group: { key: grp.key, name: grp.name, description: grp.description || '' },
      items: list.map(({ id, name, description, duration, shortcut, group, path: p }) => ({ id, name, description, duration, shortcut, group, src: p }))
    };
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'));
    const soundsFolder = 'sounds/';
    list.forEach((it) => {
      const src = it.path || '';
      try {
        const abs = path.isAbsolute(src) ? src : path.join(__dirname, src);
        if (fs.existsSync(abs)) {
          const base = path.basename(abs);
          const buf = fs.readFileSync(abs);
          zip.addFile(soundsFolder + base, buf);
        }
      } catch (_) {}
    });
    zip.writeZip(filePath);
    return { success: true, path: filePath };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// 向渲染进程暴露路径
ipcMain.handle('get-app-paths', async () => {
  try {
    return { dataDir: getAppDataDir(), soundsDir: getAppSoundsDir() };
  } catch (e) {
    return { dataDir: DATA_DIR, soundsDir: ensureSoundsDirMain() };
  }
});

// 打开 sounds 目录
ipcMain.handle('open-sounds-dir', async (event, preferredPath) => {
  try {
    const target = (preferredPath && typeof preferredPath === 'string' && fs.existsSync(preferredPath))
      ? preferredPath
      : getAppSoundsDir();
    if (target && fs.existsSync(target)) {
      await shell.openPath(target);
      return { success: true };
    }
    return { success: false, error: '目录不存在' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ===== 辅助：将样例或旧路径复制到用户 sounds 目录，并返回新绝对路径 =====
function copyIntoUserSoundsIfExists(src) {
  try {
    if (!src || !fs.existsSync(src)) return '';
    const soundsDir = getAppSoundsDir();
    const base = path.basename(src);
    let dest = path.join(soundsDir, base);
    const parsed = path.parse(base);
    let i = 1;
    while (fs.existsSync(dest)) {
      dest = path.join(soundsDir, `${parsed.name} (${i})${parsed.ext}`);
      i += 1;
    }
    fs.copyFileSync(src, dest);
    return dest;
  } catch (_) {
    return '';
  }
}

function isUnderDir(targetPath, parentDir) {
  try {
    const t = path.resolve(targetPath);
    const p = path.resolve(parentDir);
    return t.toLowerCase().startsWith(p.toLowerCase() + path.sep);
  } catch (_) {
    return false;
  }
}

function migrateDevPathsToUserData(items) {
  const list = Array.isArray(items) ? items.slice() : [];
  let changed = false;
  const devSounds = path.join(__dirname, 'sounds');
  for (let idx = 0; idx < list.length; idx++) {
    const it = list[idx];
    const p = (it && it.path) ? String(it.path) : '';
    if (!p) continue;
    const abs = path.isAbsolute(p) ? p : path.join(__dirname, p);
    if (isUnderDir(abs, devSounds) || isUnderDir(abs, __dirname)) {
      const newPath = copyIntoUserSoundsIfExists(abs);
      if (newPath) {
        list[idx] = { ...it, path: newPath };
        changed = true;
      }
    }
  }
  return { items: list, changed };
}