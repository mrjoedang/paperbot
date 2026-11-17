// Demo on the 3D device: someone asks a research question.
// While it listens, the device shows REC (as the real one does) and the page shows live captions of what is
// being "said". Then it sends, the screen refreshes like e-paper, and a card shows the research running
// (sped up) and the short report that comes back.
import { screen, beep, warmAudio } from './screen.js';

const mv = document.getElementById('mv');
const caption = document.getElementById('caption');
const cards = document.getElementById('cards');
const label = document.getElementById('hold-label');
const s = screen(mv);
// The page opens with a still image of exactly this view (same camera, same screen); once the 3D model has
// drawn its first frame, the still fades out underneath. The device's size follows the stage height, so the
// still lines up at any window size.
s.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector('.stage').classList.add('ready'))));
s.preload(['rec', 'sending', 'tooshort', 'work-dishwasher', 'done-dishwasher', 'work-gift', 'done-gift', 'work-bike', 'done-bike', 'work-sleep', 'done-sleep']);

// "See it on your desk" sits with the laptop and phone, outside the viewer, and opens the same device in AR.
// model-viewer picks an AR mode once the model loads; with none (desktops) the button stays hidden.
const ar = document.getElementById('ar');
const showAR = () => { ar.hidden = !mv.canActivateAR; };
mv.addEventListener('load', showAR);
showAR();
ar.addEventListener('click', () => mv.activateAR());

const IDLE = '24deg 80deg 0.19m', FACING = '4deg 84deg 0.185m';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// the web app's own icons (24-unit outline family)
const ICON = {
  todo: 'M9 11l3 3 8-9M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9',
  reminder: 'M12 8v4l3 2M21 13a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 3 1 5M21 3l2 2',
  work: 'M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M4 7h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2ZM2 12a24 24 0 0 0 20 0M12 12v3',
  note: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6M8 12h8M8 16h5',
};
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[name]}"/></svg>`;

// Life admin you'd fire off while working and check on later: paperbot's research agent reads around in the
// background, then writes a short report.
// The device screens were rendered with the firmware's own Bolt layout (see README).
const MEMOS = [
  { said: 'My dishwasher’s about eight years old and leaking. Should I fix it or just get a new one?',
    title: 'Fix or replace the dishwasher', frame: 'dishwasher', minutes: 6,
    summary: 'At eight years old, replacing usually makes sense, unless it’s a cheap part like the door seal.',
    points: ['Most dishwashers last around ten years',
             'If the repair costs more than half a new one, replace it',
             'A worn door seal is the most common cause of leaks'] },
  { said: 'Can you find gift ideas for my mom? She just retired and is really into gardening.',
    title: 'Gift ideas for Mom', frame: 'gift', minutes: 5,
    summary: 'Three she’d likely use every week: good pruners, a garden kneeler, or a seed subscription.',
    points: ['Bypass pruners are the one tool most gardeners wish they’d upgraded sooner',
             'A kneeler that flips into a seat is easier on the knees',
             'A seed subscription keeps arriving all year'] },
  { said: 'I want to start biking to work. What should I look for in a beginner bike?',
    title: 'A beginner bike for commuting', frame: 'bike', minutes: 7,
    summary: 'A hybrid with an aluminum frame and wider tires suits a commute better than a road bike.',
    points: ['Disc brakes are worth it if you’ll ride in the rain',
             'Get fitted at a local shop; the right size matters more than the parts',
             'Leave room in the budget for a lock, lights and fenders'] },
  { said: 'Why do I keep waking up at 3am? See if there’s anything I can actually do about it.',
    title: 'Waking up at 3am', frame: 'sleep', minutes: 6,
    summary: 'Keep the same wake-up time every day, skip caffeine after noon, and go easy on evening drinks.',
    points: ['Waking briefly at night is normal; staying awake is the part to fix',
             'If you’re up for twenty minutes, get up and read somewhere dim',
             'Morning daylight helps reset your body clock'] },
];

