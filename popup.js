/**
 * 豆包去水印 - Popup Script
 * 
 * 功能：状态显示、图片去重（只保留最高清）、框选多选、批量下载、下载目录选择
 */

// ── 全局状态 ──────────────────────────────────────────────────────────────────
let imageList = [];         // 去重后的图片列表 [{ url, previewUrl, width, height, quality }]
let selectedSet = new Set();
let sortOrder = 'desc';     // 排序顺序：'desc' 倒序（最新在前），'asc' 正序（最早在前）
const DEFAULT_DOWNLOAD_DIR = '豆包无水印图片';



// ── DOM 引用 ──────────────────────────────────────────────────────────────────
const $hookStatus = document.getElementById('hookStatus');
const $hookStatusText = document.getElementById('hookStatusText');
const $imageGrid = document.getElementById('imageGrid');
const $emptyState = document.getElementById('emptyState');
const $selectAllBtn = document.getElementById('selectAllBtn');
const $deselectAllBtn = document.getElementById('deselectAllBtn');
const $downloadBtn = document.getElementById('downloadBtn');
const $dirDisplay = document.getElementById('dirDisplay');
const $changeDirBtn = document.getElementById('changeDirBtn');
const $dirFullPath = document.getElementById('dirFullPath');
const $openDirBtn = document.getElementById('openDirBtn');
const $sortToggle = document.getElementById('sortToggle');
const $sortLabel = document.getElementById('sortLabel');
const $popupToast = document.getElementById('popupToast');
const $toastIcon = document.getElementById('toastIcon');
const $toastText = document.getElementById('toastText');
const $toastProgress = document.getElementById('toastProgress');
const $downloadProgress = document.getElementById('downloadProgress');
const $progressFill = document.getElementById('progressFill');

// ── Toast 工具函数 ──────────────────────────────────────────────────────────
let toastTimer = null;

function showPopupToast(text, type, progress) {
  // type: 'success' | 'error' | 'info'
  type = type || 'info';
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };

  $toastIcon.textContent = icons[type] || icons.info;
  $toastText.textContent = text;
  $popupToast.className = 'popup-toast ' + type;

  if (progress !== undefined) {
    $toastProgress.textContent = progress;
    $toastProgress.style.display = '';
  } else {
    $toastProgress.style.display = 'none';
  }

  // 清除之前的定时器
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }

  // 显示
  requestAnimationFrame(() => {
    $popupToast.classList.add('show');
  });

  // 3秒后自动隐藏（除非是持续显示的进度 toast）
  if (progress === undefined) {
    toastTimer = setTimeout(() => {
      $popupToast.classList.remove('show');
    }, 3000);
  }
}

function hidePopupToast() {
  $popupToast.classList.remove('show');
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
}

function showDownloadProgress(current, total, percent) {
  $downloadProgress.classList.add('active');
  $progressFill.style.width = percent + '%';
}

function hideDownloadProgress() {
  $downloadProgress.classList.remove('active');
  $progressFill.style.width = '0%';
}

