// ==========================================================
//  Sincronización del catálogo de la tienda unificada
//  Junta los productos de Qamify + GGSoma, les aplica el markup
//  y los guarda en caché (shop_products) — así "Productos" nunca
//  consulta las APIs en vivo cada vez que un usuario la abre.
// ==========================================================

const qamify = require('./qamify_connector');
const ggsoma = require('./ggsoma_connector');

const MARKUP_USD = 3; // aplica igual para Qamify y GGSoma, confirmado por el negocio

async function syncShopCatalog(db) {
  const results = { qamify: { ok: false, count: 0 }, ggsoma: { ok: false, count: 0 } };

  let qamifyProducts = [];
  try {
    qamifyProducts = await qamify.getProducts();
    results.qamify = { ok: true, count: qamifyProducts.length };
  } catch (err) {
    results.qamify = { ok: false, error: err.message };
    console.error('❌ Error sincronizando catálogo de Qamify:', err.message);
  }

  let ggsomaProducts = [];
  try {
    ggsomaProducts = await ggsoma.getProducts();
    results.ggsoma = { ok: true, count: ggsomaProducts.length };
  } catch (err) {
    results.ggsoma = { ok: false, error: err.message };
    console.error('❌ Error sincronizando catálogo de GGSoma:', err.message);
  }

  const allProducts = [...qamifyProducts, ...ggsomaProducts];

  // Si AMBAS APIs fallaron, no se toca nada (para no desactivar todo el catálogo
  // por un problema de red pasajero)
  if (allProducts.length === 0 && !results.qamify.ok && !results.ggsoma.ok) {
    return { ...results, skipped: true, reason: 'ambas APIs fallaron, catálogo no modificado' };
  }

  for (const p of allProducts) {
    const finalPrice = Math.round((p.your_price_usd + MARKUP_USD) * 100) / 100;
    await db.upsertShopProduct({
      source: p.source,
      external_id: p.external_id,
      external_ref: p.external_ref,
      name: p.name,
      description: p.description,
      instructions: p.instructions,
      your_price_usd: p.your_price_usd,
      final_price_usd: finalPrice,
      stock: p.stock,
      min_qty: p.min_qty,
      max_qty: p.max_qty,
      raw_data: p.raw,
    });
  }

  // Desactivar (no borrar) los que YA NO aparecen en su API de origen — evita
  // vender algo descontinuado, pero conserva el historial de órdenes pasadas.
  if (results.qamify.ok) await db.deactivateMissingShopProducts('qamify', qamifyProducts.map(p => p.external_id));
  if (results.ggsoma.ok) await db.deactivateMissingShopProducts('ggsoma', ggsomaProducts.map(p => p.external_id));

  return { ...results, total_synced: allProducts.length };
}

module.exports = { syncShopCatalog, MARKUP_USD };
