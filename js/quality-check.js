/**
 * 人脸图像质量检测自检页(quality-check.js)
 * 上传一张人脸图 -> 检测 68 点 -> 跑 checkEnrollmentQuality 的 8 项校验 -> 显示结果与对应要求。
 * 与录入环节共用同一套质量门槛,便于无摄像头时验证与标定阈值。
 * 输入源用 <img>(比 <video> 加载静态图更可靠),检测与质量函数已兼容 img/canvas/video。
 */
import { ensureEngine, detectMetrics } from './face-engine.js';
import { checkEnrollmentQuality } from './quality.js';

const $ = (id) => document.getElementById(id);
const els = {
  upload: $('qc-upload'), file: $('qc-file'),
  img: $('qc-img'),
  verdict: $('qc-verdict'), items: $('qc-items'), msg: $('qc-msg'),
};

function setMsg(t) { els.msg.textContent = t; }

function renderQuality(q) {
  const chip = (label, val, ok) =>
    `<span class="q-item ${ok ? 'good' : 'bad'}"><b>${label}</b><i>${val}</i></span>`;
  els.items.innerHTML = (q.checks || []).map((c) => chip(c.label, c.value, c.pass)).join('');

  els.verdict.hidden = false;
  if (q.ok) {
    els.verdict.className = 'qc-verdict pass';
    els.verdict.textContent = '✓ 通过：8 项质量校验全部达标';
  } else {
    els.verdict.className = 'qc-verdict fail';
    els.verdict.textContent = '✕ 不通过：' + (q.failed ? q.failed.requirement : '未达标');
  }
}

async function useFile(file) {
  setMsg('加载人脸模型中…');
  try {
    await ensureEngine((st) => {
      if (st === 'loading-models') setMsg('加载人脸模型（首次需联网或已下载本地 assets）…');
    });

    const url = URL.createObjectURL(file);
    await new Promise((res, rej) => {
      els.img.onload = () => res();
      els.img.onerror = () => rej(new Error('图片加载失败'));
      els.img.src = url;
    });

    setMsg('检测中…');
    const m = await detectMetrics(els.img);
    if (!m || !m.ok) {
      els.items.innerHTML = '';
      els.verdict.hidden = false;
      els.verdict.className = 'qc-verdict fail';
      els.verdict.textContent = '未检测到人脸：请换一张清晰的正面人脸图';
      setMsg(m && m.reason === 'too-small' ? '人脸过小，请换更清晰的大图' : '未检测到人脸');
      URL.revokeObjectURL(url);
      return;
    }

    const q = checkEnrollmentQuality(els.img, m);
    renderQuality(q);
    setMsg(q.ok ? '检测完成。' : '检测完成，存在不达标项。');
    URL.revokeObjectURL(url);
  } catch (e) {
    setMsg('处理失败：' + ((e && e.message) || e));
  }
}

els.upload.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', () => {
  if (els.file.files && els.file.files[0]) useFile(els.file.files[0]);
  els.file.value = '';
});
