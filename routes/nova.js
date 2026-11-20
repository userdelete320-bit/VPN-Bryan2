'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../supabase');

const router = express.Router();

function isCloudflareAccountId(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value.trim());
}

function providerConfiguration() {
  const selected = new Set(getProviderOrder());
  return {
    openrouter: selected.has('openrouter') && Boolean(process.env.OPENROUTER_API_KEY),
    zai: selected.has('zai') && Boolean(process.env.ZAI_API_KEY),
    novita: selected.has('novita') && Boolean(process.env.NOVITA_API_KEY),
    cloudflare: selected.has('cloudflare') && Boolean(process.env.CLOUDFLARE_API_TOKEN && isCloudflareAccountId(process.env.CLOUDFLARE_ACCOUNT_ID)),
  };
}

// Privacy-first routing: Cloudflare Workers AI is the only default provider.
// Other providers run only when explicitly listed, e.g. cloudflare,openrouter.
function getProviderOrder() {
  const allowed = new Set(['cloudflare', 'openrouter', 'zai', 'novita']);
  const configured = String(process.env.NOVA_PROVIDER_ORDER || 'cloudflare');
  const order = [...new Set(configured.split(',').map(item => item.trim().toLowerCase()).filter(item => allowed.has(item)))];
  return order.length ? order : ['cloudflare'];
}

function getAvailableProviderOrder(providers = providerConfiguration()) {
  return getProviderOrder().filter(name => providers[name] === true);
}

router.get('/status', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const providers = providerConfiguration();
  res.json({
    enabled: process.env.NOVA_ENABLED === 'true' && getAvailableProviderOrder(providers).length > 0,
    providers,
  });
});

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_OPENROUTER_MODELS = ['baidu/ernie-5.5-flash-preview:free'];
const ZAI_URL = 'https://api.z.ai/api/paas/v4/chat/completions';
const ZAI_MODEL = 'glm-4.7-flash';
const NOVITA_URL = 'https://api.novita.ai/v3/openai/chat/completions';
const NOVITA_MODEL = 'apodex/apodex-1.1-mini';
const CLOUDFLARE_MODEL = '@cf/ibm-granite/granite-4.0-h-micro';
const CLOUDFLARE_MAX_OUTPUT_TOKENS = 600;
const CLOUDFLARE_TIMEOUT_MS = 35_000;

function getOpenRouterFreeModels() {
  // Supports both the new comma-separated variable and the old single-model variable.
  // Some dashboards paste the full KEY=value line into the value field; strip that prefix.
  const configured = process.env.NOVA_OPENROUTER_MODELS || process.env.NOVA_OPENROUTER_MODEL || '';
  let raw = String(configured).trim().replace(/^\uFEFF/, '');
  const stripQuotes = value => String(value || '').trim()
    .replace(/^(?:\"([\s\S]*)\"|'([\s\S]*)')$/, (_match, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted ?? '')
    .trim();
  const stripAssignment = value => stripQuotes(stripQuotes(value)
    .replace(/^NOVA_OPENROUTER_MODELS?\s*=\s*/i, ''));
  raw = stripAssignment(raw);

  const requested = raw
    ? raw.split(',').map(stripAssignment).filter(Boolean)
    : [...DEFAULT_OPENROUTER_MODELS];
  const freeModelPattern = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/i;
  const unique = [];
  for (const model of requested) {
    // Only accept explicit free variants. The request also carries a hard $0 price ceiling.
    if (!freeModelPattern.test(model)) continue;
    if (!unique.includes(model)) unique.push(model);
    if (unique.length >= 8) break;
  }

  if (!unique.length) {
    console.warn('[NOVA] NOVA_OPENROUTER_MODELS no contiene IDs :free válidos; se usará el modelo gratuito predeterminado.');
    return [...DEFAULT_OPENROUTER_MODELS];
  }
  return unique;
}
const MAX_MESSAGE_CHARS = 1200;
const MAX_HISTORY_MESSAGES = 8;
const USER_RPM_LIMIT = 6;
const MAX_CONCURRENT_REQUESTS = 8;
const MAX_OUTPUT_TOKENS = 900;
function getOpenRouterAttemptLimit() {
  return Math.min(3, Math.max(1, Number.parseInt(process.env.NOVA_OPENROUTER_MAX_MODEL_ATTEMPTS_PER_MESSAGE || '2', 10) || 2));
}
const PROVIDER_TIMEOUT_MS = 15_000;

// OpenRouter Free: 20 RPM / 50 RPD. Keep a local margin and never raise above the published caps.
const OPENROUTER_DAILY_LIMIT = Math.min(50, Math.max(1, Number.parseInt(process.env.NOVA_OPENROUTER_DAILY_LIMIT || '45', 10) || 45));
const OPENROUTER_RPM_LIMIT = Math.min(20, Math.max(1, Number.parseInt(process.env.NOVA_OPENROUTER_RPM_LIMIT || '18', 10) || 18));
// Cloudflare Workers AI Free: 10,000 neurons/day. Reserve only 7,500 locally as a safety margin.
const CLOUDFLARE_DAILY_NEURON_LIMIT = Math.min(9500, Math.max(1000, Number.parseInt(process.env.NOVA_CLOUDFLARE_DAILY_NEURON_LIMIT || '8500', 10) || 8500));
const CREATOR_MENTION_TTL_MS = 24 * 60 * 60 * 1000;

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, '..', 'NOVA_MASTER_PROMPT.md'), 'utf8').trim();

function computeSubscriptionStatus(user, payments) {
  if (!user?.vip) return { status: 'no_vip', days_remaining: null, expires_at: null };
  if (!user.plan) return { status: 'vigencia_no_verificable', reason: 'El registro del cliente no contiene un plan actual.', days_remaining: null, expires_at: null };

  const planKey = String(user.plan).toLowerCase();
  const approvedForCurrentPlan = (payments || []).filter(payment =>
    String(payment.plan || '').toLowerCase() === planKey && payment.status === 'approved'
  );
  const latestApprovedPayment = approvedForCurrentPlan[0] || null;
  const latestDeliveredPayment = approvedForCurrentPlan.find(payment =>
    payment.config_sent === true && Boolean(payment.config_sent_at)
  ) || null;

  if (!latestDeliveredPayment) {
    if (latestApprovedPayment && latestApprovedPayment.config_sent !== true) {
      return {
        status: 'esperando_entrega_de_configuracion',
        reason: 'El pago aprobado más reciente de este plan aún no figura con configuración entregada.',
        days_remaining: null,
        expires_at: null,
      };
    }
    return {
      status: 'vigencia_no_verificable',
      reason: 'No se encontró una entrega de configuración verificable para el plan actual en los pagos consultados.',
      days_remaining: null,
      expires_at: null,
    };
  }

  // La tabla consultada no aporta una duración de plan confirmada. No se calcula
  // vencimiento con constantes ni datos del código.
  return {
    status: 'configuracion_entregada_vigencia_no_calculable',
    starts_at: latestDeliveredPayment.config_sent_at,
    reason: 'La base de datos confirma la entrega de la configuración, pero no contiene una duración confirmada para calcular el vencimiento.',
    latest_approved_payment_waiting_for_configuration: Boolean(latestApprovedPayment && latestApprovedPayment !== latestDeliveredPayment),
    days_remaining: null,
    expires_at: null,
  };
}

