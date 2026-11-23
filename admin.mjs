#!/usr/bin/env node
/**
 * Управление игрой «Монетка» из Termux.
 *
 *   node admin.mjs status         — раунд, фаза, банк, онлайн и офлайн
 *   node admin.mjs start          — принудительно подбросить монету
 *   node admin.mjs newround       — начать новый раунд
 *   node admin.mjs reset          — перезапуск, остаются только онлайн
 *   node admin.mjs clear ""       — удалить всех игроков
 *   node admin.mjs clear "Саша"   — удалить только этого игрока
 *   node admin.mjs wipe           — удалить всех и перезапустить
 *   node admin.mjs help           — список команд
 *
 * Нужен Node.js 18+ (в Termux: pkg install nodejs).
 * Доступ идёт через правила Firebase, ключи не требуются.
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
const patch = (path, body) => http(path, "PATCH", body);
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

// все известные игроки: из комнаты, присутствия и профилей
async function collectPlayers(room) {
  const all = {}; // key -> { name, bet, online }
  const presence = (room && room.presence) || {};
  const on = onlineMap(presence);
  let profiles = null;
  try {
    profiles = await http("/players");
  } catch (e) {
    if (!/401|403/.test(e.message)) throw e;
  }
  for (const [key, val] of Object.entries(profiles || {})) {
    if (val && val.blocked) continue;
    all[key] = { name: (val && val.name) || "Игрок", bet: 0, online: !!on[key] };
  }
  for (const [key, val] of Object.entries((room && room.players) || {})) {
    if (!all[key]) all[key] = { name: (val && val.name) || "Игрок", bet: 0, online: !!on[key] };
    all[key].name = (val && val.name) || all[key].name;
    all[key].bet = Number(val && val.bet) || 0;
  }
  for (const [key, name] of Object.entries(on)) {
    if (!all[key]) all[key] = { name, bet: 0, online: true };
    else all[key].online = true;
  }
  return all;
}

async function status() {
  const room = await getRoom();
  if (!room) {
    console.log("Комната пуста — откройте сайт, она создастся сама.");
    return;
  }
  const all = await collectPlayers(room);
  const online = [], offline = [];
  for (const key of Object.keys(all)) {
    const p = all[key];
    const line = p.name + (p.bet > 0 ? ` — ставка ${p.bet}` : "");
    (p.online ? online : offline).push(line);
  }
  console.log(`Раунд ${room.round || 1}, фаза: ${room.phase || "—"}, банк ${room.pot || 0}`);
  console.log(`Онлайн (${online.length}): ${online.join("; ") || "никого"}`);
  console.log(`Офлайн (${offline.length}): ${offline.join("; ") || "никого"}`);
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

// clear "" — все, clear "имя" — только совпадающие по имени
async function clear(arg) {
  const query = String(arg === undefined || arg === null ? "" : arg).trim().toLowerCase();
  const room = await getRoom();
  if (!room) {
    console.log("Комната пуста.");
    return;
  }
  const all = await collectPlayers(room);
  const targets = Object.entries(all)
    .filter(([, p]) => !query || p.name.toLowerCase().includes(query))
    .map(([key, p]) => ({ key, name: p.name }));

  if (!targets.length) {
    console.log(query ? `Никого не нашли по «${arg}»` : "Игроков нет.");
    return;
  }

  let pot = Number(room.pot) || 0;
  let potChanged = false;
  for (const { key } of targets) {
    const p = (room.players || {})[key];
    if (p && Number(p.bet) > 0 && room.phase !== "result") {
      pot -= Number(p.bet) || 0;
      potChanged = true;
    }
    // «надгробие»: профиль больше не восстанавливается на устройстве автоматически
    try {
      await http(`/players/${key}`, "PUT", { name: "", balance: 0, blocked: true });
    } catch (e) {
      if (!/401|403/.test(e.message)) throw e;
    }
    await del(`/rooms/${ROOM}/players/${key}`).catch(() => {});
    await del(`/rooms/${ROOM}/presence/${key}`).catch(() => {});
  }
  if (potChanged) await patch(`/rooms/${ROOM}`, { pot: Math.max(0, pot) });

  const after = await getRoom();
  const left = Object.keys((after && after.players) || {}).filter((k) =>
    targets.some((t) => t.key === k)
  );
  if (!query) console.log(`Удалены все игроки (${targets.length}): ${targets.map((t) => t.name).join(", ")}.`);
  else console.log(`Удалён: ${targets.map((t) => t.name).join(", ")}.`);
  if (left.length) {
    console.log("Не убрались со стола: " + left.map((k) => all[k].name).join(", ") + ".");
    console.log("Опубликуйте database.rules.json в Realtime Database → Rules (в новых правилах игроки необязательны).");
  }
}

async function wipe() {
  const room = await getRoom();
  if (room) {
    try { await clear(""); } catch (e) { if (!/401|403/.test(e.message)) throw e; }
  }
  await del(`/rooms/${ROOM}`).catch(() => {});
  console.log("Игра перезапущена с чистого листа.");
}

function help() {
  console.log("Команды:");
  console.log("  status          — раунд, фаза, банк, онлайн и офлайн");
  console.log("  start           — принудительно подбросить монету");
  console.log("  newround        — начать новый раунд");
  console.log("  reset           — перезапуск, остаются только онлайн");
  console.log('  clear ""        — удалить всех игроков');
  console.log('  clear "Саша"    — удалить только этого игрока');
  console.log("  wipe            — удалить всех и перезапустить");
}

const command = (process.argv[2] || "status").toLowerCase();
const arg = process.argv[3];

const actions = {
  status,
  start,
  newround,
  reset,
  clear: () => clear(arg),
  wipe,
  help
};

if (!actions[command]) {
  console.log("Неизвестная команда. Доступно: status | start | newround | reset | clear | wipe");
  process.exit(1);
}

Promise.resolve(actions[command]()).catch((err) => {
  console.error("Ошибка:", err.message);
  if (/401|403/.test(err.message)) {
    console.error("Правила Firebase не разрешают это действие. Откройте Realtime Database → Rules,");
    console.error("вставьте database.rules.json и нажмите Publish — после этого команда сработает.");
  }
  process.exit(1);
});
