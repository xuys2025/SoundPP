// 应用主要功能脚本
const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
let WaveSurfer;
try { WaveSurfer = require('wavesurfer.js'); } catch (_) { WaveSurfer = null; }
let RegionsPluginModule = null; // ESM 模块（需动态 import）

// DOM 元素
const importBtn = document.getElementById('importBtn');
const settingsBtn = document.getElementById('settingsBtn');
const openSoundsBtn = document.getElementById('openSoundsBtn');
const addGroupBtn = document.getElementById('addGroupBtn');
const searchInput = document.getElementById('searchInput');
const addGroupNameInput = document.getElementById('addGroupNameInput');
const addGroupConfirmBtn = document.getElementById('addGroupConfirmBtn');
const addGroupCancelBtn = document.getElementById('addGroupCancelBtn');
const importModal = document.getElementById('importModal');
const editModal = document.getElementById('editModal');
const settingsModal = document.getElementById('settingsModal');
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const volumeSlider = document.getElementById('volumeSlider');
const volumeValue = document.getElementById('volumeValue');
let isMuted = false;
let lastVolumeBeforeMute = 0.7; // 0-1

// 应用状态
let currentGroup = 'all';
let globalVolume = 0.7; // 全局音量 (0-1)
let currentAudio = null; // 当前播放的音频对象
let currentPlayingId = null; // 当前播放的音频ID
let activeNotifications = []; // 当前显示的通知列表
let audioFiles = [];
let editingAudioId = null; // 正在编辑的音频ID
let waveformInstance = null;
let groups = [];
// 批量选择/删除状态
let isBulkSelectMode = false;
const bulkSelectedIds = new Set();
// 拖拽兜底：记录当前拖拽的音频ID
let currentDraggingAudioId = null;

// 初始化应用
function initApp() {
    setupEventListeners();
    
    // 添加淡入动画
    document.querySelector('.app-container').classList.add('fade-in');
    
    // 先加载音频库，再渲染与应用设置
    loadAudioLibrary().then(() => {
        // 启动时清理 sounds 目录中未被引用的文件
        try { cleanupUnreferencedSounds(); } catch (_) {}
        renderAudioList();
        updateGroupCounts();
        fillMissingDurations();
        loadSettingsAndApply();
    }).catch(() => {
        try { cleanupUnreferencedSounds(); } catch (_) {}
        renderAudioList();
        updateGroupCounts();
        fillMissingDurations();
        loadSettingsAndApply();
    });

    // 注入批量操作控件
    injectBulkControls();
}

// 设置事件监听器
function setupEventListeners() {
    // 窗口控制按钮
    const minimizeBtn = document.getElementById('minimize-btn');
    const closeBtn = document.getElementById('close-btn');
    
    if (minimizeBtn) {
        minimizeBtn.addEventListener('click', () => {
            ipcRenderer.invoke('window-minimize');
        });
    }
    
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            ipcRenderer.invoke('window-close');
        });
    }
    
    // 工具栏按钮
    importBtn.addEventListener('click', showImportModal);
    settingsBtn.addEventListener('click', showSettings);
    if (openSoundsBtn) openSoundsBtn.addEventListener('click', openSoundsDirectory);
    addGroupBtn.addEventListener('click', addNewGroup);
    
    // 搜索功能
    searchInput.addEventListener('input', handleSearch);
    
    // 分组切换（首次绑定；之后由渲染侧边栏时重绑）
    bindGroupListEvents();
    // 分组右键菜单（事件委托，避免动态渲染后失效）
    setupGroupContextMenu();
    
    // 模态框关闭
    document.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', closeModals);
    });
    
    // 点击模态框外部关闭
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModals();
        });
    });
    
    // 文件拖拽
    setupFileDrop();
    
    // 文件选择
    fileInput.addEventListener('change', handleFileSelect);
    
    // 键盘快捷键
    document.addEventListener('keydown', handleKeyboard);
    
    // 为音频列表按钮添加事件监听器（使用事件委托）
    setupAudioListeners();
    
    // 音量控制
    setupVolumeControl();

    // 设置事件
    setupSettingsHandlers();

    // 主界面添加一键静音按钮
    injectMuteButton();

    // 批量操作事件
    bindBulkControls();
}

// 设置音频列表事件监听器
function setupAudioListeners() {
    // 使用事件委托为动态生成的按钮添加事件监听器
    const audioList = document.querySelector('.audio-list');
    
    audioList.addEventListener('click', (e) => {
        const button = e.target.closest('button');
        if (!button) return;
        
        const audioItem = button.closest('.audio-item');
        if (!audioItem) return;
        
        const audioId = audioItem.dataset.id;
        
        if (button.classList.contains('play-btn')) {
            if (audioId) {
                playAudio(parseInt(audioId));
            } else {
                // 处理静态HTML中的音频项目
                const audioItems = Array.from(document.querySelectorAll('.audio-item'));
                const index = audioItems.indexOf(audioItem);
                if (index >= 0 && index < audioFiles.length) {
                    playAudio(audioFiles[index].id);
                }
            }
        } else if (button.classList.contains('edit-btn')) {
            if (audioId) {
                editAudio(parseInt(audioId));
            } else {
                const audioItems = Array.from(document.querySelectorAll('.audio-item'));
                const index = audioItems.indexOf(audioItem);
                if (index >= 0 && index < audioFiles.length) {
                    editAudio(audioFiles[index].id);
                }
            }
        } else if (button.classList.contains('delete-btn')) {
            if (audioId) {
                deleteAudio(parseInt(audioId));
            } else {
                const audioItems = Array.from(document.querySelectorAll('.audio-item'));
                const index = audioItems.indexOf(audioItem);
                if (index >= 0 && index < audioFiles.length) {
                    deleteAudio(audioFiles[index].id);
                }
            }
        }
    });

    // 拖拽开始：标记被拖拽的音频ID
    audioList.addEventListener('dragstart', (e) => {
        const item = e.target.closest('.audio-item');
        if (!item) return;
        const id = item.dataset.id;
        if (!id) return;
        try {
            e.dataTransfer.setData('text/soundpp-audio-id', String(id));
            e.dataTransfer.setData('text/plain', 'A:' + String(id));
            e.dataTransfer.effectAllowed = 'move';
        } catch (_) {}
        // 兜底：记录当前拖拽的音频ID
        currentDraggingAudioId = String(id);
    });
    // 拖拽结束：清理兜底ID
    audioList.addEventListener('dragend', () => {
        currentDraggingAudioId = null;
    });

    // 监听批量选择复选框
    audioList.addEventListener('change', (e) => {
        const checkbox = e.target.closest('.bulk-select');
        if (!checkbox) return;
        const audioItem = checkbox.closest('.audio-item');
        if (!audioItem) return;
        const idStr = audioItem.dataset.id;
        if (!idStr) return;
        const id = parseInt(idStr, 10);
        if (checkbox.checked) {
            bulkSelectedIds.add(id);
        } else {
            bulkSelectedIds.delete(id);
        }
        updateBulkDeleteButtonCount();
    });
}

// 设置音量控制
function setupVolumeControl() {
    if (volumeSlider && volumeValue) {
        // 音量滑块变化事件
        volumeSlider.addEventListener('input', (e) => {
            const volume = parseInt(e.target.value);
            globalVolume = volume / 100;
            volumeValue.textContent = volume + '%';
            
    
            updateVolumeIcon(volume);
            
    
            if (currentAudio && !currentAudio.paused) {
                currentAudio.volume = globalVolume;
        
            }

            // 若从静音状态拖动音量，则自动取消静音
            if (isMuted && globalVolume > 0) {
                isMuted = false;
            }
            
    
        });
        
        // 按当前滑块值初始化音量图标
        const initVol = parseInt(volumeSlider.value || '70', 10);
        updateVolumeIcon(initVol);
    }
}

// 更新音量图标
function updateVolumeIcon(volume) {
    const volumeIcon = document.querySelector('.volume-icon');
    if (volumeIcon) {
        if (volume === 0) {
            volumeIcon.className = 'fas fa-volume-mute volume-icon';
        } else if (volume < 30) {
            volumeIcon.className = 'fas fa-volume-down volume-icon';
        } else {
            volumeIcon.className = 'fas fa-volume-up volume-icon';
        }
    }
}

