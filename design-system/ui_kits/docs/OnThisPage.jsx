function OnThisPage() {
  return (
    <aside className="on-this-page">
      <h4>On this page</h4>
      <ul>
        <li><a href="#route">The route_task tool</a></li>
        <li><a href="#grok" className="current">Configure inside Grok</a></li>
        <li><a href="#classes">Celestial classes</a></li>
      </ul>
    </aside>
  );
}

window.OnThisPage = OnThisPage;