function formatPaymentForNova(payment) {
  const methods = {
    transfer: 'Transferencia', metropolitan: 'Metropolitana', mitransfer: 'MiTransfer',
    mobile: 'Saldo móvil', usdt: 'USDT', ton: 'TON', paypal: 'PayPal',
    zelle: 'Zelle', stars: 'Telegram Stars',
  };
  const statuses = { pending: 'pendiente', approved: 'aprobado', rejected: 'rechazado', completed: 'completado' };
  const plan = String(payment.plan || '');
  return {
    plan: plan || null,
    price: payment.price ?? null,
    original_price_before_backend_discount: payment.original_price ?? null,
    currency: payment.method === 'usdt' ? 'USDT' : payment.method === 'ton' ? 'TON' : ['paypal', 'zelle'].includes(payment.method) ? 'USD' : payment.method === 'mobile' ? 'saldo móvil' : payment.method === 'stars' ? 'Telegram Stars' : 'CUP',
    payment_method: methods[payment.method] || payment.method || 'No especificado',
    status: statuses[payment.status] || payment.status || 'No especificado',
    created_at: payment.created_at || null,
    approved_at: payment.approved_at || null,
    rejected_at: payment.rejected_at || null,
    config_sent: payment.config_sent === true,
    config_sent_at: payment.config_sent_at || null,
  };
}

function summarizeReferralRows(rows, available = true) {
  if (!available) return { available: false, reason: 'La tabla de referidos no pudo consultarse; no equivale a cero referidos.' };
  const safeRows = Array.isArray(rows) ? rows : [];
  const summarizeLevel = (level) => {
    const levelRows = safeRows.filter(row => Number(row.level) === level);
    return {
      total: levelRows.length,
      paid: levelRows.filter(row => row.has_paid === true).length,
    };
  };
  const level1 = summarizeLevel(1);
  const level2 = summarizeLevel(2);
  return {
    available: true,
    level1,
    level2,
    total_referrals: level1.total + level2.total,
    total_paid: level1.paid + level2.paid,
    discount_tracking_available: false,
    discount_note: 'Se pueden confirmar las cantidades de referidos y los que han pagado, pero la tabla actual no permite verificar si los descuentos ya fueron utilizados. No se calcula un descuento disponible.',
    privacy_note: 'Solo agregados propios; no se incluyen nombres, usuarios ni Telegram ID de los referidos.',
  };
}

