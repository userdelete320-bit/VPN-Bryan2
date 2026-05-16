const { exec } = require('child_process');
const fs = require('fs');
const http = require('http');

class BotMonitor {
  constructor() {
    this.checkInterval = 5 * 60 * 1000; // 5 minutos
    this.restartAttempts = 0;
    this.maxRestartAttempts = 5;
    this.logFile = 'monitor.log';
    this.lastHealthCheck = null;
    
    // Crear directorio de logs si no existe
    if (!fs.existsSync('logs')) {
      fs.mkdirSync('logs', { recursive: true });
    }
  }

  log(message, type = 'info') {
    const timestamp = new Date().toLocaleString();
    const typePrefix = type === 'error' ? '❌' : type === 'warn' ? '⚠️' : '📝';
    const logMessage = `[${timestamp}] ${typePrefix} ${message}`;
    
    console.log(logMessage);
    
    // Guardar en archivo
    const fileMessage = `[${timestamp}] [${type.toUpperCase()}] ${message}\n`;
    fs.appendFileSync(`logs/${this.logFile}`, fileMessage, 'utf8');
    
    // Rotar logs si son muy grandes (>10MB)
    this.rotateLogs();
  }

  rotateLogs() {
    const logPath = `logs/${this.logFile}`;
    if (fs.existsSync(logPath)) {
      const stats = fs.statSync(logPath);
      if (stats.size > 10 * 1024 * 1024) { // 10MB
        const backupName = `logs/${this.logFile}.${Date.now()}.bak`;
        fs.renameSync(logPath, backupName);
        this.log('Log rotado por tamaño', 'info');
      }
    }
  }

  async checkHealth() {
    return new Promise((resolve) => {
      const options = {
        hostname: 'localhost',
        port: process.env.PORT || 3000,
        path: '/api/health',
        method: 'GET',
        timeout: 10000
      };

      const startTime = Date.now();
      const req = http.request(options, (res) => {
        const responseTime = Date.now() - startTime;
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const jsonData = JSON.parse(data);
            if (res.statusCode === 200 && jsonData.status === 'OK') {
              this.log(`✅ Bot saludable (${responseTime}ms): ${jsonData.message}`);
              this.restartAttempts = 0;
              this.lastHealthCheck = new Date();
              resolve({
                healthy: true,
                responseTime,
                data: jsonData
              });
            } else {
              this.log(`⚠️ Respuesta inesperada: ${res.statusCode}`, 'warn');
              resolve({
                healthy: false,
                error: `Status ${res.statusCode}`
              });
            }
          } catch (error) {
            this.log(`❌ Error parseando JSON: ${error.message}`, 'error');
            resolve({
              healthy: false,
              error: 'Parse error'
            });
          }
        });
      });

      req.on('error', (error) => {
        this.log(`❌ Error de conexión: ${error.message}`, 'error');
        resolve({
          healthy: false,
          error: error.message
        });
      });

      req.on('timeout', () => {
        this.log('⏰ Timeout (10s) al verificar salud', 'warn');
        req.destroy();
        resolve({
          healthy: false,
          error: 'Timeout'
        });
      });

