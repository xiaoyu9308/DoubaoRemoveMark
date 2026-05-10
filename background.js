/**
 * 豆包去水印 - Background Service Worker
 * 
 * 处理：
 * 1. 右键菜单注册
 * 2. 图片下载
 * 3. 批量下载
 * 4. 下载目录管理
 */

// ── 在豆包页面加载时注入主世界脚本 ──────────────────────────────────────────
// 使用 chrome.scripting.executeScript + world: "MAIN" 比 manifest 的 world 字段更可靠
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url && tab.url.includes('doubao.com')) {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['injected.js'],
      world: 'MAIN',
      injectImmediately: true
    }).catch(err => {
      console.error('[豆包去水印] 注入主世界脚本失败:', err);
    });
  }
});

// ── 默认下载目录 ──────────────────────────────────────────────────────────────
const DEFAULT_DOWNLOAD_DIR = '豆包无水印图片';

// ── 创建右键菜单 ──────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'download-no-watermark',
    title: '下载原图（无水印）',
    contexts: ['image'],
    documentUrlPatterns: ['https://*.doubao.com/*']
  });

  chrome.contextMenus.create({
    id: 'copy-no-watermark-url',
    title: '复制无水印图片链接',
    contexts: ['image'],
    documentUrlPatterns: ['https://*.doubao.com/*']
  });
});

// ── 右键菜单点击 ──────────────────────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'download-no-watermark') {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_IMAGE_INFO' });
      let downloadUrl = null;

      if (response) {
        downloadUrl = response.image_ori_raw?.url || response.image_ori?.url || response.imageUrl;
      }

      if (!downloadUrl && info.srcUrl) {
        downloadUrl = convertToNoWatermarkUrl(info.srcUrl) || info.srcUrl;
      }

      if (downloadUrl) {
        await downloadImage(downloadUrl, tab.id);
      } else {
        showToastInTab(tab.id, '未找到无水印图片URL', 'error');
      }
    } catch (e) {
      console.error('[豆包去水印] 获取图片信息失败:', e);
      if (info.srcUrl) {
        const url = convertToNoWatermarkUrl(info.srcUrl) || info.srcUrl;
        await downloadImage(url, tab.id);
      }
    }
  }

  if (info.menuItemId === 'copy-no-watermark-url') {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_IMAGE_INFO' });
      let url = null;
      if (response) {
        url = response.image_ori_raw?.url || response.image_ori?.url || response.imageUrl;
      }
      if (!url && info.srcUrl) {
        url = convertToNoWatermarkUrl(info.srcUrl) || info.srcUrl;
      }
      if (url) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (text) => { navigator.clipboard.writeText(text); },
          args: [url]
        });
        showToastInTab(tab.id, '无水印链接已复制', 'success');
      }
    } catch (e) {
      console.error('[豆包去水印] 复制链接失败:', e);
    }
  }
});

// ── URL转换：将带水印URL转为无水印URL ──────────────────────────────────────────
function convertToNoWatermarkUrl(url) {
  if (!url || !url.includes('byteimg.com')) return null;

  try {
    const patterns = [
      /(~tplv-[\w]+-)(downsize_watermark_\d+_\d+)(_[a-z]\.\w+)/,
      /(~tplv-[\w]+-)(pre_watermark)(_[a-z]\.\w+)/,
      /(~tplv-[\w]+-)(dld_watermark)(_[a-z]\.\w+)/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return url.replace(pattern, '$1image_raw$3');
      }
    }

    // 通用 watermark 替换
    if (url.includes('watermark')) {
      const newUrl = url.replace(/(~tplv-[\w]+-)[\w_]*watermark[\w_]*(_[a-z]\.\w+)/, '$1image_raw$2');
      if (newUrl !== url) return newUrl;
    }

    return null;
  } catch (e) {
    console.error('[豆包去水印] URL转换失败:', e);
    return null;
  }
}

