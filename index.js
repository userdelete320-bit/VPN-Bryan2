const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Telegraf } = require('telegraf');
// Control de solicitudes de prueba en curso (evita duplicados)
const pendingTrialLocks = new Map(); // userId -> timestamp
// Tiempo de inicio del bot (para uptime)
const START_TIME = Date.now();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
const db = require('./supabase');

// ==================== PLAN TYPES ====================
// Todos los tipos de plan con pool propio
const PLAN_TYPES = ['basico', 'avanzado', 'cuba_vip', 'premium', 'anual'];
// ==================== STUB MÉTODOS TRIAL FILES (uno por plan) ====================
// Cada función acepta planType para operar sobre la tabla/bucket correcto.
// Las tablas en Supabase se llaman: trial_files_basico, trial_files_avanzado,
// trial_files_premium, trial_files_anual

function getTrialTableName(planType) {
  const valid = ['basico', 'avanzado', 'cuba_vip', 'premium', 'anual'];
  return valid.includes(planType) ? `trial_files_${planType}` : 'trial_files_basico';
}

function getSbClient() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
  );
}

if (!db.getTrialFilesByPlan) {
  db.getTrialFilesByPlan = async (planType) => {
    try {
      const sb = getSbClient();
      const table = getTrialTableName(planType);
      const { data, error } = await sb.from(table).select('*').order('uploaded_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch(e) { console.warn(`⚠️ trial_files_${planType} tabla no existe aún:`, e.message); return []; }
  };
}

if (!db.getTrialFileByPlan) {
  db.getTrialFileByPlan = async (planType, id) => {
    try {
      const sb = getSbClient();
      const table = getTrialTableName(planType);
      const { data, error } = await sb.from(table).select('*').eq('id', id).single();
      if (error) throw error;
      return data;
    } catch(e) { return null; }
  };
}

if (!db.saveTrialFileByPlan) {
  db.saveTrialFileByPlan = async (planType, fileData) => {
    try {
      const sb = getSbClient();
      const table = getTrialTableName(planType);
      const { data, error } = await sb.from(table).insert([fileData]).select().single();
      if (error) throw error;
      return data;
    } catch(e) { console.warn(`⚠️ saveTrialFileByPlan(${planType}) falló:`, e.message); return fileData; }
  };
}

if (!db.updateTrialFileByPlan) {
  db.updateTrialFileByPlan = async (planType, id, updateData) => {
    try {
      const sb = getSbClient();
      const table = getTrialTableName(planType);
      const { data, error } = await sb.from(table).update({ ...updateData, updated_at: new Date().toISOString() }).eq('id', id).select().single();
      if (error) throw error;
      return data;
    } catch(e) { return null; }
  };
}

if (!db.deleteTrialFileByPlan) {
  db.deleteTrialFileByPlan = async (planType, id) => {
    try {
      const sb = getSbClient();
      const table = getTrialTableName(planType);
      const { error } = await sb.from(table).delete().eq('id', id);
      if (error) throw error;
      return true;
    } catch(e) { return false; }
  };
}

// Compatibilidad: stubs legacy (sin plan) — redirigen a basico por defecto
if (!db.getTrialFiles)    db.getTrialFiles    = async () => db.getTrialFilesByPlan('basico');
if (!db.getTrialFile)     db.getTrialFile     = async (id) => db.getTrialFileByPlan('basico', id);
if (!db.saveTrialFile)    db.saveTrialFile    = async (d) => db.saveTrialFileByPlan('basico', d);
if (!db.updateTrialFile)  db.updateTrialFile  = async (id, d) => db.updateTrialFileByPlan('basico', id, d);
if (!db.deleteTrialFile)  db.deleteTrialFile  = async (id) => db.deleteTrialFileByPlan('basico', id);

const PORT = process.env.PORT || 5000;

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SUPER_ADMIN_ID = '6373481979'; // Jefe de todos los admins, no se puede quitar

let ADMIN_IDS = process.env.ADMIN_TELEGRAM_IDS ?
    process.env.ADMIN_TELEGRAM_IDS.split(',').map(id => id.trim()) :
    ['6373481979', '5376388604', '6974850309', '7846534518', '8782244257'];

// Carga la lista de admins desde Supabase (tabla bot_admins) y la fusiona con el super admin.
async function loadAdminsFromDb() {
    try {
        const sb = getSbClient();
        const { data, error } = await sb.from('bot_admins').select('telegram_id');
        if (error) throw error;
        const dbIds = (data || []).map(r => String(r.telegram_id));
        const merged = Array.from(new Set([SUPER_ADMIN_ID, ...dbIds]));
        ADMIN_IDS = merged;
        console.log('✅ Admins cargados desde BD:', ADMIN_IDS);
    } catch (e) {
        console.error('❌ Error cargando admins desde BD (se usa lista por defecto):', e.message);
    }
}

const USDT_CONFIG = {
    WALLET_ADDRESS: '0x9065C7d2cC04134A55F6Abf2B4118C11A8A01ff2',
    BSCSCAN_API_KEY: '',
    USDT_CONTRACT_ADDRESS: '0x55d398326f99059ff775485246999027b3197955',
    CHECK_INTERVAL: 0,
    MIN_CONFIRMATIONS: 3
};

// Precios por defecto (fallback si la BD aún no tiene datos)
const DEFAULT_PLAN_PRICES = {
    basico:   { cup: 900,   mobile: 400,   usdt: 0.7,  stars: 150,  ton: 2.0 },
    avanzado: { cup: 1800,  mobile: 900,   usdt: 1.4,  stars: 270,  ton: 3.0 },
    cuba_vip: { cup: 1200,  mobile: 500,   usdt: 2.0,  stars: 180,  ton: 2.2 },
    premium:  { cup: 1500,  mobile: 700,   usdt: 1.1,  stars: 210,  ton: 2.5 },
    anual:    { cup: 15000, mobile: 10000, usdt: 30,   stars: 2100, ton: 26.0 }
};

let PLAN_PRICES = JSON.parse(JSON.stringify(DEFAULT_PLAN_PRICES));

// Objetos derivados que el resto del código ya usa (se actualizan junto con PLAN_PRICES)
let USDT_PRICES = {};
let STARS_PRICES = {};
let TON_PRICES = {};

function rebuildDerivedPriceObjects() {
    USDT_PRICES = {}; STARS_PRICES = {}; TON_PRICES = {};
    for (const plan of Object.keys(PLAN_PRICES)) {
        USDT_PRICES[plan] = String(PLAN_PRICES[plan].usdt);
        STARS_PRICES[plan] = Number(PLAN_PRICES[plan].stars);
        TON_PRICES[plan] = Number(PLAN_PRICES[plan].ton);
    }
}
rebuildDerivedPriceObjects();

// Carga los precios actuales desde Supabase (tabla plan_prices) y reconstruye los derivados.
async function loadPlanPricesFromDb() {
    try {
        const sb = getSbClient();
        const { data, error } = await sb.from('plan_prices').select('*');
        if (error) throw error;
        if (data && data.length) {
            const merged = JSON.parse(JSON.stringify(DEFAULT_PLAN_PRICES));
            for (const row of data) {
                if (merged[row.plan]) {
                    merged[row.plan] = {
                        cup: Number(row.cup), mobile: Number(row.mobile),
                        usdt: Number(row.usdt), stars: Number(row.stars), ton: Number(row.ton)
                    };
                }
            }
            PLAN_PRICES = merged;
            rebuildDerivedPriceObjects();
        }
        console.log('✅ Precios de planes cargados desde BD');
    } catch (e) {
        console.error('❌ Error cargando precios desde BD (se usan valores por defecto):', e.message);
    }
}
  

const WHATSAPP_GROUP_LINK = 'https://chat.whatsapp.com/Fj5dBROMqmeECOllIjVEYu?mode=gi_t';
const WHATSAPP_GROUP2_LINK = 'https://chat.whatsapp.com/JlRxfIjxlLI7aF4f9YRGJI';

function isAdmin(userId) {
    return ADMIN_IDS.includes(userId.toString());
}

function isSuperAdmin(userId) {
    return userId?.toString() === SUPER_ADMIN_ID;
}

async function canSendMessageToUser(telegramId) {
    try {
        await bot.telegram.sendChatAction(telegramId, 'typing');
        return { canSend: true, reason: 'Usuario disponible' };
    } catch (error) {
        console.log(`❌ Usuario ${telegramId} no disponible: ${error.description || error.message}`);
        return {
            canSend: false,
            reason: error.description || error.message,
            errorCode: error.response?.error_code || 400
        };
    }
}

const BUTTON_ICONS = {
    'VER PLANES': '5312361253610475399',
    'MI PERFIL': '5197269100878907942',
    'DESCARGAR VPN': '5443127283898405358',
    'SOPORTE': '5337080053119336309',
    'REFERIDOS': '5332724926216428039',
    'CÓMO FUNCIONA': '5422439311196834318',
    'VPN CANAL': '5332455502917949981',
    'POLÍTICAS': '5444856076954520455',
    'WHATSAPP': '5935973359480213803',
    'WHATSAPP G1': '5282843764451195532',
    'WHATSAPP G2': '5282843764451195532',   // Nuevo: emoji custom para Grupo 2
    'FAQ': '5443038326535759644',
    'PANEL ADMIN': '6325570573044815610',
    'WINDOWS': '6005916300600152073',
    'IOS': '5931544299010266023',
    'ANDROID': '5931594395508805861',
    'CEO': '6021659919835469581',
    'ADMIN': '5839116473951328489',
    'MOD': '6021401276904905698',
    'COPIAR ENLACE': '5877465816030515018',
    'VER GUÍA COMPLETA': '6028435952299413210',
    'TÉRMINOS DE SERVICIO': '5440539497383087970',
    'POLÍTICA DE REEMBOLSO': '5447203607294265305',
    'POLÍTICA DE PRIVACIDAD': '5453902265922376865',
    'VER PREGUNTAS FRECUENTES': '5873121512445187130',
    'MENÚ PRINCIPAL': '5415655814079723871',
    'RENOVAR AHORA': '6019175208240289774',
    'ABRIR PANEL WEB': '5839116473951328489',
    'SAYKO': '5884179047482659474',
    'ROVER': '5884179047482659474',
    'SOLICITAR REEMBOLSO': '5444856076954520455'
};

function createButton(text, options) {
    const button = { text };
    const iconId = BUTTON_ICONS[text.toUpperCase()];
    if (iconId) button.icon_custom_emoji_id = iconId;
    Object.assign(button, options);
    return button;
}

function getVipStatusHtml(user) {
    const vipSince = formatearFecha(user.vip_since);
    const diasRestantes = calcularDiasRestantes(user);
    const planNombre = user.plan ? getPlanName(user.plan) : 'No especificado';
    let html = `<tg-emoji emoji-id="6019175208240289774">👑</tg-emoji> <b>¡ERES USUARIO VIP!</b>\n\n`;
    html += `<tg-emoji emoji-id="6023880246128810031">📅</tg-emoji> <b>Activado:</b> ${vipSince}\n`;
    html += `<tg-emoji emoji-id="6021435576513730578">📋</tg-emoji> <b>Plan:</b> ${planNombre}\n`;
    html += `<tg-emoji emoji-id="5778202206922608769">⏳</tg-emoji> <b>Días restantes:</b> ${diasRestantes} días\n`;
    html += `<tg-emoji emoji-id="5992430854909989581">💰</tg-emoji> <b>Precio:</b> $${user.plan_price || '0'} CUP\n\n`;
    if (diasRestantes <= 7) {
        html += `<tg-emoji emoji-id="6019102674832595118">⚠️</tg-emoji> <b>TU PLAN ESTÁ POR EXPIRAR PRONTO</b>\nRenueva ahora para mantener tu acceso VIP.\n\n`;
    } else {
        html += `Tu acceso está activo. ¡Disfruta de baja latencia! 🚀\n\n`;
    }
    return html;
}

function getDownloadWireguardHtml() {
    return `<tg-emoji emoji-id="6019168392127190964">💻</tg-emoji> <b>DESCARGAR VPN</b> <tg-emoji emoji-id="6019099814384378473">📱</tg-emoji>\n\n` +
           `<b>Para Windows</b>\nAplicación Oficial de WireGuard para Windows:\nEnlace: https://www.wireguard.com/install/\n\n` +
           `<b>Para Android</b>\nAplicación Oficial de WireGuard en Google Play Store:\nEnlace: https://play.google.com/store/apps/details?id=com.wireguard.android\n\n` +
           `<b>Para iOS (iPhone / iPad)</b>\nAplicación Oficial de WireGuard en App Store:\nEnlace: https://apps.apple.com/app/id1441195209\n\n` +
           `Selecciona tu sistema operativo:`;
}

function getSupportHtml() {
    return `🛠 <b>Soporte VPN CUBA</b>\n\n` +
           `<tg-emoji emoji-id="5807453545548487345">👉</tg-emoji> @vpncubawire (CEO)\n` +
           `<tg-emoji emoji-id="5807453545548487345">👉</tg-emoji> @ErenJeager129182 (Admin)\n` +
           `<tg-emoji emoji-id="5807453545548487345">👉</tg-emoji> @JosherSnchz (Moderador)\n\n` +
           `Responde rápido y te ayudaremos.`;
}

function getReferralInfoHtml(userId, referralStats) {
    const referralLink = `https://t.me/vpncubaw_bot?start=ref${userId}`;
    const totalReferidos = (referralStats?.level1?.total || 0) + (referralStats?.level2?.total || 0);
    const descuento = referralStats?.discount_percentage || 0;
    const detalle = descuento >= 30 ? 'Alto' : descuento >= 15 ? 'Medio' : 'Bajo';

    let html = `<tg-emoji emoji-id="5944956300759668915">🤝</tg-emoji> <b>SISTEMA DE REFERIDOS</b>\n\n` +
               `<tg-emoji emoji-id="5778168620278354602">🔗</tg-emoji> <b>Tu enlace único:</b>\n${referralLink}\n\n` +
               `<tg-emoji emoji-id="5190806721286657692">📊</tg-emoji> Total referidos: ${totalReferidos}\n` +
               `<tg-emoji emoji-id="5987880246865565644">💰</tg-emoji> Descuentos por Referidos sin usar: ${descuento}%\n\n` +
               `<i>Detalle: ${detalle}</i>\n\n` +
               `<tg-emoji emoji-id="6023897907034330805">💡</tg-emoji> Cada referido que paga te da 20% (nivel 1) o 10% (nivel 2). El descuento se reduce al usarlo (40%→20%→0%).`;
    return html;
}

function getHowItWorksHtml() {
    return `<tg-emoji emoji-id="5873121512445187130">🚀</tg-emoji> <b>¿CÓMO FUNCIONA VPN CUBA?</b>\n\n` +
           `Descubre cómo optimizamos tu conexión para gaming y navegación.\n\n` +
           `Haz clic en el botón para ver la guía completa en nuestra Web App:`;
}

function getPoliticasHtml() {
    return `<tg-emoji emoji-id="5956561916573782596">📜</tg-emoji> <b>Políticas de VPN Cuba</b>\n\n` +
           `Selecciona una sección para ver los detalles completos en nuestra Web App:`;
}

function getFaqHtml() {
    return `<tg-emoji emoji-id="5873121512445187130">❓</tg-emoji> <b>PREGUNTAS FRECUENTES (FAQ)</b>\n\n` +
           `Encuentra respuestas a las dudas más comunes sobre nuestros servicios, pagos, instalación y más.\n\n` +
           `Haz clic en el botón para abrir la sección de preguntas frecuentes:`;
}

function buildMainMenuKeyboard(userId, firstName, esAdmin, isGroup = false) {
    const webappUrl = `${process.env.WEBAPP_URL || `http://localhost:${PORT}`}`;
    const plansUrl = `${webappUrl}/plans.html?userId=${userId}`;
    const adminUrl = `${webappUrl}/admin.html?userId=${userId}&admin=true`;
    const inlineKeyboard = [
        [
            createButton("VER PLANES", isGroup ? { url: plansUrl } : { web_app: { url: plansUrl } }),
            createButton("MI PERFIL", { callback_data: "check_status" })
        ],
        [
            createButton("DESCARGAR VPN", { callback_data: "download_wireguard" }),
            createButton("SOPORTE", { callback_data: "show_support" })
        ],
        [
            createButton("REFERIDOS", { callback_data: "referral_info" }),
            createButton("CÓMO FUNCIONA", { callback_data: "how_it_works" })
        ],
        [
            createButton("VPN CANAL", { url: "https://t.me/vpncubaw" }),
            createButton("POLÍTICAS", { callback_data: "politicas" })
        ],
        [
            createButton("WHATSAPP G1", { url: WHATSAPP_GROUP_LINK }),   // 👈 sin emoji, solo texto
            createButton("WHATSAPP G2", { url: WHATSAPP_GROUP2_LINK })    // 👈 sin emoji, solo texto
        ],
        [createButton("FAQ", { callback_data: "faq" })]
    ];
    if (esAdmin && !isGroup) {
        inlineKeyboard.push([createButton("PANEL ADMIN", { web_app: { url: adminUrl } })]);
    }
    return { reply_markup: { inline_keyboard: inlineKeyboard } };
}

function wa(url, ctx) {
    const chatType = ctx.chat?.type || ctx.callbackQuery?.message?.chat?.type;
    const inGroup = chatType === 'group' || chatType === 'supergroup';
    return inGroup ? { url } : { web_app: { url } };
}
function isGroupCtx(ctx) {
    const chatType = ctx.chat?.type || ctx.callbackQuery?.message?.chat?.type;
    return chatType === 'group' || chatType === 'supergroup';
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/assets', express.static('assets'));

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => { cb(null, Date.now() + path.extname(file.originalname)); }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'screenshot' || file.fieldname === 'refundProof') {
      const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (allowedTypes.includes(file.mimetype)) cb(null, true);
      else cb(new Error('Solo se permiten imágenes JPG, PNG, GIF o WebP'));
    } else if (file.fieldname === 'mediaFile') {
      if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) cb(null, true);
      else cb(new Error('Solo se permiten imágenes o videos'));
    } else if (['configFile', 'trialConfigFile', 'planFile', 'file'].includes(file.fieldname)) {
      const allowedExtensions = ['.conf', '.zip', '.rar'];
      const allowedMimeTypes = [
        'application/zip', 'application/x-rar-compressed',
        'application/x-zip-compressed', 'application/octet-stream',
        'text/plain', 'application/x-conf'
      ];
      const fileExt = path.extname(file.originalname).toLowerCase();
      if (allowedExtensions.includes(fileExt) || allowedMimeTypes.includes(file.mimetype.toLowerCase())) cb(null, true);
      else cb(new Error('Solo se permiten archivos .conf, .zip o .rar'));
    } else {
      cb(null, true);
    }
  }
});

