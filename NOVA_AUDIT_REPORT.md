# Auditoría de NOVA — versión con prompt maestro y contexto personal ampliado

## Alcance de esta revisión

Esta revisión actualiza el sistema NOVA que usa cuatro proveedores IA secuenciales y atiende desde el chat privado de Telegram y la Web App. El prompt normativo ahora vive en `NOVA_MASTER_PROMPT.md` y se carga como prompt de sistema desde `routes/nova.js`.

## Información que NOVA puede consultar

### Datos personales filtrados por el Telegram ID autenticado

- `users` y `payments`: perfil, plan, pagos y estados propios, usando una lista explícita de campos.
- `referrals`: cantidades y niveles de referidos propios, estado de pago y descuentos agregados. No se pasan identidades de los referidos.
- El saldo del monedero de referidos queda desactivado hasta auditar el SQL de `get_referral_wallet`; las cantidades de referidos se consultan directamente desde `referrals` con filtro de propietario.
- `trial_history`, `xp_log`, `coupon_usage`: historial propio de pruebas, XP y cupones usados.
- `shop_balances`, `shop_topups`, `shop_orders`: saldo, recargas y pedidos de la propia cuenta.
- `support_tickets` y mensajes ligados a tickets previamente identificados como propios. Los mensajes se recortan y redactan.
- `resellers`, `reseller_sales`, `reseller_withdrawals`, `reseller_clients`: estado, ingresos, retiradas y cantidades agregadas del propio revendedor, sin nombres ni IDs de sus clientes.
- `reseller_clients`: indicador de si el cliente autenticado está vinculado a un revendedor, sin revelar su identidad.
- `referral_withdrawals`: excluida hasta que se confirme una relación de propiedad segura, pues el código visible solo muestra una consulta global para administración.

### Información general permitida

- `plan_prices`: solo filas y precios realmente guardados.
- `announcements` / `popup_announcement`: avisos públicos activos/vigentes.
- `settings`: solo `key=plan_availability`.
- `shop_products`: solo productos activos y campos comerciales seleccionados.
- `coupons`: solo cupones activos, con stock y fecha de expiración revisados.
- `reseller_config`: parámetros comerciales permitidos cuando existe un registro propio de revendedor.
- `announcements` y `popup_announcement`: avisos públicos activos/vigentes.
- `announcements` y `popup_announcement`: avisos globales activos y vigentes.

Los datos privados se consultan en el servidor con filtros exactos. El modelo no recibe credenciales de Supabase, no ejecuta SQL ni decide qué ID consultar. Las lecturas opcionales llevan indicadores de disponibilidad: un fallo de consulta nunca se convierte en «cero» ni en «no existe».

## Exclusiones y protección

No se envían archivos WireGuard, capturas, notas internas, TXID, direcciones de billeteras, contraseñas, claves API, tokens, secretos, listas globales de usuarios, estadísticas administrativas ni datos individuales de otras personas. Los mensajes de tickets son redactados antes de enviarse al proveedor.

`usdt_payments` queda fuera mientras no exista una relación de propiedad inequívoca y comprobada por Telegram ID. `referral_withdrawals` también permanece excluida porque el código actual solo muestra un lector global administrativo y no confirma su columna de propietario. Tampoco se concede acceso arbitrario a todas las tablas: se permite consultar las tablas útiles y seguras, con filtros por usuario y campos permitidos. Las tablas administrativas o que contengan archivos/configuraciones permanecen excluidas.

## Reglas comerciales del prompt

El prompt maestro incorpora la información que proporcionó el propietario sobre planes, WireGuard, Gaming, navegación nacional, procedimientos de compra, recargas USDT, pedidos, reembolsos, renovaciones, referidos, soporte y estilo de atención.

Los precios vigentes siguen subordinados a `plan_prices`. El lector actual expone `cup`, `mobile`, `usdt`, `stars` y `ton`, pero no una columna `usd`; por eso los importes USD de referencia incluidos en el nuevo texto no se han fijado como precios constantes. Para cotizar en USD, hay que guardar ese valor en Supabase y añadir la columna a la consulta.

## Comprobaciones ejecutadas

- `node --check` para los archivos JavaScript modificados.
- `npm test`: **22 pruebas superadas, 0 fallidas**.
- Aislamiento por Telegram ID.
- Lectura de nuevas secciones personales y filtros de propietario.
- No filtración de identificadores de referidos/clientes, TXID, direcciones ni material de configuración dentro del contexto simulado.
- Ninguna operación de escritura ejecutada por el motor NOVA en las pruebas.
- La cadena OpenRouter → Z.AI → Novita → Cloudflare continúa funcionando en las pruebas de simulación.
- Los comandos slash existentes y la excepción `/nova` siguen conservados.

## Pendientes antes de producción

1. Antes de habilitar el saldo de referidos en NOVA, revisar en Supabase la definición SQL real de `get_referral_wallet`. La función permanece desactivada desde NOVA porque su cuerpo no está versionado; las estadísticas por filas de `referrals` sí están disponibles con filtro de propietario.
2. Probar con staging y datos ficticios/una cuenta autorizada real; estas pruebas locales no contactan proveedores, Supabase ni Telegram reales.
3. Revisar condiciones de privacidad de los cuatro proveedores. El contexto de cliente enviado a un proveedor puede haber sido recibido incluso si devuelve timeout; el fallback podría transmitirlo al siguiente.
4. Mantener `NOVA_ENABLED=false` hasta cerrar estas verificaciones.

## Archivos normativos

- `NOVA_MASTER_PROMPT.md`: prompt maestro de NOVA.
- `NOVA_SETUP.md`: configuración, proveedores y operación.
- `NOVA_DB_ACCESS_SCOPE.md`: matriz de tablas, filtros, datos permitidos y exclusiones.
