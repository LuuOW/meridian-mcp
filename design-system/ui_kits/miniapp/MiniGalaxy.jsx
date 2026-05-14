// Simplified mini-galaxy: 2D mode of the production mini-galaxy.js.
// Renders the orbit + central star + candidate planets, twinkling stars.

const RING_COLORS = [
  { ring: 'rgba(167, 139, 250, 0.55)', planet: '#c4b5fd', glow: 'rgba(167, 139, 250, 0.45)' },
  { ring: 'rgba(56, 189, 248, 0.55)',  planet: '#7dd3fc', glow: 'rgba(56, 189, 248, 0.45)' },
  { ring: 'rgba(16, 185, 129, 0.55)',  planet: '#6ee7b7', glow: 'rgba(16, 185, 129, 0.45)' },
  { ring: 'rgba(244, 114, 182, 0.55)', planet: '#f9a8d4', glow: 'rgba(244, 114, 182, 0.45)' },
  { ring: 'rgba(251, 191, 36, 0.55)',  planet: '#fcd34d', glow: 'rgba(251, 191, 36, 0.45)' },
];

function MiniGalaxy({ candidates, onPlanetClick }) {
  const canvasRef = React.useRef(null);
  const stateRef  = React.useRef({ t: 0, stars: null, hover: null, candidates: [] });
  stateRef.current.candidates = candidates;
  stateRef.current.onPlanetClick = onPlanetClick;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const state = stateRef.current;
    state.stars = Array.from({ length: 180 }, () => ({
      x: Math.random(), y: Math.random(),
      r: 0.4 + Math.random() * 1.4, tw: Math.random() * Math.PI * 2,
      hue: Math.random() < 0.18 ? 'cyan' : (Math.random() < 0.4 ? 'violet' : 'white'),
    }));

    function resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      canvas.width = r.width * dpr; canvas.height = r.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      canvas._w = r.width; canvas._h = r.height;
    }
    const ro = new ResizeObserver(resize); ro.observe(canvas); resize();

    function planetPositions() {
      const cx = canvas._w / 2, cy = canvas._h / 2;
      const ru = Math.min(canvas._w, canvas._h * 2.4) * 0.13;
      return state.candidates.slice(0, 5).map((c, i) => {
        const orbit = 1 + i * 0.55;
        const speed = 0.18 - i * 0.018;
        const phase = i * 0.9 + ((i * 0.37) % 1);
        const a = state.t * speed + phase;
        return {
          slug: c.slug,
          x: cx + Math.cos(a) * orbit * ru,
          y: cy + Math.sin(a) * orbit * ru,
          size: Math.max(2.4, 6 - i * 0.45),
          orbit: orbit * ru, color: RING_COLORS[i % RING_COLORS.length],
        };
      });
    }

    function hit(mx, my) {
      const ps = planetPositions();
      let best = null, bestD = Infinity;
      for (const p of ps) {
        const d = Math.hypot(mx - p.x, my - p.y);
        if (d <= p.size + 8 && d < bestD) { best = p; bestD = d; }
      }
      return best;
    }

    function onMove(e) {
      const r = canvas.getBoundingClientRect();
      const h = hit(e.clientX - r.left, e.clientY - r.top);
      state.hover = h ? h.slug : null;
      canvas.style.cursor = h ? 'pointer' : 'default';
    }
    function onClick(e) {
      const r = canvas.getBoundingClientRect();
      const h = hit(e.clientX - r.left, e.clientY - r.top);
      if (h && state.onPlanetClick) state.onPlanetClick(h.slug);
    }
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', () => { state.hover = null; canvas.style.cursor = 'default'; });
    canvas.addEventListener('click', onClick);

    let lastT = 0, raf = 0;
    function loop(now) {
      const dt = Math.min(0.06, (now - lastT) / 1000); lastT = now;
      state.t += dt;
      draw();
      raf = requestAnimationFrame(loop);
    }
    function draw() {
      const w = canvas._w, h = canvas._h;
      if (!w || !h) return;
      // bg
      const g = ctx.createRadialGradient(w*0.5, h*0.4, 0, w*0.5, h*0.5, Math.max(w,h)*0.85);
      g.addColorStop(0, 'rgba(28,22,50,1)'); g.addColorStop(0.5, 'rgba(12,13,30,1)'); g.addColorStop(1, 'rgba(6,8,15,1)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      const n = ctx.createRadialGradient(w*0.7, h*0.3, 0, w*0.7, h*0.3, Math.max(w,h)*0.5);
      n.addColorStop(0, 'rgba(167,139,250,0.18)'); n.addColorStop(1, 'rgba(167,139,250,0)');
      ctx.fillStyle = n; ctx.fillRect(0, 0, w, h);
      const n2 = ctx.createRadialGradient(w*0.2, h*0.75, 0, w*0.2, h*0.75, Math.max(w,h)*0.45);
      n2.addColorStop(0, 'rgba(56,189,248,0.12)'); n2.addColorStop(1, 'rgba(56,189,248,0)');
      ctx.fillStyle = n2; ctx.fillRect(0, 0, w, h);
      // stars
      for (const s of state.stars) {
        const tw = (Math.sin(state.t * 1.4 + s.tw) + 1) * 0.5;
        const a = 0.35 + tw * 0.6;
        const px = ((s.x + state.t * 0.004) % 1) * w; const py = s.y * h;
        const tone = s.hue === 'violet' ? '167,139,250' : s.hue === 'cyan' ? '56,189,248' : '255,255,255';
        ctx.fillStyle = `rgba(${tone},${a})`;
        ctx.beginPath(); ctx.arc(px, py, s.r, 0, Math.PI*2); ctx.fill();
      }
      const cx = w/2, cy = h/2;
      // sun
      const sg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 22);
      sg.addColorStop(0, 'rgba(255,224,156,1)'); sg.addColorStop(0.4, 'rgba(252,211,77,0.55)'); sg.addColorStop(1, 'rgba(252,211,77,0)');
      ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(cx, cy, 22, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = '#fef3c7'; ctx.beginPath(); ctx.arc(cx, cy, 3.2, 0, Math.PI*2); ctx.fill();
      if (!state.candidates.length) {
        ctx.fillStyle = 'rgba(148,163,184,0.45)';
        ctx.font = '11px ui-monospace, monospace'; ctx.textAlign = 'center';
        ctx.fillText('// awaiting query', cx, cy + 56);
        return;
      }
      const ps = planetPositions();
      // orbits
      for (const p of ps) {
        ctx.strokeStyle = p.color.ring; ctx.lineWidth = 0.8;
        ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.arc(cx, cy, p.orbit, 0, Math.PI*2); ctx.stroke();
        ctx.setLineDash([]);
      }
      // planets
      for (const p of ps) {
        const isHover = state.hover === p.slug;
        const gl = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * (isHover ? 4.5 : 3));
        gl.addColorStop(0, p.color.glow); gl.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gl;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (isHover ? 4.5 : 3), 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = p.color.planet;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI*2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.6; ctx.stroke();
        if (isHover) {
          ctx.font = '11px ui-monospace, monospace'; ctx.textAlign = 'center';
          ctx.fillStyle = 'rgba(230,236,245,0.98)';
          ctx.fillText(p.slug, p.x, p.y - p.size - 8);
        }
      }
    }
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return (
    <div className="mini-galaxy-frame">
      <canvas ref={canvasRef} className="mini-galaxy-canvas" aria-label="Routed candidates orbiting" />
      <div className="mini-galaxy-controls">
        <span className="mini-galaxy-label">view</span>
        <div className="mode-toggle" role="tablist">
          <button className="mode-btn active">2D</button>
          <button className="mode-btn">3D</button>
        </div>
      </div>
    </div>
  );
}

window.MiniGalaxy = MiniGalaxy;
