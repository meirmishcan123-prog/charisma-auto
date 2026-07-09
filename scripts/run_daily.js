/*
 * run_daily.js — the fully-free daily pipeline (runs on GitHub Actions, PC off):
 * for each time slot today: Gemini writes a fresh script on a new topic ->
 * render_video.js renders it (free Edge TTS voice) -> commit the mp4 to this
 * public repo -> Buffer schedules it to Instagram (+ TikTok) at the exact time.
 *
 * Env: GEMINI_API_KEY, BUFFER_ACCESS_TOKEN, BUFFER_INSTAGRAM_CHANNEL_ID,
 *      BUFFER_TIKTOK_CHANNEL_ID, PIXABAY_KEY, GITHUB_REPOSITORY (owner/repo).
 * Optional: SLOTS="7,9,11,13,15,17,18,20,21,22", MAX_VIDEOS, TIKTOK=0 to skip TikTok.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GEMINI = process.env.GEMINI_API_KEY;
const BUFFER = process.env.BUFFER_ACCESS_TOKEN;
const IG = process.env.BUFFER_INSTAGRAM_CHANNEL_ID;
const TT = process.env.BUFFER_TIKTOK_CHANNEL_ID;
const PIXABAY = process.env.PIXABAY_KEY;
const REPO = process.env.GITHUB_REPOSITORY || 'meirmishcan123-prog/charisma-auto';
const SLOTS = (process.env.SLOTS || '7,9,11,13,15,17,18,20,21,22').split(',').map((x) => parseInt(x, 10)); // 10 posts/day, 07:00-22:00
const MAX = parseInt(process.env.MAX_VIDEOS || '99', 10);
const DO_TT = process.env.TIKTOK !== '0' && !!TT;
const DRY = process.env.DRY_RUN === '1'; // render + host, but do NOT schedule/publish
const KEEP = 24; // how many recent videos to keep hosted (per platform)

// Same video for both platforms, ONLY the end CTA differs.
// Instagram keeps the "comment אני" CTA (Gemini's cta.he already ends with the fixed lines).
// TikTok drives followers to the bio link (selling the 30-day self-discipline guide).
const TT_CTA_HE = 'כנסו לקישור שבביו,\nוקבלו את המדריך המוביל בישראל\nלפיתוח משמעת עצמית תוך 30 יום 👇';
const TT_CTA_EN = [
  "Tap the link in my bio to get the number one guide for real self discipline.",
  "The link in my bio has Israel's top guide to build self discipline in thirty days.",
  "Go to the link in my bio and start building unstoppable self discipline today.",
];
const TT_CAPTION = 'הקישור בביו שלנו 👆\nהמדריך המוביל בישראל לפיתוח\nמשמעת עצמית תוך 30 יום.\n\n#משמעת_עצמית #מוטיבציה #התפתחות_אישית';
const IG_HASHTAGS = '#מוטיבציה #משמעת_עצמית #התפתחות_אישית';

for (const [k, v] of Object.entries({ GEMINI_API_KEY: GEMINI, BUFFER_ACCESS_TOKEN: BUFFER, BUFFER_INSTAGRAM_CHANNEL_ID: IG, PIXABAY_KEY: PIXABAY }))
  if (!v) { console.error('Missing env ' + k); process.exit(1); }

function req(opts, body) {
  return new Promise((res, rej) => {
    const r = https.request(opts, (x) => { let d = ''; x.on('data', (c) => d += c); x.on('end', () => res({ status: x.statusCode, body: d })); });
    r.on('error', rej); if (body) r.write(body); r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function genScript(topic) {
  const PROMPT = `You are a scriptwriter for the Hebrew Instagram/TikTok page @charisma.il (charisma, self-discipline, personal development). Write ONE ~55 second vertical video script about: "${topic}".
Return ONLY JSON: { "voice":"en-US-ChristopherNeural", "segments":[{"en","he","query"}...], "cta":{"en","he","query"} }
RULES:
- 12-13 segments. "en"=short spoken English sentence (7-10 words). "he"=short natural Hebrew subtitle, simple 3rd-grade Hebrew, NO em dash, NO jargon. "query"=2-4 concrete English words for a matching Pixabay stock VIDEO (real visual things: people, city, nature, sunrise, ocean, gym, desk; avoid abstract).
- Segments 1-2 = HOOK: stop the scroll, open a curiosity gap, fresh & specific to the topic (a myth to bust / a bold counter-intuitive claim / a "why do some people..." question). Do NOT start with "Most people think".
- Middle = practical useful value, one idea per line.
- The LAST 2 segments = a FEAR beat (regret / being left behind) then a JEALOUSY beat (others already started and are winning).
- "cta.he" MUST end with exactly these 3 lines (keep the newlines and the 👇):
תגיבו "אני" אם הגעתם עד לכאן,
וקבלו את המדריך לפיתוח
משמעת עצמית 👇
  Vary the spoken "cta.en" wording. cta.query = a fresh inspiring visual that fits THIS topic — pick a DIFFERENT one each time (e.g. city skyline at dawn, runner finishing a race, ocean waves, mountain summit, someone celebrating a win, sunrise over water, busy street). Do not always use sunrise.
- Keep it TIGHT: ~110-125 total English words so the voice is ~52-56s. Valid JSON only.`;
  const body = JSON.stringify({ contents: [{ parts: [{ text: PROMPT }] }], generationConfig: { responseMimeType: 'application/json', temperature: 1.05, maxOutputTokens: 8192 } });
  // Gemini occasionally returns truncated / rate-limited output — retry a few times.
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await req({ hostname: 'generativelanguage.googleapis.com', path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI}`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
      if (r.status !== 200) throw new Error('Gemini ' + r.status + ': ' + r.body.slice(0, 200));
      const script = JSON.parse(JSON.parse(r.body).candidates[0].content.parts[0].text);
      if (!script.segments || !script.segments.length || !script.cta) throw new Error('script missing segments/cta');
      return script;
    } catch (e) { lastErr = e; console.log(`  genScript attempt ${attempt} failed: ${e.message} — retrying...`); await sleep(2500 * attempt); }
  }
  throw lastErr;
}

async function schedule(channelId, videoUrl, dueAt, caption, isTt, title) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const meta = isTt ? `{ tiktok: { title: "${esc(title)}", isAiGenerated: true } }` : `{ instagram: { type: reel, shouldShareToFeed: true } }`;
  const q = `mutation { createPost(input: { channelId: "${channelId}", text: "${esc(caption)}", schedulingType: automatic, mode: customScheduled, dueAt: "${dueAt}", saveToDraft: false, metadata: ${meta}, assets: [{ video: { url: "${videoUrl}" } }] }) { ... on PostActionSuccess { post { id status } } ... on MutationError { message } } }`;
  const body = JSON.stringify({ query: q });
  const r = await req({ hostname: 'api.buffer.com', path: '/', method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + BUFFER, 'Content-Length': Buffer.byteLength(body) } }, body);
  return r.body;
}

function urlReady(u) {
  return new Promise((res) => { https.request(u, { method: 'HEAD' }, (x) => res(x.statusCode >= 200 && x.statusCode < 400)).on('error', () => res(false)).end(); });
}

// timezone-correct slot times for TODAY in Israel
function ilOffsetMin() { const d = new Date(); return Math.round((new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })) - d) / 60000); }
function ilYMD() { const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })); return [d.getFullYear(), d.getMonth(), d.getDate()]; }
function dueAtFor(hour) { const [y, m, day] = ilYMD(); return new Date(Date.UTC(y, m, day, hour, 0, 0) - ilOffsetMin() * 60000).toISOString(); }

const FF = 'ffmpeg';
const RENDER = path.join(ROOT, 'scripts', 'render_video.js');
const VIDEOS = path.join(ROOT, 'videos');
const STATE = path.join(ROOT, 'state', 'next_topic.txt');

(async () => {
  const topics = JSON.parse(fs.readFileSync(path.join(ROOT, 'topics.json'), 'utf8'));
  let ptr = parseInt(fs.readFileSync(STATE, 'utf8').trim(), 10) || 0;
  const today = ilYMD().join('-');
  const LASTP = path.join(ROOT, 'state', 'last_run.txt');
  if (process.env.FORCE !== '1' && fs.existsSync(LASTP) && fs.readFileSync(LASTP, 'utf8').trim() === today) {
    console.log('Already ran today (' + today + ') — skipping.'); return;
  }
  const nowMs = Date.now();
  const cand = SLOTS.map((h) => ({ h, dueAt: dueAtFor(h) }));
  // normally only fill slots still ahead today; in dry-run render regardless of clock so it's testable anytime
  const future = (DRY ? cand : cand.filter((s) => new Date(s.dueAt).getTime() > nowMs + 5 * 60000)).slice(0, MAX);
  console.log('Slots to fill today:', future.map((s) => s.h + ':00').join(', ') || '(none left today)');
  if (!future.length) { console.log('Nothing to schedule.'); return; }

  const stamp = ilYMD().map((n, i) => (i ? String(n + (i === 1 ? 1 : 0)).padStart(2, '0') : n)).join(''); // yyyymmdd-ish
  const made = [];
  for (const slot of future) {
    const topic = topics[ptr % topics.length]; ptr++;
    const name = `v-${stamp}-${slot.h}`;
    try {
      console.log(`\n=== ${slot.h}:00  topic="${topic}" ===`);
      const script = await genScript(topic);
      const outDir = path.join(ROOT, '.work', name);
      fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
      const seed = name + '-' + Date.now();
      const base = { outDir: outDir.replace(/\\/g, '/'), pixabayKey: PIXABAY, voice: script.voice, segments: script.segments, seed };
      const cj = path.join(outDir, 'content.json');
      const compress = (dst) => execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-i', path.join(outDir, 'video.mp4'), '-c:v', 'libx264', '-crf', '26', '-maxrate', '2500k', '-bufsize', '5000k', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', dst]);
      // 1) Instagram version — CTA = comment "אני". Records the clips it used.
      fs.writeFileSync(cj, JSON.stringify({ ...base, cta: script.cta, usedClipsFile: path.join(ROOT, 'state', 'used_clips.json') }), 'utf8');
      execFileSync('node', [RENDER, cj], { stdio: 'inherit' });
      compress(path.join(VIDEOS, name + '-ig.mp4'));
      // 2) TikTok version — SAME outDir so the body clips are reused from cache (identical
      // video); only the voice + the last CTA slide change (link in bio).
      const ttCta = { en: TT_CTA_EN[ptr % TT_CTA_EN.length], he: TT_CTA_HE, query: script.cta.query };
      fs.writeFileSync(cj, JSON.stringify({ ...base, cta: ttCta }), 'utf8');
      execFileSync('node', [RENDER, cj], { stdio: 'inherit' });
      compress(path.join(VIDEOS, name + '-tt.mp4'));
      const title = topic.length > 60 ? topic.slice(0, 57) + '...' : topic;
      made.push({ name, dueAt: slot.dueAt, title, igCaption: `${script.cta.he}\n\n${IG_HASHTAGS}`, ttCaption: TT_CAPTION });
      fs.rmSync(outDir, { recursive: true, force: true });
    } catch (e) { console.error('  slot failed:', e.message); }
  }
  if (!made.length) { console.error('No videos produced.'); process.exit(1); }

  if (DRY) {
    for (const v of made) { const kb = Math.round((fs.statSync(path.join(VIDEOS, v.name + '-ig.mp4')).size + fs.statSync(path.join(VIDEOS, v.name + '-tt.mp4')).size) / 1024); console.log(`  [DRY_RUN] rendered ${v.name} IG+TT (${kb} KB) — not pushing, not scheduling.`); }
    console.log('\nDRY RUN OK — rendering works. ' + made.length + ' video(s) x2 (IG+TikTok) produced.'); return;
  }

  // prune old videos (keep the most recent KEEP posts = KEEP*2 files)
  const all = fs.readdirSync(VIDEOS).filter((f) => f.endsWith('.mp4')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP * 2))) fs.rmSync(path.join(VIDEOS, f));

  // commit + push all new videos so their raw URLs go live
  fs.writeFileSync(STATE, String(ptr) + '\n');
  fs.writeFileSync(LASTP, today + '\n');
  execFileSync('git', ['config', 'user.name', 'charisma-bot']);
  execFileSync('git', ['config', 'user.email', 'bot@users.noreply.github.com']);
  execFileSync('git', ['add', '-A'], { cwd: ROOT });
  execFileSync('git', ['commit', '-m', 'daily videos ' + stamp], { cwd: ROOT });
  // resilient push: if the remote moved (a concurrent commit), rebase and retry so we
  // never abort before scheduling (this is exactly what broke on 2026-07-09).
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { execFileSync('git', ['push'], { cwd: ROOT, stdio: 'inherit' }); break; }
    catch (e) {
      if (attempt === 5) throw e;
      console.log('  push rejected — pulling --rebase and retrying...');
      try { execFileSync('git', ['pull', '--rebase', 'origin', 'main'], { cwd: ROOT, stdio: 'inherit' }); } catch (e2) {}
      await sleep(2000);
    }
  }

  // schedule each: the -ig video to Instagram (comment CTA), the -tt video to TikTok (bio-link CTA)
  const waitReady = async (u) => { for (let i = 0; i < 20; i++) { if (await urlReady(u)) return true; await sleep(3000); } return false; };
  for (const v of made) {
    const igUrl = `https://raw.githubusercontent.com/${REPO}/main/videos/${v.name}-ig.mp4`;
    const ttUrl = `https://raw.githubusercontent.com/${REPO}/main/videos/${v.name}-tt.mp4`;
    console.log(`\nScheduling ${v.name} @ ${v.dueAt}`);
    await waitReady(igUrl);
    const ig = await schedule(IG, igUrl, v.dueAt, v.igCaption, false, v.title); console.log('  IG:', ig.slice(0, 200));
    if (DO_TT) { await waitReady(ttUrl); const tt = await schedule(TT, ttUrl, v.dueAt, v.ttCaption, true, v.title); console.log('  TT:', tt.slice(0, 200)); }
  }
  console.log('\nALL DONE — scheduled ' + made.length + ' videos.');
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
