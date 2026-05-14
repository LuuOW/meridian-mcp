function ResultItem({ rank, slug, cls, score, desc, why, onClick }) {
  return (
    <li className="result-item result-item-in" onClick={onClick} tabIndex="0">
      <div className="result-head">
        <span className="result-slug">
          {slug}
          <span className="result-class" data-class={cls}>{cls}</span>
        </span>
        <span className="result-score">{score.toFixed(3)}</span>
      </div>
      <p className="result-desc">{desc}</p>
      <div className="result-why">{why}</div>
    </li>
  );
}

function ResultsList({ candidates, onSelect }) {
  if (!candidates.length) return null;
  return (
    <section className="results-section">
      <div className="results-header">
        <h2>Results</h2>
        <div className="results-meta" role="status">
          {candidates.length} candidates · classifier <span className="conf-strong">strong</span>
        </div>
      </div>
      <ol className="results-list">
        {candidates.map((c, i) => (
          <ResultItem
            key={c.slug}
            rank={i + 1}
            slug={c.slug}
            cls={c.class}
            score={c.route_score}
            desc={c.tagline}
            why={c.why}
            onClick={() => onSelect(c)}
          />
        ))}
      </ol>
    </section>
  );
}

window.ResultsList = ResultsList;