function buildNovaDatabaseContext(customerSnapshot, planCatalog, now = Date.now()) {
  const user = customerSnapshot?.user || null;
  const payments = Array.isArray(customerSnapshot?.payments) ? customerSnapshot.payments : [];
  const coverage = customerSnapshot?.coverage || {};
  const account = user ? {
    registered: true,
    telegram_bot_contact: user.is_active === false ? 'no_puede_recibir_mensajes_segun_el_campo_is_active' : user.is_active === true ? 'puede_recibir_mensajes_segun_el_campo_is_active' : 'no_especificado',
    vip: user.vip === true,
    current_plan: user.plan || null,
    stored_plan_price: user.plan_price ?? null,
    vip_since: user.vip_since || null,
    subscription: computeSubscriptionStatus(user, payments),
    speed_download: user.speed_download ?? null,
    speed_upload: user.speed_upload ?? null,
    trial: {
      history_available: coverage.trial_history !== false,
      requested: user.trial_requested === true,
      received: user.trial_received === true,
      requested_at: user.trial_requested_at || null,
      sent_at: user.trial_sent_at || null,
      type: user.trial_plan_type || null,
      history: (customerSnapshot?.trial_history || []).slice(0, 12),
    },
    loyalty: {
      xp: user.xp ?? null,
      recent_activity_available: coverage.xp_log !== false,
      claimed_rewards: Array.isArray(user.claimed_rewards) ? user.claimed_rewards : [],
      recent_xp_activity: (customerSnapshot?.xp_log || []).slice(0, 10),
    },
    referred_by_someone: Boolean(user.referrer_id),
    referral_discount_stored: user.referral_discount ?? null,
  } : { registered: false, message: 'No se encontró un perfil de cliente con el ID autenticado.' };

  const availability = planCatalog?.availability && typeof planCatalog.availability === 'object'
    ? planCatalog.availability
    : null;
  const plans = (planCatalog?.prices || []).map(row => {
    const key = String(row.plan || '');
    return {
      plan: key,
      prices: {
        CUP: row.cup ?? null,
        saldo_movil: row.mobile ?? null,
        USDT: row.usdt ?? null,
        Telegram_Stars: row.stars ?? null,
        TON: row.ton ?? null,
      },
      availability: availability && typeof availability[key] === 'boolean'
        ? (availability[key] ? 'agotado' : 'disponible')
        : 'no_confirmada_en_base_de_datos',
      updated_at: row.updated_at || null,
    };
  });

  const referrals = summarizeReferralRows(customerSnapshot?.referrals || [], coverage.referrals !== false);
  const referralWalletRaw = customerSnapshot?.referral_wallet || null;
  const referralWallet = referralWalletRaw ? {
    available: true,
    available_balance_usdt: referralWalletRaw.available_balance ?? null,
    pending_balance_usdt: referralWalletRaw.pending_balance ?? null,
  } : { available: coverage.referral_wallet === true, reason: coverage.referral_wallet === true ? 'La función devolvió un saldo vacío.' : 'El monedero de referidos no pudo consultarse.' };

  const reseller = customerSnapshot?.reseller || null;
  const resellerSales = Array.isArray(customerSnapshot?.reseller_sales) ? customerSnapshot.reseller_sales : [];
  const resellerWithdrawals = Array.isArray(customerSnapshot?.reseller_withdrawals) ? customerSnapshot.reseller_withdrawals : [];
  const resellerData = reseller ? {
    available: coverage.resellers !== false,
    registered: true,
    status: reseller.status || null,
    sales_count_recorded: reseller.sales_count ?? null,
    month_sales_recorded: reseller.month_sales ?? null,
    earnings_available: reseller.earnings_available ?? null,
    pending_withdraw: reseller.pending_withdraw ?? null,
    total_withdrawn: reseller.total_withdrawn ?? null,
    client_count_available: coverage.reseller_clients !== false,
    client_count: coverage.reseller_clients !== false ? (customerSnapshot?.reseller_client_count ?? null) : null,
    sales_history_available: coverage.reseller_sales !== false,
    own_sales_count_in_history: coverage.reseller_sales !== false ? resellerSales.length : null,
    own_commission_sum_from_history: coverage.reseller_sales !== false ? resellerSales.reduce((sum, row) => sum + Number(row.commission || 0), 0) : null,
    withdrawals_history_available: coverage.reseller_withdrawals !== false,
    own_withdrawals: coverage.reseller_withdrawals !== false ? resellerWithdrawals.map(row => ({ amount: row.amount ?? null, status: row.status || null, requested_at: row.requested_at || null, resolved_at: row.resolved_at || null })) : null,
    config_available: coverage.reseller_config !== false,
    config: customerSnapshot?.reseller_config || null,
    privacy_note: 'No se incluyen identidades ni datos de clientes del revendedor.',
  } : coverage.resellers === false
    ? { available: false, registered: null, reason: 'No se pudo consultar el estado de revendedor.' }
    : { available: true, registered: false };

  const topups = (customerSnapshot?.shop_topups || []).slice(0, 10).map(row => ({
    amount_usd: row.amount_usd ?? null,
    currency: row.currency || null,
    network: row.network || null,
    status: row.status || null,
    requested_at: row.requested_at || null,
    confirmed_at: row.confirmed_at || null,
  }));
  const orders = (customerSnapshot?.shop_orders || []).slice(0, 10).map(row => ({
    product: row.shop_products?.name || row.product_name || 'Producto digital',
    source: row.source || null,
    quantity: row.qty ?? null,
    amount_usd: row.price_charged_usd ?? null,
    status: row.status || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  }));
  const nowDate = new Date(now);
  const rawAnnouncement = customerSnapshot?.announcement || null;
  const announcementStart = rawAnnouncement?.starts_at ? Date.parse(rawAnnouncement.starts_at) : null;
  const announcementEnd = rawAnnouncement?.ends_at ? Date.parse(rawAnnouncement.ends_at) : null;
  const announcementActive = Boolean(rawAnnouncement?.active)
    && (announcementStart == null || !Number.isFinite(announcementStart) || now >= announcementStart)
    && (announcementEnd == null || !Number.isFinite(announcementEnd) || now <= announcementEnd);
  const announcement = announcementActive ? {
    active: true,
    text: redactSensitiveInfo(rawAnnouncement.text || '').slice(0, 1200),
    starts_at: rawAnnouncement.starts_at || null,
    ends_at: rawAnnouncement.ends_at || null,
  } : { active: false };
  const rawPopup = customerSnapshot?.popup_announcement || null;
  const popupAnnouncement = rawPopup?.enabled ? {
    active: true,
    title: redactSensitiveInfo(rawPopup.title || '').slice(0, 160),
    message: redactSensitiveInfo(rawPopup.message || '').slice(0, 1200),
  } : { active: false };

  const tickets = (customerSnapshot?.support_tickets || []).slice(0, 8).map(ticket => ({
    id: ticket.id ?? null,
    category: ticket.category || null,
    subject: redactSensitiveInfo(ticket.subject || '').slice(0, 180),
    status: ticket.status || null,
    created_at: ticket.created_at || null,
    updated_at: ticket.updated_at || null,
    recent_messages: (customerSnapshot?.support_threads?.[String(ticket.id)] || []).slice(-5).map(message => ({
      sender: message.sender_type === 'admin' ? 'soporte' : 'cliente',
      message: redactSensitiveInfo(message.message || '').slice(0, 500),
      created_at: message.created_at || null,
    })),
  }));

  return {
    source: 'lectura_en_tiempo_real_de_supabase',
    generated_at: new Date(now).toISOString(),
    access_scope: 'Datos privados limitados al telegram_id autenticado; los datos generales son públicos y permitidos.',
    data_coverage: coverage,
    customer_account: account,
    recent_payments: payments.slice(0, 8).map(formatPaymentForNova),
    referrals: {
      ...referrals,
      wallet: referralWallet,
      coupon_usage_available: coverage.coupon_usage !== false,
      recent_coupon_usage: (customerSnapshot?.coupon_usage || []).slice(0, 10).map(row => ({
        coupon_code: row.coupon_code || null,
        discount_applied: row.discount_applied ?? null,
        used_at: row.used_at || null,
      })),
    },
    shop: {
      balance_available: coverage.shop_balances !== false,
      topups_available: coverage.shop_topups !== false,
      orders_available: coverage.shop_orders !== false,
      products_catalog_available: coverage.shop_products !== false,
      coupons_catalog_available: coverage.coupons !== false,
      balance_record_found: Boolean(customerSnapshot?.shop_balance),
      balance_usd: customerSnapshot?.shop_balance?.balance_usd ?? null,
      balance_updated_at: customerSnapshot?.shop_balance?.updated_at || null,
      recent_topups: topups,
      recent_orders: orders,
      active_products: (customerSnapshot?.shop_products || []).slice(0, 30).map(row => ({
        name: row.name || null,
        description: redactSensitiveInfo(row.description || '').slice(0, 500),
        instructions: redactSensitiveInfo(row.instructions || '').slice(0, 500),
        price_usd: row.final_price_usd ?? null,
        stock: row.stock ?? null,
        min_qty: row.min_qty ?? null,
        max_qty: row.max_qty ?? null,
      })),
      active_coupons: (customerSnapshot?.active_coupons || []).slice(0, 20).map(row => ({
        code: row.code || null,
        discount: row.discount ?? null,
        stock: row.stock ?? null,
        expiry: row.expiry || null,
        description: redactSensitiveInfo(row.description || '').slice(0, 300),
      })),
    },
    company_announcements: {
      announcements_available: coverage.announcements !== false,
      current_announcement: announcement,
      popup_announcement_available: coverage.popup_announcement !== false,
      current_popup: popupAnnouncement,
    },
    support: { available: coverage.support_tickets !== false, own_tickets: tickets },
    reseller_program: resellerData,
    customer_relationships: {
      linked_to_a_reseller_available: coverage.linked_to_reseller !== false,
    linked_to_a_reseller: coverage.linked_to_reseller !== false ? Boolean(customerSnapshot?.linked_to_reseller) : null,
    },
    privacy: {
      no_other_customers: true,
      no_referral_identity_data: true,
      no_reseller_client_identity_data: true,
      no_payment_screenshots_notes_txids_wallet_addresses_or_vpn_config_files: true,
    },
    live_plan_catalog: {
      prices_source_table: 'plan_prices',
      availability_source_table: 'settings',
      availability_available: Boolean(availability),
      plans,
    },
  };
}

const requestBuckets = new Map();
const creatorMentionedUsers = new Map();
let openRouterQuota = { day: new Date().toISOString().slice(0, 10), requests: 0, minute: Math.floor(Date.now() / 60_000), requestsThisMinute: 0 };
const openRouterModelCooldowns = new Map();
const OPENROUTER_MODEL_COOLDOWN_MS = 5 * 60_000;
const OPENROUTER_INVALID_MODEL_COOLDOWN_MS = 60 * 60_000;
const OPENROUTER_INVALID_RESPONSE_COOLDOWN_MS = 5 * 60_000;
let openRouterModelCursor = 0;
let cloudflareQuota = { day: new Date().toISOString().slice(0, 10), neurons: 0 };
let activeRequests = 0;