// ── 下载图片 ──────────────────────────────────────────────────────────────────
async function downloadImage(url, tabId, filename, customDir) {
  try {
    // 获取下载目录
    let downloadDir = customDir;
    if (!downloadDir) {
      const stored = await chrome.storage.local.get('downloadDir');
      downloadDir = stored.downloadDir || DEFAULT_DOWNLOAD_DIR;
    }

    // 生成文件名
    if (!filename) {
      const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 17);
      const ext = url.match(/\.(png|jpe?g|webp)/)?.[1] || 'png';
      filename = 'doubao_' + timestamp + '.' + ext;
    }

    const fullPath = downloadDir + '/' + filename;

    const downloadId = await chrome.downloads.download({
      url: url,
      filename: fullPath,
      saveAs: false,
      conflictAction: 'uniquify'
    });

    if (tabId) {
      showToastInTab(tabId, '无水印图片下载中...', 'success');
    }
    console.log('[豆包去水印] 下载已开始, ID:', downloadId, '路径:', fullPath);
  } catch (e) {
    console.error('[豆包去水印] 下载失败:', e);
    if (tabId) {
      showToastInTab(tabId, '下载失败: ' + e.message, 'error');
    }
  }
}

// ── 批量下载 ──────────────────────────────────────────────────────────────────
async function batchDownload(urls, tabId, customDir) {
  let downloadDir = customDir;
  if (!downloadDir) {
    const stored = await chrome.storage.local.get('downloadDir');
    downloadDir = stored.downloadDir || DEFAULT_DOWNLOAD_DIR;
  }

  let success = 0;
  for (let i = 0; i < urls.length; i++) {
    try {
      const url = urls[i].url || urls[i];
      const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 17);
      const ext = url.match(/\.(png|jpe?g|webp)/)?.[1] || 'png';
      const filename = 'doubao_' + timestamp + '.' + ext;
      await downloadImage(url, null, filename, downloadDir);
      success++;
      // 间隔500ms避免下载太快
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error('[豆包去水印] 批量下载第', i + 1, '张失败:', e);
    }
  }
  if (tabId) {
    showToastInTab(tabId, '批量下载完成：' + success + '/' + urls.length, success === urls.length ? 'success' : 'info');
  }
}

// ── 在页面中显示Toast ─────────────────────────────────────────────────────────
function showToastInTab(tabId, message, type) {
  if (!tabId) return;
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: (msg, t) => {
      const colors = {
        info: { bg: '#e6f7ff', border: '#1890ff', color: '#1890ff' },
        success: { bg: '#f6ffed', border: '#52c41a', color: '#52c41a' },
        error: { bg: '#fff2f0', border: '#ff4d4f', color: '#ff4d4f' },
      };
      const c = colors[t] || colors.info;
      const toast = document.createElement('div');
      toast.textContent = msg;
      toast.style.cssText = 'position:fixed;top:40%;left:50%;transform:translateX(-50%);background:' + c.bg + ';color:' + c.color + ';padding:12px 24px;border:1px solid ' + c.border + ';border-radius:8px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.15);transition:opacity 0.3s ease;pointer-events:none;';
      document.body.appendChild(toast);
      setTimeout(function() {
        toast.style.opacity = '0';
        setTimeout(function() { toast.remove(); }, 300);
      }, 3000);
    },
    args: [message, type]
  });
}

// ── 监听来自content script和popup的消息 ──────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'DOWNLOAD_IMAGE':
      downloadImage(message.url, sender.tab?.id, message.filename, message.downloadDir);
      sendResponse({ success: true });
      break;

    case 'BATCH_DOWNLOAD':
      batchDownload(message.urls, sender.tab?.id, message.downloadDir);
      sendResponse({ success: true });
      break;

    case 'FETCH_IMAGE':
      // 代理获取图片数据（避免 popup 中的 CORS 限制）
      fetchImageData(message.url)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // 异步响应

    case 'GET_DOWNLOAD_DIR':
      // 获取 Chrome 默认下载目录的绝对路径
      getDownloadDir()
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'OPEN_DIRECTORY':
      // 在文件管理器中打开指定目录
      openDirectory(message.path)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'CHOOSE_DIRECTORY':
      // 通过 native host 弹出 macOS 原生选择目录对话框，返回绝对路径
      chooseDirectory(message.defaultLocation)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'WRITE_FILE_NATIVE':
      // 通过 native host 把 base64 内容写入指定绝对路径下的文件
      writeFileNative(message.dir, message.filename, message.dataBase64)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'TEST_NATIVE_PING':
      // 诊断：测试 Native Messaging 是否可用，返回 Python 环境信息
      testNativePing()
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
  }
  return true;
});

