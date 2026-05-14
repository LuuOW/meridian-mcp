function HeroOrbits() {
  return (
    <svg className="hero-orbits" viewBox="0 0 800 800" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="meridianCore">
          <stop offset="0%"  stopColor="#a78bfa" stopOpacity="0.85"/>
          <stop offset="55%" stopColor="#a78bfa" stopOpacity="0.18"/>
          <stop offset="100%" stopColor="#a78bfa" stopOpacity="0"/>
        </radialGradient>
      </defs>
      <circle cx="400" cy="400" r="160" fill="url(#meridianCore)"/>
      <g>
        <circle cx="400" cy="400" r="140" fill="none" stroke="rgba(167,139,250,0.22)" strokeDasharray="1 5"/>
        <circle cx="540" cy="400" r="6" fill="#7dd3fc">
          <animateTransform attributeName="transform" type="rotate" from="0 400 400" to="360 400 400" dur="22s" repeatCount="indefinite"/>
        </circle>
      </g>
      <g>
        <circle cx="400" cy="400" r="220" fill="none" stroke="rgba(56,189,248,0.18)" strokeDasharray="1 7"/>
        <circle cx="180" cy="400" r="5" fill="#cbd5e1">
          <animateTransform attributeName="transform" type="rotate" from="360 400 400" to="0 400 400" dur="38s" repeatCount="indefinite"/>
        </circle>
      </g>
      <g>
        <circle cx="400" cy="400" r="300" fill="none" stroke="rgba(167,139,250,0.14)" strokeDasharray="1 9"/>
        <circle cx="700" cy="400" r="4" fill="#c4b5fd">
          <animateTransform attributeName="transform" type="rotate" from="0 400 400" to="360 400 400" dur="58s" repeatCount="indefinite"/>
        </circle>
        <circle cx="100" cy="400" r="4" fill="#c4b5fd">
          <animateTransform attributeName="transform" type="rotate" from="0 400 400" to="360 400 400" dur="58s" repeatCount="indefinite"/>
        </circle>
      </g>
      <g>
        <ellipse cx="400" cy="400" rx="370" ry="200" fill="none" stroke="rgba(244,114,182,0.10)" strokeDasharray="1 12"/>
        <circle cx="770" cy="400" r="3" fill="#f9a8d4">
          <animateTransform attributeName="transform" type="rotate" from="0 400 400" to="360 400 400" dur="84s" repeatCount="indefinite"/>
        </circle>
      </g>
    </svg>
  );
}

function Hero() {
  const heroRef = React.useRef(null);
  React.useEffect(() => {
    const el = heroRef.current;
    if (!el) return;
    let raf = 0, x = 50, y = 35;
    function onMove(e) {
      const r = el.getBoundingClientRect();
      x = ((e.clientX - r.left) / r.width) * 100;
      y = ((e.clientY - r.top) / r.height) * 100;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.style.setProperty('--cursor-x', `${x}%`);
        el.style.setProperty('--cursor-y', `${y}%`);
      });
    }
    el.addEventListener('mousemove', onMove);
    return () => el.removeEventListener('mousemove', onMove);
  }, []);

  return (
    <section className="hero" ref={heroRef}>
      <HeroOrbits />
      <span className="eyebrow eyebrow-live">MCP server · v3.2.0</span>
      <h1 className="hero-title">
        Dynamic task routing<br/>
        <span className="grad">via orbital mechanics.</span>
      </h1>
      <p className="lead hero-lead">
        An LLM writes <em>N</em> candidates per task. A deterministic classifier picks one of six celestial classes by argmax.
      </p>
      <div className="cta-row hero-cta">
        <a href="#" className="btn btn-primary">Try it live →</a>
        <a href="#" className="btn btn-ghost">
          <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor" style={{verticalAlign: '-3px', marginRight: 8}}>
            <path d="M395.479 633.828L735.91 381.105c16.689-12.39 40.544-7.557 48.496 11.687 41.854 101.493 23.155 223.461-60.118 307.204-83.272 83.743-199.137 102.108-305.041 60.281L303.556 814.143c165.934 114.059 367.431 85.852 493.345-40.861 99.875-100.439 130.807-237.345 101.884-360.806l.262.263c-41.942-181.369 10.311-253.865 117.353-402.106 2.53-3.515 5.07-7.03 7.6-10.633L883.144 141.651v-.439L395.392 633.916z"/>
            <path d="M325.226 695.251C206.128 580.84 226.662 403.776 328.285 301.668c75.146-75.571 198.264-106.414 305.741-61.072L749.454 186.994c-20.797-15.114-47.447-31.371-78.03-42.794-138.234-57.206-303.731-28.735-416.101 84.182C147.234 337.081 113.244 504.215 171.613 646.833c43.603 106.59-27.874 181.985-99.875 258.083C46.224 931.893 20.622 958.87 0 987.429L325.139 695.339z"/>
          </svg>
          Add to Grok →
        </a>
      </div>
    </section>
  );
}

window.LandingHero = Hero;
