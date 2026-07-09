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
// Per-platform posting hours by Israel weekday (0=Sunday .. 6=Saturday) — the
// user's engagement-optimized schedule. Ranges were expanded to one video per hour.
const TT_SCHED = {
  0: [9, 13],               // Sunday
  1: [11, 13],              // Monday
  2: [7, 22],               // Tuesday
  3: [21, 22],              // Wednesday
  4: [13, 22],              // Thursday
  5: [18, 20, 21, 22],      // Friday
  6: [15, 16, 17, 21, 22, 23], // Saturday + motzash (strongest window)
};
const IG_SCHED = {
  0: [12, 19],              // Sunday
  1: [15, 19],              // Monday
  2: [12, 18, 19, 20],      // Tuesday (strongest day)
  3: [8, 9, 19],            // Wednesday
  4: [12, 18],              // Thursday
  5: [11, 12, 13],          // Friday (before Shabbat)
  6: [],                    // Saturday — no Instagram posts
};
const MAX = parseInt(process.env.MAX_VIDEOS || '99', 10);
const DO_TT = process.env.TIKTOK !== '0' && !!TT;
const DRY = process.env.DRY_RUN === '1'; // render + host, but do NOT schedule/publish
const KEEP = 24; // how many recent videos to keep hosted (per platform)

