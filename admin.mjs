#!/usr/bin/env node
/**
 * Управление игрой «Монетка» из Termux.
 *
 *   node admin.mjs                — интерактивный режим (status/ban/... по строке)
 *   node admin.mjs status         — раунд, фаза, банк, онлайн и офлайн
 *   node admin.mjs start          — принудительно подбросить монету
 *   node admin.mjs newround       — начать новый раунд
 *   node admin.mjs round          — сбросить все раунды (номер 1, история пуста)
 *   node admin.mjs reset          — перезапуск, остаются только онлайн
 *   node admin.mjs clear ""       — удалить всех игроков
 *   node admin.mjs clear "Саша"   — удалить только этого игрока
 *   node admin.mjs ban "Саша"     — забанить устройство
 *   node admin.mjs unban "Саша"   — снять бан
 *   node admin.mjs rename "Саша" "Алекс" — переименовать
 *   node admin.mjs wipe           — удалить всех и перезапустить
 *   node admin.mjs help           — список команд
 *
 * Нужен Node.js 18+ (в Termux: pkg install nodejs).
 * Доступ идёт через правила Firebase, ключи не требуются.
 */
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";

const VERSION = 8;
const RAW_URL = process.env.ADMIN_URL || "https://raw.githubusercontent.com/gutvisple-maker/minicasino/main/admin.mjs";
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
  let survivors = [];
  const missed = [];
  alive.forEach(([key]) => {
    // у каждого свой независимый подброс 50/50
    if (Math.random() < 0.5) survivors.push(key);
    else missed.push(key);
  });
  if (!survivors.length) {
    // все проиграли — никто не выбывает, кидаем снова
    survivors = alive.map(([key]) => key);
  } else {
    missed.forEach((key) => { players[key].out = true; });
  }
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
    room.phase = "flipping";
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