let n = 0, timers = [], memo = null, words = [], spoken = 0, startedAt = 0, energy = 0;
const later = (fn, ms) => timers.push(setTimeout(fn, ms));
const clear = () => { timers.forEach(clearTimeout); timers = []; };
const setState = (st) => { document.documentElement.dataset.device = st; };   // idle | rec | sending | filed
setState('idle');

function addWord() {
  if (spoken >= words.length) return false;
  const w = document.createElement('span');
  w.className = 'w';
  w.textContent = words[spoken++];
  caption.append(w);
  energy = 1;
  return true;
}

// The card: research in progress (a progress bar, sped up for the demo), then a short report.
const RESEARCH_MS = reduced ? 1000 : 2200;
function card(m) {
  const el = document.createElement('article');
  el.className = 'card';
  el.innerHTML = `<div class="kind">${svg('work')}<span>Research</span><time>just now</time></div><h3></h3>
    <div class="progress"><p class="meta wait">Researching</p>
      <div class="track"><i></i></div></div>`;
  el.querySelector('h3').textContent = m.title;
  cards.replaceChildren(el);
  const fill = el.querySelector('.track i');
  const t0 = performance.now();
  const step = () => {
    const f = Math.min((performance.now() - t0) / RESEARCH_MS, 1);
    fill.style.width = `${Math.round(f * 100)}%`;
    if (f < 1) later(step, 90 + Math.random() * 90);
    else report(el, m);
  };
  step();
  return el;
}
function report(el, m) {
  const r = document.createElement('div');
  r.className = 'report';
  r.innerHTML = '<p class="summary"></p><ul></ul>';
  r.querySelector('.summary').textContent = m.summary;
  for (const pt of m.points) { const li = document.createElement('li'); li.textContent = pt; r.querySelector('ul').append(li); }
  el.querySelector('.progress').replaceWith(r);
  el.querySelector('.kind time').textContent = `${m.minutes} min`;
}

// Fake audio spectrum in the button while it listens: louder right after each word, quieter in the pauses.
const BARS = 19;
const spectrum = document.querySelector('.spectrum');
for (let i = 0; i < BARS; i++) spectrum.append(document.createElement('i'));
const bars = [...spectrum.children];
let raf = 0, last = 0, level = 0;
function drawSpectrum(t) {
  const dt = Math.min((t - last) / 1000, 0.05); last = t;
  energy *= Math.pow(0.12, dt);                       // each word's burst fades over about a second
  level += ((0.3 + energy * 0.7) - level) * Math.min(dt * 14, 1);
  bars.forEach((b, i) => {
    const centre = 1 - Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2);     // taller in the middle
    const wobble = 0.5 + 0.5 * Math.abs(Math.sin(t / 80 + i * 1.7) * Math.sin(t / 143 + i * 0.6));
    b.style.transform = `scaleY(${Math.min(1, Math.max(0.14, level * (0.45 + 0.55 * centre) * wobble * 1.5 + Math.random() * 0.12 * level))})`;
  });
  raf = requestAnimationFrame(drawSpectrum);
}
const spectrumOn = () => { energy = 0; level = 0; last = performance.now(); if (!reduced) raf = requestAnimationFrame(drawSpectrum); };
const spectrumOff = () => cancelAnimationFrame(raf);

// One click plays a whole memo: it listens while a sentence is "said", stops on its own at the end of the
// sentence, then sends and files it. Clicking again while it listens stops it early.
const btn = document.getElementById('hold');
let listening = false, sending = false, tick = 0, run = 0;

// The demo answers the press, not the release (a click fires a beat later). A tap may turn into a scroll,
// so on touch only the beep comes on press and the demo starts with the click. Keyboard clicks start it too.
let pressBeep = null, pressAt = -Infinity, pointer = '';
btn.addEventListener('pointerdown', (event) => {
  pointer = event.pointerType;
  if (event.button !== 0 || sending) return;
  if (pointer !== 'touch') return listening ? stop() : start();
  if (!listening) { pressBeep = beep(); pressAt = performance.now(); }
});