// Same video for both platforms, ONLY the end CTA differs.
// Instagram keeps the "comment אני" CTA (Gemini's cta.he already ends with the fixed lines).
// TikTok drives followers to the bio link (selling the 30-day self-discipline guide).
// keep the LAST line short so the inline 👇 stays on screen
const TT_CTA_HE = 'כנסו לקישור שבביו,\nוקבלו את המדריך המוביל\nבישראל לפיתוח משמעת\nעצמית תוך 30 יום 👇';
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
  const PROMPT = `You are a top scriptwriter for the Hebrew Instagram/TikTok page @charisma.il (charisma, self-discipline, personal development). Write ONE ~55 second vertical video script about: "${topic}" that feels like a calm, cinematic, deep motivational reel.
Return ONLY JSON: { "voice":"en-US-ChristopherNeural", "segments":[{"en","he","query"}...], "cta":{"en","he","query"} }
RULES:
- 12-13 segments. "en"=short spoken English sentence (7-10 words). "he"=short natural Hebrew subtitle, simple 3rd-grade Hebrew, NO em dash, NO jargon.
- CONTENT QUALITY (make it genuinely interesting, not generic): the HOOK (segments 1-2) must stop the scroll with a specific, fresh, counter-intuitive angle (a myth to bust, a surprising fact, a bold claim, or a "why do some people..." question). Do NOT start with "Most people think". The MIDDLE gives real, concrete, useful value: one sharp idea per line, specific and vivid, no filler and no repeating the same idea. Where it fits, gently tie the message to the calm nature imagery (a river that never stops, a mountain built slowly, still water). End several lines on a punchy thought that sticks.
- The LAST 2 segments before the CTA = a FEAR beat (regret / being left behind) then a JEALOUSY beat (others already started and are winning).
- "query" = 2-4 English words for a CINEMATIC NATURE / SCENERY stock video ONLY. Allowed: calm lake, misty mountains, waterfall, flowing river, deep forest, ocean waves, sunrise over mountains, aerial forest, snowy peak, green valley, canyon, autumn woods, starry night sky, northern lights. NEVER people, faces, city, streets, office, gym, desk, phones, or objects. Pick a DIFFERENT scene for every segment so no two clips repeat.
- "cta.he" MUST end with exactly these 3 lines (keep the newlines and the 👇):
תגיבו "אני" אם הגעתם עד לכאן,
וקבלו את המדריך לפיתוח
משמעת עצמית 👇
  Vary the spoken "cta.en" wording. cta.query = an inspiring nature scene (e.g. sunrise over mountains, grand waterfall, calm lake at dawn, aerial forest) — vary it each time.
- Keep it TIGHT: ~110-125 total English words so the voice is ~52-56s. Valid JSON only.`;
  const body = JSON.stringify({ contents: [{ parts: [{ text: PROMPT }] }], generationConfig: { responseMimeType: 'application/json', temperature: 1.05, maxOutputTokens: 8192 } });
  // Gemini occasionally returns truncated output or rate-limits (429). On 429 the
  // free tier needs a real cool-down, so wait ~65s before retrying.
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await req({ hostname: 'generativelanguage.googleapis.com', path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI}`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
      if (r.status !== 200) throw new Error('Gemini ' + r.status + ': ' + r.body.slice(0, 200));
      const script = JSON.parse(JSON.parse(r.body).candidates[0].content.parts[0].text);
      if (!script.segments || !script.segments.length || !script.cta) throw new Error('script missing segments/cta');
      return script;
    } catch (e) {
      lastErr = e;
      const wait = /429/.test(e.message) ? 65000 : 2500 * attempt;
      console.log(`  genScript attempt ${attempt} failed: ${e.message.slice(0, 80)} — waiting ${Math.round(wait / 1000)}s...`);
      await sleep(wait);
    }
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
function ilWeekday() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })).getDay(); }
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
  const wd = ilWeekday();
  const cand = [
    ...(IG_SCHED[wd] || []).map((h) => ({ h, plat: 'ig' })),
    ...(DO_TT ? (TT_SCHED[wd] || []) : []).map((h) => ({ h, plat: 'tt' })),
  ].map((s) => ({ ...s, dueAt: dueAtFor(s.h) })).sort((a, b) => a.h - b.h);
  // normally only fill slots still ahead today; in dry-run render regardless of clock so it's testable anytime
  const future = (DRY ? cand : cand.filter((s) => new Date(s.dueAt).getTime() > nowMs + 5 * 60000)).slice(0, MAX);
  console.log(`Weekday ${wd} — slots to fill today:`, future.map((s) => s.h + ':00 ' + s.plat.toUpperCase()).join(', ') || '(none left today)');
  if (!future.length) { console.log('Nothing to schedule.'); return; }

  const stamp = ilYMD().map((n, i) => (i ? String(n + (i === 1 ? 1 : 0)).padStart(2, '0') : n)).join(''); // yyyymmdd-ish
  const made = [];
  for (const slot of future) {
    const topic = topics[ptr % topics.length]; ptr++;
    const isTT = slot.plat === 'tt';
    const name = `v-${stamp}-${slot.h}-${slot.plat}`;
    // idempotent re-runs: if this slot's video already exists (committed by an earlier
    // run today), skip it so a backfill dispatch never double-schedules a slot.
    if (fs.existsSync(path.join(VIDEOS, name + '.mp4'))) { console.log(`\n=== ${slot.h}:00 ${slot.plat.toUpperCase()} — already made today, skipping ===`); continue; }
    try {
      console.log(`\n=== ${slot.h}:00 ${slot.plat.toUpperCase()}  topic="${topic}" ===`);
      const script = await genScript(topic);
      const outDir = path.join(ROOT, '.work', name);
      fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
      // each slot is its own fresh video with the platform's CTA:
      // Instagram = comment "אני"; TikTok = link in bio (sells the 30-day guide)
      const cta = isTT ? { en: TT_CTA_EN[ptr % TT_CTA_EN.length], he: TT_CTA_HE, query: script.cta.query } : script.cta;
      const content = {
        outDir: outDir.replace(/\\/g, '/'), pixabayKey: PIXABAY, voice: script.voice,
        segments: script.segments, cta, seed: name + '-' + Date.now(),
        usedClipsFile: path.join(ROOT, 'state', 'used_clips.json'),
      };
      const cj = path.join(outDir, 'content.json');
      fs.writeFileSync(cj, JSON.stringify(content), 'utf8');
      execFileSync('node', [RENDER, cj], { stdio: 'inherit' });
      execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-i', path.join(outDir, 'video.mp4'), '-c:v', 'libx264', '-crf', '26', '-maxrate', '2500k', '-bufsize', '5000k', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', path.join(VIDEOS, name + '.mp4')]);
      const title = topic.length > 60 ? topic.slice(0, 57) + '...' : topic;
      made.push({ name, dueAt: slot.dueAt, plat: slot.plat, title, caption: isTT ? TT_CAPTION : `${script.cta.he}\n\n${IG_HASHTAGS}` });
      fs.rmSync(outDir, { recursive: true, force: true });
    } catch (e) { console.error('  slot failed:', e.message); }
  }
  if (!made.length) { console.error('No videos produced.'); process.exit(1); }

  if (DRY) {
    for (const v of made) { const kb = Math.round(fs.statSync(path.join(VIDEOS, v.name + '.mp4')).size / 1024); console.log(`  [DRY_RUN] rendered ${v.name}.mp4 (${kb} KB) — not pushing, not scheduling.`); }
    console.log('\nDRY RUN OK — rendering works. ' + made.length + ' video(s) produced.'); return;
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

  // schedule each video to its own platform at its own hour
  const waitReady = async (u) => { for (let i = 0; i < 20; i++) { if (await urlReady(u)) return true; await sleep(3000); } return false; };
  for (const v of made) {
    const url = `https://raw.githubusercontent.com/${REPO}/main/videos/${v.name}.mp4`;
    console.log(`\nScheduling ${v.name} @ ${v.dueAt}`);
    await waitReady(url);
    const r = await schedule(v.plat === 'tt' ? TT : IG, url, v.dueAt, v.caption, v.plat === 'tt', v.title);
    console.log(`  ${v.plat.toUpperCase()}:`, r.slice(0, 200));
  }
  console.log('\nALL DONE — scheduled ' + made.length + ' videos.');
  process.exit(0); // exit cleanly so the runner step doesn't hang on open sockets
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