const UPLOADS_DIR = path.join(__dirname, 'uploads');
// Carpetas por plan
const TRIAL_DIRS = {};
for (const pt of PLAN_TYPES) {
  TRIAL_DIRS[pt] = path.join(__dirname, `uploads/trial_files_${pt}`);
}
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
for (const pt of PLAN_TYPES) {
  if (!fs.existsSync(TRIAL_DIRS[pt])) fs.mkdirSync(TRIAL_DIRS[pt], { recursive: true });
}
if (!fs.existsSync('public')) fs.mkdirSync('public', { recursive: true });

// Ruta de fallback (archivo de plan individual para trial legacy)
const TRIAL_CURRENT_FILE = path.join(UPLOADS_DIR, 'trial_files_basico', 'trial_current');

function getPlanName(planType) {
  const plans = {
    'basico': 'Básico (1 mes)',
    'avanzado': 'Avanzado (2 meses)',
    'cuba_vip': 'Cuba VIP (1 mes)',
    'premium': 'Gaming (1 mes)',
    'anual': 'Anual (12 meses)',
    'trial': 'Prueba Gratuita'
  };
  return plans[planType] || planType;
}

function getPlanLabel(planType) {
  const labels = {
    'basico': '🌐 Básico',
    'avanzado': '🌟 Avanzado',
    'cuba_vip': '🇨🇺 Cuba VIP',
    'premium': '🎮 Gaming',
    'anual': '📅 Anual'
  };
  return labels[planType] || planType;
}

function generateUniqueUsdtAddress() { return USDT_CONFIG.WALLET_ADDRESS; }

function formatearFecha(fecha) {
    if (!fecha) return 'N/A';
    try {
        const date = new Date(fecha);
        if (isNaN(date.getTime())) return 'Fecha inválida';
        return date.toLocaleDateString('es-ES', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            timeZone: 'America/Havana'
        });
    } catch (error) { return 'Error fecha'; }
}

function calcularDiasRestantes(user) {
    if (!user.vip || !user.vip_since || !user.plan) return 0;
    const fechaInicio = new Date(user.vip_since);
    const fechaActual = new Date();
    let duracionDias;
    switch(user.plan.toLowerCase()) {
        case 'basico': duracionDias = 30; break;
        case 'avanzado': duracionDias = 60; break;
        case 'cuba_vip': duracionDias = 30; break;
        case 'premium': duracionDias = 30; break;
        case 'anual': duracionDias = 365; break;
        default: duracionDias = 30;
    }
    const fechaExpiracion = new Date(fechaInicio);
    fechaExpiracion.setDate(fechaExpiracion.getDate() + duracionDias);
    const diferenciaMs = fechaExpiracion - fechaActual;
    return Math.max(0, Math.ceil(diferenciaMs / (1000 * 60 * 60 * 24)));
}

async function checkUsdtTransactions() {
    console.log('⚠️ Verificación automática USDT desactivada');
    return { success: true, message: 'Flujo manual' };
}

async function initializeUsdtSystem() {
    console.log('💸 Sistema USDT en modo MANUAL');
}

async function createStorageBucket(bucketName, isPublic = true) {
  try {
    const { data: buckets, error: listError } = await supabaseAdmin.storage.listBuckets();
    if (listError) { console.error('❌ Error listando buckets:', listError.message); return { success: false, error: listError.message }; }
    const bucketExists = buckets?.some(b => b.name === bucketName);
    if (bucketExists) { console.log(`✅ Bucket ${bucketName} ya existe`); return { success: true, exists: true }; }
    const { data, error } = await supabaseAdmin.storage.createBucket(bucketName, {
      public: isPublic, allowedMimeTypes: null, fileSizeLimit: 20971520, avifAutodetection: false
    });
    if (error) { console.error(`❌ Error creando bucket ${bucketName}:`, error.message); return await createBucketViaAPI(bucketName, isPublic); }
    console.log(`✅ Bucket ${bucketName} creado exitosamente`);
    return { success: true, data };
  } catch (error) { console.error(`❌ Error en createStorageBucket:`, error.message); return { success: false, error: error.message }; }
}

async function createBucketViaAPI(bucketName, isPublic = true) {
  try {
    const response = await fetch(`${process.env.SUPABASE_URL}/storage/v1/bucket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY },
      body: JSON.stringify({ name: bucketName, public: isPublic, allowed_mime_types: null, file_size_limit: 20971520 })
    });
    if (response.ok) { console.log(`✅ Bucket ${bucketName} creado via API REST`); return { success: true }; }
    else { const errorText = await response.text(); console.error(`❌ Error API REST para ${bucketName}:`, errorText); return { success: false, error: errorText }; }
  } catch (error) { return { success: false, error: error.message }; }
}

async function verifyStorageBuckets() {
  try {
    const buckets = ['payments-screenshots', 'plan-files', 'trial-files-basico', 'trial-files-avanzado', 'trial-files-premium', 'trial-files-anual'];
    for (const bucketName of buckets) {
      try {
        const { data, error } = await supabaseAdmin.storage.from(bucketName).list();
        if (error && error.message.includes('not found')) { console.log(`📦 Creando bucket ${bucketName}...`); await createStorageBucket(bucketName, true); }
        else if (error) console.error(`⚠️ Error verificando ${bucketName}:`, error.message);
        else console.log(`✅ Bucket ${bucketName} existe`);
      } catch (bucketError) { console.error(`⚠️ Error procesando ${bucketName}:`, bucketError.message); }
    }
  } catch (error) { console.error('❌ Error en verifyStorageBuckets:', error.message); }
}

async function initializeStorageBuckets() {
  console.log('🚀 Inicializando buckets...');
  const buckets = [
    { name: 'payments-screenshots', public: true },
    { name: 'plan-files', public: true },
    { name: 'trial-files-basico', public: true },
    { name: 'trial-files-avanzado', public: true },
    { name: 'trial-files-premium', public: true },
    { name: 'trial-files-anual', public: true }
  ];
  for (const bucket of buckets) { await createStorageBucket(bucket.name, bucket.public); }
  console.log('✅ Inicialización de buckets completada');
}

// ==================== ENVIAR PRUEBA (POOL POR PLAN) ====================
 async function sendTrialConfigToUser(telegramId, adminId, deleteAfterSend = true) {
  try {
    const user = await db.getUser(telegramId);
    if (!user) throw new Error(`Usuario ${telegramId} no encontrado`);

    const gameServer = user.trial_game_server || 'No especificado';
    const connectionType = user.trial_connection_type || 'No especificado';
    const trialPlanType = user.trial_plan_type || 'basico';
    const planLabel = getPlanLabel(trialPlanType);

    let filePath = null;
    let fileName = null;
    let fileId = null;

    // 1. Intentar pool del plan correspondiente (BD)
    try {
      const trialFiles = await db.getTrialFilesByPlan(trialPlanType);
      const activeFiles = (trialFiles || []).filter(f => f.is_active !== false && f.local_path && fs.existsSync(f.local_path));
      if (activeFiles.length > 0) {
        const chosen = activeFiles[0];
        filePath = chosen.local_path;
        fileName = chosen.original_name;
        fileId = chosen.id;
        console.log(`📁 Pool ${trialPlanType}: usando archivo #${chosen.id}: ${fileName}`);
      }
    } catch (dbErr) {
      console.warn(`⚠️ No se pudieron obtener archivos del pool ${trialPlanType}:`, dbErr.message);
    }

    // 2. Fallback: archivo local legacy (ruta fija)
    if (!filePath) {
      const dir = TRIAL_DIRS[trialPlanType] || TRIAL_DIRS['basico'];
      for (const ext of ['.conf', '.zip', '.rar']) {
        const testPath = path.join(dir, 'trial_current' + ext);
        if (fs.existsSync(testPath)) {
          filePath = testPath;
          fileName = `config_${trialPlanType}${ext}`;
          break;
        }
      }
    }

    // 3. Fallback: descargar desde Supabase public_url
    if (!filePath) {
      try {
        const trialFiles = await db.getTrialFilesByPlan(trialPlanType);
        const urlFiles = (trialFiles || []).filter(f => f.is_active !== false && f.public_url);
        if (urlFiles.length > 0) {
          const chosen = urlFiles[0];
          console.log(`🌐 Descargando desde Supabase (${trialPlanType}): ${chosen.public_url}`);
          const urlResponse = await fetch(chosen.public_url);
          if (urlResponse.ok) {
            const arrayBuf = await urlResponse.arrayBuffer();
            const ext = path.extname(chosen.original_name || '') || '.conf';
            const dir = TRIAL_DIRS[trialPlanType] || TRIAL_DIRS['basico'];
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const tempPath = path.join(dir, `trial_dl_${Date.now()}${ext}`);
            fs.writeFileSync(tempPath, Buffer.from(arrayBuf));
            filePath = tempPath;
            fileName = chosen.original_name || path.basename(tempPath);
            fileId = chosen.id;
            console.log(`✅ Archivo descargado (${trialPlanType}): ${fileName}`);
          }
        }
      } catch (urlErr) {
        console.warn(`⚠️ No se pudo descargar archivo desde Supabase (${trialPlanType}):`, urlErr.message);
      }
    }

    if (!filePath) {
      throw new Error(`No hay archivo de prueba disponible para el plan ${planLabel}. Sube uno en el panel de admin → Pool de Pruebas.`);
    }

    // Envío único sin reintentos
    await bot.telegram.sendDocument(
      telegramId,
      { source: filePath, filename: fileName },
      {
        caption: `<tg-emoji emoji-id="5875465628285931233">🎁</tg-emoji> <b>¡Tu prueba gratuita de VPN Cuba está lista!</b>\n\n` +
                 `<tg-emoji emoji-id="6021375494216226506">📁</tg-emoji> <b>Archivo:</b> ${fileName}\n` +
                 `<tg-emoji emoji-id="6021744990252702234">📋</tg-emoji> <b>Plan probado:</b> ${planLabel}\n\n` +
                 `<tg-emoji emoji-id="6021744990252702234">🎮</tg-emoji> <b>Juego/Servidor:</b> ${gameServer}\n` +
                 `<tg-emoji emoji-id="6021744990252702234">📡</tg-emoji> <b>Conexión:</b> ${connectionType}\n\n` +
                 `<b>Instrucciones de instalación:</b>\n` +
                 `1. Descarga este archivo\n` +
                 `2. Importa el archivo .conf en tu cliente WireGuard\n` +
                 `3. Activa la conexión\n` +
                 `4. ¡Disfruta de 1 hora de prueba gratis! <tg-emoji emoji-id="4978747001718966118">🎉</tg-emoji>\n\n` +
                 `<tg-emoji emoji-id="5778202206922608769">⏰</tg-emoji> <b>Duración:</b> 1 hora\n` +
                 `<b>Importante:</b> Esta configuración expirará en 1 hora.`,
        parse_mode: 'HTML'
      }
    );

    await db.markTrialAsSent(telegramId, adminId);
    console.log(`✅ Prueba ${planLabel} enviada a ${telegramId}: ${fileName}`);

    if (deleteAfterSend && fileId) {
      try {
        if (filePath && fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`🗑️ Archivo eliminado: ${filePath}`);
        }
        await db.deleteTrialFileByPlan(trialPlanType, fileId);
        console.log(`🗑️ Registro #${fileId} del pool ${trialPlanType} eliminado`);
      } catch (delErr) {
        console.warn(`⚠️ No se pudo eliminar archivo #${fileId}:`, delErr.message);
      }
    }
    return true;
  } catch (error) {
    console.error(`❌ Error en sendTrialConfigToUser para ${telegramId}:`, error.message);
    throw error;
  }
      }
      
      

async function sendTrialToValidUsers(adminId) {
  try {
    console.log('🎯 Enviando pruebas a usuarios pendientes...');
    const pendingTrials = await db.getPendingTrials();
    if (!pendingTrials || pendingTrials.length === 0) {
      console.log('📭 No hay pruebas pendientes');
      return { success: true, message: 'No hay pruebas pendientes' };
    }

    let sentCount = 0;
    let failedCount = 0;
    let unavailableCount = 0;
    const processedUsers = new Set(); // Evita duplicados en la misma ejecución

    for (let i = 0; i < pendingTrials.length; i++) {
      const user = pendingTrials[i];
      const userId = user.telegram_id;

      if (processedUsers.has(userId)) {
        console.log(`⏭️ Usuario ${userId} ya fue procesado en esta ronda, omitiendo.`);
        continue;
      }

      // Refrescar estado desde BD
      let freshUser;
      try {
        freshUser = await db.getUser(userId);
      } catch (err) {
        console.warn(`⚠️ No se pudo obtener usuario actualizado ${userId}:`, err.message);
        freshUser = user;
      }

      if (!freshUser || !freshUser.trial_requested || freshUser.trial_received) {
        console.log(`⏭️ Usuario ${userId} ya no está pendiente, omitiendo.`);
        continue;
      }

      processedUsers.add(userId);

      try {
        await sendTrialConfigToUser(userId, adminId, true);
        sentCount++;
        await new Promise(resolve => setTimeout(resolve, 80));
      } catch (error) {
        failedCount++;
        const errMsg = error.description || error.message || '';
        const isPermanent = errMsg.includes('chat not found') || errMsg.includes('blocked') ||
                            errMsg.includes('user is deactivated') || errMsg.includes('kicked');
        if (isPermanent) {
          unavailableCount++;
          try {
            await db.updateUser(userId, { is_active: false, last_error: errMsg, updated_at: new Date().toISOString() });
          } catch (e) {}
        }
        console.error(`❌ Error enviando prueba a ${userId}:`, errMsg);
      }
    }

    console.log(`✅ Envío completado: ${sentCount} enviadas, ${failedCount} fallidas, ${unavailableCount} no disponibles`);
    return { success: true, sent: sentCount, failed: failedCount, unavailable: unavailableCount, total: pendingTrials.length };
  } catch (error) {
    console.error('❌ Error en sendTrialToValidUsers:', error);
    return { success: false, error: error.message };
  }
}
async function getAllUsersForBroadcast(target) {
  try {
    if (target !== 'all' && target !== 'active') {
      const users = await db.getUsersForBroadcast(target);
      console.log(`📢 Broadcast target "${target}": ${users.length} usuarios`);
      return users;
    }
    console.log(`📢 Broadcast target "${target}": obteniendo TODOS con paginación...`);
    const allUsers = await db.getAllUsers(1000000, 0);
    let filtered = allUsers;
    if (target === 'active') {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      filtered = allUsers.filter(u => u.last_activity && new Date(u.last_activity) >= thirtyDaysAgo);
    }
    console.log(`📢 Broadcast target "${target}": ${filtered.length} usuarios (de ${allUsers.length} totales)`);
    return filtered;
  } catch (err) {
    console.error('❌ Error en getAllUsersForBroadcast:', err.message);
    return await db.getUsersForBroadcast(target) || [];
  }
}

// ==================== RUTAS API ====================

app.get('/api/check-admin/:telegramId', (req, res) => {
  res.json({ isAdmin: isAdmin(req.params.telegramId), isSuperAdmin: isSuperAdmin(req.params.telegramId) });
});

// ── GESTIÓN DE ADMINS (solo super admin) ────────────────────────────

