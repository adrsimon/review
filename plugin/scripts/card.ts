/**
 * The score card: one graded session as a 1200x675 image and a small page
 * around it to copy it or save it as PNG.
 *
 * It never names a private repository. A private PR shows as its size only, so
 * the image can be passed around without leaking what a company works on.
 */

export interface CardCriterion {
  key: string;
  label: string;
  weight: number;
  score: number;
}

export interface CardData {
  overall: number;
  bonus: number;
  criteria: CardCriterion[];
  /** caught/total per severity, nits left out. */
  recall: Array<{ severity: string; caught: number; total: number }>;
  /** e.g. "vercel/next.js#71234", or null when the repository is not public. */
  prLabel: string | null;
  prTitle: string | null;
  prUrl: string | null;
  files: number;
  additions: number;
  deletions: number;
  minutes: number | null;
  /** Overall change against the previous graded session, if any. */
  delta: number | null;
  session: number;
  date: string;
}

const W = 1200;
const H = 675;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/** Score colour: the same three bands the eye reads on a progress bar. */
function tone(fraction: number): string {
  if (fraction >= 0.7) return "#4ade80";
  if (fraction >= 0.45) return "#facc15";
  return "#f87171";
}

export function caughtTotals(data: CardData): { caught: number; total: number } {
  let caught = 0;
  let total = 0;
  for (const r of data.recall) {
    caught += r.caught;
    total += r.total;
  }
  return { caught, total };
}

export function renderSvg(data: CardData): string {
  const font = `font-family="Inter, 'SF Pro Display', system-ui, -apple-system, 'Segoe UI', sans-serif"`;
  const mono = `font-family="'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace"`;
  const { caught, total } = caughtTotals(data);
  const scoreColor = tone(data.overall / 100);

  const subject = data.prLabel
    ? `${esc(data.prLabel)}`
    : `a private pull request`;
  const size = `${data.files} file${data.files === 1 ? "" : "s"} · +${data.additions} −${data.deletions}`;

  // Criteria, right column.
  const barX = 640;
  const barW = 400;
  const rowH = 50;
  const top = 150;
  const rows = data.criteria
    .map((c, i) => {
      const y = top + i * rowH;
      const f = Math.max(0, Math.min(1, c.score / 5));
      return `
    <text x="${barX}" y="${y}" ${font} font-size="19" fill="#e4e4e7">${esc(c.label)}</text>
    <text x="${barX + barW + 70}" y="${y}" ${mono} font-size="18" fill="#a1a1aa" text-anchor="end">${c.score % 1 ? c.score.toFixed(1) : c.score}/5</text>
    <rect x="${barX}" y="${y + 10}" width="${barW + 70}" height="8" rx="4" fill="#27272a"/>
    <rect x="${barX}" y="${y + 10}" width="${Math.max(8, (barW + 70) * f)}" height="8" rx="4" fill="${tone(f)}"/>`;
    })
    .join("");

  const recallLine = data.recall
    .filter((r) => r.total > 0)
    .map((r) => `${r.severity} ${r.caught}/${r.total}`)
    .join("   ");

  const delta =
    data.delta === null
      ? ""
      : `<text x="64" y="420" ${font} font-size="24" font-weight="600" fill="${data.delta >= 0 ? "#4ade80" : "#f87171"}">${data.delta >= 0 ? "▲" : "▼"} ${Math.abs(data.delta)} since last session</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="glow" cx="0.18" cy="0.35" r="0.6">
      <stop offset="0" stop-color="${scoreColor}" stop-opacity="0.16"/>
      <stop offset="1" stop-color="${scoreColor}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#0a0a0b"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="#27272a"/>

  <text x="64" y="86" ${font} font-size="22" font-weight="600" fill="#a1a1aa" letter-spacing="0.5">CODE REVIEW SCORE</text>
  <text x="64" y="300" ${font} font-size="210" font-weight="700" fill="#fafafa" letter-spacing="-8">${data.overall}</text>
  <text x="${64 + String(data.overall).length * 118 + 12}" y="300" ${font} font-size="44" font-weight="500" fill="#71717a">/100</text>
  <text x="64" y="370" ${font} font-size="26" fill="#e4e4e7">Caught <tspan font-weight="700" fill="#fafafa">${caught} of ${total}</tspan> issues in the change</text>
  ${delta}

  <text x="64" y="500" ${font} font-size="20" fill="#a1a1aa">Reviewed blind</text>
  <text x="64" y="532" ${mono} font-size="22" fill="#fafafa">${subject}</text>
  ${data.prTitle ? `<text x="64" y="564" ${font} font-size="20" fill="#a1a1aa">${esc(clip(data.prTitle, 48))}</text>` : ""}
  <text x="64" y="${data.prTitle ? 596 : 564}" ${mono} font-size="18" fill="#71717a">${esc(size)}${data.minutes !== null ? ` · ${data.minutes} min` : ""}</text>

  <text x="${barX}" y="86" ${font} font-size="22" font-weight="600" fill="#a1a1aa" letter-spacing="0.5">RUBRIC</text>
  ${rows}
  <text x="${barX}" y="${top + data.criteria.length * rowH + 4}" ${mono} font-size="17" fill="#71717a">${esc(recallLine)}${data.bonus ? `   bonus +${data.bonus}` : ""}</text>

  <line x1="64" y1="${H - 56}" x2="${W - 64}" y2="${H - 56}" stroke="#27272a"/>
  <text x="64" y="${H - 22}" ${font} font-size="18" fill="#a1a1aa"><tspan fill="#fafafa" font-weight="600">review-training</tspan> · a Claude Code plugin</text>
  <text x="${W - 64}" y="${H - 22}" ${mono} font-size="17" fill="#71717a" text-anchor="end">session ${data.session} · ${esc(data.date)}</text>
</svg>
`;
}

export function renderCard(data: CardData): { svg: string; html: string } {
  const svg = renderSvg(data);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review score ${data.overall}/100</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #050505;
         font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #e4e4e7; }
  main { width: min(1200px, calc(100vw - 32px)); display: flex; flex-direction: column; gap: 16px; padding: 32px 0; }
  .card svg { width: 100%; height: auto; display: block; border-radius: 16px; box-shadow: 0 30px 80px rgba(0,0,0,.6); }
  .bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  button { appearance: none; border: 1px solid #3f3f46; background: #18181b; color: #fafafa; border-radius: 8px;
         padding: 8px 14px; font: inherit; font-weight: 500; cursor: pointer; text-decoration: none; }
  button:hover { background: #27272a; }
  .hint { color: #71717a; font-size: 13px; margin-left: auto; }
</style>
</head>
<body>
<main>
  <div class="card" id="card">${svg}</div>
  <div class="bar">
    <button id="copy">Copy image</button>
    <button id="png">Download PNG</button>
    <span class="hint" id="hint">Copy the image or save it as PNG.</span>
  </div>
</main>
<script>
  const svg = document.querySelector("#card svg");
  const hint = document.getElementById("hint");
  function toPng() {
    return new Promise((resolve, reject) => {
      const data = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = ${W * 2}; c.height = ${H * 2};
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, c.width, c.height);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error("no image"))), "image/png");
      };
      img.onerror = reject;
      img.src = data;
    });
  }
  document.getElementById("png").onclick = async () => {
    const blob = await toPng();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "review-score-${data.overall}.png";
    a.click();
  };
  document.getElementById("copy").onclick = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": toPng() })]);
      hint.textContent = "Copied.";
    } catch {
      hint.textContent = "Your browser blocked copying; use Download PNG instead.";
    }
  };
</script>
</body>
</html>
`;
  return { svg, html };
}
