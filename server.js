// ===============================================
// 後端伺服器：存放問題設定、背景圖、大家的回覆
// 啟動：npm install && npm start
// 留言永久保存：設定環境變數 SHEET_URL、SHEET_KEY 後，留言會同步存到 Google 試算表
//               （做法見 google-sheet-script.js 檔案最上面的說明）
// ===============================================
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
// ⚠️ 上線前一定要改成自己的密碼（用環境變數 ADMIN_PASSWORD 設定）
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'admin123').trim();

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const RESPONSES_FILE = path.join(DATA_DIR, 'responses.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 放在 public/media/ 的圖片會被當成「永久預設」背景
// （適合 Render 免費方案，因為它重啟後會清掉後台上傳的檔案）
// 檔名不限、不分大小寫：資料夾裡第一張圖片就當背景
function findMedia(base, exts) {
  let files = [];
  try { files = fs.readdirSync(path.join(__dirname, 'public', 'media')); } catch { return null; }
  const matches = files.filter(f => exts.includes(path.extname(f).toLowerCase())).sort();
  const pick = matches.find(f => f.toLowerCase().startsWith(base)) || matches[0];
  return pick ? `/media/${encodeURIComponent(pick)}` : null;
}

// ===== 想永久保存的設定，直接改這裡（標題、問題、秒數…）=====
const DEFAULT_CONFIG = {
  title: '給你的悄悄話',
  intro: '請寫下你想說的話，大家的留言會一起做成一支影片 🎬',
  questions: ['你想對這個人說什麼話？', '你們之間最難忘的回憶是什麼？', '最後給他一句祝福吧！'],
  backgroundImage: findMedia('background', ['.jpg', '.jpeg', '.png', '.webp', '.gif']),
  music: null,           // 已取消背景音樂
  secondsPerLine: 6,     // 每個畫面停留幾秒
  perPage: 4,            // 每個畫面幾則留言（3 或 4）
  textColor: '#ffffff',
  fontSize: 56,
  overlay: 0.35,         // 背景變暗程度 0~0.8，讓字更清楚
  aspect: '16:9',        // '16:9' 橫式 或 '9:16' 直式（手機/限動）
  outro: '♥'             // 合併影片的片尾文字（空白＝沒有片尾）
};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
const getConfig = () => {
  const cfg = { ...DEFAULT_CONFIG, ...readJSON(CONFIG_FILE, {}) };
  // 後台上傳的圖片在 Render 重啟後會消失（media 裡的圖也可能被換掉）：檔案不在了就改用預設圖
  if (cfg.backgroundImage && /^\/(uploads|media)\//.test(cfg.backgroundImage) &&
      !fs.existsSync(path.join(__dirname, 'public', decodeURIComponent(cfg.backgroundImage)))) cfg.backgroundImage = null;
  // 後台沒上傳時，一律退回 media 資料夾裡的預設檔
  cfg.backgroundImage = cfg.backgroundImage || DEFAULT_CONFIG.backgroundImage;
  cfg.music = null;
  return cfg;
};

// ================= 留言儲存（Google 試算表 + 本機備份）=================
const SHEET_URL = (process.env.SHEET_URL || '').trim();
const SHEET_KEY = (process.env.SHEET_KEY || '').trim();
const useSheet = !!(SHEET_URL && SHEET_KEY);
let responses = readJSON(RESPONSES_FILE, []); // 所有留言（記憶體中）
let pending = [];                             // 還沒成功寫進試算表的留言
let lastSheetError = '';
let sheetLoaded = false;                      // 是否已成功從試算表讀回留言
let sheetLink = '';                           // 試算表本身的網址（後台顯示連結用）

const saveLocal = () => writeJSON(RESPONSES_FILE, responses);

async function sheetCall(payload) {
  const res = await fetch(SHEET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ key: SHEET_KEY, ...payload }),
    redirect: 'follow',
    signal: AbortSignal.timeout(25000)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    // Google 回傳的是錯誤網頁：抓出裡面的文字當作錯誤原因
    const reason = text.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new Error('Google 沒有正確回應' + (reason ? `（${reason}）` : '') +
      '。請確認 Apps Script 已用「新版本」部署，且「誰可以存取」選了「所有人」');
  }
  if (data.error) throw new Error(data.error);
  return data;
}

// 從試算表讀回所有留言（試算表為主）
// 本機有、試算表沒有的留言：還沒寫進去過的會補寫；寫進去過的代表你在試算表刪掉了，就跟著刪掉
async function loadFromSheet() {
  const data = await sheetCall({ action: 'list' });
  const fromSheet = (data.responses || []).map(r => ({ ...r, _synced: true }));
  if (data.url) sheetLink = data.url;
  if (data.config && typeof data.config === 'object') {
    writeJSON(CONFIG_FILE, data.config); // 讀回後台設定
    await restoreImage(data.config).catch(e => console.error('❌ 讀回背景圖片失敗：', e.message));
  }
  const ids = new Set(fromSheet.map(r => r.id));
  const localOnly = responses.filter(r => !ids.has(r.id) && !r._synced);
  responses = [...fromSheet, ...localOnly].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  pending = localOnly;
  saveLocal();
  sheetLoaded = true;
  lastSheetError = '';
  await flushPending();
}