app.get('/api/admins', async (req, res) => {
  try {
    const { requesterId } = req.query;
    if (!isSuperAdmin(requesterId)) return res.status(403).json({ error: 'Solo el administrador principal puede ver esta lista.' });

    const sb = getSbClient();
    const { data, error } = await sb.from('bot_admins').select('*').order('added_at', { ascending: false });
    if (error) throw error;

    // Enriquecer con datos de usuario si existen
    const enriched = await Promise.all((data || []).map(async (a) => {
      const user = await db.getUser(String(a.telegram_id)).catch(() => null);
      return { ...a, first_name: user?.first_name || null, username: user?.username || null };
    }));

    res.json({ superAdminId: SUPER_ADMIN_ID, admins: enriched });
  } catch (error) {
    console.error('❌ Error listando admins:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admins/add', async (req, res) => {
  try {
    const { requesterId, telegramId } = req.body;
    if (!isSuperAdmin(requesterId)) return res.status(403).json({ error: 'Solo el administrador principal puede añadir admins.' });
    if (!telegramId || !/^\d+$/.test(String(telegramId).trim())) return res.status(400).json({ error: 'ID de Telegram inválido.' });

    const cleanId = String(telegramId).trim();
    if (cleanId === SUPER_ADMIN_ID) return res.status(400).json({ error: 'Ese usuario ya es el administrador principal.' });

    const sb = getSbClient();
    const { error } = await sb.from('bot_admins').upsert([{ telegram_id: cleanId, added_at: new Date().toISOString(), added_by: String(requesterId) }], { onConflict: 'telegram_id' });
    if (error) throw error;

    await loadAdminsFromDb();

    try {
      await bot.telegram.sendMessage(cleanId, '🔧 <b>Has sido añadido como administrador de VPN Cuba.</b>\n\nYa puedes usar el comando /admin para acceder al panel.', { parse_mode: 'HTML' });
    } catch (e) {}

    res.json({ success: true, admins: ADMIN_IDS });
  } catch (error) {
    console.error('❌ Error añadiendo admin:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admins/remove', async (req, res) => {
  try {
    const { requesterId, telegramId } = req.body;
    if (!isSuperAdmin(requesterId)) return res.status(403).json({ error: 'Solo el administrador principal puede quitar admins.' });
    const cleanId = String(telegramId).trim();
    if (cleanId === SUPER_ADMIN_ID) return res.status(400).json({ error: 'No puedes quitar al administrador principal.' });

    const sb = getSbClient();
    const { error } = await sb.from('bot_admins').delete().eq('telegram_id', cleanId);
    if (error) throw error;

    await loadAdminsFromDb();

    try {
      await bot.telegram.sendMessage(cleanId, 'ℹ️ Tus permisos de administrador en VPN Cuba han sido revocados.', { parse_mode: 'HTML' });
    } catch (e) {}

    res.json({ success: true, admins: ADMIN_IDS });
  } catch (error) {
    console.error('❌ Error quitando admin:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── ANUNCIO TIPO TICKER (lectura pública, edición solo super admin) ──

app.get('/api/announcement', async (req, res) => {
  try {
    const sb = getSbClient();
    const { data, error } = await sb.from('announcements').select('*').eq('id', 1).maybeSingle();
    if (error) throw error;

    if (!data || !data.active) return res.json({ active: false });

    const now = new Date();
    const startsAt = data.starts_at ? new Date(data.starts_at) : null;
    const endsAt = data.ends_at ? new Date(data.ends_at) : null;
    const isWithinWindow = (!startsAt || now >= startsAt) && (!endsAt || now <= endsAt);

    if (!isWithinWindow) return res.json({ active: false });

    res.json({ active: true, text: data.text, ends_at: data.ends_at });
  } catch (error) {
    console.error('❌ Error obteniendo anuncio:', error);
    res.json({ active: false });
  }
});

app.post('/api/announcement/update', async (req, res) => {
  try {
    const { requesterId, text, active, durationHours } = req.body;
    if (!isSuperAdmin(requesterId)) return res.status(403).json({ error: 'Solo el administrador principal puede editar el anuncio.' });
    if (active && (!text || !text.trim())) return res.status(400).json({ error: 'El texto del anuncio no puede estar vacío.' });

    const now = new Date();
    let endsAt = null;
    if (active && durationHours) {
      const hours = Number(durationHours);
      if (isNaN(hours) || hours <= 0) return res.status(400).json({ error: 'Duración inválida.' });
      endsAt = new Date(now.getTime() + hours * 3600000).toISOString();
    }

    const sb = getSbClient();
    const { error } = await sb.from('announcements').upsert([{
      id: 1,
      text: text || '',
      active: !!active,
      starts_at: now.toISOString(),
      ends_at: endsAt,
      updated_at: now.toISOString(),
      updated_by: String(requesterId)
    }], { onConflict: 'id' });
    if (error) throw error;

    res.json({ success: true, ends_at: endsAt });
  } catch (error) {
    console.error('❌ Error actualizando anuncio:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── PRECIOS DE PLANES (lectura pública, edición solo super admin) ──

app.get('/api/plan-prices', (req, res) => {
  res.json(PLAN_PRICES);
});

app.post('/api/plan-prices/update', async (req, res) => {
  try {
    const { requesterId, prices } = req.body;
    if (!isSuperAdmin(requesterId)) return res.status(403).json({ error: 'Solo el administrador principal puede modificar precios.' });
    if (!prices || typeof prices !== 'object') return res.status(400).json({ error: 'Formato de precios inválido.' });

    const validPlans = Object.keys(DEFAULT_PLAN_PRICES);
    const sb = getSbClient();
    const rows = [];

    for (const plan of validPlans) {
      if (!prices[plan]) continue;
      const p = prices[plan];
      const cup = Number(p.cup), mobile = Number(p.mobile), usdt = Number(p.usdt), stars = Number(p.stars), ton = Number(p.ton);
      if ([cup, mobile, usdt, stars, ton].some(v => isNaN(v) || v < 0)) {
        return res.status(400).json({ error: `Valores inválidos para el plan ${plan}.` });
      }
      rows.push({ plan, cup, mobile, usdt, stars, ton, updated_at: new Date().toISOString(), updated_by: String(requesterId) });
    }

    if (!rows.length) return res.status(400).json({ error: 'No se enviaron precios válidos.' });

    const { error } = await sb.from('plan_prices').upsert(rows, { onConflict: 'plan' });
    if (error) throw error;

    await loadPlanPricesFromDb();

    res.json({ success: true, prices: PLAN_PRICES });
  } catch (error) {
    console.error('❌ Error actualizando precios:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/accept-terms', async (req, res) => {
  try {
    const { telegramId, username, firstName, referrerId, referrerUsername } = req.body;
    const userData = { telegram_id: telegramId, username, first_name: firstName, accepted_terms: true, terms_date: new Date().toISOString(), is_active: true };
    if (referrerId) {
      userData.referrer_id = referrerId; userData.referrer_username = referrerUsername;
      try { await db.createReferral(referrerId, telegramId, username, firstName); } catch (refError) { console.log('⚠️ Error creando referido:', refError.message); }
    }
    const user = await db.saveUser(telegramId, userData);
    res.json({ success: true, user });
  } catch (error) { console.error('❌ Error aceptando términos:', error); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.get('/api/check-terms/:telegramId', async (req, res) => {
  try {
    const user = await db.getUser(req.params.telegramId);
    res.json({ accepted: user?.accepted_terms || false, user });
  } catch (error) { res.json({ accepted: false }); }
});

app.post('/api/payment', upload.single('screenshot'), async (req, res) => {
  try {
    const { telegramId, plan, price, notes, method, couponCode } = req.body;
    if (!telegramId || !plan || !price) return res.status(400).json({ error: 'Datos incompletos' });
    if (!req.file) return res.status(400).json({ error: 'Captura de pantalla requerida' });

    let screenshotUrl = '';
    try {
      screenshotUrl = await db.uploadImage(req.file.path, telegramId);
      fs.unlink(req.file.path, () => {});
    } catch (uploadError) { screenshotUrl = `/uploads/${req.file.filename}`; }

    const user = await db.getUser(telegramId);
    const username = user?.username ? `@${user.username}` : 'Sin usuario';
    const firstName = user?.first_name || 'Usuario';

    let couponUsed = false, couponDiscount = 0, finalPrice = parseFloat(price), appliedCoupon = null, referralDiscountApplied = 0;
    if (couponCode && couponCode.trim() !== '') {
      try {
        const coupon = await db.getCoupon(couponCode.toUpperCase());
        if (coupon && coupon.status === 'active' && !(coupon.expiry && new Date(coupon.expiry) < new Date()) && coupon.stock > 0 && !(await db.hasUserUsedCoupon(telegramId, couponCode.toUpperCase()))) {
          couponUsed = true; couponDiscount = coupon.discount; appliedCoupon = coupon;
          finalPrice = finalPrice * (1 - couponDiscount / 100);
        }
      } catch (couponError) { console.log('⚠️ Error verificando cupón:', couponError.message); }
    }
    if (!couponUsed) {
      try {
        const refStats = await db.getReferralStats(telegramId);
        if (refStats && refStats.discount_percentage > 0) {
          referralDiscountApplied = Math.min(refStats.discount_percentage, 100);
          finalPrice = finalPrice * (1 - referralDiscountApplied / 100);
        }
      } catch (refErr) {}
    }

    const payment = await db.createPayment({
      telegram_id: telegramId, plan, price: finalPrice, original_price: parseFloat(price),
      method: method || 'transfer', screenshot_url: screenshotUrl, notes: notes || '',
      status: 'pending', created_at: new Date().toISOString(),
      coupon_used: couponUsed, coupon_code: couponUsed ? couponCode?.toUpperCase() : null, coupon_discount: couponDiscount
    });
    if (!payment) throw new Error('No se pudo crear el pago en la base de datos');

    try {
      const methodNames = { transfer: 'BPA', metropolitan: 'Metropolitana', mitransfer: 'MITRANSFER', mobile: 'Saldo Móvil', usdt: 'USDT (BEP20)' };
      let adminMessage = `💰 *NUEVO PAGO - ${method === 'usdt' ? 'USDT' : 'CUP'}*\n\n👤 *Usuario:* ${firstName}\n📱 *Telegram:* ${username}\n🆔 *ID:* ${telegramId}\n📋 *Plan:* ${getPlanName(plan)}\n💰 *Monto:* ${price} ${method === 'usdt' ? 'USDT' : 'CUP'}\n`;
      if (couponUsed) adminMessage += `🎫 *Cupón:* ${couponCode} (${couponDiscount}%)\n💰 *Final:* ${finalPrice.toFixed(2)}\n`;
      else if (referralDiscountApplied > 0) adminMessage += `👥 *Descuento:* ${referralDiscountApplied}%\n💰 *Final:* ${finalPrice.toFixed(2)}\n`;
      adminMessage += `💳 *Método:* ${methodNames[method] || method}\n⏰ *Fecha:* ${new Date().toLocaleString('es-ES')}\n📝 *Estado:* ⏳ Pendiente`;
      for (const adminId of ADMIN_IDS) {
        try { await bot.telegram.sendMessage(adminId, adminMessage, { parse_mode: 'Markdown' }); } catch (e) {}
      }

      try {
        const userMessage = `✅ <b>Captura recibida</b>

Ya registramos tu comprobante para <b>${getPlanName(plan)}</b>.
No hace falta enviar otra foto. Tu pago quedó en revisión manual.

<b>Estado:</b> ⏳ Revisión manual de 1-12 horas`;
        await bot.telegram.sendMessage(telegramId, userMessage, { parse_mode: 'HTML' });
      } catch (e) {}
    } catch (e) {}

    res.json({ success: true, message: 'Captura recibida. No hace falta enviar otra foto.', payment, couponApplied: couponUsed, discount: couponDiscount, finalPrice });
  } catch (error) {
    console.error('❌ Error procesando pago:', error);
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Error procesando pago: ' + error.message });
  }
});

app.get('/api/payments/pending', async (req, res) => {
  try {
    const payments = await db.getPendingPayments();
    if (!payments || payments.length === 0) return res.json([]);
    const uniqueIds = [...new Set(payments.map(p => p.telegram_id).filter(Boolean))];
    const userResults = await Promise.allSettled(uniqueIds.map(id => db.getUser(id)));
    const userMap = {};
    uniqueIds.forEach((id, i) => { if (userResults[i].status === 'fulfilled') userMap[id] = userResults[i].value; });
    res.json(payments.map(p => ({ ...p, user: userMap[p.telegram_id] || null })));
  } catch (error) { res.status(500).json({ error: 'Error obteniendo pagos pendientes' }); }
});

app.get('/api/payments/approved', async (req, res) => {
  try {
    const payments = await db.getApprovedPayments();
    if (!payments || payments.length === 0) return res.json([]);
    const uniqueIds = [...new Set(payments.map(p => p.telegram_id).filter(Boolean))];
    const userResults = await Promise.allSettled(uniqueIds.map(id => db.getUser(id)));
    const userMap = {};
    uniqueIds.forEach((id, i) => { if (userResults[i].status === 'fulfilled') userMap[id] = userResults[i].value; });
    res.json(payments.map(p => ({ ...p, user: userMap[p.telegram_id] || null })));
  } catch (error) { res.status(500).json({ error: 'Error obteniendo pagos aprobados' }); }
});

app.post('/api/payments/:id/approve', async (req, res) => {
  try {
    const payment = await db.approvePayment(req.params.id);
    if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });
    if (!payment.telegram_id) return res.status(400).json({ error: 'El pago no tiene un usuario asociado' });

    if (payment.coupon_used && payment.coupon_code) {
      try {
        const coupon = await db.getCoupon(payment.coupon_code);
        if (coupon && coupon.stock > 0) {
          const applied = await db.applyCouponToPayment(payment.coupon_code, payment.telegram_id, payment.id);
          if (applied) await db.updateCoupon(payment.coupon_code, { stock: coupon.stock - 1, used: (coupon.used || 0) + 1, updated_at: new Date().toISOString(), updated_by: payment.config_sent_by || 'system' });
        }
      } catch (couponError) { console.error('❌ Error aplicando cupón:', couponError.message); }
    }

    try {
      let userMessage = '<tg-emoji emoji-id="6019175208240289774">🎉</tg-emoji> <b>¡Tu pago ha sido aprobado!</b>\n\nAhora eres usuario VIP de VPN Cuba.\nEl administrador te enviará el archivo de configuración en breve.\n\n';
      if (payment.coupon_used && payment.coupon_discount) userMessage += `<tg-emoji emoji-id="6021793768196282527">🎫</tg-emoji> <b>Cupón:</b> ${payment.coupon_code} (${payment.coupon_discount}% descuento)\n`;
      userMessage += '<b>Nota:</b> Sistema de envío automático desactivado.';
      await bot.telegram.sendMessage(payment.telegram_id, userMessage, { parse_mode: 'HTML' });
    } catch (botError) { console.log('❌ No se pudo notificar al usuario:', botError.message); }

    const user = await db.getUser(payment.telegram_id);
    if (!user.vip) await db.makeUserVIP(payment.telegram_id, { plan: payment.plan, plan_price: payment.price, vip_since: new Date().toISOString() });

    if (user.referrer_id) {
      try {
        await db.markReferralAsPaid(payment.telegram_id);
        const referrerUser = await db.getUser(user.referrer_id);
        if (referrerUser?.referrer_id) await db.markReferralAsPaid(user.referrer_id, 2);
      } catch (refError) { console.error('❌ Error marcando referido:', refError.message); }
    }

    res.json({ success: true, payment });
  } catch (error) { console.error('❌ Error aprobando pago:', error); res.status(500).json({ error: 'Error aprobando pago' }); }
});

app.post('/api/payments/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Se requiere un motivo de rechazo' });
    const payment = await db.rejectPayment(req.params.id, reason);
    if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });
    try { await bot.telegram.sendMessage(payment.telegram_id, `❌ *Tu pago ha sido rechazado*\n\nMotivo: ${reason}\n\nContacta con soporte si necesitas más información.`, { parse_mode: 'Markdown' }); } catch (e) {}
    res.json({ success: true, payment });
  } catch (error) { res.status(500).json({ error: 'Error rechazando pago' }); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const stats = await db.getStats();
    try { const broadcasts = await db.getBroadcasts(); stats.broadcasts = { total: broadcasts.length, completed: broadcasts.filter(b => b.status === 'completed').length, pending: broadcasts.filter(b => b.status === 'pending').length, sending: broadcasts.filter(b => b.status === 'sending').length, failed: broadcasts.filter(b => b.status === 'failed').length }; } catch(e) { stats.broadcasts = stats.broadcasts || { total: 0, completed: 0 }; }
    stats.usdt = { wallet_address: USDT_CONFIG.WALLET_ADDRESS, verification_enabled: false, mode: 'manual' };
    if (!stats.referrals) { try { const refStats = await db.getAllReferralsStats(); stats.referrals = { total: refStats.total_referrals || 0, paid: refStats.paid_referrals || 0, level1: refStats.level1_referrals || 0, level2: refStats.level2_referrals || 0 }; } catch(e) { stats.referrals = { total: 0, paid: 0, level1: 0, level2: 0 }; } }
    if (!stats.coupons) { try { stats.coupons = await db.getCouponsStats(); } catch(e) { stats.coupons = { total:0, active:0, expired:0, used:0 }; } }
    res.json(stats);
  } catch (error) { res.status(500).json({ error: 'Error obteniendo estadísticas', users:{total:0,vip:0,trial_requests:0,trial_pending:0,active:0,inactive:0}, payments:{pending:0,approved:0}, revenue:{total:0}, broadcasts:{total:0,completed:0}, coupons:{total:0,active:0,expired:0,used:0}, referrals:{total:0,paid:0,level1:0,level2:0} }); }
});

app.get('/api/vip-users', async (req, res) => {
  try { res.json(await db.getVIPUsers()); } catch (error) { res.status(500).json({ error: 'Error obteniendo usuarios VIP' }); }
});

app.get('/api/all-users', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;
    const users = await db.getAllUsers(limit, offset);
    const total = await db.getTotalUsersCount();
    res.json({ users, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) { res.status(500).json({ error: 'Error obteniendo usuarios: ' + error.message }); }
});

app.get('/api/payments/:id', async (req, res) => {
  try {
    const payment = await db.getPayment(req.params.id);
    if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });
    const user = await db.getUser(payment.telegram_id);
    res.json({ ...payment, user: user || null });
  } catch (error) { res.status(500).json({ error: 'Error obteniendo pago' }); }
});

app.post('/api/send-config', upload.single('configFile'), async (req, res) => {
  try {
    const { paymentId, adminId } = req.body;
    if (!isAdmin(adminId)) return res.status(403).json({ error: 'No autorizado' });
    if (!paymentId) return res.status(400).json({ error: 'ID de pago requerido' });
    if (!req.file) return res.status(400).json({ error: 'Archivo de configuración requerido' });

    const fileName = req.file.originalname.toLowerCase();
    if (!fileName.endsWith('.zip') && !fileName.endsWith('.rar') && !fileName.endsWith('.conf')) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'El archivo debe tener extensión .conf, .zip o .rar' });
    }

    const payment = await db.getPayment(paymentId);
    if (!payment) { fs.unlink(req.file.path, () => {}); return res.status(404).json({ error: 'Pago no encontrado' }); }
    if (payment.status !== 'approved') { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'El pago no está aprobado' }); }
    if (!payment.telegram_id || payment.telegram_id === 'undefined' || payment.telegram_id === 'null') { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'El pago no tiene un usuario asociado (telegram_id)' }); }

    const chatId = payment.telegram_id.toString().trim();
    const user = await db.getUser(chatId);
    if (!user) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: `El usuario ${chatId} no está registrado` }); }

    const MAX_RETRIES = 3;
    let lastTelegramError = null, sent = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await bot.telegram.sendDocument(chatId, { source: req.file.path, filename: req.file.originalname }, {
  caption: `<tg-emoji emoji-id="5875465628285931233">🎉</tg-emoji> <b>¡Tu configuración VPN Cuba está lista!</b>\n\n` +
           `<tg-emoji emoji-id="6021375494216226506">📁</tg-emoji> <b>Archivo:</b> ${req.file.originalname}\n` +
           `<tg-emoji emoji-id="6021744990252702234">📋</tg-emoji> <b>Plan:</b> ${getPlanName(payment.plan)}\n` +
           `${payment.coupon_used ? `<tg-emoji emoji-id="6021793768196282527">🎫</tg-emoji> <b>Cupón:</b> ${payment.coupon_code} (${payment.coupon_discount}%)\n` : ''}` +
           `\n<b>Instrucciones:</b>\n1. Descarga este archivo\n2. ${fileName.endsWith('.conf') ? 'Importa el archivo .conf directamente en WireGuard' : 'Descomprime y luego importa el archivo .conf en WireGuard'}\n3. Activa la conexión\n4. ¡Disfruta! <tg-emoji emoji-id="4978747001718966118">🚀</tg-emoji>`,
  parse_mode: 'HTML'
});
        sent = true; break;
      } catch (retryErr) {
        lastTelegramError = retryErr;
        const errMsg = retryErr.description || retryErr.message || '';
        console.warn(`⚠️ Intento ${attempt}/${MAX_RETRIES} fallido: ${errMsg}`);
        if (errMsg.includes('chat not found') || errMsg.includes('bot was blocked') || errMsg.includes('user is deactivated') || errMsg.includes('kicked') || retryErr.response?.error_code === 403 || retryErr.response?.error_code === 400) break;
        if (attempt < MAX_RETRIES) await new Promise(resolve => setTimeout(resolve, attempt * 1500));
      }
    }

    if (!sent) { fs.unlink(req.file.path, () => {}); throw lastTelegramError || new Error('No se pudo enviar el archivo'); }

    await db.updatePayment(paymentId, { config_sent: true, config_sent_at: new Date().toISOString(), config_file: req.file.originalname, config_sent_by: adminId });
    if (user && !user.vip) await db.makeUserVIP(chatId, { plan: payment.plan, plan_price: payment.price, vip_since: new Date().toISOString() });
    fs.unlink(req.file.path, () => {});
    res.json({ success: true, message: 'Configuración enviada manualmente', filename: req.file.filename, telegramId: chatId });
  } catch (error) {
    console.error('❌ Error en send-config:', error);
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Error interno del servidor: ' + error.message });
  }
});

