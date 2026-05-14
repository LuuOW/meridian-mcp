function AskCard({ task, setTask, onAsk, busy }) {
  const examples = [
    'Set up rate limiting on a public API endpoint with Redis',
    'Stake a position on a prediction market on World Chain using ethers.js',
    'Write a SKILL.md authoring guide for new contributors',
    'Run a difference-in-differences analysis on rollout impact',
  ];
  const labels = ['Rate limit a public API', 'DeFi staking on World Chain', 'Author a SKILL.md', 'Causal analysis of a rollout'];

  return (
    <section className="ask-card">
      <div className="input-frame">
        <textarea
          className="task-input"
          placeholder="e.g. Write integration tests for a Stripe webhook handler in a TypeScript Express app"
          rows="3"
          maxLength="800"
          value={task}
          onChange={e => setTask(e.target.value)}
        />
      </div>
      <div className="ask-controls">
        <button className="btn btn-primary" onClick={onAsk} disabled={busy}>
          {busy ? 'Routing…' : 'Find compatible candidates →'}
        </button>
        <button className="ar-pill" type="button" aria-label="Scan a real-world object">
          <span className="ar-pill-icon">📷</span>
          <span className="ar-pill-label">Scan an object</span>
        </button>
      </div>
      <div className="examples">
        <span className="examples-label">Try:</span>
        {examples.map((ex, i) => (
          <button key={i} className="ex-chip" onClick={() => setTask(ex)}>{labels[i]}</button>
        ))}
      </div>
    </section>
  );
}

window.AskCard = AskCard;
