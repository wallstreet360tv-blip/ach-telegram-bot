// server.js — Stripe (Payment Link) + Telegram Bot (sin emails, sin pedir usuario de Telegram)

const express = require('express');
const Stripe = require('stripe');
const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const app = express();

// ====== ENV obligatorias ======
const {
  PORT = 10000,
  SERVER_URL,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  TELEGRAM_BOT_TOKEN,
  BOT_USERNAME,
  CHANNEL_ID,
  PORTAL_RETURN_URL
} = process.env;

[
  'SERVER_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'BOT_USERNAME',
  'CHANNEL_ID'
].forEach(k => {
  if (!process.env[k]) console.error(`❌ Falta variable de entorno: ${k}`);
});

const stripe = Stripe(STRIPE_SECRET_KEY);
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { webHook: true });

// ====== DB local (persistente en Render) ======
const db = new Database('data.sqlite');
db.exec(`
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_customer_id TEXT UNIQUE,
  status TEXT,
  current_period_end INTEGER,
  tg_user_id INTEGER,
  join_token TEXT UNIQUE,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_cust ON subscribers(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_token ON subscribers(join_token);
CREATE INDEX IF NOT EXISTS idx_tg ON subscribers(tg_user_id);
`);

const upsertSub = db.prepare(`
INSERT INTO subscribers (stripe_customer_id, status, current_period_end, tg_user_id, join_token, updated_at)
VALUES (@stripe_customer_id, @status, @current_period_end, @tg_user_id, @join_token, strftime('%s','now'))
ON CONFLICT(stripe_customer_id) DO UPDATE SET
  status=excluded.status,
  current_period_end=excluded.current_period_end,
  updated_at=strftime('%s','now')
`);

const setJoinTokenByCustomer = db.prepare(
  "UPDATE subscribers SET join_token=@join_token, updated_at=strftime('%s','now') WHERE stripe_customer_id=@stripe_customer_id"
);
const setTgByToken = db.prepare(
  "UPDATE subscribers SET tg_user_id=@tg_user_id, join_token=NULL, updated_at=strftime('%s','now') WHERE join_token=@join_token"
);
const getByToken = db.prepare("SELECT * FROM subscribers WHERE join_token=?");
const getByCustomer = db.prepare("SELECT * FROM subscribers WHERE stripe_customer_id=?");
const getByTg = db.prepare("SELECT * FROM subscribers WHERE tg_user_id=?");
const setStatusPeriod = db.prepare(
  "UPDATE subscribers SET status=@status, current_period_end=@current_period_end, updated_at=strftime('%s','now') WHERE stripe_customer_id=@stripe_customer_id"
);

function genToken() {
  return crypto.randomBytes(16).toString('hex');
}

// ====== Telegram Webhook ======
async function setTelegramWebhook() {
  const url = `${SERVER_URL}/telegram-webhook`;
  try {
    const res = await bot.setWebHook(url);
    console.log('✅ Telegram webhook OK →', res);
  } catch (e) {
    console.error('❌ Error setWebHook:', e.message);
  }
}

app.post('/telegram-webhook', express.json(), async (req, res) => {
  res.status(200).send('OK');
  try {
    await bot.processUpdate(req.body);
  } catch (e) {
    console.error('processUpdate error:', e);
  }
});

