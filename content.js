/**
 * 豆包去水印 - Content Script（隔离世界）
 * 
 * 架构说明：
 * - injected.js：在页面主世界运行（manifest.json world:MAIN），Hook JSON.parse 提取图片数据
 * - content.js：在隔离世界运行，接收 injected.js 通过 postMessage 传来的图片数据
 * - 两者通过 window.postMessage 通信，绕过 CSP 限制
 * 
 * 功能：
 * 1. 接收主世界 Hook 传来的无水印图片 URL
 * 2. 图片去重，只保留每张图片的最高清版本
 * 3. 支持右键菜单下载原图
 * 4. 供 popup 查询和批量下载
 */

(function () {
  'use strict';

  // ── 配置 ──────────────────────────────────────────────────────────────────────
  const CONFIG = {
    debug: true,
  };

  // ── 收集到的图片数据 ────────────────────────────────────────────────────────
  // { [imageId]: { url, previewUrl, width, height } }
  const collectedImages = new Map();

  // ── 日志工具 ──────────────────────────────────────────────────────────────────
  function log(...args) {
    if (CONFIG.debug) {
      console.log('[豆包去水印]', ...args);
    }
  }

  // ── 监听来自页面主世界的消息 ────────────────────────────────────────────────
  // 注：Hook JSON.parse 的代码已移至 injected.js，通过 manifest.json world:MAIN 在主世界运行
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    if (event.data && event.data.type === 'DOUBAO_NOWATERMARK_IMAGES') {
      const images = event.data.images || [];
      for (const img of images) {
        // 优先使用无水印原图URL
        const bestUrl = img.image_ori_raw_url || img.image_ori_url || img.image_preview_url || img.image_thumb_url;
        if (!bestUrl) continue;

        // 用URL路径中的图片hash作为唯一标识去重
        const imageId = extractImageId(bestUrl);
        if (!imageId) continue;

        const existing = collectedImages.get(imageId);
        const newQuality = getQualityLevel(bestUrl);

        if (!existing) {
          // 预览图用缩略图URL（显示更小更快）
          const previewUrl = img.image_thumb_url || img.image_preview_url || img.image_ori_url || bestUrl;
          collectedImages.set(imageId, {
            url: bestUrl,
            previewUrl: previewUrl,
            width: 0,
            height: 0,
            qualityLevel: newQuality,
          });
          log('新图片:', imageId, '质量:', newQuality, 'URL:', bestUrl);
        } else if (newQuality > existing.qualityLevel) {
          // 发现更高质量的版本，更新
          existing.url = bestUrl;
          existing.qualityLevel = newQuality;
          log('更新图片为更高质量:', imageId, '新质量:', newQuality);
        }
      }
      log('当前共收集', collectedImages.size, '张不重复图片');
    }
  });

  // ── 从URL中提取图片唯一标识 ────────────────────────────────────────────────
  function extractImageId(url) {
    if (!url) return null;
    const match = url.match(/(\/tos-[\w-]+\/[\w_]+\/[\w]+\.jpe?g)/);
    if (match) return match[1];
    const tildeIdx = url.indexOf('~');
    if (tildeIdx > 0) return url.substring(0, tildeIdx);
    return url;
  }

  // ── 获取URL质量等级 ────────────────────────────────────────────────────────
  function getQualityLevel(url) {
    if (!url) return 0;
    if (url.includes('image_raw') || url.includes('image_ori_raw')) return 5;
    if (url.includes('image_ori')) return 4;
    if (url.includes('image_preview')) return 3;
    if (url.includes('image_thumb')) return 2;
    if (url.includes('watermark')) return 1;
    return 0;
  }

  // ── 从React Fiber中提取图片信息（右键菜单用）────────────────────────────────
  function getImageInfoFromFiber(imgEl) {
    const fiberKey = Object.keys(imgEl).find(k => k.startsWith('__reactFiber'));
    if (!fiberKey) return null;
    let fiber = imgEl[fiberKey];
    let depth = 0;
    while (fiber && depth < 20) {
      const props = fiber.memoizedProps;
      if (props) {
        if (props.realImageInfo) return props.realImageInfo;
        if (props.image && props.image.image_ori_raw) return props.image;
        if (props.src && props.src.includes('byteimg.com')) return { imageUrl: props.src };
      }
      fiber = fiber.return;
      depth++;
    }
    return null;
  }

  // ── 存储右键点击时的图片信息 ──────────────────────────────────────────────────
  let lastRightClickedImageInfo = null;

  document.addEventListener('contextmenu', (e) => {
    if (e.target.tagName === 'IMG') {
      lastRightClickedImageInfo = getImageInfoFromFiber(e.target);
      // 也尝试从collectedImages中查找匹配的无水印URL
      if (!lastRightClickedImageInfo && e.target.src) {
        const srcId = extractImageId(e.target.src);
        if (srcId && collectedImages.has(srcId)) {
          lastRightClickedImageInfo = { imageUrl: collectedImages.get(srcId).url };
        }
      }
      if (lastRightClickedImageInfo) {
        log('右键捕获到图片信息:', lastRightClickedImageInfo);
      }
    }
  }, true);

  // ── Toast 提示 ────────────────────────────────────────────────────────────────
  function showToast(message, type) {
    type = type || 'info';
    var colors = {
      info: { bg: '#e6f7ff', border: '#1890ff', color: '#1890ff' },
      success: { bg: '#f6ffed', border: '#52c41a', color: '#52c41a' },
      error: { bg: '#fff2f0', border: '#ff4d4f', color: '#ff4d4f' },
    };
    var c = colors[type] || colors.info;
    var toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = 'position:fixed;top:40%;left:50%;transform:translateX(-50%);background:' + c.bg + ';color:' + c.color + ';padding:12px 24px;border:1px solid ' + c.border + ';border-radius:8px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.15);transition:opacity 0.3s ease;pointer-events:none;';
    document.body.appendChild(toast);
    setTimeout(function() {
      toast.style.opacity = '0';
      setTimeout(function() { toast.remove(); }, 300);
    }, 3000);
  }

  // ── 收集所有无水印图片URL（供popup调用）───────────────────────────────────
  function collectNoWatermarkUrls() {
    var urls = [];

    // 1. 优先使用Hook收集到的图片（来自JSON.parse拦截）
    if (collectedImages.size > 0) {
      collectedImages.forEach(function(img, id) {
        urls.push({
          url: img.url,
          previewUrl: img.previewUrl || img.url,
          width: img.width || 0,
          height: img.height || 0,
        });
      });
      return urls;
    }

    // 2. 备用方案：从页面DOM中扫描图片元素
    var images = document.querySelectorAll('img[src*="byteimg.com"]');
    images.forEach(function(img) {
      var fiberInfo = getImageInfoFromFiber(img);
      var noWatermarkUrl = null;
      if (fiberInfo) {
        noWatermarkUrl = (fiberInfo.image_ori_raw && fiberInfo.image_ori_raw.url) ||
                         (fiberInfo.image_ori && fiberInfo.image_ori.url) ||
                         fiberInfo.imageUrl;
      }
      if (!noWatermarkUrl && img.src) {
        noWatermarkUrl = img.src;
      }
      if (noWatermarkUrl) {
        urls.push({
          url: noWatermarkUrl,
          previewUrl: img.src,
          width: img.naturalWidth || 0,
          height: img.naturalHeight || 0,
        });
      }
    });
    return urls;
  }

  // ── 消息监听 ──────────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    switch (message.type) {
      case 'GET_STATUS':
        sendResponse({
          hookActive: true,
          imageCount: collectedImages.size
        });
        break;

      case 'GET_IMAGE_INFO':
        sendResponse(lastRightClickedImageInfo);
        break;

      case 'COLLECT_IMAGES':
        sendResponse({ images: collectNoWatermarkUrls() });
        break;

      case 'DOWNLOAD_IMAGE':
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_IMAGE',
          url: message.url,
          downloadDir: message.downloadDir,
          filename: message.filename
        });
        sendResponse({ success: true });
        break;

      case 'SHOW_TOAST':
        showToast(message.text, message.toastType || 'info');
        sendResponse({ success: true });
        break;
    }
    return true;
  });

  // ── 注：Hook脚本已通过 manifest.json world:MAIN 在主世界自动加载，无需手动注入 ──
  log('Content Script 已加载，等待 injected.js 的消息...');
})();
