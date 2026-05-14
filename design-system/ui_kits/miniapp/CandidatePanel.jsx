function ScoreBreakdown({ physics, decision }) {
  const entries = Object.entries(physics);
  return (
    <section className="candidate-panel-why">
      <h4>Physics signature · why this class?</h4>
      <div className="score-breakdown">
        {entries.map(([key, val]) => (
          <React.Fragment key={key}>
            <span className="label">{key}</span>
            <span className="bar"><span className="bar-fill phys" style={{ width: `${Math.max(2, val * 100)}%` }}/></span>
            <span className="val">{val.toFixed(2)}</span>
          </React.Fragment>
        ))}
      </div>
      <div className="decision-rule">
        <strong>Decision:</strong> {decision}
      </div>
    </section>
  );
}

function CandidatePanel({ candidate, open, onClose }) {
  if (!candidate) return null;
  return (
    <aside className="candidate-panel" aria-hidden={!open}>
      <div className="candidate-panel-backdrop" onClick={onClose} />
      <div className="candidate-panel-body">
        <header className="candidate-panel-header">
          <div className="candidate-panel-title-row">
            <h3>{candidate.slug}</h3>
            <span className="candidate-panel-class" data-class={candidate.class}>{candidate.class}</span>
          </div>
          <button className="btn-ghost btn-sm" onClick={onClose}>✕</button>
        </header>
        <div className="candidate-panel-scroll">
          <ScoreBreakdown physics={candidate.physics} decision={candidate.decision} />
          <section className="candidate-panel-content">
            <p className="candidate-tagline">{candidate.tagline}</p>
            <div className="candidate-md">
              <h2>Use it for</h2>
              <ul>
                {candidate.useFor.map((u, i) => <li key={i}>{u}</li>)}
              </ul>
              <h2>Workflow</h2>
              <ol>
                {candidate.workflow.map((w, i) => <li key={i}>{w}</li>)}
              </ol>
              {candidate.snippet && (
                <>
                  <h2>Snippet</h2>
                  <pre><code>{candidate.snippet}</code></pre>
                </>
              )}
            </div>
            <div className="candidate-keywords">
              <span className="kw-label">Top token hits</span>
              {candidate.keywords.map(k => <code key={k}>{k}</code>)}
            </div>
          </section>
        </div>
      </div>
    </aside>
  );
}

window.CandidatePanel = CandidatePanel;
