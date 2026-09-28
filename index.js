// ─────────────────────────────────────────────────────────────
//  Bot de Gastos + Agenda por WhatsApp — Gabi
//  Recibe mensajes de UltraMsg → los interpreta con Claude →
//  segun el caso: anota un gasto en Google Sheets, agenda un
//  evento en Google Calendar, o consulta la agenda.
//  Ahora con MEMORIA: recuerda los ultimos mensajes de cada
//  persona para entender el contexto (ej: responder "1 hora").
//  Siempre responde por WhatsApp.
//  v2 (26/09): acepta VARIOS gastos en un mismo mensaje/audio
//  (una fila por gasto) + "seguro" que repregunta en vez de
//  mostrar errores técnicos cuando los datos llegan incompletos.
//  v3 (28/09): CORREGIR el último gasto ("perdón, fue MP sosa")
//  editando la misma fila en vez de anotarlo dos veces · si dice
//  solo "Mercado Pago" pregunta SOSA o PILAU · una compra pagada
//  con 2 medios se anota separada sin preguntar · controla que la
//  categoría y el medio de pago sean de la lista oficial.
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
  GROQ_API_KEY,
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
Fecha del gasto: la de HOY en formato DD/MM/AAAA, salvo que el mensaje diga otra ("ayer", "el lunes", "el 20").

UNO O VARIOS GASTOS: el mensaje puede traer un solo gasto o varios juntos (ej: "Gasté todo con MP sosa: 10.300 compras casa vino, 14.900 compras casa verdulería, 14.000 súper"). Poné CADA gasto como un elemento separado de la lista "gastos", en el mismo orden en que aparecen. Si un dato se dice una sola vez para todos (el medio de pago, la categoría, la fecha), aplicalo a TODOS los gastos de la lista. Nunca sumes los gastos entre sí: cada uno va aparte. Los puntos de miles no son decimales: "10.300" = 10300.

MERCADO PAGO: hay DOS cuentas distintas, MP-SOSA y MP-PILAU. Si la persona dice solo "Mercado Pago", "MP" o "mercadopago" sin aclarar SOSA o PILAU, NO elijas vos: completo=false y preguntá "¿Fue MP-SOSA o MP-PILAU?".

UNA COMPRA PAGADA CON DOS MEDIOS: si un mismo gasto se pagó una parte con un medio y otra parte con otro (ej: "gasté 19.500 en gastos varios, pagué 5000 en efectivo y 14.500 con mp sosa, club delivery"), anotalo directamente como gastos SEPARADOS, uno por cada medio de pago, cada uno con su monto, con la misma categoría y el mismo detalle. No preguntes si separar: siempre van separados. No anotes el total (19.500) como un gasto aparte.

─────────────────────────
ACCIÓN "corregir" — cambiar un gasto que YA se anotó
─────────────────────────
Usala cuando en la conversación ya aparece la confirmación "✅ Anotado" de un gasto y la persona avisa que un dato estaba mal. Ejemplos: "perdón, fue MP sosa", "no, eran 15 mil", "la categoría era Pilu", "me equivoqué, fue con Galicia".
- Devolvé en "gastos" la lista COMPLETA de la última carga (la misma cantidad de gastos y en el mismo orden que la última confirmación), con el dato corregido y todo lo demás igual.
- Si la última carga tenía varios gastos y no queda claro cuál corregir: completo=false y preguntá cuál.
- NUNCA uses la acción "gasto" para una corrección: eso anotaría el gasto dos veces en la planilla.
- Si el gasto todavía NO se había anotado (vos estabas preguntando un dato que faltaba), NO es una corrección: es la acción "gasto" normal, completada con el dato nuevo.

─────────────────────────
ACCIÓN "agendar" — crear un evento en el calendario
─────────────────────────
Cubre reuniones, turnos, eventos, recordatorios de pago y CUMPLEAÑOS.
Ejemplos: "agendá reunión con proveedor el jueves a las 15", "turno con Rodri mañana 10:30", "recordame pagar la luz el 10", "esta semana tengo que pagar expensas", "anotá cumple de Pili el 20 de marzo", "recordame el service del auto el viernes que viene".

