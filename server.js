// server.js — Investe.pro (Plan B + fix webhook 200 inmediato)
// CommonJS para compatibilidad.

const express = require('express');
const bodyParser = require('body-parser');
const Stripe = require('stripe');
const TelegramBot = require('node-telegram-bot-api');

const app = express();

// ====== ENV ======
const PORT = process.env.PORT || 10000;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHANNEL_ID = process.env.CHANNEL_ID; // ej: -1003161708891
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const CHANNEL_INVITE_LINK = process.env.CHANNEL_INVITE_LINK || ''; // opcional

// ====== CLIENTES ======
const stripe = Stripe(STRIPE_SECRET_KEY);
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// ====== MEMORIA EN RAM ======
const verifiedUserIds = new Set();
let inviteLink = CHANNEL_INVITE_LINK || null;

// ⚠️ Stripe necesita raw ANTES del JSON parser
app.post('/webhook', express.raw({ type: 'application/json' }), stripeWebhook);

// El resto de rutas usan JSON normal
app.use(bodyParser.json());

// Salud
app.get('/', (_req, res) => res.send('Investe.pro bot OK 🚀'));

// ====== WEBHOOK TELEGRAM (responder 200 inmediato) ======
app.post('/telegram-webhook', express.json(), async (req, res) => {
  // Responder YA para evitar 502 por timeouts de proxy
  res.status(200).send('OK');

  try {
    console.log('🟡 TG update recibido:', JSON.stringify(req.body));
    await bot.processUpdate(req.body);
  } catch (e) {
    console.error('❌ Error en Telegram webhook:', e);
  }
});

// ====== FLUJO DEL BOT ======
bot.onText(/^\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await ensureInviteLink();
  const text =
    '👋 Bienvenido a *Investe.pro*.\n\n' +
    'Para confirmar tu suscripción, envíame el **correo** con el que realizaste el pago en Stripe.\n\n' +
    '_Ejemplo:_ `tunombre@gmail.com`\n\n' +
    'Si aún no pagaste, completa tu pago y vuelve aquí.';
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

bot.on('message', async (msg) => {
  // Ignora comandos; /start ya está manejado
  if (msg.text && msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const fromId = msg.from.id.toString();
  const text = (msg.text || '').trim().toLowerCase();

  // Validación rápida de email
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    return bot.sendMessage(chatId, '⚠️ Ese no parece un correo válido. Intenta de nuevo.');
  }

  try {
    // 1) Cliente por email
    const customers = await stripe.customers.list({ email: text, limit: 1 });
    if (customers.data.length === 0) {
      return bot.sendMessage(chatId, '❌ No encontré una suscripción con ese correo.');
    }
    const customer = customers.data[0];

    // 2) Suscripción activa
    const subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 1
    });
    if (subs.data.length === 0) {
      return bot.sendMessage(chatId, '⚠️ Tu suscripción no está activa. Si pagaste recién, espera 1–2 min y reintenta.');
    }

    // 3) Marcar verificado
    verifiedUserIds.add(fromId);

    // 4) Guardar mapeo en metadata (para expulsar con webhook)
    const meta = customer.metadata || {};
    if (meta.telegram_user_id !== fromId) {
      await stripe.customers.update(customer.id, {
        metadata: { ...meta, telegram_user_id: fromId }
      });
    }

    // 5) Enviar link de solicitud (join request)
    await ensureInviteLink();
    if (!inviteLink) {
      return bot.sendMessage(chatId, '⚠️ No pude generar el enlace. Intenta nuevamente.');
    }

    await bot.sendMessage(
      chatId,
      '✅ Suscripción verificada.\n\nToca este enlace para *solicitar acceso* al canal privado (se aprueba automáticamente):\n' +
        inviteLink
    );
  } catch (err) {
    console.error('Error verificando suscripción:', err);
    bot.sendMessage(chatId, '❌ Ocurrió un error al verificar. Intenta otra vez en unos segundos.');
  }
});

// Aprobación/rechazo de solicitudes
bot.on('chat_join_request', async (update) => {
  try {
    const userId = update.from.id.toString();
    if (verifiedUserIds.has(userId)) {
      await bot.approveChatJoinRequest(CHANNEL_ID, update.from.id);
      await bot.sendMessage(userId, '🎉 Acceso concedido. ¡Bienvenido al canal privado Investe.pro!');
    } else {
      await bot.declineChatJoinRequest(CHANNEL_ID, update.from.id);
      await bot.sendMessage(userId, '❌ Verifica tu suscripción enviando tu correo con /start.');
    }
  } catch (e) {
    console.error('Error en chat_join_request:', e);
  }
});

// ====== STRIPE WEBHOOK ======
async function stripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'customer.subscription.deleted':
      case 'invoice.payment_failed': {
        const obj = event.data.object;
        const customerId = obj.customer || obj.customer_id;
        if (!customerId) break;

        const customer = await stripe.customers.retrieve(customerId);
        const tgId = customer.metadata?.telegram_user_id;

        if (tgId) {
          try {
            await bot.banChatMember(CHANNEL_ID, Number(tgId));
            await bot.unbanChatMember(CHANNEL_ID, Number(tgId));
            await bot.sendMessage(
              tgId,
              '🚫 Tu suscripción no está activa. Te retiramos del canal. Si renuevas, vuelve a verificar con /start.'
            );
          } catch (kickErr) {
            console.error('Error expulsando usuario:', kickErr);
          }
        }
        break;
      }
      case 'checkout.session.completed': {
        // opcional: acciones extra
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Error manejando webhook:', err);
    res.status(500).send('Server error');
  }
}

// ====== HELPERS ======
async function ensureInviteLink() {
  if (inviteLink) return;
  try {
    const link = await bot.createChatInviteLink(CHANNEL_ID, {
      name: 'Acceso semanal Investe.pro',
      creates_join_request: true,
      expire_date: 0,
      member_limit: 0
    });
    inviteLink = link.invite_link;
    console.log('Invite link creado:', inviteLink);
  } catch (e) {
    console.error('No pude crear invite link:', e.message);
  }
}

async function setTelegramWebhook() {
  try {
    const publicBase = 'https://ach-telegram-bot.onrender.com';
    const url = `${publicBase}/telegram-webhook`;
    const res = await bot.setWebHook(url);
    console.log('Telegram webhook set:', res);
  } catch (e) {
    console.error('Error setting Telegram webhook:', e);
  }
}

// ====== ARRANQUE ======
app.listen(PORT, async () => {
  console.log(`Server escuchando en puerto ${PORT}`);
  await setTelegramWebhook();
  await ensureInviteLink();
});