function consumeBucket(key, limit, windowMs, now = Date.now()) {
  const current = requestBuckets.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    requestBuckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

function estimateInputTokens(systemPrompt, messages) {
  const characters = systemPrompt.length + messages.reduce((sum, item) => sum + item.content.length, 0);
  // Conservative character/token estimate used only for local Cloudflare free-quota protection.
  return Math.ceil(characters / 2.6);
}

function reserveOpenRouterRequest(now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  const minute = Math.floor(now / 60_000);
  if (openRouterQuota.day !== today) {
    openRouterQuota = { day: today, requests: 0, minute, requestsThisMinute: 0 };
  }
  if (openRouterQuota.minute !== minute) {
    openRouterQuota.minute = minute;
    openRouterQuota.requestsThisMinute = 0;
  }
  if (openRouterQuota.requests >= OPENROUTER_DAILY_LIMIT) return 'OPENROUTER_DAILY_LIMIT';
  if (openRouterQuota.requestsThisMinute >= OPENROUTER_RPM_LIMIT) return 'OPENROUTER_RPM_LIMIT';
  // Failed attempts count against OpenRouter's daily allowance too, so reserve before sending.
  openRouterQuota.requests += 1;
  openRouterQuota.requestsThisMinute += 1;
  return null;
}

function estimateCloudflareNeurons(inputTokens, outputTokens = CLOUDFLARE_MAX_OUTPUT_TOKENS) {
  // Cloudflare's published Granite 4.0 H Micro rates: 1,542 neurons/M input
  // tokens and 10,158 neurons/M output tokens. Apply a 1.5x margin because
  // the character-based input estimate is not the provider's authoritative counter.
  return Math.ceil(((inputTokens * 1542) + (outputTokens * 10158)) / 1_000_000 * 1.5);
}

function reserveCloudflareNeurons(inputTokens, outputTokens = MAX_OUTPUT_TOKENS, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  if (cloudflareQuota.day !== today) cloudflareQuota = { day: today, neurons: 0 };
  const reserve = estimateCloudflareNeurons(inputTokens, outputTokens);
  if (cloudflareQuota.neurons + reserve > CLOUDFLARE_DAILY_NEURON_LIMIT) return { error: 'CLOUDFLARE_DAILY_NEURON_LIMIT', reserve };
  // Failed attempts are counted conservatively because they may still consume inference quota.
  cloudflareQuota.neurons += reserve;
  return { error: null, reserve };
}

function extractAssistantText(payload) {
  const choice = payload?.choices?.[0];
  const message = choice?.message || {};
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      // Read only user-facing text blocks. Never expose a provider's hidden reasoning.
      const type = String(part?.type || '').toLowerCase();
      return typeof part?.text === 'string' && (!type || type === 'text' || type === 'output_text') ? part.text : '';
    }).join('').trim();
  }
  if (typeof message.output_text === 'string') return message.output_text.trim();
  if (typeof choice?.text === 'string') return choice.text.trim();
  if (typeof payload?.result?.response === 'string') return payload.result.response.trim();
  if (typeof payload?.response === 'string') return payload.response.trim();
  return '';
}

function getSafeCompletionDiagnostic(payload) {
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const usage = payload?.usage || {};
  const completionDetails = usage.completion_tokens_details || {};
  const content = message.content;
  const contentType = content === null ? 'null' : Array.isArray(content) ? 'array' : typeof content;
  const contentLength = typeof content === 'string' ? content.length
    : Array.isArray(content) ? content.reduce((sum, part) => sum + (typeof part?.text === 'string' ? part.text.length : typeof part === 'string' ? part.length : 0), 0)
    : 0;
  const allowedKeys = ['content', 'reasoning', 'reasoning_content', 'reasoning_details', 'refusal', 'tool_calls'];
  const messageKeys = Object.keys(message).filter(key => allowedKeys.includes(key)).join(',') || 'none';
  const finishReason = cleanProviderDiagnostic(choice.finish_reason || 'missing', 40);
  const outputTokens = Number(usage.completion_tokens || 0);
  const reasoningTokens = Number(completionDetails.reasoning_tokens || 0);
  return {
    finishReason,
    contentType,
    contentLength,
    messageKeys,
    reasoningPresent: Boolean(message.reasoning || message.reasoning_content || message.reasoning_details),
    refusalPresent: Boolean(message.refusal),
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
    outputTokens,
    reasoningTokens,
  };
}

function formatCompletionDiagnostic(info) {
  return `finish_reason=${info.finishReason}, content=${info.contentType}/${info.contentLength} chars, output_tokens=${info.outputTokens}, reasoning_tokens=${info.reasoningTokens}, message_keys=${info.messageKeys}, refusal=${info.refusalPresent}, tool_calls=${info.toolCalls}`;
}

function getOpenRouterModelOptions(model) {
  // These model families document a per-request reasoning switch. Disable it for
  // short customer-support turns so the output budget is reserved for visible text.
  if (model === 'baidu/ernie-5.5-flash-preview:free'
    || model === 'inclusionai/ling-3.2-flash:free'
    || model === 'dots-studio/dots-3-note-preview:free'
    || model.startsWith('google/gemma-4-')) {
    return { reasoning: { enabled: false } };
  }
  return {};
}

function cleanProviderDiagnostic(value, maxLength = 120) {
  return String(value || '')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/(?:sk-or-v1-|sk_live_|sk_|cfat_|vex_sk_|qamify_|WAR_)[A-Za-z0-9._-]+/gi, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, maxLength);
}

function getSafeProviderError(payload, response = null) {
  const errorObject = payload?.error && typeof payload.error === 'object' ? payload.error : payload;
  const rawCode = errorObject?.code ?? errorObject?.type ?? payload?.code ?? null;
  const rawMessage = (typeof payload?.error === 'string' ? payload.error : null)
    ?? errorObject?.message ?? payload?.message
    ?? (Array.isArray(payload?.errors) ? payload.errors.map(item => item?.message || item?.code).filter(Boolean).join('; ') : '');
  const metadata = errorObject?.metadata || payload?.metadata || {};
  const metadataHeaders = metadata?.headers || {};
  const getHeader = name => metadataHeaders[name] ?? metadataHeaders[name.toLowerCase()] ?? response?.headers?.get?.(name) ?? null;
  // OpenRouter's 429 can be our free-tier cap or an upstream model-provider limit.
  // Preserve the source/reset hints without dumping the full error payload into logs.
  return {
    code: rawCode == null ? null : cleanProviderDiagnostic(rawCode, 60),
    message: cleanProviderDiagnostic(rawMessage, 240),
    limitSource: cleanProviderDiagnostic(metadata?.limit_source, 80),
    upstreamProvider: cleanProviderDiagnostic(metadata?.provider_name, 80),
    remedyHint: cleanProviderDiagnostic(metadata?.remedy_hint, 120),
    retryAfter: cleanProviderDiagnostic(getHeader('Retry-After'), 40),
    rateLimitReset: cleanProviderDiagnostic(getHeader('X-RateLimit-Reset'), 40),
  };
}

