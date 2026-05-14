function CtaFinal() {
  return (
    <section className="cta-final">
      <h2>Stop guessing which prompt template fits.</h2>
      <p className="lead">Let the router pick the right expert.</p>
      <div className="cta-row">
        <a href="#" className="btn btn-primary">Read the docs</a>
        <a href="#" className="btn btn-ghost">Star on GitHub</a>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-brand">◎ Meridian</div>
        <div className="footer-links">
          <a href="#">Documentation</a>
          <a href="#">GitHub</a>
          <a href="#">npm</a>
          <a href="#">Contact</a>
        </div>
        <div className="footer-meta">© 2026 Meridian · MIT licensed</div>
      </div>
    </footer>
  );
}

window.CtaFinal = CtaFinal;
window.LandingFooter = Footer;
