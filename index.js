// ────────────────────────────────────────────────────────────────
//  Bot de Gastos por WhatsApp — Gabi
//  Recibe mensajes de UltraMsg → los interpreta con Claude →
//  los anota en Google Sheets → responde por WhatsApp.
// ────────────────────────────────────────────────────────────────

const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Configuración (todo se carga como variables de entorno en Railway) ──
const {
  ANTHROPIC_API_KEY,
  ULTRAMSG_INSTANCE_ID,
  ULTRAMSG_TOKEN,
  GOOGLE_CREDENTIALS,
  SHEET_ID,
  SHEET_TAB = 'Cargar',
  ALLOWED = '',
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Números permitidos → nombre. Formato: "549351...:Gabi,549351...:Fer"
const allowedUsers = {};
ALLOWED.split(',').forEach((pair) => {
  const [num, name] = pair.split(':');
  if (num && num.trim()) allowedUsers[num.trim()] = (name || '').trim();
});

// Cliente de Google Sheets (usa la cuenta de servicio)
const sheetsAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(GOOGLE_CREDENTIALS || '{}'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });

// ── El "cerebro" del bot ──
const SYSTEM_PROMPT = `Sos un asistente que registra gastos personales por WhatsApp para Gabi y su esposa Fer. Tu única función es interpretar mensajes de gastos.

CATEGORÍAS VÁLIDAS (elegí exactamente una, tal cual está escrita): Combustibles, Gastos Gabi, Compras casa, Gastos varios, Lauti, Pilu, Servicios hogar, Tarjetas y créditos, Vehículos, Viajes.

MEDIOS DE PAGO VÁLIDOS (elegí exactamente uno, tal cual está escrito): MP-SOSA, MP-PILAU, Santander, Efectivo, BBVA Net Cash, BBVA SOSA, Galicia.

REGLAS:
- La nafta/gasoil va SIEMPRE a "Combustibles". "Vehículos" es para service, patente, seguro, cubiertas y arreglos.
- "Gastos Gabi" son cosas personales de Gabi; "Gastos varios" es el cajón para lo que no encaja en ninguna otra categoría.
- Fecha: usá la fecha de hoy (te la doy más abajo) en formato DD/MM/AAAA, salvo que el usuario aclare otra ("ayer", "el lunes").
- Moneda: usá "Pesos" por defecto. Usá "US$" solo si el mensaje menciona "dólares" o "usd".
- Montos informales: "15 lucas" = 15000, "15k" = 15000, "$15.000" = 15000. Devolvé el monto como número, sin símbolos ni puntos.
- El "detalle" es una descripción breve de en qué se gastó (ej: "nafta", "súper", "farmacia").

RESPONDÉ SIEMPRE en JSON válido, sin texto adicional ni markdown, con esta estructura exacta:
{
  "es_gasto": true | false,
  "completo": true | false,
  "gasto": {
    "fecha": "DD/MM/AAAA" | null,
    "monto": número | null,
    "moneda": "Pesos" | "US$" | null,
    "categoria": "una de la lista" | null,
    "medio_pago": "uno de la lista" | null,
    "detalle": "texto breve" | null
  },
  "respuesta": "el texto que se le envía al usuario por WhatsApp"
}

- Si es un gasto completo: completo=true, llená todos los campos y en "respuesta" poné una confirmación cortita, ej: "✅ Anotado: $15.000 · Combustibles · Santander".
- Si es un gasto pero falta un dato (típicamente el medio de pago): completo=false, llená lo que puedas y en "respuesta" preguntá SOLO por lo que falta.
- Si NO es un gasto (un saludo, una pregunta suelta): es_gasto=false, completo=false, todos los campos del gasto en null, y en "respuesta" poné un mensaje amable con ganas de aprender, recordando para qué servís. Ej: "¡Hola! 👋 Por ahora mi fuerte es anotar tus gastos — probá algo como 'gasté 3000 en el súper con Santander'. Y si alguna vez no te entiendo bien, decímelo y voy afinando. 😉"`;

function fechaHoyAR() {
  return new Date().toLocaleDateString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function extraerJSON(texto) {
  const limpio = texto.replace(/```json|```/g, '').trim();
  const ini = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}');
  return JSON.parse(limpio.slice(ini, fin + 1));
}

async function interpretar(mensaje) {
  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: `${SYSTEM_PROMPT}\n\nHoy es ${fechaHoyAR()}.`,
    messages: [{ role: 'user', content: mensaje }],
  });
  const bloque = resp.content.find((b) => b.type === 'text');
  return extraerJSON(bloque.text);
}

async function anotarEnPlanilla(gasto, cargadoPor) {
  // Buscamos la próxima fila vacía mirando la columna A
  const col = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:A`,
  });
  const proximaFila = (col.data.values || []).length + 1;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A${proximaFila}:G${proximaFila}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        gasto.fecha,
        gasto.monto,
        gasto.moneda,
        gasto.categoria,
        gasto.medio_pago,
        gasto.detalle,
        cargadoPor,
      ]],
    },
  });
}

async function enviarWhatsApp(to, body) {
  await axios.post(
    `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`,
    null,
    { params: { token: ULTRAMSG_TOKEN, to, body } }
  );
}

// ── Rutas ──
app.get('/', (req, res) => res.send('Bot de gastos funcionando ✅'));

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // respondemos ya, para que UltraMsg no reintente

  try {
    const data = req.body.data;
    if (!data || data.fromMe || data.type !== 'chat') return;

    const numero = String(data.from).split('@')[0];
    const nombre = allowedUsers[numero];
    if (!nombre) return; // número no autorizado → se ignora

    const resultado = await interpretar(data.body || '');

    if (resultado.es_gasto && resultado.completo) {
      await anotarEnPlanilla(resultado.gasto, nombre);
    }
    await enviarWhatsApp(numero, resultado.respuesta);
  } catch (err) {
    console.error('Error procesando mensaje:', err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot escuchando en el puerto ${PORT}`));
