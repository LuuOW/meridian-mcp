function MetaBar() {
  return (
    <div className="meta-bar">
      <span className="quota-pill"><span className="quota-dot"></span>4 / 5 calls today</span>
      <label className="model-pill">
        <span className="model-pill-label">model</span>
        <select defaultValue="llama-3.3-70b">
          <option value="llama-3.3-70b">llama-3.3-70b</option>
          <option value="gpt-4o-mini">gpt-4o-mini</option>
          <option value="phi-4">phi-4</option>
        </select>
      </label>
    </div>
  );
}

window.MetaBar = MetaBar;