      req.end();
    });
  }

  async restartBot() {
    return new Promise((resolve) => {
      this.restartAttempts++;
      this.log(`🔄 Reinicio ${this.restartAttempts}/${this.maxRestartAttempts}`, 'warn');
      
      exec('npm run pm2-restart', { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          this.log(`❌ Error al reiniciar: ${error.message}`, 'error');
          if (stderr) this.log(`STDERR: ${stderr}`, 'error');
          
          // Intentar método alternativo
          this.alternativeRestart().then(resolve).catch(() => resolve(false));
        } else {
          this.log(`✅ Reinicio exitoso`, 'info');
          if (stdout.trim()) this.log(`Output: ${stdout.substring(0, 200)}`, 'info');
          resolve(true);
        }
      });
    });
  }

  async alternativeRestart() {
    return new Promise((resolve) => {
      this.log('🔄 Intentando método alternativo de reinicio...', 'warn');
      
      // Matar proceso y reiniciar
      exec('pkill -f "node index.js" && sleep 2 && npm start &', { timeout: 15000 }, (error, stdout) => {
        if (error) {
          this.log(`❌ Método alternativo falló: ${error.message}`, 'error');
          resolve(false);
        } else {
          this.log(`✅ Método alternativo exitoso`, 'info');
          resolve(true);
        }
      });
    });
  }

  async monitorLoop() {
    this.log('👀 Sistema de monitoreo iniciado', 'info');
    this.log(`🔧 Intervalo de verificación: ${this.checkInterval / 60000} minutos`, 'info');
    
    // Verificación inicial
    setTimeout(async () => {
      await this.checkHealth();
    }, 5000);
    
    // Loop principal
    setInterval(async () => {
      const health = await this.checkHealth();
      
      if (!health.healthy && this.restartAttempts < this.maxRestartAttempts) {
        this.log('⚠️ Bot no saludable, procediendo a reinicio...', 'warn');
        const restartSuccess = await this.restartBot();
        
        if (restartSuccess) {
          // Esperar 30 segundos después del reinicio para verificar
          setTimeout(async () => {
            const postRestartHealth = await this.checkHealth();
            if (postRestartHealth.healthy) {
              this.log('✅ Bot recuperado exitosamente después del reinicio', 'info');
            } else {
              this.log('❌ Bot sigue sin responder después del reinicio', 'error');
            }
          }, 30000);
        }
      } else if (!health.healthy) {
        this.log(`🚨 CRÍTICO: Máximo de reinicios alcanzado (${this.maxRestartAttempts})`, 'error');
        this.log('🚨 Se requiere intervención manual inmediata', 'error');
        
        // Intentar notificar por algún medio (podrías agregar Telegram aquí)
        this.sendAlert();
      }
    }, this.checkInterval);
  }

  sendAlert() {
    // Aquí puedes agregar notificaciones (Telegram, email, etc.)
    this.log('🚨 ALERTA: Bot inactivo después de múltiples reinicios', 'error');
    // Ejemplo para Telegram:
    // fetch('https://api.telegram.org/botTOKEN/sendMessage?chat_id=ID&text=ALERTA: Bot caído')
  }

  checkSystemResources() {
    const memoryUsage = process.memoryUsage();
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    const memUsedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
    const memTotalMB = Math.round(memoryUsage.heapTotal / 1024 / 1024);
    const rssMB = Math.round(memoryUsage.rss / 1024 / 1024);
    
    this.log(`📊 Estado del sistema:`, 'info');
    this.log(`   ⏰ Uptime: ${hours}h ${minutes}m`, 'info');
    this.log(`   💾 RAM: ${memUsedMB}/${memTotalMB}MB (${Math.round(memUsedMB/memTotalMB*100)}%)`, 'info');
    this.log(`   📈 RSS: ${rssMB}MB`, 'info');
    
    // Alerta si usa mucha memoria
    if (memUsedMB > 500) {
      this.log(`⚠️ Alto uso de memoria: ${memUsedMB}MB`, 'warn');
    }
    
    if (this.lastHealthCheck) {
      const minutesSince = Math.floor((new Date() - this.lastHealthCheck) / 60000);
      this.log(`   🩺 Último check salud: hace ${minutesSince} minutos`, 'info');
    }
  }

  start() {
    this.log('🚀 Iniciando VPN Bot Monitor System', 'info');
    
    // Verificar recursos del sistema cada hora
    setInterval(() => {
      this.checkSystemResources();
    }, 60 * 60 * 1000);
    
    // Verificar inmediatamente
    setTimeout(() => this.checkSystemResources(), 10000);
    
    // Iniciar loop de monitoreo
    this.monitorLoop();
    
    // Manejar cierre limpio
    process.on('SIGINT', () => {
      this.log('👋 Monitor deteniéndose...', 'info');
      process.exit(0);
    });
    
    process.on('uncaughtException', (error) => {
      this.log(`💥 Error no capturado: ${error.message}`, 'error');
      this.log(`Stack: ${error.stack}`, 'error');
    });
  }
}

// Iniciar si se ejecuta directamente
if (require.main === module) {
  const monitor = new BotMonitor();
  monitor.start();
}

module.exports = BotMonitor;
