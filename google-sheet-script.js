/* =====================================================================
 * 把留言永久保存到 Google 試算表：請把這整個檔案的內容複製到 Google Apps Script
 *
 * 設定步驟：
 * 1. 到 Google 雲端硬碟，新增一個「Google 試算表」，命名為例如「留言影片-留言」。
 * 2. 在試算表上方選單點「擴充功能」→「Apps Script」。
 * 3. 把編輯器裡原本的內容全部刪掉，貼上這個檔案的全部內容。
 * 4. 把下面 SECRET 引號裡的文字，改成一組你自己想的密碼（英文或數字，越長越好）。
 * 5. 按上方的「儲存」圖示。
 * 6. 按右上角「部署」→「新增部署作業」→ 左邊齒輪選「網頁應用程式」：
 *      - 執行身分：我
 *      - 誰可以存取：所有人
 *    按「部署」，依指示授權（若出現「Google 尚未驗證這個應用程式」，
 *    點「進階」→「前往（不安全）」→「允許」，這是你自己的程式所以沒關係）。
 * 7. 複製「網頁應用程式」網址（https://script.google.com/macros/s/.../exec）。
 * 8. 到 Render 的 Environment 新增兩個環境變數：
 *      SHEET_URL = 第 7 步複製的網址
 *      SHEET_KEY = 第 4 步設定的密碼
 *
 * 之後如果修改了這段程式，要按「部署」→「管理部署作業」→ 鉛筆圖示 →
 * 版本選「新版本」→「部署」，修改才會生效（網址不會變）。
 * ===================================================================== */

const SECRET = '請改成你自己的密碼';

const SHEET_NAME = '留言';
// 欄位：A 編號 | B 建立時間(ISO) | C 題目(JSON) | D 回答(JSON) | E 時間 | F 名字 | G 之後：每題的回答
// A~D 是程式用的，會自動隱藏；請不要修改或移動欄位。

function doGet() {
  return ContentService.createTextOutput('留言儲存服務運作中 ✅');
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json({ error: '格式錯誤' }); }
  if (body.key !== SECRET) return json({ error: 'SHEET_KEY 密碼不正確' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = getSheet();
    if (body.action === 'list') return json({ responses: listAll(sh) });
    if (body.action === 'add') { addEntry(sh, body.entry); return json({ ok: true }); }
    if (body.action === 'clear') {
      if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
      return json({ ok: true });
    }
    return json({ error: '未知的動作' });
  } finally {
    lock.releaseLock();
  }
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, 6).setValues([['編號', '建立時間', '題目', '回答', '時間', '名字']]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.hideColumns(1, 4);
  }
  return sh;
}

function listAll(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  const rows = sh.getRange(2, 1, last - 1, 6).getValues();
  return rows.filter(r => r[0]).map(r => ({
    id: String(r[0]),
    createdAt: r[1] instanceof Date ? r[1].toISOString() : String(r[1]),
    questions: safeParse(r[2]),
    answers: safeParse(r[3]),
    name: String(r[5])
  }));
}

function addEntry(sh, entry) {
  // 已經存過就不重複寫入
  const last = sh.getLastRow();
  if (last >= 2) {
    const ids = sh.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0]));
    if (ids.indexOf(entry.id) !== -1) return;
  }
  // 第一列標題：補上各題題目
  (entry.questions || []).forEach((q, i) => {
    const cell = sh.getRange(1, 7 + i);
    if (!cell.getValue()) cell.setValue(q).setFontWeight('bold');
  });
  const time = Utilities.formatDate(new Date(entry.createdAt), 'Asia/Taipei', 'yyyy/MM/dd HH:mm:ss');
  const values = [entry.id, entry.createdAt, JSON.stringify(entry.questions || []), JSON.stringify(entry.answers || []),
    time, entry.name].concat(entry.answers || []);
  const row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, values.length).setNumberFormat('@').setValues([values]);
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return []; }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
