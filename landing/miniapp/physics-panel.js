// Shared renderer for the orbital-dynamics + optical-properties sections.
// Used by both the main miniapp's skill detail panel and the vision lab's
// in-stage panel — single source of truth for the physics UI.

const escapeHTML = (s) => String(s).replace(/[&<>"']/g, c =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]))

// Wavelength (nm) → CSS rgb. Standard CIE-style approximation.
function nmToRGB(nm) {
  let r = 0, g = 0, b = 0
  if      (nm >= 380 && nm < 440) { r = -(nm - 440) / 60; g = 0; b = 1 }
  else if (nm < 490)              { r = 0; g = (nm - 440) / 50; b = 1 }
  else if (nm < 510)              { r = 0; g = 1; b = -(nm - 510) / 20 }
  else if (nm < 580)              { r = (nm - 510) / 70; g = 1; b = 0 }
  else if (nm < 645)              { r = 1; g = -(nm - 645) / 65; b = 0 }
  else if (nm <= 750)             { r = 1; g = 0; b = 0 }
  return `rgb(${(r*255)|0},${(g*255)|0},${(b*255)|0})`
}

const physBar = (label, val) => `
  <span class="label">${escapeHTML(label)}</span>
  <span class="bar"><span class="bar-fill phys" style="width:${(val * 100).toFixed(0)}%"></span></span>
  <span class="val">${val.toFixed(2)}</span>`

// Bar normaliser for non-[0,1] orbital values.
const orbitalBar = (label, val, max, unit, decimals = 2) => `
  <span class="label">${escapeHTML(label)}</span>
  <span class="bar"><span class="bar-fill phys" style="width:${(Math.min(val, max) / max * 100).toFixed(0)}%"></span></span>
  <span class="val">${val.toFixed(decimals)}${unit ? ' ' + unit : ''}</span>`

export function renderPhysicsPanel(skill) {
  const phys = skill?.classification?.physics || {}
  const orb  = phys.orbital
  const opt  = phys.optical
  if (!orb && !opt) return ''

  return `
    ${orb ? `
      <h4>Orbital dynamics</h4>
      <div class="score-breakdown">
        ${orbitalBar('semi_major_axis', orb.semi_major_axis, 7,         'AU',  2)}
        ${orbitalBar('eccentricity',    orb.eccentricity,    1,         '',    3)}
        ${orbitalBar('inclination',     orb.inclination,     Math.PI/2, 'rad', 3)}
        ${orbitalBar('orbital_period',  orb.orbital_period,  18,        'yr',  2)}
        ${orbitalBar('perihelion',      orb.perihelion,      7,         'AU',  2)}
        ${orbitalBar('aphelion',        orb.aphelion,        14,        'AU',  2)}
        ${orbitalBar('mean_anomaly',    orb.mean_anomaly,    2*Math.PI, 'rad', 3)}
      </div>
    ` : ''}

    ${opt ? `
      <h4 style="margin-top:18px">Optical properties</h4>
      <div class="score-breakdown">
        <span class="label">wavelength</span>
        <span class="bar"><span class="bar-fill phys" style="width:${((opt.wavelength - 380) / (750 - 380) * 100).toFixed(0)}%"></span></span>
        <span class="val"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;vertical-align:middle;margin-right:4px;background:${nmToRGB(opt.wavelength)};box-shadow:0 0 6px ${nmToRGB(opt.wavelength)}"></span>${opt.wavelength} nm</span>
        ${physBar('polarization',  opt.polarization ?? 0)}
        ${physBar('amplitude',     opt.amplitude    ?? 0)}
        ${orbitalBar('phase',      opt.phase ?? 0,  2*Math.PI, 'rad', 3)}
      </div>
    ` : ''}
  `
}