// ── 获取图片数据（返回 base64）──────────────────────────────────────────────
async function fetchImageData(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'image/*'
      }
    });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    const blob = await response.blob();
    const mimeType = blob.type || 'image/png';

    // 将 Blob 转为 base64
    // 分块处理避免 call stack overflow
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const CHUNK_SIZE = 0x8000; // 32KB per chunk
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
      binary += String.fromCharCode.apply(null, chunk);
    }
    const base64 = btoa(binary);

    return { success: true, data: base64, mimeType: mimeType };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── 获取 Chrome 默认下载目录的绝对路径 ────────────────────────────────────
async function getDownloadDir() {
  try {
    // 搜索最近的下载记录来推断下载目录
    const downloads = await chrome.downloads.search({
      limit: 1,
      orderBy: ['-startTime']
    });
    
    if (downloads && downloads.length > 0 && downloads[0].filename) {
      const filePath = downloads[0].filename;
      const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
      if (lastSep > 0) {
        return { success: true, path: filePath.substring(0, lastSep) };
      }
    }

    // 没有下载记录，创建一个极小的临时文件来探测路径
    const tempUrl = 'data:text/plain;base64,';
    const downloadId = await chrome.downloads.download({
      url: tempUrl,
      filename: '_doubao_probe_.tmp',
      saveAs: false,
      conflictAction: 'uniquify'
    });
    
    // 等待下载完成
    await new Promise(resolve => {
      const listener = (delta) => {
        if (delta.id === downloadId && delta.state && delta.state.current === 'complete') {
          chrome.downloads.onChanged.removeListener(listener);
          resolve();
        }
      };
      chrome.downloads.onChanged.addListener(listener);
      setTimeout(resolve, 2000);
    });

    const probeDownloads = await chrome.downloads.search({ id: downloadId });
    let downloadDir = '';
    if (probeDownloads && probeDownloads.length > 0 && probeDownloads[0].filename) {
      const filePath = probeDownloads[0].filename;
      const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
      if (lastSep > 0) {
        downloadDir = filePath.substring(0, lastSep);
      }
    }
    // 清理临时文件
    try { await chrome.downloads.removeFile(downloadId); } catch (e) {}
    try { await chrome.downloads.erase({ id: downloadId }); } catch (e) {}

    return { success: true, path: downloadDir };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── 在文件管理器中打开指定目录 ────────────────────────────────────────────
async function openDirectory(dirPath) {
  const result = await chrome.runtime.sendNativeMessage(
    'com.doubao.remove.mark',
    { command: 'open', path: dirPath }
  );
  if (result && result.success) {
    return { success: true };
  }
  return { success: false, error: result?.error || 'Native Messaging 返回失败' };
}

// ── 通过 native host 弹出 macOS 原生选择目录对话框 ─────────
async function chooseDirectory(defaultLocation) {
  try {
    const result = await chrome.runtime.sendNativeMessage(
      'com.doubao.remove.mark',
      { command: 'choose_dir', prompt: '请选择下载目录', default_location: defaultLocation || '' }
    );
    return result || { success: false, error: 'Native Messaging 无响应' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── 通过 native host 写文件（base64 -> 任意绝对路径）───────────
async function writeFileNative(dir, filename, dataBase64) {
  try {
    const result = await chrome.runtime.sendNativeMessage(
      'com.doubao.remove.mark',
      { command: 'write_file', dir: dir, filename: filename, data_base64: dataBase64 }
    );
    return result || { success: false, error: 'Native Messaging 无响应' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── 诊断：测试 Native Messaging 是否可用 ──────────────────────
async function testNativePing() {
  try {
    const result = await chrome.runtime.sendNativeMessage(
      'com.doubao.remove.mark',
      { command: 'ping' }
    );
    return { success: true, info: result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
