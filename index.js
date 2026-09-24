// ─────────────────────────────────────────────────────────────
//  Bot de Gastos + Agenda por WhatsApp — Gabi
//  Recibe mensajes de UltraMsg → los interpreta con Claude →
//  segun el caso: anota un gasto en Google Sheets, agenda un
//  evento en Google Calendar, o consulta la agenda.
//  Ahora con MEMORIA: recuerda los ultimos mensajes de cada
//  persona para entender el contexto (ej: responder "1 hora").
//  Siempre responde por WhatsApp.
// ─────────────────────────────────────────────────────────────

const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Configuración (variables de entorno en Railway) ──
const {
  ANTHROPIC_API_KEY,
  ULTRAMSG_INSTANCE_ID,
  ULTRAMSG_TOKEN,
  GOOGLE_CREDENTIALS,
  SHEET_ID,
  SHEET_TAB = 'Cargar',
  CALENDAR_ID,
  ALLOWED = '',
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Números permitidos → nombre. Formato: "549351...:Gabi,549351...:Fer"
const allowedUsers = {};
ALLOWED.split(',').forEach((pair) => {
  const [num, name] = pair.split(':');
  if (num && num.trim()) allowedUsers[num.trim()] = (name || '').trim();
});

// ── MEMORIA DE CONVERSACIÓN ──
// Guardamos los últimos mensajes de cada persona en la memoria del
// servidor. Sirve para entender el contexto (ej: si el bot pregunta
// "¿1 hora o 30 min?" y la persona responde "1 hora", el bot ya sabe
// de qué se trata). Nota: si Railway reinicia el bot, esta memoria se
// borra (empieza de cero); para una charla seguida funciona muy bien.
const historial = {};                 // { numero: { mensajes: [...], ts: 123 } }
const MAX_MENSAJES = 10;              // recuerda los últimos 10 mensajes por persona
const MINUTOS_VIGENCIA = 30;         // si pasaron +30 min sin hablar, arranca contexto nuevo

function obtenerHistorial(numero) {
  const h = historial[numero];
  if (!h) return [];
  // Si la última charla fue hace mucho, la olvidamos (contexto viejo)
  if (Date.now() - h.ts > MINUTOS_VIGENCIA * 60 * 1000) {
    delete historial[numero];
    return [];
  }
  return h.mensajes;
}

function guardarEnHistorial(numero, mensajeUsuario, respuestaBot) {
  const h = historial[numero] || { mensajes: [], ts: Date.now() };
  h.mensajes.push({ role: 'user', content: mensajeUsuario });
  h.mensajes.push({ role: 'assistant', content: respuestaBot });
  // Nos quedamos solo con los últimos MAX_MENSAJES
  if (h.mensajes.length > MAX_MENSAJES) {
    h.mensajes = h.mensajes.slice(-MAX_MENSAJES);
  }
  h.ts = Date.now();
  historial[numero] = h;
}

// Autenticación de Google (misma cuenta de servicio para Sheets y Calendar)
const googleAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(GOOGLE_CREDENTIALS || '{}'),
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/calendar',
  ],
});
const sheets = google.sheets({ version: 'v4', auth: googleAuth });
const calendar = google.calendar({ version: 'v3', auth: googleAuth });

const TIMEZONE = 'America/Argentina/Buenos_Aires';

