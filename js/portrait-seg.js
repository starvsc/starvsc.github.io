/**
 * 人像精细分割加载器(portrait-seg.js)
 *
 * 用 MediaPipe SelfieSegmentation 在浏览器做"人像前景分割"(需求:人像精细分割)。
 * 加载策略:优先本地 assets/vendor/mediapipe/(离线),否则回退 jsDelivr CDN。
 * 注意:与 face-api 不同,MediaPipe 需要 wasm 同源目录,本地化需整目录(见 tools/fetch_assets.py 扩展)。
 *
 * 用法:
 *   const seg = await getSegmenter({ onResult });
 *   seg.send({ image: videoOrImage });   // 触发 onResult({segmentationMask,...})
 */
const CDN_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation';
const LOCAL_BASE = './assets/vendor/mediapipe';

let _instance = null;
let _promise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => { s.remove(); reject(new Error('script 加载失败: ' + src)); };
    document.head.appendChild(s);
  });
}

/** 判断本地目录是否存在 mediapipe 脚本 */
async function localAvailable() {
  try {
    const r = await fetch(LOCAL_BASE + '/selfie_segmentation.js', { method: 'HEAD', cache: 'no-store' });
    return r.ok;
  } catch (e) {
    return false;
  }
}

/**
 * 获取(并缓存)一个 SelfieSegmentation 实例。
 * @param {{onResult?:Function}} opts
 */
export function getSegmenter({ onResult } = {}) {
  if (_instance) {
    if (onResult) _instance.onResults(onResult);
    return Promise.resolve(_instance);
  }
  if (!_promise) {
    _promise = (async () => {
      const lib = await loadLib();
      const base = await baseDir();
      const seg = new lib.SelfieSegmentation({
        locateFile: (file) => `${base}/${file}`,
      });
      await seg.setOptions({ modelSelection: 0, selfieMode: false });
      if (onResult) seg.onResults(onResult);
      _instance = seg;
      return seg;
    })();
  }
  return _promise.then((seg) => {
    if (onResult) seg.onResults(onResult);
    return seg;
  });
}

async function baseDir() {
  return (await localAvailable()) ? LOCAL_BASE : CDN_BASE;
}

async function loadLib() {
  if (window.SelfieSegmentation) return window;
  if (await localAvailable()) {
    try { await loadScript(LOCAL_BASE + '/selfie_segmentation.js'); } catch (e) { /* fallthrough */ }
  }
  if (!window.SelfieSegmentation) {
    await loadScript(CDN_BASE + '/selfie_segmentation.js');
  }
  if (!window.SelfieSegmentation) throw new Error('MediaPipe SelfieSegmentation 加载失败');
  return window;
}

/** 简单判断:一次 send 是否可能支持传入 canvas/image */
export function isSelfieLoaded() { return !!_instance; }
