# VPN CUBA

Proyecto de bot de Telegram y aplicación web para administrar el servicio VPN CUBA.

## Requisitos

- Node.js 20 o superior.
- Variables de entorno del proyecto configuradas.
- Proyecto de Supabase y bot de Telegram ya configurados.

## Instalación y ejecución

```bash
npm ci
npm start
```

Configura las credenciales del proyecto como secretos/variables de entorno del servidor. No subas un archivo `.env` real al repositorio.

## NOVA — atención al cliente con IA

NOVA aparece como una conversación separada dentro del Centro de soporte. Usa una cadena secuencial de cuatro proveedores: OpenRouter Free → Z.AI GLM-4.7-Flash → Novita Apodex 1.1 Mini → Cloudflare Workers AI. Para habilitarla, configura `OPENROUTER_API_KEY`, `ZAI_API_KEY`, `NOVITA_API_KEY`, `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`, y cambia `NOVA_ENABLED=true` después de probar en staging. El interruptor permanece en `false` por defecto.

Consulta **[NOVA_SETUP.md](NOVA_SETUP.md)** para crear las claves, comprender las cuotas gratuitas, revisar el aislamiento de datos por Telegram ID y conocer los límites operativos. El prompt normativo está en **[NOVA_MASTER_PROMPT.md](NOVA_MASTER_PROMPT.md)**. Los tickets tradicionales siguen funcionando de manera independiente.
