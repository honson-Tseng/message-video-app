// =====================================================
// 影片生成器（在瀏覽器裡完成，不需要伺服器運算）
// 原理：用 <canvas> 一格一格畫出「背景圖 + 一句一句的字」，
//      再用 MediaRecorder 把畫面 + 背景音樂錄成影片檔。
// 每一句可以是字串，或 { text: '句子', author: '名字' }（會在句子下方顯示名字）
// =====================================================
(function () {
  const FONT = '"Noto Sans TC","PingFang TC","Microsoft JhengHei","Heiti TC",sans-serif';

  // 把一段回答切成一句一句（依換行與。！？；切）
  function splitSentences(text) {
    return String(text || '')
      .split(/\n+|(?<=[。！？!?；;])/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  // 把回覆攤平成 [{ key, text, author, question, qi }]
  // withAuthor=false 時不在每句下方顯示名字（個人影片用，名字放片尾）
  function responsesToItems(responses, withAuthor = true) {
    return responses.flatMap(r =>
      r.answers.flatMap((a, qi) =>
        splitSentences(a).map((text, si) => ({
          key: `${r.id}-${qi}-${si}`, text, qi,
          author: withAuthor ? r.name || '' : '',
          question: (r.questions && r.questions[qi]) || ''
        }))
      )
    );
  }

  // 合併影片用：依問題分段，每段前面插入一張「問題卡」
  function groupByQuestion(items) {
    const sorted = items.map((it, i) => [it, i]).sort((a, b) => (a[0].qi - b[0].qi) || (a[1] - b[1])).map(x => x[0]);
    const out = [];
    let last = null;
    for (const it of sorted) {
      if (it.question && it.question !== last) out.push({ card: true, text: it.question, qi: it.qi });
      last = it.question;
      out.push(it);
    }
    return out;
  }

  function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function pickMime() {
    const list = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return list.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  // 中文逐字換行、英文以單字換行
  function wrapText(ctx, text, maxWidth) {
    const tokens = text.match(/[A-Za-z0-9'’\-.,]+\s*|\s+|./gu) || [];
    const lines = [];
    let line = '';
    for (const tk of tokens) {
      if (ctx.measureText(line + tk).width > maxWidth && line) {
        lines.push(line.trim());
        line = tk.trimStart();
      } else line += tk;
    }
    if (line.trim()) lines.push(line.trim());
    return lines;
  }

  // ---------- 場景：準備好畫布、背景圖、字體大小 ----------
  async function createScene(canvas, config) {
    const [W, H] = config.aspect === '9:16' ? [720, 1280] : [1280, 720];
    canvas.width = W;
    canvas.height = H;
    const img = config.backgroundImage ? await loadImage(config.backgroundImage) : null;
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    return {
      W, H, img, canvas,
      ctx: canvas.getContext('2d'),
      fontSize: Math.round((config.fontSize || 56) * (W / 1280) * (config.aspect === '9:16' ? 1.4 : 1)),
      color: config.textColor || '#ffffff',
      overlay: config.overlay ?? 0.35,
      per: (config.secondsPerLine || 3.5) * 1000,
      showQuestions: config.showQuestions !== false
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

  function drawText(s, text, { size, alpha, offsetY = 0, italic = false, author = '', label = '' }) {
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
    const authorSpace = author ? size * 1.2 : 0;
    const ls = Math.round(size * 0.5);
    let labelLines = [];
    if (label) {
      ctx.font = `500 ${ls}px ${FONT}`;
      labelLines = wrapText(ctx, label, W * 0.8);
      ctx.font = `${italic ? 'italic ' : ''}700 ${size}px ${FONT}`;
    }
    const labelSpace = labelLines.length ? labelLines.length * ls * 1.4 + size * 0.6 : 0;
    const startY = H / 2 - ((lines.length - 1) * lh + authorSpace - labelSpace) / 2 + offsetY;
    if (labelLines.length) {
      ctx.save();
      ctx.font = `500 ${ls}px ${FONT}`;
      ctx.globalAlpha *= 0.75;
      const top = startY - size * 0.6 - (labelLines.length - 0.5) * ls * 1.4;
      labelLines.forEach((l, i) => ctx.fillText(l, W / 2, top + i * ls * 1.4));
      ctx.restore();
    }
    lines.forEach((l, i) => ctx.fillText(l, W / 2, startY + i * lh));
    if (author) {
      const as = Math.round(size * 0.6);
      ctx.font = `500 ${as}px ${FONT}`;
      ctx.globalAlpha *= 0.85;
      ctx.fillText(`— ${author}`, W / 2, startY + (lines.length - 1) * lh + authorSpace + as * 0.3);
    }
    ctx.restore();
  }

  // 一句的內容（字串或物件）
  const textOf = it => (typeof it === 'string' ? it : it.text);
  const authorOf = it => (typeof it === 'string' ? '' : it.author || '');

  // 淡入淡出：回傳 0~1
  function fade(t, dur, f = 600) {
    if (t < 0 || t > dur) return 0;
    return Math.min(1, t / f, (dur - t) / f);
  }

  function drawItem(s, item, lt) {
    const a = fade(lt, s.per);
    if (item.card) {
      // 問題卡：較大的字，上方加「第 N 題」
      drawText(s, item.text, { size: s.fontSize * 1.1, alpha: a, offsetY: 20 * (1 - a), label: `第 ${item.qi + 1} 題` });
      return;
    }
    const label = s.showQuestions && typeof item === 'object' ? item.question || '' : '';
    drawText(s, textOf(item), { size: s.fontSize, alpha: a, offsetY: 20 * (1 - a), author: authorOf(item), label });
  }

  // ---------- 背景音樂（同時播放給現場聽、也可錄進影片）----------
  async function startMusic(url) {
    if (!url) return null;
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    await actx.resume();
    const el = new Audio(url);
    el.loop = true;
    const src = actx.createMediaElementSource(el);
    const gain = actx.createGain();
    const dest = actx.createMediaStreamDestination();
    src.connect(gain);
    gain.connect(dest);
    gain.connect(actx.destination);
    try { await el.play(); } catch (e) { console.warn('音樂無法播放', e); }
    return {
      el, gain, track: dest.stream.getAudioTracks()[0],
      stop() { el.pause(); actx.close(); }
    };
  }

  /**
   * 錄製一支完整影片（片頭 → 一句一句 → 片尾）
   * @returns Promise<{ blob, ext }>
   */
  async function render({ canvas, lines, config, title, signature, onProgress }) {
    const s = await createScene(canvas, config);
    if (s.showQuestions && lines.some(it => typeof it === 'object' && it.question)) lines = groupByQuestion(lines);
    const INTRO = title ? 2800 : 0;
    const OUTRO = 2500;
    const total = INTRO + lines.length * s.per + OUTRO;

    const stream = canvas.captureStream(30);
    const music = await startMusic(config.music);
    if (music) { music.el.currentTime = 0; stream.addTrack(music.track); }

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
          drawText(s, title, { size: s.fontSize * 1.3, alpha: a, offsetY: -10 * (1 - a) });
        } else if (t < INTRO + lines.length * s.per) {
          const i = Math.floor((t - INTRO) / s.per);
          drawItem(s, lines[i], t - INTRO - i * s.per);
        } else {
          drawText(s, signature ? `— ${signature}` : '♥', { size: s.fontSize * 0.9, alpha: fade(t - INTRO - lines.length * s.per, OUTRO), italic: !!signature });
        }
        if (music) music.gain.gain.value = Math.max(0, Math.min(1, (total - t) / 2000)); // 最後 2 秒淡出
        onProgress && onProgress(Math.min(1, t / total));
        if (t < total) requestAnimationFrame(frame);
        else resolve();
      }
      frame();
    });

    recorder.stop();
    await stopped;
    if (music) music.stop();
    stream.getTracks().forEach(t => t.stop());
    const type = recorder.mimeType || mimeType || 'video/webm';
    return { blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm' };
  }

  /**
   * 現場大螢幕即時播放：不斷輪播所有留言，新留言會優先插播。
   * getItems() 回傳目前所有的 [{ key, text, author }]
   * @returns { stop() }
   */
  async function live({ canvas, config, title, getItems, onStatus }) {
    const s = await createScene(canvas, config);
    const music = await startMusic(config.music);
    const played = new Set();
    let current = null;    // 目前這一句
    let start = performance.now();
    let showingTitle = !!title;
    let running = true;
    const TITLE_MS = 3000;

    function next() {
      const items = getItems();
      const fresh = items.find(it => !played.has(it.key));
      if (fresh) {
        played.add(fresh.key);
        current = fresh;
        showingTitle = false;
      } else if (items.length) {
        // 全部播過一輪：清空紀錄，先顯示標題再重播
        played.clear();
        current = null;
        showingTitle = !!title;
        if (!showingTitle) return next();
      } else {
        current = null;
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
        drawText(s, title || '等待留言中…', { size: s.fontSize * 1.3, alpha: waiting ? Math.min(1, lt / 600) : fade(lt, TITLE_MS) });
        if (!waiting && lt >= TITLE_MS) next();
        else if (waiting && getItems().length) next();
      } else if (current) {
        drawItem(s, current, lt);
        if (lt >= s.per) next();
      } else next();
      requestAnimationFrame(frame);
    }
    next();
    frame();
    return { stop() { running = false; if (music) music.stop(); } };
  }

  window.VideoMaker = { render, live, splitSentences, responsesToItems, groupByQuestion };
})();
