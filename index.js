'use strict';

// =====================================================================
// Telegram-бот розыгрыша QuickRust (Dimiki & Yumis)
//
// Что делает:
//   * игрок в игре жмёт «ПРИВЯЗАТЬ TELEGRAM» -> плагин StreamerGiveaway выдаёт код
//     и передаёт его сюда (POST /api/code);
//   * игрок открывает бота, жмёт START и присылает код -> Telegram привязан к SteamID;
//   * бот даёт ссылки на каналы и по кнопке проверяет, подписан ли игрок
//     (бот должен быть администратором в каждом канале - иначе Telegram
//     не отдаёт список участников);
//   * плагин спрашивает статус (POST /api/status) и пускает в розыгрыш
//     только тех, кто привязан и подписан на все каналы.
//
// Зависимостей нет: нужен Node.js 18+ (встроенный fetch).
// Настройки - config.json рядом (или переменные окружения BOT_TOKEN, API_KEY, PORT).
// Данные - data/state.json (на хостинге не удалять).
// =====================================================================

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// ---------------------------------------------------------------------
// Конфиг
// ---------------------------------------------------------------------

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('[config] не удалось прочитать config.json:', e.message);
  }

  cfg.token = process.env.BOT_TOKEN || cfg.token || '';
  cfg.apiKey = process.env.API_KEY || cfg.apiKey || '';
  cfg.port = Number(process.env.PORT || process.env.SERVER_PORT || cfg.port || 3000);
  cfg.channels = Array.isArray(cfg.channels) ? cfg.channels.filter((c) => c && c.id) : [];
  cfg.checkCacheSeconds = Number(cfg.checkCacheSeconds || 60);
  cfg.maxCodeMinutes = Number(cfg.maxCodeMinutes || 30);
  cfg.adminIds = Array.isArray(cfg.adminIds) ? cfg.adminIds.map(String) : [];
  cfg.texts = Object.assign({
    start:
      '👋 Привет! Это бот розыгрыша <b>5 500 ₽</b> от Dimiki и Yumis на сервере QuickRust.\n\n' +
      '1. Зайди на сервер, открой меню → <b>РОЗЫГРЫШ</b> → «ПРИВЯЗАТЬ» у пункта Telegram.\n' +
      '2. Пришли сюда код, который покажет игра.',
    askCode: 'Пришли код из игры (меню → РОЗЫГРЫШ → «ПРИВЯЗАТЬ» у пункта Telegram).',
    badCode: '❌ Код не найден или устарел. Открой окно привязки в игре ещё раз и пришли новый код.',
    linked: '✅ Готово! Telegram привязан к игроку <b>{name}</b>.\n\nОсталось подписаться на каналы стримеров:',
    alreadyOther:
      '⛔ Этот Telegram уже привязан к другому игроку (<b>{name}</b>). Один Telegram — один участник.\n' +
      'Если это ошибка — напиши администрации в Discord проекта.',
    subscribeTitle: 'Подпишись на каналы и нажми «Проверить подписку»:',
    allGood:
      '🎉 Подписка на все каналы есть! Возвращайся в игру: меню → <b>РОЗЫГРЫШ</b> → «УЧАСТВУЮ».\n' +
      'Отыграй нужное время — и ты в розыгрыше.',
    missing: '⚠️ Пока нет подписки на: {list}.\nПодпишись и нажми «Проверить подписку» ещё раз.',
    notLinked: 'Telegram ещё не привязан. ',
    checkError: '⚠️ Не получилось проверить канал {list} — бот не администратор в нём. Сообщи администрации.',
  }, cfg.texts || {});
  return cfg;
}

const config = loadConfig();

if (!config.token) {
  console.error('[config] не задан token бота (config.json → token или переменная BOT_TOKEN).');
  process.exit(1);
}
if (!config.apiKey) {
  console.warn('[config] не задан apiKey: HTTP API открыт всем! Задай apiKey в config.json.');
}
if (config.channels.length === 0) {
  console.warn('[config] список channels пуст — проверять подписку не на что.');
}

// ---------------------------------------------------------------------
// Хранилище
// ---------------------------------------------------------------------

// links:  { tgId: { steamId, steamName, tgName, username, linkedAt } }
// codes:  { CODE: { steamId, name, expires } }
let state = { links: {}, codes: {} };
let bySteam = new Map();
let saveTimer = null;

function loadState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(STATE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      state.links = raw.links || {};
      state.codes = raw.codes || {};
    }
  } catch (e) {
    console.error('[state] не удалось прочитать state.json:', e.message);
  }
  rebuildIndex();
}