// ====== /join — redirección desde Stripe ======
app.get('/join', async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).send('Falta session_id');

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session || session.payment_status !== 'paid') {
      return res.status(400).send('Pago no encontrado o incompleto.');
    }
    if (session.mode !== 'subscription') {
      return res.status(400).send('La sesión no es de suscripción.');
    }

    const customerId = session.customer;
    const subscr = await stripe.subscriptions.retrieve(session.subscription);

    upsertSub.run({
      stripe_customer_id: customerId,
      status: subscr.status,
      current_period_end: subscr.current_period_end || null,
      tg_user_id: null,
      join_token: null
    });

    const joinToken = genToken();
    setJoinTokenByCustomer.run({ join_token: joinToken, stripe_customer_id: customerId });

    let portalUrl = null;
    try {
      const portal = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: PORTAL_RETURN_URL || SERVER_URL
      });
      portalUrl = portal.url;
    } catch (_) {}

    const startCmd = `/start join_${joinToken}`;
    const deepLink = `https://t.me/${BOT_USERNAME}?start=join_${joinToken}`;
    const deepLinkNative = `tg://resolve?domain=${BOT_USERNAME}&start=join_${joinToken}`;

    res.send(`
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Investe.pro — Acceso</title>
          <style>
            :root { color-scheme: dark; }
            body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
            .card{background:#111827;padding:28px;border-radius:18px;box-shadow:0 10px 30px rgba(0,0,0,.35);max-width:560px;text-align:center}
            .btn{display:inline-block;padding:12px 18px;border-radius:10px;text-decoration:none;background:#0088cc;color:#fff;font-weight:600}
            .btn.secondary{background:#334155}
            .muted{opacity:.85;font-size:14px;margin-top:12px}
            .sp{height:1px;background:#1f2937;margin:18px 0}
            .link{color:#93c5fd}
            .code{font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;background:#0b1220;padding:8px 10px;border-radius:8px;display:inline-block}
            .toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#16a34a;color:#fff;padding:10px 14px;border-radius:10px;display:none}
          </style>
          <script>
            function openTelegram(){
              window.location.href='${deepLinkNative}';
              setTimeout(function(){ window.location.href='${deepLink}'; }, 900);
            }
            function copyStart(){
              navigator.clipboard.writeText('${startCmd}')
                .then(()=>{ const t=document.getElementById('toast'); t.style.display='block'; setTimeout(()=>t.style.display='none',1300); })
                .catch(()=>{ alert('Copia manual: ${startCmd}'); });
            }
            document.addEventListener('DOMContentLoaded', function(){ setTimeout(openTelegram, 300); });
          </script>
        </head>
        <body>
          <div class="card">
            <h2>✅ Pago verificado</h2>
            <p>Ahora completa tu acceso desde Telegram.</p>
            <p><a class="btn" href="#" onclick="openTelegram();return false;">Abrir en Telegram</a></p>
            <p class="muted">¿No se abrió?
              <a class="link" href="#" onclick="openTelegram();return false;">Reintentar abrir Telegram</a>
            </p>
            <div class="sp"></div>
            <p class="muted">Si al abrir Telegram no ves el mensaje del bot, toca el botón <b>Start</b> (Comenzar) que aparece abajo.</p>
            <p class="muted">Plan C (si nada abre): copia este comando, pégalo en el chat del bot y envíalo:</p>
            <p class="code">${startCmd}</p><br/>
            <p><a class="btn secondary" href="#" onclick="copyStart();return false;">Copiar comando</a></p>
            <p class="muted">También puedes usar este <a class="link" href="${deepLink}">enlace alternativo</a>.</p>
            ${portalUrl ? `<div class="sp"></div><p class="muted">¿Necesitas gestionar tu suscripción?<br/><a class="link" href="${portalUrl}" target="_blank" rel="noopener">Abrir portal de cliente</a></p>` : ``}
          </div>
          <div id="toast" class="toast">Comando copiado ✅</div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('Error en /join:', err);
    res.status(500).send('Error interno verificando el pago.');
  }
});

// ====== Textos globales ======
const DISCLAIMER_HTML = [
  '⚠️ <b>Aviso importante</b>',
  'Este canal es estrictamente <b>educativo</b> y no constituye asesoramiento financiero ni recomendación de inversión.',
  'Al continuar y solicitar el acceso, <b>aceptas nuestros términos y condiciones</b>.'
].join('\n');
const SUPPORT_PHONE = '786 677 5827';

// ====== Función: enviar bienvenida y botones ======
function sendAccessFlow(chatId, inviteLink) {
  bot.sendMessage(
    chatId,
    `<b>Bienvenido a <a href="https://t.me/${BOT_USERNAME}">Investe.pro</a></b>\n\n${DISCLAIMER_HTML}`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🔓 Solicitar acceso al canal', url: inviteLink }]]
      }
    }
  );

  bot.sendMessage(
    chatId,
    '🔧 Para gestionar o cancelar tu suscripción en cualquier momento, usa los botones de abajo:',
    {
      parse_mode: 'HTML',
      reply_markup: {
        keyboard: [
          [{ text: '/portal' }, { text: 'Soporte' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
      }
    }
  );
}

// ====== /start (con token o sin token) ======
bot.onText(/^\/start(?:\s+|)(.*)?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const param = (match && match[1] ? match[1].trim() : '') || '';
  const join = param.startsWith('join_') ? param.slice('join_'.length) : null;

  try {
    if (join) {
      const row = getByToken.get(join);
      if (!row) {
        const linked = getByTg.get(msg.from.id);
        if (linked && (linked.status === 'active' || linked.status === 'trialing')) {
          const invite = await bot.createChatInviteLink(CHANNEL_ID, {
            creates_join_request: true,
            name: `Access for tg:${msg.from.id}`,
            expire_date: Math.floor(Date.now()/1000) + 86400
          });
          sendAccessFlow(chatId, invite.invite_link);
          return;
        }
        return bot.sendMessage(chatId, '❌ Token inválido o usado. Si ya pagaste, vuelve al enlace /join para generar uno nuevo.');
      }

      setTgByToken.run({ tg_user_id: msg.from.id, join_token: join });

      const invite = await bot.createChatInviteLink(CHANNEL_ID, {
        creates_join_request: true,
        name: `Access for tg:${msg.from.id}`,
        expire_date: Math.floor(Date.now()/1000) + 86400
      });

      sendAccessFlow(chatId, invite.invite_link);
      return;
    }

    const linked = getByTg.get(msg.from.id);
    if (linked && (linked.status === 'active' || linked.status === 'trialing')) {
      const invite = await bot.createChatInviteLink(CHANNEL_ID, {
        creates_join_request: true,
        name: `Access for tg:${msg.from.id}`,
        expire_date: Math.floor(Date.now()/1000) + 86400
      });
      sendAccessFlow(chatId, invite.invite_link);
      return;
    }

    return bot.sendMessage(
      chatId,
      '👋 Hola. Para activar tu acceso, completa el pago y usa el botón que te llevamos a Telegram.\n\nSi ya pagaste, vuelve al enlace que te dimos después del pago.'
    );
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, '⚠️ Ocurrió un error. Intenta de nuevo.');
  }
});

// ====== Aprobación automática ======
bot.on('chat_join_request', async (req) => {
  try {
    const userId = req.from.id;
    const chatId = req.chat.id;
    if (String(chatId) !== String(CHANNEL_ID)) return;

    const row = getByTg.get(userId);
    if (row && (row.status === 'active' || row.status === 'trialing')) {
      await bot.approveChatJoinRequest(CHANNEL_ID, userId);

      const direct = await bot.createChatInviteLink(CHANNEL_ID, {
        creates_join_request: false,
        expire_date: Math.floor(Date.now()/1000) + 21600 // 6h
      });

      await bot.sendMessage(
        userId,
        '🎉 <b>Acceso aprobado</b>. ¡Bienvenido al canal!',
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '➡️ Entrar al canal', url: direct.invite_link }]]
          }
        }
      );

      await bot.sendMessage(userId, DISCLAIMER_HTML, { parse_mode: 'HTML' });
    } else {
      await bot.declineChatJoinRequest(CHANNEL_ID, userId);
      await bot.sendMessage(userId, '❌ No tienes una suscripción activa. Verifica tu pago y vuelve a intentarlo.');
    }
  } catch (e) {
    console.error('join_request error:', e);
  }
});

// ====== /portal ======
bot.onText(/^\/portal$/i, async (msg) => {
  try {
    const row = getByTg.get(msg.from.id);
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

// ====== Soporte (botón y comando) ======
bot.onText(/^\/(soporte|ayuda|help)$/i, async (msg) => {
  bot.sendMessage(msg.chat.id, `📞 Soporte (llamadas o SMS): ${SUPPORT_PHONE}\n\nPara gestionar tu suscripción usa /portal.`);
});
bot.on('message', (msg) => {
  if (msg.text && msg.text.trim().toLowerCase() === 'soporte') {
    bot.sendMessage(msg.chat.id, `📞 Soporte (llamadas o SMS): ${SUPPORT_PHONE}\n\nPara gestionar tu suscripción usa /portal.`);
  }
});

// ====== Webhooks Stripe ======
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
        const s = event.data.object;
        if (s.mode === 'subscription') {
          const sub = await stripe.subscriptions.retrieve(s.subscription);
          upsertSub.run({
            stripe_customer_id: s.customer,
            status: sub.status,
            current_period_end: sub.current_period_end || null,
            tg_user_id: null,
            join_token: null
          });
          console.log('✅ checkout.session.completed');
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const i = event.data.object;
        const sub = await stripe.subscriptions.retrieve(i.subscription);
        setStatusPeriod.run({
          stripe_customer_id: i.customer,
          status: sub.status,
          current_period_end: sub.current_period_end || null
        });
        console.log('💚 invoice.payment_succeeded');
        break;
      }

      case 'invoice.payment_failed': {
        const i = event.data.object;
        setStatusPeriod.run({
          stripe_customer_id: i.customer,
          status: 'past_due',
          current_period_end: null
        });
        const row = getByCustomer.get(i.customer);
        if (row && row.tg_user_id) await kickFromChannel(row.tg_user_id);
        console.log('💥 invoice.payment_failed → acceso revocado');
        break;
      }

      case 'customer.subscription.deleted':
      case 'customer.subscription.updated': {
        const s = event.data.object; // subscription
        const id = s.customer;
        setStatusPeriod.run({
          stripe_customer_id: id,
          status: s.status,
          current_period_end: s.current_period_end || null
        });
        if (['canceled','past_due','incomplete','unpaid'].includes(s.status)) {
          const row = getByCustomer.get(id);
          if (row && row.tg_user_id) await kickFromChannel(row.tg_user_id);
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

// ====== Salud y JSON para otras rutas ======
app.use(express.json());
app.get('/', (_req, res) => res.send('OK - Stripe + Telegram (sin emails)'));

// ====== Arranque ======
app.listen(Number(PORT), async () => {
  console.log(`✅ Server escuchando en puerto ${PORT}`);
  await setTelegramWebhook();
});