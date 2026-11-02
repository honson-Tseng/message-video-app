// =====================================================
// 影片生成器（在瀏覽器裡完成，不需要伺服器運算）
// 原理：用 <canvas> 一格一格畫出「背景圖 + 一句一句的字」，
//      再用 MediaRecorder 把畫面 + 背景音樂錄成影片檔。
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

  function drawBackground(ctx, W, H, img, zoom) {
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
  }

  function drawCentered(ctx, W, H, text, { size, color, alpha, offsetY = 0, italic = false }) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.font = `${italic ? 'italic ' : ''}700 ${size}px ${FONT}`;
    ctx.fillStyle = color;
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

  // 淡入淡出：回傳 0~1
  function fade(t, dur, f = 600) {
    if (t < 0 || t > dur) return 0;
    return Math.min(1, t / f, (dur - t) / f);
  }

  /**
   * 生成影片
   * @param {object} opts
   *   canvas   : <canvas> 元素（會即時顯示畫面）
   *   lines    : ['第一句', '第二句', ...]
   *   config   : 後台設定（背景圖、音樂、秒數、字色…）
   *   title    : 片頭標題
   *   signature: 片尾署名（可空）
   *   onProgress(0~1)
   * @returns Promise<{ blob, ext }>
   */
  async function render({ canvas, lines, config, title, signature, onProgress }) {
    const [W, H] = config.aspect === '9:16' ? [720, 1280] : [1280, 720];
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const img = config.backgroundImage ? await loadImage(config.backgroundImage) : null;
    if (document.fonts && document.fonts.ready) await document.fonts.ready;

    const fontSize = Math.round((config.fontSize || 56) * (W / 1280) * (config.aspect === '9:16' ? 1.4 : 1));
    const color = config.textColor || '#ffffff';
    const per = (config.secondsPerLine || 3.5) * 1000;
    const INTRO = title ? 2800 : 0;
    const OUTRO = 2500;
    const total = INTRO + lines.length * per + OUTRO;

    // ---- 影像串流 + 音樂串流 ----
    const stream = canvas.captureStream(30);
    let audioEl = null, actx = null, gain = null;
    if (config.music) {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      await actx.resume();
      audioEl = new Audio(config.music);
      audioEl.loop = true;
      const src = actx.createMediaElementSource(audioEl);
      gain = actx.createGain();
      const dest = actx.createMediaStreamDestination();
      src.connect(gain);
      gain.connect(dest);           // 錄進影片
      gain.connect(actx.destination); // 同時讓你聽到
      dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    }

    const mimeType = pickMime();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 5_000_000 } : undefined);
    const chunks = [];
    recorder.ondataavailable = e => e.data && e.data.size && chunks.push(e.data);
    const stopped = new Promise(r => (recorder.onstop = r));

    if (audioEl) {
      audioEl.currentTime = 0;
      try { await audioEl.play(); } catch (e) { console.warn('音樂無法播放', e); }
    }
    recorder.start(250);
    const t0 = performance.now();

    await new Promise(resolve => {
      function frame() {
        const t = performance.now() - t0;
        ctx.clearRect(0, 0, W, H);
        drawBackground(ctx, W, H, img, 1 + 0.06 * (t / total)); // 緩慢放大的運鏡效果
        ctx.fillStyle = `rgba(0,0,0,${config.overlay ?? 0.35})`;
        ctx.fillRect(0, 0, W, H);

        if (t < INTRO) {
          drawCentered(ctx, W, H, title, { size: fontSize * 1.3, color, alpha: fade(t, INTRO), offsetY: -10 * (1 - fade(t, INTRO)) });
        } else if (t < INTRO + lines.length * per) {
          const i = Math.floor((t - INTRO) / per);
          const lt = t - INTRO - i * per;
          const a = fade(lt, per);
          drawCentered(ctx, W, H, lines[i], { size: fontSize, color, alpha: a, offsetY: 20 * (1 - a) });
        } else {
          const ot = t - INTRO - lines.length * per;
          drawCentered(ctx, W, H, signature ? `— ${signature}` : '♥', { size: fontSize * 0.9, color, alpha: fade(ot, OUTRO), italic: !!signature });
        }

        // 最後 2 秒音樂淡出
        if (gain && actx) gain.gain.value = Math.max(0, Math.min(1, (total - t) / 2000));
        onProgress && onProgress(Math.min(1, t / total));
        if (t < total) requestAnimationFrame(frame);
        else resolve();
      }
      frame();
    });

    recorder.stop();
    await stopped;
    if (audioEl) audioEl.pause();
    if (actx) actx.close();
    stream.getTracks().forEach(t => t.stop());

    const type = recorder.mimeType || mimeType || 'video/webm';
    return { blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm' };
  }

  window.VideoMaker = { render, splitSentences };
})();
