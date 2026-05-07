/**
 * 豆包去水印 - Popup Script
 * 
 * 功能：状态显示、图片去重（只保留最高清）、框选多选、批量下载、下载目录选择
 */

// ── 全局状态 ──────────────────────────────────────────────────────────────────
let imageList = [];         // 去重后的图片列表 [{ url, previewUrl, width, height, quality }]
let selectedSet = new Set();
const DEFAULT_DOWNLOAD_DIR = '豆包无水印图片';

// ── DOM 引用 ──────────────────────────────────────────────────────────────────
const $hookStatus = document.getElementById('hookStatus');
const $hookStatusText = document.getElementById('hookStatusText');
const $imageGrid = document.getElementById('imageGrid');
const $emptyState = document.getElementById('emptyState');
const $selectAllBtn = document.getElementById('selectAllBtn');
const $deselectAllBtn = document.getElementById('deselectAllBtn');
const $selectedCount = document.getElementById('selectedCount');
const $downloadBtn = document.getElementById('downloadBtn');
const $dirDisplay = document.getElementById('dirDisplay');
const $changeDirBtn = document.getElementById('changeDirBtn');
const $dirFullPath = document.getElementById('dirFullPath');
const $openDirBtn = document.getElementById('openDirBtn');
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
  // ── 下载目录管理 ──────────────────────────────────────────────────────────
  // 核心思路：
  // - 使用 File System Access API (showDirectoryPicker) 获取目录句柄，直接写入文件
  // - 保存 dirHandle 到 IndexedDB（chrome.storage 无法存 Handle）
  // - 如果没有 dirHandle，回退到 chrome.downloads（相对路径，在默认下载目录下创建子目录）
  // - 手动输入的路径名作为相对子目录名使用

  let currentDirHandle = null;   // File System Access API 的目录句柄
  let currentDirName = DEFAULT_DOWNLOAD_DIR;  // 显示用的目录名

  // IndexedDB 操作：保存/读取 FileSystemDirectoryHandle
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
  const stored = await chrome.storage.local.get('downloadDir');
  currentDirName = stored.downloadDir || DEFAULT_DOWNLOAD_DIR;
  updateDirDisplay(currentDirName);

  // 尝试恢复 dirHandle
  // 注意：不在初始化时验证权限，因为 popup 打开时没有用户交互，
  // requestPermission 会失败。保留 dirHandle，等下载时再验证权限。
  const savedHandle = await loadDirHandle();
  if (savedHandle) {
    currentDirHandle = savedHandle;
    currentDirName = savedHandle.name;
    await chrome.storage.local.set({ downloadDir: savedHandle.name });
    updateDirDisplay(savedHandle.name);
  }

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
    currentDirName = dirName;
    // 手动输入时清除 dirHandle（改为相对路径模式）
    currentDirHandle = null;
    await removeDirHandle();
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

  // 选择目录按钮 — 弹出 Mac 原生目录选择器
  $changeDirBtn.addEventListener('click', async () => {
    try {
      // File System Access API — 弹出原生目录选择器
      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      // 验证权限
      const perm = await dirHandle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        console.warn('[豆包去水印] 目录写入权限未授予');
        return;
      }
      currentDirHandle = dirHandle;
      currentDirName = dirHandle.name;
      await saveDirHandle(dirHandle);
      await chrome.storage.local.set({ downloadDir: dirHandle.name });
      updateDirDisplay(dirHandle.name);
    } catch (e) {
      if (e.name === 'AbortError') return; // 用户取消选择
      console.error('[豆包去水印] 目录选择失败:', e);
      // 回退：手动输入模式
      $dirDisplay.textContent = currentDirName;
      $dirDisplay.contentEditable = true;
      $dirDisplay.focus();
    }
  });

  // 打开下载目录按钮 — 在 Finder 中打开下载目录
  $openDirBtn.addEventListener('click', async () => {
    $openDirBtn.disabled = true;
    try {
      const stored = await chrome.storage.local.get(['downloadDirFullPath']);
      const dirFullPath = stored.downloadDirFullPath;
      const targetPath = dirFullPath || '/Users/mars/Downloads/Doubao/Download';
      const result = await chrome.runtime.sendMessage({ type: 'OPEN_DIRECTORY', path: targetPath });
      if (result && result.success) {
        // 成功
      } else {
        const extId = chrome.runtime.id;
        const installCmd = `bash /Users/mars/Documents/WorkSpace/CodeBuddy/Chrome/DoubaoRemoveMark/install_native_host.sh ${extId}`;
        try { await navigator.clipboard.writeText(installCmd); } catch(e) {}
        showPopupToast('❌ Native未就绪，安装命令已复制到剪贴板', 'error');
        console.log('[豆包去水印] 请在终端运行:', installCmd);
      }
    } catch (e) {
      showPopupToast('打开下载目录失败', 'error');
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
    console.error('初始化失败:', e);
  }

  // 全选 / 取消全选
  $selectAllBtn.addEventListener('click', () => {
    imageList.forEach((_, i) => selectedSet.add(i));
    updateSelection();
  });
  $deselectAllBtn.addEventListener('click', () => {
    selectedSet.clear();
    updateSelection();
  });

  // 批量下载
  $downloadBtn.addEventListener('click', async () => {
    const selected = Array.from(selectedSet).map(i => imageList[i]).filter(Boolean);
    if (selected.length === 0) return;

    $downloadBtn.disabled = true;
    $downloadBtn.textContent = '下载中...';

    // 显示进度条和初始 toast
    showDownloadProgress(0, selected.length, 0);
    showPopupToast('正在下载无水印图片...', 'info', `0/${selected.length}`);

    let successCount = 0;
    let failCount = 0;

    // 预验证 dirHandle 权限（只在下载开始时验证一次）
    let useFileSystemAPI = !!currentDirHandle;
    let lastDownloadId = null;  // 记录最后一个下载ID，用于"打开目录"功能
    if (useFileSystemAPI) {
      try {
        const perm = await currentDirHandle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
          // 用户刚点击了下载按钮，此时 requestPermission 可以触发权限弹窗
          const req = await currentDirHandle.requestPermission({ mode: 'readwrite' });
          if (req !== 'granted') {
            console.warn('[豆包去水印] 目录写入权限未授予，回退到 chrome.downloads');
            useFileSystemAPI = false;
            showPopupToast('目录权限未授予，将下载到默认目录', 'info');
            await new Promise(r => setTimeout(r, 1500));
          }
        }
      } catch (e) {
        // handle 可能已失效（如目录被删除/移动），清除并提示用户重新选择
        console.warn('[豆包去水印] 目录权限验证失败，回退到 chrome.downloads:', e);
        useFileSystemAPI = false;
        currentDirHandle = null;
        await removeDirHandle();
        showPopupToast('目录已失效，将下载到默认目录，请重新选择目录', 'info');
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    for (let i = 0; i < selected.length; i++) {
      try {
        const url = selected[i].url;
        const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 17);
        const ext = url.match(/\.(png|jpe?g|webp)/)?.[1] || 'png';
        const filename = 'doubao_' + timestamp + '.' + ext;

        if (useFileSystemAPI) {
          // 方式1：使用 File System Access API 直接写入选定目录
          try {
            // 通过 background script 获取图片数据（避免 CORS 问题）
            const imageBlob = await new Promise((resolve, reject) => {
              chrome.runtime.sendMessage(
                { type: 'FETCH_IMAGE', url: url },
                (response) => {
                  if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                  }
                  if (response && response.success) {
                    // 将 base64 转为 Blob
                    const byteString = atob(response.data);
                    const ab = new ArrayBuffer(byteString.length);
                    const ia = new Uint8Array(ab);
                    for (let j = 0; j < byteString.length; j++) {
                      ia[j] = byteString.charCodeAt(j);
                    }
                    resolve(new Blob([ab], { type: response.mimeType || 'image/png' }));
                  } else {
                    reject(new Error(response?.error || '获取图片数据失败'));
                  }
                }
              );
            });

            // 创建文件并写入
            const fileHandle = await currentDirHandle.getFileHandle(filename, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(imageBlob);
            await writable.close();

            successCount++;
          } catch (fsErr) {
            // File System Access 失败，回退到 chrome.downloads
            console.warn('[豆包去水印] File System API 写入第', i + 1, '张失败，回退到 chrome.downloads:', fsErr);
            try {
              const fullPath = currentDirName + '/' + filename;
              lastDownloadId = await chrome.downloads.download({
                url: url,
                filename: fullPath,
                saveAs: false,
                conflictAction: 'uniquify'
              });
              successCount++;
            } catch (dlErr) {
              console.error('[豆包去水印] chrome.downloads 也失败:', dlErr);
              failCount++;
            }
          }
        } else {
          // 方式2：使用 chrome.downloads（相对路径，在默认下载目录下创建子目录）
          const fullPath = currentDirName + '/' + filename;
          lastDownloadId = await chrome.downloads.download({
            url: url,
            filename: fullPath,
            saveAs: false,
            conflictAction: 'uniquify'
          });
          successCount++;
        }

        // 更新进度
        const completed = i + 1;
        const percent = Math.round((completed / selected.length) * 100);
        showDownloadProgress(completed, selected.length, percent);
        showPopupToast('正在下载无水印图片...', 'info', `${completed}/${selected.length}`);

        // 间隔300ms避免下载太快
        if (i < selected.length - 1) {
          await new Promise(r => setTimeout(r, 300));
        }
      } catch (e) {
        console.error('[豆包去水印] 下载第', i + 1, '张失败:', e);
        failCount++;

        // 更新进度（失败也要更新）
        const completed = i + 1;
        const percent = Math.round((completed / selected.length) * 100);
        showDownloadProgress(completed, selected.length, percent);
        if (failCount > 0) {
          showPopupToast('正在下载无水印图片...', 'info', `${completed}/${selected.length}（失败 ${failCount} 张）`);
        }
      }
    }

    // 下载完成
    hideDownloadProgress();
    $downloadBtn.disabled = false;
    $downloadBtn.textContent = '下载选中';
    updateSelection();

    // 保存最后的下载ID，用于"打开目录"功能
    if (lastDownloadId) {
      await chrome.storage.local.set({ lastDownloadId: lastDownloadId });
      // 通过下载记录获取完整路径并更新显示
      try {
        const downloads = await chrome.downloads.search({ id: lastDownloadId });
        if (downloads && downloads.length > 0 && downloads[0].filename) {
          const filePath = downloads[0].filename;
          const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
          if (lastSep > 0) {
            const dirPath = filePath.substring(0, lastSep);
            $dirFullPath.textContent = dirPath;
            // 计算相对路径（去掉默认下载目录前缀）
            const relPath = await computeRelPath(dirPath);
            await chrome.storage.local.set({
              downloadDirFullPath: dirPath,
              downloadDirRelPath: relPath
            });
          }
        }
      } catch (e) {
        // 静默失败
      }
    } else if (useFileSystemAPI && successCount > 0) {
      // File System API 模式：需要通过 chrome.downloads 下载一个标记文件来获取 downloadId
      // 以便"打开目录"功能可以调用 chrome.downloads.show() 在 Finder 中定位
      try {
        // 使用 downloadDirRelPath（如果有）而非 currentDirName，确保标记文件下载到正确子目录
        const storedRelPath = await chrome.storage.local.get('downloadDirRelPath');
        const markerRelPath = (storedRelPath.downloadDirRelPath || currentDirName) + '/.doubao_dir_marker';
        const markerId = await chrome.downloads.download({
          url: 'data:application/octet-stream;base64,Vg==',
          filename: markerRelPath,
          saveAs: false,
          conflictAction: 'overwrite'
        });
        // 等待下载完成
        await new Promise(resolve => {
          const listener = (delta) => {
            if (delta.id === markerId && delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
              chrome.downloads.onChanged.removeListener(listener);
              resolve();
            }
          };
          chrome.downloads.onChanged.addListener(listener);
          setTimeout(resolve, 2000);
        });
        // 保存 downloadId，用于"打开目录"功能
        await chrome.storage.local.set({ lastDownloadId: markerId });
        lastDownloadId = markerId;
        // 获取完整路径
        const markerDownloads = await chrome.downloads.search({ id: markerId });
        if (markerDownloads && markerDownloads.length > 0 && markerDownloads[0].filename) {
          const filePath = markerDownloads[0].filename;
          const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
          if (lastSep > 0) {
            const dirPath = filePath.substring(0, lastSep);
            $dirFullPath.textContent = dirPath;
            // 计算相对路径
            const relPath = await computeRelPath(dirPath);
            await chrome.storage.local.set({
              downloadDirFullPath: dirPath,
              downloadDirRelPath: relPath
            });
          }
        }
        // 注意：保留 .doubao_dir_marker 标记文件（macOS Finder 默认隐藏 . 开头文件）
        // 不删除它，确保 chrome.downloads.show() 能可靠在 Finder 中定位该目录
      } catch (e) {
        // 标记文件下载失败不影响主流程，尝试推断路径
        try {
          const downloads = await chrome.downloads.search({ limit: 1, orderBy: ['-startTime'] });
          if (downloads && downloads.length > 0 && downloads[0].filename) {
            const defaultDir = downloads[0].filename;
            const lastSep = Math.max(defaultDir.lastIndexOf('/'), defaultDir.lastIndexOf('\\'));
            if (lastSep > 0) {
              const basePath = defaultDir.substring(0, lastSep);
              const fullPath = basePath + '/' + currentDirName;
              $dirFullPath.textContent = fullPath;
              await chrome.storage.local.set({
                downloadDirFullPath: fullPath,
                downloadDirRelPath: currentDirName
              });
            }
          }
        } catch (e2) {
          // 静默失败
        }
      }
    }

    // 显示完成 toast
    if (failCount > 0) {
      showPopupToast(
        `下载完成：成功 ${successCount} 张，失败 ${failCount} 张`,
        'error'
      );
    } else if (useFileSystemAPI) {
      showPopupToast(
        `✨ 已成功下载 ${successCount} 张图片到「${currentDirName}」`,
        'success'
      );
    } else {
      showPopupToast(
        `✨ 已成功下载 ${successCount} 张图片到默认下载目录的「${currentDirName}」文件夹`,
        'success'
      );
    }

    // 同时在页面中也显示 toast（如果页面还在）
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'SHOW_TOAST',
          text: failCount > 0
            ? `下载完成：成功 ${successCount} 张，失败 ${failCount} 张`
            : `已下载 ${successCount} 张无水印图片到 ${currentDirName}`,
          toastType: failCount > 0 ? 'info' : 'success'
        });
      }
    } catch (e) { /* ignore */ }
  });

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

