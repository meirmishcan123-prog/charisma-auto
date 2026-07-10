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
// A fresh video every 2 hours on BOTH platforms, PLUS the user's special
// engagement hours (peak windows) merged in — peak-hour videos get an extra
// strong hook. Israel weekday: 0=Sunday .. 6=Saturday.
const BASE_GRID = [7, 9, 11, 13, 15, 17, 19, 21];
const TT_SPECIAL = {
  0: [9, 13], 1: [11, 13], 2: [7, 22], 3: [21, 22], 4: [13, 22],
  5: [18, 20, 21, 22], 6: [15, 16, 17, 21, 22, 23], // Sat + motzash (strongest)
};
const IG_SPECIAL = {
  0: [12, 19], 1: [15, 19], 2: [12, 18, 19, 20], 3: [8, 9, 19], 4: [12, 18],
  5: [11, 12, 13], 6: [], // Friday before Shabbat only; no Instagram on Shabbat
};
function slotsFor(wd, plat) {
  const special = (plat === 'tt' ? TT_SPECIAL : IG_SPECIAL)[wd] || [];
  let grid = BASE_GRID;
  if (plat === 'ig') {
    if (wd === 6) grid = [];                          // Shabbat: no Instagram at all
    if (wd === 5) grid = grid.filter((h) => h <= 13); // Friday: only before Shabbat
  }
  return [...new Set([...grid, ...special])].sort((a, b) => a - b)
    .map((h) => ({ h, plat, strong: special.includes(h) }));
}
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

