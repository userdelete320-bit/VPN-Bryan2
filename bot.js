const { Telegraf } = require('telegraf');
const { userService, configFileService, paymentService } = require('./supabase');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

// IDs de administradores (separados por comas)
const ADMIN_IDS = process.env.ADMIN_TELEGRAM_IDS ? 
    process.env.ADMIN_TELEGRAM_IDS.split(',').map(id => id.trim()) : 
    ['6373481979', '5376388604'];

// Verificar si es administrador
function isAdmin(userId) {
    return ADMIN_IDS.includes(userId.toString());
}

// Función para calcular días restantes según el plan
function calcularDiasRestantes(user) {
    if (!user.vip || !user.vip_since || !user.plan) {
        return 0;
    }

    const fechaInicio = new Date(user.vip_since);
    const fechaActual = new Date();
    
    let duracionDias;
    switch(user.plan.toLowerCase()) {
        case 'basico':
            duracionDias = 30;
            break;
        case 'premium':
            duracionDias = 60;
            break;
        case 'vip':
            duracionDias = 180;
            break;
        default:
            duracionDias = 30;
    }
    
    const fechaExpiracion = new Date(fechaInicio);
    fechaExpiracion.setDate(fechaExpiracion.getDate() + duracionDias);
    
    const diferenciaMs = fechaExpiracion - fechaActual;
    const diasRestantes = Math.max(0, Math.ceil(diferenciaMs / (1000 * 60 * 60 * 24)));
    
    return diasRestantes;
}

// Función para formatear fecha
function formatearFecha(fecha) {
    return new Date(fecha).toLocaleDateString('es-ES', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
}

// ==================== KEEP ALIVE ====================

function startBotKeepAlive() {
  const keepAliveInterval = 5 * 60 * 1000;
  
  setInterval(() => {
    console.log(`🤖 Bot activo y escuchando a las ${new Date().toLocaleTimeString()}`);
    
    try {
      bot.telegram.getMe()
        .then(() => {
          console.log('✅ Conexión con Telegram estable');
        })
        .catch(error => {
          console.error('❌ Error en conexión con Telegram:', error.message);
        });
    } catch (error) {
      console.error('❌ Error en keep-alive del bot:', error.message);
    }
  }, keepAliveInterval);

  console.log(`🔄 Keep-alive del bot iniciado. Verificación cada 5 minutos`);
}

// ==================== FUNCIÓN PARA CREAR MENÚ PRINCIPAL ====================

function crearMenuPrincipal(userId, firstName = 'usuario') {
    const plansUrl = `${process.env.WEBAPP_URL || 'http://localhost:3000'}/plans.html?userId=${userId}`;
    const adminUrl = `${process.env.WEBAPP_URL || 'http://localhost:3000'}/admin.html?userId=${userId}&admin=true`;
    
    // Crear teclado BASE para TODOS los usuarios
    const keyboard = [
        [
            { 
                text: '📋 VER PLANES', 
                web_app: { url: plansUrl }
            },
            {
                text: '👑 MI ESTADO',
                callback_data: 'check_status'
            }
        ],
        [
            {
                text: '🆘 SOPORTE',
                url: 'https://t.me/L0quen2'
            }
        ]
    ];

    // Si es ADMIN, agregar botones adicionales EN LA MISMA PANTALLA
    if (isAdmin(userId)) {
        keyboard.push([
            { 
                text: '🔧 PANEL ADMIN', 
                web_app: { url: adminUrl }
            },
            {
                text: '📢 BROADCAST',
                callback_data: 'start_broadcast'
            }
        ]);
    }

    return {
        mensaje: `¡Hola ${firstName}! 👋\n\n` +
                `*VPN CUBA - MENÚ PRINCIPAL* 🚀\n\n` +
                `Selecciona una opción:`,
        teclado: keyboard
    };
}

// ==================== COMANDO /START ====================

bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username;
    const firstName = ctx.from.first_name;
    
    try {
        // Registrar usuario si no existe
        await userService.upsertUser(userId.toString(), {
            username: username,
            first_name: firstName,
            created_at: new Date().toISOString()
        });

        // Crear menú principal
        const menu = crearMenuPrincipal(userId, firstName);
        
        await ctx.reply(
            menu.mensaje,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: menu.teclado
                }
            }
        );
    } catch (error) {
        console.error('Error en comando /start:', error);
        await ctx.reply('❌ Hubo un error. Por favor, intenta de nuevo.');
    }
});

// ==================== BOTÓN "MENÚ PRINCIPAL" ====================

bot.action('main_menu', async (ctx) => {
    const userId = ctx.from.id.toString();
    const firstName = ctx.from.first_name;
    
    // Crear menú principal
    const menu = crearMenuPrincipal(userId, firstName);
    
    await ctx.editMessageText(
        menu.mensaje,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: menu.teclado
            }
        }
    );
});

