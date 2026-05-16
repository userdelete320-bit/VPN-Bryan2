# Crear un archivo start-all.js
const { exec } = require('child_process');
const fs = require('fs');

console.log('🚀 Iniciando VPN Bot System...');

// Iniciar el bot con PM2
exec('npm run pm2-start', (error, stdout, stderr) => {
  if (error) {
    console.error('❌ Error iniciando bot:', error);
    return;
  }
  
  console.log('✅ Bot iniciado:', stdout);
  
  // Iniciar monitor después de 10 segundos
  setTimeout(() => {
    console.log('👀 Iniciando monitor...');
    const BotMonitor = require('./monitor');
    const monitor = new BotMonitor();
    monitor.start();
    
    console.log('🎯 Sistema completamente operativo');
  }, 10000);
});