app.use('/uploads', express.static(UPLOADS_DIR));

app.get('/api/user-info/:telegramId', async (req, res) => {
  try {
    const user = await db.getUser(req.params.telegramId);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    const admin = isAdmin(req.params.telegramId);
    let referralStats = null;
    try { referralStats = await db.getReferralStats(req.params.telegramId); } catch (e) {}
    const discountPct = referralStats ? Math.min(referralStats.discount_percentage || 0, 100) : 0;
    res.json({ ...user, isAdmin: admin, referral_stats: referralStats, referral_discount: discountPct });
  } catch (error) { res.status(500).json({ error: 'Error obteniendo información del usuario' }); }
});

app.post('/api/send-message', async (req, res) => {
  try {
    const { telegramId, message, adminId } = req.body;
    if (!isAdmin(adminId)) return res.status(403).json({ error: 'No autorizado' });
    if (!telegramId || telegramId === 'undefined' || telegramId === 'null') return res.status(400).json({ error: 'ID de usuario inválido' });
    const chatId = telegramId.toString().trim();
    const canSend = await canSendMessageToUser(chatId);
    if (!canSend.canSend) return res.status(400).json({ error: `No se puede enviar mensaje: ${canSend.reason}` });
    await bot.telegram.sendMessage(chatId, `📨 *Mensaje del Administrador:*\n\n${message}`, { parse_mode: 'Markdown' });
    res.json({ success: true, message: 'Mensaje enviado' });
  } catch (error) { res.status(500).json({ error: 'Error enviando mensaje: ' + error.message }); }
});

app.post('/api/user/:userId/remove-vip', async (req, res) => {
  try {
    const { adminId } = req.body;
    if (!isAdmin(adminId)) return res.status(403).json({ error: 'No autorizado' });
    const user = await db.removeVIP(req.params.userId);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    try {
      const canSend = await canSendMessageToUser(req.params.userId);
      if (canSend.canSend) await bot.telegram.sendMessage(req.params.userId, '⚠️ *Tu acceso VIP ha sido removido*\n\nTu suscripción VIP ha sido cancelada.\nContacta con soporte si crees que es un error.', { parse_mode: 'Markdown' });
    } catch (e) {}
    res.json({ success: true, message: 'VIP removido', user });
  } catch (error) { res.status(500).json({ error: 'Error removiendo VIP' }); }
});

app.get('/api/check-trial-eligibility/:telegramId', async (req, res) => {
  try { res.json(await db.checkTrialEligibility(req.params.telegramId)); } catch (error) { res.json({ eligible: true, reason: 'Error verificando' }); }
});

// ==================== SOLICITUD DE PRUEBA ====================

    // ==================== SOLICITUD DE PRUEBA ====================
app.post('/api/request-trial', async (req, res) => {
  const { telegramId, username, firstName, trialType = '1h', gameServer, connectionType, trialPlanType } = req.body;

  // Verificar lock para evitar solicitudes duplicadas en menos de 15 segundos
  const now = Date.now();
  const lastRequest = pendingTrialLocks.get(telegramId);
  if (lastRequest && (now - lastRequest) < 15000) {
    return res.status(429).json({ error: 'Ya hay una solicitud de prueba en proceso. Espera 15 segundos.' });
  }
  pendingTrialLocks.set(telegramId, now);

  try {
    // 1. Verificar elegibilidad
    const eligibility = await db.checkTrialEligibility(telegramId);
    if (!eligibility.eligible) {
      pendingTrialLocks.delete(telegramId);
      return res.status(400).json({ error: `No puedes solicitar una prueba: ${eligibility.reason}` });
    }

    const selectedPlan = getPlanLabel(trialPlanType) || 'No especificado';

    // 2. Guardar la solicitud en BD
    const updatedUser = await db.saveUser(telegramId, {
      telegram_id: telegramId,
      username,
      first_name: firstName,
      trial_requested: true,
      trial_requested_at: new Date().toISOString(),
      trial_plan_type: trialPlanType || 'basico',
      trial_game_server: gameServer || '',
      trial_connection_type: connectionType || '',
      is_active: true
    });

    // 3. Notificar a los administradores
    const adminMessage = `🎯 *NUEVA SOLICITUD DE PRUEBA*\n\n👤 *Usuario:* ${firstName}\n📱 *Telegram:* ${username ? `@${username}` : 'Sin usuario'}\n🆔 *ID:* ${telegramId}\n🎮 *Juego/Servidor:* ${gameServer || 'No especificado'}\n📡 *Conexión:* ${connectionType || 'No especificado'}\n📋 *Plan a probar:* ${selectedPlan}\n📅 *Fecha:* ${new Date().toLocaleString('es-ES')}`;
    for (const adminId of ADMIN_IDS) {
      try { await bot.telegram.sendMessage(adminId, adminMessage, { parse_mode: 'Markdown' }); } catch (e) {}
    }

    // 4. Intentar enviar la configuración automáticamente
    let autoSent = false;
    let sendError = null;
    try {
      const canSend = await canSendMessageToUser(telegramId);
      if (canSend.canSend) {
        await sendTrialConfigToUser(telegramId, 'system');
        autoSent = true;
      } else {
        sendError = new Error(`Usuario no disponible: ${canSend.reason}`);
      }
    } catch (err) {
      sendError = err;
      console.error(`❌ Error en envío automático a ${telegramId}:`, err.message);
    }

    // 5. Responder al usuario según resultado
    if (autoSent) {
      await bot.telegram.sendMessage(telegramId,
        `<tg-emoji emoji-id="5875465628285931233">🎉</tg-emoji> <b>¡Tu prueba gratuita ya está aquí!</b>\n\nAcabo de enviarte el archivo de configuración para el plan <b>${selectedPlan}</b>.\nRevísalo en este mismo chat y actívalo en WireGuard.\n\n<tg-emoji emoji-id="5778202206922608769">⏰</tg-emoji> <b>Plan probado:</b> ${selectedPlan}\n¡Disfruta de baja latencia! <tg-emoji emoji-id="4978747001718966118">🚀</tg-emoji>`,
        { parse_mode: 'HTML' }
      );
      res.json({ success: true, message: 'Prueba gratuita enviada automáticamente.', trialPlanType, user: updatedUser, autoSent: true });
    } else {
      await bot.telegram.sendMessage(telegramId,
        `<tg-emoji emoji-id="6019175208240289774">✅</tg-emoji> <b>Solicitud de prueba recibida</b>\n\nTu solicitud para el plan <b>${selectedPlan}</b> ha sido registrada. Un administrador te enviará la configuración en breve.\n\n¡Gracias por probar VPN Cuba!`,
        { parse_mode: 'HTML' }
      );
      res.json({ success: true, message: 'Solicitud registrada. Recibirás la configuración en breve.', trialPlanType, user: updatedUser, autoSent: false, error: sendError?.message });
    }
  } catch (error) {
    console.error('❌ Error en solicitud de prueba:', error);
    res.status(500).json({ error: 'Error procesando solicitud: ' + error.message });
  } finally {
    // Eliminar el lock siempre, incluso si hay error
    pendingTrialLocks.delete(telegramId);
  }
});

app.get('/api/trial-stats', async (req, res) => {
  try { res.json(await db.getTrialStats()); } catch (error) { res.status(500).json({ error: 'Error obteniendo estadísticas de prueba' }); }
});

app.get('/api/trials/pending', async (req, res) => {
  try {
    const trials = await db.getPendingTrials();
    const trialsWithUsers = trials.map(t => ({
      ...t,
      trial_info: { requested_at: t.trial_requested_at, plan_type: t.trial_plan_type || 'basico', game_server: t.trial_game_server || '', connection_type: t.trial_connection_type || '', days_ago: t.trial_requested_at ? Math.floor((new Date() - new Date(t.trial_requested_at)) / (1000 * 60 * 60 * 24)) : 0 }
    }));
    res.json(trialsWithUsers);
  } catch (error) { res.status(500).json({ error: 'Error obteniendo pruebas pendientes' }); }
});

app.post('/api/trials/:telegramId/mark-sent', async (req, res) => {
  try {
    const { adminId } = req.body;
    if (!isAdmin(adminId)) return res.status(403).json({ error: 'No autorizado' });
    const user = await db.markTrialAsSent(req.params.telegramId, adminId);
    try {
      const canSend = await canSendMessageToUser(req.params.telegramId);
      if (canSend.canSend) await bot.telegram.sendMessage(req.params.telegramId, '<tg-emoji emoji-id="5875465628285931233">🎉</tg-emoji> <b>¡Tu prueba gratuita está lista!</b>\n\nHas recibido la configuración de prueba.\n¡Disfruta! <tg-emoji emoji-id="4978747001718966118">🚀</tg-emoji>', { parse_mode: 'HTML' });
    } catch (e) {}
    res.json({ success: true, message: 'Prueba marcada como enviada', user });
  } catch (error) { res.status(500).json({ error: 'Error marcando prueba como enviada' }); }
});

app.post('/api/trials/:telegramId/cancel', async (req, res) => {
  try {
    const { adminId } = req.body;
    if (!isAdmin(adminId)) return res.status(403).json({ error: 'No autorizado' });
    const user = await db.getUser(req.params.telegramId);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    const updated = await db.updateUser(req.params.telegramId, { trial_requested: false, trial_requested_at: null, trial_game_server: null, trial_connection_type: null, trial_plan_type: null });
    res.json({ success: true, message: 'Solicitud de prueba eliminada', user: updated });
  } catch (error) { res.status(500).json({ error: 'Error cancelando solicitud: ' + error.message }); }
});

app.post('/api/send-trial-config', async (req, res) => {
  try {
    const { telegramId, adminId } = req.body;
    if (!isAdmin(adminId)) return res.status(403).json({ error: 'No autorizado' });
    if (!telegramId || telegramId === 'undefined') return res.status(400).json({ error: 'ID de usuario inválido' });
    const chatId = telegramId.toString().trim();
    const user = await db.getUser(chatId);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!user.trial_requested) return res.status(400).json({ error: 'El usuario no solicitó prueba' });
    if (user.trial_received) return res.status(400).json({ error: 'El usuario ya recibió la prueba' });
    const canSend = await canSendMessageToUser(chatId);
    if (!canSend.canSend) { await db.updateUser(chatId, { is_active: false, last_error: canSend.reason }); return res.status(400).json({ error: `El usuario no puede recibir mensajes: ${canSend.reason}` }); }
    await sendTrialConfigToUser(chatId, adminId);
    res.json({ success: true, message: 'Configuración de prueba enviada', trialPlanType: user.trial_plan_type || 'basico', gameServer: user.trial_game_server || 'No especificado', connectionType: user.trial_connection_type || 'No especificado' });
  } catch (error) { res.status(500).json({ error: 'Error interno: ' + error.message }); }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString(), admins: ADMIN_IDS, port: PORT, bot_token: process.env.BOT_TOKEN ? '✅' : '❌', usdt_system: { enabled: true, mode: 'MANUAL', wallet_address: USDT_CONFIG.WALLET_ADDRESS } });
});

app.get('/api/image/:filename', (req, res) => {
  const filePath = path.join(UPLOADS_DIR, req.params.filename);
  if (fs.existsSync(filePath)) res.sendFile(filePath);
  else res.status(404).json({ error: 'Imagen no encontrada' });
});

