function CodeBlock({ tabs }) {
  const [active, setActive] = React.useState(0);
  const [copied, setCopied] = React.useState(false);
  const code = tabs[active].code;

  function copy() {
    navigator.clipboard?.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <div className="codeblock">
      <div className="codeblock-tabs">
        {tabs.map((t, i) => (
          <button key={i} className={'tab' + (i === active ? ' active' : '')} onClick={() => setActive(i)}>{t.label}</button>
        ))}
        <button className={'copy-btn' + (copied ? ' copied' : '')} onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre><code dangerouslySetInnerHTML={{ __html: highlight(code) }} /></pre>
    </div>
  );
}

// Single-pass tokenizer — avoids the regex-soup bug where later replaces
// matched substrings inside earlier-injected <span class="..."> attributes.
const CODE_KEYWORDS = new Set(['npm','npx','install','export','run','claude','mcp','add','node','docker','const','let','function','return','await','async','new']);
const CODE_VERBS = new Set(['GET','POST','PUT','DELETE']);

function highlight(code) {
  const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let out = '';
  let i = 0;
  while (i < esc.length) {
    const ch = esc[i];
    // comment to end of line
    if (ch === '#') {
      let j = esc.indexOf('\n', i);
      if (j === -1) j = esc.length;
      out += '<span class="c">' + esc.slice(i, j) + '</span>';
      i = j;
      continue;
    }
    // string literal
    if (ch === '"') {
      let j = esc.indexOf('"', i + 1);
      if (j === -1) j = esc.length - 1;
      out += '<span class="s">' + esc.slice(i, j + 1) + '</span>';
      i = j + 1;
      continue;
    }
    // word — keyword / verb / plain
    const tail = esc.slice(i);
    const m = /^[A-Za-z_][\w-]*/.exec(tail);
    if (m) {
      const w = m[0];
      if (CODE_KEYWORDS.has(w))      out += '<span class="k">' + w + '</span>';
      else if (CODE_VERBS.has(w))    out += '<span class="v">' + w + '</span>';
      else                           out += w;
      i += w.length;
      continue;
    }
    // anything else (punctuation, whitespace)
    out += ch;
    i++;
  }
  return out;
}

window.CodeBlock = CodeBlock;