// ── El "cerebro" del bot ──
const SYSTEM_PROMPT = `Sos un asistente personal por WhatsApp para Gabi y su esposa Fer. Interpretás mensajes y decidís qué acción tomar. Hay CUATRO tipos de acción posibles: registrar un gasto, agendar un evento, consultar la agenda, o responder cuando no es ninguna de las anteriores.

Tu trabajo es leer el mensaje, entender la intención (aunque esté escrita de mil formas distintas) y devolver SIEMPRE un JSON válido, sin texto adicional ni markdown.

IMPORTANTE SOBRE EL CONTEXTO: te paso los mensajes anteriores de la conversación. Usalos para entender respuestas cortas. Por ejemplo, si vos preguntaste "¿1 hora o 30 minutos?" y la persona responde "1 hora", entendé que se refiere al evento que estaban armando y completá la acción con TODOS los datos que ya se dijeron antes. No vuelvas a preguntar algo que la persona ya respondió en un mensaje anterior.

─────────────────────────
ACCIÓN "gasto" — registrar un gasto
─────────────────────────
Ejemplos de cómo puede venir: "gasté 3000 en el súper con santander", "cargá 15 lucas de nafta MP-SOSA", "pagué 5000 a Pilu con galicia", "20k farmacia efectivo".

CATEGORÍAS VÁLIDAS (elegí exactamente una, tal cual): Combustibles, Gastos Gabi, Compras casa, Gastos varios, Lauti, Pilu, Servicios hogar, Tarjetas y créditos, Vehículos, Viajes.
MEDIOS DE PAGO VÁLIDOS (elegí exactamente uno): MP-SOSA, MP-PILAU, Santander, Efectivo, BBVA Net Cash, BBVA SOSA, Galicia.
Reglas: nafta/gasoil = "Combustibles"; service/patente/seguro/cubiertas/arreglos = "Vehículos"; "Gastos Gabi" = cosas personales de Gabi; "Gastos varios" = cajón para lo que no encaja. Moneda "Pesos" por defecto, "US$" si dice dólares/usd. Montos informales: "15 lucas"/"15k" = 15000. Monto como número sin símbolos.

─────────────────────────
ACCIÓN "agendar" — crear un evento en el calendario
─────────────────────────
Cubre reuniones, turnos, eventos, recordatorios de pago y CUMPLEAÑOS.
Ejemplos: "agendá reunión con proveedor el jueves a las 15", "turno con Rodri mañana 10:30", "recordame pagar la luz el 10", "esta semana tengo que pagar expensas", "anotá cumple de Pili el 20 de marzo", "recordame el service del auto el viernes que viene".

Reglas de interpretación:
- Fecha/hora: interpretá lenguaje natural ("mañana", "el jueves", "en 2 semanas", "el 10", "a las 3 de la tarde" = 15:00). Usá la fecha/hora de HOY (te la doy abajo) como referencia.
- Si NO menciona hora, es un evento de día completo (all_day = true).
- CUMPLEAÑOS: si el mensaje dice "cumple", "cumpleaños" o similar, poné es_cumple = true (se repetirá todos los años) y all_day = true.
- RECORDATORIO: si pide un aviso ("recordámelo 1 hora antes", "avisame 2 días antes", "1 día antes"), convertilo a minutos en recordatorio_minutos (1 hora = 60, 1 día = 1440, 30 min = 30, 10 días = 14400). Si no pide, dejá recordatorio_minutos = null.

─────────────────────────
ACCIÓN "consultar" — leer la agenda
─────────────────────────
Ejemplos: "¿qué tengo mañana?", "qué hay esta semana", "quién cumple este mes", "agenda de hoy", "tengo algo el viernes?".
Definí un rango con rango_desde y rango_hasta (fechas YYYY-MM-DD) según lo que pida:
- "hoy" → desde y hasta = hoy.
- "mañana" → desde y hasta = mañana.
- "esta semana" → desde = hoy, hasta = domingo de esta semana.
- "este mes" / "quién cumple este mes" → desde = primer día del mes, hasta = último día del mes.
- un día puntual ("el viernes") → desde y hasta = ese día.
Si es específicamente sobre cumpleaños, poné solo_cumples = true.

─────────────────────────
ACCIÓN "charla" — nada de lo anterior
─────────────────────────
Un saludo, una pregunta suelta, algo que no entendés. Respondé amable, con ganas de aprender, recordando qué sabés hacer.

─────────────────────────
FORMATO DE RESPUESTA (JSON exacto)
─────────────────────────
{
  "accion": "gasto" | "agendar" | "consultar" | "charla",
  "completo": true | false,
  "gasto": { "fecha": "DD/MM/AAAA"|null, "monto": número|null, "moneda": "Pesos"|"US$"|null, "categoria": null, "medio_pago": null, "detalle": null },
  "evento": { "titulo": string|null, "fecha": "YYYY-MM-DD"|null, "hora_inicio": "HH:MM"|null, "hora_fin": "HH:MM"|null, "all_day": true|false, "es_cumple": true|false, "recordatorio_minutos": número|null },
  "consulta": { "rango_desde": "YYYY-MM-DD"|null, "rango_hasta": "YYYY-MM-DD"|null, "solo_cumples": true|false },
  "respuesta": "texto que se le envía al usuario por WhatsApp"
}

Reglas del JSON:
- Completá SOLO el sub-objeto de la acción que corresponde; los demás dejalos con sus campos en null/false.
- Si la acción está completa: completo=true.
- Si es un gasto/evento pero falta un dato esencial (ej: falta el medio de pago, o falta la fecha del evento): completo=false, llená lo que puedas, y en "respuesta" preguntá SOLO por lo que falta.
- En "respuesta", cuando la acción esté completa, poné una confirmación cortita y clara:
  · gasto → "✅ Anotado: \$15.000 · Combustibles · Santander"
  · agendar → "📅 Agendado: Turno con Rodri · jue 18/09 15:00 · te aviso 1h antes"
  · consultar → dejá "respuesta" con un texto breve tipo "Buscando tu agenda..." (el sistema completará el detalle real después).
- charla → mensaje amable. Ej: "¡Hola! 👋 Puedo anotarte gastos y manejar tu agenda. Probá con 'gasté 3000 en el súper con Santander' o 'agendá turno con Rodri mañana 15hs'. 😉"`;