app.get('/api/storage-status', async (req, res) => {
  try {
    const buckets = [];
    for (const name of ['payments-screenshots', 'plan-files', 'trial-files-basico', 'trial-files-avanzado', 'trial-files-premium', 'trial-files-anual']) {
      try { const { data } = await supabaseAdmin.storage.from(name).list(); buckets.push({ name, status: '✅ Existe', fileCount: data?.length || 0 }); }
      catch (e) { buckets.push({ name, status: '❌ Error: ' + e.message }); }
    }
    res.json({ success: true, buckets, service_key_configured: !!process.env.SUPABASE_SERVICE_ROLE_KEY });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/broadcast/send', upload.single('mediaFile'), async (req, res) => {
  try {
    let { message, target, adminId } = req.body;
    
    // Convertir adminId a string si viene como número o undefined
    if (!adminId) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'ID de administrador no proporcionado' });
    }
    adminId = String(adminId);
    
    if (!isAdmin(adminId)) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'No autorizado' });
    }
    if ((!message || typeof message !== 'string' || !message.trim()) && !req.file) {
      return res.status(400).json({ error: 'El mensaje no puede estar vacío' });
    }
    message = message || '';
    
    const validTargets = ['all', 'vip', 'non_vip', 'trial_pending', 'trial_received', 'active', 'with_referrals', 'usdt_payers'];
    if (!validTargets.includes(target)) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Target de broadcast inválido' });
    }

    // Subir media (si la hay) y determinar su tipo para Telegram
    let mediaUrl = null, mediaType = null;
    if (req.file) {
      mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'photo';
      try {
        mediaUrl = await db.uploadImage(req.file.path, `broadcast_${Date.now()}`, req.file.originalname);
        fs.unlink(req.file.path, () => {});
      } catch (e) {
        mediaUrl = `/uploads/${req.file.filename}`;
      }
    }
    
    const broadcast = await db.createBroadcast(message, target, adminId);
    if (!broadcast?.id) throw new Error('No se pudo crear el broadcast');
    
    const users = await getAllUsersForBroadcast(target);
    await db.updateBroadcastStatus(broadcast.id, 'pending', { total_users: users.length, media_url: mediaUrl || null, media_type: mediaType || null });
    setImmediate(() => { sendBroadcastToUsers(broadcast.id, message, users, adminId, mediaUrl, mediaType); });
    
    res.json({ 
      success: true, 
      message: 'Broadcast creado', 
      broadcast: { id: broadcast.id, target, total_users: users.length, status: 'pending' }, 
      totalUsers: users.length 
    });
  } catch (error) {
    console.error('❌ Error en broadcast:', error);
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: error.message });
  }
});

async function sendBroadcastToUsers(broadcastId, message, users, adminId, mediaUrl, mediaType) {
  try {
    if (!users?.length) { await db.updateBroadcastStatus(broadcastId, 'completed', { sent_count: 0, failed_count: 0, unavailable_count: 0, total_users: 0 }); return; }
    await db.updateBroadcastStatus(broadcastId, 'sending', { total_users: users.length, sent_count: 0 });
    let sentCount = 0, failedCount = 0, unavailableCount = 0;
    const caption = message ? `📢 *MENSAJE IMPORTANTE - VPN CUBA*\n\n${message}\n\n_Soporte: @vpncubawire | @ErenJeager129182 | @JosherSnchz_` : null;
    const textOnly = `📢 *MENSAJE IMPORTANTE - VPN CUBA*\n\n${message}\n\n_Soporte: @vpncubawire | @ErenJeager129182 | @JosherSnchz_`;
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      try {
        if (!user.telegram_id) { failedCount++; continue; }
        if (mediaUrl) {
          const sendFn = mediaType === 'video' ? bot.telegram.sendVideo : bot.telegram.sendPhoto;
          await sendFn.call(bot.telegram, user.telegram_id, mediaUrl, caption ? { caption, parse_mode: 'Markdown' } : {});
        } else {
          await bot.telegram.sendMessage(user.telegram_id, textOnly, { parse_mode: 'Markdown' });
        }
        sentCount++;
      } catch (error) {
        failedCount++;
        const errMsg = error.description || error.message || '';
        if (errMsg.includes('blocked') || errMsg.includes('chat not found') || errMsg.includes('kicked') || errMsg.includes('user is deactivated') || error.response?.error_code === 403) {
          unavailableCount++;
          try { await db.updateUser(user.telegram_id, { is_active: false, last_error: errMsg, updated_at: new Date().toISOString() }); } catch (e) {}
        }
      }
      if ((i + 1) % 25 === 0 || i === users.length - 1) {
        try { await db.updateBroadcastStatus(broadcastId, 'sending', { sent_count: sentCount, failed_count: failedCount, unavailable_count: unavailableCount, total_users: users.length }); } catch (e) {}
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await db.updateBroadcastStatus(broadcastId, 'completed', { sent_count: sentCount, failed_count: failedCount, unavailable_count: unavailableCount, total_users: users.length });
  } catch (error) {
    console.error(`❌ Error crítico en broadcast ${broadcastId}:`, error);
    try { await db.updateBroadcastStatus(broadcastId, 'failed', { sent_count: 0, failed_count: users?.length || 0, unavailable_count: 0, total_users: users?.length || 0 }); } catch (e) {}
  }
}

app.get('/api/broadcasts', async (req, res) => { try { res.json(await db.getBroadcasts()); } catch (e) { res.status(500).json({ error: 'Error obteniendo broadcasts' }); } });
app.get('/api/broadcast/status/:id', async (req, res) => { try { const b = await db.getBroadcast(req.params.id); if (!b) return res.status(404).json({ error: 'No encontrado' }); res.json(b); } catch (e) { res.status(500).json({ error: 'Error' }); } });
app.get('/api/broadcast/:id', async (req, res) => { try { const b = await db.getBroadcast(req.params.id); if (!b) return res.status(404).json({ error: 'No encontrado' }); res.json(b); } catch (e) { res.status(500).json({ error: 'Error' }); } });

app.post('/api/broadcast/retry/:id', async (req, res) => {
  try {
    const { adminId } = req.body;
    if (!isAdmin(adminId)) return res.status(403).json({ error: 'No autorizado' });
    const broadcast = await db.retryFailedBroadcast(req.params.id);
    if (!broadcast) return res.status(404).json({ error: 'No encontrado' });
    const users = await getAllUsersForBroadcast(broadcast.target_users);
    setTimeout(() => { sendBroadcastToUsers(broadcast.id, broadcast.message, users, adminId); }, 100);
    res.json({ success: true, message: 'Reintentando broadcast', broadcast });
  } catch (error) { res.status(500).json({ error: 'Error reintentando: ' + error.message }); }
});

app.get('/api/users/active', async (req, res) => { try { res.json(await db.getActiveUsers(30)); } catch (e) { res.status(500).json({ error: 'Error' }); } });

app.get('/api/referrals/stats', async (req, res) => { try { res.json(await db.getAllReferralsStats()); } catch (e) { res.status(500).json({ error: 'Error' }); } });
app.get('/api/referrals/top', async (req, res) => {
  try {
    const stats = await db.getAllReferralsStats();
    const top = await Promise.all((stats.top_referrers || []).map(async r => { const u = await db.getUser(r.referrer_id); return { ...r, first_name: u?.first_name || 'Usuario', username: u?.username || 'sin_usuario' }; }));
    res.json(top);
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});
app.get('/api/referrals/list', async (req, res) => {
  try {
    const stats = await db.getAllReferralsStats();
    const referrals = await Promise.all((stats.recent_referrals || []).map(async r => { const u = await db.getUser(r.referred_id); const ref = await db.getUser(r.referrer_id); return { ...r, user_name: u?.first_name || 'Usuario', user_id: u?.telegram_id, referrer_name: ref?.first_name || 'Usuario', referrer_id: ref?.telegram_id }; }));
    res.json(referrals);
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});
app.get('/api/referrals/user/:telegramId', async (req, res) => { try { res.json(await db.getReferralStats(req.params.telegramId)); } catch (e) { res.status(500).json({ error: 'Error' }); } });
app.get('/api/users/with-referrals', async (req, res) => {
  try {
    const stats = await db.getAllReferralsStats();
    const users = await Promise.all((stats.top_referrers || []).map(async u => { const info = await db.getUser(u.referrer_id); return { ...u, first_name: info?.first_name || 'Usuario', username: info?.username || 'sin_usuario', telegram_id: u.referrer_id }; }));
    res.json(users);
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});
app.get('/api/users/without-referrals', async (req, res) => {
  try {
    const stats = await db.getAllReferralsStats();
    const allUsers = await db.getAllUsers(10000, 0);
    const usersWithReferrals = new Set(stats.top_referrers?.map(u => u.referrer_id) || []);
    res.json(allUsers.filter(u => !usersWithReferrals.has(u.telegram_id.toString())).slice(0, 200));
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/usdt/wallet-status', async (req, res) => {
  res.json({ success: true, wallet_address: USDT_CONFIG.WALLET_ADDRESS, network: 'BEP20', usdt_contract: USDT_CONFIG.USDT_CONTRACT_ADDRESS, mode: 'MANUAL', message: 'Todos los pagos USDT requieren captura y aprobación manual' });
});
app.get('/api/usdt/verify-transaction/:hash', (req, res) => { res.json({ success: true, status: 'manual_review_required', mode: 'manual' }); });
app.post('/api/usdt/force-check', (req, res) => { if (!isAdmin(req.body.adminId)) return res.status(403).json({ error: 'No autorizado' }); res.json({ success: true, message: 'Verificación automática desactivada.', result: { transactions: 0, mode: 'manual' } }); });
app.get('/api/usdt/unassigned-transactions', (req, res) => { res.json([]); });


//====================PAGO CON STARS ================{
// Endpoint para generar link de pago con Telegram Stars
app.post('/api/create-stars-invoice', async (req, res) => {
    try {
        const { userId, planType } = req.body;
        if (!userId || !planType) {
            return res.status(400).json({ success: false, error: 'Faltan parámetros indispensables.' });
        }

        const starsAmount = STARS_PRICES[planType];
        if (!starsAmount) {
            return res.status(400).json({ success: false, error: 'Plan no soportado en este método.' });
        }

        const title = `Plan ${getPlanName(planType)}`;
        const description = `Acceso VIP a VPN CUBA - Modalidad ${getPlanName(planType)}`;
        const payload = JSON.stringify({ userId: userId.toString(), planType, method: 'stars' });
        const currency = 'XTR'; // Código oficial para Telegram Stars

        // Generar el enlace de la factura mediante la API nativa de Telegraf
        const invoiceLink = await bot.telegram.createInvoiceLink({
            title,
            description,
            payload,
            provider_token: '', // Debe ir vacío para Telegram Stars
            currency,
            prices: [{ label: title, amount: starsAmount }]
        });

        res.json({ success: true, invoiceLink });
    } catch (error) {
        console.error('❌ Error creando factura Stars:', error);
        res.status(500).json({ success: false, error: error.message });
    }
}); 

app.post('/api/initiate-stars-payment', async (req, res) => {
  try {
    const { telegramId, plan } = req.body;
    if (!telegramId || !plan) return res.status(400).json({ success: false, error: 'Faltan parámetros.' });
    const starsAmount = STARS_PRICES[plan];
    if (!starsAmount) return res.status(400).json({ success: false, error: 'Plan no soportado.' });
    const title = `Plan ${getPlanName(plan)}`;
    const payload = JSON.stringify({ userId: telegramId.toString(), planType: plan, method: 'stars' });
    await bot.telegram.sendInvoice(telegramId, {
      title, description: `Acceso VIP a VPN CUBA - ${title}`,
      payload, provider_token: '', currency: 'XTR',
      prices: [{ label: title, amount: starsAmount }]
    });
    res.json({ success: true, message: 'Factura enviada por Telegram' });
  } catch (error) {
    console.error('❌ Error en initiate-stars-payment:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ==================== PAGO CON TON ====================

const TON_CONFIG = {
  WALLET_ADDRESS: 'UQAY_qlJ1uxM-UP2zWjLn4jbFf6nQWL4N3JDWfNIyTPy5rZO',
  MANIFEST_URL:   'https://vpn-bryan.onrender.com/tonconnect-manifest.json',
  TONCENTER_API:  'https://toncenter.com/api/v2',
};

const TON_PLAN_LABELS = {
  basico:   'Plan Básico (1 mes)',
  avanzado: 'Plan Avanzado (2 meses)',
  cuba_vip: 'Plan VIP Cuba (1 mes)',
  premium:  'Plan Gaming (1 mes)',
  anual:    'Plan Anual (12 meses)'
};

app.post('/api/initiate-ton-payment', async (req, res) => {
  try {
    const { telegramId, plan } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'ID de usuario requerido' });
    const amount = TON_PRICES[plan];
    if (!amount) return res.status(400).json({ error: 'Plan inválido' });
    const comment = `VPNCUBA-${plan.toUpperCase()}-${telegramId}-${Date.now()}`;
    res.json({ success: true, walletAddress: TON_CONFIG.WALLET_ADDRESS, amount, comment, plan, label: TON_PLAN_LABELS[plan], manifestUrl: TON_CONFIG.MANIFEST_URL });
  } catch (error) {
    console.error('Error iniciando pago TON:', error);
    res.status(500).json({ error: 'Error iniciando pago TON: ' + error.message });
  }
});

app.post('/api/verify-ton-payment', async (req, res) => {
  try {
    const { telegramId, plan, comment } = req.body;
    if (!telegramId || !plan || !comment) return res.status(400).json({ error: 'Parámetros incompletos' });
    const amount = TON_PRICES[plan];
    if (!amount) return res.status(400).json({ error: 'Plan inválido' });

    const url = `${TON_CONFIG.TONCENTER_API}/getTransactions?address=${TON_CONFIG.WALLET_ADDRESS}&limit=20`;
    const response = await fetch(url);
    const data = await response.json();
    if (!data.ok || !data.result) return res.status(502).json({ error: 'No se pudo consultar la blockchain' });

    const amountNano = Math.floor(amount * 1e9);
    const found = data.result.find(tx => {
      const inMsg = tx.in_msg;
      if (!inMsg) return false;
      return parseInt(inMsg.value || '0') >= amountNano * 0.99 && (inMsg.message || '') === comment;
    });

    if (!found) return res.json({ success: false, verified: false, message: 'Pago no encontrado aún' });

    const label = TON_PLAN_LABELS[plan];

    await db.createPayment({
      telegram_id: String(telegramId), plan, price: amount, original_price: amount, method: 'ton',
      screenshot_url: '', notes: `Pago TON · comment: ${comment} · tx: ${found.transaction_id?.hash || ''}`,
      status: 'approved', created_at: new Date().toISOString(),
      coupon_used: false, coupon_code: null, coupon_discount: 0, referral_discount: 0
    });

    await db.makeUserVIP(String(telegramId), { plan, plan_price: amount, vip_since: new Date().toISOString() });

    await bot.telegram.sendMessage(telegramId,
      `<tg-emoji emoji-id="6019175208240289774">🎉</tg-emoji> <b>¡Pago TON confirmado!</b>\n\n` +
      `<b>Plan:</b> ${label}\n<b>TON pagados:</b> 💎 ${amount}\n\n` +
      `Un administrador te enviará el archivo de configuración WireGuard en breve.\n\n<b>Tiempo estimado:</b> 1-12 horas`,
      { parse_mode: 'HTML' }
    );

    const user = await db.getUser(String(telegramId)).catch(() => null);
    const username = user?.username ? `@${user.username}` : 'Sin usuario';
    const firstName = user?.first_name || 'Usuario';
    const adminMsg = `💎 *NUEVO PAGO TON*\n\n👤 *Usuario:* ${firstName}\n📱 *Telegram:* ${username}\n🆔 *ID:* ${telegramId}\n📋 *Plan:* ${label}\n💎 *TON:* ${amount}\n🔖 *Comment:* \`${comment}\`\n📅 *Fecha:* ${new Date().toLocaleString('es-ES')}`;
    for (const adminId of ADMIN_IDS) {
      try { await bot.telegram.sendMessage(adminId, adminMsg, { parse_mode: 'Markdown' }); } catch (e) {}
    }

    if (user?.referrer_id) {
      try {
        await db.markReferralAsPaid(String(telegramId));
        const referrerUser = await db.getUser(user.referrer_id);
        if (referrerUser?.referrer_id) await db.markReferralAsPaid(user.referrer_id, 2);
      } catch (e) {}
    }

    res.json({ success: true, verified: true, message: '¡Pago verificado y plan activado!' });
  } catch (error) {
    console.error('Error verificando pago TON:', error);
    res.status(500).json({ error: 'Error verificando pago: ' + error.message });
  }
});

// ==================== ARCHIVOS DE PLANES ====================
app.post('/api/upload-plan-file', upload.single('file'), async (req, res) => {
  try {
    const { plan, adminId } = req.body;
    if (!isAdmin(adminId)) return res.status(403).json({ error: 'No autorizado' });
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
    if (!plan || !['basico', 'avanzado', 'cuba_vip', 'premium', 'anual'].includes(plan)) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'Plan inválido' }); }
    const fileName = req.file.originalname.toLowerCase();
    if (!fileName.endsWith('.zip') && !fileName.endsWith('.rar') && !fileName.endsWith('.conf')) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'Solo .conf, .zip o .rar' }); }
    const fileBuffer = fs.readFileSync(req.file.path);
    const uploadResult = await db.uploadPlanFile(fileBuffer, plan, req.file.originalname);
    fs.unlink(req.file.path, () => {});
    const savedFile = await db.savePlanFile({ plan, storage_filename: uploadResult.filename, original_name: uploadResult.originalName, public_url: uploadResult.publicUrl, uploaded_by: adminId, uploaded_at: new Date().toISOString() });
    res.json({ success: true, message: `Archivo de plan ${getPlanName(plan)} subido`, file: savedFile });
  } catch (error) { if (req.file?.path) fs.unlink(req.file.path, () => {}); res.status(500).json({ error: 'Error: ' + error.message }); }
});

// ==================== POOL DE PRUEBAS POR PLAN ====================

// Subir archivo al pool de un plan específico
app.post('/api/trial-files/upload', upload.single('file'), async (req, res) => {
  try {
    const { adminId, label, planType } = req.body;
    if (!isAdmin(adminId)) return res.status(403).json({ error: 'No autorizado' });
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });

    const targetPlan = PLAN_TYPES.includes(planType) ? planType : 'basico';
    const fileName = req.file.originalname.toLowerCase();
    if (!fileName.endsWith('.zip') && !fileName.endsWith('.rar') && !fileName.endsWith('.conf')) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'Solo .conf, .zip o .rar' }); }

    const ext = path.extname(req.file.originalname);
    const uniqueName = `trial_${targetPlan}_${Date.now()}${ext}`;
    const dir = TRIAL_DIRS[targetPlan] || TRIAL_DIRS['basico'];
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const localPath = path.join(dir, uniqueName);
    fs.copyFileSync(req.file.path, localPath);
    fs.unlink(req.file.path, () => {});

    let publicUrl = null;
    try {
      const buf = fs.readFileSync(localPath);
      const up = await db.uploadPlanFile(buf, `trial-${targetPlan}`, uniqueName);
      publicUrl = up.publicUrl;
    } catch (e) { console.warn(`⚠️ Supabase backup falló (${targetPlan}):`, e.message); }

    const saved = await db.saveTrialFileByPlan(targetPlan, {
      original_name: req.file.originalname,
      local_path: localPath,
      public_url: publicUrl,
      label: label || req.file.originalname,
      uploaded_by: adminId,
      is_active: true,
      uploaded_at: new Date().toISOString()
    });

    res.json({ success: true, message: `Archivo añadido al pool ${getPlanLabel(targetPlan)}`, file: saved, planType: targetPlan });
  } catch (error) {
    console.error('❌ Error subiendo archivo de prueba:', error);
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Error subiendo archivo: ' + error.message });
  }
});

