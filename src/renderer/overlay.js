// Bildschirmrand-Glow (WebGL) und "Hier klicken"-Hinweise.
// Startwerte aus dem Plan; in Phase 1 an Googlebook-Aufnahmen kalibrierbar (siehe TUNING).
const TUNING = {
  widthPx: 34, // Breite des weichen Glows am Rand
  rotationPerSec: 0.25, // Umdrehungen der Farbstopps pro Sekunde (≈ 4 s pro Runde)
  introIn: 340, // ms bis volle Helligkeit
  introHold: 900, // ms bunt
  introBlue: 450, // ms Übergang zu Blau
  introOut: 500, // ms Ausblenden
  fade: 400, // ms Ausblenden (outro/off)
  liveBase: 0.55, // Grundhelligkeit während Live
  holdLevel: 0.6, // Helligkeit, solange das Fenster offen bleibt
  pointerTimeout: 12000 // ms, bis ein Klick-Hinweis verschwindet
};

const canvas = document.getElementById('glow');
const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
const FRAG = `
precision highp float;
uniform vec2 uRes; uniform float uTime, uIntensity, uBlue, uLevel, uWidth;
const vec3 B = vec3(0.259, 0.522, 0.957);
const vec3 R = vec3(0.918, 0.263, 0.208);
const vec3 Y = vec3(0.984, 0.737, 0.016);
const vec3 G = vec3(0.204, 0.659, 0.325);
vec3 pal(float t) {
  t = fract(t);
  // Blau dominiert: zwei Segmente Blau, dann Rot, Gelb, Grün.
  if (t < 0.25) return B;
  if (t < 0.45) return mix(B, R, smoothstep(0.25, 0.45, t));
  if (t < 0.65) return mix(R, Y, smoothstep(0.45, 0.65, t));
  if (t < 0.85) return mix(Y, G, smoothstep(0.65, 0.85, t));
  return mix(G, B, smoothstep(0.85, 1.0, t));
}
void main() {
  vec2 p = gl_FragCoord.xy;
  float d = min(min(p.x, uRes.x - p.x), min(p.y, uRes.y - p.y));
  vec2 c = (p - uRes * 0.5) / uRes;
  float ang = atan(c.y, c.x) / 6.2831853 + 0.5;
  // Wellen, die vom Rand nach innen laufen.
  float wave = 0.5 + 0.5 * sin(ang * 18.85 + uTime * 1.7) * sin(ang * 31.4 - uTime * 1.1);
  float w = uWidth * (0.7 + (0.5 + 1.6 * uLevel) * wave);
  float a = exp(-d / w) * 0.85 + exp(-d / (uWidth * 0.18)) * 0.55;
  vec3 col = mix(pal(ang + uTime * ${TUNING.rotationPerSec.toFixed(3)}), B, uBlue);
  float alpha = clamp(a * uIntensity, 0.0, 1.0);
  gl_FragColor = vec4(col * alpha, alpha);
}`;

// Fallback ohne WebGL (z. B. GPU blockiert): weicher CSS-Rand in den vier Farben.
let fallback = null;
let draw;
if (gl) {
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = Object.fromEntries(
    ['uRes', 'uTime', 'uIntensity', 'uBlue', 'uLevel', 'uWidth'].map((n) => [n, gl.getUniformLocation(prog, n)])
  );
  draw = (now) => {
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, now / 1000);
    gl.uniform1f(U.uIntensity, intensity);
    gl.uniform1f(U.uBlue, blue);
    gl.uniform1f(U.uLevel, level);
    gl.uniform1f(U.uWidth, TUNING.widthPx * (window.devicePixelRatio || 1));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
} else {
  fallback = document.createElement('div');
  fallback.style.cssText = 'position:fixed;inset:0;pointer-events:none;opacity:0';
  document.body.appendChild(fallback);
  draw = (now) => {
    const w = TUNING.widthPx * (1 + level);
    const c = blue > 0.5 ? ['#4285F4', '#4285F4', '#4285F4', '#4285F4'] : ['#4285F4', '#EA4335', '#FBBC04', '#34A853'];
    const r = Math.floor((now / 1000 / (1 / TUNING.rotationPerSec)) * 4) % 4;
    const k = (i) => c[(i + r) % 4];
    fallback.style.boxShadow =
      `inset ${w}px 0 ${w * 1.5}px -${w / 2}px ${k(0)}, inset 0 ${w}px ${w * 1.5}px -${w / 2}px ${k(1)}, ` +
      `inset -${w}px 0 ${w * 1.5}px -${w / 2}px ${k(2)}, inset 0 -${w}px ${w * 1.5}px -${w / 2}px ${k(3)}`;
    fallback.style.opacity = intensity.toFixed(3);
  };
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
}
addEventListener('resize', resize);
resize();

