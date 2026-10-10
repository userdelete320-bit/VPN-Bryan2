// ==========================================================
//  Sincronización del catálogo de la tienda unificada
// Junta los productos de Qamify + DigitalCore + Vexoran, les aplica el markup
//  y los guarda en caché (shop_products) — así "Productos" nunca
//  consulta las APIs en vivo cada vez que un usuario la abre.
// ==========================================================

const qamify = require('./qamify_connector');
const digitalcore = require('./digitalcore_connector');
const vexoran = require('./vexoran_connector');

const MARKUP_USD = 3; // markup fijo de la tienda aplicado a los proveedores integrados

// Vexoran puede representar los booleanos de stock con valores no normalizados
// en algunas respuestas. Convertimos el campo antes de decidir si hay inventario.
function isExplicitFalse(value) {
  return value === false || value === 0 || (typeof value === 'string' && value.trim().toLowerCase() === 'false');
}

function isExplicitTrue(value) {
  return value === true || value === 1 || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

async function syncShopCatalog(db) {
  const results = { qamify: { ok: false, count: 0 }, digitalcore: { ok: false, count: 0 }, vexoran: { ok: false, count: 0 } };

  // GGSoma se retiró: desactivar su catálogo anterior sin borrar compras ni historial.
  try {
    if (typeof db.deactivateShopProductsBySource === 'function') {
      await db.deactivateShopProductsBySource('ggsoma');
    }
  } catch (err) {
    console.error('❌ No se pudieron desactivar los productos antiguos de GGSoma:', err.message);
  }

  let qamifyProducts = [];
  try {
    qamifyProducts = await qamify.getProducts();
    results.qamify = { ok: true, count: qamifyProducts.length };
  } catch (err) {
    results.qamify = { ok: false, error: err.message };
    console.error('❌ Error sincronizando catálogo de Qamify:', err.message);
  }

  let digitalcoreProducts = [];
  try {
    digitalcoreProducts = await digitalcore.getProducts();
    results.digitalcore = { ok: true, count: digitalcoreProducts.length };
  } catch (err) {
    results.digitalcore = { ok: false, error: err.message };
    console.error('❌ Error sincronizando catálogo de DigitalCore:', err.message);
  }

  let vexoranProducts = [];
  try {
    const products = await vexoran.getProducts();
    vexoranProducts = products.map(p => {
      // La documentación de Vexoran define stock=null para servicios sin
      // inventario. 'available=true' también confirma que ese servicio puede
      // comprarse. No convertir ese null en cero: el bot lo mostraría agotado.
      const requiresStock = isExplicitFalse(p.requires_stock)
        ? false
        : (isExplicitTrue(p.requires_stock) ? true : !(p.stock == null && isExplicitTrue(p.available)));
      const stockUnlimited = !requiresStock;
      const normalizedStock = stockUnlimited
        ? -1
        : (p.stock == null ? 0 : Number(p.stock));

      return {
        source: 'vexoran',
        external_id: String(p.id),
        external_ref: String(p.id),
        name: p.name || String(p.id),
        description: p.description_text || p.description || p.description_html || '',
        instructions: p.delivery_instructions || '',
        your_price_usd: Number(p.price),
        stock: Number.isFinite(normalizedStock) ? normalizedStock : 0,
        min_qty: Number(p.min_qty) > 0 ? Number(p.min_qty) : 1,
        max_qty: Number(p.max_qty) > 0 ? Number(p.max_qty) : 1000,
        // Guardamos los booleanos normalizados para que la validación de compra
        // no trate 'false' como true por ser una cadena de texto.
        raw: { ...p, requires_stock: requiresStock, stock_unlimited: stockUnlimited },
      };
    });
    results.vexoran = { ok: true, count: vexoranProducts.length };
  } catch (err) {
    results.vexoran = { ok: false, error: err.message };
    console.error('❌ Error sincronizando catálogo de Vexoran:', err.message);
  }

  const allProducts = [...qamifyProducts, ...digitalcoreProducts, ...vexoranProducts];

  // Si todas las APIs fallaron, no se toca el catálogo para evitar desactivarlo
  // por un problema de red pasajero.
  if (allProducts.length === 0 && !results.qamify.ok && !results.digitalcore.ok && !results.vexoran.ok) {
    return { ...results, skipped: true, reason: 'todas las APIs fallaron; catálogo no modificado' };
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
    if (results.digitalcore.ok) await db.deactivateMissingShopProducts('digitalcore', digitalcoreProducts.map(p => p.external_id));
  if (results.vexoran.ok) await db.deactivateMissingShopProducts('vexoran', vexoranProducts.map(p => p.external_id));

  return { ...results, total_synced: allProducts.length };
}

module.exports = { syncShopCatalog, MARKUP_USD };