// Obtener archivos del pool de un plan específico
app.get('/api/trial-files/:planType', async (req, res) => {
  try {
    const planType = PLAN_TYPES.includes(req.params.planType) ? req.params.planType : 'basico';
    const files = await db.getTrialFilesByPlan(planType);
    res.json((files || []).map(f => ({ ...f, local_exists: f.local_path ? fs.existsSync(f.local_path) : false })));
  } catch (error) { res.status(500).json({ error: 'Error obteniendo archivos' }); }
});

// Obtener todos los pools en un solo objeto { basico: [...], avanzado: [...], ... }
app.get('/api/trial-files', async (req, res) => {
  try {
    const result = {};
    for (const pt of PLAN_TYPES) {
      const files = await db.getTrialFilesByPlan(pt);
      result[pt] = (files || []).map(f => ({ ...f, local_exists: f.local_path ? fs.existsSync(f.local_path) : false }));
    }
    res.json(result);
  } catch (error) { res.status(500).json({ error: 'Error obteniendo archivos' }); }
});

app.put('/api/trial-files/:planType/:id/toggle', async (req, res) => {
  try {
    const { adminId, is_active } = req.body;
    if (!isAdmin(adminId)) return res.status(403).json({ error: 'No autorizado' });
    const planType = PLAN_TYPES.includes(req.params.planType) ? req.params.planType : 'basico';
    const updated = await db.updateTrialFileByPlan(planType, req.params.id, { is_active: !!is_active });
    res.json({ success: true, file: updated });
  } catch (error) { res.status(500).json({ error: 'Error: ' + error.message }); }
});

app.delete('/api/trial-files/:planType/:id', async (req, res) => {
  try {
    const { adminId } = req.body;
    if (!isAdmin(adminId)) return res.status(403).json({ error: 'No autorizado' });
    const planType = PLAN_TYPES.includes(req.params.planType) ? req.params.planType : 'basico';
    const file = await db.getTrialFileByPlan(planType, req.params.id);
    if (!file) return res.status(404).json({ error: 'Archivo no encontrado' });
    if (file.local_path && fs.existsSync(file.local_path)) fs.unlinkSync(file.local_path);
    await db.deleteTrialFileByPlan(planType, req.params.id);
    res.json({ success: true, message: 'Archivo eliminado' });
  } catch (error) { res.status(500).json({ error: 'Error: ' + error.message }); }
});

// Legacy: ruta antigua /api/upload-trial-file (mantener por compatibilidad)
app.post('/api/upload-trial-file', upload.single('file'), async (req, res) => {
  try {
    const { adminId } = req.body;
    if (!isAdmin(adminId)) return res.status(403).json({ error: 'No autorizado' });
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
    const fileName = req.file.originalname.toLowerCase();
    if (!fileName.endsWith('.zip') && !fileName.endsWith('.rar') && !fileName.endsWith('.conf')) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'Solo .conf, .zip o .rar' }); }
    const ext = path.extname(req.file.originalname);
    const targetPath = TRIAL_CURRENT_FILE + ext;
    fs.copyFileSync(req.file.path, targetPath);
    const poolPath = path.join(TRIAL_DIRS['basico'], `trial_basico_${Date.now()}${ext}`);
    fs.copyFileSync(req.file.path, poolPath);
    fs.unlink(req.file.path, () => {});
    let publicUrl = null;
    try { const buf = fs.readFileSync(targetPath); const up = await db.uploadPlanFile(buf, 'trial', req.file.originalname); publicUrl = up.publicUrl; await db.savePlanFile({ plan: 'trial', storage_filename: up.filename, original_name: up.originalName, public_url: up.publicUrl, uploaded_by: adminId, uploaded_at: new Date().toISOString() }); } catch(e) {}
    try { await db.saveTrialFileByPlan('basico', { original_name: req.file.originalname, local_path: poolPath, public_url: publicUrl, label: req.file.originalname, uploaded_by: adminId, is_active: true, uploaded_at: new Date().toISOString() }); } catch(e) {}
    res.json({ success: true, message: 'Archivo de prueba subido al pool Básico', file: { local_path: targetPath } });
  } catch (error) { if (req.file?.path) fs.unlink(req.file.path, () => {}); res.status(500).json({ error: 'Error: ' + error.message }); }
});

app.get('/api/plan-files', async (req, res) => { try { res.json(await db.getAllPlanFiles()); } catch (e) { res.status(500).json({ error: 'Error' }); } });
app.get('/api/plan-files/:plan', async (req, res) => { try { const f = await db.getPlanFile(req.params.plan); if (!f) return res.status(404).json({ error: 'No encontrado' }); res.json(f); } catch (e) { res.status(500).json({ error: 'Error' }); } });
app.delete('/api/plan-files/:plan', async (req, res) => {
  try {
    const { adminId } = req.body;
    if (!isAdmin(adminId)) return res.status(403).json({ error: 'No autorizado' });
    const deletedFile = await db.deletePlanFile(req.params.plan);
    if (req.params.plan === 'trial') { for (const ext of ['.conf', '.zip', '.rar']) { const fp = TRIAL_CURRENT_FILE + ext; if (fs.existsSync(fp)) fs.unlinkSync(fp); } }
    res.json({ success: true, message: `Archivo ${getPlanName(req.params.plan)} eliminado`, file: deletedFile });
  } catch (error) { res.status(500).json({ error: 'Error: ' + error.message }); }
});

app.get('/api/games-stats', async (req, res) => {
  try { const stats = await db.getGamesStatistics(); res.json(stats.games || []); } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/user/:telegramId/details', async (req, res) => {
  try {
    const user = await db.getUser(req.params.telegramId);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    let referralStats = null, payments = [], referrals = [];
    try { referralStats = await db.getReferralStats(req.params.telegramId); } catch(e) {}
    try { payments = await db.getUserPayments(req.params.telegramId) || []; } catch(e) {}
    try { referrals = await db.getReferralsByReferrer(req.params.telegramId) || []; } catch(e) {}
    const level1 = referrals.filter(r => r.level === 1), level2 = referrals.filter(r => r.level === 2);
    res.json({ ...user, telegram_id: user.telegram_id, first_name: user.first_name || 'Usuario', username: user.username || '', vip: user.vip || false, current_plan: user.plan || user.current_plan || null, plan: user.plan || user.current_plan || null, plan_price: user.plan_price || null, vip_since: user.vip_since || null, referrer_id: user.referrer_id || null, referrer_username: user.referrer_username || null, is_active: user.is_active !== false, trial_requested: user.trial_requested || false, trial_received: user.trial_received || false, created_at: user.created_at || null, referral_stats: referralStats, payments, referrals, level1_referrals: level1.length, level2_referrals: level2.length, level1_paid: level1.filter(r => r.has_paid).length, level2_paid: level2.filter(r => r.has_paid).length, total_referrals: referrals.length, paid_referrals: level1.filter(r => r.has_paid).length + level2.filter(r => r.has_paid).length });
  } catch (error) { res.status(500).json({ error: 'Error: ' + error.message }); }
});

app.post('/api/user/:userId/message', async (req, res) => {
  try {
    const { adminId, message } = req.body;
    if (!isAdmin(adminId)) return res.status(403).json({ error: 'No autorizado' });
    if (!message) return res.status(400).json({ error: 'Mensaje vacío' });
    const chatId = req.params.userId.toString().trim();
    const canSend = await canSendMessageToUser(chatId);
    if (!canSend.canSend) return res.status(400).json({ error: `No se puede enviar: ${canSend.reason}` });
    await bot.telegram.sendMessage(chatId, `📨 *Mensaje del Administrador:*\n\n${message}`, { parse_mode: 'Markdown' });
    res.json({ success: true, message: 'Mensaje enviado' });
  } catch (error) { res.status(500).json({ error: 'Error: ' + error.message }); }
});

app.post('/api/send-trials-to-valid', async (req, res) => {
  try {
    const { adminId } = req.body;
    if (!isAdmin(adminId)) return res.status(403).json({ error: 'No autorizado' });
    res.json(await sendTrialToValidUsers(adminId));
  } catch (error) { res.status(500).json({ success: false, error: 'Error: ' + error.message }); }
});

// ==================== CUPONES ====================
app.post('/api/coupons', async (req, res) => {
  try {
    const { code, discount, stock, expiry, description, adminId } = req.body;
    if (!isAdmin(adminId)) return res.status(403).json({ error: 'No autorizado' });
    if (!code || !discount || !stock) return res.status(400).json({ error: 'Faltan campos requeridos' });
    if (!/^[A-Z0-9]+$/.test(code)) return res.status(400).json({ error: 'Código inválido' });
    const discountNum = parseFloat(discount);
    if (isNaN(discountNum) || discountNum < 1 || discountNum > 100) return res.status(400).json({ error: 'Descuento 1-100' });
    const stockNum = parseInt(stock);
    if (isNaN(stockNum) || stockNum < 1) return res.status(400).json({ error: 'Stock debe ser mayor a 0' });
    let expiryDate = null;
    if (expiry) {
      let expiryStr = /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? expiry + 'T23:59:59' : expiry;
      expiryDate = new Date(expiryStr);
      if (isNaN(expiryDate.getTime())) expiryDate = new Date(expiry.replace('T', ' '));
      if (isNaN(expiryDate.getTime())) return res.status(400).json({ error: 'Fecha de expiración inválida' });
      if (expiryDate <= new Date()) return res.status(400).json({ error: 'La fecha debe ser en el futuro' });
    }
    const coupon = await db.createCoupon({ code: code.toUpperCase(), discount: discountNum, stock: stockNum, expiry: expiryDate, description: description || '', status: 'active', created_by: adminId });
    res.json({ success: true, message: 'Cupón creado', coupon });
  } catch (error) {
    if (error.message.includes('unique')) return res.status(400).json({ error: 'Ya existe un cupón con ese código' });
    res.status(500).json({ error: 'Error: ' + error.message });
  }
});

app.get('/api/coupons', async (req, res) => { try { res.json(await db.getCoupons()); } catch (e) { res.status(500).json({ error: 'Error' }); } });
app.get('/api/coupons/stats', async (req, res) => { try { res.json(await db.getCouponsStats()); } catch (e) { res.status(500).json({ error: 'Error' }); } });
app.get('/api/coupons/:code', async (req, res) => { try { const c = await db.getCoupon(req.params.code.toUpperCase()); if (!c) return res.status(404).json({ error: 'No encontrado' }); res.json(c); } catch (e) { res.status(500).json({ error: 'Error' }); } });

app.put('/api/coupons/:code', async (req, res) => {
  try {
    const { stock, status, adminId } = req.body;
    const code = req.params.code.toUpperCase();
    if (!isAdmin(adminId)) return res.status(403).json({ error: 'No autorizado' });
    const coupon = await db.getCoupon(code);
    if (!coupon) return res.status(404).json({ error: 'No encontrado' });
    let stockNum = coupon.stock;
    if (stock !== undefined) { stockNum = parseInt(stock); if (isNaN(stockNum) || stockNum < 0) return res.status(400).json({ error: 'Stock inválido' }); }
    let newStatus = coupon.status;
    if (status && ['active', 'inactive', 'expired'].includes(status)) newStatus = status;
    const updated = await db.updateCoupon(code, { stock: stockNum, status: newStatus, updated_at: new Date().toISOString(), updated_by: adminId });
    res.json({ success: true, message: 'Cupón actualizado', coupon: updated });
  } catch (error) { res.status(500).json({ error: 'Error: ' + error.message }); }
});

app.put('/api/coupons/:code/status', async (req, res) => {
  try {
    const { status, adminId } = req.body;
    const code = req.params.code.toUpperCase();
    if (!isAdmin(adminId)) return res.status(403).json({ error: 'No autorizado' });
    if (!status || !['active', 'inactive', 'expired'].includes(status)) return res.status(400).json({ error: 'Estado inválido' });
    const coupon = await db.getCoupon(code);
    if (!coupon) return res.status(404).json({ error: 'No encontrado' });
    const updated = await db.updateCouponStatus(code, status, adminId);
    res.json({ success: true, message: `Cupón ${status === 'active' ? 'activado' : 'desactivado'}`, coupon: updated });
  } catch (error) { res.status(500).json({ error: 'Error: ' + error.message }); }
});

app.delete('/api/coupons/:code', async (req, res) => {
  try {
    const { adminId } = req.body;
    const code = req.params.code.toUpperCase();
    if (!isAdmin(adminId)) return res.status(403).json({ error: 'No autorizado' });
    const coupon = await db.getCoupon(code);
    if (!coupon) return res.status(404).json({ error: 'No encontrado' });
    if (coupon.used && coupon.used > 0) return res.status(400).json({ error: 'No se puede eliminar un cupón que ha sido usado. Desactívalo en su lugar.' });
    await db.deleteCoupon(code);
    res.json({ success: true, message: 'Cupón eliminado' });
  } catch (error) { res.status(500).json({ error: 'Error: ' + error.message }); }
});

app.post('/api/coupons/verify/:code', async (req, res) => {
  try {
    const { telegramId } = req.body;
    const code = req.params.code.toUpperCase();
    if (!telegramId) return res.status(400).json({ error: 'ID de usuario requerido' });
    const coupon = await db.getCoupon(code);
    if (!coupon) return res.json({ success: false, error: 'Cupón no encontrado' });
    if (coupon.status !== 'active') return res.json({ success: false, error: `Cupón ${coupon.status === 'expired' ? 'expirado' : 'inactivo'}` });
    if (coupon.expiry) {
      let expiryStr = /^\d{4}-\d{2}-\d{2}$/.test(coupon.expiry) ? coupon.expiry + 'T23:59:59' : coupon.expiry;
      const expiryDate = new Date(expiryStr);
      if (expiryDate < new Date()) { await db.updateCouponStatus(code, 'expired', 'system'); return res.json({ success: false, error: 'Cupón expirado' }); }
    }
    if (coupon.stock <= 0) return res.json({ success: false, error: 'Cupón agotado' });
    if (await db.hasUserUsedCoupon(telegramId, code)) return res.json({ success: false, error: 'Ya has usado este cupón' });
    res.json({ success: true, coupon: { code: coupon.code, discount: coupon.discount, description: coupon.description, stock: coupon.stock }, message: `Descuento del ${coupon.discount}% aplicado.` });
  } catch (error) { res.status(500).json({ success: false, error: 'Error: ' + error.message }); }
});

app.get('/api/coupons/public/:code/usage', async (req, res) => {
  try {
    const coupon = await db.getCoupon(req.params.code.toUpperCase());
    if (!coupon) return res.status(404).json({ error: 'Cupón no encontrado' });
    res.json({ code: coupon.code, used: coupon.used || 0, stock_remaining: coupon.stock || 0, status: coupon.status, description: coupon.description || '', discount: coupon.discount });
  } catch (error) { res.status(500).json({ error: 'Error obteniendo cupón' }); }
});

app.post('/api/coupons/apply/:code', async (req, res) => {
  try {
    const { telegramId, paymentId, adminId } = req.body;
    const code = req.params.code.toUpperCase();
    if (!telegramId || !paymentId) return res.status(400).json({ error: 'ID de usuario y pago requeridos' });
    const coupon = await db.getCoupon(code);
    if (!coupon) return res.status(404).json({ error: 'No encontrado' });
    if (coupon.status !== 'active') return res.status(400).json({ error: `Cupón ${coupon.status === 'expired' ? 'expirado' : 'inactivo'}` });
    if (coupon.expiry && new Date(coupon.expiry) < new Date()) { await db.updateCouponStatus(code, 'expired', 'system'); return res.status(400).json({ error: 'Cupón expirado' }); }
    if (coupon.stock <= 0) return res.status(400).json({ error: 'Cupón agotado' });
    if (await db.hasUserUsedCoupon(telegramId, code)) return res.status(400).json({ error: 'Ya has usado este cupón' });
    const applied = await db.applyCouponToPayment(code, telegramId, paymentId);
    if (!applied) return res.status(400).json({ error: 'No se pudo aplicar' });
    await db.updateCoupon(code, { stock: coupon.stock - 1, used: (coupon.used || 0) + 1, updated_at: new Date().toISOString(), updated_by: adminId || 'system' });
    res.json({ success: true, message: `Descuento del ${coupon.discount}% aplicado.`, discount: coupon.discount, coupon: coupon.code });
  } catch (error) { res.status(500).json({ error: 'Error: ' + error.message }); }
});