// 渲染音频列表
function renderAudioList(filter = '') {
    const audioList = document.querySelector('.audio-list');
    // 在切换分组/过滤时，锁定容器高度以减轻重排跳动
    const prevHeight = audioList.getBoundingClientRect().height;
    audioList.style.minHeight = prevHeight + 'px';
    const filteredFiles = audioFiles.filter(file => {
        const matchesGroup = currentGroup === 'all' || file.group === currentGroup || (!file.group && currentGroup === 'ungrouped');
        const matchesSearch = filter === '' || 
            file.name.toLowerCase().includes(filter.toLowerCase()) ||
            file.description.toLowerCase().includes(filter.toLowerCase());
        return matchesGroup && matchesSearch;
    });
    
    audioList.innerHTML = filteredFiles.map(file => {
        // 检查是否是当前播放的音频
        const isPlaying = currentPlayingId === file.id;
        const playIcon = isPlaying ? 'fas fa-stop' : 'fas fa-play';
        const playBtnStyle = isPlaying ? 'background: #dc3545; color: white;' : '';
        const playTitle = isPlaying ? '停止' : '播放';
        const isChecked = bulkSelectedIds.has(file.id) ? 'checked' : '';
        const bulkBox = isBulkSelectMode ? `<input type="checkbox" class="bulk-select" ${isChecked} title="选择" />` : '';

        return `
        <div class="audio-item" data-id="${file.id}" draggable="true">
            <div class="audio-info">
                ${bulkBox}
                <div class="audio-icon">
                    <i class="fas fa-music"></i>
                </div>
                <div class="audio-details">
                    <h4>${file.name}</h4>
                    <p>${file.description}</p>
                    <span class="audio-duration">${file.duration}</span>
                </div>
            </div>
            <div class="audio-shortcut">
                <span class="shortcut-display">${formatShortcutForDisplay(file.shortcut)}</span>
            </div>
            <div class="audio-actions">
                <button class="btn-icon play-btn ${isPlaying ? 'playing' : ''}" title="${playTitle}">
                    <i class="${playIcon}"></i>
                </button>
                <button class="btn-icon edit-btn" title="编辑">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="btn-icon delete-btn" title="删除">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>
        `;
    }).join('');
    // 释放最小高度锁
    requestAnimationFrame(() => { audioList.style.minHeight = ''; });
    // 更新内容标题
    const current = (currentGroup === 'all') ? { name: '全部音频' } : (groups||[]).find(g => g.key === currentGroup);
    document.querySelector('.content-header h2').textContent = current ? current.name : '全部音频';
    // 不在主界面显示分组描述（按需求移除展示）

    // 渲染结束后，若在批量模式，更新操作栏显示与数量
    updateBulkUIVisibility();
    updateBulkDeleteButtonCount();
}

// 注入批量操作控件（按钮）
function injectBulkControls() {
    const header = document.querySelector('.content-header');
    if (!header || header.querySelector('#bulkControls')) return;
    const container = document.createElement('div');
    container.id = 'bulkControls';
    container.style.display = 'flex';
    container.style.gap = '8px';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn btn-secondary';
    toggleBtn.id = 'bulkToggleBtn';
    toggleBtn.textContent = '批量选择';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-primary';
    deleteBtn.id = 'bulkDeleteBtn';
    deleteBtn.textContent = '删除 (0)';

    container.appendChild(toggleBtn);
    container.appendChild(deleteBtn);
    header.appendChild(container);
    updateBulkUIVisibility();
    updateBulkDeleteButtonCount();
    // 创建后立即绑定事件
    bindBulkControls();
}

function bindBulkControls() {
    const toggleBtn = document.getElementById('bulkToggleBtn');
    const deleteBtn = document.getElementById('bulkDeleteBtn');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            isBulkSelectMode = !isBulkSelectMode;
            if (!isBulkSelectMode) bulkSelectedIds.clear();
            renderAudioList(searchInput.value);
            updateBulkUIVisibility();
        });
    }
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
            if (bulkSelectedIds.size === 0) return;
            deleteAudios(Array.from(bulkSelectedIds));
        });
    }
}

function updateBulkUIVisibility() {
    const container = document.getElementById('bulkControls');
    const toggleBtn = document.getElementById('bulkToggleBtn');
    const deleteBtn = document.getElementById('bulkDeleteBtn');
    if (!container || !toggleBtn || !deleteBtn) return;
    toggleBtn.textContent = isBulkSelectMode ? '退出批量' : '批量选择';
    deleteBtn.style.display = isBulkSelectMode ? 'inline-flex' : 'none';
}

function updateBulkDeleteButtonCount() {
    const deleteBtn = document.getElementById('bulkDeleteBtn');
    if (!deleteBtn) return;
    deleteBtn.textContent = `删除 (${bulkSelectedIds.size})`;
    deleteBtn.disabled = bulkSelectedIds.size === 0;
}

// 更新分组计数
function updateGroupCounts() {
    renderGroupSidebar();
    
    // 更新状态栏
    document.querySelector('.status-left .status-item:nth-child(2)').innerHTML = `
        <i class="fas fa-music"></i>
        共 ${audioFiles.length} 个音频文件
    `;
    
    const shortcutCount = audioFiles.filter(f => f.shortcut).length;
    document.querySelector('.status-right .status-item').innerHTML = `
        <i class="fas fa-keyboard"></i>
        ${shortcutCount} 个快捷键已设置
    `;
}

function renderGroupSidebar() {
    const sidebarList = document.querySelector('.group-list');
    if (!sidebarList) return;
    const countByKey = new Map();
    audioFiles.forEach(f => {
        const key = f.group || 'ungrouped';
        countByKey.set(key, (countByKey.get(key) || 0) + 1);
    });
    const allCount = audioFiles.length;
    const itemsHtml = [`
        <div class=\"group-item ${currentGroup==='all'?'active':''}\" data-group=\"all\">
            <i class=\"fas fa-music\"></i>
            <span>全部音频</span>
            <span class=\"count\">${allCount}</span>
        </div>
    `].concat((groups||[]).map(g => {
        // 确保 data-group 属性值安全且有效
        const safeKey = String(g.key || '').replace(/['"<>&]/g, '');
        return `
        <div class=\"group-item ${currentGroup===g.key?'active':''}\" data-group=\"${safeKey}\" draggable=\"true\">
            <i class=\"fas fa-folder\"></i>
            <span>${g.name}</span>
            <span class=\"count\">${countByKey.get(g.key)||0}</span>
        </div>
        `;
    })).join('');
    sidebarList.innerHTML = itemsHtml;
    bindGroupListEvents();
}

function bindGroupListEvents() {
    document.querySelectorAll('.group-item').forEach(item => {
        item.addEventListener('click', () => switchGroup(item.dataset.group));

        // 拖拽目标行为：允许拖拽音频放入该分组
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; } catch (_) {}
            item.classList.add('drag-over');
        });
        item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            // 若成功处理音频放置，阻止后续冒泡到排序 drop
            item.classList.remove('drag-over');
            // 兼容读取自定义与 text/plain 回退格式
            let id = '';
            try { id = e.dataTransfer.getData('text/soundpp-audio-id') || ''; } catch (_) { id = ''; }
            if (!id) {
                try {
                    const plain = (e.dataTransfer.getData('text/plain') || '').trim();
                    const m = /^A:(\d+)$/.exec(plain);
                    if (m) id = m[1];
                } catch (_) { /* ignore */ }
            }
            // 最后再次兜底：使用全局拖拽ID
            if (!id && currentDraggingAudioId) {
                id = String(currentDraggingAudioId);
            }
            if (!id) return;
            const audio = audioFiles.find(a => String(a.id) === String(id));
            if (!audio) return;
            const key = item.dataset.group;
            if (!key || key === 'all') return;
            audio.group = key;
            persistLibrary();
            renderAudioList(searchInput.value);
            updateGroupCounts();
            showNotification('已移动到分组');
            // 明确阻止事件冒泡，避免触发排序 drop 监听
            try { e.stopPropagation(); } catch (_) {}
        });

        // 分组排序：拖拽分组项到另一个分组项位置
        item.addEventListener('dragstart', (e) => {
            try { e.dataTransfer.setData('text/soundpp-group-key', item.dataset.group); } catch (_) {}
        });
        item.addEventListener('drop', (e) => {
            // 若是音频放置，忽略排序逻辑
            try { if (e.dataTransfer && e.dataTransfer.getData('text/soundpp-audio-id')) return; } catch (_) {}
            const from = e.dataTransfer.getData('text/soundpp-group-key');
            const to = item.dataset.group;
            if (!from || !to || from === to || to === 'all') return;
            const fromIdx = (groups||[]).findIndex(g => g.key === from);
            const toIdx = (groups||[]).findIndex(g => g.key === to);
            if (fromIdx === -1 || toIdx === -1) return;
            const moving = groups.splice(fromIdx, 1)[0];
            groups.splice(toIdx, 0, moving);
            persistLibrary();
            updateGroupCounts();
        });
    });
}

function setupGroupContextMenu() {
    const sidebarList = document.querySelector('.group-list');
    if (!sidebarList) return;
    // 清理旧菜单
    removeExistingContextMenu();
    // 右键事件委托，展示自定义菜单
    sidebarList.addEventListener('contextmenu', (e) => {
        const item = e.target.closest('.group-item');
        if (!item || !sidebarList.contains(item)) return;
        e.preventDefault();
        const key = item.dataset.group;
        const grp = (groups||[]).find(g => g.key === key);
        // "全部音频" 不提供导出/重命名/删除
        if (key === 'all') return;

        const menuItems = [];
        if (grp && key !== 'ungrouped') {
            menuItems.push(
                { key: 'rename', label: '重命名分组' },
                { key: 'editdesc', label: '编辑分组描述' }
            );
        }
        // 基于分组导入/导出/分享
        menuItems.push(
            { key: 'exportzip', label: '导出分组 ZIP' },
            { key: 'importzip', label: '导入 ZIP 到该分组' },
            { key: 'sharezip', label: '分享（导出并在文件夹中显示）' }
        );
        if (grp && key !== 'ungrouped') {
            menuItems.push({ key: 'delete', label: '删除分组', danger: true });
        }

        if (menuItems.length === 0) return;
        showContextMenu(e.clientX, e.clientY, menuItems, (action) => {
            if (action === 'rename') {
                setTimeout(() => safeStartGroupRename(item, grp), 0);
            } else if (action === 'editdesc') {
                setTimeout(() => openEditGroupModal(key), 0);
            } else if (action === 'delete') {
                if (confirm(`删除分组 “${grp?.name || key}”？该分组中的音频将移入“未分组”。`)) {
                    deleteGroup(key);
                }
            } else if (action === 'exportzip') {
                exportGroupZip(key);
            } else if (action === 'importzip') {
                importGroupZip(key);
            } else if (action === 'sharezip') {
                shareGroupZip(key);
            }
        });
    }, false);

    // 全局点击关闭菜单
    document.addEventListener('click', removeExistingContextMenu);
}