// 把還沒寫進試算表的留言補寫上去
let flushing = null;
function flushPending() {
  if (!useSheet || !pending.length) return Promise.resolve();
  if (flushing) return flushing;
  flushing = (async () => {
    while (pending.length) {
      try {
        const { _synced, ...entry } = pending[0];
        await sheetCall({ action: 'add', entry });
        pending[0]._synced = true; // 標記「已寫進試算表」
        pending.shift();
        saveLocal();
        lastSheetError = '';
      } catch (e) {
        lastSheetError = e.message;
        console.error('❌ 寫入試算表失敗，稍後重試：', e.message);
        break;
      }
    }
    flushing = null;
  })();
  return flushing;
}
// 每分鐘：還沒讀到試算表就再試一次；讀到了就補寫失敗的留言
// 每 5 分鐘：重新讀一次試算表（你在試算表刪掉的留言，最慢 5 分鐘後網站也會跟著消失）
let tick = 0;
if (useSheet) setInterval(() => {
  tick++;
  if (!sheetLoaded || tick % 5 === 0) loadFromSheet().catch(e => (lastSheetError = e.message));
  else flushPending();
}, 60 * 1000);

// 後台上傳的背景圖片在 Render 重啟後會消失：從 Google 雲端硬碟抓回來
async function restoreImage(cfg) {
  const url = cfg.backgroundImage;
  if (!url || !url.startsWith('/uploads/')) return;
  const file = path.join(UPLOAD_DIR, path.basename(url));
  if (fs.existsSync(file)) return;
  const img = await sheetCall({ action: 'getImage' });
  if (img.data) {
    fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
    console.log('🖼️ 已從 Google 雲端硬碟讀回背景圖片');
  }
}

// 儲存後台設定：本機一份，Google 一份（網站重啟後從 Google 讀回）
async function saveConfig(cfg) {
  writeJSON(CONFIG_FILE, cfg);
  if (!useSheet) return { _storage: 'local' };
  try {
    await sheetCall({ action: 'setConfig', config: cfg });
    return { _storage: 'sheet', _savedToSheet: true };
  } catch (e) {
    const msg = e.message === '未知的動作'
      ? 'Google Apps Script 是舊版，請貼上新版程式並用「新版本」重新部署'
      : e.message;
    return { _storage: 'sheet', _savedToSheet: false, _error: msg };
  }
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 上傳設定（只接受圖片與音樂，最大 30MB）----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) =>
      cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 最大 10MB
  fileFilter: (req, file, cb) => {
    const ok = req.query.kind === 'music' ? file.mimetype.startsWith('audio/') : file.mimetype.startsWith('image/');
    cb(ok ? null : new Error('檔案類型不符'), ok);
  }
});

// ---------- 管理員驗證 ----------
function auth(req, res, next) {
  let given = req.get('x-admin-password') || '';
  try { given = decodeURIComponent(given); } catch {}
  if (given.trim() === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: '密碼錯誤' });
}

// ================= 公開 API（填寫者用）=================
app.get('/api/config', (req, res) => res.json(getConfig()));

app.post('/api/responses', async (req, res) => {
  const { name = '', answers } = req.body || {};
  const cfg = getConfig();
  if (!Array.isArray(answers) || answers.length !== cfg.questions.length) {
    return res.status(400).json({ error: '回答格式不正確' });
  }
  if (!String(name).trim()) return res.status(400).json({ error: '請填寫你的名字' });
  const clean = answers.map(a => String(a || '').trim().slice(0, 1000));
  if (clean.every(a => !a)) return res.status(400).json({ error: '請至少回答一題' });

  const entry = {
    id: crypto.randomUUID(),
    name: String(name).trim().slice(0, 50),
    questions: cfg.questions,
    answers: clean,
    createdAt: new Date().toISOString()
  };
  responses.push(entry);
  saveLocal();
  res.json({ ok: true, id: entry.id }); // 先告訴填寫者成功，不用等 Google
  if (useSheet) {
    pending.push(entry);
    flushPending(); // 在背景依序寫進 Google 試算表（失敗會每分鐘自動重試）
  }
});

// ================= 管理 API（你自己用）=================
app.post('/api/admin/login', auth, (req, res) => res.json({ ok: true }));

// 留言儲存狀態（後台顯示用）
app.get('/api/admin/status', auth, (req, res) => res.json({
  storage: useSheet ? 'sheet' : 'local',
  count: responses.length,
  pending: pending.length,
  error: lastSheetError,
  sheetLink
}));