function fechaHoyAR() {
  return new Date().toLocaleString('es-AR', {
    timeZone: TIMEZONE,
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function extraerJSON(texto) {
  const limpio = texto.replace(/```json|```/g, '').trim();
  const ini = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}');
  return JSON.parse(limpio.slice(ini, fin + 1));
}

async function interpretar(mensaje, historialUsuario) {
  // Armamos la conversación: primero los mensajes anteriores (contexto),
  // y al final el mensaje nuevo de la persona.
  const mensajes = [...historialUsuario, { role: 'user', content: mensaje }];

  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 700,
    system: `${SYSTEM_PROMPT}\n\nAhora es ${fechaHoyAR()} (zona horaria de Argentina).`,
    messages: mensajes,
  }, { timeout: 30000 });
  const bloque = resp.content.find((b) => b.type === 'text');
  console.log('🕵️ [2] Claude respondió:', bloque.text);
  return extraerJSON(bloque.text);
}

// ── GASTOS ──
async function anotarGasto(gasto, cargadoPor) {
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
        gasto.fecha, gasto.monto, gasto.moneda,
        gasto.categoria, gasto.medio_pago, gasto.detalle, cargadoPor,
      ]],
    },
  });
}

// ── AGENDAR ──
async function agendarEvento(ev) {
  const evento = { summary: ev.titulo };

  if (ev.all_day) {
    // Evento de día completo (la fecha "end" es exclusiva → sumamos 1 día)
    const fin = new Date(`${ev.fecha}T00:00:00`);
    fin.setDate(fin.getDate() + 1);
    const finStr = fin.toISOString().slice(0, 10);
    evento.start = { date: ev.fecha };
    evento.end = { date: finStr };
    if (ev.es_cumple) {
      evento.recurrence = ['RRULE:FREQ=YEARLY']; // se repite todos los años
    }
  } else {
    const horaFin = ev.hora_fin || sumarUnaHora(ev.hora_inicio);
    evento.start = { dateTime: `${ev.fecha}T${ev.hora_inicio}:00`, timeZone: TIMEZONE };
    evento.end = { dateTime: `${ev.fecha}T${horaFin}:00`, timeZone: TIMEZONE };
  }

  if (ev.recordatorio_minutos) {
    evento.reminders = {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: ev.recordatorio_minutos }],
    };
  }

  console.log('🕵️ [3] Creando evento en calendario:', CALENDAR_ID, JSON.stringify(evento));
  const creado = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: evento,
  }, { timeout: 20000 });
  console.log('🕵️ [4] Evento creado OK:', creado.data.htmlLink);
}

