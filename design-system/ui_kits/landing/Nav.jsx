function Nav() {
  return (
    <nav className="nav" aria-label="Primary">
      <a href="#" className="brand">◎ Meridian</a>
      <ul className="nav-inline">
        <li><button className="nav-inline-link" type="button">Apps <span className="caret">▾</span></button></li>
        <li><a href="#" className="nav-inline-link">Docs</a></li>
        <li><a href="#" className="nav-inline-link">Blog</a></li>
      </ul>
      <button className="cmdk-trigger" type="button">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>
        </svg>
        <span className="cmdk-label">Search</span>
        <kbd className="cmdk-kbd">⌘K</kbd>
      </button>
      <a href="#" className="nav-gh-link" aria-label="GitHub">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
          <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.55v-1.94c-3.2.69-3.87-1.55-3.87-1.55-.52-1.34-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11.06 11.06 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.77.11 3.06.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.4-5.25 5.69.41.36.78 1.05.78 2.12v3.14c0 .31.21.66.79.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z"/>
        </svg>
      </a>
      <button className="burger" type="button" aria-label="Toggle nav">
        <span></span><span></span><span></span>
      </button>
    </nav>
  );
}

window.LandingNav = Nav;