// ── 初始化 ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // ── 下载目录管理（方案 B：完全走 native host）──────────────────────────────
  // 核心思路：
  // - 「选择目录」：调 native host → AppleScript 弹原生 choose folder → 返回绝对路径
  // - 「下载图片」：popup 拉图片 base64 → 通过 background → native host 直接写到绝对路径
  // - 「打开目录」：调 native host → open <绝对路径>
  // - 不再使用 showDirectoryPicker / IndexedDB dirHandle / chrome.downloads.download
  //   也不再产生任何探针文件，路径来源唯一：storage.downloadDirFullPath

  let currentDirFullPath = '';                // 选定目录的绝对路径（唯一权威来源）
  let currentDirName = DEFAULT_DOWNLOAD_DIR;  // 显示用的目录叶子名

  // 保留 IndexedDB 操作（清理旧版本残留的 dirHandle）
  async function saveDirHandle(handle) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('DoubaoRemoveMarkDB', 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings');
        }
      };
      request.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('settings', 'readwrite');
        const store = tx.objectStore('settings');
        store.put(handle, 'dirHandle');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function loadDirHandle() {
    return new Promise((resolve) => {
      const request = indexedDB.open('DoubaoRemoveMarkDB', 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings');
        }
      };
      request.onsuccess = (e) => {
        const db = e.target.result;
        try {
          const tx = db.transaction('settings', 'readonly');
          const store = tx.objectStore('settings');
          const getReq = store.get('dirHandle');
          getReq.onsuccess = () => resolve(getReq.result || null);
          getReq.onerror = () => resolve(null);
        } catch (err) {
          resolve(null);
        }
      };
      request.onerror = () => resolve(null);
    });
  }

  async function removeDirHandle() {
    return new Promise((resolve) => {
      const request = indexedDB.open('DoubaoRemoveMarkDB', 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings');
        }
      };
      request.onsuccess = (e) => {
        const db = e.target.result;
        try {
          const tx = db.transaction('settings', 'readwrite');
          const store = tx.objectStore('settings');
          store.delete('dirHandle');
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch (err) {
          resolve();
        }
      };
      request.onerror = () => resolve();
    });
  }

  // 验证 dirHandle 是否仍然可用（权限可能已过期）
  async function verifyDirHandle(handle) {
    if (!handle) return false;
    try {
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') return true;
      // 尝试请求权限
      const req = await handle.requestPermission({ mode: 'readwrite' });
      return req === 'granted';
    } catch (e) {
      return false;
    }
  }

  // 加载已保存的目录设置
  const stored = await chrome.storage.local.get(['downloadDir', 'downloadDirFullPath']);
  if (stored.downloadDirFullPath) {
    currentDirFullPath = stored.downloadDirFullPath;
    // 从绝对路径推导叶子名作为显示名（如果 storage 里有就用 storage 里的）
    const lastSep = Math.max(currentDirFullPath.lastIndexOf('/'), currentDirFullPath.lastIndexOf('\\'));
    const leaf = (lastSep >= 0 && lastSep < currentDirFullPath.length - 1) ? currentDirFullPath.substring(lastSep + 1) : currentDirFullPath;
    currentDirName = stored.downloadDir || leaf;
  } else {
    currentDirName = stored.downloadDir || DEFAULT_DOWNLOAD_DIR;
  }
  updateDirDisplay(currentDirName);
  if (currentDirFullPath) {
    $dirFullPath.textContent = currentDirFullPath;
  } else {
    $dirFullPath.textContent = '未设置，点击「选择目录」指定';
  }

  // 清理旧版本残留的 IndexedDB dirHandle（方案 B 不再使用）
  try {
    const stale = await loadDirHandle();
    if (stale) {
      await removeDirHandle();
    }
  } catch (e) { /* ignore */ }

  // 清理旧版本残留的已下载记录（已废弃此功能）
  try {
    await chrome.storage.local.remove(['downloadedUrls']);
  } catch (e) { /* ignore */ }

  // 目录显示区可编辑：点击后进入编辑模式，直接输入子目录名
  $dirDisplay.addEventListener('click', () => {
    // 先显示纯目录名，方便编辑
    $dirDisplay.textContent = currentDirName;
    $dirDisplay.contentEditable = true;
    $dirDisplay.focus();
    const range = document.createRange();
    range.selectNodeContents($dirDisplay);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });

  $dirDisplay.addEventListener('blur', async () => {
    $dirDisplay.contentEditable = false;
    const val = $dirDisplay.textContent.trim();
    const dirName = val || DEFAULT_DOWNLOAD_DIR;
    // 方案 B 下，手动编辑显示名仅用于 UI 标签，绝对路径仍由「选择目录」决定
    currentDirName = dirName;
    await chrome.storage.local.set({ downloadDir: dirName });
    updateDirDisplay(dirName);
  });

  $dirDisplay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $dirDisplay.blur();
    }
    if (e.key === 'Escape') {
      $dirDisplay.contentEditable = false;
      $dirDisplay.textContent = '';
      updateDirDisplay(currentDirName);
    }
  });

  // 选择目录按钮 — 通过 native host 弹出 macOS 原生 choose folder 对话框
  $changeDirBtn.addEventListener('click', async () => {
    $changeDirBtn.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'CHOOSE_DIRECTORY',
        defaultLocation: currentDirFullPath || ''
      });
      if (!result) {
        showPopupToast('Native 未响应，请确认已安装 native host', 'error');
        return;
      }
      if (result.canceled) {
        return;
      }
      if (!result.success || !result.path) {
        const errMsg = result.error || '未知错误';
        const isNativeNotReady =
          /Specified native messaging host not found/i.test(errMsg) ||
          /Native host has exited/i.test(errMsg) ||
          /Access to the specified native messaging host is forbidden/i.test(errMsg) ||
          /Error when communicating with the native messaging host/i.test(errMsg);
        if (isNativeNotReady) {
          showPopupToast('Native 未就绪，请先安装 native host', 'error');
        } else {
          showPopupToast('选择目录失败: ' + errMsg, 'error');
        }
        return;
      }
      // 成功：拿到绝对路径，立刻刷新所有状态
      const absPath = result.path;
      const lastSep = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'));
      const leaf = (lastSep >= 0 && lastSep < absPath.length - 1) ? absPath.substring(lastSep + 1) : absPath;
      currentDirFullPath = absPath;
      currentDirName = leaf;
      await chrome.storage.local.set({
        downloadDir: leaf,
        downloadDirFullPath: absPath
      });
      // 清理旧版本可能存在的字段
      await chrome.storage.local.remove(['downloadDirRelPath']);
      // 立即刷新 UI
      updateDirDisplay(leaf);
      $dirFullPath.textContent = absPath;
      $dirFullPath.style.color = '';
      showPopupToast('目录已设置：' + absPath, 'success');
    } catch (e) {
      showPopupToast('选择目录失败: ' + (e && e.message ? e.message : e), 'error');
    } finally {
      $changeDirBtn.disabled = false;
    }
  });

  // 打开下载目录按钮 — 在 Finder 中打开下载目录
  $openDirBtn.addEventListener('click', async () => {
    $openDirBtn.disabled = true;
    try {
      // 路径来源：只使用 storage 中存储的绝对路径（在「选择目录」时已解析并落库）
      const s = await chrome.storage.local.get(['downloadDirFullPath']);
      let targetPath = s.downloadDirFullPath;
      if (!targetPath) {
        showPopupToast('请先点击「选择目录」指定下载目录', 'error');
        return;
      }
      const result = await chrome.runtime.sendMessage({ type: 'OPEN_DIRECTORY', path: targetPath });
      if (result && result.success) {
        // 成功
      } else {
        // 区分错误类型：根据具体的 error 信息判断
        const errMsg = (result && result.error) ? String(result.error) : '';
        const isNativeNotReady =
          !result ||                                                        // background 没返回（消息通道异常）
          /Specified native messaging host not found/i.test(errMsg) ||      // manifest 未注册
          /Native host has exited/i.test(errMsg) ||                         // 脚本启动失败
          /Access to the specified native messaging host is forbidden/i.test(errMsg) || // allowed_origins 不匹配
          /Error when communicating with the native messaging host/i.test(errMsg);
        const isDirNotExist = /does not exist/i.test(errMsg) || /No such file/i.test(errMsg);

        if (isNativeNotReady) {
          // 真正的 Native 未就绪：提示安装方法
          const extId = chrome.runtime.id;
          // 不硬编码脚本路径（因每个用户安装位置不同），提示用户手动定位脚本
          showPopupToast('❌ Native未就绪，请在终端运行安装脚本', 'error');
        } else if (isDirNotExist) {
          // 目录不存在：自动清除 storage 中的脏路径，刷新显示，引导用户重新选择
          await chrome.storage.local.remove(['downloadDirFullPath', 'downloadDirRelPath']);
          await updateFullPathDisplay();
          showPopupToast(`❌ 目录不存在：已自动重置，请点击"选择目录"重新指定`, 'error');
        } else {
          // 其他未知错误：显示原始 error 信息，便于排查
          showPopupToast(`❌ 打开目录失败: ${errMsg || '未知错误'}`, 'error');
        }
      }
    } catch (e) {
      showPopupToast('打开下载目录失败: ' + (e && e.message ? e.message : e), 'error');
    } finally {
      setTimeout(() => { $openDirBtn.disabled = false; }, 500);
    }
  });

  // 获取当前tab状态

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('doubao.com')) {
      // 获取 Hook 状态
      chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }, (response) => {
        if (chrome.runtime.lastError) {
          setHookStatus(false);
          return;
        }
        if (response) {
          setHookStatus(response.hookActive);
        }
      });

      // 收集页面图片
      chrome.tabs.sendMessage(tab.id, { type: 'COLLECT_IMAGES' }, (response) => {
        if (chrome.runtime.lastError || !response || !response.images) return;
        imageList = deduplicateImages(response.images);
        renderImageGrid();
      });
    } else {
      setHookStatus(false, '非豆包页面');
    }
  } catch (e) {
    // 初始化失败，静默
  }

  // ── 排序切换 ───────────────────────────────────────────────────────────────────────
  $sortToggle.addEventListener('click', () => {
    sortOrder = sortOrder === 'desc' ? 'asc' : 'desc';
    $sortToggle.className = 'sort-toggle ' + sortOrder;
    $sortLabel.textContent = sortOrder === 'desc' ? '倒序' : '正序';
    renderImageGrid();
  });

  // 全选 / 取消全选
  $selectAllBtn.addEventListener('click', () => {
    imageList.forEach((_, i) => selectedSet.add(i));
    updateSelection();
  });
  $deselectAllBtn.addEventListener('click', () => {
    selectedSet.clear();
    updateSelection();
  });

  // ── 批量下载 ──
  // 核心改动：一次性把所有 items 发给 background.js（native host 并行下载）
  // 通过 connectNative 长连接，native host 每完成一张图片就推送 download_progress 回调
  // popup 监听 DOWNLOAD_PROGRESS_UPDATE 消息实时刷新进度

  $downloadBtn.addEventListener('click', async () => {
    const selected = Array.from(selectedSet).map(i => imageList[i]).filter(Boolean);
    if (selected.length === 0) return;

    // 方案 B：必须先选目录拿到绝对路径，否则没法下载
    const s = await chrome.storage.local.get(['downloadDirFullPath']);
    const targetDir = s.downloadDirFullPath;
    if (!targetDir) {
      showPopupToast('请先点击「选择目录」指定下载目录', 'error');
      return;
    }

    $downloadBtn.disabled = true;
    $downloadBtn.textContent = '下载中...';

    const total = selected.length;

    // 构建下载 items
    const downloadItems = selected.map((img, i) => {
      const url = img.url;
      const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const ext = url.match(/\.(png|jpe?g|webp)/)?.[1] || 'png';
      const filename = 'doubao_' + timestamp + '_' + (i + 1) + '.' + ext;
      return { filename, url };
    });

    showDownloadProgress(0, total, 0);
    showPopupToast('正在下载无水印图片...', 'info', `0/${total}`);

    // 一次性把所有 items 发给 background → native host，native host 会用 ThreadPoolExecutor 并行下载
    // native host 每完成一张图片就通过 connectNative 长连接推送 download_progress 消息
    // background.js 转发为 DOWNLOAD_PROGRESS_UPDATE 消息，popup 通过监听回调实时刷新进度
    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_URL_NATIVE',
      dir: targetDir,
      items: downloadItems
    }, (response) => {
      if (chrome.runtime.lastError) {
        showPopupToast('发送下载请求失败: ' + (chrome.runtime.lastError.message || ''), 'error');
        $downloadBtn.disabled = false;
        $downloadBtn.textContent = '下载选中';
        hideDownloadProgress();
        return;
      }
      if (response && response.success === false) {
        showPopupToast('下载启动失败: ' + (response.error || '未知错误'), 'error');
        $downloadBtn.disabled = false;
        $downloadBtn.textContent = '下载选中';
        hideDownloadProgress();
      }
    });
  });

  // ── 下载进度回调：监听 background.js 通过 Port 转发的进度更新 ──
  // native_host.py 文件落盘后立即在 worker 线程里 send_message
  // → background.js 收到后 postMessage 到本 Port
  // → popup 监听 onMessage 实时刷新 UI
  // 用 Port 长连接而非 sendMessage，可消除消息注册/查找开销，进度更跟手
  let downloadTotal = 0;
  let downloadTargetDir = '';

  const progressPort = chrome.runtime.connect({ name: 'download-progress' });
  progressPort.onMessage.addListener((message) => {
    if (message.type === 'DOWNLOAD_PROGRESS_UPDATE') {
      // 收到进度回调：native host 完成了一张图片
      const completed = message.completed;
      const total = message.total;
      const success = message.success;
      const fail = message.fail;

      const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
      showDownloadProgress(completed, total, percent);
      showPopupToast(
        completed < total ? `正在下载第 ${completed + 1} 张...` : '下载完成，正在处理...',
        'info',
        `${completed}/${total}`
      );

    } else if (message.type === 'DOWNLOAD_COMPLETE') {
      // 全部下载完成
      const successCount = message.successCount;
      const failCount = message.failCount;
      hideDownloadProgress();
      $downloadBtn.disabled = false;
      $downloadBtn.textContent = '下载选中';

      chrome.storage.local.get(['downloadDirFullPath'], (stored) => {
        const targetDir = stored.downloadDirFullPath || '';
        if (failCount > 0 && successCount === 0) {
          showPopupToast(`❌ 下载失败 ${failCount} 张，请确认 native host 已就绪`, 'error');
        } else if (failCount > 0) {
          showPopupToast(`下载完成：成功 ${successCount} 张，失败 ${failCount} 张`, 'error');
        } else {
          const targetMsg = targetDir ? `到「${targetDir}」` : '';
          showPopupToast(`✨ 已成功下载 ${successCount} 张图片${targetMsg}`, 'success');
        }
      });

      // 同时在页面中也显示 toast
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs && tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              type: 'SHOW_TOAST',
              text: failCount > 0
                ? `下载完成：成功 ${successCount} 张，失败 ${failCount} 张`
                : `已下载 ${successCount} 张无水印图片`,
              toastType: failCount > 0 ? 'info' : 'success'
            });
          }
        });
      } catch (e) { /* ignore */ }

    } else if (message.type === 'DOWNLOAD_ERROR') {
      hideDownloadProgress();
      $downloadBtn.disabled = false;
      $downloadBtn.textContent = '下载选中';
      showPopupToast('下载失败: ' + (message.error || '未知错误'), 'error');
    }
  });

  // ── 进度恢复：popup 重新打开时 ──
  // 如果 popup 关闭后重新打开，下载仍在进行中，
  // background.js 维护的长连接会持续推送 DOWNLOAD_PROGRESS_UPDATE，
  // popup 的 onMessage 监听器会自动接收并刷新进度

  // ── 框选支持 ─────────────────────────────────────────────────────────────
  const $selRect = document.getElementById('selectionRect');
  let boxSelecting = false;
  let boxStartX = 0, boxStartY = 0;
  let hasMoved = false; // 是否有移动（区分点击和框选）
  const DRAG_THRESHOLD = 5; // 超过5px视为框选

  // 判断两个矩形是否相交
  function rectsIntersect(r1, r2) {
    return !(r1.right < r2.left || r1.left > r2.right || r1.bottom < r2.top || r1.top > r2.bottom);
  }

  // 根据框选矩形更新卡片选中状态
  function updateBoxSelection(selLeft, selTop, selRight, selBottom) {
    const cards = $imageGrid.querySelectorAll('.image-card');
    cards.forEach(card => {
      const idx = parseInt(card.dataset.index);
      const cardRect = card.getBoundingClientRect();
      if (rectsIntersect(
        { left: selLeft, top: selTop, right: selRight, bottom: selBottom },
        cardRect
      )) {
        // 框选到的：如果之前没选中则添加选中，如果之前已选中则保持选中
        selectedSet.add(idx);
        card.classList.add('selected');
      }
    });
    updateSelection();
  }

  // 在图片网格的父容器上监听 mousedown
  const gridContainer = $imageGrid.parentElement;
  gridContainer.addEventListener('mousedown', (e) => {
    // 只响应左键
    if (e.button !== 0) return;
    e.preventDefault();

    boxSelecting = true;
    hasMoved = false;

    const containerRect = gridContainer.getBoundingClientRect();
    boxStartX = e.clientX;
    boxStartY = e.clientY;

    $selRect.style.display = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!boxSelecting) return;

    const dx = e.clientX - boxStartX;
    const dy = e.clientY - boxStartY;

    if (!hasMoved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) {
      return; // 移动距离太小，还不算框选
    }

    hasMoved = true;

    const containerRect = gridContainer.getBoundingClientRect();
    const left = Math.min(boxStartX, e.clientX);
    const top = Math.min(boxStartY, e.clientY);
    const right = Math.max(boxStartX, e.clientX);
    const bottom = Math.max(boxStartY, e.clientY);

    // 绘制框选矩形（相对于容器）
    $selRect.style.display = 'block';
    $selRect.style.left = (left - containerRect.left) + 'px';
    $selRect.style.top = (top - containerRect.top) + 'px';
    $selRect.style.width = (right - left) + 'px';
    $selRect.style.height = (bottom - top) + 'px';

    // 实时更新框选状态
    updateBoxSelection(left, top, right, bottom);
  });

  document.addEventListener('mouseup', (e) => {
    if (!boxSelecting) return;
    boxSelecting = false;
    $selRect.style.display = 'none';

    if (!hasMoved) {
      // 没有移动 → 视为点击
      const card = e.target.closest('.image-card');
      if (card) {
        const idx = parseInt(card.dataset.index);
        if (selectedSet.has(idx)) {
          selectedSet.delete(idx);
        } else {
          selectedSet.add(idx);
        }
        updateSelection();
      }
    }
  });

  // ── 更新目录显示 ──────────────────────────────────────────────────────
  function updateDirDisplay(dir) {
    $dirDisplay.textContent = dir;
    if (dir === DEFAULT_DOWNLOAD_DIR) {
      $dirDisplay.textContent = dir + '（默认）';
      $dirDisplay.classList.add('default');
    } else {
      $dirDisplay.classList.remove('default');
    }
    updateFullPathDisplay();
  }

  // 更新完整路径显示
  async function updateFullPathDisplay() {
    try {
      // 只使用 storage 中存储的下载目录（在“选择目录”时已解析为绝对路径）。
      const stored = await chrome.storage.local.get(['downloadDirFullPath']);
      if (stored.downloadDirFullPath) {
        $dirFullPath.textContent = stored.downloadDirFullPath;
      } else {
        $dirFullPath.textContent = '未设置，点击「选择目录」指定';
      }
    } catch (e) { /* ignore */ }
  }
});

