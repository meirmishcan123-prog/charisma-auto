/*
 * run_daily.js — the fully-free daily pipeline (runs on GitHub Actions, PC off):
 * for each time slot today: Gemini writes a fresh script on a new topic ->
 * render_video.js renders it (free Edge TTS voice) -> commit the mp4 to this
 * public repo -> Buffer schedules it to Instagram (+ TikTok) at the exact time.
 *
 * Env: GEMINI_API_KEY, BUFFER_ACCESS_TOKEN, BUFFER_INSTAGRAM_CHANNEL_ID,
 *      BUFFER_TIKTOK_CHANNEL_ID, PIXABAY_KEY, GITHUB_REPOSITORY (owner/repo).
 * Optional: SLOTS="7,9,11,13,15,17,19,21", MAX_VIDEOS, TIKTOK=0 to skip TikTok.
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
const SLOTS = (process.env.SLOTS || '7,9,11,13,15,17,19,21').split(',').map((x) => parseInt(x, 10));
const MAX = parseInt(process.env.MAX_VIDEOS || '99', 10);
const DO_TT = process.env.TIKTOK !== '0' && !!TT;
const KEEP = 24; // how many recent videos to keep hosted

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
  Vary only the spoken "cta.en" wording. cta.query = inspiring sunrise/mountain/success stock video.
- Keep it TIGHT: ~110-125 total English words so the voice is ~52-56s. Valid JSON only.`;
  const body = JSON.stringify({ contents: [{ parts: [{ text: PROMPT }] }], generationConfig: { responseMimeType: 'application/json', temperature: 1.05, maxOutputTokens: 4096 } });
  const r = await req({ hostname: 'generativelanguage.googleapis.com', path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI}`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
  if (r.status !== 200) throw new Error('Gemini ' + r.status + ': ' + r.body.slice(0, 200));
  return JSON.parse(JSON.parse(r.body).candidates[0].content.parts[0].text);
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
  const future = SLOTS.map((h) => ({ h, dueAt: dueAtFor(h) })).filter((s) => new Date(s.dueAt).getTime() > nowMs + 5 * 60000).slice(0, MAX);
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
      script.outDir = outDir.replace(/\\/g, '/'); script.pixabayKey = PIXABAY;
      fs.writeFileSync(path.join(outDir, 'content.json'), JSON.stringify(script), 'utf8');
      execFileSync('node', [RENDER, path.join(outDir, 'content.json')], { stdio: 'inherit' });
      const outVid = path.join(VIDEOS, name + '.mp4');
      execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-i', path.join(outDir, 'video.mp4'), '-c:v', 'libx264', '-crf', '26', '-maxrate', '2500k', '-bufsize', '5000k', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', outVid]);
      const title = topic.length > 60 ? topic.slice(0, 57) + '...' : topic;
      made.push({ name, dueAt: slot.dueAt, caption: `${script.cta.he}\n\n#מוטיבציה #משמעת_עצמית #התפתחות_אישית`, title });
      fs.rmSync(outDir, { recursive: true, force: true });
    } catch (e) { console.error('  slot failed:', e.message); }
  }
  if (!made.length) { console.error('No videos produced.'); process.exit(1); }

  // prune old videos (keep the most recent KEEP)
  const all = fs.readdirSync(VIDEOS).filter((f) => f.endsWith('.mp4')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP))) fs.rmSync(path.join(VIDEOS, f));

  // commit + push all new videos so their raw URLs go live
  fs.writeFileSync(STATE, String(ptr) + '\n');
  fs.writeFileSync(LASTP, today + '\n');
  execFileSync('git', ['config', 'user.name', 'charisma-bot']);
  execFileSync('git', ['config', 'user.email', 'bot@users.noreply.github.com']);
  execFileSync('git', ['add', '-A'], { cwd: ROOT });
  execFileSync('git', ['commit', '-m', 'daily videos ' + stamp], { cwd: ROOT });
  execFileSync('git', ['push'], { cwd: ROOT });

  // schedule each (wait for its raw URL to be live)
  for (const v of made) {
    const url = `https://raw.githubusercontent.com/${REPO}/main/videos/${v.name}.mp4`;
    let ready = false; for (let i = 0; i < 20 && !ready; i++) { ready = await urlReady(url); if (!ready) await sleep(3000); }
    console.log(`\nScheduling ${v.name} @ ${v.dueAt}  (url ready: ${ready})`);
    const ig = await schedule(IG, url, v.dueAt, v.caption, false, v.title); console.log('  IG:', ig.slice(0, 200));
    if (DO_TT) { const tt = await schedule(TT, url, v.dueAt, v.caption, true, v.title); console.log('  TT:', tt.slice(0, 200)); }
  }
  console.log('\nALL DONE — scheduled ' + made.length + ' videos.');
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
