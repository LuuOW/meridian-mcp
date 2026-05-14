function Feature({ icon, title, children }) {
  return (
    <article className="feature">
      <div className="feature-icon" aria-hidden="true">{icon}</div>
      <h3>{title}</h3>
      <p>{children}</p>
    </article>
  );
}

function FeaturesGrid() {
  return (
    <section className="features" aria-label="Key features">
      <Feature icon="◎" title="LLM proposes, orbital judges">
        Llama-3.3-70B authors fresh candidates for your task — opinionated bodies with use-it-for, workflow, heuristics. The orbital engine then classifies each one deterministically.
      </Feature>
      <Feature icon="▲" title="Celestial classification">
        Each candidate gets a class — <strong>planet</strong>, <strong>moon</strong>, <strong>trojan</strong>, <strong>asteroid</strong>, <strong>comet</strong>, or <strong>irregular</strong> — based on physics features derived from its content.
      </Feature>
      <Feature icon="⌬" title="Open source core">
        The MCP client is a 5&nbsp;KB stdio shim under MIT. Same backend powers the <a href="#">browser miniapp</a> and the <a href="#">npm package</a>. One source of truth.
      </Feature>
    </section>
  );
}

window.FeaturesGrid = FeaturesGrid;