Reglas de interpretación:
- Fecha/hora: interpretá lenguaje natural ("mañana", "el jueves", "en 2 semanas", "el 10", "a las 3 de la tarde" = 15:00). Usá la fecha/hora de HOY (te la doy abajo) como referencia.
- Si NO menciona hora, es un evento de día completo (all_day = true).
- CUMPLEAÑOS: si el mensaje dice "cumple", "cumpleaños" o similar, poné es_cumple = true (se repetirá todos los años) y all_day = true.
- RECORDATORIOS: SOLO si la persona pide avisos en el mensaje. Puede pedir uno o varios ("avisame 1 hora antes", "recordámelo 30 min, 1 hora y 1 día antes", "con los avisos de siempre" = 30 min, 1 hora y 1 día). Convertí cada uno a minutos y ponelos en la lista recordatorios_minutos (30 min = 30, 1 hora = 60, 2 horas = 120, 1 día = 1440, 2 días = 2880, 1 semana = 10080). Máximo 5. Si NO pide avisos, dejá recordatorios_minutos = [] (lista vacía) y NO preguntes por avisos.
- En eventos de día completo (sin hora), "1 día antes" significa el día anterior a las 9:00 → usá 900 minutos; "el mismo día" → usá 0.

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
  "accion": "gasto" | "corregir" | "agendar" | "consultar" | "charla",
  "completo": true | false,
  "gastos": [ { "fecha": "DD/MM/AAAA"|null, "monto": número|null, "moneda": "Pesos"|"US$"|null, "categoria": string|null, "medio_pago": string|null, "detalle": string|null } ],
  "evento": { "titulo": string|null, "fecha": "YYYY-MM-DD"|null, "hora_inicio": "HH:MM"|null, "hora_fin": "HH:MM"|null, "all_day": true|false, "es_cumple": true|false, "recordatorios_minutos": [números] },
  "consulta": { "rango_desde": "YYYY-MM-DD"|null, "rango_hasta": "YYYY-MM-DD"|null, "solo_cumples": true|false },
  "respuesta": "texto que se le envía al usuario por WhatsApp"
}

Reglas del JSON:
- Completá SOLO el sub-objeto de la acción que corresponde; los demás dejalos con sus campos en null/false. Si la acción no es "gasto" ni "corregir", dejá "gastos" como lista vacía [].
- Si la acción es "gasto" o "corregir", la lista "gastos" SIEMPRE debe tener al menos un elemento, con todos los datos que se conozcan (nunca null ni vacía).
- Si la acción está completa: completo=true.
- Si es un gasto/evento pero falta un dato esencial (ej: falta el medio de pago, o falta la fecha del evento): completo=false, llená lo que puedas, y en "respuesta" preguntá SOLO por lo que falta. Con varios gastos, completo=true solo si TODOS tienen monto, categoría y medio de pago; si no, preguntá qué falta y de cuál.
- En "respuesta", cuando la acción esté completa, poné una confirmación cortita y clara:
  · gasto → "✅ Anotado" (el sistema arma el detalle real después, con uno o varios gastos).
  · corregir → "✏️ Corregido" (el sistema arma el detalle real después).
  · agendar → "📅 Agendado: Turno con Rodri · jue 18/09 15:00 · avisos: 1 día, 1 h y 30 min antes" (si no hay avisos, no los menciones)
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
    max_tokens: 1500, // más margen para mensajes con varios gastos
    system: `${SYSTEM_PROMPT}\n\nAhora es ${fechaHoyAR()} (zona horaria de Argentina).`,
    messages: mensajes,
  }, { timeout: 30000 });
  const bloque = resp.content.find((b) => b.type === 'text');
  console.log('🕵️ [2] Claude respondió:', bloque.text);
  return extraerJSON(bloque.text);
}

// ── GASTOS ──
// Listas oficiales: el bot solo escribe en la planilla valores de estas listas
const CATEGORIAS = ['Combustibles', 'Gastos Gabi', 'Compras casa', 'Gastos varios', 'Lauti', 'Pilu',
  'Servicios hogar', 'Tarjetas y créditos', 'Vehículos', 'Viajes'];
const MEDIOS_PAGO = ['MP-SOSA', 'MP-PILAU', 'Santander', 'Efectivo', 'BBVA Net Cash', 'BBVA SOSA', 'Galicia'];