function rebuildIndex() {
  bySteam = new Map();
  for (const [tgId, link] of Object.entries(state.links)) {
    if (link && link.steamId) bySteam.set(String(link.steamId), tgId);
  }
}

function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = STATE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, STATE_PATH);
    } catch (e) {
      console.error('[state] не удалось сохранить:', e.message);
    }
  }, 500);
}

function pruneCodes() {
  const now = Date.now();
  let changed = false;
  for (const [code, c] of Object.entries(state.codes)) {
    if (!c || c.expires <= now) {
      delete state.codes[code];
      changed = true;
    }
  }
  if (changed) saveState();
}

// ---------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------

const TG = `https://api.telegram.org/bot${config.token}/`;
let botInfo = null;

async function tg(method, params) {
  const res = await fetch(TG + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  const data = await res.json().catch(() => ({ ok: false, description: 'bad json' }));
  if (!data.ok) {
    const err = new Error(data.description || ('HTTP ' + res.status));
    err.code = data.error_code;
    throw err;
  }
  return data.result;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fill(text, vars) {
  return text.replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m));
}

async function send(chatId, text, extra) {
  try {
    return await tg('sendMessage', Object.assign({
      chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
    }, extra || {}));
  } catch (e) {
    console.warn('[tg] sendMessage', chatId, e.message);
    return null;
  }
}

// ---------------------------------------------------------------------
// Проверка подписки
// ---------------------------------------------------------------------

const memberCache = new Map(); // `${chat}|${user}` -> { joined, error, at }

function channelTitle(c) {
  return c.title || c.id;
}

function channelUrl(c) {
  if (c.url) return c.url;
  const id = String(c.id);
  return id.startsWith('@') ? 'https://t.me/' + id.slice(1) : '';
}

async function isMember(channel, userId, force) {
  const key = channel.id + '|' + userId;
  const cached = memberCache.get(key);
  if (!force && cached && Date.now() - cached.at < config.checkCacheSeconds * 1000) return cached;

  let result;
  try {
    const m = await tg('getChatMember', { chat_id: channel.id, user_id: Number(userId) });
    const st = m && m.status;
    const joined = st === 'creator' || st === 'administrator' || st === 'member'
      || (st === 'restricted' && m.is_member === true);
    result = { joined, error: null, at: Date.now() };
  } catch (e) {
    // "member list is inaccessible" / "chat not found" - бот не админ в канале
    // или неверный id. Это не «не подписан», а ошибка настройки.
    const notFound = /user not found|PARTICIPANT_ID_INVALID/i.test(e.message);
    result = { joined: false, error: notFound ? null : e.message, at: Date.now() };
    if (!notFound) console.warn('[tg] getChatMember', channel.id, e.message);
  }

  memberCache.set(key, result);
  return result;
}

async function checkUser(userId, force) {
  const channels = [];
  for (const c of config.channels) {
    const r = await isMember(c, userId, force);
    channels.push({ id: String(c.id), title: channelTitle(c), url: channelUrl(c), joined: r.joined, error: r.error });
  }
  const subscribed = channels.length > 0 && channels.every((c) => c.joined);
  return { subscribed, channels };
}

function subscribeKeyboard(channels) {
  const rows = [];
  for (const c of channels) {
    if (!c.url) continue;
    rows.push([{ text: (c.joined ? '✅ ' : '📢 ') + c.title, url: c.url }]);
  }
  rows.push([{ text: '🔄 Проверить подписку', callback_data: 'check' }]);
  return { inline_keyboard: rows };
}

function statusText(link, result) {
  if (result.subscribed) return config.texts.allGood;

  const errors = result.channels.filter((c) => c.error).map((c) => c.title);
  if (errors.length) return fill(config.texts.checkError, { list: errors.join(', ') });

  const missing = result.channels.filter((c) => !c.joined).map((c) => '<b>' + escapeHtml(c.title) + '</b>');
  return fill(config.texts.missing, { list: missing.join(', ') });
}

// ---------------------------------------------------------------------
// Обработка сообщений
// ---------------------------------------------------------------------

const CODE_RE = /^[A-Z0-9]{4,12}$/;