// ── 图片去重：同一张图只保留最高清版本 ──────────────────────────────────────────
// 豆包页面上同一张图可能以缩略图/预览图/原图多种形式存在
// 策略：按URL中的图片标识（路径中的hash部分）去重，保留最高清版本
function deduplicateImages(images) {
  // quality 优先级：image_raw > image_ori > image_preview > image_thumb > 其他
  const QUALITY_PRIORITY = {
    'image_raw': 5,
    'image_ori_raw': 5,
    'image_ori': 4,
    'image_preview': 3,
    'image_thumb': 2,
  };

  // 从URL中提取图片唯一标识
  // 例如：https://p11-flow-imagex-sign.byteimg.com/tos-cn-i-xxx/rc_gen_image/757c21aefa4f4539997df775097cab4f.jpeg~tplv-...
  // 唯一标识是 /tos-cn-i-xxx/rc_gen_image/757c21aefa4f4539997df775097cab4f.jpeg 这一段
  function extractImageId(url) {
    if (!url) return null;
    // 匹配 /tos-cn-i-.../.../hash.jpeg 部分
    const match = url.match(/(\/tos-[\w-]+\/[\w_]+\/[\w]+\.jpe?g)/);
    if (match) return match[1];
    // 备用：取 ~ 之前的部分
    const tildeIdx = url.indexOf('~');
    if (tildeIdx > 0) return url.substring(0, tildeIdx);
    return url;
  }

  // 从URL中提取质量等级
  function getQualityLevel(url) {
    if (!url) return 0;
    for (const [key, priority] of Object.entries(QUALITY_PRIORITY)) {
      if (url.includes(key)) return priority;
    }
    // watermark 结尾的优先级最低
    if (url.includes('watermark')) return 1;
    return 0;
  }

  // 从URL中推断分辨率
  function getResolution(url) {
    // byteimg URL中可能有分辨率信息
    const match = url.match(/(\d+)x(\d+)/);
    if (match) return parseInt(match[1]) * parseInt(match[2]);
    return 0;
  }

  const imageMap = new Map(); // imageId -> { url, previewUrl, width, height, quality, qualityLevel }

  for (const img of images) {
    const imageId = extractImageId(img.url);
    if (!imageId) continue;

    const qualityLevel = getQualityLevel(img.url);
    const resolution = getResolution(img.url) || (img.width && img.height ? img.width * img.height : 0);

    const existing = imageMap.get(imageId);
    if (!existing) {
      imageMap.set(imageId, {
        url: img.url,
        previewUrl: img.previewUrl || img.url,
        width: img.width || 0,
        height: img.height || 0,
        quality: qualityLevel,
        resolution: resolution,
      });
    } else {
      // 保留更高质量的版本
      if (qualityLevel > existing.qualityLevel || (qualityLevel === existing.qualityLevel && resolution > existing.resolution)) {
        existing.url = img.url;
        existing.previewUrl = img.previewUrl || img.url;
        existing.width = img.width || existing.width;
        existing.height = img.height || existing.height;
        existing.quality = qualityLevel;
        existing.resolution = resolution;
      }
    }
  }

  // 转换为数组，添加质量标签
  const result = [];
  for (const img of imageMap.values()) {
    let qualityLabel = '原图';
    if (img.quality >= 5) qualityLabel = '原图';
    else if (img.quality >= 4) qualityLabel = '高清';
    else if (img.quality >= 3) qualityLabel = '预览';
    else if (img.quality >= 2) qualityLabel = '缩略';
    else qualityLabel = '水印';

    result.push({
      url: img.url,
      previewUrl: img.previewUrl,
      width: img.width,
      height: img.height,
      qualityLabel: qualityLabel,
    });
  }

  return result;
}

