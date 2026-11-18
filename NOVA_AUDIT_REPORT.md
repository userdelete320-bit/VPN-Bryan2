# Auditoría de NOVA — acceso de solo lectura a Supabase

Fecha de revisión: 2026-11-16

## Resultado

NOVA queda preparada para consultar en tiempo real el perfil del cliente autenticado, sus registros recientes de pagos, el catálogo de precios de los planes estándar y la disponibilidad. Las consultas se ejecutan desde el servidor mediante los métodos `getNovaCustomerSnapshot` y `getNovaPlanCatalog` de `supabase.js`. La nueva ruta solo utiliza operaciones de lectura (`select`, `eq`, `order`, `limit`, `maybeSingle`).

No se ha conectado esta revisión a Supabase de producción ni se ha enviado ningún dato al servidor real. No se ha alterado ninguna tabla. Las pruebas se realizaron con un cliente Supabase simulado y datos ficticios.

## Alcance de lectura y seguridad

- La ruta `POST /api/nova/chat` valida `X-Telegram-Init-Data` con el `BOT_TOKEN`.
- El ID consultado se extrae del objeto `user` dentro de los datos firmados. Los valores `telegramId` y `customerId` que pudiera enviar el navegador no se utilizan.
- `users` se filtra por `telegram_id` validado. Se seleccionan solo los campos de estado VIP, plan, velocidades y prueba.
- `payments` se filtra por el mismo `telegram_id` y obtiene los 25 registros más recientes. Al modelo se le envían como máximo 8, con campos de importe, método, estado y entrega de configuración.
- `plan_prices` se consulta para los importes de planes estándar. Los precios guardados prevalecen; los valores predeterminados compartidos con el catálogo público se usan cuando falta una fila.
- `settings` se consulta por `key=plan_availability`. Un fallo en esta consulta produce un error controlado en lugar de asumir que todos los planes están disponibles.
- El backend exige `SUPABASE_SERVICE_ROLE_KEY`; la clave permanece en el servidor y no se envía al navegador ni a OpenRouter Free / Cloudflare Workers AI.
- Si falla cualquier lectura requerida, NOVA responde `503 CUSTOMER_DATA_UNAVAILABLE` y no consulta OpenRouter Free / Cloudflare Workers AI con información incompleta.
- El contexto enviado a OpenRouter Free / Cloudflare Workers AI no incluye Telegram ID, capturas, notas internas, claves, TXID, datos de otros clientes ni archivos de configuración.

## Precisión de planes y vigencia

Los precios CUP, saldo móvil, USDT, Stars y TON de los planes estándar se obtienen de `plan_prices` o del mismo fallback que usa la aplicación pública. PayPal y Zelle son precios estáticos definidos en la interfaz pública (PayPal: Básico 3 USD, Avanzado 7, VIP Cuba 7, Gaming 5, Gaming Pro 8 y Anual 40; Zelle: solo Anual, 35 USD), no se almacenan en `plan_prices`. Las descripciones y los periodos estándar tampoco están en esa tabla: se toman del catálogo/código público del proyecto y se identifican como tal en el contexto.

Express es una excepción: las opciones 24 horas, 3 días y 7 días aparecen en la interfaz pública con importes estáticos y no se persisten como filas independientes de `plan_prices`. Aunque el formulario manda `duration` al servidor, `createPayment` en `supabase.js` no almacena ese campo en la fila de pago. Por eso NOVA no inventa la duración ni calcula un vencimiento para Express.

Para los demás planes, NOVA calcula vigencia solo con un pago aprobado del plan actual y `config_sent=true` con `config_sent_at`, usando los periodos estándar del proyecto: 30 días (Básico, VIP Cuba, Gaming, Gaming Pro), 90 días (Avanzado) y 365 días (Anual). El indicador `users.vip` no prueba que el túnel esté conectado; `users.is_active` solo indica si el bot puede enviar mensajes.

## Archivos modificados / añadidos para esta etapa

- `supabase.js`: añade métodos de lectura con listas de campos permitidos y filtro obligatorio por Telegram ID validado. Rechaza llamadas de NOVA si falta la service-role key.
- `routes/nova.js`: crea un snapshot de cuenta y catálogo por consulta, construye contexto de datos verificados y lo entrega al modelo. No incorpora acciones de escritura.
- `plan-price-defaults.js`: concentra los defaults ya utilizados por el catálogo público para que la interfaz/backend y NOVA no diverjan.
- `index.js`: importa esos mismos defaults compartidos; no cambia las rutas comerciales.
- `public/app.html`: informa al cliente de la lectura de su propio perfil y del envío de un resumen mínimo al proveedor de IA.
- `NOVA_SETUP.md`: documenta secretos, fuentes, permisos y limitaciones.
- `tests/nova-db-readonly.test.js`: pruebas automatizadas simuladas.

## Pruebas locales

Comando ejecutado: `npm test`

Resultado actual de `npm test`: 13 pruebas superadas y 0 fallidas. Incluye OpenRouter principal, fallback automático a Cloudflare, modo solo Cloudflare, validación de Telegram y protección de solo lectura.

1. Endpoint de estado indica qué proveedores están configurados sin revelar claves.
2. Perfil y pagos consultados usando exclusivamente el ID de Telegram validado.
3. Catálogo de precios y disponibilidad incorporado al contexto del modelo.
4. No se calcula vencimiento antes de la entrega de configuración.
5. Fallo de Supabase devuelve error controlado y no llama a OpenRouter Free / Cloudflare Workers AI.
6. Una firma Telegram inválida se rechaza antes de consultar DB o proveedores.
7. Mensaje en inglés se rechaza antes de consultar DB o proveedores.
8. Una renovación aprobada sin entrega no borra la vigencia de la última configuración entregada.
9. Un fallo específico en `settings` no se interpreta como disponibilidad confirmada ni llama a proveedores.
10. OpenRouter 429 activa el fallback a Cloudflare Workers AI y devuelve respuesta.
11. NOVA funciona con Cloudflare cuando falta la clave de OpenRouter.
12. La capa simulada bloquea y verifica ausencia de escrituras.
13. Existen los métodos nuevos de lectura y se verifican valores DB y fallback.

También se ejecutaron comprobaciones sintácticas de `routes/nova.js`, `supabase.js` e `index.js`. Pendiente como validación externa: iniciar el proyecto en un entorno de prueba con credenciales reales de Supabase/OpenRouter Free / Cloudflare Workers AI y verificar una cuenta de prueba. Esta validación no se hizo porque el usuario no autorizó acceso a la base de datos/servidor ni proporcionó credenciales.

## Requisito operativo antes de habilitar

Configurar `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`, `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID` como secretos del servidor. Mantener `NOVA_ENABLED=false` hasta terminar una prueba controlada. OpenRouter usa el alias gratuito `openrouter/free` con filtros `data_collection=deny`, `zdr=true`, `allow_fallbacks=false` y `max_price={prompt:0, completion:0}`; Cloudflare Workers AI (`@cf/zai-org/glm-4.7-flash`) actúa como respaldo. La integración no modifica la base de datos y no conserva historial del chat en Supabase.
