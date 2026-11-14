// =====================================================
// 影片生成器（在瀏覽器裡完成，不需要伺服器運算）
// 原理：用 <canvas> 一格一格畫出「背景圖 + 留言卡片」，
//      再用 MediaRecorder 錄成影片檔。
// 每個畫面同時顯示 3～4 則留言（後台可設定）。
// =====================================================
(function () {
  const FONT = '"PingFang TC","Microsoft JhengHei","Heiti TC","Noto Sans TC","Noto Sans CJK TC",sans-serif';
  const MAX_CHARS = 70; // 一張卡片最多放幾個字，超過會切成好幾張

  // 依換行與。！？；切句
  function splitSentences(text) {
    return String(text || '')
      .split(/\n+|(?<=[。！？!?；;])/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  // 一則回答 → 一張或多張卡片的文字（太長才切）
  function chunkText(text) {
    const t = String(text || '').trim();
    if (!t) return [];
    if (t.length <= MAX_CHARS) return [t.replace(/\s*\n+\s*/g, ' ')];
    const out = [];
    let cur = '';
    for (const s of splitSentences(t)) {
      const joined = cur ? cur + (/[\x00-\x7F]$/.test(cur) ? ' ' : '') + s : s;
      if (cur && joined.length > MAX_CHARS) { out.push(cur); cur = s; } else cur = joined;
    }
    if (cur) out.push(cur);
    return out;
  }

  // 把回覆攤平成留言卡片 [{ key, text, author }]，依題目順序排列
  // withAuthor=false 時卡片上不顯示名字（個人影片用，名字放片尾）
  function responsesToItems(responses, withAuthor = true) {
    const items = [];
    const maxQ = Math.max(0, ...responses.map(r => r.answers.length));
    for (let qi = 0; qi < maxQ; qi++) {
      for (const r of responses) {
        chunkText(r.answers[qi]).forEach((text, ci) =>
          items.push({ key: `${r.id}-${qi}-${ci}`, text, author: withAuthor ? r.name || '' : '' })
        );
      }
    }
    return items;
  }

  const normalize = it => (typeof it === 'string' ? { key: it, text: it, author: '' } : it);
  const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

  function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function pickMime() {
    const list = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    return list.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  // 中文逐字換行、英文以單字換行
  function wrapText(ctx, text, maxWidth) {
    const tokens = text.match(/[A-Za-z0-9'’\-.,!?]+\s*|\s+|./gu) || [];
    const lines = [];
    let line = '';
    const closing = /^[，。！？、；：」』）〉》…,.!?;:)\]～~]/;
    for (const tk of tokens) {
      // 標點符號不要單獨跑到下一行
      if (ctx.measureText(line + tk).width > maxWidth && line && !closing.test(tk)) {
        lines.push(line.trim());
        line = tk.trimStart();
      } else line += tk;
    }
    if (line.trim()) lines.push(line.trim());
    return lines;
  }

  // ---------- 場景 ----------
  async function createScene(canvas, config) {
    const [W, H] = config.aspect === '9:16' ? [720, 1280] : [1280, 720];
    canvas.width = W;
    canvas.height = H;
    const img = config.backgroundImage ? await loadImage(config.backgroundImage) : null;
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    return {
      W, H, img,
      ctx: canvas.getContext('2d'),
      fontSize: Math.round((config.fontSize || 56) * (W / 1280) * (config.aspect === '9:16' ? 1.4 : 1)),
      color: config.textColor || '#ffffff',
      overlay: config.overlay ?? 0.35,
      per: (config.secondsPerLine || 6) * 1000,       // 每個畫面幾毫秒
      perPage: Number(config.perPage) === 3 ? 3 : 4    // 每個畫面幾則
    };
  }

  function drawBase(s, zoom = 1) {
    const { ctx, W, H, img } = s;
    ctx.clearRect(0, 0, W, H);
    if (img) {
      const scale = Math.max(W / img.width, H / img.height) * zoom;
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    } else {
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#2b1e4a');
      g.addColorStop(1, '#c2526b');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.fillStyle = `rgba(0,0,0,${s.overlay})`;
    ctx.fillRect(0, 0, W, H);
  }

  // 片頭、片尾用的置中大字
  function drawTitle(s, text, { size, alpha, offsetY = 0, italic = false }) {
    const { ctx, W, H } = s;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.font = `${italic ? 'italic ' : ''}700 ${size}px ${FONT}`;
    ctx.fillStyle = s.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = size * 0.3;
    const lines = wrapText(ctx, text, W * 0.82);
    const lh = size * 1.45;
    const startY = H / 2 - ((lines.length - 1) * lh) / 2 + offsetY;
    lines.forEach((l, i) => ctx.fillText(l, W / 2, startY + i * lh));
    ctx.restore();
  }

  // ---------- 留言卡片的排版 ----------
  function cardRects(s, n) {
    const { W, H } = s;
    const portrait = H > W;
    const pad = Math.round(Math.min(W, H) * 0.06);
    const gap = Math.round(Math.min(W, H) * 0.035);
    let cols, rows;
    if (portrait) { cols = 1; rows = Math.max(n, 3); }   // 直式：由上往下排
    else if (n >= 4) { cols = 2; rows = 2; }
    else if (n === 3) { cols = 3; rows = 1; }
    else if (n === 2) { cols = 2; rows = 1; }
    else { cols = 1; rows = 1; }
    let areaW = W - pad * 2, areaH = H - pad * 2, ox = pad, oy = pad;
    if (!portrait && n <= 3) { areaH = H * 0.62; oy = (H - areaH) / 2; }       // 3 則以下：卡片別拉太高
    if (!portrait && n === 1) { areaW = W * 0.62; ox = (W - areaW) / 2; }
    if (portrait && n < 3) { areaH = (areaH - gap * 2) / 3 * n + gap * (n - 1); oy = (H - areaH) / 2; rows = n; }
    const cw = (areaW - gap * (cols - 1)) / cols;
    const ch = (areaH - gap * (rows - 1)) / rows;
    return Array.from({ length: n }, (_, i) => ({
      x: ox + (i % cols) * (cw + gap),
      y: oy + Math.floor(i / cols) * (ch + gap),
      w: cw, h: ch
    }));
  }

  // 自動縮小字體，讓留言塞得進卡片
  function fitCard(s, rect, item) {
    const { ctx } = s;
    const innerW = rect.w * 0.84, innerH = rect.h * 0.78;
    let size = Math.min(s.fontSize * 0.75, rect.h / 3.2);
    const minSize = Math.max(14, s.fontSize * 0.28);
    let lines;
    for (; size >= minSize; size -= 1) {
      ctx.font = `700 ${size}px ${FONT}`;
      lines = wrapText(ctx, item.text, innerW);
      const authorH = item.author ? size * 1.3 : 0;
      if (lines.length * size * 1.45 + authorH <= innerH) break;
    }
    return { rect, item, size: Math.max(size, minSize), lines };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawCard(s, c, alpha, offsetY) {
    const { ctx } = s;
    const { rect, item, size, lines } = c;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.translate(0, offsetY);
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, Math.min(rect.w, rect.h) * 0.08);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = s.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = size * 0.25;
    ctx.font = `700 ${size}px ${FONT}`;
    const lh = size * 1.45;
    const authorH = item.author ? size * 1.3 : 0;
    const blockH = (lines.length - 1) * lh + authorH;
    const cx = rect.x + rect.w / 2;
    const startY = rect.y + rect.h / 2 - blockH / 2;
    lines.forEach((l, i) => ctx.fillText(l, cx, startY + i * lh));
    if (item.author) {
      ctx.font = `500 ${Math.round(size * 0.7)}px ${FONT}`;
      ctx.globalAlpha *= 0.85;
      ctx.fillText(`— ${item.author}`, cx, startY + (lines.length - 1) * lh + authorH);
    }
    ctx.restore();
  }

  // 準備一個畫面（排版只算一次）
  function preparePage(s, items) {
    return cardRects(s, items.length).map((r, i) => fitCard(s, r, items[i]));
  }

  // 卡片依序淡入，畫面結束前一起淡出
  function drawPage(s, page, t) {
    const out = Math.min(1, Math.max(0, (s.per - t) / 600));
    page.forEach((c, i) => {
      const a = Math.min(1, Math.max(0, (t - i * 350) / 500));
      drawCard(s, c, Math.min(a, out), 18 * (1 - a));
    });
  }

  function fade(t, dur, f = 600) {
    if (t < 0 || t > dur) return 0;
    return Math.min(1, t / f, (dur - t) / f);
  }

  /**
   * 錄製一支完整影片（片頭 → 一頁一頁的留言 → 片尾），沒有聲音
   * @returns Promise<{ blob, ext }>
   */
  async function render({ canvas, lines, config, title, signature, onProgress }) {
    const s = await createScene(canvas, config);
    const pages = chunk(lines.map(normalize), s.perPage).map(p => preparePage(s, p));
    const outroText = signature ? `— ${signature}` : (config.outro ?? '♥');
    const INTRO = title ? 2800 : 0;
    const OUTRO = outroText ? 2500 : 0;
    const total = INTRO + pages.length * s.per + OUTRO;

    const stream = canvas.captureStream(30);
    const mimeType = pickMime();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 5_000_000 } : undefined);
    const chunks = [];
    recorder.ondataavailable = e => e.data && e.data.size && chunks.push(e.data);
    const stopped = new Promise(r => (recorder.onstop = r));
    recorder.start(250);
    const t0 = performance.now();

    await new Promise(resolve => {
      function frame() {
        const t = performance.now() - t0;
        drawBase(s, 1 + 0.06 * (t / total));
        if (t < INTRO) {
          const a = fade(t, INTRO);
          drawTitle(s, title, { size: s.fontSize * 1.3, alpha: a, offsetY: -10 * (1 - a) });
        } else if (t < INTRO + pages.length * s.per) {
          const i = Math.floor((t - INTRO) / s.per);
          drawPage(s, pages[i], t - INTRO - i * s.per);
        } else if (OUTRO) {
          drawTitle(s, outroText, { size: s.fontSize * 0.9, alpha: fade(t - INTRO - pages.length * s.per, OUTRO), italic: !!signature });
        }
        onProgress && onProgress(Math.min(1, t / total));
        if (t < total) requestAnimationFrame(frame);
        else resolve();
      }
      frame();
    });

    recorder.stop();
    await stopped;
    stream.getTracks().forEach(t => t.stop());
    const type = recorder.mimeType || mimeType || 'video/webm';
    return { blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm' };
  }

  /**
   * 現場大螢幕即時播放：一頁一頁輪播所有留言，新留言會優先插播。
   * getItems() 回傳目前所有的 [{ key, text, author }]
   * @returns { stop() }
   */
  async function live({ canvas, config, title, getItems, onStatus }) {
    const s = await createScene(canvas, config);
    const played = new Set();
    let page = null;
    let start = performance.now();
    let showingTitle = !!title;
    let running = true;
    const TITLE_MS = 3000;

    function next() {
      const items = getItems();
      const fresh = items.filter(it => !played.has(it.key)).slice(0, s.perPage);
      if (fresh.length) {
        fresh.forEach(it => played.add(it.key));
        page = preparePage(s, fresh);
        showingTitle = false;
      } else if (items.length) {
        // 全部播過一輪：先顯示標題再重播
        played.clear();
        page = null;
        showingTitle = !!title;
        if (!showingTitle) return next();
      } else {
        page = null;
        showingTitle = true; // 還沒有人留言時一直顯示標題
      }
      start = performance.now();
      onStatus && onStatus({ played: played.size, total: items.length });
    }

    function frame() {
      if (!running) return;
      const now = performance.now();
      const lt = now - start;
      drawBase(s, 1.03 + 0.03 * Math.sin(now / 8000));
      if (showingTitle) {
        const waiting = !getItems().length;
        drawTitle(s, title || '等待留言中…', { size: s.fontSize * 1.3, alpha: waiting ? Math.min(1, lt / 600) : fade(lt, TITLE_MS) });
        if (!waiting && lt >= TITLE_MS) next();
        else if (waiting && getItems().length) next();
      } else if (page) {
        drawPage(s, page, lt);
        if (lt >= s.per) next();
      } else next();
      requestAnimationFrame(frame);
    }
    next();
    frame();
    return { stop() { running = false; } };
  }

  window.VideoMaker = { render, live, splitSentences, responsesToItems };
})();
