# NOVA — instalación y operación

NOVA está conectada al chat privado directo del bot de Telegram y también conserva el endpoint de la Web App. Permanece desactivada por defecto (`NOVA_ENABLED=false`), por lo que el ZIP puede desplegarse sin activar el chat. Los tickets humanos y las rutas de soporte existentes siguen separados.

## Proveedores de IA

NOVA utiliza una cadena de respaldo **secuencial**. No hace cuatro llamadas a la vez: se detiene en el primer proveedor que devuelve una respuesta válida en español.

1. **OpenRouter (primario)** — endpoint OpenAI-compatible. `NOVA_OPENROUTER_MODEL=openrouter/free`; se conservan `provider.max_price.prompt=0` y `provider.max_price.completion=0`, además de los filtros de retención ya configurados. En el nivel gratuito OpenRouter publica 20 solicitudes/minuto y 50/día; NOVA limita localmente a 18/minuto y 45/día.
2. **Z.AI (segundo respaldo)** — modelo fijo `glm-4.7-flash`, endpoint `https://api.z.ai/api/paas/v4/chat/completions`, clave `ZAI_API_KEY`. La tabla oficial consultada muestra entrada y salida a $0 por millón de tokens. Esto no equivale a capacidad ilimitada: la cuota y la disponibilidad dependen de la cuenta y de las condiciones vigentes del proveedor.
3. **Novita (tercer respaldo)** — modelo fijo `apodex/apodex-1.1-mini`, endpoint `https://api.novita.ai/openai/chat/completions`, clave `NOVITA_API_KEY`. La ficha oficial del modelo muestra entrada y salida a $0 por millón de tokens y documenta compatibilidad OpenAI. Novita no publica en esa ficha un límite diario que permita garantizar 3.000 respuestas.
4. **Cloudflare Workers AI (último respaldo)** — modelo `@cf/zai-org/glm-4.7-flash`, con la asignación gratuita de 10.000 Neurons/día en Workers Free. NOVA reserva localmente hasta 7.500 Neurons estimadas/día y aplica margen de seguridad. El consumo de Neurons no equivale a un número fijo de solicitudes.

Si un proveedor no está configurado, responde con error HTTP, límite de uso, tiempo de espera, fallo de conexión o una respuesta vacía/no válida/en otro idioma, NOVA continúa al siguiente. Una respuesta válida detiene la cadena. Si todos fallan, NOVA ofrece el contacto humano sin exponer detalles internos ni claves.

**Coste y capacidad:** Z.AI y Novita muestran precio de tokens $0 para los modelos indicados, pero eso no garantiza un cupo ilimitado ni 3.000 solicitudes/día. OpenRouter tiene un límite diario gratuito bajo; Cloudflare se rige por su asignación de Neurons. La cadena reduce interrupciones, pero no constituye un SLA ni una promesa de volumen gratuito.

Los identificadores de modelo para Z.AI, Novita y Cloudflare están fijados en el código para evitar que una variable de entorno seleccione accidentalmente un modelo facturable. Si un proveedor cambia sus precios o retira el modelo, el proveedor puede devolver error y NOVA continuará con el siguiente. Verifica periódicamente las fichas oficiales antes de producción.


## Conversación directa por Telegram

- En el chat privado del bot, cualquier mensaje de texto normal que no esté siendo utilizado por un flujo existente de compra, búsqueda, comprobante, recarga o administración se envía a NOVA.
- Los mensajes que comienzan con `/` quedan reservados para comandos y no se envían a la IA. La excepción `/nova` se reconoce sin distinguir mayúsculas (`/nova`, `/Nova`) y presenta a NOVA. También admite una consulta en la misma línea, por ejemplo: `/nova ¿Qué plan tengo?`.
- Después de presentar NOVA, el usuario puede escribir normalmente; no hay que anteponer el comando en cada mensaje.
- `/start`, `/help`, `/menu` y los demás comandos continúan enrutándose a sus controladores originales. Los manejadores de flujos pendientes dejan pasar los mensajes slash para que no consuman comandos.
- NOVA solo responde en chats privados. En grupos no se mostrarán datos de cuenta para evitar que información personal quede expuesta a otros miembros.
- La conversación reciente de cada Telegram ID se conserva solo en memoria del proceso durante un máximo de 30 minutos. No se guarda en Supabase y no se comparte entre usuarios.
- El webhook de Telegram se configura con `secret_token`; el endpoint `/webhook` rechaza peticiones que no incluyan el encabezado secreto esperado. Si `TELEGRAM_WEBHOOK_SECRET` no está configurado, el servidor deriva un secreto estable del `BOT_TOKEN`. El secreto nunca se envía al cliente.

