/*
 * render_video.js — builds a 60-second vertical video for @charisma.il:
 *   English ElevenLabs voiceover + Hebrew subtitles (Arial Bold) + Pixabay clips
 *   that switch exactly when the subtitle changes + a fixed CTA at the end.
 *
 * Usage:  node render_video.js <content.json>
 *
 * content.json:
 * {
 *   "outDir": "C:/Users/2pac4/Charsima/Video 1",
 *   "voiceId": "pNInz6obpgDQGcFmaJgB",           // optional (default Adam)
 *   "segments": [
 *     { "en": "English narration line.", "he": "כתובית בעברית.", "query": "stock clip search" },
 *     ...
 *   ],
 *   "cta": { "en": "Comment ...", "he": "תגיבו \"אני\" ...", "query": "sunrise success" }
 * }
 *
 * Needs: ffmpeg/ffprobe (found automatically), ElevenLabs key, Pixabay key.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

// Free Microsoft Edge neural TTS -> writes mp3, returns word timings [{t,d} in seconds].
function edgeTTS(text, voice, outPath) {
  return new Promise((resolve, reject) => {
    (async () => {
      const tts = new MsEdgeTTS();
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { wordBoundaryEnabled: true, sentenceBoundaryEnabled: false });
      const { audioStream, metadataStream } = tts.toStream(text);
      const out = fs.createWriteStream(outPath);
      const words = [];
      audioStream.on('data', (c) => out.write(c));
      metadataStream.on('data', (chunk) => {
        try {
          const m = JSON.parse(chunk.toString());
          for (const b of (m.Metadata || [])) {
            if (b.Type === 'WordBoundary') words.push({ t: b.Data.Offset / 1e7, d: b.Data.Duration / 1e7, w: (b.Data.text && b.Data.text.Text) || '' });
          }
        } catch (e) {}
      });
      audioStream.on('end', () => { out.end(); out.on('finish', () => resolve(words)); });
      audioStream.on('error', reject);
    })().catch(reject);
  });
}

const CONTENT_PATH = process.argv[2];
if (!CONTENT_PATH) { console.error('Usage: node render_video.js <content.json>'); process.exit(1); }
const C = JSON.parse(fs.readFileSync(CONTENT_PATH, 'utf8'));

const EL_KEY = process.env.ELEVENLABS_KEY || 'sk_ed0e31dc67c9cd84597b4fcd74e3a9265a1a2f5ce2d3fbf7';
const PIXABAY_KEY = process.env.PIXABAY_KEY || '56592495-3cd45b015bad6e813ce9ff19a';
const VOICE = C.voice || 'en-US-ChristopherNeural';    // free Edge neural voice, deep & authoritative
const PITCH = C.pitch || 0.93;                         // <1 = deeper / thicker / more confident, credible voice
const VIDEO_SECONDS = C.totalSeconds || 60.0;          // every finished video is EXACTLY this long
const TAIL = 2.2;                                      // seconds of breathing room after the narration ends
let TOTAL = VIDEO_SECONDS;                             // video length (seconds)
const W = 1080, H = 1920, FPS = 30;

const OUT_DIR = C.outDir;
if (!OUT_DIR) { console.error('content.json needs "outDir"'); process.exit(1); }
const WORK = path.join(OUT_DIR, '.work');

// ---- locate ffmpeg / ffprobe ----
function findBin(name) {
  try { execFileSync(name, ['-version'], { stdio: 'ignore' }); return name; } catch (e) {}
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft/WinGet/Packages') : null,
    'C:/Program Files', 'C:/ffmpeg',
  ].filter(Boolean);
  for (const r of roots) {
    let found = null;
    (function walk(d, depth) {
      if (found || depth > 5 || !fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (found) return;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name.toLowerCase() === name + '.exe') found = p;
      }
    })(r, 0);
    if (found) return found;
  }
  throw new Error('Could not find ' + name);
}
const FFMPEG = findBin('ffmpeg');
const FFPROBE = findBin('ffprobe');

// ---- tiny http helpers ----
function reqJSON(opts, bodyBuf) {
  return new Promise((resolve, reject) => {
    const r = https.request(opts, (res) => {
      let d = [];
      res.on('data', (c) => d.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(d) }));
    });
    r.on('error', reject);
    if (bodyBuf) r.write(bodyBuf);
    r.end();
  });
}
function getBuf(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return getBuf(res.headers.location).then(resolve, reject);
      }
      let d = [];
      res.on('data', (c) => d.push(c));
      res.on('end', () => resolve(Buffer.concat(d)));
    }).on('error', reject);
  });
}
function ff(args, cwd) { execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { cwd, stdio: 'inherit' }); }
function probeDur(file) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim();
  return parseFloat(out);
}
function tc(sec) {
  if (sec < 0) sec = 0;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = (sec % 60);
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const segs = [...C.segments, C.cta];

  // 1) build full English text + char offsets per segment
  let offset = 0; const parts = [];
  segs.forEach((s, i) => { s._cs = offset; s._ce = offset + s.en.length; offset += s.en.length; if (i < segs.length - 1) offset += 1; parts.push(s.en); });
  const fullText = parts.join(' ');

  // 2) Free Microsoft Edge neural TTS with word boundaries, then DEEPEN the voice
  // (pitch down) and stretch/compress it so the finished video is exactly
  // VIDEO_SECONDS. Cached by script + pitch + target so tweaks re-render cleanly.
  const TARGET_VOICE = Math.max(20, VIDEO_SECONDS - TAIL);   // the narration fills up to here
  const textHash = crypto.createHash('md5').update(fullText + '|' + VOICE + '|p' + PITCH + '|t' + TARGET_VOICE + '|v2').digest('hex');
  const voicePath = path.join(WORK, 'voice.mp3');
  const timingPath = path.join(WORK, 'timing.json');
  let words;
  const cachedTiming = fs.existsSync(voicePath) && fs.existsSync(timingPath) ? JSON.parse(fs.readFileSync(timingPath, 'utf8')) : null;
  if (cachedTiming && cachedTiming.hash === textHash && cachedTiming.words) {
    words = cachedTiming.words;
    console.log('Reusing cached voiceover.');
  } else {
    console.log('Generating voiceover (Edge Neural TTS, free)...');
    const rawWords = await edgeTTS(fullText, VOICE, voicePath);
    const rawDur = probeDur(voicePath);
    // one ffmpeg pass: asetrate lowers pitch (deeper), atempo restores/sets length to TARGET_VOICE
    const SR = 24000;
    let tempo = rawDur / (TARGET_VOICE * PITCH);
    tempo = Math.max(0.5, Math.min(2.0, tempo));
    const adj = path.join(WORK, 'voice_adj.mp3');
    ff(['-i', voicePath, '-filter:a', `asetrate=${Math.round(SR * PITCH)},aresample=${SR},atempo=${tempo.toFixed(5)}`, '-ac', '1', adj]);
    fs.copyFileSync(adj, voicePath);
    const scale = probeDur(voicePath) / rawDur;               // map word times onto the adjusted audio
    words = rawWords.map((w) => ({ t: w.t * scale, d: w.d * scale, w: w.w }));
    fs.writeFileSync(timingPath, JSON.stringify({ hash: textHash, words }));
  }

  // map each segment to its words -> speech start/end times.
  // ACCURATE alignment: match each spoken word boundary to the source text word by
  // word. TTS expands numbers/abbreviations ("5am" -> "five A M", "1%" -> "one
  // percent"), which adds extra boundaries; those extras are attributed to the
  // CURRENT segment so every later subtitle still lands exactly on its speech.
  const normW = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
  const src = [];
  segs.forEach((s, si) => { s.en.trim().split(/\s+/).filter(Boolean).forEach((w) => src.push({ w: normW(w), si })); });
  const times = segs.map(() => ({ start: null, end: null }));
  const mark = (si, b) => { const T = times[si]; const e = b.t + b.d; if (T.start === null || b.t < T.start) T.start = b.t; if (T.end === null || e > T.end) T.end = e; };
  let sp = 0, matched = 0, haveText = words.some((b) => b.w);
  if (haveText) {
    for (const b of words) {
      const bw = normW(b.w || '');
      let si = null;
      if (bw && sp < src.length) {
        const cur = src[sp].w;
        if (cur === bw || (cur && bw && (cur.startsWith(bw) || bw.startsWith(cur)))) { si = src[sp].si; sp++; matched++; }
        else if (sp + 1 < src.length && src[sp + 1].w === bw) { sp++; si = src[sp].si; sp++; matched++; } // TTS skipped a token
      }
      if (si === null) si = sp > 0 ? src[Math.min(sp, src.length) - 1].si : 0;   // expansion word -> current segment
      mark(si, b);
    }
    console.log(`Subtitle sync: matched ${matched}/${src.length} source words to spoken words.`);
  }
  if (!haveText || matched < src.length * 0.6) {
    // fallback (old cache without word text): plain word-count mapping
    console.log('Subtitle sync: falling back to word-count mapping.');
    let _wi = 0;
    segs.forEach((s, i) => {
      const wc = s.en.trim().split(/\s+/).filter(Boolean).length;
      const start = words[Math.min(_wi, words.length - 1)];
      const end = words[Math.min(_wi + wc - 1, words.length - 1)];
      times[i] = { start: start ? start.t : 0, end: end ? (end.t + end.d) : null };
      _wi += wc;
    });
  }
  segs.forEach((s, i) => {
    s.tstart = times[i].start !== null ? times[i].start : (i ? segs[i - 1].tend : 0);
    s.tend = times[i].end !== null ? times[i].end : s.tstart + 0.8;
  });

  const voiceDur = probeDur(voicePath);
  TOTAL = VIDEO_SECONDS;   // fixed: every finished video is exactly this long

  // contiguous boundaries: clip/subtitle i runs from its start to the NEXT one's start (last -> TOTAL)
  segs.forEach((s, i) => { s.dstart = (i === 0) ? 0 : s.tstart; s.dend = (i < segs.length - 1) ? segs[i + 1].tstart : TOTAL; });

  console.log(`Voiceover ${voiceDur.toFixed(2)}s (deepened, pitch ${PITCH}); video length ${TOTAL.toFixed(2)}s across ${segs.length} segments.`);
  const lastSpoken = Math.max(...segs.map((s) => s.tend));
  if (lastSpoken > TOTAL - 0.3) console.warn(`WARNING: narration ends at ${lastSpoken.toFixed(2)}s — too close to the ${TOTAL}s cut!`);
  else console.log(`Narration ends at ${lastSpoken.toFixed(2)}s — nothing is cut.`);

  // 2b) background music bed (bundled asset, no external API needed)
  const bgPath = path.join(WORK, 'bg.mp3');
  const bgSrc = C.musicFile || path.join(__dirname, '..', 'assets', 'music_dramatic.mp3');
  if (fs.existsSync(bgSrc)) { fs.copyFileSync(bgSrc, bgPath); console.log('Using bundled background music.'); }
  else console.warn('  no bundled music found; video will have no background music');

  // 3) fetch a Pixabay clip per segment, normalize to its exact duration
  console.log('Fetching clips + building segments...');
  // --- clip variety: a seeded, non-repeating picker so EVERY video is genuinely new.
  // usedClipsFile remembers clip ids used by recent videos (across the whole day and
  // previous days) so the same stock clip is never reused; seed makes each video's
  // choices differ even for identical search terms.
  const usedFile = C.usedClipsFile;
  let usedList = [];
  if (usedFile && fs.existsSync(usedFile)) { try { usedList = JSON.parse(fs.readFileSync(usedFile, 'utf8')) || []; } catch (e) {} }
  const usedSet = new Set(usedList);
  const rng = (() => { const s = String(C.seed || Date.now()); let h = 1779033703 ^ s.length; for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); } return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; }; })();
  const listLines = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const dur = Math.max(0.6, s.dend - s.dstart);
    const seg = path.join(WORK, `seg${String(i).padStart(2, '0')}.mp4`);
    const keyPath = seg + '.key';
    const key = s.query + '|' + dur.toFixed(3);
    listLines.push(`file '${path.basename(seg)}'`);
    if (fs.existsSync(seg) && fs.existsSync(keyPath) && fs.readFileSync(keyPath, 'utf8') === key) {
      console.log(`  seg ${i + 1}/${segs.length} cached`);
      continue;
    }
    const api = `https://pixabay.com/api/videos/?key=${PIXABAY_KEY}&q=${encodeURIComponent(s.query)}&per_page=50&safesearch=true`;
    const data = JSON.parse((await getBuf(api)).toString());
    const hits = data.hits || [];
    if (!hits.length) throw new Error('No Pixabay video for: ' + s.query);
    // score hits by tag relevance, then pick a NOT-recently-used one at random among
    // the best matches — relevant but different every time.
    const qwords = s.query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const scored = hits.map((h) => { const tags = (h.tags || '').toLowerCase(); const score = qwords.reduce((a, w) => a + (tags.includes(w) ? 1 : 0), 0); return { h, score }; });
    const maxScore = Math.max(0, ...scored.map((x) => x.score));
    let cand = scored.filter((x) => x.score >= maxScore && !usedSet.has(x.h.id));  // best & unused
    if (!cand.length) cand = scored.filter((x) => !usedSet.has(x.h.id));           // any unused
    if (!cand.length) cand = scored;                                              // last resort
    cand.sort((a, b) => b.score - a.score);
    const topN = cand.slice(0, Math.min(cand.length, 12));
    const hit = topN[Math.floor(rng() * topN.length)].h;
    usedSet.add(hit.id); usedList.push(hit.id);
    const v = hit.videos.large || hit.videos.medium || hit.videos.small;
    const raw = path.join(WORK, `raw${i}.mp4`);
    fs.writeFileSync(raw, await getBuf(v.url));
    // slow Ken Burns zoom, alternating in / out per clip for variety
    const bigW = Math.round(W * 1.25), bigH = Math.round(H * 1.25);
    const zExpr = (i % 2 === 0) ? 'min(1.0+0.0014*on,1.25)' : 'max(1.25-0.0014*on,1.0)';
    ff(['-stream_loop', '-1', '-i', raw, '-t', dur.toFixed(3),
      '-vf', `scale=${bigW}:${bigH}:force_original_aspect_ratio=increase,crop=${bigW}:${bigH},` +
        `zoompan=z='${zExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},setsar=1,format=yuv420p`,
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', seg]);
    fs.writeFileSync(keyPath, key);
    console.log(`  seg ${i + 1}/${segs.length} "${s.query}" -> clip #${hit.id} (${dur.toFixed(2)}s)`);
  }
  // remember the clips we just used (keep the last 400) so future videos avoid them
  if (usedFile) { try { fs.writeFileSync(usedFile, JSON.stringify(usedList.slice(-400))); } catch (e) {} }

  // 4) concat the silent video track
  fs.writeFileSync(path.join(WORK, 'list.txt'), listLines.join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'novoice.mp4'], WORK);

  // 5) subtitles (ASS, Arial Bold) — one entry per segment, timed to the clip changes
  const ASSETS = path.join(__dirname, '..', 'assets');
  fs.copyFileSync(path.join(ASSETS, 'logo_circle.png'), path.join(WORK, 'logo_circle.png'));
  for (const f of ['arialbd.ttf', 'arial.ttf', 'seguiemj.ttf']) { const s = path.join('C:/Windows/Fonts', f); if (fs.existsSync(s)) fs.copyFileSync(s, path.join(WORK, f)); }

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Def,Arial,68,&H00FFFFFF,&H9EFFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,4,2,5,120,120,0,1
Style: Brand,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,1,8,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  // eye-catching captions: centered, pop-in (fade + scale) on each subtitle
  // exact screen center (H/2 = 960), \an5 middle anchor, quick fade-in
  // Clean full-line captions with a quick pop-in. Full-line (not word-by-word)
  // so libass renders Hebrew bidi correctly and every comma and period lands on
  // the correct (left / end) side. Each physical line is wrapped in RTL marks.
  const lead = '{\\an5\\pos(540,960)\\fad(110,50)\\fscx85\\fscy85\\t(0,160,\\fscx100\\fscy100)}';
  // emoji don't render in color in libass, so strip them from the burned text and
  // overlay a real color emoji image separately (see the final mux below).
  const stripEmoji = (t) => t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/[ \t]+$/gm, '').trim();
  const rtl = (t) => stripEmoji(t).split('\n').map((l) => '‫' + l.trim() + '‬').join('\\N');
  const capEv = segs.map((s) => `Dialogue: 0,${tc(s.dstart)},${tc(s.dend)},Def,,0,0,0,,${lead}${rtl(s.he)}`).join('\n');
  // color 👇 emoji overlay during the CTA (last segment), if present
  const ctaSeg = segs[segs.length - 1];
  const hasPointEmoji = /\u{1F447}/u.test(ctaSeg.he || '');
  const ctaStart = ctaSeg.dstart;
  const emojiSize = 74;
  let emX = 0, emY = 0;
  if (hasPointEmoji) {
    fs.copyFileSync(path.join(ASSETS, 'emoji_point_down.png'), path.join(WORK, 'emoji.png'));
    // place the emoji on the SAME row as the last CTA line, just past its (left/RTL) end
    const ctaLines = stripEmoji(ctaSeg.he).split('\n');
    const lastLine = ctaLines[ctaLines.length - 1].trim();
    const lineH = 84, avgChar = 36;                                  // approx metrics for Arial bold 68
    const estW = lastLine.length * avgChar;
    emX = Math.round((540 - estW / 2) - 8 - emojiSize);              // emoji right edge sits just left of the line (RTL end)
    const lastLineCenterY = 960 + Math.round(((ctaLines.length - 1) / 2) * lineH);
    emY = lastLineCenterY - Math.round(emojiSize / 2);
  }
  // consistent branding: the handle sits under the logo, on screen the whole time
  const brandEv = `Dialogue: 0,${tc(0)},${tc(TOTAL)},Brand,,0,0,0,,{\\an8\\pos(540,1705)}@charisma.il`;
  fs.writeFileSync(path.join(WORK, 'subs.ass'), header + brandEv + '\n' + capEv + '\n', 'utf8');

  // 6) final mux: logo watermark + burned captions + color CTA emoji + voice + music
  console.log('Rendering final video...');
  const hasBg = fs.existsSync(path.join(WORK, 'bg.mp3'));
  const inputs = ['-i', 'novoice.mp4', '-i', 'voice.mp3', '-i', 'logo_circle.png'];
  let audioFc;
  if (hasBg) {
    inputs.push('-stream_loop', '-1', '-i', 'bg.mp3');            // input index 3
    audioFc = '[1:a]apad,volume=1.0[voice];' +
      `[3:a]loudnorm=I=-28,afade=t=in:st=0:d=2,afade=t=out:st=${(TOTAL - 3).toFixed(2)}:d=3[bg];` +
      '[voice][bg]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]';
  } else {
    audioFc = '[1:a]apad[a]';
  }
  let vidFc = '[2:v]scale=175:175[lg];[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=black@0.25:t=fill,ass=subs.ass:fontsdir=.[vs];[vs][lg]overlay=(W-w)/2:1510[vv];';
  if (hasPointEmoji) {
    inputs.push('-i', 'emoji.png');                              // index 4 (with bg) or 3
    const emIdx = hasBg ? 4 : 3;
    vidFc += `[${emIdx}:v]scale=${emojiSize}:${emojiSize}[em];[vv][em]overlay=${emX}:${emY}:enable='between(t,${ctaStart.toFixed(2)},${TOTAL.toFixed(2)})'[v];`;
  } else {
    vidFc += '[vv]null[v];';
  }
  ff([...inputs, '-filter_complex', vidFc + audioFc, '-map', '[v]', '-map', '[a]', '-t', String(TOTAL),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '176k', '-r', String(FPS), 'final.mp4'], WORK);

  const outFile = path.join(OUT_DIR, 'video.mp4');
  fs.copyFileSync(path.join(WORK, 'final.mp4'), outFile);
  console.log('DONE -> ' + outFile + ' (' + probeDur(outFile).toFixed(2) + 's)');
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