// "mp sosa", "MP-SOSA", "Mercado Pago Sosa" → "mpsosa" (para comparar sin importar cómo se escriba)
function normalizar(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '').replace(/^mercadopago/, 'mp');
}
function buscarEnLista(valor, lista) {
  const n = normalizar(valor);
  if (!n) return null;
  return lista.find((x) => normalizar(x) === n) || null;
}

function fechaHoyDDMMAAAA() {
  return new Date().toLocaleDateString('es-AR', {
    timeZone: TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

// Convierte "10.300", "$14.900", "15000" en número. Devuelve NaN si no se puede.
function aNumero(monto) {
  if (typeof monto === 'number') return monto;
  if (monto == null) return NaN;
  const limpio = String(monto).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  return Number(limpio);
}

function formatoPesos(n) {
  return '$' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 });
}

// Anota una o varias filas de una sola vez (una fila por gasto)
async function anotarGastos(gastos, cargadoPor) {
  const col = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:A`,
  });
  const primeraFila = (col.data.values || []).length + 1;
  const ultimaFila = primeraFila + gastos.length - 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A${primeraFila}:G${ultimaFila}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: filasDe(gastos, cargadoPor) },
  });
  return primeraFila; // la guardamos para poder corregir después
}

function filasDe(gastos, cargadoPor) {
  return gastos.map((g) => [
    g.fecha, g.monto, g.moneda, g.categoria, g.medio_pago, g.detalle, cargadoPor,
  ]);
}

// ── CORREGIR: recordamos en qué filas quedó la última carga de cada persona ──
const ultimaCarga = {}; // { numero: { primeraFila, gastos, ts } }

function recordarCarga(numero, primeraFila, gastos) {
  ultimaCarga[numero] = { primeraFila, gastos, ts: Date.now() };
}
function obtenerCarga(numero) {
  const c = ultimaCarga[numero];
  if (!c) return null;
  if (Date.now() - c.ts > MINUTOS_VIGENCIA * 60 * 1000) {
    delete ultimaCarga[numero];
    return null;
  }
  return c;
}

// Reescribe las MISMAS filas de la última carga con los datos corregidos
async function corregirGastos(numero, cargadoPor, nuevos) {
  const c = obtenerCarga(numero);
  if (!c) {
    return { ok: false, texto: '🤔 No encuentro un gasto tuyo de los últimos 30 minutos para corregir. Si es uno más viejo, corregilo directo en la planilla.' };
  }
  if (nuevos.length !== c.gastos.length) {
    return { ok: false, texto: '🤔 No me quedó claro qué corregir. ¿Me decís qué dato cambia y de cuál gasto?' };
  }
  const ultimaFila = c.primeraFila + c.gastos.length - 1;
  const rango = `${SHEET_TAB}!A${c.primeraFila}:G${ultimaFila}`;

  // Control: antes de pisar, verificamos que en esas filas siga estando lo que anotamos
  // (por si alguien borró o movió filas en el medio)
  const actual = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: rango,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const filasActuales = actual.data.values || [];
  const coincide = c.gastos.every((g, i) => {
    const f = filasActuales[i] || [];
    return Number(f[1]) === Number(g.monto) && String(f[6] || '') === String(cargadoPor);
  });
  if (!coincide) {
    const filasTxt = c.gastos.length === 1 ? `la fila ${c.primeraFila}` : `las filas ${c.primeraFila} a ${ultimaFila}`;
    return { ok: false, texto: `⚠️ La planilla cambió desde que lo anoté (se movieron o borraron filas). Para no pisar otro gasto no toqué nada: corregilo a mano (estaba en ${filasTxt}).` };
  }

  const corregidos = nuevos.map((g, i) => ({ ...g, fecha: g.fecha || c.gastos[i].fecha }));
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: rango,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: filasDe(corregidos, cargadoPor) },
  });
  recordarCarga(numero, c.primeraFila, corregidos);
  return { ok: true, gastos: corregidos };
}

// Arma la confirmación de WhatsApp a partir de lo que realmente se anotó
function confirmacionGastos(gastos, esCorreccion = false) {
  const linea = (g) => {
    const simbolo = g.moneda === 'US$' ? 'US' : '';
    const partes = [`${simbolo}${formatoPesos(g.monto)}`, g.categoria, g.medio_pago];
    if (g.detalle) partes.push(g.detalle);
    return partes.join(' · ');
  };
  if (gastos.length === 1) return `${esCorreccion ? '✏️ Corregido' : '✅ Anotado'}: ${linea(gastos[0])}`;

  const medios = [...new Set(gastos.map((g) => g.medio_pago))];
  const monedas = [...new Set(gastos.map((g) => g.moneda || 'Pesos'))];
  let encabezado = `${esCorreccion ? '✏️ Corregidos' : '✅ Anotados'} ${gastos.length} gastos`;
  if (medios.length === 1) encabezado += ` · ${medios[0]}`;
  if (monedas.length === 1) {
    const total = gastos.reduce((acc, g) => acc + g.monto, 0);
    encabezado += ` · Total ${monedas[0] === 'US$' ? 'US' : ''}${formatoPesos(total)}`;
  }
  const detalle = gastos.map((g) => {
    const simbolo = g.moneda === 'US$' ? 'US' : '';
    const partes = [`${simbolo}${formatoPesos(g.monto)}`, g.categoria];
    if (medios.length > 1) partes.push(g.medio_pago);
    if (g.detalle) partes.push(g.detalle);
    return `• ${partes.join(' · ')}`;
  });
  return `${encabezado}\n${detalle.join('\n')}`;
}

// ── SEGURO: revisa que los datos estén completos antes de actuar ──
// Si algo viene vacío o raro, devolvemos una repregunta amable en vez de un error técnico.
const REPREGUNTA_GASTO = '🤔 No llegué a entender bien los datos del gasto. ¿Me lo mandás de nuevo con monto, categoría y medio de pago? (podés mandar uno o varios)';
const REPREGUNTA_EVENTO = '🤔 No llegué a entender bien el evento. ¿Me lo repetís con qué es, qué día y a qué hora?';
const PREGUNTA_MP = '🤔 ¿Fue MP-SOSA o MP-PILAU?';
const PREGUNTA_MEDIO = `🤔 ¿Con qué medio de pago fue? Tengo: ${MEDIOS_PAGO.join(', ')}.`;
const PREGUNTA_CATEGORIA = `🤔 ¿En qué categoría lo anoto? Tengo: ${CATEGORIAS.join(', ')}.`;

function validarGastos(r) {
  // Acepta el formato nuevo (lista "gastos") y el viejo ("gasto" suelto)
  let lista = Array.isArray(r.gastos) ? r.gastos : (r.gasto ? [r.gasto] : []);
  lista = lista.filter((g) => g && typeof g === 'object');
  if (lista.length === 0) return { ok: false, motivo: 'lista de gastos vacía' };
  const limpios = [];
  for (const g of lista) {
    const monto = aNumero(g.monto);
    if (!Number.isFinite(monto) || monto <= 0) return { ok: false, motivo: `monto inválido (${g.monto})` };
    if (!g.categoria || !g.medio_pago) return { ok: false, motivo: 'falta categoría o medio de pago' };
    const medio = buscarEnLista(g.medio_pago, MEDIOS_PAGO);
    if (!medio) {
      const esMP = normalizar(g.medio_pago) === 'mp';
      return { ok: false, motivo: `medio de pago fuera de la lista (${g.medio_pago})`, pregunta: esMP ? PREGUNTA_MP : PREGUNTA_MEDIO };
    }
    const categoria = buscarEnLista(g.categoria, CATEGORIAS);
    if (!categoria) return { ok: false, motivo: `categoría fuera de la lista (${g.categoria})`, pregunta: PREGUNTA_CATEGORIA };
    limpios.push({
      fecha: g.fecha || fechaHoyDDMMAAAA(),
      monto,
      moneda: g.moneda === 'US$' ? 'US$' : 'Pesos',
      categoria,
      medio_pago: medio,
      detalle: g.detalle || '',
    });
  }
  return { ok: true, gastos: limpios };
}

function validarEvento(ev) {
  if (!ev || typeof ev !== 'object') return 'evento vacío';
  if (!ev.titulo) return 'falta el título';
  if (!ev.fecha || !/^\d{4}-\d{2}-\d{2}$/.test(ev.fecha)) return `fecha inválida (${ev && ev.fecha})`;
  if (!ev.all_day && !/^\d{2}:\d{2}$/.test(ev.hora_inicio || '')) return `hora inválida (${ev.hora_inicio})`;
  return null; // todo bien
}

// ── AGENDAR ──
async function agendarEvento(ev, numero) {
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

  // Varios recordatorios (Google permite hasta 5)
  const avisos = (Array.isArray(ev.recordatorios_minutos) ? ev.recordatorios_minutos : [])
    .map(Number).filter((m) => Number.isFinite(m) && m >= 0).slice(0, 5);
  // Guardamos en el evento a quién avisar y cuándo (los avisos llegan por WhatsApp)
  if (avisos.length) {
    evento.extendedProperties = { private: { avisos: avisos.join(','), numero: String(numero || '') } };
  }
  if (avisos.length) {
    evento.reminders = {
      useDefault: false,
      overrides: avisos.map((m) => ({ method: 'popup', minutes: m })),
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
  // Seguro: si falta el rango, tomamos hoy
  c = c || {};
  const hoyISO = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.rango_desde || '')) c.rango_desde = hoyISO;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.rango_hasta || '')) c.rango_hasta = c.rango_desde;
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

// ── AUDIOS: pasar de voz a texto con Groq (Whisper) ──
async function transcribirAudio(urlAudio) {
  if (!GROQ_API_KEY) throw new Error('Falta la variable GROQ_API_KEY');
  if (!urlAudio) throw new Error('El audio no trae enlace (media)');
  const audio = await axios.get(urlAudio, { responseType: 'arraybuffer', timeout: 20000 });
  const form = new FormData();
  form.append('file', new Blob([audio.data], { type: 'audio/ogg' }), 'audio.ogg');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'es');
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
  });
  const json = await r.json();
  if (!r.ok) throw new Error(json.error ? json.error.message : `Groq respondió ${r.status}`);
  return json.text || '';
}

// ── RECORDATORIOS POR WHATSAPP ──
// Cada minuto miramos los eventos de los próximos días que tengan avisos,
// y si a alguno le toca aviso en este minuto, mandamos el WhatsApp.
let ultimoChequeo = Date.now();
let revisando = false;
const avisosEnviados = new Set();

function textoFaltan(m) {
  if (m <= 0) return 'ahora';
  if (m < 60) return `en ${m} min`;
  if (m < 1440) { const h = Math.round(m / 60); return `en ${h} hora${h > 1 ? 's' : ''}`; }
  const d = Math.round(m / 1440); return d === 1 ? 'mañana' : `en ${d} días`;
}

async function revisarAvisos() {
  if (revisando || !CALENDAR_ID) return;
  revisando = true;
  const desde = ultimoChequeo;
  const ahora = Date.now();
  ultimoChequeo = ahora;
  try {
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: new Date(ahora - 60 * 1000).toISOString(),
      timeMax: new Date(ahora + 8 * 24 * 3600 * 1000).toISOString(),
      singleEvents: true,
      maxResults: 250,
    }, { timeout: 20000 });

    for (const e of res.data.items || []) {
      const priv = (e.extendedProperties && e.extendedProperties.private) || {};
      if (!priv.avisos || !priv.numero) continue;
      const todoElDia = !!e.start.date;
      const inicio = todoElDia
        ? new Date(`${e.start.date}T00:00:00-03:00`).getTime()
        : new Date(e.start.dateTime).getTime();

      for (const m of priv.avisos.split(',').map(Number)) {
        const momento = inicio - m * 60 * 1000;
        const clave = `${e.id}|${m}`;
        if (momento > desde && momento <= ahora && !avisosEnviados.has(clave)) {
          avisosEnviados.add(clave);
          const cuando = todoElDia ? formatearFecha(e.start.date) : formatearFechaHora(e.start.dateTime);
          const texto = todoElDia
            ? `⏰ Recordatorio: ${e.summary} · ${cuando}`
            : `⏰ Recordatorio: ${e.summary} · ${cuando} · ${textoFaltan(m)}`;
          console.log('🕵️ [aviso] Enviando:', texto, 'a', priv.numero);
          await enviarWhatsApp(priv.numero, texto);
        }
      }
    }
  } catch (err) {
    console.error('Error revisando avisos:', err.message);
  } finally {
    revisando = false;
  }
}

// ── RUTAS ──
app.get('/', (req, res) => res.send('Bot de gastos + agenda funcionando ✅'));

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // respondemos ya para que UltraMsg no reintente

  let numero = null;
  try {
    const data = req.body.data;
    console.log('🕵️ [0] Llegó webhook:', data ? `tipo=${data.type} fromMe=${data.fromMe} de=${data.from}` : 'sin datos');
    const esAudio = data && (data.type === 'ptt' || data.type === 'audio');
    if (!data || data.fromMe || (data.type !== 'chat' && !esAudio)) return;

    numero = String(data.from).split('@')[0];
    const nombre = allowedUsers[numero];
    if (!nombre) { console.log('🕵️ Número no autorizado:', numero); return; }

    let mensajeUsuario = data.body || '';
    let prefijoAudio = '';
    if (esAudio) {
      console.log('🕵️ [0b] Es un audio, transcribiendo:', data.media);
      try {
        mensajeUsuario = await transcribirAudio(data.media);
        console.log('🕵️ [0c] Transcripción:', mensajeUsuario);
      } catch (e) {
        console.error('Error transcribiendo audio:', e.message);
        await enviarWhatsApp(numero, '🎤 No pude escuchar bien el audio. ¿Me lo mandás de nuevo o por escrito?');
        return;
      }
      if (!mensajeUsuario.trim()) {
        await enviarWhatsApp(numero, '🎤 El audio me llegó vacío. ¿Me lo repetís?');
        return;
      }
      // Le mostramos lo que entendió, para que pueda chequear
      prefijoAudio = `🎤 _${mensajeUsuario.trim()}_\n\n`;
    }
    console.log('🕵️ [1] Llegó mensaje de', nombre, ':', mensajeUsuario);

    // Traemos el contexto de los mensajes anteriores de esta persona
    const contexto = obtenerHistorial(numero);

    let r;
    try {
      r = await interpretar(mensajeUsuario, contexto);
    } catch (errInterp) {
      // Seguro: si Claude devolvió algo que no se puede leer, repreguntamos
      console.error('🕵️ No se pudo interpretar la respuesta de Claude:', errInterp.message);
      await enviarWhatsApp(numero, prefijoAudio + '🤔 Me mareé con ese mensaje. ¿Me lo mandás de nuevo, un poquito más claro?');
      return;
    }
    if (!r || typeof r !== 'object') r = { accion: 'charla', completo: false };
    let respuesta = r.respuesta || '🤔 No te entendí bien. ¿Me lo repetís?';

    if (r.completo) {
      try {
        if (r.accion === 'gasto') {
          const v = validarGastos(r);
          if (!v.ok) {
            console.log('🕵️ Seguro activado (gasto):', v.motivo);
            respuesta = v.pregunta || REPREGUNTA_GASTO;
            r.completo = false; // así la próxima respuesta se toma como el dato que faltaba
          } else {
            const primeraFila = await anotarGastos(v.gastos, nombre);
            recordarCarga(numero, primeraFila, v.gastos);
            r.gastos = v.gastos;
            respuesta = confirmacionGastos(v.gastos);
          }
        } else if (r.accion === 'corregir') {
          const v = validarGastos(r);
          if (!v.ok) {
            console.log('🕵️ Seguro activado (corrección):', v.motivo);
            respuesta = v.pregunta || '🤔 No me quedó claro qué corregir. ¿Me decís qué dato cambia?';
            r.completo = false;
          } else {
            const c = await corregirGastos(numero, nombre, v.gastos);
            if (c.ok) {
              r.gastos = c.gastos;
              respuesta = confirmacionGastos(c.gastos, true);
            } else {
              console.log('🕵️ Corrección no aplicada:', c.texto);
              respuesta = c.texto;
              r.completo = false;
            }
          }
        } else if (r.accion === 'agendar') {
          const problema = validarEvento(r.evento);
          if (problema) {
            console.log('🕵️ Seguro activado (evento):', problema);
            respuesta = REPREGUNTA_EVENTO;
            r.completo = false;
          } else {
            await agendarEvento(r.evento, numero);
          }
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

    await enviarWhatsApp(numero, prefijoAudio + respuesta);
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
app.listen(PORT, () => {
  console.log(`Bot escuchando en el puerto ${PORT}`);
  setInterval(revisarAvisos, 60 * 1000); // revisa los recordatorios cada minuto
});