async function onMessage(msg) {
  if (!msg || !msg.chat || msg.chat.type !== 'private' || !msg.from) return;

  const userId = String(msg.from.id);
  const text = String(msg.text || '').trim();

  if (text.startsWith('/start')) {
    const payload = text.split(/\s+/)[1];
    if (payload && CODE_RE.test(payload.toUpperCase())) return tryLink(msg, payload.toUpperCase());

    const link = state.links[userId];
    if (link) return showStatus(msg.chat.id, userId, false);
    return send(msg.chat.id, config.texts.start);
  }

  if (text === '/status' || text === '/check') {
    if (!state.links[userId]) return send(msg.chat.id, config.texts.notLinked + config.texts.askCode);
    return showStatus(msg.chat.id, userId, true);
  }

  if (text.startsWith('/unlink') && config.adminIds.includes(userId)) {
    // Админ: /unlink <steamId>
    const steamId = text.split(/\s+/)[1];
    const tgId = steamId && bySteam.get(steamId);
    if (!tgId) return send(msg.chat.id, 'Не найдено.');
    delete state.links[tgId];
    rebuildIndex();
    saveState();
    return send(msg.chat.id, 'Привязка ' + steamId + ' снята.');
  }

  const code = text.replace(/\s+/g, '').toUpperCase();
  if (CODE_RE.test(code)) return tryLink(msg, code);

  return send(msg.chat.id, state.links[userId] ? config.texts.askCode : config.texts.start);
}

async function tryLink(msg, code) {
  pruneCodes();
  const userId = String(msg.from.id);
  const entry = state.codes[code];

  if (!entry) return send(msg.chat.id, config.texts.badCode);

  const steamId = String(entry.steamId);
  const existing = state.links[userId];

  if (existing && String(existing.steamId) !== steamId) {
    return send(msg.chat.id, fill(config.texts.alreadyOther, { name: escapeHtml(existing.steamName || existing.steamId) }));
  }

  // У этого SteamID был другой Telegram - переносим привязку на новый.
  const oldTg = bySteam.get(steamId);
  if (oldTg && oldTg !== userId) delete state.links[oldTg];

  state.links[userId] = {
    steamId,
    steamName: entry.name || '',
    tgName: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' '),
    username: msg.from.username || '',
    linkedAt: new Date().toISOString(),
  };
  delete state.codes[code];
  rebuildIndex();
  saveState();

  console.log('[link]', steamId, '<->', userId, msg.from.username || '');

  const result = await checkUser(userId, true);
  await send(msg.chat.id, fill(config.texts.linked, { name: escapeHtml(entry.name || steamId) }) + '\n\n'
    + (result.subscribed ? config.texts.allGood : config.texts.subscribeTitle),
  { reply_markup: subscribeKeyboard(result.channels) });
}

async function showStatus(chatId, userId, force, editMessageId) {
  const link = state.links[userId];
  const result = await checkUser(userId, force);
  const header = 'Игрок: <b>' + escapeHtml(link.steamName || link.steamId) + '</b>\n\n';
  const text = header + statusText(link, result);
  const markup = subscribeKeyboard(result.channels);

  if (editMessageId) {
    try {
      await tg('editMessageText', {
        chat_id: chatId, message_id: editMessageId, text, parse_mode: 'HTML',
        disable_web_page_preview: true, reply_markup: markup,
      });
      return;
    } catch (e) {
      if (/message is not modified/i.test(e.message)) return;
    }
  }
  await send(chatId, text, { reply_markup: markup });
}

async function onCallback(q) {
  const userId = String(q.from.id);
  let answer = '';

  if (q.data === 'check') {
    if (!state.links[userId]) {
      answer = 'Сначала пришли код из игры';
    } else {
      const result = await checkUser(userId, true);
      answer = result.subscribed ? 'Подписка есть ✅' : 'Подписка не на все каналы';
      if (q.message) await showStatus(q.message.chat.id, userId, false, q.message.message_id);
    }
  }

  try { await tg('answerCallbackQuery', { callback_query_id: q.id, text: answer }); } catch (e) { /* ignore */ }
}

// Отписка/подписка в канале (приходит, когда бот - админ канала): сбрасываем кэш,
// чтобы плагин сразу увидел новое состояние.
function onChatMember(upd) {
  if (!upd || !upd.chat || !upd.new_chat_member || !upd.new_chat_member.user) return;
  const userId = String(upd.new_chat_member.user.id);
  for (const key of [...memberCache.keys()]) if (key.endsWith('|' + userId)) memberCache.delete(key);
}

// ---------------------------------------------------------------------
// Long polling
// ---------------------------------------------------------------------

let offset = 0;

