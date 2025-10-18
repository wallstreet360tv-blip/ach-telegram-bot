// server.js — Bot Telegram + Stripe + Email + Aprobaciones (webhook Telegram, no polling)

const express = require('express');
const bodyParser = require('body-parser');
const Stripe = require('stripe');
const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();

// ====== ENV obligatorias ======
const {
  PORT = 10000,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_ID,
  TELEGRAM_BOT_TOKEN,
  BOT_USERNAME,           // sin @, ej: InvestetetrisBot
  CHANNEL_ID,             // ej: -1003161708891
  SERVER_URL,             // ej: https://ach-telegram-bot.onrender.com
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  FROM_EMAIL,
  PORTAL_RETURN_URL
} = process.env;

[
  'STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_PRICE_ID',
  'TELEGRAM_BOT_TOKEN','BOT_USERNAME','CHANNEL_ID','SERVER_URL',
  'SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','FROM_EMAIL'
].forEach(k => {
  if (!process.env[k]) {
    console.error(`❌ Falta variable de entorno: ${k}`);
  }
});

const stripe = Stripe(STRIPE_SECRET_KEY);
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { webHook: true });

// ====== DB local (persistente en Render) ======
const db = new Database('data.sqlite');
db.exec(`
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_customer_id TEXT UNIQUE,
  email TEXT,
  status TEXT,                 -- active, trialing, past_due, canceled, incomplete
  current_period_end INTEGER,  -- epoch seconds
  tg_user_id INTEGER,          -- Telegram user id una vez verificado
  verify_token TEXT UNIQUE,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_email ON subscribers(email);
CREATE INDEX IF NOT EXISTS idx_token ON subscribers(verify_token);
`);

const upsertSub = db.prepare(`
INSERT INTO subscribers (stripe_customer_id, email, status, current_period_end, verify_token, tg_user_id, updated_at)
VALUES (@stripe_customer_id, @email, @status, @current_period_end, @verify_token, @tg_user_id, strftime('%s','now'))
ON CONFLICT(stripe_customer_id) DO UPDATE SET
  email=excluded.email,
  status=excluded.status,
  current_period_end=excluded.current_period_end,
  updated_at=strftime('%s','now')
`);
const setTokenByCustomer = db.prepare(`UPDATE subscribers SET verify_token=@verify_token, updated_at=strftime('%s','now') WHERE stripe_customer_id=@stripe_customer_id`);
const setTgUserByToken  = db.prepare(`UPDATE subscribers SET tg_user_id=@tg_user_id, updated_at=strftime('%s','now') WHERE verify_token=@verify_token`);
const getByToken        = db.prepare(`SELECT * FROM subscribers WHERE verify_token=?`);
const getByEmail        = db.prepare(`SELECT * FROM subscribers WHERE email=? ORDER BY updated_at DESC LIMIT 1`);
const getByCustomer     = db.prepare(`SELECT * FROM subscribers WHERE stripe_customer_id=?`);
const setStatusPeriod   = db.prepare(`UPDATE subscribers SET status=@status, current_period_end=@current_period_end, updated_at=strftime('%s','now') WHERE stripe_customer_id=@stripe_customer_id`);

// ====== Email (Outlook/Office365) ======
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: Number(SMTP_PORT) === 465, // 587 = STARTTLS
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

async function sendWelcomeEmail({ to, deepLink, portalUrl }) {
  const html = `
  <div style="font-family:Arial,sans-serif;line-height:1.5">
    <h2>¡Gracias por suscribirte!</h2>
    <p>Para activar tu acceso al canal de Telegram:</p>
    <ol>
      <li>Inicia el bot y verifica tu correo: <a href="${deepLink}">${deepLink}</a></li>
      <li>Escribe el mismo correo con el que pagaste en Stripe.</li>
      <li>Recibirás el enlace para <b>solicitar ingreso</b> al canal; el bot aprobará tu solicitud automáticamente.</li>
    </ol>
    <hr/>
    <p>Gestiona o cancela tu suscripción cuando quieras desde tu portal:</p>
    <p><a href="${portalUrl}">${portalUrl}</a></p>
  </div>`;
  await transporter.sendMail({
    from: FROM_EMAIL,
    to,
    subject: 'Activa tu acceso: verifica tu correo en Telegram',
    html
  });
}

