// ==========================================================
//  Conector Qamify (API 1) — Reseller API
//  Traduce la API real de Qamify a nuestro formato interno único,
//  para que el resto del sistema (SHOP SYSTEM) no necesite saber
//  nada específico de esta API.
// ==========================================================

const BASE_URL = 'https://api.qamify.site';
const API_KEY = process.env.QAMIFY_API_KEY; // nunca hardcodear la clave aquí

function authHeaders() {
  return { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
}

// Convierte un producto de Qamify a nuestro formato unificado
function normalizeProduct(p) {
  return {
    source: 'qamify',
    external_id: String(p.id),
    external_ref: String(p.id), // Qamify solo usa product_id numérico, no hay slug
    name: p.name,
    description: p.description || '',
    instructions: p.instructions || '',
    your_price_usd: Number(p.unit_price), // Qamify ya devuelve el precio final del reseller
    stock: p.stock,
    min_qty: p.min_qty || 1,
    max_qty: p.max_qty || 1,
    raw: p,
  };
}

async function getProducts() {
  const fetch = require('node-fetch');
  const res = await fetch(`${BASE_URL}/v1/products`, { headers: authHeaders() });
  const data = await res.json();
  if (!data.ok) throw new Error(`Qamify getProducts: ${data.error?.code || 'error desconocido'}`);
  return data.products.map(normalizeProduct);
}

async function getProduct(externalId) {
  const fetch = require('node-fetch');
  const res = await fetch(`${BASE_URL}/v1/products/${encodeURIComponent(externalId)}`, { headers: authHeaders() });
  const data = await res.json();
  if (!data.ok) return null;
  return normalizeProduct(data.product);
}

// Crea una orden real. idempotencyKey debe ser único por intento de compra
// (mismo key en reintentos → Qamify no vuelve a cobrar, devuelve la misma orden).
async function createOrder({ idempotencyKey, externalId, qty }) {
  const fetch = require('node-fetch');
  try {
    const res = await fetch(`${BASE_URL}/v1/orders`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ product_id: Number(externalId), qty: qty || 1 }),
    });
    const data = await res.json();
    if (!data.ok) {
      return { success: false, error: { code: data.error.code, message: data.error.message, raw: data.error } };
    }
    return {
      success: true,
      external_order_code: data.order.code,
      items: data.order.items.map(i => i.content),
      instructions: data.order.instructions || '',
      replayed: !!data.order.replayed,
      raw: data,
    };
  } catch (err) {
    // Error de red/timeout: seguro reintentar con la MISMA idempotencyKey más tarde
    return { success: false, error: { code: 'network_error', message: err.message, retryable: true } };
  }
}

async function getBalance() {
  const fetch = require('node-fetch');
  const res = await fetch(`${BASE_URL}/v1/balance`, { headers: authHeaders() });
  const data = await res.json();
  if (!data.ok) throw new Error('Qamify getBalance: error');
  return Number(data.balance);
}

module.exports = { getProducts, getProduct, createOrder, getBalance };
