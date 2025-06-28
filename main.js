require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const TonWeb = require('tonweb');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const app = express();
app.use(express.json());

const db = new sqlite3.Database('./gift_shop.db');

// Инициализация TON
const tonweb = new TonWeb(new TonWeb.HttpProvider('https://toncenter.com/api/v2/jsonRPC'));
const tonWalletAddress = process.env.TON_WALLET_ADDRESS;
const toncenterApiKey = process.env.TONCENTER_API_KEY;

const ADMINS = [7424750473];
const DEFAULT_LANG = 'ru';

const MESSAGES = {
  ru: {
    start: '👋 Добро пожаловать в магазин подарков!',
    catalog: '🛍 Каталог подарков:',
    inventory: '🎒 Ваш инвентарь:',
    no_gifts: 'Подарков пока нет.',
    choose_language: '🌐 Выберите язык:',
    success: '✅ Успешно!',
    enter_price: '💰 Введите цену для выставления на продажу:',
    invalid_price: '❌ Неверный формат цены.',
    added: '🎁 Подарок добавлен!',
    menu: '📋 Главное меню',
    enter_name: '📝 Введите название подарка:',
    enter_description: '📃 Введите описание подарка:',
    choose_rarity: '🌟 Выберите редкость подарка:',
    listed: '📦 Подарок выставлен на продажу!',
    removed_from_sale: '❌ Подарок снят с продажи',
    purchase_success: '✅ Покупка завершена!',
    insufficient_funds: '❌ Недостаточно средств для покупки.',
    already_for_sale: '❌ Этот подарок уже выставлен на продажу.'
  },
  // Добавь другие языки по необходимости
};

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    lang TEXT DEFAULT '${DEFAULT_LANG}'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS gifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER,
    name TEXT,
    description TEXT,
    rarity TEXT,
    price REAL,
    is_for_sale INTEGER DEFAULT 0,
    file_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

function getLang(userId, cb) {
  db.get('SELECT lang FROM users WHERE id = ?', [userId], (err, row) => {
    cb(row?.lang || DEFAULT_LANG);
  });
}

function setLang(userId, lang) {
  db.run('INSERT INTO users (id, lang) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET lang=?', [userId, lang, lang]);
}

function _(userId, key, cb) {
  getLang(userId, lang => {
    cb(MESSAGES[lang]?.[key] || MESSAGES[DEFAULT_LANG][key]);
  });
}

function sendMainMenu(chatId, userId) {
  _(userId, 'menu', (menuText) => {
    bot.sendMessage(chatId, menuText, {
      reply_markup: {
        keyboard: [[
          { text: '🛍 Каталог' },
          { text: '🎒 Инвентарь' }
        ], [
          { text: '🌐 Язык' }
        ]],
        resize_keyboard: true,
        one_time_keyboard: false
      }
    });
  });
}

const userStates = {};

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  if (!userStates[userId]) userStates[userId] = {};
  const state = userStates[userId];

  if (text === '/start') {
    _(userId, 'start', (message) => {
      bot.sendMessage(chatId, message);
      sendMainMenu(chatId, userId);
    });
    return;
  }

  if (text === '🌐 Язык') {
    bot.sendMessage(chatId, 'Выберите язык:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Русский', callback_data: 'lang_ru' }],
          // можно добавить другие языки
        ]
      }
    });
    return;
  }

  if (text === '🛍 Каталог') {
    db.all('SELECT * FROM gifts WHERE is_for_sale = 1', (err, gifts) => {
      if (!gifts.length) {
        _(userId, 'no_gifts', msg => bot.sendMessage(chatId, msg));
        return;
      }
      gifts.forEach(gift => {
        const caption = `🎁 ${gift.name} (${gift.rarity})\n📃 ${gift.description}\n💰 ${gift.price} TON\n🆔 ${gift.id}`;
        bot.sendSticker(chatId, gift.file_id).then(() => {
          bot.sendMessage(chatId, caption, {
            reply_markup: {
              inline_keyboard: [[
                { text: 'Купить', callback_data: `buy_${gift.id}` }
              ]]
            }
          });
        });
      });
    });
    return;
  }

  if (text === '🎒 Инвентарь') {
    db.all('SELECT * FROM gifts WHERE owner_id = ?', [userId], (err, gifts) => {
      if (!gifts.length) return _(userId, 'no_gifts', msg => bot.sendMessage(chatId, msg));
      gifts.forEach(gift => {
        const caption = `🎁 ${gift.name} (${gift.rarity})\n📃 ${gift.description}\n${gift.is_for_sale ? '💰 ' + gift.price + ' TON (на продаже)' : ''}`;
        const buttons = gift.is_for_sale
          ? [{ text: '🔽 Снять с продажи', callback_data: `unsell_${gift.id}` }]
          : [{ text: '📤 Продать', callback_data: `sell_${gift.id}` }];
        bot.sendSticker(chatId, gift.file_id, {
          reply_markup: { inline_keyboard: [buttons] }
        }).then(() => bot.sendMessage(chatId, caption));
      });
    });
    return;
  }

  // Создание подарка — упрощённо, через текстовые сообщения
  if (state.step === 'awaiting_name') {
    state.name = text;
    _(userId, 'enter_description', prompt => bot.sendMessage(chatId, prompt));
    state.step = 'awaiting_description';
    return;
  }

  if (state.step === 'awaiting_description') {
    state.description = text;
    _(userId, 'choose_rarity', prompt => bot.sendMessage(chatId, prompt, {
      reply_markup: {
        inline_keyboard: [[
          { text: '⭐️ Обычный', callback_data: 'rarity_common' },
          { text: '🌟 Редкий', callback_data: 'rarity_rare' },
          { text: '💎 Легендарный', callback_data: 'rarity_legendary' }
        ]]
      }
    }));
    state.step = 'awaiting_rarity';
    return;
  }

  if (state.step === 'awaiting_price') {
    const price = parseFloat(text);
    if (isNaN(price) || price <= 0) {
      _(userId, 'invalid_price', msg => bot.sendMessage(chatId, msg));
      return;
    }
    db.run('UPDATE gifts SET price = ?, is_for_sale = 1 WHERE id = ? AND owner_id = ?', [price, state.giftId, userId], () => {
      _(userId, 'listed', msg => bot.sendMessage(chatId, msg));
      sendMainMenu(chatId, userId);
      delete userStates[userId];
    });
    return;
  }
});

bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  if (data.startsWith('lang_')) {
    const newLang = data.split('_')[1];
    setLang(userId, newLang);
    _(userId, 'success', msg => bot.sendMessage(chatId, msg));
    sendMainMenu(chatId, userId);
    bot.answerCallbackQuery(query.id);
    return;
  }

  if (data.startsWith('rarity_')) {
    const rarity = data.split('_')[1];
    const state = userStates[userId];
    if (!state) return;
    db.run(`INSERT INTO gifts (owner_id, name, description, rarity, file_id) VALUES (?, ?, ?, ?, ?)`,
      [userId, state.name, state.description, rarity, state.file_id], () => {
        _(userId, 'added', msg => bot.sendMessage(chatId, msg));
        sendMainMenu(chatId, userId);
        delete userStates[userId];
      });
    bot.answerCallbackQuery(query.id);
    return;
  }

  if (data.startsWith('sell_')) {
    const giftId = data.split('_')[1];
    userStates[userId] = { step: 'awaiting_price', giftId };
    _(userId, 'enter_price', msg => bot.sendMessage(chatId, msg));
    bot.answerCallbackQuery(query.id);
    return;
  }

  if (data.startsWith('unsell_')) {
    const giftId = data.split('_')[1];
    db.run('UPDATE gifts SET is_for_sale = 0, price = NULL WHERE id = ? AND owner_id = ?', [giftId, userId], () => {
      _(userId, 'removed_from_sale', msg => bot.sendMessage(chatId, msg));
      sendMainMenu(chatId, userId);
    });
    bot.answerCallbackQuery(query.id);
    return;
  }

  if (data.startsWith('buy_')) {
    const giftId = parseInt(data.split('_')[1]);
    db.get('SELECT * FROM gifts WHERE id = ? AND is_for_sale = 1', [giftId], async (err, gift) => {
      if (!gift) {
        bot.sendMessage(chatId, '❌ Подарок не найден или не продается.');
        bot.answerCallbackQuery(query.id);
        return;
      }
      if (gift.owner_id === userId) {
        bot.sendMessage(chatId, '❌ Это ваш подарок.');
        bot.answerCallbackQuery(query.id);
        return;
      }

      try {
        // Проверяем баланс покупателя через TonWeb
        const wallet = tonweb.wallet.create({ publicKey: Buffer.from('00', 'hex') }); // Здесь можно доработать под реальные ключи
        const balance = await tonweb.provider.getBalance(tonWalletAddress);
        if (balance < gift.price * 1e9) {
          _(userId, 'insufficient_funds', msg => bot.sendMessage(chatId, msg));
          bot.answerCallbackQuery(query.id);
          return;
        }

        // TODO: Реализовать перевод TON с покупателя продавцу через TON API

        // Обновляем владельца и снимаем с продажи
        db.run('UPDATE gifts SET owner_id = ?, is_for_sale = 0, price = NULL WHERE id = ?', [userId, giftId], () => {
          _(userId, 'purchase_success', msg => bot.sendMessage(chatId, msg));
          sendMainMenu(chatId, userId);
          bot.answerCallbackQuery(query.id);
        });
      } catch (e) {
        bot.sendMessage(chatId, '❌ Ошибка при покупке: ' + e.message);
        bot.answerCallbackQuery(query.id);
      }
    });
    return;
  }
});

// --- Веб-сервер для простого статуса и API (пример) ---
app.get('/', (req, res) => {
  res.send('🎁 Gift Shop Bot is running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