La única función que obtiene información privada es `respondToTelegramMessage`, que recibe el ID del remitente proporcionado por el contexto de Telegram después de recibir el update por el webhook validado. El servidor vuelve a leer el perfil y los pagos desde Supabase para ese ID en cada mensaje.

## Crear las claves

### OpenRouter

1. Crea una cuenta en [OpenRouter](https://openrouter.ai/).
2. En [Keys](https://openrouter.ai/settings/keys), crea una API key.
3. Mantén el uso en modelos gratuitos (`openrouter/free`) y no compres créditos si el objetivo es no pagar por inferencia.
4. Copia la clave solo al secreto `OPENROUTER_API_KEY` del servidor.

La solicitud incluye `provider.data_collection="deny"`, `provider.zdr=true` y `provider.max_price={prompt:0, completion:0}`. Los dos primeros filtros piden proveedores sin recopilación y endpoints ZDR; el último impone un tope de precio cero para que OpenRouter no enrute inferencia pagada. Esto puede reducir la disponibilidad: si no hay un endpoint gratuito que cumpla, NOVA continúa por Z.AI, Novita y Cloudflare, en ese orden. OpenRouter documenta que pueden existir endpoints con retención limitada por seguridad; para aplicar una política más estricta, activa también ZDR Only en los ajustes de privacidad de tu cuenta OpenRouter.

### Z.AI

1. Crea o utiliza una cuenta de [Z.AI](https://z.ai/).
2. Genera una API key desde el panel de API Keys.
3. Guarda la clave en el secreto de servidor `ZAI_API_KEY`.
4. El código usa el modelo fijo `glm-4.7-flash` y el endpoint OpenAI-compatible oficial `https://api.z.ai/api/paas/v4/chat/completions`.

La tarifa publicada del modelo muestra entrada y salida gratuitas. La cuota de solicitudes, disponibilidad y condiciones de tratamiento de datos están sujetas a la cuenta y a los términos de Z.AI. Asegúrate de contar con autorización y base legal para transferir al proveedor los datos mínimos del cliente que necesita NOVA.

### Novita

1. Crea o utiliza una cuenta de [Novita AI](https://novita.ai/).
2. Genera una API key en el panel de la plataforma.
3. Guarda la clave en el secreto de servidor `NOVITA_API_KEY`.
4. El código llama a `https://api.novita.ai/openai/chat/completions` con el modelo fijo `apodex/apodex-1.1-mini`.

La ficha oficial del modelo muestra entrada y salida a $0 por millón de tokens y documenta la API compatible con OpenAI. La ficha no establece un máximo diario garantizado de solicitudes; revisa la cuota y las condiciones en tu cuenta antes de producción.

### Cloudflare Workers AI

1. Crea o utiliza una cuenta de [Cloudflare](https://dash.cloudflare.com/).
2. Abre **Workers AI** y selecciona **Use REST API**.
3. Usa **Create a Workers AI API Token** y guarda el token que genera Cloudflare.
4. Copia el **Account ID** de esa misma pantalla.
5. Añade `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID` a los secretos del servidor.
6. Mantén la cuenta en **Workers Free**. El plan Workers Paid cobra el uso de neurons que exceda la asignación gratuita; no cambies a un plan de pago si no deseas cargos.

El token debe tener los permisos Workers AI indicados por la plantilla oficial de Cloudflare para REST API. No uses un token global de administrador si puedes crear uno limitado a Workers AI.

## Variables de entorno

Usa `.env.example` como referencia y configura:

```env
NOVA_ENABLED=false
OPENROUTER_API_KEY=...
NOVA_OPENROUTER_MODEL=openrouter/free
OPENROUTER_SITE_URL=https://vpn-cuba.com
OPENROUTER_APP_NAME=VPN CUBA NOVA
NOVA_OPENROUTER_DAILY_LIMIT=45
NOVA_OPENROUTER_RPM_LIMIT=18
ZAI_API_KEY=...
NOVITA_API_KEY=...
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
NOVA_CLOUDFLARE_DAILY_NEURON_LIMIT=7500
```

El modelo Cloudflare está fijado en el código a `@cf/zai-org/glm-4.7-flash`, que está disponible en Workers Free; no se permite configurarlo a un modelo que pueda requerir un plan de pago. Las cuatro claves son independientes: NOVA puede arrancar con uno o varios proveedores configurados. Para disponer de la cadena completa, configura los cuatro. `/status` informa si cada uno está configurado sin revelar claves.

## Protección de datos

OpenRouter recibe `data_collection=deny` y `zdr=true` por solicitud; si no hay endpoint elegible, la cadena continúa con Z.AI, Novita y Cloudflare. La aplicación solo usa endpoints de inferencia; no activa herramientas de búsqueda ni plugins. Z.AI y Novita reciben el mismo contexto mínimo del cliente si les corresponde responder, por lo que debes revisar sus condiciones de API, privacidad y tratamiento de datos y contar con autorización/base legal apropiada antes de producción. Z.AI publica condiciones de tratamiento para clientes API; Novita publica sus propios términos sobre el contenido de las solicitudes. Cloudflare declara que Workers AI procesa el Customer Content solo durante el tiempo necesario para prestar el servicio y el modelo seleccionado se marca Zero Data Retention. Ninguna de estas afirmaciones elimina la responsabilidad de VPN CUBA de controlar qué datos transmite.

El servidor consulta en modo exclusivamente lectura los datos del cliente autenticado en Telegram y el catálogo. No se envían el Telegram ID, notas internas, capturas, claves, TXID, direcciones ni archivos de configuración. El resumen de pagos (importe, método, estado y fecha) y el plan del cliente sí se transmiten al proveedor que genere la respuesta para dar atención personalizada. El proveedor que responda procesará ese contexto; no actives la función si no aceptas esa transferencia. La redacción automática de mensajes es una protección adicional, no una garantía para detectar todos los datos sensibles.

## Datos de Supabase consultados

- `users`: consulta del registro cuyo `telegram_id` coincide exactamente con el ID autenticado.
- `payments`: hasta 25 registros recientes filtrados por el mismo `telegram_id`. Se remiten al modelo solo los últimos 8 y campos permitidos; nunca capturas, notas, TXID ni archivos de conexión.
- `plan_prices`: catálogo general. NOVA muestra exclusivamente filas y valores realmente guardados en esta tabla; no utiliza `plan-price-defaults.js` ni ningún fallback del código.
- `settings` (`key=plan_availability`): disponibilidad general. Si no existe el valor o falla la consulta, la disponibilidad queda sin confirmar y NOVA no llama al modelo cuando la consulta falla.

La cuenta consultada se determina únicamente por el Telegram ID extraído de `X-Telegram-Init-Data` y su firma validada con `BOT_TOKEN`. El cliente no puede sustituir ese ID desde el cuerpo de la solicitud. Los datos de `users` y `payments` siempre usan ese mismo filtro. `plan_prices` y `settings` son datos generales de la empresa y no contienen consultas de cuentas ajenas. NOVA no permite consultar terceros.

## Activación gradual y pruebas

1. Mantén `NOVA_ENABLED=false` durante el primer despliegue.
2. Verifica que `/api/nova/status` (o el montaje correspondiente en el servidor) muestra los proveedores esperados como configurados.
3. Prueba en un entorno de staging con una cuenta de cliente autorizada. Comprueba primero OpenRouter y después simula fallos sucesivos para verificar el orden Z.AI → Novita → Cloudflare.
4. Comprueba que los tickets humanos, pagos y las demás rutas siguen funcionando.
5. Solo después cambia `NOVA_ENABLED=true`.
6. Abre el chat privado del bot y prueba `/nova`, luego escribe una pregunta sin `/`. Comprueba también que `/start`, `/help`, `/menu` y otros comandos originales siguen funcionando.

Los contadores de cuota de esta versión son locales al proceso Node. Si despliegas varias instancias, cada una tendrá su propio contador; no existe una cuota global distribuida ni se creó una tabla para ello. Mantén las cuotas de cuenta de los proveedores como límite definitivo y monitoriza respuestas 429/503.

## Restricciones funcionales

NOVA lee la cuenta y el catálogo, pero no escribe datos. No activa, renueva ni cancela servicios; no aprueba pagos; no modifica saldos; no entrega configuraciones; no diagnostica el estado técnico de los túneles. NOVA no calcula ningún vencimiento mientras la duración aplicable no esté disponible como dato verificado en Supabase. Tampoco afirma descripciones o características de planes que no existan en los datos consultados.

Las pruebas incluidas son simuladas: no contactan APIs externas ni Supabase real. Verifican también que el filtro por Telegram ID excluye registros de otros clientes, que el navegador no puede inyectar historial falso y que NOVA no usa precios predeterminados, descripciones ni duraciones incrustadas en el código. Las cuentas y claves reales deben validarse en staging antes de activar el chat en producción.