async function pollLoop() {
  for (;;) {
    try {
      const updates = await tg('getUpdates', {
        offset, timeout: 50, allowed_updates: ['message', 'callback_query', 'chat_member'],
      });
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          if (u.message) await onMessage(u.message);
          else if (u.callback_query) await onCallback(u.callback_query);
          else if (u.chat_member) onChatMember(u.chat_member);
        } catch (e) {
          console.error('[update]', e);
        }
      }
    } catch (e) {
      console.warn('[poll]', e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// ---------------------------------------------------------------------
// HTTP API для плагина StreamerGiveaway
// ---------------------------------------------------------------------

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function reply(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 256 * 1024) req.destroy();
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

async function playerStatus(steamId, force) {
  const tgId = bySteam.get(String(steamId));
  if (!tgId) return { linked: false, subscribed: false, channels: [] };

  const link = state.links[tgId];
  const result = await checkUser(tgId, force);
  return {
    linked: true,
    username: link.username || '',
    tgName: link.tgName || '',
    subscribed: result.subscribed,
    channels: result.channels.map((c) => ({ title: c.title, joined: c.joined, error: !!c.error })),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/' || url.pathname === '/health') return reply(res, 200, { ok: true });

  if (!url.pathname.startsWith('/api/')) return reply(res, 404, { ok: false, error: 'not found' });

  const key = req.headers['x-api-key'] || '';
  if (config.apiKey && !safeEqual(key, config.apiKey)) return reply(res, 401, { ok: false, error: 'bad api key' });

  try {
    if (url.pathname === '/api/info' && req.method === 'GET') {
      return reply(res, 200, {
        ok: true,
        username: botInfo ? botInfo.username : '',
        channels: config.channels.map((c) => ({ title: channelTitle(c), url: channelUrl(c) })),
      });
    }

    if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method' });

    const body = await readBody(req);
    if (!body) return reply(res, 400, { ok: false, error: 'bad json' });

    if (url.pathname === '/api/code') {
      const code = String(body.code || '').toUpperCase();
      const steamId = String(body.steamId || '');
      if (!CODE_RE.test(code) || !/^\d{5,20}$/.test(steamId)) return reply(res, 400, { ok: false, error: 'bad args' });

      const ttl = Math.min(Number(body.ttl) || 900, config.maxCodeMinutes * 60);
      pruneCodes();
      for (const [c, e] of Object.entries(state.codes)) if (String(e.steamId) === steamId && c !== code) delete state.codes[c];
      state.codes[code] = { steamId, name: String(body.name || '').slice(0, 64), expires: Date.now() + ttl * 1000 };
      saveState();
      return reply(res, 200, { ok: true });
    }

    if (url.pathname === '/api/status') {
      const ids = Array.isArray(body.steamIds) ? body.steamIds.slice(0, 200).map(String) : [];
      const force = body.force === true;
      const players = {};
      for (const id of ids) players[id] = await playerStatus(id, force);
      return reply(res, 200, { ok: true, players });
    }

    if (url.pathname === '/api/notify') {
      const tgId = bySteam.get(String(body.steamId || ''));
      if (!tgId) return reply(res, 200, { ok: true, sent: false });
      const sent = await send(tgId, escapeHtml(String(body.text || '')).slice(0, 3500));
      return reply(res, 200, { ok: true, sent: !!sent });
    }

    if (url.pathname === '/api/unlink') {
      const tgId = bySteam.get(String(body.steamId || ''));
      if (tgId) {
        delete state.links[tgId];
        rebuildIndex();
        saveState();
      }
      return reply(res, 200, { ok: true, removed: !!tgId });
    }

    return reply(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    console.error('[api]', e);
    return reply(res, 500, { ok: false, error: 'internal' });
  }
});

// ---------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------

async function main() {
  loadState();
  setInterval(pruneCodes, 60 * 1000);

  server.listen(config.port, () => console.log('[api] слушаю порт', config.port));

  for (;;) {
    try {
      botInfo = await tg('getMe');
      // Long polling не работает, пока у бота стоит вебхук.
      await tg('deleteWebhook', { drop_pending_updates: false });
      break;
    } catch (e) {
      console.error('[tg] getMe:', e.message, '- повтор через 10 с');
      await new Promise((r) => setTimeout(r, 10000));
    }
  }

  console.log('[tg] бот @' + botInfo.username + ' запущен. Каналов: ' + config.channels.length);

  // Сразу проверяем, что бот - админ в каналах: без этого подписку не проверить.
  for (const c of config.channels) {
    try {
      const me = await tg('getChatMember', { chat_id: c.id, user_id: botInfo.id });
      if (me.status !== 'administrator' && me.status !== 'creator') {
        console.warn('[tg] бот НЕ администратор в ' + c.id + ' — подписку там проверить не получится.');
      } else {
        console.log('[tg] канал ' + c.id + ': бот администратор ✓');
      }
    } catch (e) {
      console.warn('[tg] канал ' + c.id + ': ' + e.message + ' — добавь бота в канал администратором.');
    }
  }

  pollLoop();
}

if (require.main === module) main();

module.exports = { server, state, loadState, rebuildIndex, config, main, onMessage, onCallback, onChatMember };