// 导出分组为 ZIP
async function exportGroupZip(groupKey) {
    try {
        const res = await ipcRenderer.invoke('export-group-zip', { groupKey });
        if (res && res.success) {
            showNotification('导出成功：已生成 ZIP');
        } else if (!res?.canceled) {
            showNotification('导出失败' + (res?.error ? `：${res.error}` : ''));
        }
    } catch (e) {
        showNotification('导出失败：' + (e?.message || '未知错误'));
    }
}

// 导入 ZIP 到指定分组
async function importGroupZip(targetGroupKey) {
    try {
        const res = await ipcRenderer.invoke('import-group-zip', { targetGroupKey });
        if (res && res.success) {
            await loadAudioLibrary();
            renderAudioList(searchInput.value);
            updateGroupCounts();
            showNotification(`导入成功：${res.count || 0} 个音频`);
        } else if (!res?.canceled) {
            showNotification('导入失败' + (res?.error ? `：${res.error}` : ''));
        }
    } catch (e) {
        showNotification('导入失败：' + (e?.message || '未知错误'));
    }
}

// 分享：导出后在资源管理器中显示
async function shareGroupZip(groupKey) {
    try {
        const res = await ipcRenderer.invoke('share-group-zip', { groupKey });
        if (res && res.success) {
            showNotification('已导出并打开文件所在位置');
        } else if (!res?.canceled) {
            showNotification('分享失败' + (res?.error ? `：${res.error}` : ''));
        }
    } catch (e) {
        showNotification('分享失败：' + (e?.message || '未知错误'));
    }
}

function safeStartGroupRename(item, grp) {
    try {
        startInlineGroupRename(item, grp);
    } catch (_) {
        // 兜底：使用提示框方式重命名
        const newName = prompt('输入新分组名称：', grp.name);
        if (newName && newName.trim()) {
            grp.name = newName.trim();
            persistLibrary();
            updateGroupCounts();
            showNotification('分组已重命名');
        }
    }
}

function startInlineGroupRename(groupItemEl, grp) {
    if (!groupItemEl || !grp) return;
    const nameSpan = groupItemEl.querySelector('span:not(.count)');
    if (!nameSpan) return;
    const original = grp.name;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-input';
    input.value = original;
    input.style.width = Math.max(120, nameSpan.clientWidth + 40) + 'px';
    // 插入并聚焦
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    const finish = (commit) => {
        const newName = (input.value || '').trim();
        const span = document.createElement('span');
        span.textContent = commit && newName ? newName : original;
        input.replaceWith(span);
        if (commit && newName && newName !== original) {
            grp.name = newName;
            persistLibrary();
            updateGroupCounts();
            showNotification('分组已重命名');
        }
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
        }
    });
    input.addEventListener('blur', () => finish(true));
}

function showContextMenu(x, y, items, onSelect) {
    removeExistingContextMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    items.forEach(it => {
        const el = document.createElement('div');
        el.className = 'menu-item' + (it.danger ? ' danger' : '');
        el.textContent = it.label;
        const handler = (e) => {
            e.stopPropagation();
            if (onSelect) onSelect(it.key);
            removeExistingContextMenu();
        };
        el.addEventListener('mousedown', handler, { once: true });
        el.addEventListener('click', handler, { once: true });
        menu.appendChild(el);
    });
    document.body.appendChild(menu);
}

function removeExistingContextMenu() {
    document.querySelectorAll('.context-menu').forEach(el => el.remove());
}

// 切换分组
function switchGroup(group) {
    currentGroup = group;
    
    // 更新活动状态
    document.querySelectorAll('.group-item').forEach(item => {
        item.classList.remove('active');
    });
    document.querySelector(`[data-group="${group}"]`).classList.add('active');
    
    // 重新渲染列表
    renderAudioList(searchInput.value);
}

// 搜索处理
function handleSearch(e) {
    renderAudioList(e.target.value);
}

// 播放音频
async function playAudio(id) {
    const file = audioFiles.find(f => f.id === id);
    if (!file) {
        return;
    }
    
    const playBtn = document.querySelector(`[data-id="${id}"] .play-btn`);
    if (!playBtn) {
        return;
    }
    const icon = playBtn.querySelector('i');
    
    // 如果当前正在播放这个音频，则停止播放并返回
    if (currentPlayingId === id) {
        await stopCurrentAudio();
        return;
    }
    
    // 如果有其他音频在播放，先安全停止
    if (currentPlayingId !== null) {
        await stopCurrentAudio();
    }

    // 设置当前播放ID并更新按钮状态（此时已无其它播放，避免被复位逻辑覆盖）
    currentPlayingId = id;
    icon.className = 'fas fa-stop';
    playBtn.classList.add('playing');
    
    // 通过主进程补全绝对路径并回传播放（无需再次停止）
    try {
        await ipcRenderer.invoke('play-audio', file.path);
    } catch (e) {
        showNotification('音频播放失败：' + (e?.message || '未知错误'));
    }
}

// 编辑音频
function editAudio(id) {
    const file = audioFiles.find(f => f.id === id);
    if (file) {
        showEditModal(file);
    }
}

// 删除音频
function deleteAudio(id) {
    if (confirm('确定要删除这个音频文件吗？')) {
        audioFiles = audioFiles.filter(f => f.id !== id);
        renderAudioList(searchInput.value);
        updateGroupCounts();
        showNotification('音频文件已删除');
        saveAudioLibrary(audioFiles);
        try { cleanupUnreferencedSounds(); } catch (_) {}
    }
}

// 批量删除
function deleteAudios(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    if (!confirm(`确定要删除选中的 ${ids.length} 个音频吗？`)) return;
    const idSet = new Set(ids.map(v => parseInt(v, 10)));
    audioFiles = audioFiles.filter(f => !idSet.has(f.id));
    persistLibrary();
    renderAudioList(searchInput.value);
    updateGroupCounts();
    showNotification(`已删除 ${ids.length} 个音频`);
    bulkSelectedIds.clear();
    isBulkSelectMode = false;
    updateBulkUIVisibility();
    try { cleanupUnreferencedSounds(); } catch (_) {}
}

// 显示导入模态框
function showImportModal() {
    importModal.classList.add('show');
}

