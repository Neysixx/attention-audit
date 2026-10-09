// Turns the audit CSVs into your attention numbers and a shareable card,
// using only what ships with macOS (JavaScript for Automation + AppKit).
// Usage: osascript -l JavaScript card-macos.js <data_dir> <out.png> [assets_dir]
// Prints the text report. The card never shows app names.

ObjC.import('AppKit');
ObjC.import('CoreText');

const IDLE = 'idle';
const FOCUSED_SECONDS = 600;
const SHORT_SECONDS = 120;

// ---------- stats ----------

function readSamples(dataDir) {
  const fm = $.NSFileManager.defaultManager;
  const names = ObjC.deepUnwrap(fm.contentsOfDirectoryAtPathError(dataDir, null)) || [];
  const samples = [];
  names.filter(n => /^audit_\d{4}-\d{2}-\d{2}\.csv$/.test(n)).forEach(name => {
    const raw = $.NSString.stringWithContentsOfFileEncodingError(dataDir + '/' + name, $.NSUTF8StringEncoding, null);
    ObjC.unwrap(raw).split('\n').slice(1).forEach(line => {
      const comma = line.indexOf(',');
      if (comma < 0) return;
      const iso = line.slice(0, comma);
      const ts = new Date(iso);
      if (isNaN(ts)) return;
      samples.push({ ts, day: iso.slice(0, 10), app: line.slice(comma + 1).replace(/^"|"$/g, '') });
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

// A gap means the logger was not sampling (mac asleep, agent stopped), so
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
// Nudge art direction: cream page, ivory sheet, Newsreader for figures,
// Public Sans for text, one teal accent. Nudge red only marks the peak hour,
// the moment of the day the app would nudge you.
// AppKit's origin is bottom-left, so every y below goes through top().

const W = 1200;
const H = 675;
const MARGIN = 28;
const PAD = 76;

const PAGE = hex('#e7e2d7');
const SHEET = hex('#f6f2ea');
const BORDER = hex('#cfc7b8');
const INK = hex('#1f1c18');
const MUTED = hex('#524c45');
const FAINT = hex('#8a8276');
const ACCENT = hex('#326b82');
const TRACK = hex('#e4ddcf');
const NUDGE = hex('#ff382e');

const SERIF = { regular: 'Newsreader16pt-Regular', medium: 'NewsreaderRoman-Medium' };
const SANS = { regular: 'PublicSansRoman-Regular', medium: 'PublicSansRoman-Medium', semibold: 'PublicSansRoman-SemiBold' };

function hex(h) {
  return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
}

function registerFonts(assetsDir) {
  ['Newsreader.ttf', 'PublicSans.ttf'].forEach(name => {
    $.CTFontManagerRegisterFontsForURL($.NSURL.fileURLWithPath(assetsDir + '/fonts/' + name), 1, null);
  });
}

// Falls back to the system font if a brand font did not register.
function font(name, size) {
  const f = $.NSFont.fontWithNameSize(name, size);
  return f.isNil() ? $.NSFont.systemFontOfSize(size) : f;
}

function color(rgb) {
  return $.NSColor.colorWithSRGBRedGreenBlueAlpha(rgb[0], rgb[1], rgb[2], 1);
}

function top(y, height) {
  return H - y - height;
}

function attrsFor(name, size, rgb, tracking) {
  const attrs = $.NSMutableDictionary.alloc.init;
  attrs.setObjectForKey(font(name, size), $.NSFontAttributeName);
  attrs.setObjectForKey(color(rgb), $.NSForegroundColorAttributeName);
  if (tracking) attrs.setObjectForKey($(tracking), $.NSKernAttributeName);
  return attrs;
}

function measure(str, name, size, tracking) {
  return $(str).sizeWithAttributes(attrsFor(name, size, INK, tracking)).width;
}

function text(str, x, y, name, size, rgb, tracking) {
  const attrs = attrsFor(name, size, rgb, tracking);
  const s = $(str);
  const sz = s.sizeWithAttributes(attrs);
  s.drawAtPointWithAttributes($.NSMakePoint(x, top(y, sz.height)), attrs);
  return sz.width;
}

function rect(x, y, w, h, rgb, radius) {
  color(rgb).setFill;
  $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(x, top(y, h), w, h), radius, radius).fill;
}

function strokeRect(x, y, w, h, rgb, radius) {
  color(rgb).setStroke;
  const path = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(
    $.NSMakeRect(x + 0.5, top(y, h) + 0.5, w - 1, h - 1), radius, radius);
  path.setLineWidth(1);
  path.stroke;
}

function image(path, x, y, size, radius) {
  const img = $.NSImage.alloc.initWithContentsOfFile(path);
  if (img.isNil()) return false;
  $.NSGraphicsContext.saveGraphicsState;
  $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(x, top(y, size), size, size), radius, radius).addClip;
  img.drawInRectFromRectOperationFraction($.NSMakeRect(x, top(y, size), size, size), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  return true;
}

function stat(x, y, value, label, rgb) {
  text(value, x, y, SERIF.medium, 52, rgb, -0.5);
  text(label, x, y + 68, SANS.regular, 19, MUTED);
}

function hourChart(byHour, x, y, w, h) {
  const peak = Math.max(1, ...byHour);
  const gap = 7;
  const barW = (w - gap * 23) / 24;
  byHour.forEach((count, hour) => {
    const bx = x + hour * (barW + gap);
    rect(bx, y, barW, h, TRACK, 4);
    const bh = Math.max(count ? 5 : 0, (count / peak) * h);
    if (bh) rect(bx, y + h - bh, barW, bh, count === peak ? NUDGE : ACCENT, 4);
  });
  [0, 6, 12, 18, 23].forEach(hour => {
    text(String(hour).padStart(2, '0') + 'h', x + hour * (barW + gap), y + h + 10, SANS.regular, 14, FAINT);
  });
}

function drawCard(s, outPath, assetsDir) {
  registerFonts(assetsDir);
  const rep = $.NSBitmapImageRep.alloc
    .initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null, W, H, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  $.NSGraphicsContext.setCurrentContext(ctx);

  rect(0, 0, W, H, PAGE, 0);
  rect(MARGIN, MARGIN, W - MARGIN * 2, H - MARGIN * 2, SHEET, 26);
  strokeRect(MARGIN, MARGIN, W - MARGIN * 2, H - MARGIN * 2, BORDER, 26);

  const dayLabel = s.days === 1 ? '1 day' : s.days + ' days';
  text('ATTENTION AUDIT  ·  ' + dayLabel.toUpperCase() + ' ON MY MAC', PAD, 74, SANS.semibold, 14, FAINT, 1.8);

  const iconSize = 34;
  const hasIcon = image(assetsDir + '/nudge-icon.png', W - PAD - iconSize, 64, iconSize, 8);
  const brandX = W - PAD - (hasIcon ? iconSize + 10 : 0) - measure('nudge', SERIF.medium, 26);
  text('nudge', brandX, 66, SERIF.medium, 26, INK);

  const num = String(Math.round(s.switchesPerDay));
  const numW = text(num, PAD - 6, 112, SERIF.regular, 150, INK, -4);
  text('app switches', PAD + numW + 18, 158, SERIF.regular, 40, INK, -0.5);
  text('a day, on average', PAD + numW + 18, 206, SANS.regular, 21, MUTED);

  const rowY = 300;
  const col = (W - PAD * 2) / 4;
  stat(PAD, rowY, fmt(s.medianRun), 'median focus stretch', INK);
  stat(PAD + col, rowY, Math.round(s.shortPct) + '%', 'of stretches under 2 min', INK);
  stat(PAD + col * 2, rowY, Math.round(s.focusedPct) + '%', 'of stretches over 10 min', ACCENT);
  stat(PAD + col * 3, rowY, s.switchesPerHour.toFixed(1), 'switches per active hour', INK);

  rect(PAD, 418, W - PAD * 2, 1, BORDER, 0);
  text('switches by hour of day', PAD, 438, SANS.medium, 15, MUTED);
  const peakHour = s.byHour.indexOf(Math.max(...s.byHour));
  const peakLabel = 'peak at ' + String(peakHour).padStart(2, '0') + 'h';
  const peakW = measure(peakLabel, SANS.medium, 15);
  rect(W - PAD - peakW - 14, 440, 8, 8, NUDGE, 4);
  text(peakLabel, W - PAD - peakW, 438, SANS.medium, 15, MUTED);
  hourChart(s.byHour, PAD, 470, W - PAD * 2, 92);

  text('github.com/Neysixx/attention-audit  ·  @ks_nsx', PAD, 600, SANS.regular, 14, FAINT);
  const site = 'mynudge.app';
  text(site, W - PAD - measure(site, SANS.medium, 14), 600, SANS.medium, 14, ACCENT);

  ctx.flushGraphics;
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  if (!png.writeToFileAtomically(outPath, true)) throw new Error('could not write ' + outPath);
}

// ---------- entry ----------

function run(argv) {
  const [dataDir, outPath] = argv;
  const assetsDir = argv[2] || dataDir.replace(/\/data\/?$/, '') + '/assets';
  const samples = readSamples(dataDir);
  if (samples.length < 2) throw new Error('not enough data yet. let the audit run a few hours.');
  const stats = compute(samples);
  if (!stats) throw new Error('every sample is idle. was the mac asleep the whole time?');
  drawCard(stats, outPath, assetsDir);
  // Last line is machine-read by card.sh to prefill the post.
  return textReport(stats) + '\n' + JSON.stringify({
    days: stats.days,
    perDay: Math.round(stats.switchesPerDay),
    median: fmt(stats.medianRun),
  });
}
