#!/usr/bin/env node
/**
 * Управление игрой «Монетка» из Termux.
 *
 *   node admin.mjs status     — что сейчас в комнате и кто онлайн
 *   node admin.mjs start      — принудительно подбросить монету (или начать новый раунд)
 *   node admin.mjs newround   — начать новый раунд, не дожидаясь кнопки в браузере
 *   node admin.mjs reset      — перезапустить игру, оставить только онлайн
 *   node admin.mjs clear      — удалить никнеймы (все заходят заново)
 *   node admin.mjs wipe       — удалить никнеймы и перезапустить игру
 *
 * Нужен Node.js 18+ (в Termux: pkg install nodejs).
 * Доступ идёт через открытые правила Firebase, ключи не требуются.
 */
const DB = "https://minigame-b6df4-default-rtdb.firebaseio.com";
const ROOM = process.env.ROOM || "MAIN";
const ONLINE_TTL = 60000; // мс: отметка присутствия моложе минуты = онлайн

const url = (path) => `${DB}${path}.json`;

async function http(path, method = "GET", body) {
  const res = await fetch(url(path), {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} на ${method} ${path}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const getRoom = () => http(`/rooms/${ROOM}`);
const putRoom = (room) => http(`/rooms/${ROOM}`, "PUT", room);
const del = (path) => http(path, "DELETE");

function onlineMap(presence) {
  const now = Date.now();
  const on = {};
  for (const [key, val] of Object.entries(presence || {})) {
    if (val && now - (Number(val.at) || 0) < ONLINE_TTL) on[key] = val.name || "Игрок";
  }
  return on;
}

function emptyRoom(players) {
  return {
    host: Object.keys(players)[0] || null,
    created: Date.now(),
    round: 1,
    phase: "betting",
    pot: 0,
    stage: 0,
    lastFlip: null,
    winner: null,
    prize: 0,
    winSide: null,
    awarded: true,
    players
  };
}

function startNewRound(room) {
  room.round = (Number(room.round) || 1) + 1;
  room.phase = "betting";
  room.pot = 0;
  room.stage = 0;
  room.lastFlip = null;
  room.winner = null;
  room.prize = 0;
  room.winSide = null;
  room.awarded = true;
  for (const p of Object.values(room.players || {})) {
    p.bet = 0;
    p.side = null;
    p.out = false;
  }
  return room;
}

// копия логики подброса из сайта
function forceFlip(room) {
  const players = room.players || {};
  const alive = Object.entries(players).filter(([, p]) => Number(p.bet) > 0 && !p.out);
  if (alive.length < 2) return { error: "Нужно минимум 2 участника со ставкой" };

  const result = Math.random() < 0.5 ? "H" : "T";
  const survivors = [];
  alive.forEach(([key, p]) => {
    if (!p.side) p.side = Math.random() < 0.5 ? "H" : "T";
    if (p.side === result) survivors.push(key);
    else p.out = true;
  });
  survivors.forEach((key) => { players[key].side = null; });

  room.stage = (Number(room.stage) || 0) + 1;
  room.lastFlip = { result, at: Date.now(), stage: room.stage };

  if (survivors.length === 1) {
    room.winner = survivors[0];
    room.prize = Number(room.pot) || 0;
    room.winSide = result;
    const results = {};
    Object.entries(players).forEach(([key, p]) => {
      const bet = Number(p.bet) || 0;
      if (bet > 0) {
        results[key] = {
          name: p.name || "Игрок",
          bet,
          delta: key === survivors[0] ? room.prize - bet : -bet
        };
      }
    });
    room.rounds = room.rounds || {};
    room.rounds[String(room.round)] = results;
    const keys = Object.keys(room.rounds).map(Number).sort((a, b) => a - b);
    while (keys.length > 20) delete room.rounds[String(keys.shift())];
    room.phase = "result";
    room.awarded = false;
  } else {
    room.phase = "pick";
  }
  return { room, survivors: survivors.length, result };
}

async function status() {
  const room = await getRoom();
  if (!room) {
    console.log("Комната пуста — откройте сайт, она создастся сама.");
    return;
  }
  const on = onlineMap(room.presence);
  console.log(`Раунд ${room.round || 1}, фаза: ${room.phase || "—"}`);
  const names = Object.entries(on).map(([key, name]) => {
    const p = (room.players || {})[key];
    const bet = p && Number(p.bet) > 0 ? `, ставка ${p.bet}` : "";
    return `${name}${bet}`;
  });
  console.log(`Онлайн (${names.length}): ${names.join("; ") || "никого"}`);
}

async function start() {
  const room = await getRoom();
  if (!room) {
    console.log("Комната пуста — откройте сайт, она создастся сама.");
    return;
  }
  if (room.phase === "result") {
    startNewRound(room);
    await putRoom(room);
    console.log(`Новый раунд ${room.round}. Ждём ставки.`);
    return;
  }
  const res = forceFlip(room);
  if (res.error) {
    console.log(res.error);
    return;
  }
  await putRoom(res.room);
  const face = res.result === "H" ? "орёл" : "решка";
  if (res.room.phase === "result") {
    const winner = res.room.players[res.room.winner];
    console.log(`Монета: ${face}. Победитель — ${winner ? winner.name : "?"}, ставки: ${res.room.prize}.`);
  } else {
    console.log(`Монета: ${face}. Продолжают ${res.survivors} — нужен тай-брейк.`);
  }
}

async function newround() {
  const room = await getRoom();
  if (!room) {
    console.log("Комната пуста — откройте сайт, она создастся сама.");
    return;
  }
  startNewRound(room);
  await putRoom(room);
  console.log(`Новый раунд ${room.round}. Ставки обнулены.`);
}

async function reset() {
  const room = await getRoom();
  if (!room) {
    console.log("Комната пуста — откройте сайт, она создастся сама.");
    return;
  }
  const on = onlineMap(room.presence);
  const players = {};
  for (const key of Object.keys(on)) {
    const p = (room.players || {})[key] || {};
    players[key] = { name: p.name || on[key], bet: 0, side: null, out: false };
  }
  if (!Object.keys(players).length) {
    await del(`/rooms/${ROOM}`);
    console.log("Игра перезапущена (комната очищена, онлайн никого).");
    return;
  }
  await putRoom(emptyRoom(players));
  console.log("Игра перезапущена. Онлайн: " + Object.values(players).map((p) => p.name).join(", "));
}

async function clear() {
  const room = await getRoom();
  const keys = Object.keys((room && room.players) || {});
  let wipedAll = true;
  try {
    await del("/players");
  } catch (e) {
    if (!/401|403/.test(e.message)) throw e;
    wipedAll = false;
    for (const key of keys) {
      try { await del(`/players/${key}`); } catch (err) {}
    }
  }
  try { await del(`/rooms/${ROOM}`); } catch (e) {
    if (!/401|403/.test(e.message)) throw e;
  }
  if (wipedAll) console.log("Никнеймы удалены. Все заходят заново.");
  else console.log("Комната очищена. Полностью стереть профили мешают правила БД — опубликуйте database.rules.json.");
}

async function wipe() {
  await clear();
  console.log("Игра перезапущена с чистого листа.");
}

function help() {
  console.log("Команды:");
  console.log("  status    — кто онлайн и состояние комнаты");
  console.log("  start     — принудительно подбросить монету (после результата — новый раунд)");
  console.log("  newround  — начать новый раунд сразу");
  console.log("  reset     — перезапуск, остаются только онлайн");
  console.log("  clear     — удалить никнеймы");
  console.log("  wipe      — удалить никнеймы и перезапустить");
}

const command = (process.argv[2] || "status").toLowerCase();
const actions = { status, start, newround, reset, clear, wipe, help };

if (!actions[command]) {
  console.log("Неизвестная команда. Доступно: status | start | newround | reset | clear | wipe");
  process.exit(1);
}

actions[command]().catch((err) => {
  console.error("Ошибка:", err.message);
  if (/401|403/.test(err.message)) {
    console.error("Правила Firebase не разрешают это действие. Откройте Realtime Database → Rules,");
    console.error("вставьте database.rules.json и нажмите Publish — после этого команда сработает.");
  }
  process.exit(1);
});