// ── 渲染图片网格 ──────────────────────────────────────────────────────────────────────
async function renderImageGrid() {
  $imageGrid.innerHTML = '';

  if (imageList.length === 0) {
    $emptyState.style.display = 'block';
    return;
  }
  $emptyState.style.display = 'none';

  // 根据 sortOrder 排序：'desc' 倒序（最新在前，即列表末尾的图片排到前面）
  //                'asc' 正序（最早在前，即列表开头的图片排到前面）
  const sortedIndices = imageList.map((_, idx) => idx);
  if (sortOrder === 'desc') {
    sortedIndices.reverse();
  }

  sortedIndices.forEach(idx => {
    const img = imageList[idx];

    const card = document.createElement('div');
    card.className = 'image-card';
    card.dataset.index = idx;

    card.innerHTML = `
      <img src="${escapeHtml(img.previewUrl || img.url)}" alt="" loading="lazy" draggable="false" />
      <div class="check-mark">✓</div>
      <div class="quality-badge">${escapeHtml(img.qualityLabel || '')}</div>
    `;

    $imageGrid.appendChild(card);
  });
}

// ── 更新选中计数和按钮状态 ────────────────────────────────────────────────────
function updateSelection() {
  $imageGrid.querySelectorAll('.image-card').forEach(card => {
    const idx = parseInt(card.dataset.index);
    if (selectedSet.has(idx)) {
      card.classList.add('selected');
    } else {
      card.classList.remove('selected');
    }
  });

  const count = selectedSet.size;
  $downloadBtn.disabled = count === 0;
  $downloadBtn.textContent = count > 0 ? `下载 ${count} 张` : '下载选中';
}

