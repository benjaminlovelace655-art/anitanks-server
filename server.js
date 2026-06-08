const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3001;
const MAP_W = 2000;
const MAP_H = 2000;
const TANK_RADIUS = 18;
const TURRET_LEN = 28;
const BULLET_RADIUS = 4;
const MAX_PLAYERS = 20;
const RESPAWN_TIME = 3000;

const players = new Map();
const bullets = [];
const powerups = [];
let nextPowerupSpawn = 0;

function randomName() {
  const names = ['Titan', 'Viper', 'Storm', 'Shadow', 'Blitz', 'Fury', 'Omega', 'Nova', 'Raven', 'Cobra', 'Apex', 'Ghost', 'Sniper', 'Blaze', 'Crusher'];
  return names[Math.floor(Math.random() * names.length)] + Math.floor(Math.random() * 100);
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function createPlayer(ws) {
  const id = uuidv4().slice(0, 8);
  const player = {
    id,
    ws,
    x: 100 + Math.random() * (MAP_W - 200),
    y: 100 + Math.random() * (MAP_H - 200),
    angle: 0,
    turretAngle: 0,
    hp: 100,
    maxHp: 100,
    speed: 2.5,
    kills: 0,
    deaths: 0,
    name: randomName(),
    cooldown: 0,
    bulletSpeed: 7,
    damage: 20,
    isDead: false,
    deathTimer: 0,
    powerupTimer: 0,
    lastInput: null,
  };
  players.set(id, player);
  broadcast({
    type: 'playerJoin',
    id,
    name: player.name,
    x: player.x,
    y: player.y,
  });
  ws.send(JSON.stringify({ type: 'init', id, map: { w: MAP_W, h: MAP_H } }));
  return player;
}

function spawnPowerup() {
  if (powerups.length >= 8) return;
  const types = ['health', 'speed', 'damage'];
  powerups.push({
    x: 50 + Math.random() * (MAP_W - 100),
    y: 50 + Math.random() * (MAP_H - 100),
    type: types[Math.floor(Math.random() * types.length)],
  });
}

function broadcast(data, excludeId) {
  const msg = JSON.stringify(data);
  for (const [id, p] of players) {
    if (id !== excludeId && p.ws.readyState === 1) {
      p.ws.send(msg);
    }
  }
}

function gameLoop() {
  const now = Date.now();

  if (powerups.length < 4 && now > nextPowerupSpawn) {
    spawnPowerup();
    nextPowerupSpawn = now + 5000;
  }

  for (const [id, p] of players) {
    if (p.isDead) {
      if (now >= p.deathTimer) {
        p.isDead = false;
        p.hp = p.maxHp;
        p.x = MAP_W / 2 + (Math.random() - 0.5) * 200;
        p.y = MAP_H / 2 + (Math.random() - 0.5) * 200;
        p.ws.send(JSON.stringify({ type: 'respawn', x: p.x, y: p.y }));
      }
      continue;
    }

    if (p.powerupTimer > 0) {
      p.powerupTimer--;
      if (p.powerupTimer === 0) {
        p.speed = 2.5; p.damage = 20; p.bulletSpeed = 7;
      }
    }

    if (p.cooldown > 0) p.cooldown--;

    if (p.lastInput) {
      const { keys, mouse, shooting } = p.lastInput;
      let dx = 0, dy = 0;
      if (keys.w || keys.arrowup) dy = -1;
      if (keys.s || keys.arrowdown) dy = 1;
      if (keys.a || keys.arrowleft) dx = -1;
      if (keys.d || keys.arrowright) dx = 1;
      if (dx || dy) {
        p.angle = Math.atan2(dy, dx);
        p.x += Math.cos(p.angle) * p.speed;
        p.y += Math.sin(p.angle) * p.speed;
      }
      p.x = clamp(p.x, TANK_RADIUS, MAP_W - TANK_RADIUS);
      p.y = clamp(p.y, TANK_RADIUS, MAP_H - TANK_RADIUS);
      p.turretAngle = Math.atan2(mouse.y, mouse.x);

      if (shooting && p.cooldown <= 0) {
        bullets.push({
          x: p.x + Math.cos(p.turretAngle) * TURRET_LEN,
          y: p.y + Math.sin(p.turretAngle) * TURRET_LEN,
          vx: Math.cos(p.turretAngle) * p.bulletSpeed,
          vy: Math.sin(p.turretAngle) * p.bulletSpeed,
          owner: p.id,
          damage: p.damage,
          life: 120,
        });
        p.cooldown = 12;
      }
    }

    for (let i = 0; i < powerups.length; i++) {
      const pu = powerups[i];
      if (dist(pu, p) < TANK_RADIUS + 10) {
        if (pu.type === 'health') p.hp = Math.min(p.maxHp, p.hp + 40);
        else if (pu.type === 'speed') { p.speed = 4; p.powerupTimer = 300; }
        else if (pu.type === 'damage') { p.damage = 40; p.bulletSpeed = 10; p.powerupTimer = 300; }
        powerups.splice(i, 1);
        broadcast({ type: 'powerupCollected', x: pu.x, y: pu.y });
        break;
      }
    }
  }

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx;
    b.y += b.vy;
    b.life--;
    if (b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H || b.life <= 0) {
      bullets.splice(i, 1);
      continue;
    }

    let hit = false;
    for (const [id, p] of players) {
      if (p.isDead || id === b.owner) continue;
      if (dist(b, p) < TANK_RADIUS + BULLET_RADIUS) {
        p.hp -= b.damage;
        hit = true;
        if (p.hp <= 0) {
          p.isDead = true;
          p.deathTimer = now + RESPAWN_TIME;
          p.deaths++;
          const killer = players.get(b.owner);
          if (killer) { killer.kills++; killer.ws.send(JSON.stringify({ type: 'kill', targetId: id })); }
          broadcast({ type: 'playerDeath', id, killerId: b.owner, killerName: killer ? killer.name : 'unknown' });
        }
        bullets.splice(i, 1);
        break;
      }
    }
    if (!hit) {
      for (const [id, p] of players) {
        if (p.isDead) continue;
        if (dist(b, p) < BULLET_RADIUS + TANK_RADIUS) {
          p.hp -= b.damage;
          hit = true;
          if (p.hp <= 0) {
            p.isDead = true;
            p.deathTimer = now + RESPAWN_TIME;
            p.deaths++;
            const killer = players.get(b.owner);
            if (killer) { killer.kills++; killer.ws.send(JSON.stringify({ type: 'kill', targetId: id })); }
            broadcast({ type: 'playerDeath', id, killerId: b.owner, killerName: killer ? killer.name : 'unknown' });
          }
          bullets.splice(i, 1);
          break;
        }
      }
    }
  }

  const state = {
    type: 'state',
    players: [],
    bullets: bullets.map(b => ({ x: b.x, y: b.y, id: b.owner })),
    powerups: powerups.map(p => ({ x: p.x, y: p.y, type: p.type })),
  };
  for (const [id, p] of players) {
    if (!p.isDead) {
      state.players.push({
        id: p.id, x: p.x, y: p.y, angle: p.angle, turretAngle: p.turretAngle,
        hp: p.hp, maxHp: p.maxHp, name: p.name, kills: p.kills, deaths: p.deaths,
      });
    }
  }
  broadcast(state);
}

function handleMessage(ws, data) {
  let player = null;
  for (const [id, p] of players) {
    if (p.ws === ws) { player = p; break; }
  }
  if (!player) return;

  if (data.type === 'input') {
    player.lastInput = data;
  }
}

const wss = new WebSocketServer({ port: PORT });
console.log(`AniTanks server running on ws://localhost:${PORT}`);

wss.on('connection', (ws) => {
  const player = createPlayer(ws);

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      handleMessage(ws, data);
    } catch {}
  });

  ws.on('close', () => {
    players.delete(player.id);
    broadcast({ type: 'playerLeave', id: player.id });
  });
});

setInterval(gameLoop, 1000 / 60);