// ── 渲染图片网格 ──────────────────────────────────────────────────────────────
function renderImageGrid() {
  $imageGrid.innerHTML = '';

  if (imageList.length === 0) {
    $emptyState.style.display = 'block';
    return;
  }
  $emptyState.style.display = 'none';

  imageList.forEach((img, idx) => {
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
  $selectedCount.textContent = `已选 ${count} 张`;
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
    $hookStatusText.innerHTML = '⚠️ 未生效 · <u>点击刷新豆包页面</u>';
    $hookStatusText.style.color = '#ff4d4f';
    $hookStatusText.classList.add('clickable');
    $hookStatusText.title = '插件已开启，需刷新豆包页面才能生效';
    // 点击"未生效"文字时刷新当前豆包页面
    $hookStatusText.onclick = async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url && tab.url.includes('doubao.com')) {
          chrome.tabs.reload(tab.id);
          showPopupToast('✅ 插件已开启，正在刷新豆包页面…', 'info');
        } else {
          showPopupToast('⚠️ 请先打开豆包对话页面，再点击此处刷新', 'error');
        }
      } catch (e) { /* ignore */ }
    };
  }
}

  // 计算目录的相对路径（相对于 Chrome 默认下载目录）
  async function computeRelPath(dirFullPath) {
    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_DOWNLOAD_DIR' }, (res) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res);
        });
      });
      if (response && response.success && response.path && dirFullPath.startsWith(response.path + '/')) {
        return dirFullPath.substring(response.path.length + 1);
      }
    } catch (e) { /* ignore */ }
    // 回退：使用 currentDirName
    return currentDirName;
  }

  // ── 更新目录显示 ──────────────────────────────────────────────────────────────
  function updateDirDisplay(dir) {
    $dirDisplay.textContent = dir;
    if (dir === DEFAULT_DOWNLOAD_DIR) {
      $dirDisplay.textContent = dir + '（默认）';
      $dirDisplay.classList.add('default');
    } else {
      $dirDisplay.classList.remove('default');
    }
    // 更新完整路径显示
    updateFullPathDisplay();
  }

  // 更新完整路径显示
  async function updateFullPathDisplay() {
    try {
      // 获取默认下载目录的绝对路径
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_DOWNLOAD_DIR' }, (res) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res);
        });
      });

      if (response && response.success && response.path) {
        // 获取保存的相对路径（可能比 currentDirName 更准确）
        const stored = await chrome.storage.local.get(['downloadDirFullPath', 'downloadDirRelPath']);
        const relPath = stored.downloadDirRelPath || currentDirName;
        const fullPath = response.path + '/' + relPath;
        $dirFullPath.textContent = fullPath;
        await chrome.storage.local.set({
          downloadDirFullPath: fullPath,
          downloadDirRelPath: relPath
        });
      } else {
        // 无法获取默认下载目录，只显示目录名
        const stored = await chrome.storage.local.get('downloadDirFullPath');
        if (stored.downloadDirFullPath) {
          $dirFullPath.textContent = stored.downloadDirFullPath;
        } else {
          $dirFullPath.textContent = currentDirName;
        }
      }
    } catch (e) {
      // 静默失败，不影响主流程
    }
  }

// ── HTML转义 ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
