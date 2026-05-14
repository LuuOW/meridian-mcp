function StatsStrip() {
  return (
    <section className="stats" aria-label="By the numbers">
      <div className="stat">
        <div className="stat-num">5</div>
        <div className="stat-label">candidates authored per task</div>
      </div>
      <div className="stat">
        <div className="stat-num">6</div>
        <div className="stat-label">celestial classes, deterministic argmax</div>
      </div>
      <div className="stat">
        <div className="stat-num">70<span className="stat-unit">B</span></div>
        <div className="stat-label">parameter Llama-3.3 author model</div>
      </div>
      <div className="stat">
        <div className="stat-num">5<span className="stat-unit">KB</span></div>
        <div className="stat-label">stdio MCP shim, MIT-licensed</div>
      </div>
    </section>
  );
}

window.StatsStrip = StatsStrip;