// 显示编辑模态框
function showEditModal(file) {
    const modal = editModal;
    editingAudioId = file.id;
    const nameInput = document.getElementById('editNameInput');
    const descInput = document.getElementById('editDescInput');
    const groupSelect = document.getElementById('editGroupSelect');
    const shortcutInput = document.getElementById('editShortcutInput');
    const recordBtn = document.getElementById('editShortcutRecordBtn');

    if (nameInput) nameInput.value = file.name || '';
    if (descInput) descInput.value = file.description || '';
    if (groupSelect) {
        // 生成分组选项，确保 value 属性安全且有效
        const options = (groups||[]).map(g => {
            const safeKey = String(g.key || '').replace(/['"<>&]/g, '');
            const safeName = String(g.name || '').replace(/[<>&]/g, '');
            return `<option value="${safeKey}">${safeName}</option>`;
        }).join('');
        groupSelect.innerHTML = options + `<option value="ungrouped">未分组</option>`;
        const value = file.group || 'ungrouped';
        groupSelect.value = value;
        // 如果当前分组不在选项中，默认选择"未分组"
        if (groupSelect.value !== value) {
            groupSelect.value = 'ungrouped';
        }
    }
    if (shortcutInput) {
        shortcutInput.value = (file.shortcut ? humanizeAccelerator(file.shortcut) : '未设置');
        shortcutInput.dataset.accelerator = file.shortcut || '';
    }

    if (recordBtn && shortcutInput) {
        recordBtn.onclick = () => startRecordingHotkey(shortcutInput, recordBtn);
    }

    const saveBtn = document.getElementById('editSaveBtn');
    const cancelBtn = document.getElementById('editCancelBtn');
    if (cancelBtn) cancelBtn.onclick = () => { modal.classList.remove('show'); editingAudioId = null; };
    if (saveBtn) saveBtn.onclick = onConfirmEditSave;

    // 初始化波形
    initWaveformPreview(file);
    const playBtn = document.getElementById('editPreviewPlayBtn');
    const stopBtn = document.getElementById('editPreviewStopBtn');
    const sliceBtn = document.getElementById('editSliceBtn');
    if (playBtn) {
        playBtn.onclick = () => waveformPlayToggle(playBtn);
        // 初始化为播放图标
        const i = playBtn.querySelector('i');
        if (i) i.className = 'fas fa-play';
        playBtn.dataset.state = 'paused';
    }
    if (stopBtn) stopBtn.onclick = () => waveformStop(playBtn);
    if (sliceBtn) sliceBtn.onclick = () => sliceCurrentSelection(file);
    
    modal.classList.add('show');
    // 进入编辑模态时，确保不存在残留的热键录制，避免抢占输入焦点
    try { if (window.__hotkeyRecordingCleanup) window.__hotkeyRecordingCleanup(); } catch (_) {}
}

function onConfirmEditSave() {
    const modal = editModal;
    const nameInput = document.getElementById('editNameInput');
    const descInput = document.getElementById('editDescInput');
    const groupSelect = document.getElementById('editGroupSelect');
    const shortcutInput = document.getElementById('editShortcutInput');
    const target = audioFiles.find(f => f.id === editingAudioId);
    if (!target) {
        showNotification('未找到要保存的音频条目');
        return;
    }
    const newName = (nameInput?.value || '').trim() || target.name;
    const newDesc = (descInput?.value || '').trim();
    const newGroup = (groupSelect?.value || 'ungrouped');
    const newShortcut = (shortcutInput?.dataset?.accelerator || '').trim();

    target.name = newName;
    target.description = newDesc;
    target.group = newGroup;
    target.shortcut = newShortcut;

    // 保存库
    persistLibrary();
    renderAudioList(searchInput.value);
    updateGroupCounts();
    showNotification('音频信息已保存');

    // 更新快捷键注册
    ipcRenderer.invoke('unregister-all-shortcuts').then(() => {
        return ipcRenderer.invoke('get-settings');
    }).then(res => {
        const enabled = res?.settings?.enableHotkeys !== false;
        if (enabled) {
            registerInitialShortcuts();
            const muteHotkey = res?.settings?.muteHotkey || '';
            if (muteHotkey) {
                ipcRenderer.invoke('register-shortcut', normalizeShortcut(muteHotkey), 'MUTE_TOGGLE').catch(() => {});
            }
        }
    }).catch(() => {});

    // 关闭
    modal.classList.remove('show');
    // 若键盘录制处于活动状态，强制结束
    try { if (window.__hotkeyRecordingCleanup) window.__hotkeyRecordingCleanup(); } catch (_) {}
    editingAudioId = null;
    disposeWaveform();
}

function slugify(name) {
    if (!name || typeof name !== 'string') return '';
    // 先尝试标准 slug 化（适用于英文/数字）
    let slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
    // 如果结果为空（如纯中文），则使用简单的哈希方案
    if (!slug) {
        // 为中文或特殊字符生成基于内容的唯一 key
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            const char = name.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // 转换为 32bit 整数
        }
        slug = 'group-' + Math.abs(hash).toString(36);
    }
    return slug;
}

function deleteGroup(key) {
    audioFiles.forEach(f => {
        if (f.group === key) f.group = 'ungrouped';
    });
    groups = (groups||[]).filter(g => g.key !== key);
    if (currentGroup === key) currentGroup = 'all';
    persistLibrary();
    updateGroupCounts();
    renderAudioList(searchInput.value);
    showNotification('分组已删除，音频已移入“未分组”');
}

function persistLibrary() {
    ipcRenderer.invoke('save-audio-library', { items: audioFiles, groups }).catch(()=>{});
}

async function initWaveformPreview(file) {
    disposeWaveform();
    if (!WaveSurfer) return;
    const container = document.getElementById('waveform');
    if (!container) return;
    try {
        const config = {
            container,
            height: 120,
            waveColor: '#90caf9',
            progressColor: '#90caf9',
            cursorColor: '#1e88e5',
            responsive: true,
            partialRender: true
        };
        // 动态加载 regions 插件（在 Electron 渲染进程中以 ESM 加载）
        const maybeEnableRegions = async () => {
            try {
                if (!RegionsPluginModule) {
                    RegionsPluginModule = await import('wavesurfer.js/dist/plugins/regions.esm.js');
                }
                if (RegionsPluginModule && RegionsPluginModule.default) {
                    config.plugins = [RegionsPluginModule.default.create({ dragSelection: true })];
                }
            } catch (_) {}
        };
        // 等待插件加载后再创建实例
        await maybeEnableRegions();
        waveformInstance = WaveSurfer.create(config);
        const src = 'file:///' + String(file.path || '').replace(/\\/g, '/');
        waveformInstance.load(src);
        // 回退：若插件不可用，则启用手动框选
        if (!config.plugins) {
            enableManualSelection();
        }
    } catch (_) {
        waveformInstance = null;
    }
}

function waveformPlayToggle(btn) {
    if (!waveformInstance || !btn) return;
    const icon = btn.querySelector('i');
    const label = document.getElementById('editPreviewPlayLabel');
    const isPaused = btn.dataset.state !== 'playing';
    waveformInstance.playPause();
    if (isPaused) {
        btn.dataset.state = 'playing';
        if (icon) icon.className = 'fas fa-pause';
        if (label) label.textContent = '暂停';
    } else {
        btn.dataset.state = 'paused';
        if (icon) icon.className = 'fas fa-play';
        if (label) label.textContent = '播放';
    }
}

function waveformStop(playBtn) {
    if (waveformInstance) {
        waveformInstance.stop();
    }
    if (playBtn) {
        const icon = playBtn.querySelector('i');
        playBtn.dataset.state = 'paused';
        if (icon) icon.className = 'fas fa-play';
        const label = document.getElementById('editPreviewPlayLabel');
        if (label) label.textContent = '播放';
    }
}

function disposeWaveform() {
    if (waveformInstance) {
        try { waveformInstance.destroy(); } catch (_) {}
        waveformInstance = null;
    }
    // 移除手动选区与监听
    if (window.__wfManualSelCleanup) {
        try { window.__wfManualSelCleanup(); } catch (_) {}
        window.__wfManualSelCleanup = null;
    }
    const container = document.querySelector('.waveform-container');
    const sel = container && container.querySelector('.wf-selection');
    if (sel) sel.remove();
}

// 手动框选（插件不可用时使用）
function enableManualSelection() {
    const container = document.querySelector('.waveform-container');
    const wf = document.getElementById('waveform');
    if (!container || !wf) return;
    let isDown = false; let startPx = 0; let endPx = 0; let selectionEl = null;
    const getRelX = (clientX) => {
        const rect = wf.getBoundingClientRect();
        return Math.min(Math.max(clientX - rect.left, 0), rect.width);
    };
    const toTime = (relPx) => {
        const rect = wf.getBoundingClientRect();
        const dur = waveformInstance && waveformInstance.getDuration ? waveformInstance.getDuration() : 0;
        return dur > 0 ? (relPx / rect.width) * dur : 0;
    };
    const updateSel = () => {
        if (!selectionEl) return;
        const left = Math.min(startPx, endPx);
        const right = Math.max(startPx, endPx);
        selectionEl.style.left = left + 'px';
        selectionEl.style.width = (right - left) + 'px';
    };
    const onDown = (e) => {
        isDown = true;
        startPx = getRelX(e.clientX);
        endPx = startPx;
        if (!selectionEl) {
            selectionEl = document.createElement('div');
            selectionEl.className = 'wf-selection';
            wf.appendChild(selectionEl);
        }
        updateSel();
    };
    const onMove = (e) => {
        if (!isDown) return;
        endPx = getRelX(e.clientX);
        updateSel();
    };
    const onUp = () => {
        if (!isDown) return;
        isDown = false;
        // 将选择映射到 regions 接口的仿真（供切片使用）
        const selLeft = Math.min(startPx, endPx);
        const selRight = Math.max(startPx, endPx);
        const start = toTime(selLeft);
        const end = toTime(selRight);
        waveformInstance.regions = {
            list: { manual: { id: 'manual', start, end } }
        };
        // 将波形进度设到选区起点，避免从头播放的视觉错觉
        try {
            if (waveformInstance && typeof waveformInstance.seekTo === 'function') {
                const rect = wf.getBoundingClientRect();
                waveformInstance.seekTo(selLeft / rect.width);
            }
        } catch (_) {}
    };
    wf.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    // 暴露清理函数
    window.__wfManualSelCleanup = () => {
        try { wf.removeEventListener('mousedown', onDown); } catch (_) {}
        try { window.removeEventListener('mousemove', onMove); } catch (_) {}
        try { window.removeEventListener('mouseup', onUp); } catch (_) {}
        if (selectionEl && selectionEl.parentNode) selectionEl.parentNode.removeChild(selectionEl);
    };
}

async function sliceCurrentSelection(file) {
    if (!waveformInstance) {
        showNotification('无法切片：波形未加载');
        return;
    }
    const regions = waveformInstance.regions ? Object.values(waveformInstance.regions.list || {}) : [];
    if (!regions || regions.length === 0) {
        showNotification('请先在波形上拖拽选择要切片的片段');
        return;
    }
    const region = regions[0];
    const start = Math.max(0, region.start || 0);
    const end = Math.max(start + 0.05, region.end || 0);
    try {
        const slicedPath = await extractSliceToWav(file.path, start, end);
        if (!slicedPath) {
            showNotification('切片失败');
            return;
        }
        const nameBase = (file.name || '音频') + `_${Math.round(start*1000)}-${Math.round(end*1000)}`;
        const newItem = {
            id: Date.now(),
            name: nameBase,
            description: '切片生成',
            duration: '未知',
            shortcut: '',
            group: file.group || 'ungrouped',
            path: slicedPath
        };
        audioFiles.push(newItem);
        renderAudioList(searchInput.value);
        updateGroupCounts();
        await saveAudioLibrary(audioFiles);
        probeAndUpdateDuration(newItem);
        showNotification('切片已保存');
    } catch (e) {
        showNotification('切片失败：' + (e?.message || '未知错误'));
    }
}

function getArrayBufferFromFilePath(absPath) {
    return fetch('file:///' + absPath.replace(/\\/g, '/')).then(r => r.arrayBuffer());
}

async function extractSliceToWav(absPath, startSec, endSec) {
    try {
        const soundsDir = await ensureSoundsDir();
        if (!soundsDir) return '';
        const buffer = await getArrayBufferFromFilePath(absPath);
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        const decoded = await ac.decodeAudioData(buffer.slice(0));
        const sampleRate = decoded.sampleRate;
        const from = Math.floor(startSec * sampleRate);
        const to = Math.min(decoded.length, Math.floor(endSec * sampleRate));
        const length = Math.max(0, to - from);
        const numChannels = Math.min(2, decoded.numberOfChannels);
        const outBuffer = ac.createBuffer(numChannels, length, sampleRate);
        for (let ch = 0; ch < numChannels; ch += 1) {
            const data = decoded.getChannelData(ch).slice(from, to);
            outBuffer.copyToChannel(data, ch);
        }
        const wavData = encodeWAV(outBuffer);
        const base = path.basename(absPath, path.extname(absPath));
        const outName = `${base}_${Math.round(startSec*1000)}-${Math.round(endSec*1000)}.wav`;
        let outPath = path.join(soundsDir, outName);
        let i = 1;
        while (fs.existsSync(outPath)) {
            outPath = path.join(soundsDir, `${base}_${Math.round(startSec*1000)}-${Math.round(endSec*1000)} (${i}).wav`);
            i += 1;
        }
        fs.writeFileSync(outPath, Buffer.from(wavData));
        return outPath;
    } catch (_) {
        return '';
    }
}

function encodeWAV(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const numFrames = buffer.length;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = numFrames * blockAlign;
    const bufferSize = 44 + dataSize;
    const arrayBuffer = new ArrayBuffer(bufferSize);
    const view = new DataView(arrayBuffer);

    function writeStr(offset, s) { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); }
    function write16(offset, v) { view.setUint16(offset, v, true); }
    function write32(offset, v) { view.setUint32(offset, v, true); }

    writeStr(0, 'RIFF');
    write32(4, 36 + dataSize);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    write32(16, 16);
    write16(20, 1);
    write16(22, numChannels);
    write32(24, sampleRate);
    write32(28, byteRate);
    write16(32, blockAlign);
    write16(34, 16);
    writeStr(36, 'data');
    write32(40, dataSize);

    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            const sample = buffer.getChannelData(ch)[i];
            const s = Math.max(-1, Math.min(1, sample));
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
            offset += 2;
        }
    }
    return arrayBuffer;
}

