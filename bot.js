// Универсальный демо-бот для Telegram (Node.js + grammY).
process.env.TZ = process.env.TZ || 'Europe/Moscow';

import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ===================== НАСТРОЙКИ =====================
const TOKEN = process.env.BOT_TOKEN || '8985257496:AAFg99so12mVX6jR3HwzsoG77A6kBEoF2nE';
const ADMIN_ID = Number(process.env.ADMIN_ID || 0);

const SERVICES = [
  { id: 'consult', emoji: '💬', name: 'Консультация, 30 мин', price: 1000 },
  { id: 'diag', emoji: '🔍', name: 'Диагностика, 60 мин', price: 2000 },
  { id: 'full', emoji: '⭐', name: 'Полный пакет, 90 мин', price: 3500 },
];
const SLOTS = ['10:00', '11:30', '13:00', '14:30', '16:00', '17:30', '19:00'];
const DAYS_AHEAD = 5;
const REMIND_HOURS = 2;

const PRODUCTS = [
  { id: 'start', emoji: '🌱', name: 'Тариф Старт', price: 990, text: 'Базовый набор для знакомства.' },
  { id: 'std', emoji: '🚀', name: 'Тариф Стандарт', price: 1990, text: 'Самый популярный вариант.' },
  { id: 'pro', emoji: '👑', name: 'Тариф Премиум', price: 3990, text: 'Максимум возможностей и поддержка.' },
];
const FAQ = [
  { q: 'Как оформить заказ?', a: 'Откройте «Каталог и заказ», добавьте товары в корзину и нажмите «Оформить».' },
  { q: 'Как отменить запись?', a: 'Раздел «Запись на услугу», затем «Мои записи»: у каждой записи есть кнопка отмены.' },
  { q: 'Как с вами связаться?', a: 'Оставьте заявку в боте, мы перезвоним в рабочее время (пн–вс, 10:00–20:00).' },
];
// =====================================================

const DATA_FILE = process.env.DATA_FILE || join(dirname(fileURLToPath(import.meta.url)), 'data.json');
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

if (!TOKEN || TOKEN.includes('ВСТАВЬТЕ')) {
  console.error('Не задан токен бота. Укажите BOT_TOKEN (переменная окружения) или вставьте токен в TOKEN.');
  process.exit(1);
}
const bot = new Bot(TOKEN);

// ---------- хранилище ----------
const empty = { bookings: [], orders: [], leads: [], ratings: [], users: [], subs: [], orderSeq: 0 };
const db = { ...empty, ...(existsSync(DATA_FILE) ? JSON.parse(readFileSync(DATA_FILE, 'utf8')) : {}) };
const save = () => writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
const carts = new Map();
const forms = new Map();

