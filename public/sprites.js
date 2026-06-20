// Pixel-art sprite engine for the Kappa agents.
// Characters are authored as 16x16 grids (one char per pixel -> palette colour).
// Rendered as crisp SVG, with an idle bob + occasional blink, and a "charging"
// mood for Bara while he reasons. Hand-authored — easy to tweak the grids below.

(function () {
  const PAL = {
    ".": null, // transparent
    o: "#0a1730", // dark outline
    c: "#8fd6ff", // Kappy cyan body / Bara visor
    w: "#ffffff", // eye white
    e: "#0a1730", // pupil (same as outline)
    p: "#ff9ad5", // pink (Kappy)
    d: "#3a6fc4", // Bara deep-blue body
    a: "#9bf0ff", // bright accent core
  };

  const KAPPY_IDLE = [
    ".......oo.......",
    ".......pp.......",
    "......oooo......",
    "....ooccccoo....",
    "...occcccccco...",
    "..occcccccccco..",
    "..occwwccwwcco..",
    "..occweccewcco..",
    "..occcccccccco..",
    "..ocpccccccpco..",
    "..occcccccccco..",
    "...occcccccco...",
    "....ooccccoo....",
    "......o..o......",
    ".....oo..oo.....",
    "................",
  ];
  const KAPPY_BLINK = KAPPY_IDLE.slice();
  KAPPY_BLINK[6] = "..occcccccccco..";
  KAPPY_BLINK[7] = "..occeecceecco..";

  const BARA_IDLE = [
    "................",
    "....oddddddo....",
    "...oddddddddo...",
    "..oddddddddddo..",
    "..odccccccccdo..",
    "..odcaaccaacdo..",
    "..oddddddddddo..",
    ".oddddddddddddo.",
    "oddddaaaaaaddddo",
    "oddddddaaddddddo",
    "oddddddddddddddo",
    ".oddddddddddddo.",
    "..oddddddddddo..",
    "..oddd....dddo..",
    "..oooo....oooo..",
    "................",
  ];
  const BARA_BLINK = BARA_IDLE.slice();
  BARA_BLINK[4] = "..oddddddddddo..";
  BARA_BLINK[5] = "..oddddddddddo..";

  const CHARS = {
    kappy: { w: 16, h: 16, idle: KAPPY_IDLE, blink: KAPPY_BLINK },
    bara: { w: 16, h: 16, idle: BARA_IDLE, blink: BARA_BLINK },
  };

  // Pad/truncate a row to width so a miscount never breaks rendering.
  function norm(rows, w) {
    return rows.map((r) => (r.length >= w ? r.slice(0, w) : r + ".".repeat(w - r.length)));
  }

  function svgFor(def, frame, scale) {
    const w = def.w, h = def.h;
    const rows = norm(frame, w);
    let rects = "";
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const col = PAL[rows[y][x]];
        if (col) rects += `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${col}"/>`;
      }
    }
    const px = w * scale;
    return `<svg width="${px}" height="${px}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
  }

  function mount(el, name, opts = {}) {
    const def = CHARS[name];
    if (!el || !def) return null;
    const scale = opts.scale || 4;
    el.classList.add("ksprite");
    if (opts.mood) el.classList.add(opts.mood);
    el.innerHTML = svgFor(def, def.idle, scale);

    let blinkTimer = null, restoreTimer = null;
    const loop = () => {
      el.innerHTML = svgFor(def, def.blink, scale);
      restoreTimer = setTimeout(() => { el.innerHTML = svgFor(def, def.idle, scale); }, 130);
      blinkTimer = setTimeout(loop, 2600 + Math.random() * 2400); // staggered, natural blinks
    };
    blinkTimer = setTimeout(loop, 1800 + Math.random() * 1600);

    el._kbStop = () => { clearTimeout(blinkTimer); clearTimeout(restoreTimer); };
    return el;
  }

  function autoMount() {
    document.querySelectorAll("[data-char]").forEach((el) => mount(el, el.dataset.char, { scale: Number(el.dataset.scale) || 4 }));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoMount);
  else autoMount();

  window.KappaSprites = { mount, svgFor, CHARS };
})();