// 显示设置
function showSettings() {
    // 加载主进程保存的设置并展示
    ipcRenderer.invoke('get-settings').then(res => {
        const settings = res?.settings || { enableHotkeys: true, defaultVolume: 70 };
        const enableHotkeysCheckbox = document.getElementById('enableHotkeysCheckbox');
        const defaultVolumeRange = document.getElementById('defaultVolumeRange');
        const settingsVolumeIcon = document.getElementById('settingsVolumeIcon');
        const settingsVolumeValue = document.getElementById('settingsVolumeValue');
        const muteHotkeyDisplay = document.getElementById('muteHotkeyDisplay');
        const outputDeviceSelect = document.getElementById('outputDeviceSelect');
        if (enableHotkeysCheckbox) enableHotkeysCheckbox.checked = !!settings.enableHotkeys;
        if (defaultVolumeRange) defaultVolumeRange.value = String(settings.defaultVolume ?? 70);
        if (settingsVolumeValue) settingsVolumeValue.textContent = `${settings.defaultVolume ?? 70}%`;
        if (muteHotkeyDisplay) {
            const acc = settings.muteHotkey || '';
            muteHotkeyDisplay.value = humanizeAccelerator(acc);
            muteHotkeyDisplay.dataset.accelerator = acc;
        }
        // 填充输出设备列表
        if (outputDeviceSelect && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
            navigator.mediaDevices.enumerateDevices().then(devices => {
                const audios = devices.filter(d => d.kind === 'audiooutput');
                const current = settings.defaultOutputDeviceId || 'default';
                // 清空并插入选项
                outputDeviceSelect.innerHTML = '<option value="default">系统默认</option>' +
                  audios.map(d => `<option value="${d.deviceId}">${d.label || ('设备 ' + d.deviceId)}</option>`).join('');
                outputDeviceSelect.value = current;
            }).catch(() => {
                outputDeviceSelect.innerHTML = '<option value="default">系统默认</option>';
                outputDeviceSelect.value = 'default';
            });
        }

        // 同步到UI预览
        if (typeof settings.defaultVolume === 'number' && !Number.isNaN(settings.defaultVolume)) {
            volumeSlider.value = String(settings.defaultVolume);
            volumeValue.textContent = `${settings.defaultVolume}%`;
            globalVolume = settings.defaultVolume / 100;
            updateVolumeIcon(settings.defaultVolume);
            if (settingsVolumeIcon) updateVolumeIconInSettings(settings.defaultVolume);
        }

        settingsModal.classList.add('show');
    }).catch(() => {
        settingsModal.classList.add('show');
    });
}

// 添加新分组（抽屉）
function addNewGroup() {
    const modal = document.getElementById('addGroupModal');
    if (!modal) return;
    modal.classList.add('show');
    if (addGroupNameInput) {
        addGroupNameInput.value = '';
        addGroupNameInput.focus();
        addGroupNameInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                confirmAddGroup();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                hideAddGroupModal();
            }
        };
    }
    if (addGroupConfirmBtn) addGroupConfirmBtn.onclick = confirmAddGroup;
    if (addGroupCancelBtn) addGroupCancelBtn.onclick = hideAddGroupModal;
    const closeBtns = document.querySelectorAll('#addGroupModal .modal-close');
    closeBtns.forEach(btn => btn.addEventListener('click', hideAddGroupModal));
}

function confirmAddGroup() {
    const name = (addGroupNameInput?.value || '').trim();
    if (!name) {
        showNotification('请输入分组名称');
        return;
    }
    // 生成分组 key：优先使用 slug；若为空（如中文），回退为可读的唯一键
    let key = slugify(name);
    if (!key) {
        key = 'g-' + Date.now();
    }
    // 确保唯一性（若同名导致 slug 冲突或时间戳极端碰撞，则追加编号）
    if ((groups || []).some(g => g.key === key)) {
        let i = 1;
        let candidate = `${key}-${i}`;
        while ((groups || []).some(g => g.key === candidate)) {
            i += 1;
            candidate = `${key}-${i}`;
        }
        key = candidate;
    }
    // 插入到当前选中组之后（若为“全部音频”，则追加到末尾）
    let index = groups.length;
    if (currentGroup && currentGroup !== 'all') {
        const idx = (groups||[]).findIndex(g => g.key === currentGroup);
        if (idx >= 0) index = idx + 1;
    }
    groups.splice(index, 0, { id: key, key, name, description: '' });
    persistLibrary();
    updateGroupCounts();
    showNotification(`分组 "${name}" 已添加`);
    hideAddGroupModal();
}

function openEditGroupModal(targetKey) {
    const key = targetKey || currentGroup;
    if (!groups || key === 'all') {
        showNotification('请选择具体分组再编辑描述');
        return;
    }
    const grp = groups.find(g => g.key === key);
    if (!grp) return;
    const modal = document.getElementById('editGroupModal');
    const textarea = document.getElementById('editGroupDescInput');
    const saveBtn = document.getElementById('editGroupSaveBtn');
    const cancelBtn = document.getElementById('editGroupCancelBtn');
    if (!modal || !textarea || !saveBtn || !cancelBtn) return;
    textarea.value = grp.description || '';
    modal.classList.add('show');
    textarea.focus();

    const onSave = () => {
        grp.description = textarea.value;
        persistLibrary();
        renderAudioList(searchInput.value);
        modal.classList.remove('show');
        showNotification('分组描述已保存');
        cleanup();
    };
    const onCancel = () => { modal.classList.remove('show'); cleanup(); };
    const onClose = () => { modal.classList.remove('show'); cleanup(); };
    const closeBtns = modal.querySelectorAll('.modal-close');
    saveBtn.onclick = onSave;
    cancelBtn.onclick = onCancel;
    closeBtns.forEach(btn => btn.onclick = onClose);
    function cleanup() {
        saveBtn.onclick = null;
        cancelBtn.onclick = null;
        closeBtns.forEach(btn => btn.onclick = null);
    }
}

function hideAddGroupModal() {
    const modal = document.getElementById('addGroupModal');
    if (modal) modal.classList.remove('show');
    // 若键盘录制处于活动状态，强制结束
    try { if (window.__hotkeyRecordingCleanup) window.__hotkeyRecordingCleanup(); } catch (_) {}
}

// 关闭模态框
function closeModals() {
    document.querySelectorAll('.modal').forEach(modal => {
        modal.classList.remove('show');
    });
    // 若键盘录制处于活动状态，强制结束，避免拦截输入导致光标消失
    try { if (window.__hotkeyRecordingCleanup) window.__hotkeyRecordingCleanup(); } catch (_) {}
}