function genToken() {
  return crypto.randomBytes(16).toString('hex');
}

// ====== Telegram (Webhook) ======
// Configura el webhook público del bot al arrancar
async function setTelegramWebhook() {
  const url = `${SERVER_URL}/telegram-webhook`;
  try {
    const res = await bot.setWebHook(url);
    console.log('✅ Telegram webhook OK →', res);
  } catch (e) {
    console.error('❌ Error setWebHook:', e.message);
  }
}

// Telegram entrega actualizaciones aquí (hay que responder 200 inmediato)
app.post('/telegram-webhook', express.json(), async (req, res) => {
  res.status(200).send('OK');         // respuesta inmediata
  try {
    await bot.processUpdate(req.body); // procesa en segundo plano
  } catch (e) {
    console.error('Error processUpdate:', e);
  }
});

// /start (con o sin token)
bot.onText(/^\/start(?:\s+|)(.*)?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const textParam = (match && match[1] ? match[1].trim() : '') || '';
  const deep = textParam.startsWith('verify_') ? textParam.slice('verify_'.length) : null;

  try {
    if (deep) {
      const row = getByToken.get(deep);
      if (!row) {
        return bot.sendMessage(chatId, '❌ Token inválido o expirado. Escribe tu correo para re-enviar validación.');
      }
      setTgUserByToken.run({ tg_user_id: msg.from.id, verify_token: deep });
      await bot.sendMessage(chatId, '👋 Perfecto. Ahora escribe el *correo* con el que pagaste en Stripe para confirmar tu acceso.', { parse_mode: 'Markdown' });
      return;
    }

    await bot.sendMessage(chatId, `Hola ${msg.from.first_name || ''} 👋\n\nEscribe el *correo* con el que pagaste la suscripción para activar tu acceso.`, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, '⚠️ Ocurrió un error. Intenta de nuevo.');
  }
});

// Captura de correo del usuario y envío de enlace de solicitud
bot.on('message', async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text.startsWith('/')) return;
  const emailLike = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
  if (!emailLike) return;

  try {
    const sub = getByEmail.get(text.toLowerCase());
    if (!sub) {
      return bot.sendMessage(chatId, '❌ No encuentro una suscripción activa con ese correo. Verifica que esté bien escrito o finaliza el pago.');
    }
    if (sub.status !== 'active' && sub.status !== 'trialing') {
      return bot.sendMessage(chatId, '⚠️ Tu suscripción no está activa ahora mismo. Si ya pagaste, espera la confirmación del sistema o revisa tu método de pago.');
    }

    if (!sub.tg_user_id) {
      setTgUserByToken.run({ tg_user_id: msg.from.id, verify_token: sub.verify_token });
    }

    const invite = await bot.createChatInviteLink(CHANNEL_ID, {
      creates_join_request: true,
      name: `Access for ${text.toLowerCase()}`,
      expire_date: Math.floor(Date.now() / 1000) + 60 * 60 * 24 // 24h
    });

    await bot.sendMessage(
      chatId,
      '✅ Correo verificado.\n\nToca este enlace para solicitar acceso al canal privado:\n' +
      invite.invite_link +
      '\n\nCuando envíes la solicitud, el bot la aprobará automáticamente si todo coincide.'
    );
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, '⚠️ Ocurrió un problema generando tu enlace. Intenta de nuevo.');
  }
});

// Aprobación automática de solicitudes de ingreso al canal
bot.on('chat_join_request', async (req) => {
  try {
    const userId = req.from.id;
    const chatId = req.chat.id;
    if (String(chatId) !== String(CHANNEL_ID)) return;

    const row = db.prepare(`SELECT * FROM subscribers WHERE tg_user_id=?`).get(userId);
    if (row && (row.status === 'active' || row.status === 'trialing')) {
      await bot.approveChatJoinRequest(CHANNEL_ID, userId);
      await bot.sendMessage(userId, '🎉 Acceso aprobado. ¡Bienvenido al canal!');
    } else {
      await bot.declineChatJoinRequest(CHANNEL_ID, userId);
      await bot.sendMessage(userId, '❌ No tienes una suscripción activa. Verifica tu pago y vuelve a intentarlo.');
    }
  } catch (e) {
    console.error('join_request error:', e);
  }
});

