// server.js — Investe.pro (Plan B con fix 200 inmediato)
// CommonJS (require) para compatibilidad.

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
const CHANNEL_INVITE_LINK = process.env.CHANNEL_INVITE_LINK || ''; // opcional: link fijo

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

// ====== WEBHOOK TELEGRAM (FIX: responder 200 inmediatamente) ======
app.post('/telegram-webhook', express.json(), (req, res) => {
  // Respondemos ya para evitar 502 por timeouts/proxy.
  res.status(200).end();

  try {
    console.log('🟡 TG update recibido:', JSON.stringify(req.body));
    bot.processUpdate(req.body);
  } catch (e) {
    console.error('Error processUpdate:', e);
  }
});

// ====== FLUJO BOT ======
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
  // Ignora comandos (el /start ya se maneja)
  if (msg.text && msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const fromId = msg.from.id.toString();
  const text = (msg.text || '').trim().toLowerCase();

  // Validación básica de correo
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    return bot.sendMessage(chatId, '⚠️ Eso no parece un correo válido. Intenta de nuevo.');
  }

  try {
    // Buscar cliente por email
    const customers = await stripe.customers.list({ email: text, limit: 1 });
    if (customers.data.length === 0) {
      return bot.sendMessage(
        chatId,
        '❌ No encontré ninguna suscripción con ese correo. Verifica y vuelve a intentar.'
      );
    }

    const customer = customers.data[0];

    // Verificar suscripción activa
    const subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 1
    });

    if (subs.data.length === 0) {
      return bot.sendMessage(
        chatId,
        '⚠️ Tu suscripción no está activa. Si acabas de pagar, espera 1–2 minutos y vuelve a intentar.'
      );
    }

    // Marcar como verificado en RAM
    verifiedUserIds.add(fromId);

    // Guardar mapping en Stripe (para expulsión futura por webhook)
    const meta = customer.metadata || {};
    if (meta.telegram_user_id !== fromId) {
      await stripe.customers.update(customer.id, {
        metadata: { ...meta, telegram_user_id: fromId }
      });
    }

    // Dar link de solicitud de unión (join request)
    await ensureInviteLink();
    if (!inviteLink) {
      return bot.sendMessage(chatId, '⚠️ No pude generar el enlace de acceso. Intenta de nuevo en un momento.');
    }

    await bot.sendMessage(
      chatId,
      '✅ Suscripción verificada.\n\nToca este enlace para *solicitar acceso* al canal privado (se aprueba automáticamente):\n' +
        inviteLink
    );
  } catch (err) {
    console.error('Error verificando suscripción:', err);
    bot.sendMessage(chatId, '❌ Ocurrió un error al verificar. Intenta nuevamente en unos segundos.');
  }
});

// Aprobar/rechazar join request
bot.on('chat_join_request', async (update) => {
  try {
    const userId = update.from.id.toString();

    if (verifiedUserIds.has(userId)) {
      await bot.approveChatJoinRequest(CHANNEL_ID, update.from.id);
      await bot.sendMessage(userId, '🎉 Acceso concedido. ¡Bienvenido al canal privado Investe.pro!');
    } else {
      await bot.declineChatJoinRequest(CHANNEL_ID, update.from.id);
      await bot.sendMessage(userId, '❌ Debes verificar tu suscripción. Escribe /start y envía tu correo de Stripe.');
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
              '🚫 Tu suscripción no está activa. Te hemos retirado del canal. Si renuevas, vuelve a verificar enviando tu correo con /start.'
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
