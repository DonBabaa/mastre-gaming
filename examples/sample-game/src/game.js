// Coin Chase: the smallest game that follows every rule of the Mastre contract.

// Rule: every storage key starts with "mastre:<id>:" because all games share one website.
const BEST_KEY = 'mastre:sample-game:best';

// Rule: tell the hub what is going on. Both calls do nothing when the game runs on its own.
const tellHub = (type) => window.parent.postMessage({ type }, '*');

const W = 960;
const H = 540;
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const readBest = () => {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
};

const state = {
  mode: 'title', // title | playing | over
  player: W / 2,
  target: null,
  things: [],
  score: 0,
  lives: 3,
  best: readBest(),
  spawnIn: 0,
  time: 0,
  flash: 0,
};

const keys = new Set();

function start() {
  Object.assign(state, { mode: 'playing', things: [], score: 0, lives: 3, spawnIn: 0.4, time: 0, flash: 0 });
}

function gameOver() {
  state.mode = 'over';
  if (state.score > state.best) {
    state.best = state.score;
    try {
      localStorage.setItem(BEST_KEY, String(state.best));
    } catch { /* storage can be blocked; the game still works */ }
  }
}

function anyInput() {
  if (state.mode !== 'playing') start();
}

window.addEventListener('keydown', (event) => {
  keys.add(event.code);
  if (!event.repeat) anyInput();
  if (event.code.startsWith('Arrow') || event.code === 'Space') event.preventDefault();
});
window.addEventListener('keyup', (event) => keys.delete(event.code));

const pointerTo = (clientX) => {
  const box = canvas.getBoundingClientRect();
  state.target = ((clientX - box.left) / box.width) * W;
};
canvas.addEventListener('pointermove', (event) => pointerTo(event.clientX));
canvas.addEventListener('pointerdown', (event) => {
  pointerTo(event.clientX);
  anyInput();
});

document.getElementById('quit').addEventListener('click', () => tellHub('mastre:exit'));

function update(dt) {
  if (state.mode !== 'playing') return;
  state.time += dt;
  state.flash = Math.max(0, state.flash - dt);

  const left = keys.has('ArrowLeft') || keys.has('KeyA');
  const right = keys.has('ArrowRight') || keys.has('KeyD');
  if (left || right) {
    state.target = null;
    state.player += (right ? 1 : -1) * 620 * dt;
  } else if (state.target !== null) {
    state.player += (state.target - state.player) * Math.min(1, dt * 18);
  }
  state.player = Math.max(70, Math.min(W - 70, state.player));

  const level = 1 + state.time / 14;
  state.spawnIn -= dt;
  if (state.spawnIn <= 0) {
    state.spawnIn = Math.max(0.22, 0.75 / level);
    state.things.push({
      x: 40 + Math.random() * (W - 80),
      y: -30,
      speed: (200 + Math.random() * 120) * level,
      bomb: Math.random() < Math.min(0.42, 0.18 + state.time / 120),
      spin: Math.random() * 6,
    });
  }

  for (const thing of state.things) {
    thing.y += thing.speed * dt;
    thing.spin += dt * 4;
    const caught = thing.y > H - 78 && thing.y < H - 40 && Math.abs(thing.x - state.player) < 76;
    if (caught) {
      thing.done = true;
      if (thing.bomb) {
        state.lives -= 1;
        state.flash = 0.25;
      } else {
        state.score += 1;
      }
    } else if (thing.y > H + 40) {
      thing.done = true;
    }
  }
  state.things = state.things.filter((thing) => !thing.done);
  if (state.lives <= 0) gameOver();
}

function text(value, x, y, size, color, align = 'center') {
  ctx.font = `700 ${size}px ui-monospace, "Cascadia Mono", Consolas, monospace`;
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText(value, x, y);
}

function draw() {
  ctx.fillStyle = state.flash > 0 ? '#2a0d18' : '#0b0b12';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = '#161622';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 48) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
  }
  for (let y = 0; y <= H; y += 48) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(W, y + 0.5);
  }
  ctx.stroke();

  for (const thing of state.things) {
    ctx.save();
    ctx.translate(thing.x, thing.y);
    if (thing.bomb) {
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = '#ff3d7f';
      ctx.fillRect(-15, -15, 30, 30);
      ctx.fillStyle = '#0b0b12';
      ctx.fillRect(-5, -5, 10, 10);
    } else {
      ctx.scale(Math.abs(Math.cos(thing.spin)) * 0.7 + 0.3, 1);
      ctx.fillStyle = '#ffd23a';
      ctx.beginPath();
      ctx.arc(0, 0, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#b8860b';
      ctx.fillRect(-3, -8, 6, 16);
    }
    ctx.restore();
  }

  ctx.fillStyle = '#ff3d7f';
  ctx.fillRect(state.player - 64, H - 56, 140, 18);
  ctx.fillStyle = '#c6ff3a';
  ctx.fillRect(state.player - 70, H - 62, 140, 18);

  text(String(state.score).padStart(3, '0'), 24, 44, 34, '#f4f1e8', 'left');
  text(`BEST ${String(state.best).padStart(3, '0')}`, 24, 70, 15, '#9a98ad', 'left');
  text('♥'.repeat(Math.max(0, state.lives)), 24, 98, 22, '#ff3d7f', 'left');

  if (state.mode === 'title') {
    text('COIN CHASE', W / 2, 230, 84, '#c6ff3a');
    text('catch the coins   dodge the bombs', W / 2, 280, 20, '#9a98ad');
    if (Math.floor(performance.now() / 500) % 2) text('PRESS ANY KEY OR TAP TO START', W / 2, 360, 22, '#f4f1e8');
    text('← →  or  A D  or  the mouse', W / 2, 400, 16, '#9a98ad');
  } else if (state.mode === 'over') {
    text('GAME OVER', W / 2, 230, 84, '#ff3d7f');
    text(`score ${state.score}   best ${state.best}`, W / 2, 284, 22, '#f4f1e8');
    if (Math.floor(performance.now() / 500) % 2) text('PRESS ANY KEY OR TAP TO PLAY AGAIN', W / 2, 360, 22, '#f4f1e8');
  }
}

let last = performance.now();
function frame(now) {
  update(Math.min(0.05, (now - last) / 1000));
  last = now;
  draw();
  requestAnimationFrame(frame);
}

draw();
requestAnimationFrame(frame);
tellHub('mastre:ready');
