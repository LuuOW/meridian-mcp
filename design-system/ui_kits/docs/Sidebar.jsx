function Sidebar({ active }) {
  const sections = [
    { title: 'Getting started', items: [
      ['Install', 'install'],
      ['Quick start', 'quick'],
      ['Configuration', 'config'],
    ]},
    { title: 'Transports', items: [
      ['stdio (Claude Code / Cursor)', 'stdio'],
      ['HTTP / Streamable', 'http'],
      ['Grok connector', 'grok'],
      ['ChatGPT custom MCP', 'chatgpt'],
    ]},
    { title: 'Routing', items: [
      ['The route_task tool', 'route'],
      ['Celestial classes', 'classes'],
      ['Physics signatures', 'physics'],
      ['Online learning loop', 'learning'],
    ]},
    { title: 'Self-hosting', items: [
      ['Docker', 'docker'],
      ['Pass-through auth', 'auth'],
      ['Gateway mode', 'gateway'],
    ]},
  ];
  return (
    <aside className="docs-sidebar">
      <div className="docs-sidebar-head">
        <a href="#" className="brand">◎ Meridian</a>
        <span className="docs-version">v3.2.0</span>
      </div>
      <nav>
        {sections.map(s => (
          <div className="nav-section" key={s.title}>
            <h4>{s.title}</h4>
            <ul>
              {s.items.map(([label, id]) => (
                <li key={id}>
                  <a href={'#' + id} className={active === id ? 'current' : ''}>{label}</a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}

window.DocsSidebar = Sidebar;