function start() {
  const heard = performance.now() - pressAt < 1500 ? pressBeep : beep();
  pressAt = -Infinity;
  const id = ++run;
  clear();
  listening = true;
  btn.classList.add('down');
  btn.setAttribute('aria-pressed', 'true');
  setState('rec');
  mv.cameraOrbit = FACING;
  btn.setAttribute('aria-label', 'Listening. Click to stop');
  spectrumOn();
  const old = cards.querySelector('.card');
  if (old) { old.classList.add('leaving'); later(() => old.remove(), 260); }
  memo = MEMOS[n % MEMOS.length];
  words = memo.said.split(' ');
  spoken = 0;
  startedAt = performance.now();
  caption.classList.remove('done');
  caption.textContent = '';
  // the device's screen turns to REC as its beep is heard, so on Bluetooth headphones (the sound ~170 ms
  // late) sound and screen still land together, like the device reacting; the button itself reacts at once
  heard.then((at) => {
    if (id !== run || !listening) return;
    later(() => {
      s.show('rec', 0);
      tick = setInterval(() => s.show('rec', Math.floor((performance.now() - startedAt) / 1000)), 200);
    }, at - performance.now());
  });
  // the beep, then they start talking; when the sentence is done, a short pause and it stops by itself
  const speakThenStop = () => {
    if (addWord()) later(speakThenStop, 170 + Math.random() * 50 + (/[,.?]$/.test(words[spoken - 1]) ? 80 : 0));
    else later(stop, 250);
  };
  later(speakThenStop, 220);
}

function stop() {
  if (!listening) return;
  listening = false;
  clear();
  clearInterval(tick);
  btn.classList.remove('down');
  btn.setAttribute('aria-pressed', 'false');
  spectrumOff();
  btn.removeAttribute('aria-label');
  btn.setAttribute('aria-label', 'Sending');
  sending = true;
  btn.classList.add('busy');
  if (spoken === 0) {                       // stopped before a word was said
    sending = false; btn.classList.remove('busy'); btn.removeAttribute('aria-label');
    setState('idle');
    caption.textContent = '';
    s.show('tooshort', { flash: true });
    return;
  }
  n++;
  const m = memo;
  // stopped mid-sentence? the rest of the words land quickly, as the full transcript comes back
  const rest = words.length - spoken;
  const catchUp = () => { if (addWord()) later(catchUp, reduced ? 0 : 45); };
  catchUp();
  setState('sending');
  s.show('sending');
  later(() => {
    setState('filed');
    sending = false; btn.classList.remove('busy'); btn.removeAttribute('aria-label');
    caption.classList.add('done');
    later(() => { caption.textContent = ''; caption.classList.remove('done'); }, 400);
    s.show('work-' + m.frame, { flash: true });
    card(m);
    later(() => s.show('done-' + m.frame, { flash: true }), RESEARCH_MS + 150);
    later(() => setState('idle'), RESEARCH_MS + 2500);
    later(() => { mv.cameraOrbit = IDLE; }, RESEARCH_MS + 6000);
  }, 500 + rest * 40);
}

btn.setAttribute('aria-pressed', 'false');
btn.addEventListener('click', (event) => {
  if (sending || (event.detail > 0 && pointer !== 'touch')) return;   // a mouse or pen press already did it
  listening ? stop() : start();
});

// iOS Safari only shows :active (the buttons' press state) on pages that listen for touches.
document.addEventListener('touchstart', () => {}, { passive: true });

// Set up device opens setup in this tab: show it's on its way until the next page takes over.
const setup = document.querySelector('.setup-btn');
setup?.addEventListener('click', (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  setup.classList.add('loading');
  setup.setAttribute('aria-busy', 'true');
});
// back to this page from the browser's back/forward cache: the button is ready again
addEventListener('pageshow', () => { setup?.classList.remove('loading'); setup?.removeAttribute('aria-busy'); });

// the beep's audio, made while the page is idle so the first click doesn't wait for it
(window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1500)))(warmAudio);
