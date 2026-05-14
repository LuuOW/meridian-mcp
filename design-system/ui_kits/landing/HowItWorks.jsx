function Step({ n, title, children }) {
  return (
    <div className="step">
      <span className="step-num">{n}</span>
      <h4>{title}</h4>
      <p>{children}</p>
    </div>
  );
}

function HowItWorks() {
  return (
    <section className="how">
      <h2>How it works</h2>
      <div className="how-grid">
        <Step n="1" title="LLM authoring">
          Llama-3.3-70B (GitHub Models) writes 5 candidates for your task — full markdown bodies, ~600 chars each, with named tools and decision rules.
        </Step>
        <Step n="2" title="Physics signature">
          For each candidate we derive <code>mass</code>, <code>scope</code>, <code>independence</code>, <code>cross_domain</code>, <code>fragmentation</code>, <code>drag</code>, and <code>dep_ratio</code> — from content alone.
        </Step>
        <Step n="3" title="Class + score">
          Argmax over six per-class scores assigns the celestial class. Final ranking = lexical relevance × class boost × Lagrange versatility.
        </Step>
      </div>
    </section>
  );
}

window.HowItWorks = HowItWorks;
