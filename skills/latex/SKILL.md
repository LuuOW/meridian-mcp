---
name: latex
description: LaTeX and mathematical notation authority — typesetting equations, document structure, AMS math environments, BibTeX citations, arXiv submission formatting, KaTeX/MathJax web rendering, and converting mathematical prose to precise symbolic notation
keywords: ["latex", "ams", "bibtex", "katex", "mathjax", "mathematical", "notation", "authority", "typesetting", "equations", "document", "structure", "math", "environments", "citations", "arxiv", "submission"]
orb_class: moon
---

# latex

Production mathematical typesetting for arXiv preprints, academic papers, and web-rendered equations. Covers the full pipeline from mathematical intuition → LaTeX notation → rendered output, for both document (PDFLaTeX/XeTeX) and web (KaTeX/MathJax) targets.

## Core Math Environments

```latex
% Inline math — use sparingly, only for simple symbols in prose
The energy $E = mc^2$ follows from special relativity.

% Display math — numbered equation
\begin{equation}
  \mathcal{L} = \bar{\psi}(i\gamma^\mu \partial_\mu - m)\psi
  \label{eq:dirac}
\end{equation}

% Unnumbered display
\[
  \hat{H}\psi = E\psi
\]

% Multi-line aligned (align not eqnarray)
\begin{align}
  \nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \\
  \nabla \times \mathbf{B} &= \mu_0 \mathbf{J} + \mu_0\varepsilon_0 \frac{\partial \mathbf{E}}{\partial t}
  \label{eq:maxwell}
\end{align}
```

## Common Physics Notation

```latex
% Quantum operators
\hat{a},\, \hat{a}^\dagger          % annihilation / creation
\langle \psi | \hat{O} | \phi \rangle  % Dirac bracket
\hbar\omega                           % reduced Planck × frequency

% Statistical mechanics
Z = \mathrm{Tr}\left[e^{-\beta \hat{H}}\right]
\langle O \rangle = -\frac{\partial \ln Z}{\partial \lambda}

% General relativity
g_{\mu\nu},\quad R_{\mu\nu} - \tfrac{1}{2}g_{\mu\nu}R + \Lambda g_{\mu\nu} = \frac{8\pi G}{c^4}T_{\mu\nu}

% Information / entropy
S = -\sum_i p_i \ln p_i
\mathcal{I}(\rho) = S(\rho \| \sigma) = \mathrm{Tr}[\rho(\ln\rho - \ln\sigma)]
```

## KaTeX Web Rendering

KaTeX is the correct choice for web — faster than MathJax, same quality for standard notation.

```js
// Lazy-load — only when math detected
let _katex = null
async function renderMath(container) {
  const spans = container.querySelectorAll('.math-block, .math-inline')
  if (!spans.length) return
  if (!_katex) _katex = (await import('https://esm.sh/katex@0.16.11')).default
  spans.forEach(el => {
    el.innerHTML = _katex.renderToString(el.dataset.formula, {
      displayMode:  el.classList.contains('math-block'),
      throwOnError: false,
    })
  })
}
```

```css
/* Dark-theme KaTeX overrides */
.katex { color: #e8ebf2; font-size: 1.05em; }
.math-block {
  display: block; text-align: center;
  padding: 14px; margin: 16px 0;
  background: rgba(139,92,246,0.06);
  border: 1px solid rgba(139,92,246,0.18);
  border-radius: 10px; overflow-x: auto;
}
```

## arXiv Submission Formatting

```latex
\documentclass[12pt]{article}
\usepackage{amsmath, amssymb, amsthm}
\usepackage{hyperref}
\usepackage[numbers]{natbib}

% Required by arXiv: include all source files + .bbl (not .bib)
% Max upload: 50 MB. Figures as EPS/PDF, not PNG/JPEG for vector content.

\begin{document}
\title{Orbital Routing via Physical Analogy}
\author{Author One \and Author Two}
\date{\today}
\maketitle

\begin{abstract}
We present...
\end{abstract}

\section{Introduction}
...

\bibliographystyle{unsrtnat}
\bibliography{refs}   % compile refs.bbl before submission
\end{document}
```

## Symbol Reference

| Symbol | LaTeX | Meaning |
|--------|-------|---------|
| `∇` | `\nabla` | del / gradient |
| `∂` | `\partial` | partial derivative |
| `ℏ` | `\hbar` | reduced Planck |
| `⊗` | `\otimes` | tensor product |
| `†` | `^\dagger` | Hermitian conjugate |
| `≡` | `\equiv` | defined as |
| `≈` | `\approx` | approximately |
| `∈` | `\in` | element of |
| `⟨⟩` | `\langle\rangle` | expectation value |

## Checklist

- [ ] Use `align` not `eqnarray` (avoids spacing bugs)
- [ ] Label every numbered equation — `\label{eq:name}`
- [ ] `\left(`, `\right)` for auto-sizing delimiters
- [ ] `\mathrm{}` for upright text in math (units, operators): `$\mathrm{d}x$`
- [ ] `\text{}` for words inside equations: `$x \text{ if } x > 0$`
- [ ] Never use `$$...$$` in LaTeX documents — use `\[...\]` or `equation` env
- [ ] KaTeX supports `\ce{}` for chemistry via mhchem extension