// ==================== BOTÓN "MI ESTADO" ====================

bot.action('check_status', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    try {
        const user = await userService.getUserByTelegramId(userId);
        
        if (!user) {
            const menu = crearMenuPrincipal(userId, ctx.from.first_name);
            await ctx.editMessageText(
                `❌ *NO ESTÁS REGISTRADO*\n\n` +
                `Usa el botón "📋 VER PLANES" para registrarte y comenzar.\n\n` +
                menu.mensaje,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: menu.teclado
                    }
                }
            );
            return;
        }
        
        if (user.vip) {
            const vipSince = formatearFecha(user.vip_since);
            const diasRestantes = calcularDiasRestantes(user);
            const planNombre = user.plan ? 
                (user.plan === 'basico' ? 'BÁSICO (1 mes)' : 
                 user.plan === 'premium' ? 'PREMIUM (2 meses)' : 
                 user.plan === 'vip' ? 'VIP (6 meses)' : user.plan) : 
                'No especificado';
            
            let mensajeEstado = `✅ *¡ERES USUARIO VIP!* 👑\n\n`;
            mensajeEstado += `📅 *Activado:* ${vipSince}\n`;
            mensajeEstado += `📋 *Plan:* ${planNombre}\n`;
            mensajeEstado += `⏳ *Días restantes:* ${diasRestantes} días\n`;
            mensajeEstado += `💰 *Precio:* $${user.plan_price || '0'} CUP\n\n`;
            
            if (diasRestantes <= 7) {
                mensajeEstado += `⚠️ *TU PLAN ESTÁ POR EXPIRAR PRONTO*\n`;
                mensajeEstado += `Renueva ahora para mantener tu acceso VIP.\n\n`;
            } else {
                mensajeEstado += `Tu acceso está activo. ¡Disfruta de baja latencia! 🚀\n\n`;
            }
            
            // Crear teclado para estado VIP
            const keyboard = [
                [
                    { 
                        text: '📋 VER PLANES',
                        web_app: { url: `${process.env.WEBAPP_URL || 'http://localhost:3000'}/plans.html?userId=${userId}` }
                    },
                    {
                        text: '🆘 SOPORTE',
                        url: 'https://t.me/L0quen2'
                    }
                ],
                [
                    {
                        text: '🏠 MENÚ PRINCIPAL',
                        callback_data: 'main_menu'
                    }
                ]
            ];
            
            await ctx.editMessageText(
                mensajeEstado,
                { 
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: keyboard
                    }
                }
            );
        } else {
            const menu = crearMenuPrincipal(userId, ctx.from.first_name);
            await ctx.editMessageText(
                `❌ *NO ERES USUARIO VIP*\n\n` +
                `Actualmente no tienes acceso a los servicios premium.\n\n` +
                menu.mensaje,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: menu.teclado
                    }
                }
            );
        }
    } catch (error) {
        console.error('Error en botón MI ESTADO:', error);
        const menu = crearMenuPrincipal(userId, ctx.from.first_name);
        await ctx.editMessageText(
            `❌ Error al verificar tu estado.\n\n` + menu.mensaje,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: menu.teclado
                }
            }
        );
    }
});

// ==================== BROADCAST - ENVIAR A TODOS ====================

bot.action('start_broadcast', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!isAdmin(userId)) {
        await ctx.answerCbQuery('❌ NO AUTORIZADO');
        return;
    }
    
    ctx.session = ctx.session || {};
    ctx.session.waitingForBroadcastMessage = true;
    
    const menu = crearMenuPrincipal(userId, ctx.from.first_name);
    
    await ctx.editMessageText(
        `📢 *ENVIAR MENSAJE A TODOS LOS CLIENTES* 📤\n\n` +
        `Por favor, escribe el mensaje que quieres enviar a *todos* los usuarios registrados.\n\n` +
        `*EJEMPLO:*\n` +
        `¡Hola a todos! 🎉\n` +
        `Tenemos nuevas actualizaciones disponibles...\n\n` +
        `Escribe tu mensaje ahora:`,
        { 
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '❌ CANCELAR',
                            callback_data: 'main_menu'
                        }
                    ]
                ]
            }
        }
    );
    await ctx.answerCbQuery();
});