function setupSettingsHandlers() {
    const saveBtn = document.getElementById('settingsSaveBtn');
    const cancelBtn = document.getElementById('settingsCancelBtn');
    const defaultVolumeRange = document.getElementById('defaultVolumeRange');
    const settingsVolumeIcon = document.getElementById('settingsVolumeIcon');
    const settingsVolumeValue = document.getElementById('settingsVolumeValue');
    const recordBtn = document.getElementById('recordMuteHotkeyBtn');
    const clearBtn = document.getElementById('clearMuteHotkeyBtn');
    const muteHotkeyDisplay = document.getElementById('muteHotkeyDisplay');
    if (defaultVolumeRange) {
        defaultVolumeRange.addEventListener('input', (e) => {
            const v = parseInt(e.target.value || '70', 10);
            if (settingsVolumeValue) settingsVolumeValue.textContent = `${v}%`;
            updateVolumeIconInSettings(v);
        });
    }
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => settingsModal.classList.remove('show'));
    }
    if (recordBtn && muteHotkeyDisplay) {
        recordBtn.addEventListener('click', () => startRecordingHotkey(muteHotkeyDisplay, recordBtn));
    }
    if (clearBtn && muteHotkeyDisplay) {
        clearBtn.addEventListener('click', () => {
            muteHotkeyDisplay.value = '';
            muteHotkeyDisplay.dataset.accelerator = '';
        });
    }
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const enableHotkeysCheckbox = document.getElementById('enableHotkeysCheckbox');
            const defaultVolumeInput = document.getElementById('defaultVolumeRange');
                const outputDeviceSelect = document.getElementById('outputDeviceSelect');
            const enableHotkeys = !!(enableHotkeysCheckbox && enableHotkeysCheckbox.checked);
            let defaultVolume = parseInt(defaultVolumeInput?.value || '70', 10);
            if (Number.isNaN(defaultVolume)) defaultVolume = 70;
            defaultVolume = Math.min(100, Math.max(0, defaultVolume));
            const muteHotkey = (muteHotkeyDisplay?.dataset?.accelerator || '').trim();
                const defaultOutputDeviceId = (outputDeviceSelect?.value || 'default');

            const newSettings = { enableHotkeys, defaultVolume, muteHotkey, defaultOutputDeviceId };
            const result = await ipcRenderer.invoke('save-settings', newSettings);
            if (!result || !result.success) {
                showNotification('保存设置失败');
                return;
            }

            // 应用设置：音量
            volumeSlider.value = String(defaultVolume);
            volumeValue.textContent = `${defaultVolume}%`;
            globalVolume = defaultVolume / 100;
            updateVolumeIcon(defaultVolume);

            // 应用设置：全局快捷键
            if (enableHotkeys) {
                // 先清空，再按当前数据重注
                await ipcRenderer.invoke('unregister-all-shortcuts');
                registerInitialShortcuts();
                // 注册静音快捷键
                if (muteHotkey) {
                    ipcRenderer.invoke('register-shortcut', normalizeShortcut(muteHotkey), 'MUTE_TOGGLE')
                        .then(res => {
                            if (!res || !res.success) {
                                showNotification('静音快捷键注册失败');
                            }
                        })
                        .catch(() => showNotification('静音快捷键注册异常'));
                }
                showNotification('全局快捷键已启用');
            } else {
                await ipcRenderer.invoke('unregister-all-shortcuts');
                showNotification('全局快捷键已禁用');
            }

            settingsModal.classList.remove('show');
        });
    }
}

// 设置文件拖拽
function setupFileDrop() {
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#0056b3';
        dropZone.style.background = 'rgba(79, 172, 254, 0.15)';
    });
    
    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#4facfe';
        dropZone.style.background = 'rgba(79, 172, 254, 0.05)';
    });
    
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#4facfe';
        dropZone.style.background = 'rgba(79, 172, 254, 0.05)';
        
        const files = Array.from(e.dataTransfer.files);
        handleFiles(files);
    });
}

// 处理文件选择
function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    handleFiles(files);
}

// 处理文件
function handleFiles(files) {
    const validFiles = files.filter(file => {
        const ext = file.name.toLowerCase().split('.').pop();
        return ['mp3', 'wav', 'aac', 'ogg'].includes(ext);
    });
    
    if (validFiles.length > 0) {
        (async () => {
            for (let i = 0; i < validFiles.length; i += 1) {
                const file = validFiles[i];
                const destPath = await maybeCopyAsync(file);
                const newAudio = {
                    id: Date.now() + i,
                    name: file.name.replace(/\.[^/.]+$/, ""),
                    description: '导入的音频文件',
                    duration: '未知',
                    shortcut: '',
                    group: 'ungrouped',
                    path: destPath || file.path || ''
                };
                audioFiles.push(newAudio);
                renderAudioList(searchInput.value);
                updateGroupCounts();
                await saveAudioLibrary(audioFiles);
                probeAndUpdateDuration(newAudio);
            }
            showNotification(`成功导入 ${validFiles.length} 个音频文件`);
        closeModals();
        })();
    } else {
        showNotification('请选择有效的音频文件 (MP3, WAV, AAC, OGG)');
    }
}

// 确保 sounds 目录存在（使用主进程提供的用户可写目录）
let __APP_SOUNDS_DIR__ = null;
let __APP_DATA_DIR__ = null;
async function ensureSoundsDir() {
    try {
        if (!__APP_SOUNDS_DIR__) {
            const res = await ipcRenderer.invoke('get-app-paths');
            __APP_SOUNDS_DIR__ = (res && res.soundsDir) ? res.soundsDir : path.join(__dirname, 'sounds');
            __APP_DATA_DIR__ = (res && res.dataDir) ? res.dataDir : __dirname;
        }
        if (!fs.existsSync(__APP_SOUNDS_DIR__)) {
            fs.mkdirSync(__APP_SOUNDS_DIR__, { recursive: true });
        }
        return __APP_SOUNDS_DIR__;
    } catch (_) {
        return path.join(__dirname, 'sounds');
    }
}

// 启动时清理未被引用的音频文件
async function cleanupUnreferencedSounds() {
    const soundsDir = await ensureSoundsDir();
    if (!soundsDir) return;
    const allowedExt = new Set(['.mp3', '.wav', '.aac', '.ogg', '.m4a', '.flac']);
    // 收集已引用的绝对路径（统一规范化与小写比较）
    const referenced = new Set();
    (audioFiles || []).forEach(item => {
        if (!item || !item.path) return;
        const abs = path.isAbsolute(item.path) ? item.path : path.join(__dirname, item.path);
        const norm = path.normalize(abs).toLowerCase();
        referenced.add(norm);
    });
    // 遍历 sounds 目录
    let removed = 0;
    try {
        const entries = fs.readdirSync(soundsDir);
        entries.forEach(name => {
            const full = path.join(soundsDir, name);
            let stat;
            try { stat = fs.statSync(full); } catch { stat = null; }
            if (!stat || !stat.isFile()) return;
            const ext = path.extname(name).toLowerCase();
            if (!allowedExt.has(ext)) return;
            const norm = path.normalize(full).toLowerCase();
            if (!referenced.has(norm)) {
                try { fs.unlinkSync(full); removed += 1; } catch (_) {}
            }
        });
    } catch (_) {}
    if (removed > 0) {
        // 低频提示，避免打扰
        showNotification(`已清理 ${removed} 个未引用的音频文件`);
    }
}

// 将选择的文件复制到 sounds 目录，返回目标绝对路径（若失败返回空）
async function copyToSoundsSafely(file) {
    try {
        const soundsDir = await ensureSoundsDir();
        if (!soundsDir) return '';
        // 以源文件名为基础（优先使用 file.name）
        const base = (file && file.name) ? file.name : (file?.path ? path.basename(file.path) : 'audio');
        let dest = path.join(soundsDir, base);
        // 若重名，追加编号
        if (fs.existsSync(dest)) {
            const parsed = path.parse(base);
            let i = 1;
            while (fs.existsSync(dest)) {
                const candidate = `${parsed.name} (${i})${parsed.ext}`;
                dest = path.join(soundsDir, candidate);
                i += 1;
            }
        }
        const srcPath = file?.path;
        if (srcPath && fs.existsSync(srcPath)) {
            // 直接复制
            fs.copyFileSync(srcPath, dest);
        } else if (file && typeof file.arrayBuffer === 'function') {
            // 从浏览器 File 读取并写入
            file.arrayBuffer().then(buf => {
                try {
                    fs.writeFileSync(dest, Buffer.from(buf));
                } catch (e) {
                    showNotification('保存文件失败：' + (e?.message || '未知错误'));
                }
            }).catch(err => {
                showNotification('读取文件失败：' + (err?.message || '未知错误'));
            });
        } else {
            return '';
        }
        return dest;
    } catch (e) {
        showNotification('复制文件失败：' + (e?.message || '未知错误'));
        return '';
    }
}

// 统一返回 Promise 的复制函数，兼容同步/异步两种路径
function maybeCopyAsync(file) {
    return new Promise((resolve) => {
        try {
            // ensureSoundsDir 是异步，先预取目录
            (async () => {
                const soundsDir = await ensureSoundsDir();
                if (!soundsDir) return resolve('');
                const base = (file && file.name) ? file.name : (file?.path ? path.basename(file.path) : 'audio');
                let dest = path.join(soundsDir, base);
                const uniqueDest = () => {
                    if (!fs.existsSync(dest)) return dest;
                    const parsed = path.parse(base);
                    let i = 1; let candidate = dest;
                    while (fs.existsSync(candidate)) {
                        candidate = path.join(soundsDir, `${parsed.name} (${i})${parsed.ext}`);
                        i += 1;
                    }
                    return candidate;
                };
                dest = uniqueDest();
                const srcPath = file?.path;
                if (srcPath && fs.existsSync(srcPath)) {
                    fs.copyFileSync(srcPath, dest);
                    return resolve(dest);
                }
                if (file && typeof file.arrayBuffer === 'function') {
                    file.arrayBuffer().then(buf => {
                        try { fs.writeFileSync(dest, Buffer.from(buf)); } catch (_) { /* ignore */ }
                        resolve(dest);
                    }).catch(() => resolve(''));
                    return;
                }
                resolve('');
            })();
        } catch (_) {
            resolve('');
        }
    });
}

// 键盘快捷键处理
function handleKeyboard(e) {
    // ESC 关闭模态框
    if (e.key === 'Escape') {
        closeModals();
    }
    
    // Ctrl+I 导入文件
    if (e.ctrlKey && e.key === 'i') {
        e.preventDefault();
        showImportModal();
    }
    
    // 搜索焦点
    if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        searchInput.focus();
    }
}