// сначала ищем среди тех, кто за столом, потом точное имя, потом часть имени
function resolveTargets(all, room, query) {
  const q = String(query || "").trim().toLowerCase();
  const entries = Object.entries(all);
  if (!q) return entries;
  const roomKeys = new Set(Object.keys((room && room.players) || {}));
  const inRoom = entries.filter(([key, p]) => roomKeys.has(key) && p.name.toLowerCase().includes(q));
  if (inRoom.length) return inRoom;
  const exact = entries.filter(([, p]) => p.name.toLowerCase() === q);
  if (exact.length) return exact;
  return entries.filter(([, p]) => p.name.toLowerCase().includes(q));
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
  const bans = await getBans();
  const banned = Object.values(bans).map((b) => (b && b.name) || "?").filter(Boolean);
  if (banned.length) console.log(`Забанены (${banned.length}): ${banned.join("; ")}`);
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
    console.log(`Монета: ${face}. Продолжают ${res.survivors} — кидаем снова.`);
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

async function round() {
  const room = await getRoom();
  if (!room) {
    console.log("Комната пуста — откройте сайт, она создастся сама.");
    return;
  }
  room.round = 1;
  room.phase = "betting";
  room.pot = 0;
  room.stage = 0;
  room.lastFlip = null;
  room.winner = null;
  room.prize = 0;
  room.winSide = null;
  room.awarded = true;
  room.rounds = {};
  for (const p of Object.values(room.players || {})) {
    p.bet = 0;
    p.side = null;
    p.out = false;
  }
  await putRoom(room);
  console.log("Все раунды сброшены: раунд 1, история и ставки очищены.");
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
  const targets = resolveTargets(all, room, arg).map(([key, p]) => ({ key, name: p.name }));

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

async function getBans() {
  try {
    return (await http("/bans")) || {};
  } catch (e) {
    if (/401|403/.test(e.message)) return {};
    throw e;
  }
}

async function ban(name) {
  const query = String(name || "").trim().toLowerCase();
  if (!query) {
    console.log('Укажите имя: node admin.mjs ban "Саша"');
    return;
  }
  const room = await getRoom();
  const all = await collectPlayers(room || {});
  const targets = resolveTargets(all, room, name);
  if (!targets.length) {
    console.log(`Никого не нашли по «${name}»`);
    return;
  }
  const now = Date.now();
  for (const [key, p] of targets) {
    await http(`/bans/${key}`, "PUT", { name: p.name, at: now });
    await del(`/rooms/${ROOM}/players/${key}`).catch(() => {});
    await del(`/rooms/${ROOM}/presence/${key}`).catch(() => {});
    console.log(`Забанено устройство: ${p.name} (${key.slice(0, 8)}…)`);
  }
}

async function unban(name) {
  const query = String(name || "").trim().toLowerCase();
  const bans = await getBans();
  const targets = Object.entries(bans).filter(([, b]) => !query || String((b && b.name) || "").toLowerCase().includes(query));
  if (!targets.length) {
    console.log(query ? `Забаненных по «${name}» нет.` : "Забаненных нет.");
    return;
  }
  for (const [key, b] of targets) {
    await del(`/bans/${key}`);
    console.log(`Разбанено: ${(b && b.name) || key}`);
  }
}

async function rename(oldName, newName) {
  const query = String(oldName || "").trim().toLowerCase();
  const next = String(newName || "").trim().replace(/\s+/g, " ");
  if (!query || next.length < 2) {
    console.log('Так: node admin.mjs rename "Саша" "Александр"');
    return;
  }
  const room = await getRoom();
  const all = await collectPlayers(room || {});
  const targets = resolveTargets(all, room, oldName);
  if (!targets.length) {
    console.log(`Никого не нашли по «${oldName}»`);
    return;
  }
  for (const [key, p] of targets) {
    let rec = null;
    try { rec = await http(`/players/${key}`); } catch (e) { if (!/401|403/.test(e.message)) throw e; }
    if (rec && rec.name) {
      rec.name = next;
      delete rec.blocked;
      await http(`/players/${key}`, "PUT", rec);
    }
    if (room && room.players && room.players[key]) {
      await patch(`/rooms/${ROOM}/players/${key}`, { name: next }).catch(() => {});
    }
    if (room && room.presence && room.presence[key]) {
      await patch(`/rooms/${ROOM}/presence/${key}`, { name: next }).catch(() => {});
    }
    console.log(`${p.name} → ${next}`);
  }
}

const SITE = process.env.SITE || "https://gutvisple-maker.github.io/minicasino/";

async function setRole(name, role) {
  const query = String(name || "").trim().toLowerCase();
  if (!query) {
    console.log(`Укажите имя: node admin.mjs ${role} "Тимур"`);
    return;
  }
  const room = await getRoom();
  const all = await collectPlayers(room || {});
  const targets = resolveTargets(all, room, name);
  if (!targets.length) {
    console.log(`Никого не нашли по «${name}»`);
    return;
  }
  const now = Date.now();
  for (const [key, p] of targets) {
    await http(`/roles/${key}`, "PUT", { role, name: p.name, at: now });
    console.log(`${p.name} → ${role === "owner" ? "овнер" : "админ"} (${key.slice(0, 8)}…)`);
  }
  console.log(`Панель: ${SITE}#panel`);
}

async function roles() {
  let data = null;
  try { data = await http("/roles"); } catch (e) {
    if (/401|403/.test(e.message)) { console.log("Нет доступа к ролям — опубликуйте database.rules.json."); return; }
    throw e;
  }
  const list = Object.entries(data || {});
  if (!list.length) { console.log("Ролей нет."); return; }
  for (const [key, r] of list) {
    console.log(`${r.role === "owner" ? "овнер" : "админ"}: ${r.name || "?"} (${key.slice(0, 8)}…)`);
  }
}

async function unrole(name) {
  const query = String(name || "").trim().toLowerCase();
  let data = null;
  try { data = await http("/roles"); } catch (e) {
    if (/401|403/.test(e.message)) { console.log("Нет доступа к ролям — опубликуйте database.rules.json."); return; }
    throw e;
  }
  const targets = Object.entries(data || {}).filter(([, r]) => !query || String((r && r.name) || "").toLowerCase().includes(query));
  if (!targets.length) { console.log("Ничего не найдено."); return; }
  for (const [key, r] of targets) {
    await del(`/roles/${key}`);
    console.log(`Снята роль: ${(r && r.name) || key}`);
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

async function update() {
  console.log(`Текущая версия: ${VERSION}. Скачиваю последнюю…`);
  const res = await fetch(RAW_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} на ${RAW_URL}`);
  const text = await res.text();
  const m = /const VERSION = (\d+);/.exec(text);
  if (!text.includes("admin.mjs") || !text.includes("minigame-b6df4") || !m) {
    throw new Error("В репозитории лежит старый admin.mjs — загрузите новый файл на GitHub один раз, потом update будет работать.");
  }
  const remote = Number(m[1]);
  if (remote < VERSION) throw new Error(`В репозитории версия ${remote}, у вас ${VERSION} — обновление не нужно.`);
  if (remote === VERSION && text.length === fs.statSync(path.resolve(process.argv[1])).size) {
    console.log("Уже последняя версия.");
    return;
  }
  const target = path.resolve(process.argv[1]);
  fs.writeFileSync(target, text);
  console.log(`admin.mjs обновлён: версия ${remote}, ${text.length} байт. Перезапустите: node admin.mjs`);
}

function help() {
  console.log("Команды:");
  console.log("  status                — раунд, онлайн, офлайн, баны");
  console.log("  start                 — принудительно подбросить монету");
  console.log("  newround              — начать новый раунд");
  console.log("  round                 — сбросить все раунды (номер 1, история пуста)");
  console.log("  reset                 — перезапуск, остаются только онлайн");
  console.log('  clear ""              — удалить всех игроков');
  console.log('  clear "Саша"          — удалить только этого игрока');
  console.log('  ban "Саша"            — забанить устройство');
  console.log('  unban "Саша"          — снять бан');
  console.log('  rename "Саша" "Алекс" — переименовать');
  console.log("  wipe                  — удалить всех и перезапустить");
  console.log("  update                — скачать последнюю версию admin.mjs");
  console.log('  admin "Тимур"         — дать роль админа (панель #panel)');
  console.log('  owner "Тимур"         — дать роль овнера (все права)');
  console.log("  roles                 — список ролей");
  console.log('  unrole "Тимур"        — снять роль');
  console.log("");
  console.log("Без команды: node admin.mjs — интерактивный режим, команды по одной строке.");
}

// разбор строки с учётом кавычек: rename "Саша" "Алекс"
function parseArgs(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

function runCommand(cmd, args) {
  switch (cmd) {
    case "status": return status();
    case "start": return start();
    case "newround": return newround();
    case "round": return round();
    case "reset": return reset();
    case "wipe": return wipe();
    case "update": return update();
    case "admin": return setRole(args[0], "admin");
    case "owner": return setRole(args[0], "owner");
    case "roles": return roles();
    case "unrole": return unrole(args[0]);
    case "clear": return clear(args.join(" "));
    case "ban": return ban(args.join(" "));
    case "unban": return unban(args.join(" "));
    case "rename": return rename(args[0], args[1]);
    case "help": return help();
    default:
      console.log("Неизвестно. Доступно: status | start | newround | round | reset | clear | ban | unban | rename | wipe | update | admin | owner | roles | unrole");
      return Promise.resolve();
  }
}

function printError(err) {
  console.error("Ошибка:", err.message);
  if (/401|403/.test(err.message)) {
    console.error("Правила Firebase не разрешают это действие. Откройте Realtime Database → Rules,");
    console.error("вставьте database.rules.json и нажмите Publish — после этого команда сработает.");
  }
}

async function repl() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "admin> " });
  console.log("Интерактивный режим. help — команды, exit — выход.");
  rl.prompt();
  for await (const line of rl) {
    const parts = parseArgs(line.trim());
    const cmd = (parts.shift() || "").toLowerCase();
    if (!cmd) {
      rl.prompt();
      continue;
    }
    if (cmd === "exit" || cmd === "quit" || cmd === "выход") break;
    try {
      await runCommand(cmd, parts);
    } catch (err) {
      printError(err);
    }
    rl.prompt();
  }
  rl.close();
}

const command = (process.argv[2] || "").toLowerCase();
if (!command) {
  repl();
} else {
  Promise.resolve(runCommand(command, process.argv.slice(3))).catch((err) => {
    printError(err);
    process.exit(1);
  });
}