// ---------- Zustände ----------
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

let mode = 'off';
let modeStart = 0;
let fadeFrom = 0;
let intensity = 0;
let blue = 0;
let level = 0;
let targetLevel = 0;
let running = false;

function setMode(m) {
  fadeFrom = intensity;
  mode = m;
  modeStart = performance.now();
  if (m !== 'off' && m !== 'outro') blue = 0;
  start();
}

function computeIntensity(now) {
  const t = now - modeStart;
  const T = TUNING;
  switch (mode) {
    case 'intro': {
      if (t < T.introIn) {
        blue = 0;
        return fadeFrom + (1 - fadeFrom) * easeOut(t / T.introIn);
      }
      if (t < T.introIn + T.introHold) {
        blue = 0;
        return 1;
      }
      const t2 = t - T.introIn - T.introHold;
      if (t2 < T.introBlue) {
        blue = easeInOut(t2 / T.introBlue);
        return 1 - 0.3 * blue;
      }
      const t3 = t2 - T.introBlue;
      blue = 1;
      if (t3 < T.introOut) return 0.7 * (1 - easeInOut(t3 / T.introOut));
      mode = 'off';
      return 0;
    }
    case 'hold': {
      // Solange das Gemini-Fenster offen ist: aufleuchten, dann ruhig weiterglühen.
      blue = 0;
      if (t < T.introIn) return fadeFrom + (1 - fadeFrom) * easeOut(t / T.introIn);
      const t2 = Math.min(1, (t - T.introIn) / 700);
      return 1 - (1 - T.holdLevel) * easeInOut(t2);
    }
    case 'live':
      return Math.min(1, fadeFrom + (T.liveBase + 0.45 * level - fadeFrom) * easeOut(Math.min(1, t / T.introIn)));
    case 'outro':
      blue = Math.min(1, blue + 0.04);
    // fallthrough
    case 'off':
    default:
      return fadeFrom * (1 - easeInOut(Math.min(1, t / T.fade)));
  }
}

function frame(now) {
  level += (targetLevel - level) * 0.18;
  intensity = computeIntensity(now);
  draw(now);
  if (intensity <= 0.001 && (mode === 'off' || mode === 'outro') && performance.now() - modeStart > TUNING.fade) {
    running = false;
    if (!document.querySelector('.pointer')) window.api.overlayIdle();
    return;
  }
  requestAnimationFrame(frame);
}

function start() {
  if (running) return;
  running = true;
  requestAnimationFrame(frame);
}

window.api.onGlowMode((m) => setMode(m));
window.api.onGlowLevel((v) => {
  targetLevel = Math.max(0, Math.min(1, v));
});

// ---------- Klick-Hinweise ----------
function clearPointers() {
  document.querySelectorAll('.pointer').forEach((el) => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 280);
  });
}

window.api.onPointerShow(({ x, y, label }) => {
  clearPointers();
  const el = document.createElement('div');
  el.className = 'pointer';
  const px = (Math.max(0, Math.min(1000, x)) / 1000) * innerWidth;
  const py = (Math.max(0, Math.min(1000, y)) / 1000) * innerHeight;
  el.style.left = px + 'px';
  el.style.top = py + 'px';
  if (px > innerWidth - 420) el.classList.add('left');
  el.innerHTML = '<div class="pulse"></div><div class="ring"></div><div class="dot"></div>';
  if (label) {
    const l = document.createElement('div');
    l.className = 'label';
    l.textContent = label;
    el.appendChild(l);
  }
  document.body.appendChild(el);
  setTimeout(() => {
    if (el.isConnected) {
      el.classList.add('out');
      setTimeout(() => el.remove(), 280);
    }
  }, TUNING.pointerTimeout);
});

window.api.onPointerClear(clearPointers);