// 显示通知
function showNotification(message) {
    
    // 如果已有3条通知，移除最旧的
    if (activeNotifications.length >= 3) {
        const oldestNotification = activeNotifications.shift();
        removeNotification(oldestNotification);
    }
    
    // 创建通知元素
    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.innerHTML = `
        <i class="fas fa-info-circle"></i>
        <span>${message}</span>
    `;
    
    const bottomOffset = 50 + (activeNotifications.length * 70);
    
    // 添加通知样式
    notification.style.cssText = `
        position: fixed;
        bottom: ${bottomOffset}px;
        left: 20px;
        background: linear-gradient(45deg, #4facfe, #00f2fe);
        color: white;
        padding: 12px 20px;
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.2);
        z-index: 10000;
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 14px;
        font-weight: 500;
        animation: slideInLeft 0.3s ease;
        min-height: 40px;
        max-width: 300px;
        word-wrap: break-word;
    `;
    
    document.body.appendChild(notification);
    activeNotifications.push(notification);
    
    // 3秒后自动移除
    setTimeout(() => {
        removeNotification(notification);
    }, 3000);
}

// 移除通知
function removeNotification(notification) {
    if (!notification || !notification.parentNode) return;
    
    // 从活动通知列表中移除
    const index = activeNotifications.indexOf(notification);
    if (index > -1) {
        activeNotifications.splice(index, 1);
    }
    
    // 添加退出动画
    notification.style.animation = 'slideOutLeft 0.3s ease';
    setTimeout(() => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }

        repositionNotifications();
    }, 300);
}

// 重新定位通知
function repositionNotifications() {
    activeNotifications.forEach((notification, index) => {
        const bottomOffset = 50 + (index * 70);
        notification.style.bottom = bottomOffset + 'px';
    });
}

// 添加通知动画样式
const notificationStyles = document.createElement('style');
notificationStyles.textContent = `
    @keyframes slideInLeft {
        from { transform: translateX(-100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    
    @keyframes slideOutLeft {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(-100%); opacity: 0; }
    }
`;
document.head.appendChild(notificationStyles);

// 持久化：加载与保存音频库
function loadAudioLibrary() {
    return ipcRenderer.invoke('get-audio-library')
        .then(res => {
            if (res && res.success && Array.isArray(res.items)) {
                audioFiles = res.items;
                window.audioFiles = audioFiles;
                if (Array.isArray(res.groups)) {
                    groups = res.groups;
                }
            } else {
                audioFiles = [];
                window.audioFiles = audioFiles;
            }
        })
        .catch(() => {
            audioFiles = [];
            window.audioFiles = audioFiles;
        });
}

function saveAudioLibrary(items) {
    const list = Array.isArray(items) ? items : audioFiles;
    // 同步当前 groups 一起保存
    return ipcRenderer.invoke('save-audio-library', { items: list, groups }).catch(() => {});
}

