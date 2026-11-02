// ===============================================
// 後端伺服器：存放問題設定、背景圖、音樂、大家的回覆
// 啟動：npm install && npm start
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

// 放在 public/media/ 的 background.jpg（或 .png/.jpeg/.webp）與 music.mp3（或 .m4a/.wav）
// 會被當成「永久預設」背景與音樂（適合 Render 免費方案，因為它重啟後會清掉後台上傳的檔案）
// 不分大小寫；名字不對也沒關係：資料夾裡第一張圖片就當背景、第一個音樂檔就當音樂
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
  intro: '請寫下你想說的話，送出後會立刻生成一段專屬影片 🎬',
  questions: ['你想對這個人說什麼話？', '你們之間最難忘的回憶是什麼？', '最後給他一句祝福吧！'],
  backgroundImage: findMedia('background', ['.jpg', '.jpeg', '.png', '.webp', '.gif']),
  music: findMedia('music', ['.mp3', '.m4a', '.wav', '.aac', '.ogg']),
  secondsPerLine: 3.5,   // 每句話顯示幾秒
  textColor: '#ffffff',
  fontSize: 56,
  overlay: 0.35,         // 背景變暗程度 0~0.8，讓字更清楚
  aspect: '16:9',        // '16:9' 橫式 或 '9:16' 直式（手機/限動）
  showQuestions: true    // 影片中是否顯示問題
};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
const getConfig = () => {
  const cfg = { ...DEFAULT_CONFIG, ...readJSON(CONFIG_FILE, {}) };
  // 後台沒上傳時，一律退回 media 資料夾裡的預設檔
  cfg.backgroundImage = cfg.backgroundImage || DEFAULT_CONFIG.backgroundImage;
  cfg.music = cfg.music || DEFAULT_CONFIG.music;
  return cfg;
};

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 上傳設定（只接受圖片與音樂，最大 30MB）----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) =>
      cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
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

app.post('/api/responses', (req, res) => {
  const { name = '', answers } = req.body || {};
  const cfg = getConfig();
  if (!Array.isArray(answers) || answers.length !== cfg.questions.length) {
    return res.status(400).json({ error: '回答格式不正確' });
  }
  const clean = answers.map(a => String(a || '').trim().slice(0, 1000));
  if (clean.every(a => !a)) return res.status(400).json({ error: '請至少回答一題' });

  const all = readJSON(RESPONSES_FILE, []);
  const entry = {
    id: crypto.randomUUID(),
    name: String(name).trim().slice(0, 50),
    questions: cfg.questions,
    answers: clean,
    createdAt: new Date().toISOString()
  };
  all.push(entry);
  writeJSON(RESPONSES_FILE, all);
  res.json({ ok: true, id: entry.id });
});

// ================= 管理 API（你自己用）=================
app.post('/api/admin/login', auth, (req, res) => res.json({ ok: true }));

app.put('/api/admin/config', auth, (req, res) => {
  const b = req.body || {};
  const cfg = getConfig();
  if (typeof b.title === 'string') cfg.title = b.title.slice(0, 100);
  if (typeof b.intro === 'string') cfg.intro = b.intro.slice(0, 500);
  if (Array.isArray(b.questions)) cfg.questions = b.questions.map(q => String(q).trim()).filter(Boolean).slice(0, 20);
  if (b.secondsPerLine) cfg.secondsPerLine = Math.min(15, Math.max(1, Number(b.secondsPerLine)));
  if (/^#[0-9a-f]{6}$/i.test(b.textColor)) cfg.textColor = b.textColor;
  if (b.fontSize) cfg.fontSize = Math.min(120, Math.max(20, Number(b.fontSize)));
  if (b.overlay !== undefined) cfg.overlay = Math.min(0.8, Math.max(0, Number(b.overlay)));
  if (['16:9', '9:16'].includes(b.aspect)) cfg.aspect = b.aspect;
  if (typeof b.showQuestions === 'boolean') cfg.showQuestions = b.showQuestions;
  writeJSON(CONFIG_FILE, cfg);
  res.json(cfg);
});

// kind=image 換背景圖；kind=music 換背景音樂
app.post('/api/admin/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '沒有收到檔案' });
  const cfg = getConfig();
  const key = req.query.kind === 'music' ? 'music' : 'backgroundImage';
  removeUpload(cfg[key]);
  cfg[key] = '/uploads/' + req.file.filename;
  writeJSON(CONFIG_FILE, cfg);
  res.json(cfg);
});

app.delete('/api/admin/media/:kind', auth, (req, res) => {
  const cfg = getConfig();
  const key = req.params.kind === 'music' ? 'music' : 'backgroundImage';
  removeUpload(cfg[key]);
  cfg[key] = null;
  writeJSON(CONFIG_FILE, cfg);
  res.json(cfg);
});

app.get('/api/admin/responses', auth, (req, res) => res.json(readJSON(RESPONSES_FILE, [])));
app.delete('/api/admin/responses', auth, (req, res) => { writeJSON(RESPONSES_FILE, []); res.json({ ok: true }); });

function removeUpload(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  fs.rm(path.join(UPLOAD_DIR, path.basename(url)), () => {});
}

app.use((err, req, res, next) => res.status(400).json({ error: err.message }));

app.listen(PORT, () => {
  console.log(`✅ 伺服器已啟動：http://localhost:${PORT}`);
  console.log(`   填寫頁面：http://localhost:${PORT}/`);
  console.log(`   管理頁面：http://localhost:${PORT}/admin.html`);
});
