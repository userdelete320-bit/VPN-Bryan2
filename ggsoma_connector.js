// ==========================================================
//  Conector GGSoma (API 2) — Partner API
//  Traduce la API real de GGSoma a nuestro mismo formato interno
//  que usa el conector de Qamify, para que el resto del sistema
//  (SHOP SYSTEM) trate ambas APIs exactamente igual.
// ==========================================================

const BASE_URL = 'https://ggsoma.store/api/partner/v1';
const API_KEY = process.env.GGSOMA_API_KEY; // nunca hardcodear la clave aquí

function authHeaders() {
  return { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
}

// Convierte un producto de GGSoma a nuestro formato unificado
function normalizeProduct(p) {
  return {
    source: 'ggsoma',
    external_id: String(p.id),
    external_ref: p.slug, // GGSoma recomienda usar el slug (más estable que el id numérico)
    name: p.name,
    description: p.description || '',
    instructions: p.instructions || '',
    your_price_usd: Number(p.yourPrice), // GGSoma da catalogPrice (público) y yourPrice (el nuestro) — usamos yourPrice
    stock: p.stock?.inStock ? p.stock.count : 0,
    min_qty: 1,
    max_qty: p.stock?.maxQuantity || 1,
    delivery_type: p.deliveryType, // LINK | COUPON | READY_ACCOUNT — informativo, no cambia cómo lo mostramos
    raw: p,
  };
}

async function getProducts() {
  const fetch = require('node-fetch');
  const res = await fetch(`${BASE_URL}/catalog/products`, { headers: authHeaders() });
  const data = await res.json();
  if (!data.data) throw new Error('GGSoma getProducts: respuesta inesperada');
  return data.data.map(normalizeProduct);
}

async function getProduct(externalRef) {
  const fetch = require('node-fetch');
  const res = await fetch(`${BASE_URL}/catalog/products/${encodeURIComponent(externalRef)}`, { headers: authHeaders() });
  const data = await res.json();
  if (!data || data.ok === false) return null;
  return normalizeProduct(data);
}

// GGSoma usa "externalOrderId" (un campo nuestro) en vez de un header de idempotencia,
// pero cumple exactamente la misma función: mismo id → misma orden, sin cobrar dos veces.
async function createOrder({ idempotencyKey, externalRef, qty }) {
  const fetch = require('node-fetch');
  try {
    const res = await fetch(`${BASE_URL}/orders`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ productSlug: externalRef, quantity: qty || 1, externalOrderId: idempotencyKey }),
    });
    const data = await res.json();
    if (!data.ok) {
      return { success: false, error: { code: data.error.code, message: data.error.message, raw: data.error } };
    }
    // Pedido normal (delivery único) vs. pedido bulk (lines[])
    let items = [];
    if (data.lines && data.lines.length) {
      items = data.lines.map(l => l.code || l.link || l.content || JSON.stringify(l));
    } else if (data.delivery) {
      items = [data.delivery.link || data.delivery.code || data.delivery.content];
    }
    return {
      success: true,
      external_order_code: data.orderCode,
      items,
      instructions: data.delivery?.instructions || '',
      replayed: false, // GGSoma no expone un flag explícito de "replay" como Qamify
      raw: data,
    };
  } catch (err) {
    return { success: false, error: { code: 'network_error', message: err.message, retryable: true } };
  }
}

async function getBalance() {
  const fetch = require('node-fetch');
  const res = await fetch(`${BASE_URL}/balance`, { headers: authHeaders() });
  const data = await res.json();
  if (!data.ok) throw new Error('GGSoma getBalance: error');
  return Number(data.balance);
}

module.exports = { getProducts, getProduct, createOrder, getBalance };