function toFileUrl(p) {
    const raw = String(p || '').trim();
    if (!raw) return '';
    if (/^file:\/\//i.test(raw)) return raw;
    const norm = raw.replace(/\\/g, '/');
    return encodeURI('file:///' + norm);
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '未知';
    const s = Math.max(0, seconds);
    return `${(Math.round(s * 10) / 10).toFixed(1)}s`;
}

function fillMissingDurations() {
    const tasks = (audioFiles || []).filter(f => !f.duration || f.duration === '未知');
    tasks.forEach(item => probeAndUpdateDuration(item));
}

function probeAndUpdateDuration(item) {
    return new Promise(resolve => {
        try {
            const url = toFileUrl(item.path);
            if (!url) return resolve();
            const a = new Audio();
            a.preload = 'metadata';
            let done = false;
            const cleanup = () => {
                if (done) return;
                done = true;
                a.src = '';
                resolve();
            };
            a.onloadedmetadata = () => {
                const dur = formatDuration(a.duration);
                if (dur && dur !== item.duration) {
                    item.duration = dur;
                    renderAudioList(searchInput.value);
                    updateGroupCounts();
                    saveAudioLibrary(audioFiles);
                }
                cleanup();
            };
            a.onerror = cleanup;
            const timer = setTimeout(() => {
                cleanup();
                clearTimeout(timer);
            }, 8000);
            a.src = url;
        } catch (_) {
            resolve();
        }
    });
}

// 监听来自主进程的快捷键触发
ipcRenderer.on('shortcut-triggered', (event, audioId) => {
    const file = audioFiles.find(f => f.id === parseInt(audioId));
    if (file) {
        playAudio(file.id);
    }
});

// 监听来自主进程的音频播放请求
ipcRenderer.on('play-audio-file', (event, audioPath) => {
    // 渲染侧已处理停止与UI状态，这里直接开始新音频
    playAudioFile(audioPath, false);
});

// 实际播放音频文件的函数
function playAudioFile(audioPath, shouldStopBefore = true) {
    try {
        const start = () => startNewAudio(audioPath);
        if (shouldStopBefore) {
            stopCurrentAudio().finally(start);
        } else {
            start();
        }
    } catch (error) {
        showNotification('音频播放失败：' + error.message);
    }
}

// 注册初始快捷键
function registerInitialShortcuts() {
    if (!Array.isArray(audioFiles)) return;
    audioFiles.forEach(file => {
        if (!file.shortcut) return;
        const accelerator = normalizeShortcut(file.shortcut);
        ipcRenderer.invoke('register-shortcut', accelerator, String(file.id))
            .then(res => {
                if (!res || !res.success) {
                    const reason = res?.error || '未知原因';
                    showNotification(`注册快捷键失败：${file.name} - ${accelerator}（${reason}）`);
                }
            })
            .catch(err => {
                showNotification(`注册快捷键异常：${file.name} - ${accelerator}（${err?.message || '错误'}）`);
            });
    });

    // 读取设置注册静音快捷键
    ipcRenderer.invoke('get-settings').then(res => {
        const muteHotkey = res?.settings?.muteHotkey || '';
        if (muteHotkey) {
            ipcRenderer.invoke('register-shortcut', normalizeShortcut(muteHotkey), 'MUTE_TOGGLE')
                .catch(() => {});
        }
    }).catch(() => {});
}

// 规范化用户快捷键为 Electron Accelerator
function normalizeShortcut(shortcut) {
    if (!shortcut || typeof shortcut !== 'string') return shortcut;
    let s = shortcut.trim();
    // 常见同义替换
    s = s.replace(/^Ctrl\b/i, 'CommandOrControl')
         .replace(/^Control\b/i, 'CommandOrControl')
         .replace(/^CmdOrCtrl\b/i, 'CommandOrControl')
         .replace(/\bCmd\b/i, 'Command')
         .replace(/\bAltGr\b/i, 'AltGr')
         .replace(/\+/g, '+');
    // 确保大小写规范（Electron 不强制，但统一便于阅读）
    return s
        .replace(/commandorcontrol/gi, 'CommandOrControl')
        .replace(/shift/gi, 'Shift')
        .replace(/alt/gi, 'Alt')
        .replace(/option/gi, 'Alt')
        .replace(/meta/gi, 'Super')
        .replace(/super/gi, 'Super')
        .replace(/command/gi, 'Command')
        .replace(/control/gi, 'Control');
}

function formatShortcutForDisplay(shortcut) {
    if (!shortcut) return '未设置';
    // 先将内部 Accelerator 人性化
    let s = humanizeAccelerator(shortcut);
    // 统一为小写 ctrl/shift/alt，并保持键位大小写合理
    s = s
        .replace(/\bCtrl\b/g, 'ctrl')
        .replace(/\bShift\b/g, 'shift')
        .replace(/\bAlt\b/g, 'alt');
    return s;
}

function updateVolumeIconInSettings(volume) {
    const icon = document.getElementById('settingsVolumeIcon');
    if (!icon) return;
    if (volume === 0) {
        icon.className = 'fas fa-volume-mute volume-icon';
    } else if (volume < 30) {
        icon.className = 'fas fa-volume-down volume-icon';
    } else {
        icon.className = 'fas fa-volume-up volume-icon';
    }
}

// 录制快捷键（组合键捕获）
async function startRecordingHotkey(displayInput, recordBtn) {
    if (!displayInput) return;
    // 若存在上一次未清理的录制，先安全结束
    try { if (window.__hotkeyRecordingCleanup) window.__hotkeyRecordingCleanup(); } catch (_) {}
    // 暂停全局快捷键，避免录制期间触发已注册的快捷键
    try {
        await ipcRenderer.invoke('unregister-all-shortcuts');
    } catch (_) {}
    displayInput.value = '按下组合键...';
    displayInput.dataset.accelerator = '';
    displayInput.classList.add('recording');
    if (recordBtn) recordBtn.disabled = true;

    const onKeyDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const accelerator = buildAcceleratorFromEvent(e);
        // 仅按下修饰键时，只显示修饰，不写入可保存的组合
        const onlyModifier = isModifierKey(e.key);
        displayInput.value = humanizeAccelerator(accelerator);
        if (!onlyModifier) {
            displayInput.dataset.accelerator = accelerator;
        }
        // 按下 ESC 时立即结束录制，避免悬挂状态
        if (e.key === 'Escape') {
            end();
        }
    };
    const onKeyUp = (e) => {
        // 结束录制
        end();
    };
    const end = () => {
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('keyup', onKeyUp, true);
        displayInput.classList.remove('recording');
        if (recordBtn) recordBtn.disabled = false;
        if (window.__hotkeyRecordingTimeout) {
            clearTimeout(window.__hotkeyRecordingTimeout);
            window.__hotkeyRecordingTimeout = null;
        }
        // 清理标记
        window.__hotkeyRecordingCleanup = null;
        // 恢复全局快捷键（根据当前保存的设置）
        reapplyHotkeysAfterRecording();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    // 兜底：超时自动结束，防止因为 keyup 丢失导致录制常驻
    window.__hotkeyRecordingTimeout = setTimeout(() => {
        try { end(); } catch (_) {}
    }, 15000);
    // 暴露全局清理，供其他关闭逻辑调用
    window.__hotkeyRecordingCleanup = end;
}

function buildAcceleratorFromEvent(e) {
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');
    if (!isModifierKey(e.key)) {
        const key = normalizeKey(e.key, e.code);
        if (key) parts.push(key);
    }
    return parts.join('+');
}

function humanizeAccelerator(acc) {
    if (!acc) return '';
    return acc
        .replace(/CommandOrControl/gi, 'Ctrl')
        .replace(/\bAlt\b/gi, 'Alt')
        .replace(/\bShift\b/gi, 'Shift');
}

function normalizeKey(key, code) {
    if (!key && !code) return '';
    const k = (key || '').toLowerCase();
    const c = String(code || '').toLowerCase();
    // 物理数字键（即使按下 Shift 也返回 0-9）
    const digitMatch = c.match(/^digit([0-9])$/);
    if (digitMatch) return digitMatch[1];
    const numpadMatch = c.match(/^numpad([0-9])$/);
    if (numpadMatch) return numpadMatch[1];
    // 数字、字母
    if (/^[a-z0-9]$/.test(k)) return k.toUpperCase();
    // 功能键
    if (/^f\d{1,2}$/.test(k)) return k.toUpperCase();
    // 常见特殊键映射
    const map = {
        "arrowup": 'Up',
        "arrowdown": 'Down',
        "arrowleft": 'Left',
        "arrowright": 'Right',
        "escape": 'Esc',
        "plus": 'Plus',
        "minus": 'Minus',
        "space": 'Space'
    };
    return map[k] || key.toUpperCase();
}

function isModifierKey(key) {
    if (!key) return false;
    const k = String(key).toLowerCase();
    return k === 'control' || k === 'shift' || k === 'alt' || k === 'meta';
}

async function reapplyHotkeysAfterRecording() {
    try {
        const res = await ipcRenderer.invoke('get-settings');
        const enabled = res?.settings?.enableHotkeys !== false;
        if (enabled) {
            registerInitialShortcuts();
        }
    } catch (_) {}
}

// 向主界面音量控制添加一键静音按钮
function injectMuteButton() {
    const container = document.querySelector('.volume-control');
    if (!container || container.querySelector('#muteToggleBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'muteToggleBtn';
    btn.className = 'btn btn-secondary';
    btn.title = '静音/恢复';
    btn.innerHTML = '<i class="fas fa-volume-mute"></i>';
    btn.style.minWidth = '36px';
    btn.style.padding = '6px 8px';
    container.appendChild(btn);

    btn.addEventListener('click', toggleMute);

    // 快捷键触发监听
    ipcRenderer.on('shortcut-triggered', (event, payload) => {
        if (payload === 'MUTE_TOGGLE') {
            toggleMute();
        }
    });
}

// 一键打开音频目录
async function openSoundsDirectory() {
    try {
        // 确保目录存在
        const dir = await ensureSoundsDir();
        const res = await ipcRenderer.invoke('open-sounds-dir', dir);
        if (!res || !res.success) {
            showNotification('无法打开音频目录' + (res?.error ? `：${res.error}` : ''));
        }
    } catch (e) {
        showNotification('无法打开音频目录：' + (e?.message || '未知错误'));
    }
}

function toggleMute() {
    if (!isMuted) {
        // 记录之前音量
        lastVolumeBeforeMute = globalVolume;
        setVolumePercentage(0);
        isMuted = true;
        showNotification('已静音');
    } else {
        const restored = Math.max(0.1, lastVolumeBeforeMute); // 恢复到上次音量，最低10%
        setVolumePercentage(Math.round(restored * 100));
        isMuted = false;
        showNotification('已恢复音量');
    }
}

function setVolumePercentage(percent) {
    const v = Math.min(100, Math.max(0, parseInt(percent || '0', 10)));
    globalVolume = v / 100;
    if (volumeSlider) volumeSlider.value = String(v);
    if (volumeValue) volumeValue.textContent = `${v}%`;
    updateVolumeIcon(v);
    if (currentAudio && !currentAudio.paused) {
        currentAudio.volume = globalVolume;
    }
}

// 启动时加载设置并应用
function loadSettingsAndApply() {
    ipcRenderer.invoke('get-settings')
        .then(res => {
            const settings = res?.settings || { enableHotkeys: true, defaultVolume: 70 };
            // 缓存到全局供 setSinkId 使用
            window.__soundpp_settings = settings;
            // 应用默认音量到 UI 与全局变量
            if (typeof settings.defaultVolume === 'number' && !Number.isNaN(settings.defaultVolume)) {
                const vol = Math.min(100, Math.max(0, settings.defaultVolume));
                if (volumeSlider) volumeSlider.value = String(vol);
                if (volumeValue) volumeValue.textContent = `${vol}%`;
                globalVolume = vol / 100;
                updateVolumeIcon(vol);
            }

            // 应用快捷键开关
            if (settings.enableHotkeys) {
                registerInitialShortcuts();
            } else {
                ipcRenderer.invoke('unregister-all-shortcuts');
            }
        })
        .catch(() => {
            // 失败时保持默认值，不中断启动
        });
}

// 安全停止当前音频
function stopCurrentAudio() {
    return new Promise((resolve) => {
        if (currentAudio) {
            if (currentAudio.playPromise) {
                currentAudio.playPromise.then(() => {
                    if (currentAudio && !currentAudio.paused) {
                        currentAudio.pause();
                    }
                    currentAudio = null;
                    resolve();
                }).catch(() => {
                    currentAudio = null;
                    resolve();
                });
            } else if (!currentAudio.paused) {
                currentAudio.pause();
                currentAudio = null;
                resolve();
            } else {
                currentAudio = null;
                resolve();
            }
        } else {
            resolve();
        }
        
        // 重置当前播放ID
        if (currentPlayingId !== null) {
            const playBtn = document.querySelector(`[data-id="${currentPlayingId}"] .play-btn`);
            if (playBtn) {
                const icon = playBtn.querySelector('i');
                icon.className = 'fas fa-play';
                playBtn.classList.remove('playing');
            }
            currentPlayingId = null;
        }
    });
}

// 开始播放新音频
function startNewAudio(audioPath) {
    const fileUrl = 'file:///' + audioPath.replace(/\\/g, '/');
    const audio = new Audio(fileUrl);
    audio.volume = globalVolume;
    // 应用默认输出设备（若可用）
    try {
        const outputDeviceId = (window.__soundpp_settings && window.__soundpp_settings.defaultOutputDeviceId) || null;
        if (outputDeviceId && audio.setSinkId) {
            audio.setSinkId(outputDeviceId).catch(() => {});
        }
    } catch (_) {}
    currentAudio = audio;
    
    audio.onerror = (error) => {
        showNotification('音频播放失败：文件无法加载');
        if (currentAudio === audio) {
            currentAudio = null;
        }
        // 音频播放出错时重置按钮状态
        if (currentPlayingId !== null) {
            const playBtn = document.querySelector(`[data-id="${currentPlayingId}"] .play-btn`);
            if (playBtn) {
                const icon = playBtn.querySelector('i');
                icon.className = 'fas fa-play';
                playBtn.classList.remove('playing');
            }
            currentPlayingId = null;
        }
    };
    
    audio.onended = () => {
        if (currentAudio === audio) {
            currentAudio = null;
        }
        if (currentPlayingId !== null) {
            const playBtn = document.querySelector(`[data-id="${currentPlayingId}"] .play-btn`);
            if (playBtn) {
                const icon = playBtn.querySelector('i');
                icon.className = 'fas fa-play';
                playBtn.classList.remove('playing');
            }
            currentPlayingId = null;
        }
    };
    
    const playPromise = audio.play();
    if (playPromise !== undefined) {
        audio.playPromise = playPromise;
        playPromise.then(() => {
            if (audio.playPromise === playPromise) {
                audio.playPromise = null;
            }
        }).catch(error => {
            showNotification('音频播放失败：' + error.message);
            if (currentAudio === audio) {
                currentAudio = null;
            }
            if (audio.playPromise === playPromise) {
                audio.playPromise = null;
            }
            if (currentPlayingId !== null) {
                const playBtn = document.querySelector(`[data-id="${currentPlayingId}"] .play-btn`);
                if (playBtn) {
                    const icon = playBtn.querySelector('i');
                    icon.className = 'fas fa-play';
                    playBtn.classList.remove('playing');
                }
                currentPlayingId = null;
            }
        });
    }
}

// 暴露到全局作用域
window.playAudio = playAudio;
window.editAudio = editAudio;
window.deleteAudio = deleteAudio;
window.audioFiles = audioFiles;

// 应用启动
document.addEventListener('DOMContentLoaded', initApp);

// 页面加载完成后的额外初始化
window.addEventListener('load', () => {
    setTimeout(async () => {
        try {
            const res = await ipcRenderer.invoke('get-settings');
            const enabled = res?.settings?.enableHotkeys !== false;
            showNotification(enabled ? '后台快捷键监听已启用' : '后台快捷键监听未启用');
        } catch (_) {
        showNotification('后台快捷键监听已启用');
        }
        // 显示版本号（从 package.json 读取）
        try {
            const pkg = require('./package.json');
            const verEl = document.getElementById('appVersionItem');
            if (pkg?.version && verEl) {
                verEl.innerHTML = `<i class="fas fa-code-branch"></i> v${pkg.version}`;
            }
        } catch (_) {}
    }, 1000);
});