// ── 设置Hook状态显示 ──────────────────────────────────────────────────────────
function setHookStatus(active, text) {
  $hookStatus.className = `status-dot ${active ? 'active' : 'inactive'}`;
  if (active) {
    $hookStatusText.textContent = text || '已启用';
    $hookStatusText.style.color = '#52c41a';
    $hookStatusText.classList.remove('clickable');
    $hookStatusText.title = '';
    $hookStatusText.onclick = null;
  } else if (text === '非豆包页面') {
    $hookStatusText.textContent = '非豆包页面';
    $hookStatusText.style.color = '#999';
    $hookStatusText.classList.remove('clickable');
    $hookStatusText.title = '';
    $hookStatusText.onclick = null;
  } else {
    $hookStatus.className = 'status-dot inactive pulse';
    $hookStatusText.innerHTML = '未生效 · <u>请点击刷新豆包页面</u>';
    $hookStatusText.style.color = '#ff4d4f';
    $hookStatusText.classList.add('clickable');
    $hookStatusText.title = '插件已开启，需刷新豆包页面才能生效';
    // 点击"未生效"文字时刷新当前豆包页面
    $hookStatusText.onclick = async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url && tab.url.includes('doubao.com')) {
          chrome.tabs.reload(tab.id);
          showPopupToast('插件已开启，正在刷新豆包页面…', 'info');
        } else {
          showPopupToast('请先打开豆包对话页面，再点击此处刷新', 'error');
        }
      } catch (e) { /* ignore */ }
    };
  }
}

// ── HTML转义 ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