// ---------- вспомогательные функции ----------
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n) => `${n.toLocaleString('ru-RU')} ₽`;
const isAdmin = (ctx) => ADMIN_ID && ctx.from?.id === ADMIN_ID;
const notifyAdmin = (text) => ADMIN_ID && bot.api.sendMessage(ADMIN_ID, text, { parse_mode: 'HTML' }).catch((e) => console.error('Админу:', e.message));
function iso(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function labelOfIso(s) {
  if (s === iso(0)) return 'сегодня';
  if (s === iso(1)) return 'завтра';
  const d = new Date(`${s}T12:00:00`);
  return `${WD[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
}
const dayLabel = (off) => (off === 0 ? 'Сегодня' : off === 1 ? 'Завтра' : labelOfIso(iso(off)));
const startOf = (b) => new Date(`${b.date}T${b.time}:00`);
const svcOf = (id) => SERVICES.find((s) => s.id === id);
const prodOf = (id) => PRODUCTS.find((p) => p.id === id);
const isTaken = (date, time) => db.bookings.some((b) => b.date === date && b.time === time);
function slotPassed(off, time) {
  if (off !== 0) return false;
  const [h, m] = time.split(':').map(Number);
  const t = new Date();
  t.setHours(h, m, 0, 0);
  return t.getTime() < Date.now() + 30 * 60 * 1000;
}
const freeSlots = (off) => SLOTS.map((t, i) => ({ t, i })).filter(({ t }) => !slotPassed(off, t) && !isTaken(iso(off), t));
function trackUser(ctx) {
  if (ctx.from && !db.users.some((u) => u.id === ctx.from.id)) {
    db.users.push({ id: ctx.from.id, name: ctx.from.first_name ?? '' });
    save();
  }
}

// ---------- напоминания о записи ----------
const timers = new Map();
const remindText = (b) =>
  `🔔 <b>Напоминание</b>\nСегодня в ${b.time}: ${esc(svcOf(b.svc)?.name ?? 'ваша запись')}.\nЕсли планы изменились, откройте «Запись на услугу», затем «Мои записи» и отмените запись.`;
function scheduleReminder(b) {
  const delay = startOf(b).getTime() - REMIND_HOURS * 3600 * 1000 - Date.now();
  if (delay <= 0 || delay > 2 ** 31 - 1) return;
  timers.set(b.id, setTimeout(() => {
    bot.api.sendMessage(b.userId, remindText(b), { parse_mode: 'HTML' }).catch((e) => console.error('Напоминание:', e.message));
    timers.delete(b.id);
  }, delay));
}
db.bookings.forEach(scheduleReminder);

// ---------- клавиатуры и показ сообщений ----------
const menuKb = () =>
  new InlineKeyboard()
    .text('📅 Запись на услугу', 'book').text('🛍 Каталог и заказ', 'shop').row()
    .text('📝 Оставить заявку', 'lead').text('❓ Частые вопросы', 'faq').row()
    .text('🔔 Рассылки', 'sub').text('⭐ Оценить демо', 'rate').row()
    .text('✨ Что ещё умеет бот', 'more');
const homeKb = () => new InlineKeyboard().text('🏠 В меню', 'menu');

async function show(ctx, text, kb) {
  const extra = { parse_mode: 'HTML', reply_markup: kb };
  try {
    await ctx.editMessageText(text, extra);
  } catch (e) {
    if (!String(e.description ?? e.message).includes('not modified')) await ctx.reply(text, extra);
  }
}
const welcome = (name) =>
  `Привет, ${esc(name)}! 👋\nЭто <b>демо-бот</b>: здесь собраны возможности, которые можно подключить в любом бизнесе. Запись, заказы, заявки, ответы на вопросы, рассылки и напоминания.\n\nНажимайте кнопки и пробуйте как клиент 👇`;

// ---------- команды ----------
bot.command('start', (ctx) => {
  trackUser(ctx);
  return ctx.reply(welcome(ctx.from?.first_name ?? 'гость'), { parse_mode: 'HTML', reply_markup: menuKb() });
});
bot.command('help', (ctx) => ctx.reply('Нажмите /start, чтобы открыть меню. Все функции доступны кнопками.'));
bot.command('myid', (ctx) => ctx.reply(`Ваш Telegram ID: ${ctx.from?.id}`));

bot.command('admin', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Нет доступа. Задайте ADMIN_ID (ваш ID покажет команда /myid).');
  const up = db.bookings.filter((b) => startOf(b) > new Date()).sort((a, b) => startOf(a) - startOf(b));
  const avg = db.ratings.length ? (db.ratings.reduce((s, r) => s + r.value, 0) / db.ratings.length).toFixed(1) : '—';
  const lines = [
    `👥 Пользователей: ${db.users.length}, подписчиков рассылки: ${db.subs.length}`,
    `⭐ Средняя оценка: ${avg} (${db.ratings.length})`,
    `📅 Ближайшие записи (${up.length}):`,
    ...up.slice(0, 8).map((b) => `   ${labelOfIso(b.date)} ${b.time}: ${svcOf(b.svc)?.name}, ${b.userName}`),
    `🛍 Заказов: ${db.orders.length}` + (db.orders.length ? `, последний №${db.orders.at(-1).num} на ${money(db.orders.at(-1).total)}` : ''),
    `📝 Заявок: ${db.leads.length}` + (db.leads.length ? `, последняя: ${db.leads.at(-1).name}, ${db.leads.at(-1).phone}` : ''),
    '',
    'Рассылка: /broadcast текст',
  ];
  return ctx.reply(lines.join('\n'));
});

bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Нет доступа.');
  const text = String(ctx.match ?? '').trim();
  if (!text) return ctx.reply('Напишите текст после команды: /broadcast Скидка 10% до пятницы!');
  let ok = 0;
  for (const id of db.subs) {
    try { await bot.api.sendMessage(id, `📢 ${text}`); ok++; } catch { /* пользователь заблокировал бота */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return ctx.reply(`Рассылка отправлена: ${ok} из ${db.subs.length}.`);
});

// ---------- кнопки ----------
bot.on('callback_query:data', async (ctx, next) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await next();
});

bot.callbackQuery('menu', (ctx) => show(ctx, welcome(ctx.from?.first_name ?? 'гость'), menuKb()));

// ----- запись на услугу -----
bot.callbackQuery('book', (ctx) => {
  const kb = new InlineKeyboard();
  SERVICES.forEach((s) => kb.text(`${s.emoji} ${s.name}, ${money(s.price)}`, `svc:${s.id}`).row());
  kb.text('📋 Мои записи', 'my').row().text('🏠 В меню', 'menu');
  return show(ctx, '📅 <b>Запись на услугу</b>\nВыберите услугу:', kb);
});

bot.callbackQuery(/^svc:(\w+)$/, (ctx) => {
  const s = svcOf(ctx.match[1]);
  if (!s) return show(ctx, 'Не нашёл услугу, начнём заново.', menuKb());
  const kb = new InlineKeyboard();
  for (let off = 0; off < DAYS_AHEAD; off++) {
    const n = freeSlots(off).length;
    if (n) kb.text(`${dayLabel(off)} (свободно: ${n})`, `day:${s.id}:${off}`).row();
  }
  kb.text('⬅️ Назад', 'book');
  return show(ctx, `${s.emoji} <b>${esc(s.name)}</b>\n\nВыберите день:`, kb);
});

bot.callbackQuery(/^day:(\w+):(\d+)$/, (ctx) => {
  const [, svc, offS] = ctx.match;
  const off = Number(offS);
  const free = freeSlots(off);
  const kb = new InlineKeyboard();
  free.forEach(({ t, i }, k) => {
    kb.text(t, `tm:${svc}:${off}:${i}`);
    if (k % 3 === 2) kb.row();
  });
  kb.row().text('⬅️ Назад', `svc:${svc}`);
  return show(ctx, free.length ? `🗓 <b>${dayLabel(off)}</b>\n\nВыберите время:` : 'На этот день всё занято, выберите другой.', kb);
});

bot.callbackQuery(/^tm:(\w+):(\d+):(\d+)$/, (ctx) => {
  const [, svc, off, i] = ctx.match;
  const s = svcOf(svc), time = SLOTS[Number(i)];
  if (!s || !time) return show(ctx, 'Не нашёл данные, начнём заново.', menuKb());
  return show(ctx,
    `Проверьте запись:\n\n${s.emoji} ${esc(s.name)}, <b>${money(s.price)}</b>\n🗓 ${labelOfIso(iso(Number(off)))}, ${time}`,
    new InlineKeyboard().text('✅ Подтвердить', `ok:${svc}:${off}:${i}`).row().text('⬅️ Изменить время', `day:${svc}:${off}`));
});

bot.callbackQuery(/^ok:(\w+):(\d+):(\d+)$/, async (ctx) => {
  const [, svc, offS, i] = ctx.match;
  const off = Number(offS), time = SLOTS[Number(i)], date = iso(off), s = svcOf(svc);
  if (!s || !time) return show(ctx, 'Не нашёл данные, начнём заново.', menuKb());
  if (isTaken(date, time) || slotPassed(off, time)) {
    return show(ctx, 'Это время уже занято. Выберите другое 🙏', new InlineKeyboard().text('⬅️ К выбору времени', `day:${svc}:${off}`));
  }
  const b = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    userId: ctx.from.id, userName: ctx.from.first_name ?? 'Клиент', svc, date, time,
  };
  db.bookings.push(b);
  save();
  scheduleReminder(b);
  await show(ctx,
    `✅ <b>Вы записаны!</b>\n\n${s.emoji} ${esc(s.name)}, ${money(s.price)}\n🗓 ${labelOfIso(date)}, ${time}\n\nНапомню за ${REMIND_HOURS} ч до визита 🔔`,
    new InlineKeyboard()
      .text('🔔 Показать пример напоминания', `demo:${b.id}`).row()
      .text('📋 Мои записи', 'my').text('🏠 В меню', 'menu'));
  notifyAdmin(`🆕 <b>Новая запись</b>\n${esc(s.name)}\n${labelOfIso(date)} ${time}\nКлиент: ${esc(b.userName)}`);
});

bot.callbackQuery(/^demo:(\w+)$/, (ctx) => {
  const b = db.bookings.find((x) => x.id === ctx.match[1]);
  return ctx.reply(b ? remindText(b) : 'Запись не найдена.', { parse_mode: 'HTML' });
});

bot.callbackQuery('my', (ctx) => {
  const mine = db.bookings.filter((b) => b.userId === ctx.from.id && startOf(b) > new Date()).sort((a, b) => startOf(a) - startOf(b));
  if (!mine.length) {
    return show(ctx, '📋 У вас пока нет записей.', new InlineKeyboard().text('📅 Записаться', 'book').row().text('🏠 В меню', 'menu'));
  }
  const kb = new InlineKeyboard();
  mine.slice(0, 5).forEach((b) => kb.text(`❌ Отменить ${labelOfIso(b.date)} ${b.time}`, `cx:${b.id}`).row());
  kb.text('🏠 В меню', 'menu');
  const lines = mine.map((b) => `• ${labelOfIso(b.date)} ${b.time}: ${svcOf(b.svc)?.name}`);
  return show(ctx, `📋 <b>Ваши записи</b>\n\n${esc(lines.join('\n'))}`, kb);
});

bot.callbackQuery(/^cx:(\w+)$/, async (ctx) => {
  const idx = db.bookings.findIndex((b) => b.id === ctx.match[1] && b.userId === ctx.from.id);
  if (idx < 0) return show(ctx, 'Запись не найдена.', menuKb());
  const [b] = db.bookings.splice(idx, 1);
  save();
  clearTimeout(timers.get(b.id));
  timers.delete(b.id);
  await show(ctx, `Запись на ${labelOfIso(b.date)} в ${b.time} отменена. Время снова свободно.`,
    new InlineKeyboard().text('📅 Записаться снова', 'book').row().text('🏠 В меню', 'menu'));
  notifyAdmin(`❌ <b>Отмена записи</b>\n${labelOfIso(b.date)} ${b.time}, ${esc(b.userName)}`);
});

// ----- каталог и заказ -----
bot.callbackQuery('shop', (ctx) => {
  const kb = new InlineKeyboard();
  PRODUCTS.forEach((p) => kb.text(`${p.emoji} ${p.name}, ${money(p.price)}`, `item:${p.id}`).row());
  kb.text('🛒 Корзина', 'cart').text('🏠 В меню', 'menu');
  return show(ctx, '🛍 <b>Каталог</b>\nВыберите товар:', kb);
});

bot.callbackQuery(/^item:(\w+)$/, (ctx) => {
  const p = prodOf(ctx.match[1]);
  if (!p) return show(ctx, 'Товар не найден.', menuKb());
  return show(ctx, `${p.emoji} <b>${esc(p.name)}</b>\n${esc(p.text)}\n\nЦена: <b>${money(p.price)}</b>`,
    new InlineKeyboard().text('➕ В корзину', `add:${p.id}`).row().text('🛒 Корзина', 'cart').text('⬅️ Каталог', 'shop'));
});

bot.callbackQuery(/^add:(\w+)$/, async (ctx) => {
  const p = prodOf(ctx.match[1]);
  if (!p) return;
  const cart = carts.get(ctx.from.id) ?? {};
  cart[p.id] = (cart[p.id] ?? 0) + 1;
  carts.set(ctx.from.id, cart);
  const count = Object.values(cart).reduce((a, b) => a + b, 0);
  await show(ctx, `✅ ${esc(p.name)} добавлен в корзину.\nВ корзине товаров: ${count}`,
    new InlineKeyboard().text('🛒 Открыть корзину', 'cart').row().text('⬅️ Продолжить выбор', 'shop'));
});

function cartView(uid) {
  const cart = carts.get(uid) ?? {};
  const rows = Object.entries(cart).filter(([id]) => prodOf(id)).map(([id, q]) => ({ p: prodOf(id), q }));
  return { rows, total: rows.reduce((s, r) => s + r.p.price * r.q, 0) };
}

bot.callbackQuery('cart', (ctx) => {
  const { rows, total } = cartView(ctx.from.id);
  if (!rows.length) return show(ctx, '🛒 Корзина пуста.', new InlineKeyboard().text('🛍 В каталог', 'shop').row().text('🏠 В меню', 'menu'));
  const lines = rows.map((r) => `${r.p.emoji} ${esc(r.p.name)} × ${r.q} = ${money(r.p.price * r.q)}`);
  return show(ctx, `🛒 <b>Корзина</b>\n\n${lines.join('\n')}\n\nИтого: <b>${money(total)}</b>`,
    new InlineKeyboard().text('✅ Оформить заказ', 'checkout').row().text('🗑 Очистить', 'cartclear').text('⬅️ Каталог', 'shop'));
});

bot.callbackQuery('cartclear', (ctx) => {
  carts.delete(ctx.from.id);
  return show(ctx, 'Корзина очищена.', new InlineKeyboard().text('🛍 В каталог', 'shop').row().text('🏠 В меню', 'menu'));
});

bot.callbackQuery('checkout', async (ctx) => {
  const { rows, total } = cartView(ctx.from.id);
  if (!rows.length) return show(ctx, '🛒 Корзина пуста.', new InlineKeyboard().text('🛍 В каталог', 'shop'));
  const num = ++db.orderSeq;
  db.orders.push({ num, userId: ctx.from.id, name: ctx.from.first_name ?? 'Клиент', total, items: rows.map((r) => ({ id: r.p.id, q: r.q })), createdAt: new Date().toISOString() });
  save();
  carts.delete(ctx.from.id);
  await show(ctx,
    `🎉 <b>Заказ №${num} принят!</b>\nСумма: ${money(total)}\n\n<i>В рабочем боте на этом шаге подключается оплата картой или через СБП, и клиент сразу получает чек.</i>`,
    homeKb());
  notifyAdmin(`🛍 <b>Новый заказ №${num}</b>\n${rows.map((r) => `${esc(r.p.name)} × ${r.q}`).join('\n')}\nИтого: ${money(total)}\nКлиент: ${esc(ctx.from.first_name ?? '')}`);
});

// ----- заявка с формой -----
bot.callbackQuery('lead', (ctx) => {
  forms.set(ctx.from.id, { step: 'name', data: {} });
  return ctx.reply('📝 <b>Заявка</b>\nКак вас зовут? (чтобы выйти, напишите «Отмена»)', { parse_mode: 'HTML' });
});

const phoneKb = () => new Keyboard().requestContact('📱 Отправить мой номер').row().text('Пропустить').resized().oneTime();
async function finishLead(ctx, f) {
  forms.delete(ctx.from.id);
  const lead = { id: Date.now().toString(36), userId: ctx.from.id, ...f.data, createdAt: new Date().toISOString() };
  db.leads.push(lead);
  save();
  await ctx.reply(`Спасибо, ${lead.name}! Заявка принята. Мы свяжемся с вами в рабочее время 🙌`, { reply_markup: { remove_keyboard: true } });
  await ctx.reply('Вернуться в меню:', { reply_markup: menuKb() });
  notifyAdmin(`📝 <b>Новая заявка</b>\nИмя: ${esc(lead.name)}\nТелефон: ${esc(lead.phone)}\nКомментарий: ${esc(lead.comment)}`);
}

bot.on('message:contact', async (ctx) => {
  const f = forms.get(ctx.from.id);
  if (!f || f.step !== 'phone') return;
  f.data.phone = ctx.message.contact.phone_number;
  f.step = 'comment';
  await ctx.reply('Коротко опишите, что нужно (или напишите «Пропустить»):', { reply_markup: { remove_keyboard: true } });
});

bot.on('message:text', async (ctx) => {
  const f = forms.get(ctx.from.id);
  if (!f) return ctx.reply('Я лучше всего понимаю кнопки 🙂 Откройте меню:', { reply_markup: menuKb() });
  const t = ctx.message.text.trim();
  if (/^(отмена|\/cancel)$/i.test(t)) {
    forms.delete(ctx.from.id);
    await ctx.reply('Заявка отменена.', { reply_markup: { remove_keyboard: true } });
    return ctx.reply('Меню:', { reply_markup: menuKb() });
  }
  if (f.step === 'name') {
    f.data.name = t.slice(0, 60);
    f.step = 'phone';
    return ctx.reply('Оставьте номер телефона: нажмите кнопку ниже или напишите его текстом.', { reply_markup: phoneKb() });
  }
  if (f.step === 'phone') {
    if (/^пропустить$/i.test(t)) f.data.phone = 'не указан';
    else if (t.replace(/\D/g, '').length >= 10) f.data.phone = t.slice(0, 30);
    else return ctx.reply('Не похоже на номер. Введите его ещё раз или нажмите «Пропустить».');
    f.step = 'comment';
    return ctx.reply('Коротко опишите, что нужно (или напишите «Пропустить»):', { reply_markup: { remove_keyboard: true } });
  }
  f.data.comment = /^пропустить$/i.test(t) ? '—' : t.slice(0, 300);
  return finishLead(ctx, f);
});

// ----- частые вопросы -----
bot.callbackQuery('faq', (ctx) => {
  const kb = new InlineKeyboard();
  FAQ.forEach((f, i) => kb.text(f.q, `faq:${i}`).row());
  kb.text('🏠 В меню', 'menu');
  return show(ctx, '❓ <b>Частые вопросы</b>\nВыберите вопрос:', kb);
});
bot.callbackQuery(/^faq:(\d+)$/, (ctx) => {
  const f = FAQ[Number(ctx.match[1])];
  if (!f) return;
  return show(ctx, `❓ <b>${esc(f.q)}</b>\n\n${esc(f.a)}`, new InlineKeyboard().text('⬅️ К вопросам', 'faq').text('🏠 В меню', 'menu'));
});

// ----- рассылки -----
bot.callbackQuery('sub', (ctx) => {
  const i = db.subs.indexOf(ctx.from.id);
  if (i >= 0) db.subs.splice(i, 1); else db.subs.push(ctx.from.id);
  save();
  const on = i < 0;
  return show(ctx,
    on ? '🔔 <b>Вы подписались на новости и акции.</b>\nВладелец отправляет рассылку одной командой, и она приходит всем подписчикам.'
       : '🔕 Вы отписались от рассылки. Подписаться снова можно в любой момент.',
    new InlineKeyboard().text(on ? '🔕 Отписаться' : '🔔 Подписаться', 'sub').row().text('🏠 В меню', 'menu'));
});

// ----- оценка -----
bot.callbackQuery('rate', (ctx) => {
  const kb = new InlineKeyboard();
  [1, 2, 3, 4, 5].forEach((n) => kb.text(`${n} ⭐`, `rate:${n}`));
  kb.row().text('🏠 В меню', 'menu');
  return show(ctx, '⭐ <b>Оцените демо</b>\nТак бот собирает отзывы клиентов:', kb);
});
bot.callbackQuery(/^rate:([1-5])$/, async (ctx) => {
  const value = Number(ctx.match[1]);
  db.ratings.push({ userId: ctx.from.id, value, at: new Date().toISOString() });
  save();
  await show(ctx, `Спасибо за оценку: ${'⭐'.repeat(value)}\nВ рабочем боте низкие оценки сразу приходят владельцу, чтобы он мог всё исправить.`, homeKb());
  notifyAdmin(`⭐ Новая оценка: ${value} от ${esc(ctx.from.first_name ?? '')}`);
});

// ----- что ещё -----
bot.callbackQuery('more', (ctx) =>
  show(ctx,
    '✨ <b>Что ещё можно подключить</b>\n\n• Оплата прямо в чате (карты, СБП)\n• Выгрузка заявок в Google Таблицы и CRM\n• Ответы на вопросы с ИИ по вашей базе знаний\n• Уведомления команде в рабочий чат\n• Несколько языков\n\n👨‍💼 <b>Для владельца</b> (после настройки ADMIN_ID): /admin со сводкой и /broadcast для рассылки.',
    homeKb()));

// любые другие сообщения (стикеры, фото и т.д.)
bot.on('message', (ctx) => ctx.reply('Я лучше всего понимаю кнопки 🙂 Откройте меню:', { reply_markup: menuKb() }));

bot.catch((err) => console.error('Ошибка бота:', err.error?.message ?? err));

bot.api.setMyCommands([
  { command: 'start', description: 'Открыть меню' },
  { command: 'help', description: 'Помощь' },
]).catch(() => {});

bot.start({ onStart: (me) => console.log(`Бот @${me.username} запущен`) });
