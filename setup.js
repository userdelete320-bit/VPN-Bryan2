#!/usr/bin/env node

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
require('dotenv').config();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function askQuestion(question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer.trim());
        });
    });
}

async function setupProject() {
    console.log('🚀 Configuración inicial de VPN Cuba Backend\n');
    
    // Crear archivo .env si no existe
    if (!fs.existsSync('.env')) {
        console.log('📝 Creando archivo .env...');
        
        const envConfig = {
            SUPABASE_URL: await askQuestion('1. URL de Supabase: '),
            SUPABASE_ANON_KEY: await askQuestion('2. Anon Key de Supabase: '),
            SUPABASE_SERVICE_ROLE_KEY: await askQuestion('3. Service Role Key de Supabase: '),
            BOT_TOKEN: await askQuestion('4. Token del Bot de Telegram: '),
            ADMIN_TELEGRAM_ID: await askQuestion('5. Tu ID de Telegram (admin): '),
            ADMIN_GROUP_ID: await askQuestion('6. ID del grupo de administradores (opcional): '),
            PORT: await askQuestion('7. Puerto del servidor (default 3000): ') || '3000',
            NODE_ENV: 'production',
            WEBAPP_URL: await askQuestion('8. URL de tu WebApp (ej: https://tudominio.com): '),
            JWT_SECRET: require('crypto').randomBytes(64).toString('hex'),
            ADMIN_SECRET_KEY: require('crypto').randomBytes(32).toString('hex'),
            ADMIN_USERNAME: 'admin',
            ADMIN_PASSWORD: await askQuestion('9. Contraseña para el administrador: '),
            MAX_FILE_SIZE: '5242880',
            ALLOWED_FILE_TYPES: 'image/jpeg,image/png,image/gif,application/pdf'
        };
        
        let envContent = '';
        for (const [key, value] of Object.entries(envConfig)) {
            envContent += `${key}=${value}\n`;
        }
        
        fs.writeFileSync('.env', envContent);
        console.log('✅ Archivo .env creado correctamente');
    } else {
        console.log('ℹ️  El archivo .env ya existe, omitiendo creación...');
    }
    
    // Crear directorios necesarios
    const directories = ['uploads', 'public'];
    directories.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`✅ Directorio ${dir} creado`);
        }
    });
    
    // Instalar dependencias
    console.log('\n📦 Instalando dependencias...');
    exec('npm install', (error, stdout, stderr) => {
        if (error) {
            console.error(`❌ Error instalando dependencias: ${error}`);
            return;
        }
        console.log(stdout);
        console.log('✅ Dependencias instaladas correctamente');
        
        // Ejecutar SQL en Supabase
        console.log('\n📊 Ejecutando SQL en Supabase...');
        console.log('ℹ️  Por favor, ejecuta el archivo SQL proporcionado en el editor SQL de Supabase');
        console.log('ℹ️  Puedes encontrar el SQL en el archivo: docs/supabase-schema.sql');
        
        // Crear administrador inicial
        console.log('\n👑 Creando administrador inicial...');
        console.log('ℹ️  Usa estas credenciales para iniciar sesión en el panel:');
        console.log(`   Usuario: admin`);
        console.log(`   Contraseña: ${process.env.ADMIN_PASSWORD || 'La que configuraste'}`);
        console.log(`   Clave secreta: ${process.env.ADMIN_SECRET_KEY}`);
        
        // Mensaje final
        console.log('\n🎉 ¡Configuración completada!');
        console.log('\n📋 Pasos siguientes:');
        console.log('1. Ejecuta el SQL en Supabase');
        console.log('2. Configura el bot de Telegram con @BotFather');
        console.log('   - Usa el comando /setcommands');
        console.log('   - Configura la WebApp con la URL de tu servidor');
        console.log('3. Inicia el servidor: npm start');
        console.log('4. Accede al panel: http://localhost:3000/admin.html');
        
        rl.close();
    });
}

// Ejecutar configuración
setupProject().catch(console.error);
