#!/usr/bin/env bun
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

const IDLE = 'idle';
const FOCUSED_SECONDS = 600;
const SHORT_SECONDS = 120;

// ---------- stats ----------

function readSamples(dataDir) {
  if (!fs.existsSync(dataDir)) return [];
  const names = fs.readdirSync(dataDir);
  const samples = [];
  names.filter(n => /^audit_\d{4}-\d{2}-\d{2}\.csv$/.test(n)).forEach(name => {
    const raw = fs.readFileSync(path.join(dataDir, name), 'utf8');
    raw.split('\n').slice(1).forEach(line => {
      const comma = line.indexOf(',');
      if (comma < 0) return;
      const iso = line.slice(0, comma);
      const ts = new Date(iso);
      if (isNaN(ts.getTime())) return;
      samples.push({ ts, day: iso.slice(0, 10), app: line.slice(comma + 1).replace(/^"|"$/g, '').trim() });
    });
  });
  return samples.sort((a, b) => a.ts - b.ts);
}

function intervalSeconds(samples) {
  const gaps = [];
  for (let i = 1; i < samples.length; i++) {
    const g = (samples[i].ts - samples[i - 1].ts) / 1000;
    if (g < 300) gaps.push(g);
  }
  return gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 30;
}

// A gap means the logger was not sampling (computer asleep, agent stopped), so
// samples either side of one are not a single uninterrupted stretch.
function activeBlocks(samples, step) {
  const maxGap = step * 2.5;
  const blocks = [];
  let current = [];
  let prev = null;
  samples.forEach(s => {
    const gap = prev && (s.ts - prev.ts) / 1000 > maxGap;
    if (s.app === IDLE || gap) {
      if (current.length) blocks.push(current);
      current = [];
    }
    if (s.app !== IDLE) current.push(s);
    prev = s;
  });
  if (current.length) blocks.push(current);
  return blocks;
}

function runsIn(block, step) {
  const out = [];
  let app = block[0].app;
  let count = 1;
  block.slice(1).forEach(s => {
    if (s.app === app) {
      count++;
    } else {
      out.push({ app, seconds: count * step });
      app = s.app;
      count = 1;
    }
  });
  out.push({ app, seconds: count * step });
  return out;
}