function sumarUnaHora(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h + 1, m, 0, 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── CONSULTAR ──
async function consultarAgenda(c) {
  const timeMin = new Date(`${c.rango_desde}T00:00:00-03:00`).toISOString();
  const timeMax = new Date(`${c.rango_hasta}T23:59:59-03:00`).toISOString();

  const res = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
  });

  let eventos = res.data.items || [];
  if (c.solo_cumples) {
    eventos = eventos.filter((e) =>
      /cumple|cumpleaños/i.test(e.summary || '')
    );
  }

  if (eventos.length === 0) {
    return '🗓️ No tenés nada agendado en ese período.';
  }

  const lineas = eventos.map((e) => {
    const cuando = e.start.date
      ? formatearFecha(e.start.date)
      : formatearFechaHora(e.start.dateTime);
    return `• ${cuando} — ${e.summary}`;
  });
  return `🗓️ Tu agenda:\n${lineas.join('\n')}`;
}

function formatearFecha(fechaISO) {
  return new Date(`${fechaISO}T12:00:00`).toLocaleDateString('es-AR', {
    weekday: 'short', day: '2-digit', month: '2-digit', timeZone: TIMEZONE,
  });
}
function formatearFechaHora(iso) {
  return new Date(iso).toLocaleString('es-AR', {
    weekday: 'short', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZone: TIMEZONE,
  });
}

// ── WHATSAPP ──
async function enviarWhatsApp(to, body) {
  if (!body || !String(body).trim()) body = '🤔 Algo no me cerró, ¿me lo repetís?';
  const r = await axios.post(
    `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`,
    null,
    { params: { token: ULTRAMSG_TOKEN, to, body }, timeout: 20000 }
  );
  console.log('🕵️ [5] UltraMsg contestó:', JSON.stringify(r.data));
}

// ── RUTAS ──
app.get('/', (req, res) => res.send('Bot de gastos + agenda funcionando ✅'));

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // respondemos ya para que UltraMsg no reintente

  let numero = null;
  try {
    const data = req.body.data;
    console.log('🕵️ [0] Llegó webhook:', data ? `tipo=${data.type} fromMe=${data.fromMe} de=${data.from}` : 'sin datos');
    if (!data || data.fromMe || data.type !== 'chat') return;

    numero = String(data.from).split('@')[0];
    const nombre = allowedUsers[numero];
    if (!nombre) { console.log('🕵️ Número no autorizado:', numero); return; }

    const mensajeUsuario = data.body || '';
    console.log('🕵️ [1] Llegó mensaje de', nombre, ':', mensajeUsuario);

    // Traemos el contexto de los mensajes anteriores de esta persona
    const contexto = obtenerHistorial(numero);

    const r = await interpretar(mensajeUsuario, contexto);
    let respuesta = r.respuesta;

    if (r.completo) {
      try {
        if (r.accion === 'gasto') {
          await anotarGasto(r.gasto, nombre);
        } else if (r.accion === 'agendar') {
          await agendarEvento(r.evento);
        } else if (r.accion === 'consultar') {
          respuesta = await consultarAgenda(r.consulta);
        }
      } catch (accionErr) {
        // En vez de quedar mudo, avisamos el motivo por WhatsApp
        console.error('Error en la acción:', accionErr.message);
        respuesta = `⚠️ No pude completar la acción. Motivo: ${accionErr.message}`;
      }
    }

    // Guardamos este intercambio en la memoria de la persona
    // (se guarda en formato JSON para que Claude siga respondiendo en su formato)
    guardarEnHistorial(numero, mensajeUsuario, JSON.stringify({ ...r, respuesta }));

    await enviarWhatsApp(numero, respuesta);
  } catch (err) {
    console.error('Error procesando mensaje:', err.message);
    // Avisamos también por WhatsApp para no quedar mudos
    if (numero) {
      try {
        await enviarWhatsApp(numero, `⚠️ Tuve un problema: ${err.message}`);
      } catch (e2) {
        console.error('Error avisando por WhatsApp:', e2.message);
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot escuchando en el puerto ${PORT}`));