// Manejar mensaje de broadcast
bot.on('text', async (ctx) => {
    const currentUserId = ctx.from.id.toString();
    const message = ctx.message.text;
    
    if (isAdmin(currentUserId) && ctx.session?.waitingForBroadcastMessage) {
        ctx.session.waitingForBroadcastMessage = false;
        ctx.session.pendingBroadcast = message;
        
        await ctx.reply(
            `📢 *CONFIRMAR ENVÍO DE BROADCAST* ✅\n\n` +
            `*MENSAJE A ENVIAR:*\n${message}\n\n` +
            `Este mensaje será enviado a *todos los usuarios registrados*.\n\n` +
            `¿Estás seguro de que quieres continuar?`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ SÍ, ENVIAR A TODOS', callback_data: 'confirm_broadcast' },
                            { text: '❌ CANCELAR', callback_data: 'main_menu' }
                        ]
                    ]
                }
            }
        );
    }
});

// ==================== CALLBACK QUERY HANDLER ====================

bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id.toString();
    
    try {
        switch (data) {
            case 'confirm_broadcast':
                if (!isAdmin(userId)) {
                    await ctx.answerCbQuery('❌ NO AUTORIZADO');
                    return;
                }
                
                const broadcastMessage = ctx.session?.pendingBroadcast;
                if (!broadcastMessage) {
                    await ctx.answerCbQuery('❌ NO HAY MENSAJE PARA ENVIAR');
                    return;
                }
                
                // Obtener todos los usuarios
                const users = await userService.getAllUsers();
                const totalUsers = users.length;
                
                await ctx.editMessageText(
                    `📢 *ENVIANDO BROADCAST* 📤\n\n` +
                    `Enviando mensaje a ${totalUsers} usuarios...\n` +
                    `Por favor, espera. Esto puede tomar unos minutos.\n\n` +
                    `⏳ *PROGRESO:* 0/${totalUsers}`,
                    { 
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [] }
                    }
                );
                
                let successCount = 0;
                let failCount = 0;
                
                // Enviar mensaje a cada usuario
                for (let i = 0; i < users.length; i++) {
                    const user = users[i];
                    
                    try {
                        await bot.telegram.sendMessage(
                            user.telegram_id,
                            `📢 *MENSAJE IMPORTANTE - VPN CUBA*\n\n${broadcastMessage}\n\n_Por favor, no respondas a este mensaje. Para consultas, contacta a soporte: @L0quen2_`,
                            { parse_mode: 'Markdown' }
                        );
                        successCount++;
                        
                        // Actualizar progreso cada 10 usuarios
                        if (i % 10 === 0 || i === users.length - 1) {
                            await ctx.telegram.editMessageText(
                                ctx.chat.id,
                                ctx.callbackQuery.message.message_id,
                                null,
                                `📢 *ENVIANDO BROADCAST* 📤\n\n` +
                                `⏳ *PROGRESO:* ${i + 1}/${totalUsers}\n` +
                                `✅ Enviados: ${successCount}\n` +
                                `❌ Fallados: ${failCount}`,
                                { parse_mode: 'Markdown' }
                            );
                        }
                        
                        await new Promise(resolve => setTimeout(resolve, 100));
                        
                    } catch (error) {
                        console.error(`Error enviando broadcast a ${user.telegram_id}:`, error.message);
                        failCount++;
                    }
                }
                
                delete ctx.session.pendingBroadcast;
                
                const menu = crearMenuPrincipal(userId, ctx.from.first_name);
                
                await ctx.editMessageText(
                    `✅ *BROADCAST COMPLETADO* 📤\n\n` +
                    `📊 *ESTADÍSTICAS:*\n` +
                    `• Total de usuarios: ${totalUsers}\n` +
                    `• Mensajes enviados: ${successCount}\n` +
                    `• Mensajes fallados: ${failCount}\n` +
                    `• Tasa de éxito: ${((successCount / totalUsers) * 100).toFixed(1)}%\n\n` +
                    menu.mensaje,
                    { 
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: menu.teclado
                        }
                    }
                );
                
                break;
        }
        
        await ctx.answerCbQuery();
    } catch (error) {
        console.error('Error en callback_query:', error);
        await ctx.answerCbQuery('❌ Error al procesar la solicitud');
    }
});

// ==================== INICIAR BOT ====================

async function startBot() {
    try {
        await bot.launch();
        console.log('🤖 Bot de Telegram iniciado correctamente');
        console.log(`👑 Admins configurados: ${ADMIN_IDS.join(', ')}`);
        console.log(`🆘 Soporte configurado: @L0quen2`);
        console.log(`📢 Broadcast disponible para admins`);
        console.log(`🎯 Menú principal con todos los botones visibles`);
        
        await bot.telegram.setMyCommands([
            { command: 'start', description: 'Iniciar el bot y ver menú principal' },
            { command: 'help', description: 'Ayuda y información' }
        ]);
        
        startBotKeepAlive();
        
    } catch (error) {
        console.error('Error al iniciar el bot:', error);
    }
}

module.exports = {
    bot,
    startBot,
    isAdmin,
    ADMIN_IDS,
    calcularDiasRestantes,
    formatearFecha
};