function fmt(seconds) {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}m${String(s).padStart(2, '0')}s`;
}

function compute(samples) {
  const step = intervalSeconds(samples);
  const blocks = activeBlocks(samples, step);
  if (!blocks.length) return null;

  const runs = [];
  let switches = 0;
  const byHour = new Array(24).fill(0);
  const perApp = {};
  const pulls = {};
  blocks.forEach(block => {
    const blockRuns = runsIn(block, step);
    blockRuns.forEach((r, i) => {
      runs.push(r);
      perApp[r.app] = (perApp[r.app] || 0) + r.seconds;
      if (i > 0) {
        switches++;
        pulls[r.app] = (pulls[r.app] || 0) + 1;
      }
    });
    for (let i = 1; i < block.length; i++) {
      if (block[i].app !== block[i - 1].app) byHour[block[i].ts.getHours()]++;
    }
  });

  const durations = runs.map(r => r.seconds).sort((a, b) => a - b);
  const active = durations.reduce((a, b) => a + b, 0);
  const days = new Set(samples.map(s => s.day)).size;
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    days,
    active,
    switches,
    switchesPerDay: switches / days,
    switchesPerHour: active ? switches / (active / 3600) : 0,
    medianRun: durations[Math.floor(durations.length / 2)],
    shortPct: durations.filter(d => d < SHORT_SECONDS).length / runs.length * 100,
    focusedPct: durations.filter(d => d >= FOCUSED_SECONDS).length / runs.length * 100,
    longestRun: durations[durations.length - 1],
    byHour,
    perApp: top(perApp, 10),
    pulls: top(pulls, 8),
  };
}

function textReport(s) {
  const lines = [
    'ATTENTION AUDIT',
    `days logged         ${s.days}`,
    `active time         ${fmt(s.active)}`,
    '',
    `app switches        ${s.switches}`,
    `  per day           ${Math.round(s.switchesPerDay)}`,
    `  per active hour   ${s.switchesPerHour.toFixed(1)}`,
    '',
    `median focus run    ${fmt(s.medianRun)}`,
    `  under 2 min       ${Math.round(s.shortPct)}% of runs`,
    `  over 10 min       ${Math.round(s.focusedPct)}% of runs`,
    `  longest run       ${fmt(s.longestRun)}`,
    '',
    '--- time per app ---',
    ...s.perApp.map(([app, sec]) => `  ${fmt(sec).padStart(7)}  ${(sec / s.active * 100).toFixed(1).padStart(5)}%  ${app}`),
    '',
    '--- what pulls you away ---',
    ...s.pulls.map(([app, n]) => `  ${String(n).padStart(4)}x  ${app}`),
  ];
  if (s.active < 3600) lines.splice(1, 0, `!! only ${fmt(s.active)} of activity so far. let it run longer.`);
  return lines.join('\n');
}

// ---------- card ----------
const W = 1200;
const H = 675;
const MARGIN = 28;
const PAD = 76;

const PAGE = '#e7e2d7';
const SHEET = '#f6f2ea';
const BORDER = '#cfc7b8';
const INK = '#1f1c18';
const MUTED = '#524c45';
const FAINT = '#8a8276';
const ACCENT = '#326b82';
const TRACK = '#e4ddcf';
const NUDGE = '#ff382e';

let fontsRegistered = false;
function registerFonts(assetsDir) {
  if (fontsRegistered) return;
  const newsreader = path.join(assetsDir, 'fonts/Newsreader.ttf');
  const publicSans = path.join(assetsDir, 'fonts/PublicSans.ttf');
  if (fs.existsSync(newsreader)) GlobalFonts.registerFromPath(newsreader, 'Newsreader');
  if (fs.existsSync(publicSans)) GlobalFonts.registerFromPath(publicSans, 'Public Sans');
  fontsRegistered = true;
}

function rect(ctx, x, y, w, h, color, radius = 0) {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (radius > 0) {
    ctx.roundRect(x, y, w, h, radius);
  } else {
    ctx.rect(x, y, w, h);
  }
  ctx.fill();
}

function strokeRect(ctx, x, y, w, h, color, radius = 0) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (radius > 0) {
    ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, radius);
  } else {
    ctx.rect(x + 0.5, y + 0.5, w - 1, h - 1);
  }
  ctx.stroke();
}

async function drawImage(ctx, imagePath, x, y, size, radius = 0) {
  if (!fs.existsSync(imagePath)) return false;
  try {
    const img = await loadImage(imagePath);
    ctx.save();
    ctx.beginPath();
    if (radius > 0) {
      ctx.roundRect(x, y, size, size, radius);
    } else {
      ctx.rect(x, y, size, size);
    }
    ctx.clip();
    ctx.drawImage(img, x, y, size, size);
    ctx.restore();
    return true;
  } catch (e) {
    return false;
  }
}

function text(ctx, str, x, y, font, color, letterSpacing = 0) {
  ctx.fillStyle = color;
  ctx.font = font;
  ctx.textBaseline = 'top';
  ctx.letterSpacing = letterSpacing ? `${letterSpacing}px` : '0px';
  ctx.fillText(str, x, y);
  return ctx.measureText(str).width;
}

function measure(ctx, str, font, letterSpacing = 0) {
  ctx.font = font;
  ctx.letterSpacing = letterSpacing ? `${letterSpacing}px` : '0px';
  return ctx.measureText(str).width;
}

function stat(ctx, x, y, value, label, color) {
  text(ctx, value, x, y, '500 52px "Newsreader", serif', color, -0.5);
  text(ctx, label, x, y + 68, '400 19px "Public Sans", sans-serif', MUTED);
}

function hourChart(ctx, byHour, x, y, w, h) {
  const peak = Math.max(1, ...byHour);
  const gap = 7;
  const barW = (w - gap * 23) / 24;
  byHour.forEach((count, hour) => {
    const bx = x + hour * (barW + gap);
    rect(ctx, bx, y, barW, h, TRACK, 4);
    const bh = Math.max(count ? 5 : 0, (count / peak) * h);
    if (bh) rect(ctx, bx, y + h - bh, barW, bh, count === peak ? NUDGE : ACCENT, 4);
  });
  [0, 6, 12, 18, 23].forEach(hour => {
    text(ctx, String(hour).padStart(2, '0') + 'h', x + hour * (barW + gap), y + h + 10, '400 14px "Public Sans", sans-serif', FAINT);
  });
}

async function drawCard(s, outPath, assetsDir) {
  registerFonts(assetsDir);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  rect(ctx, 0, 0, W, H, PAGE, 0);
  rect(ctx, MARGIN, MARGIN, W - MARGIN * 2, H - MARGIN * 2, SHEET, 26);
  strokeRect(ctx, MARGIN, MARGIN, W - MARGIN * 2, H - MARGIN * 2, BORDER, 26);

  const dayLabel = s.days === 1 ? '1 day' : s.days + ' days';
  text(ctx, 'ATTENTION AUDIT  ·  ' + dayLabel.toUpperCase() + ' ON LINUX', PAD, 74, '600 14px "Public Sans", sans-serif', FAINT, 1.8);

  const iconSize = 34;
  const iconPath = path.join(assetsDir, 'nudge-icon.png');
  const hasIcon = await drawImage(ctx, iconPath, W - PAD - iconSize, 64, iconSize, 8);
  const brandFont = '500 26px "Newsreader", serif';
  const brandX = W - PAD - (hasIcon ? iconSize + 10 : 0) - measure(ctx, 'nudge', brandFont);
  text(ctx, 'nudge', brandX, 66, brandFont, INK);

  const num = String(Math.round(s.switchesPerDay));
  const numFont = '400 150px "Newsreader", serif';
  const numW = text(ctx, num, PAD - 6, 112, numFont, INK, -4);
  text(ctx, 'app switches', PAD + numW + 18, 158, '400 40px "Newsreader", serif', INK, -0.5);
  text(ctx, 'a day, on average', PAD + numW + 18, 206, '400 21px "Public Sans", sans-serif', MUTED);

  const rowY = 300;
  const col = (W - PAD * 2) / 4;
  stat(ctx, PAD, rowY, fmt(s.medianRun), 'median focus stretch', INK);
  stat(ctx, PAD + col, rowY, Math.round(s.shortPct) + '%', 'of stretches under 2 min', INK);
  stat(ctx, PAD + col * 2, rowY, Math.round(s.focusedPct) + '%', 'of stretches over 10 min', ACCENT);
  stat(ctx, PAD + col * 3, rowY, s.switchesPerHour.toFixed(1), 'switches per active hour', INK);

  rect(ctx, PAD, 418, W - PAD * 2, 1, BORDER, 0);
  text(ctx, 'switches by hour of day', PAD, 438, '500 15px "Public Sans", sans-serif', MUTED);
  const peakHour = s.byHour.indexOf(Math.max(...s.byHour));
  const peakLabel = 'peak at ' + String(peakHour).padStart(2, '0') + 'h';
  const peakW = measure(ctx, peakLabel, '500 15px "Public Sans", sans-serif');
  rect(ctx, W - PAD - peakW - 14, 440, 8, 8, NUDGE, 4);
  text(ctx, peakLabel, W - PAD - peakW, 438, '500 15px "Public Sans", sans-serif', MUTED);
  hourChart(ctx, s.byHour, PAD, 470, W - PAD * 2, 92);

  text(ctx, 'github.com/Neysixx/attention-audit  ·  @ks_nsx', PAD, 600, '400 14px "Public Sans", sans-serif', FAINT);
  const site = 'mynudge.app';
  const siteFont = '500 14px "Public Sans", sans-serif';
  text(ctx, site, W - PAD - measure(ctx, site, siteFont), 600, siteFont, ACCENT);

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outPath, buffer);
}

// ---------- entry ----------

async function main() {
  const argv = process.argv.slice(2);
  const dataDir = argv[0];
  const outPath = argv[1];
  const assetsDir = argv[2] || path.resolve(dataDir, '../assets');

  if (!dataDir || !outPath) {
    console.error('Usage: bun card-linux.js <data_dir> <out.png> [assets_dir]');
    process.exit(1);
  }

  const samples = readSamples(dataDir);
  if (samples.length < 2) {
    throw new Error('not enough data yet. let the audit run a few hours.');
  }
  const stats = compute(samples);
  if (!stats) {
    throw new Error('every sample is idle. was the computer asleep the whole time?');
  }

  await drawCard(stats, outPath, assetsDir);

  // Output text report followed by JSON summary (for card.sh)
  console.log(textReport(stats));
  console.log(JSON.stringify({
    days: stats.days,
    perDay: Math.round(stats.switchesPerDay),
    median: fmt(stats.medianRun),
  }));
}

if (require.main === module || (process.argv[1] && (process.argv[1].endsWith('card-linux.js') || process.argv[1].endsWith('card.js')))) {
  if (process.argv.slice(2).length > 0) {
    main().catch(err => {
      console.error('Error: ' + err.message);
      process.exit(1);
    });
  }
}

module.exports = { drawCard, compute, textReport, fmt, readSamples };