async function genScript(topic, strong) {
  const strongNote = strong ? `
- PEAK-HOURS POST: this video publishes in a peak engagement window. Make the hook EXTRA bold and scroll-stopping (a bigger claim, a sharper curiosity gap) and make the fear + jealousy beats hit noticeably harder.` : '';
  const PROMPT = `You are a top scriptwriter for the Hebrew Instagram/TikTok page @charisma.il (charisma, self-discipline, personal development). Write ONE ~55 second vertical video script about: "${topic}" that feels like a calm, cinematic, deep motivational reel.${strongNote}
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
  // Gemini occasionally returns truncated output or rate-limits (429). Each model
  // has its OWN free quota, so on persistent 429 we fall through to the next model.
  const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite'];
  let lastErr;
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await req({ hostname: 'generativelanguage.googleapis.com', path: `/v1beta/models/${model}:generateContent?key=${GEMINI}`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
        if (r.status !== 200) throw new Error('Gemini ' + r.status + ': ' + r.body.slice(0, 200));
        const script = JSON.parse(JSON.parse(r.body).candidates[0].content.parts[0].text);
        if (!script.segments || !script.segments.length || !script.cta) throw new Error('script missing segments/cta');
        if (model !== MODELS[0]) console.log(`  (script written by fallback model ${model})`);
        return script;
      } catch (e) {
        lastErr = e;
        const is429 = /429/.test(e.message);
        console.log(`  genScript ${model} attempt ${attempt} failed: ${e.message.slice(0, 80)}`);
        if (is429) { await sleep(8000); break; }   // quota — jump to the next model
        await sleep(2500 * attempt);               // transient — retry same model
      }
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

// timezone-correct slot times, with a day offset (0=today, 1=tomorrow, ...)
function ilOffsetMin() { const d = new Date(); return Math.round((new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })) - d) / 60000); }
function ilYMD() { const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })); return [d.getFullYear(), d.getMonth(), d.getDate()]; }
function ilWeekday() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })).getDay(); }
function dueAtFor(hour, off = 0) { const [y, m, day] = ilYMD(); return new Date(Date.UTC(y, m, day + off, hour, 0, 0) - ilOffsetMin() * 60000).toISOString(); }
function stampFor(off = 0) { const [y, m, day] = ilYMD(); const d = new Date(Date.UTC(y, m, day + off)); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; }
function wdFor(off = 0) { return (ilWeekday() + off) % 7; }

const FF = 'ffmpeg';
const RENDER = path.join(ROOT, 'scripts', 'render_video.js');
const VIDEOS = path.join(ROOT, 'videos');
const STATE = path.join(ROOT, 'state', 'next_topic.txt');

(async () => {
  const topics = JSON.parse(fs.readFileSync(path.join(ROOT, 'topics.json'), 'utf8'));
  let ptr = parseInt(fs.readFileSync(STATE, 'utf8').trim(), 10) || 0;
  const today = ilYMD().join('-');
  const LASTP = path.join(ROOT, 'state', 'last_run.txt');
  // NOTE: no daily dedup here anymore — slots are file-level idempotent (a slot whose
  // video already exists is skipped), so every cron pass safely heals whatever a
  // previous pass missed (e.g. Gemini quota failures) without double-scheduling.
  const nowMs = Date.now();
  // FULL SCHEDULE, TWO DAYS AHEAD: build slots for today + the next HORIZON days.
  // Today's slots publish today; future days' videos are rendered ahead of time and
  // scheduled into Buffer as queue capacity frees up (free plan ~10 pending/channel).
  const HORIZON = parseInt(process.env.DAYS_AHEAD || '2', 10);
  const LATE_GRACE = 90 * 60000;
  let cand = [];
  for (let off = 0; off <= HORIZON; off++) {
    const wd = wdFor(off);
    const dayCand = [
      ...slotsFor(wd, 'ig'),
      ...(DO_TT ? slotsFor(wd, 'tt') : []),
    ].map((s) => ({ ...s, off, dueAt: dueAtFor(s.h, off), name: `v-${stampFor(off)}-${s.h}-${s.plat}` }))
      .sort((a, b) => a.h - b.h);
    cand = cand.concat(off === 0 && !DRY
      ? dayCand.filter((s) => new Date(s.dueAt).getTime() > nowMs - LATE_GRACE)
      : dayCand);
  }
  const future = cand.slice(0, DRY ? MAX : cand.length);
  console.log('Slots (today + ' + HORIZON + ' days):', future.map((s) => `+${s.off}d ${s.h}:00 ${s.plat.toUpperCase()}${s.strong ? '*' : ''}`).join(', ') || '(none)');
  if (!future.length) { console.log('Nothing to schedule.'); return; }

  // prune only videos from BEFORE yesterday (future days' videos must survive)
  if (!DRY) {
    const cutoff = stampFor(-1);
    for (const f of fs.readdirSync(VIDEOS).filter((x) => x.endsWith('.mp4'))) {
      const m = f.match(/^v-(\d{8})-/);
      if (m && m[1] < cutoff) fs.rmSync(path.join(VIDEOS, f));
    }
  }

  // which slots were already scheduled into Buffer (survives across runs)
  const SCHEDP = path.join(ROOT, 'state', 'scheduled.json');
  let scheduledList = [];
  try { scheduledList = JSON.parse(fs.readFileSync(SCHEDP, 'utf8')) || []; } catch (e) {}
  const scheduledSet = new Set(scheduledList);
  const saveScheduled = () => fs.writeFileSync(SCHEDP, JSON.stringify(scheduledList.slice(-400)));

  execFileSync('git', ['config', 'user.name', 'charisma-bot']);
  execFileSync('git', ['config', 'user.email', 'bot@users.noreply.github.com']);
  const pushRepo = async (msg) => {
    execFileSync('git', ['add', '-A'], { cwd: ROOT });
    try { execFileSync('git', ['commit', '-m', msg], { cwd: ROOT }); } catch (e) { return; } // nothing to commit
    for (let attempt = 1; attempt <= 5; attempt++) {
      try { execFileSync('git', ['push'], { cwd: ROOT, stdio: 'inherit' }); return; }
      catch (e) {
        if (attempt === 5) throw e;
        console.log('  push rejected — pulling --rebase and retrying...');
        try { execFileSync('git', ['pull', '--rebase', 'origin', 'main'], { cwd: ROOT, stdio: 'inherit' }); } catch (e2) {}
        await sleep(2000);
      }
    }
  };
  const waitReady = async (u) => { for (let i = 0; i < 20; i++) { if (await urlReady(u)) return true; await sleep(3000); } return false; };

  // captions saved at render time so later runs can schedule pre-rendered videos
  const CAPP = path.join(ROOT, 'state', 'captions.json');
  let captions = {};
  try { captions = JSON.parse(fs.readFileSync(CAPP, 'utf8')) || {}; } catch (e) {}
  const FALLBACK_IG = 'תגיבו "אני" אם הגעתם עד לכאן,\nוקבלו את המדריך לפיתוח\nמשמעת עצמית 👇\n\n' + IG_HASHTAGS;

  // render -> push -> schedule EACH video immediately. Pre-rendered future videos are
  // scheduled as Buffer queue capacity frees (free plan caps pending posts/channel).
  let madeCount = 0, scheduledCount = 0, attempted = 0;
  const channelFull = { ig: false, tt: false };
  for (const slot of future) {
    const isTT = slot.plat === 'tt';
    const name = slot.name;
    if (scheduledSet.has(name)) { console.log(`+${slot.off}d ${slot.h}:00 ${slot.plat.toUpperCase()} — already scheduled, skipping`); continue; }
    const exists = fs.existsSync(path.join(VIDEOS, name + '.mp4'));
    let caption = captions[name] && captions[name].c;
    let title = (captions[name] && captions[name].t) || 'self discipline';
    if (!exists) {
      if (attempted >= MAX) { console.log(`+${slot.off}d ${slot.h}:00 ${slot.plat.toUpperCase()} — render budget reached, next pass`); continue; }
      const topic = topics[ptr % topics.length]; ptr++;
      attempted++;
      try {
        console.log(`\n=== +${slot.off}d ${slot.h}:00 ${slot.plat.toUpperCase()}${slot.strong ? ' (peak)' : ''}  topic="${topic}" ===`);
        const script = await genScript(topic, slot.strong);
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
        title = topic.length > 60 ? topic.slice(0, 57) + '...' : topic;
        caption = isTT ? TT_CAPTION : `${script.cta.he}\n\n${IG_HASHTAGS}`;
        captions[name] = { c: caption, t: title };
        fs.rmSync(outDir, { recursive: true, force: true });
        if (DRY) {
          const kb = Math.round(fs.statSync(path.join(VIDEOS, name + '.mp4')).size / 1024);
          console.log(`  [DRY_RUN] rendered ${name}.mp4 (${kb} KB) — not pushing, not scheduling.`);
          madeCount++; continue;
        }
        fs.writeFileSync(STATE, String(ptr) + '\n');
        fs.writeFileSync(LASTP, today + '\n');
        fs.writeFileSync(CAPP, JSON.stringify(captions));
        await pushRepo(`video ${name}`);
        madeCount++;
      } catch (e) { console.error('  slot failed:', e.message); continue; }
    }
    if (DRY || channelFull[slot.plat]) continue;
    if (!caption) caption = isTT ? TT_CAPTION : FALLBACK_IG;
    try {
      const url = `https://raw.githubusercontent.com/${REPO}/main/videos/${name}.mp4`;
      await waitReady(url);
      // if the slot time already passed (late run), publish a few minutes from now
      const due = new Date(Math.max(new Date(slot.dueAt).getTime(), Date.now() + 6 * 60000)).toISOString();
      const r = await schedule(isTT ? TT : IG, url, due, caption, isTT, title);
      if (/"status":"(scheduled|sent)"/.test(r)) {
        scheduledSet.add(name); scheduledList.push(name); saveScheduled();
        scheduledCount++;
        console.log(`  Scheduled +${slot.off}d ${slot.h}:00 ${slot.plat.toUpperCase()} @ ${due}`);
      } else {
        console.log(`  schedule failed for ${name}: ${r.slice(0, 160)}`);
        if (/limit|queue|upgrade|plan/i.test(r)) { channelFull[slot.plat] = true; console.log(`  ${slot.plat.toUpperCase()} queue full — will top up on a later pass.`); }
      }
    } catch (e) { console.error('  schedule error:', e.message); }
  }
  if (!DRY) { fs.writeFileSync(CAPP, JSON.stringify(captions)); await pushRepo('state: scheduled/captions'); }

  if (!madeCount && !scheduledCount && attempted > 0) { console.error('No videos produced (all attempted slots failed).'); process.exit(1); }
  console.log(`\nALL DONE — rendered ${madeCount}, scheduled ${scheduledCount}${DRY ? ' (dry run)' : ''}.`);

  // keep the repo small: on Sunday runs squash all git history into one commit
  // (videos are heavy; without this the repo would outgrow GitHub within weeks)
  if (!DRY && wdFor(0) === 0) {
    try {
      execFileSync('git', ['checkout', '--orphan', 'squash'], { cwd: ROOT });
      execFileSync('git', ['add', '-A'], { cwd: ROOT });
      execFileSync('git', ['commit', '-m', 'weekly history squash'], { cwd: ROOT });
      execFileSync('git', ['push', '-f', 'origin', 'squash:main'], { cwd: ROOT });
      console.log('Weekly history squash pushed.');
    } catch (e) { console.log('squash skipped:', e.message); }
  }
  process.exit(0); // exit cleanly so the runner step doesn't hang on open sockets
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