app.get('/api/coupons/history/:code', async (req, res) => { try { res.json(await db.getCouponUsageHistory(req.params.code.toUpperCase())); } catch (e) { res.status(500).json({ error: 'Error' }); } });

// ==================== HTML ESTÁTICO ====================
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public/index.html')); });
app.get('/plans.html', (req, res) => { res.sendFile(path.join(__dirname, 'public/plans.html')); });
app.get('/payment.html', (req, res) => { res.sendFile(path.join(__dirname, 'public/payment.html')); });
app.get('/admin.html', (req, res) => { res.sendFile(path.join(__dirname, 'public/admin.html')); });
app.get('/how.html', (req, res) => { res.sendFile(path.join(__dirname, 'public/how.html')); });
app.get('/faq.html', (req, res) => { res.sendFile(path.join(__dirname, 'public/faq.html')); });
app.get('/politicas.html', (req, res) => { res.sendFile(path.join(__dirname, 'public/politicas.html')); });
app.get('/garantias.html', (req, res) => { res.sendFile(path.join(__dirname, 'public/garantias.html')); });

// Pagos de un usuario (para garantias.html)
app.get('/api/user-payments/:telegramId', async (req, res) => {
  try {
    const payments = await db.getUserPayments(req.params.telegramId);
    res.json(payments || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Solicitud de reembolso
// Fallback: obtener solicitudes de reembolso pendientes
if (!db.getRefundRequests) {
  db.getRefundRequests = async () => {
    try {
      const sb = getSbClient();
      const { data, error } = await sb.from('payments').select('*').eq('status', 'refund_pending').order('refund_requested_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (e) { console.error('❌ Error en getRefundRequests:', e); return []; }
  };
}

const REFUND_MOTIVOS = {
  incompatibilidad: 'Incompatibilidad con dispositivo',
  conexion: 'Error de conexión persistente',
  velocidad: 'Velocidad inferior a la prometida',
  error_compra: 'Compra por error / plan equivocado',
  otros: 'Otros motivos'
};

/////REFUND REQUEST /////
app.post('/api/refund-request', upload.single('refundProof'), async (req, res) => {
  try {
    const { telegramId, paymentId, motivo, detalles, planName, refundDestination } = req.body;

    if (!telegramId || !paymentId || !motivo || !refundDestination) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ success: false, error: 'Faltan parámetros obligatorios.' });
    }

    const payment = await db.getPayment(paymentId);
    if (!payment) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      return res.status(404).json({ success: false, error: 'Pago no encontrado.' });
    }
    if (String(payment.telegram_id) !== String(telegramId)) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      return res.status(403).json({ success: false, error: 'No autorizado.' });
    }

    const activatedAt = new Date(payment.approved_at || payment.created_at).getTime();
    const hoursElapsed = (Date.now() - activatedAt) / 3600000;
    if (hoursElapsed > 48) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ success: false, error: 'El plazo de 48 horas para solicitar reembolso ha expirado.' });
    }

    const user = await db.getUser(String(telegramId)).catch(() => null);
    const username = user?.username ? `@${user.username}` : 'Sin usuario';
    const firstName = user?.first_name || 'Usuario';

    let proofUrl = null;
    if (req.file) {
      try {
        proofUrl = await db.uploadImage(req.file.path, telegramId);
        fs.unlink(req.file.path, () => {});
      } catch (uploadError) {
        proofUrl = `/uploads/${req.file.filename}`;
      }
    }

    await db.updatePayment(paymentId, {
      status: 'refund_pending',
      refund_motivo: motivo,
      refund_detalles: detalles || '',
      refund_plan_name: planName || payment.plan,
      refund_requested_at: new Date().toISOString(),
      refund_destination: refundDestination,
      refund_proof_url: proofUrl || null
    });

    const adminMsgText = `🔴 *SOLICITUD DE REEMBOLSO*\n\n` +
      `👤 *Usuario:* ${firstName}\n` +
      `📱 *Telegram:* ${username}\n` +
      `🆔 *ID:* ${telegramId}\n` +
      `📋 *Plan:* ${planName || payment.plan}\n` +
      `💳 *Método de pago:* ${payment.method}\n` +
      `🔖 *ID de pago:* \`${paymentId}\`\n` +
      `📁 *Archivo entregado:* ${payment.config_file || 'No registrado'}\n` +
      `📌 *Motivo:* ${REFUND_MOTIVOS[motivo] || motivo}\n` +
      `💬 *Detalles:* ${detalles || 'Sin detalles adicionales'}\n` +
      `💰 *Destino del reembolso:* ${refundDestination || 'No especificado'}\n` +
      `📅 *Fecha solicitud:* ${new Date().toLocaleString('es-ES')}\n\n` +
      `Procesa esta solicitud desde el Panel Admin → Reembolsos.`;

    for (const adminId of ADMIN_IDS) {
      try {
        if (proofUrl) {
          const ext = (proofUrl.split('.').pop() || '').toLowerCase();
          const isVideo = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'gif'].includes(ext);
          if (isVideo) {
            await bot.telegram.sendVideo(adminId, proofUrl, { caption: adminMsgText, parse_mode: 'Markdown' });
          } else {
            await bot.telegram.sendPhoto(adminId, proofUrl, { caption: adminMsgText, parse_mode: 'Markdown' });
          }
        } else {
          await bot.telegram.sendMessage(adminId, adminMsgText, { parse_mode: 'Markdown' });
        }
      } catch(e) {
        console.error(`Error notificando a admin ${adminId}:`, e.message);
      }
    }

    // Confirmar al usuario
    try {
      await bot.telegram.sendMessage(telegramId,
        `✅ <b>Solicitud de reembolso recibida</b>\n\n` +
        `<b>Plan:</b> ${planName || payment.plan}\n` +
        `<b>Motivo:</b> ${REFUND_MOTIVOS[motivo] || motivo}\n` +
        `\nUn administrador revisará tu caso en las próximas 1–24 horas y te contactará por este chat.`,
        { parse_mode: 'HTML' }
      );
    } catch(e) {}

    // ✅ RESPONDER AL CLIENTE
    res.json({ success: true });

  } catch (error) {
    console.error('❌ Error en refund-request:', error);
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ success: false, error: error.message });
  }
});
  
// Listar solicitudes de reembolso pendientes (panel admin)
app.get('/api/refund-requests', async (req, res) => {
  try {
    const requests = await db.getRefundRequests();
    // Enriquecer con datos de usuario
    const enriched = await Promise.all(requests.map(async (r) => {
      const user = await db.getUser(String(r.telegram_id)).catch(() => null);
      return {
        ...r,
        first_name: user?.first_name || 'Usuario',
        username: user?.username || ''
      };
    }));
    res.json(enriched);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Responder a una solicitud de reembolso (aceptar/denegar) con mensaje del admin
app.post('/api/refund-requests/:id/respond', upload.single('refundProof'), async (req, res) => {
  try {
    const { adminId, action, message } = req.body;
    if (!isAdmin(adminId)) { if (req.file?.path) fs.unlink(req.file.path, () => {}); return res.status(403).json({ error: 'No autorizado' }); }
    if (!['accept', 'reject'].includes(action)) { if (req.file?.path) fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'Acción inválida' }); }

    const payment = await db.getPayment(req.params.id);
    if (!payment) { if (req.file?.path) fs.unlink(req.file.path, () => {}); return res.status(404).json({ error: 'Solicitud no encontrada' }); }

    const telegramId = String(payment.telegram_id);
    const planName = payment.refund_plan_name || getPlanName(payment.plan);

    // Subir comprobante si se adjuntó
    let proofUrl = null;
    if (req.file) {
      try {
        proofUrl = await db.uploadImage(req.file.path, telegramId);
        fs.unlink(req.file.path, () => {});
      } catch (e) {
        proofUrl = `/uploads/${req.file.filename}`;
      }
    }

    if (action === 'accept') {
      await db.removeVIP(telegramId);
      await db.updatePayment(req.params.id, {
        status: 'refunded',
        refunded_at: new Date().toISOString(),
        refunded_by: adminId,
        refund_response_message: message || '',
        refund_proof_url: proofUrl || null
      });

      const finalMsg = message && message.trim()
        ? message.trim()
        : `✅ <b>Su solicitud de reembolso fue aceptada</b>\n\nSu plan <b>${planName}</b> ha sido cancelado y el reembolso se procesará por su método de pago original en las próximas horas.\n\nGracias por su paciencia.`;

      try {
        if (proofUrl) {
          await bot.telegram.sendPhoto(telegramId, proofUrl, { caption: finalMsg, parse_mode: 'HTML' });
        } else {
          await bot.telegram.sendMessage(telegramId, finalMsg, { parse_mode: 'HTML' });
        }
      } catch(e) {}
    } else {
      await db.updatePayment(req.params.id, {
        status: 'approved',
        refund_rejected_at: new Date().toISOString(),
        refund_rejected_by: adminId,
        refund_response_message: message || '',
        refund_proof_url: proofUrl || null
      });

      const finalMsg = message && message.trim()
        ? message.trim()
        : `ℹ️ <b>Su solicitud de reembolso fue denegada</b>\n\nTras revisar su caso, no procede el reembolso según nuestra política de garantías. Su plan <b>${planName}</b> sigue activo con normalidad.\n\nSi tiene dudas, contacte con soporte.`;

      try {
        if (proofUrl) {
          await bot.telegram.sendPhoto(telegramId, proofUrl, { caption: finalMsg, parse_mode: 'HTML' });
        } else {
          await bot.telegram.sendMessage(telegramId, finalMsg, { parse_mode: 'HTML' });
        }
      } catch(e) {}
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error respondiendo reembolso:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== BOT DE TELEGRAM ====================
// Middleware para registrar la última actividad del bot
bot.use(async (ctx, next) => {
  global.lastBotActivity = Date.now();
  return next();
});

// Middleware: bloquear usuarios baneados
bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  const userId = ctx.from.id.toString();
  if (isAdmin(userId)) return next(); // Admins nunca baneados
  try {
    const user = await db.getUser(userId);
    if (user?.banned) {
      if (ctx.callbackQuery) await ctx.answerCbQuery('🚫 Estás baneado.', { show_alert: true }).catch(() => {});
      else await ctx.reply('🚫 Tu cuenta ha sido suspendida. Contacta con soporte.').catch(() => {});
      return;
    }
  } catch (e) {}
  return next();
});

bot.catch((err, ctx) => { console.error('❌ Error en el bot:', err); });

bot.action('show_support', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const webappUrl = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
    await ctx.reply(getSupportHtml(), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
        [createButton("CEO", { url: 'https://t.me/vpncubawire', icon_custom_emoji_id: '5332455502917949981' }), createButton("WHATSAPP", { url: 'https://wa.me/447348275566', icon_custom_emoji_id: '5935973359480213803'})],
        [createButton("ADMIN", { url: 'https://t.me/ErenJeager129182', icon_custom_emoji_id: '5445221832074483553' }), createButton("WHATSAPP ", { url: 'https://wa.me/5350793992', icon_custom_emoji_id: '5935973359480213803'})],
        [createButton("MODERADOR", { url: 'https://t.me/JosherSnchz', icon_custom_emoji_id: '5197269100878907942' }), createButton("WHATSAPP ", { url: 'https://wa.me/5351435068' , icon_custom_emoji_id: '5935973359480213803' })],
        [createButton("SOLICITAR REEMBOLSO", wa(`${webappUrl}/garantias.html?userId=${userId}`, ctx), {icon_custom_emoji_id: '5444856076954520455'})],
        [createButton("MENÚ PRINCIPAL", { callback_data: 'main_menu' })]
    ] } });
  } catch (error) { await ctx.answerCbQuery('❌ Error'); }
});

bot.action('wa_ceo',   async (ctx) => { await ctx.answerCbQuery(); await ctx.reply('https://wa.me/5356557646'); });
bot.action('wa_admin', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply('https://wa.me/5350793992'); });
bot.action('wa_mod',   async (ctx) => { await ctx.answerCbQuery(); await ctx.reply('https://wa.me/5351435068'); });

bot.action('check_status', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    await ctx.answerCbQuery();
    const user = await db.getUser(userId);
    if (!user) { await ctx.reply('❌ *NO ESTÁS REGISTRADO*\n\nUsa "VER PLANES" para comenzar.', { parse_mode: 'Markdown' }); return; }
    const webappUrl = `${process.env.WEBAPP_URL || `http://localhost:${PORT}`}/plans.html?userId=${userId}`;
    if (user?.vip) {
      const diasRestantes = calcularDiasRestantes(user);
      if (diasRestantes <= 0) {
        await db.removeVIP(userId);
        await ctx.reply('⚠️ <b>Tu plan VIP ha expirado</b>\n\nRenueva ahora para continuar.', { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[createButton("VER PLANES", wa(webappUrl, ctx))], [createButton("MENÚ PRINCIPAL", { callback_data: 'main_menu' })]] } });
        return;
      }
      await ctx.reply(getVipStatusHtml(user), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[createButton("VER PLANES", wa(webappUrl, ctx))], [createButton("MENÚ PRINCIPAL", { callback_data: 'main_menu' })]] } });
      if (diasRestantes <= 5) await ctx.reply(`⏰ <b>Tu plan expira pronto:</b> ${diasRestantes} día${diasRestantes === 1 ? '' : 's'}`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[createButton("RENOVAR AHORA", wa(webappUrl, ctx))]] } });
    } else {
      await ctx.reply('❌ *NO ERES USUARIO VIP*\n\nHaz clic para ver nuestros planes.', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[createButton("VER PLANES", wa(webappUrl, ctx))], [createButton("MENÚ PRINCIPAL", { callback_data: 'main_menu' })]] } });
    }
  } catch (error) { try { await ctx.reply('❌ Error al verificar.'); } catch(e){} try { await ctx.answerCbQuery(); } catch(e){} }
});

bot.action('download_wireguard', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(getDownloadWireguardHtml(), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[createButton("WINDOWS", { url: 'https://www.wireguard.com/install/' }), createButton("ANDROID", { url: 'https://play.google.com/store/apps/details?id=com.wireguard.android' })], [createButton("IOS", { url: 'https://apps.apple.com/app/id1441195209' })], [createButton("MENÚ PRINCIPAL", { callback_data: 'main_menu' })]] } });
});

bot.action('referral_info', async (ctx) => {
  const userId = ctx.from.id.toString();
  const referralLink = `https://t.me/vpncubaw_bot?start=ref${userId}`;
  try {
    const user = await db.getUser(userId);
    let referralStats = null;
    if (user) try { referralStats = await db.getReferralStats(userId); } catch (e) {}
    await ctx.answerCbQuery();
    await ctx.reply(getReferralInfoHtml(userId, referralStats), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[createButton("COPIAR ENLACE", { callback_data: 'copy_referral_link' })], [createButton("MENÚ PRINCIPAL", { callback_data: 'main_menu' })]] } });
  } catch (error) { await ctx.answerCbQuery(); await ctx.reply(`🤝 Tu enlace: \`https://t.me/vpncubaw_bot?start=ref${userId}\``, { parse_mode: 'Markdown' }); }
});

bot.action('how_it_works', async (ctx) => {
  try {
    const webappUrl = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
    await ctx.answerCbQuery();
    await ctx.reply(getHowItWorksHtml(), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[createButton("VER GUÍA COMPLETA", wa(`${webappUrl}/how.html`, ctx))], [createButton("MENÚ PRINCIPAL", { callback_data: 'main_menu' })]] } });
  } catch (error) { await ctx.answerCbQuery('❌ Error'); }
});

bot.action('main_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id.toString();
  const keyboard = buildMainMenuKeyboard(userId, ctx.from.first_name, isAdmin(userId), isGroupCtx(ctx));
  await ctx.reply(
`<tg-emoji emoji-id="5199814019325646173">🚀</tg-emoji> <b>VPN CUBA - MENÚ PRINCIPAL</b>

<tg-emoji emoji-id="5406745015365943482">📋</tg-emoji> Selecciona una opción:`,
{
    parse_mode: 'HTML',
    ...keyboard
});
});

bot.action('copy_referral_link', async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const referralLink = `https://t.me/vpncubaw_bot?start=ref${userId}`;
    await ctx.answerCbQuery('📋 Enlace listo para copiar');
    await ctx.reply(`📋 *Enlace de referido:*\n\n\`${referralLink}\`\n\nMantén presionado para copiar.`, { parse_mode: 'Markdown', reply_to_message_id: ctx.callbackQuery.message.message_id });
  } catch (error) { await ctx.answerCbQuery('❌ Error'); }
});

