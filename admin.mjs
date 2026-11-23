#!/usr/bin/env node
/**
 * Управление игрой «Монетка» из Termux.
 *
 *   node admin.mjs status    — что сейчас в комнате и кто онлайн
 *   node admin.mjs reset     — перезапустить раунд, оставить только онлайн
 *   node admin.mjs clear     — удалить никнеймы (все заходят заново)
 *   node admin.mjs wipe      — удалить никнеймы и перезапустить игру
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
    // нет игроков онлайн: проще удалить комнату, приложение создаст её заново
    await del(`/rooms/${ROOM}`);
    console.log("Игра перезапущена (комната очищена, онлайн никого).");
    return;
  }
  await putRoom(emptyRoom(players));
  console.log(
    "Игра перезапущена. Онлайн: " +
      Object.values(players).map((p) => p.name).join(", ")
  );
}

async function clear() {
  await del(`/rooms/${ROOM}`);
  await del("/players");
  console.log("Никнеймы удалены. Все заходят заново.");
}

async function wipe() {
  await clear();
  console.log("Игра перезапущена с чистого листа.");
}

const command = (process.argv[2] || "status").toLowerCase();
const actions = { status, reset, clear, wipe };

if (!actions[command]) {
  console.log("Команды: status | reset | clear | wipe");
  process.exit(1);
}

actions[command]().catch((err) => {
  console.error("Ошибка:", err.message);
  process.exit(1);
});
