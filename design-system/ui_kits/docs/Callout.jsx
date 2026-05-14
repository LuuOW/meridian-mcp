function Callout({ kind = 'info', title, children }) {
  return (
    <div className={'callout callout-' + kind}>
      <div className="callout-icon" aria-hidden="true">
        {kind === 'info' && '◇'}
        {kind === 'warn' && '!'}
        {kind === 'success' && '✓'}
      </div>
      <div className="callout-body">
        {title && <h5 className="callout-title">{title}</h5>}
        <div>{children}</div>
      </div>
    </div>
  );
}

window.Callout = Callout;