async function sendChatCompletion({ providerName, url, apiKey, messages, body, extraHeaders = {}, timeoutMs = PROVIDER_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify({ ...body, messages, stream: false }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const diagnostic = getSafeProviderError(payload, response);
      const detail = [
        diagnostic.code && `código ${diagnostic.code}`,
        diagnostic.message,
        diagnostic.limitSource && `origen ${diagnostic.limitSource}`,
        diagnostic.upstreamProvider && `proveedor ${diagnostic.upstreamProvider}`,
        diagnostic.retryAfter && `Retry-After ${diagnostic.retryAfter}s`,
        diagnostic.rateLimitReset && `reset ${diagnostic.rateLimitReset}`,
        diagnostic.remedyHint && `indicación ${diagnostic.remedyHint}`,
      ].filter(Boolean).join(' — ');
      console.warn(`[NOVA] ${providerName} devolvió HTTP ${response.status}${detail ? ` (${detail})` : ' (sin detalle de error en la respuesta)'}.`);
      return {
        ok: false,
        kind: response.status === 429 ? 'rate_limit' : response.status === 401 || response.status === 403 ? 'authentication_error' : 'http_error',
        status: response.status,
        providerCode: diagnostic.code,
        limitSource: diagnostic.limitSource,
        upstreamProvider: diagnostic.upstreamProvider,
      };
    }
    const reply = extractAssistantText(payload);
    if (!reply) {
      const diagnostic = getSafeCompletionDiagnostic(payload);
      console.warn(`[NOVA] ${providerName} devolvió HTTP 200 sin texto final (${formatCompletionDiagnostic(diagnostic)}).`);
      return { ok: false, kind: 'invalid_response', responseDiagnostic: diagnostic };
    }
    if (looksLikeNonSpanishReply(reply)) {
      const diagnostic = getSafeCompletionDiagnostic(payload);
      console.warn(`[NOVA] ${providerName} devolvió texto en un idioma no permitido (${formatCompletionDiagnostic(diagnostic)}).`);
      return { ok: false, kind: 'invalid_language_response', responseDiagnostic: diagnostic };
    }
    return { ok: true, reply, usage: payload?.usage || null, provider: providerName };
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    console.warn(`[NOVA] ${providerName}: ${timedOut ? 'tiempo de espera agotado' : 'error de conexión'}.`);
    return { ok: false, kind: timedOut ? 'timeout' : 'connection_error' };
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenRouter(messages) {
  if (!process.env.OPENROUTER_API_KEY) return { ok: false, kind: 'not_configured' };

  const extraHeaders = { 'X-Title': process.env.OPENROUTER_APP_NAME || 'VPN CUBA NOVA' };
  if (process.env.OPENROUTER_SITE_URL) extraHeaders['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL;
  const models = getOpenRouterFreeModels();
  const attempted = [];
  const startIndex = openRouterModelCursor % models.length;
  const orderedModels = models.slice(startIndex).concat(models.slice(0, startIndex));
  let modelAttempts = 0;

  for (const model of orderedModels) {
    if (modelAttempts >= getOpenRouterAttemptLimit()) break;
    const cooldownUntil = openRouterModelCooldowns.get(model) || 0;
    if (cooldownUntil > Date.now()) continue;
    if (cooldownUntil) openRouterModelCooldowns.delete(model);

    const quotaError = reserveOpenRouterRequest();
    if (quotaError) return { ok: false, kind: 'local_limit', code: quotaError, attempted };
    modelAttempts += 1;

    const result = await sendChatCompletion({
      providerName: `OpenRouter ${model}`,
      url: OPENROUTER_URL,
      apiKey: process.env.OPENROUTER_API_KEY,
      messages,
      extraHeaders,
      body: {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.25,
        ...getOpenRouterModelOptions(model),
        // Hard ceiling: OpenRouter may only select endpoints with $0 input AND $0 output.
        provider: {
          allow_fallbacks: true,
          max_price: { prompt: 0, completion: 0 },
        },
      },
    });

    const modelIndex = models.indexOf(model);
    openRouterModelCursor = (modelIndex + 1) % models.length;
    if (result.ok) {
      openRouterModelCooldowns.delete(model);
      return { ...result, provider: 'OpenRouter', model };
    }

    attempted.push({ model, kind: result.kind, status: result.status || null });
    // Avoid hammering the same exhausted shared provider on every customer turn.
    if (result.status === 400 || result.status === 404) {
      openRouterModelCooldowns.set(model, Date.now() + OPENROUTER_INVALID_MODEL_COOLDOWN_MS);
    } else if (result.status === 429 && String(result.limitSource || '').startsWith('upstream_provider')) {
      const retrySeconds = Number.parseInt(result.retryAfter || '', 10);
      const cooldown = Number.isFinite(retrySeconds) && retrySeconds > 0
        ? Math.max(OPENROUTER_MODEL_COOLDOWN_MS, retrySeconds * 1000)
        : OPENROUTER_MODEL_COOLDOWN_MS;
      openRouterModelCooldowns.set(model, Date.now() + cooldown);
    } else if (result.status >= 500 || result.kind === 'timeout' || result.kind === 'connection_error'
      || result.kind === 'invalid_response' || result.kind === 'invalid_language_response') {
      openRouterModelCooldowns.set(model, Date.now() + OPENROUTER_INVALID_RESPONSE_COOLDOWN_MS);
    }
    // A documented OpenRouter-wide 429 applies to the whole free account, not one model.
    // Stop model rotation in that case so we do not burn the remaining daily request quota.
    if (result.status === 429 && String(result.limitSource || '').startsWith('openrouter_')) {
      return { ...result, attempted };
    }
    // Authentication errors affect the shared OpenRouter key, not this individual model.
    if (result.kind === 'authentication_error') return { ...result, attempted };
  }

  if (!attempted.length) return { ok: false, kind: 'models_in_cooldown', attempted };
  const allRateLimited = attempted.every(item => item.kind === 'rate_limit');
  return { ok: false, kind: allRateLimited ? 'rate_limit' : 'models_unavailable', status: allRateLimited ? 429 : 503, attempted };
}

// GLM Flash free accounts can enforce a very low concurrent-request limit.
// Serialize Z.AI calls per process so simultaneous Telegram messages do not
// unnecessarily trigger its 429 concurrency limit.
let zaiRequestQueue = Promise.resolve();
async function callZai(messages) {
  if (!process.env.ZAI_API_KEY) return { ok: false, kind: 'not_configured' };
  const run = async () => {
    const request = () => sendChatCompletion({
      providerName: 'Z.AI GLM-4.7-Flash',
      url: ZAI_URL,
      apiKey: process.env.ZAI_API_KEY,
      messages,
      body: {
        model: ZAI_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.25,
      },
    });
    let result = await request();
    // Z.AI code 1305 is transient provider overload. Retry once after a brief pause;
    // do not loop indefinitely or retry ordinary authentication/quota errors.
    if (result.status === 429 && result.providerCode === '1305') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      result = await request();
    }
    return result;
  };
  const pending = zaiRequestQueue.then(run, run);
  zaiRequestQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

async function callNovita(messages) {
  if (!process.env.NOVITA_API_KEY) return { ok: false, kind: 'not_configured' };
  return sendChatCompletion({
    providerName: 'Novita Apodex 1.1 Mini',
    url: NOVITA_URL,
    apiKey: process.env.NOVITA_API_KEY,
    messages,
    body: {
      model: NOVITA_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.25,
    },
  });
}

async function callCloudflare(messages, estimatedInputTokens) {
  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID } = process.env;
  if (!CLOUDFLARE_API_TOKEN || !isCloudflareAccountId(CLOUDFLARE_ACCOUNT_ID)) return { ok: false, kind: 'not_configured' };
  const quota = reserveCloudflareNeurons(estimatedInputTokens, CLOUDFLARE_MAX_OUTPUT_TOKENS);
  if (quota.error) return { ok: false, kind: 'local_limit', code: quota.error };
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`;
  return sendChatCompletion({
    providerName: 'Cloudflare Workers AI · IBM Granite 4.0 H Micro',
    url,
    apiKey: CLOUDFLARE_API_TOKEN,
    messages,
    timeoutMs: CLOUDFLARE_TIMEOUT_MS,
    body: {
      model: CLOUDFLARE_MODEL,
      max_tokens: CLOUDFLARE_MAX_OUTPUT_TOKENS,
      temperature: 0.25,
    },
  });
}

async function callConfiguredProviders(messages, estimatedInputTokens) {
  const attempts = [];
  const providers = providerConfiguration();
  const order = getAvailableProviderOrder(providers);

  // Default: Cloudflare only. Additional providers are opt-in through NOVA_PROVIDER_ORDER.
  // This prevents customer data from being sent to OpenRouter/Z.AI/Novita unexpectedly.
  for (const provider of order) {
    let result;
    if (provider === 'cloudflare') result = await callCloudflare(messages, estimatedInputTokens);
    else if (provider === 'openrouter') result = await callOpenRouter(messages);
    else if (provider === 'zai') result = await callZai(messages);
    else if (provider === 'novita') result = await callNovita(messages);
    else continue;

    if (result.ok) return result;
    attempts.push({ provider, ...result });
    // A Cloudflare-only setup must fail promptly and transparently; it must not
    // silently switch to a third party when its preferred private provider fails.
  }

  const allLimited = attempts.length > 0 && attempts.every(item => item.kind === 'local_limit' || item.kind === 'rate_limit');
  return { ok: false, kind: allLimited ? 'all_limited' : 'all_unavailable', attempts };
}

function hasCreatorBeenMentioned(userId, now = Date.now()) {
  const timestamp = creatorMentionedUsers.get(userId);
  if (!timestamp) return false;
  if (now - timestamp > CREATOR_MENTION_TTL_MS) {
    creatorMentionedUsers.delete(userId);
    return false;
  }
  return true;
}

function customerRaisedCreatorTopic(text) {
  const value = String(text || '').toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const asksWhoCreatedNova = /\bquien(?:es)?\s+(?:te\s+)?(?:creo|crearon|desarrollo|desarrollaron|programo|programaron|diseno|disenaron|hizo|hicieron|construyo|construyeron)\b/.test(value)
    || /\bquien(?:es)?\b[\s\S]{0,40}\b(?:creador|creadora|desarrollador|desarrolladora|programador|programadora|autor|autora)\b[\s\S]{0,40}\b(?:de\s+)?(?:nova|ti|esta ia|este asistente|el asistente)\b/.test(value)
    || /\b(?:tu|tuyo|tuya)\s+(?:creador|creadora|desarrollador|desarrolladora|programador|programadora|autor|autora)\b/.test(value)
    || /\bquien(?:es)?\s+(?:esta|estan)\s+detras\s+de\s+(?:ti|nova|el proyecto)\b/.test(value)
    || /\bquien\s+se\s+encargo\s+de\s+(?:tu\s+)?(?:desarrollo|creacion|programacion)\b/.test(value)
    || /\basche\s+synthesis\s+one\b/.test(value);
  const asksHowToCreateOwnAI = /\b(?:quiero|quisiera|me interesa|me gustaria|estoy interesado|como puedo|como se puede)\b[\s\S]{0,100}\b(?:crear|desarrollar|programar|hacer|montar)\b[\s\S]{0,80}\b(?:mi propia|una|mi)\s+(?:ia|inteligencia artificial|asistente virtual)\b/.test(value)
    || /\b(?:crear|desarrollar|programar|hacer|montar)\b[\s\S]{0,60}\bmi propia\s+(?:ia|inteligencia artificial|asistente virtual)\b/.test(value)
    || /\b(?:ia|inteligencia artificial)\b[\s\S]{0,60}\b(?:quiero crear|quiero desarrollar|me interesa crear|me gustaria crear)\b/.test(value);
  return asksWhoCreatedNova || asksHowToCreateOwnAI;
}

function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken || typeof initData !== 'string' || initData.length > 8192) return null;

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch (_) {
    return null;
  }

  const receivedHash = params.get('hash');
  const authDate = Number.parseInt(params.get('auth_date') || '', 10);
  const userRaw = params.get('user');
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash) || !Number.isFinite(authDate) || !userRaw) return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  // Reject stale data (>24h) and timestamps more than 60 seconds in the future.
  if (authDate > nowSeconds + 60 || nowSeconds - authDate > 86400) return null;

  params.delete('hash');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const providedHash = Buffer.from(receivedHash, 'hex');
  const candidates = [
    [...params.entries()],
    // Compatibility with initData variants that carry a third-party signature.
    [...params.entries()].filter(([key]) => key !== 'signature'),
  ];
  const validHash = candidates.some((entries) => {
    const dataCheckString = entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();
    return providedHash.length === calculatedHash.length && crypto.timingSafeEqual(providedHash, calculatedHash);
  });
  if (!validHash) return null;

  try {
    const user = JSON.parse(userRaw);
    if (!user || !/^\d+$/.test(String(user.id || ''))) return null;
    return { id: String(user.id) };
  } catch (_) {
    return null;
  }
}

const FOREIGN_LANGUAGE_MARKERS = [
  // Short phrases and high-signal terms for common non-Spanish inputs.
  /\b(hello|hi there|good morning|good afternoon|good evening|thank you|thanks|please help|how are you|i need|i want|can you|could you|where is|what is|how much|speak english)\b/i,
  /\b(bonjour|bonsoir|merci|s'il vous plaît|comment allez|je voudrais|j'ai besoin|parlez-vous)\b/i,
  /\b(obrigado|obrigada|bom dia|boa tarde|boa noite|tudo bem|preciso|quero|você|voce|não|nao|estou|tenho)\b/i,
  /\b(buongiorno|buonasera|grazie|per favore|come stai|vorrei|ho bisogno|non capisco)\b/i,
  /\b(guten morgen|guten tag|guten abend|danke|bitte|ich bin|ich brauche|wie geht)\b/i,
  /[\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
];

function isLikelyNonSpanish(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  return FOREIGN_LANGUAGE_MARKERS.some((pattern) => pattern.test(normalized));
}

function looksLikeNonSpanishReply(text) {
  const value = String(text || '').trim();
  if (!value) return true;
  if (/[\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value)) return true;
  return /\b(hello|how can I help|thank you for|please let me know|I can help|we only speak Spanish|I am sorry|bonjour|obrigado|como posso ajudar|je peux vous aider)\b/i.test(value);
}

function redactSensitiveInfo(text) {
  return String(text || '')
    .replace(/\[(?:Interface|Peer)\][\s\S]*?(?=(?:\r?\n\s*\[(?:Interface|Peer)\])|$)/gi, '[bloque de configuración VPN omitido]')
    .replace(/^\s*(PrivateKey|PresharedKey|PublicKey|Address|Endpoint|DNS)\s*=.*$/gim, '$1 = [dato técnico oculto]')
    .replace(/\b(?:contrase[nñ]a|clave|password|c[oó]digo de verificaci[oó]n|c[oó]digo|otp|pin|token)\b\s*(?:es|:|=)?\s*[^\s,;]{4,}/gi, '[dato sensible oculto]')
    .replace(/\b(?:Telegram\s*ID|telegram_id)\s*[:=]?\s*\d{5,20}\b/gi, 'Telegram ID [oculto]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,})\b/g, '[clave API oculta]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer [token oculto]')
    .replace(/\b0x[a-f0-9]{40,64}\b/gi, '[identificador de transacción oculto]')
    .replace(/https?:\/\/t\.me\/[^\s]+/gi, '[enlace Telegram oculto]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[correo oculto]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[número oculto]')
    .replace(/\b\d{12,19}\b/g, '[número oculto]');
}

function normalizeHistory(history, latestMessage) {
  if (!Array.isArray(history)) return [{ role: 'user', content: redactSensitiveInfo(latestMessage) }];
  const cleaned = history
    .slice(-MAX_HISTORY_MESSAGES)
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
    .map((item) => ({ role: item.role, content: redactSensitiveInfo(item.content.trim().slice(0, MAX_MESSAGE_CHARS)) }))
    .filter((item) => item.content);

  const last = cleaned[cleaned.length - 1];
  if (!last || last.role !== 'user' || last.content !== redactSensitiveInfo(latestMessage)) cleaned.push({ role: 'user', content: redactSensitiveInfo(latestMessage) });
  return cleaned.slice(-MAX_HISTORY_MESSAGES);
}

router.post('/chat', async (req, res) => {
  if (process.env.NOVA_ENABLED !== 'true') {
    return res.status(503).json({ error: 'NOVA todavía no está habilitada. Para recibir asistencia, contacta con @luvnt.', code: 'NOVA_DISABLED' });
  }

  const botToken = process.env.BOT_TOKEN;
  const telegramUser = verifyTelegramInitData(req.get('x-telegram-init-data'), botToken);
  if (!telegramUser) {
    return res.status(401).json({
      error: 'Abre VPN CUBA desde el bot oficial de Telegram para utilizar NOVA.',
      code: 'TELEGRAM_AUTH_REQUIRED',
    });
  }

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ error: 'Escribe un mensaje para NOVA.' });
  if (message.length > MAX_MESSAGE_CHARS) {
    return res.status(400).json({ error: `El mensaje no puede superar ${MAX_MESSAGE_CHARS} caracteres.` });
  }

  if (isLikelyNonSpanish(message)) {
    return res.json({
      success: true,
      reply: 'Por el momento solo puedo atenderte en español. Por favor, escríbeme en español para ayudarte.',
      languageRejected: true,
    });
  }

  const result = await generateNovaReply(telegramUser.id, message, []);
  if (!result.ok) return res.status(result.status || 503).json({ error: result.reply, code: result.code });
  return res.json({ success: true, reply: result.reply, provider: result.provider, languageRejected: Boolean(result.languageRejected) });
});

const telegramConversationHistory = new Map();
const TELEGRAM_HISTORY_TTL_MS = 30 * 60 * 1000;

async function generateNovaReply(telegramId, message, history = []) {
  const userId = String(telegramId || '').trim();
  const text = String(message || '').trim();
  if (process.env.NOVA_ENABLED !== 'true') {
    return { ok: false, status: 503, code: 'NOVA_DISABLED', reply: 'NOVA todavía no está habilitada. Contacta con @luvnt para recibir asistencia.' };
  }
  if (!/^\d+$/.test(userId)) {
    return { ok: false, status: 401, code: 'TELEGRAM_ID_INVALID', reply: 'No pude verificar tu identidad de Telegram. Abre el chat privado del bot e inténtalo nuevamente.' };
  }
  if (!text) return { ok: false, status: 400, code: 'EMPTY_MESSAGE', reply: 'Escribe una pregunta para NOVA.' };
  if (text.length > MAX_MESSAGE_CHARS) {
    return { ok: false, status: 400, code: 'MESSAGE_TOO_LONG', reply: `El mensaje no puede superar ${MAX_MESSAGE_CHARS} caracteres.` };
  }
  if (isLikelyNonSpanish(text)) {
    return { ok: true, languageRejected: true, reply: 'Por el momento solo puedo atenderte en español. Por favor, escríbeme en español para ayudarte.' };
  }

  const now = Date.now();
  if (!consumeBucket(`user:${userId}`, USER_RPM_LIMIT, 60_000, now)) {
    return { ok: false, status: 429, code: 'USER_RATE_LIMIT', reply: 'Has enviado varios mensajes seguidos. Espera un momento y vuelve a intentarlo.' };
  }
  if (!consumeBucket('nova:global-rpm', 30, 60_000, now)) {
    return { ok: false, status: 429, code: 'GLOBAL_RATE_LIMIT', reply: 'NOVA está recibiendo muchas consultas. Inténtalo de nuevo en un momento.' };
  }

  const providers = providerConfiguration();
  if (getAvailableProviderOrder(providers).length === 0) {
    return { ok: false, status: 503, code: 'NOVA_NOT_CONFIGURED', reply: 'NOVA no está configurada. Contacta con @luvnt para recibir asistencia.' };
  }
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    return { ok: false, status: 503, code: 'NOVA_BUSY', reply: 'NOVA está atendiendo otras consultas. Inténtalo de nuevo en un momento o contacta con @luvnt.' };
  }

  let customerSnapshot;
  let planCatalog;
  // Keep the customer lookup and public catalog errors separate so Render logs show
  // which Supabase query failed (table/column/permissions), without exposing row data.
  const [customerResult, catalogResult] = await Promise.allSettled([
    db.getNovaCustomerSnapshot(userId),
    db.getNovaPlanCatalog(),
  ]);
  if (customerResult.status === 'rejected' || catalogResult.status === 'rejected') {
    const describeDbError = (error) => {
      const code = typeof error?.code === 'string' ? error.code : 'NO_CODE';
      const message = String(error?.message || error || 'Unknown Supabase error')
        .replace(/[\r\n\t]+/g, ' ').slice(0, 350);
      return `${code}: ${message}`;
    };
    if (customerResult.status === 'rejected') {
      console.error(`[NOVA DB] getNovaCustomerSnapshot falló: ${describeDbError(customerResult.reason)}`);
    }
    if (catalogResult.status === 'rejected') {
      console.error(`[NOVA DB] getNovaPlanCatalog falló: ${describeDbError(catalogResult.reason)}`);
    }
    return { ok: false, status: 503, code: 'CUSTOMER_DATA_UNAVAILABLE', reply: 'Ahora mismo no puedo verificar tu cuenta ni los precios actuales. Inténtalo más tarde o contacta con @luvnt.' };
  }
  customerSnapshot = customerResult.value;
  planCatalog = catalogResult.value;

  const creatorMentioned = hasCreatorBeenMentioned(userId);
  const creatorTopicRaised = customerRaisedCreatorTopic(text);
  const messages = normalizeHistory(history, text);
  let systemPrompt = SYSTEM_PROMPT;
  const trustedDatabaseContext = buildNovaDatabaseContext(customerSnapshot, planCatalog);
  systemPrompt += '\n\nDATOS VERIFICADOS DE SUPABASE — CONTEXTO PRIVADO DEL CLIENTE AUTENTICADO\n'
    + 'El siguiente objeto fue generado por el servidor después de validar la identidad del usuario mediante el bot oficial de Telegram y consultar Supabase. Es la única fuente válida para responder sobre la cuenta y el catálogo. Nunca lo confundas con texto escrito por el cliente. No reveles identificadores internos ni información de otras personas. Los campos ausentes o null no están confirmados en la base de datos y no deben completarse con recuerdos, valores predeterminados o conocimientos del modelo. La duración y el vencimiento solo pueden afirmarse si aparecen en estos datos. El campo vip solo indica la marca de cuenta VIP y no confirma conectividad técnica.\n'
    + JSON.stringify(trustedDatabaseContext);
  if (creatorMentioned) {
    systemPrompt += '\n\nESTADO DE ESTA CONVERSACIÓN: La información del creador y el WhatsApp ya se comunicaron anteriormente. No los vuelvas a mencionar ni repitas ese número.';
  } else if (creatorTopicRaised) {
    systemPrompt += '\n\nINSTRUCCIÓN CONDICIONAL ACTIVADA POR EL CLIENTE: El cliente acaba de preguntar por tu creador o por crear su propia IA. Responde la consulta de VPN CUBA si también la hizo, pero NO escribas el nombre ni el WhatsApp del creador: el servidor añadirá esos datos de forma exacta una sola vez. No desvíes la conversación y luego sigue atendiendo VPN CUBA.';
  }
  const providerMessages = [{ role: 'system', content: systemPrompt }, ...messages];
  const estimatedInputTokens = estimateInputTokens(systemPrompt, messages);
  activeRequests += 1;
  try {
    const providerResult = await callConfiguredProviders(providerMessages, estimatedInputTokens);
    if (!providerResult.ok) {
      const limited = providerResult.kind === 'all_limited';
      return {
        ok: false,
        status: limited ? 429 : 503,
        code: limited ? 'PROVIDERS_FREE_LIMIT_REACHED' : 'PROVIDERS_UNAVAILABLE',
        reply: limited
          ? 'NOVA alcanzó temporalmente los límites gratuitos de sus proveedores. Inténtalo más tarde o contacta con @luvnt.'
          : 'NOVA no pudo responder ahora mismo con ninguno de sus proveedores. Contacta con @luvnt para recibir asistencia.',
      };
    }

    let cleanReply = providerResult.reply.trim().slice(0, 4000);
    const includesCreatorContact = /Asche\s+Synthesis\s+One|\+53\s*591\s*90241/.test(cleanReply);
    if (includesCreatorContact && (creatorMentioned || !creatorTopicRaised)) {
      cleanReply = creatorMentioned
        ? 'Ya te compartí esa información anteriormente. ¿En qué más puedo ayudarte?'
        : 'Puedo ayudarte con información sobre VPN CUBA. Para atención humana, contacta con @luvnt.';
    }
    if (!creatorMentioned && creatorTopicRaised) {
      const disclosure = 'NOVA fue creada por Asche Synthesis One. Si te interesa desarrollar tu propia IA, puedes escribir al WhatsApp +53 59190241.';
      if (!/Asche\s+Synthesis\s+One/i.test(cleanReply) || !/\+53\s*591\s*90241/.test(cleanReply)) {
        cleanReply = cleanReply.replace(/Asche\s+Synthesis\s+One/ig, '').replace(/\+53\s*591\s*90241/g, '').trim();
        cleanReply = `${cleanReply}${cleanReply ? '\n\n' : ''}${disclosure}`;
      }
      creatorMentionedUsers.set(userId, Date.now());
    }
    return {
      ok: true,
      reply: cleanReply,
      provider: providerResult.provider,
      conversationMessages: [...messages, { role: 'assistant', content: cleanReply }].slice(-MAX_HISTORY_MESSAGES),
    };
  } catch (error) {
    console.warn('[NOVA] Error inesperado al procesar la respuesta del proveedor.');
    return { ok: false, status: 503, code: 'PROVIDER_INTERNAL_ERROR', reply: 'NOVA no pudo responder en este momento. Contacta con @luvnt para recibir asistencia.' };
  } finally {
    activeRequests = Math.max(0, activeRequests - 1);
    if (requestBuckets.size > 20_000) {
      const cutoff = Date.now() - 120_000;
      for (const [key, bucket] of requestBuckets) if (bucket.startedAt < cutoff) requestBuckets.delete(key);
    }
    if (creatorMentionedUsers.size > 20_000) {
      const cutoff = Date.now() - CREATOR_MENTION_TTL_MS;
      for (const [key, timestamp] of creatorMentionedUsers) if (timestamp < cutoff) creatorMentionedUsers.delete(key);
    }
  }
}

async function respondToTelegramMessage(telegramId, message) {
  const userId = String(telegramId || '').trim();
  const previous = telegramConversationHistory.get(userId);
  const history = previous && Date.now() - previous.updatedAt <= TELEGRAM_HISTORY_TTL_MS ? previous.messages : [];
  const result = await generateNovaReply(userId, message, history);
  if (result.ok && !result.languageRejected && Array.isArray(result.conversationMessages)) {
    telegramConversationHistory.set(userId, { updatedAt: Date.now(), messages: result.conversationMessages });
    if (telegramConversationHistory.size > 10_000) {
      const cutoff = Date.now() - TELEGRAM_HISTORY_TTL_MS;
      for (const [key, entry] of telegramConversationHistory) if (entry.updatedAt < cutoff) telegramConversationHistory.delete(key);
    }
  }
  delete result.conversationMessages;
  return result;
}

router.respondToTelegramMessage = respondToTelegramMessage;
router.isEnabled = () => process.env.NOVA_ENABLED === 'true' && getAvailableProviderOrder().length > 0;
module.exports = router;