bot.action('politicas', async (ctx) => {
  try {
    const webappUrl = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
    const userId = ctx.from.id.toString();
    await ctx.answerCbQuery();
    await ctx.reply(getPoliticasHtml(), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[createButton("TÉRMINOS DE SERVICIO", wa(`${webappUrl}/politicas.html?section=terminos`, ctx))], [createButton("POLÍTICA DE REEMBOLSO", wa(`${webappUrl}/politicas.html?section=reembolso`, ctx))], [createButton("POLÍTICA DE PRIVACIDAD", wa(`${webappUrl}/politicas.html?section=privacidad`, ctx))], [createButton("SOLICITAR REEMBOLSO", wa(`${webappUrl}/garantias.html?userId=${userId}`, ctx), {icon_custom_emoji_id: '5444856076954520455'})], [createButton("MENÚ PRINCIPAL", { callback_data: 'main_menu' })]] } });
  } catch (error) { await ctx.answerCbQuery('❌ Error'); }
});

bot.action('faq', async (ctx) => {
  try {
    const webappUrl = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
    await ctx.answerCbQuery();
    await ctx.reply(getFaqHtml(), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[createButton("VER PREGUNTAS FRECUENTES", wa(`${webappUrl}/faq.html`, ctx))], [createButton("MENÚ PRINCIPAL", { callback_data: 'main_menu' })]] } });
  } catch (error) { await ctx.answerCbQuery('❌ Error'); }
});

bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const firstName = ctx.from.first_name;
    const esAdmin = isAdmin(userId);
    const startPayload = ctx.startPayload;
    const chatType = ctx.chat.type;
    const isGroup = chatType === 'group' || chatType === 'supergroup';
    let referrerId = null, referrerUsername = null;
    if (startPayload && startPayload.startsWith('ref') && !isGroup) {
        referrerId = startPayload.replace('ref', '');
        try { const referrer = await db.getUser(referrerId); if (referrer) referrerUsername = referrer.username; } catch (e) {}
        if (referrerId) { try { await db.createReferral(referrerId, userId.toString(), ctx.from.username, firstName); } catch (e) {} }
    }
    try {
        const userData = { telegram_id: userId.toString(), username: ctx.from.username, first_name: firstName, last_name: ctx.from.last_name, created_at: new Date().toISOString(), is_active: true };
        if (referrerId) { userData.referrer_id = referrerId; userData.referrer_username = referrerUsername; }
        await db.saveUser(userId.toString(), userData);
    } catch (error) { console.error('Error guardando usuario:', error); }
    const keyboard = buildMainMenuKeyboard(userId.toString(), firstName, esAdmin, isGroup);
    let welcomeMessage =
`<tg-emoji emoji-id="5339262759794123186">👋</tg-emoji> ¡Hola @${ctx.from.username || firstName}

<tg-emoji emoji-id="5199814019325646173">🚀</tg-emoji> <b>VPN CUBA - MENÚ PRINCIPAL</b>

<tg-emoji emoji-id="5861561131226632101">⚡</tg-emoji> Conéctate con la mejor latencia para gaming y navegación.

<tg-emoji emoji-id="5406745015365943482">📋</tg-emoji> Selecciona una opción:`;
    try {
        const gifPath = path.join(__dirname, 'assets', 'vpncuba-premium.gif');
        await bot.telegram.sendAnimation(ctx.chat.id, { source: gifPath }, { caption: welcomeMessage, parse_mode: 'HTML', ...keyboard });
    } catch (e) {
        console.error('Error enviando GIF de bienvenida:', e);
        await bot.telegram.sendMessage(ctx.chat.id, welcomeMessage, { parse_mode: 'HTML', ...keyboard });
    }
});

bot.command('help', async (ctx) => { const keyboard = buildMainMenuKeyboard(ctx.from.id, ctx.from.first_name, isAdmin(ctx.from.id)); await ctx.reply('🆘 *Ayuda de VPN Cuba*\n\nUsa los botones para navegar.', { parse_mode: 'Markdown', ...keyboard }); });
bot.command('menu', async (ctx) => { const keyboard = buildMainMenuKeyboard(ctx.from.id.toString(), ctx.from.first_name, isAdmin(ctx.from.id)); 
                                    await ctx.reply(
`<tg-emoji emoji-id="5199814019325646173">🚀</tg-emoji> <b>VPN CUBA - MENÚ PRINCIPAL</b>

<tg-emoji emoji-id="5406745015365943482">📋</tg-emoji> Selecciona una opción:`,
{
    parse_mode: 'HTML',
    ...keyboard
}); 
                  });
bot.command('referidos', async (ctx) => {
  const userId = ctx.from.id;
  try {
    const user = await db.getUser(userId);
    let referralStats = null;
    if (user) try { referralStats = await db.getReferralStats(userId); } catch (e) {}
    await ctx.reply(getReferralInfoHtml(userId, referralStats), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[createButton("COPIAR ENLACE", { callback_data: 'copy_referral_link' })], [createButton("MENÚ PRINCIPAL", { callback_data: 'main_menu' })]] } });
  } catch (error) { await ctx.reply(`🤝 Tu enlace: \`https://t.me/vpncubaw_bot?start=ref${userId}\``, { parse_mode: 'Markdown' }); }
});
bot.command('trialstatus', async (ctx) => {
  const eligibility = await db.checkTrialEligibility(ctx.from.id);
  await ctx.reply(eligibility.eligible ? `✅ *Puedes solicitar una prueba*\n\n${eligibility.reason}. Usa el botón VER PLANES.` : `❌ *No puedes solicitar prueba*\n\n${eligibility.reason}`, { parse_mode: 'Markdown' });
});
bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx.from.id)) { await ctx.reply('⛔ No tienes permisos.'); return; }
  const adminUrl = `${process.env.WEBAPP_URL || `http://localhost:${PORT}`}/admin.html?userId=${ctx.from.id}&admin=true`;
  await ctx.reply('🔧 *PANEL DE ADMINISTRACIÓN*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[createButton("ABRIR PANEL WEB", wa(adminUrl, ctx))]] } });
});

bot.command('ban', async (ctx) => {
  if (!isAdmin(ctx.from.id)) { await ctx.reply('⛔ No tienes permisos.'); return; }
  const args = ctx.message.text.split(' ').slice(1);
  const targetId = args[0];
  if (!targetId) { await ctx.reply('❌ Uso: /ban <telegram_id> [motivo]'); return; }
  const reason = args.slice(1).join(' ') || 'Baneado por administrador';
  try {
    const user = await db.getUser(targetId);
    if (!user) { await ctx.reply(`❌ Usuario ${targetId} no encontrado.`); return; }
    await db.updateUser(targetId, { banned: true, ban_reason: reason, banned_at: new Date().toISOString(), banned_by: ctx.from.id.toString() });
    try { await bot.telegram.sendMessage(targetId, `🚫 <b>Has sido baneado de VPN Cuba.</b>\n\nMotivo: ${reason}\n\nContacta con soporte si crees que es un error.`, { parse_mode: 'HTML' }); } catch (e) {}
    await ctx.reply(`✅ Usuario <b>${user.first_name || targetId}</b> (@${user.username || 'sin usuario'}) baneado.\nMotivo: ${reason}`, { parse_mode: 'HTML' });
  } catch (error) { await ctx.reply('❌ Error al banear: ' + error.message); }
});

bot.command('unban', async (ctx) => {
  if (!isAdmin(ctx.from.id)) { await ctx.reply('⛔ No tienes permisos.'); return; }
  const targetId = ctx.message.text.split(' ')[1];
  if (!targetId) { await ctx.reply('❌ Uso: /unban <telegram_id>'); return; }
  try {
    const user = await db.getUser(targetId);
    if (!user) { await ctx.reply(`❌ Usuario ${targetId} no encontrado.`); return; }
    await db.updateUser(targetId, { banned: false, ban_reason: null, banned_at: null, banned_by: null });
    try { await bot.telegram.sendMessage(targetId, `✅ <b>Tu ban ha sido levantado.</b>\n\nYa puedes usar VPN Cuba con normalidad.`, { parse_mode: 'HTML' }); } catch (e) {}
    await ctx.reply(`✅ Usuario <b>${user.first_name || targetId}</b> desbaneado.`, { parse_mode: 'HTML' });
  } catch (error) { await ctx.reply('❌ Error al desbanear: ' + error.message); }
});

bot.command('botstatus', async (ctx) => {
  const userId = ctx.from.id.toString();
  const esAdmin = isAdmin(userId);

  if (!esAdmin) {
    // Mensaje simple para usuarios normales
    await ctx.reply(
      `✅ <b>VPN CUBA Bot</b> está funcionando correctamente.\n\n` +
      `Si experimentas problemas, contacta con nuestro soporte usando el botón "SOPORTE".`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // ---------- A partir de aquí, solo para administradores ----------
  // 1. Calcular uptime
  const uptimeMs = Date.now() - START_TIME;
  const uptimeSeg = Math.floor(uptimeMs / 1000);
  const uptimeStr = `${Math.floor(uptimeSeg / 86400)}d ${Math.floor((uptimeSeg % 86400) / 3600)}h ${Math.floor((uptimeSeg % 3600) / 60)}m ${uptimeSeg % 60}s`;

  // 2. Verificar conexión a Supabase y obtener estadísticas
  let supabaseStatus = '❌ Sin conexión';
  let totalUsers = 0;
  let vipUsers = 0;
  try {
    const { count: total, error: errTotal } = await supabaseAdmin
      .from('users')
      .select('*', { count: 'exact', head: true });
    if (!errTotal) totalUsers = total;

    const { count: vip, error: errVip } = await supabaseAdmin
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('vip', true);
    if (!errVip) vipUsers = vip;

    supabaseStatus = '✅ Conectado';
  } catch (e) {
    supabaseStatus = `⚠️ Error: ${e.message}`;
  }

  // 3. (Opcional) Última actividad global
  const lastActivity = global.lastBotActivity
    ? new Date(global.lastBotActivity).toLocaleString()
    : 'No registrada';

  // Construir mensaje para admin (sin webhook)
  const mensajeAdmin =
    `🤖 *ESTADO DEL BOT VPN CUBA*\n\n` +
    `⏱️ *Uptime:* ${uptimeStr}\n` +
    `🟢 *Supabase:* ${supabaseStatus}\n` +
    `👥 *Usuarios totales:* ${totalUsers}\n` +
    `👑 *Usuarios VIP:* ${vipUsers}\n` +
    `🕒 *Última actividad:* ${lastActivity}\n\n` +
    `_Versión: 2.0 | Servidor: ${process.env.WEBAPP_URL || 'localhost'}_`;

  await ctx.reply(mensajeAdmin, { parse_mode: 'Markdown' });
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;
  const userId = ctx.from.id.toString();
  const esAdmin = isAdmin(userId);
  const webappUrl = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
  if (text === '📁 VER PLANES') { await ctx.reply('📋 *NUESTROS PLANES*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[createButton("ABRIR WEB DE PLANES", wa(`${webappUrl}/plans.html?userId=${userId}`, ctx))], [createButton("MENÚ PRINCIPAL", { callback_data: 'main_menu' })]] } }); }
  else if (text === '⌨ PANEL ADMIN' && esAdmin) { await ctx.reply('🔧 *PANEL DE ADMINISTRACIÓN*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[createButton("ABRIR PANEL WEB", wa(`${webappUrl}/admin.html?userId=${userId}&admin=true`, ctx))], [createButton("MENÚ PRINCIPAL", { callback_data: 'main_menu' })]] } }); }
});

app.post('/webhook', (req, res) => { bot.handleUpdate(req.body, res); });

async function setWebhook() {
    const webhookUrl = `${process.env.WEBAPP_URL}/webhook`;
    try {
        await bot.telegram.setWebhook(webhookUrl);
        console.log(`✅ Webhook establecido en: ${webhookUrl}`);
    } catch (error) {
        console.error('❌ Error estableciendo webhook:', error);
        console.log('⚠️ Usando polling como fallback...');
        await bot.launch();
    }
}

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Servidor en http://localhost:${PORT}`);
    await loadAdminsFromDb();
    await loadPlanPricesFromDb();
    console.log(`👑 Admins: ${ADMIN_IDS.join(', ')}`);
    console.log(`💰 USDT Wallet: ${USDT_CONFIG.WALLET_ADDRESS}`);
    await verifyStorageBuckets();
    await initializeStorageBuckets();
    await initializeUsdtSystem();
    await setWebhook();
    try {
        await bot.telegram.setMyCommands([
            { command: 'start', description: 'Iniciar el bot / Ver menú' },
            { command: 'menu', description: 'Mostrar menú principal' },
            { command: 'help', description: 'Mostrar ayuda' },
            { command: 'referidos', description: 'Obtener enlace de referidos' },
            { command: 'trialstatus', description: 'Ver estado de prueba gratuita' },
            { command: 'admin', description: 'Panel de administración (solo admins)' }
        ]);
    } catch (error) { console.error('❌ Error configurando comandos:', error); }
    startKeepAlive();
    console.log(`🎯 Pool de pruebas: separado por plan (basico/avanzado/cuba_vip/premium/anual)`);
    console.log(`💰 Sistema USDT: MODO MANUAL`);
});

// =========================================================================
//  ESCUCHADORES NATIVOS PARA TELEGRAM STARS (INSERTAR AQUÍ)
// =========================================================================

// 1. Responder obligatoriamente al PreCheckoutQuery (dentro del tiempo límite de 10 segs)
bot.on('pre_checkout_query', async (ctx) => {
    try {
        await ctx.answerPreCheckoutQuery(true);
    } catch (error) {
        console.error('❌ Error en answerPreCheckoutQuery:', error);
    }
});

// 2. Procesar la entrega automática una vez completada la transferencia de Estrellas
bot.on('successful_payment', async (ctx) => {
    try {
        const payment = ctx.message.successful_payment;
        const payload = JSON.parse(payment.invoice_payload);
        
        if (payload.method === 'stars') {
            const userId = payload.userId;
            const planType = payload.planType;

            // Buscamos al usuario en base de datos para actualizar su suscripción
            const { data: user, error: fetchError } = await supabaseAdmin
                .from('users')
                .select('*')
                .eq('telegram_id', userId)
                .single();

            if (fetchError || !user) {
                return await ctx.reply(`⚠️ Pago recibido pero no localizamos tu ID en la base de datos. Contacta a soporte informando este ID: ${userId}`);
            }

            // Calculamos días adicionales manteniendo coherencia con calcularDiasRestantes
            let diasAdicionales = 30;
            if (planType === 'avanzado') diasAdicionales = 60;
            if (planType === 'anual') diasAdicionales = 365;

            let nuevaFechaInicio = new Date();
            if (user.vip && user.vip_since) {
                const fechaActual = new Date();
                const fechaVipPrevia = new Date(user.vip_since);
                // Si ya era VIP y no ha expirado, extendemos su tiempo sumando sobre la fecha previa
                if (fechaVipPrevia > fechaActual) {
                    nuevaFechaInicio = fechaVipPrevia;
                }
            }
            
            // Guardamos los cambios simulando la aprobación manual que ya usas
            const { error: updateError } = await supabaseAdmin
                .from('users')
                .update({
                    vip: true,
                    vip_since: nuevaFechaInicio.toISOString(),
                    plan: planType,
                    plan_price: payment.total_amount.toString() + " Estrellas",
                    updated_at: new Date().toISOString()
                })
                .eq('telegram_id', userId);

            if (updateError) throw updateError;

            // Enviar confirmación al usuario por el bot corporativo
            await ctx.reply(`👑 ¡Pago Exitoso! Tu plan ${getPlanName(planType)} ha sido activado mediante Telegram Stars. ¡Gracias por confiar en VPN CUBA! 🚀`);
            
            // Notificar de manera independiente al canal de Administración/Logs si existiese
            console.log(`💰 [STARS] Usuario ${userId} adquirió exitosamente el plan ${planType}`);
        }
    } catch (error) {
        console.error('❌ Error procesando successful_payment:', error);
        await ctx.reply('⚠️ Ocurrió un error al intentar procesar tu entrega VIP de forma automatizada, por favor contacta al administrador con el comprobante.');
    }
});


process.on('uncaughtException', (error) => { console.error('❌ Error no capturado:', error); });
process.on('unhandledRejection', (reason) => { console.error('❌ Promesa rechazada:', reason); });
process.on('SIGINT', () => { bot.telegram.deleteWebhook().catch(() => {}); process.exit(0); });

function startKeepAlive() {
    const healthCheckUrl = `http://localhost:${PORT}/api/health`;
    const EXTERNAL_URL = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
    setInterval(async () => { try { await fetch(healthCheckUrl); console.log(`💓 Keep-alive OK [${new Date().toLocaleTimeString()}]`); } catch (e) {} }, 4 * 60 * 1000);
    setInterval(async () => { try { await fetch(`${EXTERNAL_URL}/api/health`); } catch (e) {} }, 10 * 60 * 1000);
    setInterval(async () => { try { await fetch(`${healthCheckUrl}?t=${Date.now()}`); } catch (e) {} }, 8 * 60 * 1000);
    console.log(`🔄 Keep-alive iniciado → ${EXTERNAL_URL}`);
}

module.exports = { app, isAdmin, ADMIN_IDS, initializeStorageBuckets, initializeUsdtSystem, sendTrialToValidUsers };