app.put('/api/admin/config', auth, async (req, res) => {
  const b = req.body || {};
  const cfg = getConfig();
  if (typeof b.title === 'string') cfg.title = b.title.slice(0, 100);
  if (typeof b.intro === 'string') cfg.intro = b.intro.slice(0, 500);
  if (Array.isArray(b.questions)) cfg.questions = b.questions.map(q => String(q).trim()).filter(Boolean).slice(0, 20);
  if (b.secondsPerLine) cfg.secondsPerLine = Math.min(20, Math.max(2, Number(b.secondsPerLine)));
  if ([3, 4].includes(Number(b.perPage))) cfg.perPage = Number(b.perPage);
  if (/^#[0-9a-f]{6}$/i.test(b.textColor)) cfg.textColor = b.textColor;
  if (b.fontSize) cfg.fontSize = Math.min(120, Math.max(20, Number(b.fontSize)));
  if (b.overlay !== undefined) cfg.overlay = Math.min(0.8, Math.max(0, Number(b.overlay)));
  if (['16:9', '9:16'].includes(b.aspect)) cfg.aspect = b.aspect;
  if (typeof b.outro === 'string') cfg.outro = b.outro.slice(0, 100);
  const result = await saveConfig(cfg);
  res.json({ ...cfg, ...result });
});

// kind=image 換背景圖；kind=music 換背景音樂
app.post('/api/admin/upload', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '沒有收到檔案' });
  const cfg = getConfig();
  const key = req.query.kind === 'music' ? 'music' : 'backgroundImage';
  removeUpload(cfg[key]);
  cfg[key] = '/uploads/' + req.file.filename;
  // 圖片也存一份到 Google 雲端硬碟
  let imageError = '';
  if (useSheet && key === 'backgroundImage') {
    try {
      await sheetCall({
        action: 'saveImage', mime: req.file.mimetype, name: req.file.filename,
        data: fs.readFileSync(req.file.path).toString('base64')
      });
    } catch (e) {
      imageError = e.message === '未知的動作'
        ? 'Google Apps Script 是舊版，請貼上新版程式並用「新版本」重新部署'
        : e.message;
    }
  }
  const result = await saveConfig(cfg);
  if (imageError) Object.assign(result, { _savedToSheet: false, _error: '圖片沒能存到 Google 雲端硬碟：' + imageError });
  res.json({ ...cfg, ...result });
});

app.delete('/api/admin/media/:kind', auth, async (req, res) => {
  const cfg = getConfig();
  const key = req.params.kind === 'music' ? 'music' : 'backgroundImage';
  removeUpload(cfg[key]);
  cfg[key] = null;
  if (useSheet && key === 'backgroundImage') await sheetCall({ action: 'deleteImage' }).catch(() => {});
  const result = await saveConfig(cfg);
  res.json({ ...cfg, ...result });
});

// ?refresh=1：重新從試算表讀取（例如你直接在試算表刪了幾列）
app.get('/api/admin/responses', auth, async (req, res) => {
  if (useSheet && req.query.refresh) {
    try { await loadFromSheet(); } catch (e) { lastSheetError = e.message; }
  }
  res.json(responses);
});

// 刪除單一則留言（試算表也同步刪除）
app.delete('/api/admin/responses/:id', auth, async (req, res) => {
  const entry = responses.find(r => r.id === req.params.id);
  if (!entry) return res.json({ ok: true });
  if (useSheet && entry._synced) {
    try { await sheetCall({ action: 'delete', id: entry.id }); } catch (e) {
      const msg = e.message === '未知的動作'
        ? 'Google Apps Script 是舊版，請貼上新版程式並用「新版本」重新部署'
        : e.message;
      return res.status(500).json({ error: '刪除失敗：' + msg });
    }
  }
  responses = responses.filter(r => r.id !== entry.id);
  pending = pending.filter(r => r.id !== entry.id);
  saveLocal();
  res.json({ ok: true });
});

app.delete('/api/admin/responses', auth, async (req, res) => {
  if (useSheet) {
    try { await sheetCall({ action: 'clear' }); } catch (e) {
      return res.status(500).json({ error: '清空試算表失敗：' + e.message });
    }
  }
  responses = [];
  pending = [];
  saveLocal();
  res.json({ ok: true });
});

function removeUpload(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  fs.rm(path.join(UPLOAD_DIR, path.basename(url)), () => {});
}

app.use((err, req, res, next) => res.status(400).json({ error: err.message }));

(async () => {
  if (useSheet) {
    try {
      await loadFromSheet();
      console.log(`📄 已從 Google 試算表讀回 ${responses.length} 則留言`);
    } catch (e) {
      lastSheetError = e.message;
      console.error('❌ 無法讀取 Google 試算表：', e.message);
    }
  } else {
    console.log('⚠️ 沒有設定 SHEET_URL / SHEET_KEY，留言只暫存在伺服器上（休眠或重啟後會消失）');
  }
  app.listen(PORT, () => {
    console.log(`✅ 伺服器已啟動：http://localhost:${PORT}`);
    console.log(`   填寫頁面：http://localhost:${PORT}/`);
    console.log(`   管理頁面：http://localhost:${PORT}/admin.html`);
  });
})();