// /portal para abrir el portal del cliente (Stripe)
bot.onText(/^\/portal$/i, async (msg) => {
  try {
    const row = db.prepare(`SELECT * FROM subscribers WHERE tg_user_id=?`).get(msg.from.id);
    if (!row) return bot.sendMessage(msg.chat.id, 'No encuentro tu suscripción vinculada a este Telegram.');
    const session = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: PORTAL_RETURN_URL || SERVER_URL
    });
    bot.sendMessage(msg.chat.id, `🔧 Gestiona tu suscripción aquí:\n${session.url}`);
  } catch (e) {
    console.error(e);
    bot.sendMessage(msg.chat.id, 'No pude generar tu portal ahora. Intenta luego.');
  }
});

// ====== Stripe Webhooks ======
// Stripe exige raw body en el webhook:
app.post('/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

async function handleStripeWebhook(req, res) {
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
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'subscription') {
          const customerId = session.customer;
          const email = (session.customer_details && session.customer_details.email) || session.customer_email;
          const subscriptionId = session.subscription;

          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          const periodEnd = sub.current_period_end;
          const status = sub.status; // trialing/active

          const verify_token = genToken();
          upsertSub.run({
            stripe_customer_id: customerId,
            email: (email || '').toLowerCase(),
            status,
            current_period_end: periodEnd,
            verify_token,
            tg_user_id: null
          });
          setTokenByCustomer.run({ verify_token, stripe_customer_id: customerId });

          const portal = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: PORTAL_RETURN_URL || SERVER_URL
          });
          const deepLink = `https://t.me/${BOT_USERNAME}?start=verify_${verify_token}`;

          if (email) {
            await sendWelcomeEmail({ to: email, deepLink, portalUrl: portal.url });
          }

          console.log('✅ checkout.session.completed procesado');
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const subscriptionId = invoice.subscription;
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        setStatusPeriod.run({
          stripe_customer_id: customerId,
          status: sub.status,
          current_period_end: sub.current_period_end
        });
        console.log('💚 invoice.payment_succeeded');
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        setStatusPeriod.run({
          stripe_customer_id: customerId,
          status: 'past_due',
          current_period_end: null
        });
        const row = getByCustomer.get(customerId);
        if (row && row.tg_user_id) {
          await kickFromChannel(row.tg_user_id);
        }
        console.log('💥 invoice.payment_failed → acceso revocado');
        break;
      }

      case 'customer.subscription.deleted':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customerId = sub.customer;
        const status = sub.status;
        setStatusPeriod.run({
          stripe_customer_id: customerId,
          status,
          current_period_end: sub.current_period_end || null
        });
        if (status === 'canceled' || status === 'past_due' || status === 'incomplete') {
          const row = getByCustomer.get(customerId);
          if (row && row.tg_user_id) {
            await kickFromChannel(row.tg_user_id);
          }
          console.log('🚫 subscription off → expulsado si estaba dentro');
        }
        break;
      }

      default:
        break;
    }

    res.json({ received: true });
  } catch (e) {
    console.error('Webhook handler error:', e);
    res.status(500).send('Webhook handler error');
  }
}

async function kickFromChannel(tg_user_id) {
  try {
    await bot.banChatMember(CHANNEL_ID, tg_user_id);
    await bot.unbanChatMember(CHANNEL_ID, tg_user_id);
    await bot.sendMessage(tg_user_id, '🚪 Tu suscripción terminó o falló el cobro. Tu acceso al canal fue revocado.');
  } catch (e) {
    console.warn('kick warning:', e.message);
  }
}

// ====== Salud ======
app.use(bodyParser.json()); // para el resto de rutas
app.get('/', (_req, res) => res.send('OK - Telegram + Stripe is running'));

// ====== Arranque ======
app.listen(Number(PORT), async () => {
  console.log(`✅ Server escuchando en puerto ${PORT}`);
  await setTelegramWebhook();
});
