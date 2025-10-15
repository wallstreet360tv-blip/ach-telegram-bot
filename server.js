const express = require('express');
const bodyParser = require('body-parser');
const Stripe = require('stripe');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// Configuración de Stripe y Telegram (se ponen en Render como variables de entorno)
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN || '', { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID || '@TuCanalPrivado';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';

// Ruta de prueba
app.get('/', (req, res) => res.send('Servidor bot Telegram activo'));

// Webhook Stripe (verifica firma y maneja eventos)
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log('Webhook signature error', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const type = event.type;
  const obj = event.data.object;
  console.log('Evento Stripe:', type);

  if (type === 'invoice.payment_succeeded') {
    const tg = obj.metadata && obj.metadata.telegram_id ? obj.metadata.telegram_id : null;
    if (tg) {
      const consentText =
        'Hola 👋\n\nGracias por tu pago. Este grupo es con fines educativos.\n\n¿Estás de acuerdo en continuar?';
      const opts = {
        reply_markup: {
          inline_keyboard: [[{ text: 'Acepto y quiero unirme', callback_data: `ACCEPT_JOIN:${tg}` }]]
        }
      };
      bot.sendMessage(tg, consentText, opts).catch(err => console.log('err send consent', err));
    } else {
      console.log('No tenemos telegram_id en metadata del invoice');
    }
  }

  if (type === 'invoice.payment_failed' || type === 'customer.subscription.deleted') {
    const tg = obj.metadata && obj.metadata.telegram_id ? obj.metadata.telegram_id : null;
    if (tg) {
      bot.kickChatMember(CHANNEL_ID, parseInt(tg, 10))
        .then(() => console.log('Usuario expulsado', tg))
        .catch(err => console.log('Error al expulsar', err));
    }
  }

  res.json({ received: true });
});

// Webhook de Telegram para manejar el botón "Acepto"
app.post('/telegram-webhook', express.json(), async (req, res) => {
  const update = req.body;
  if (update.callback_query) {
    const data = update.callback_query.data;
    if (data && data.startsWith('ACCEPT_JOIN:')) {
      const userId = update.callback_query.from.id;
      try {
        const invite = await bot.createChatInviteLink(CHANNEL_ID, {
          member_limit: 1,
          expire_date: Math.floor(Date.now() / 1000) + 24 * 3600
        });
        await bot.answerCallbackQuery(update.callback_query.id, { text: 'Enlace enviado ✅' });
        await bot.sendMessage(userId, `Aquí está tu enlace de acceso al grupo (válido 24 horas):\n${invite.invite_link}`);
      } catch (err) {
        console.log('Error creando invite', err);
        await bot.answerCallbackQuery(update.callback_query.id, { text: 'Error generando enlace.' });
      }
    }
  }
  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Server escuchando en puerto ${PORT}`));
