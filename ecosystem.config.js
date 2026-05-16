module.exports = {
  apps: [{
    name: 'vpn-bot',
    script: 'index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    env_development: {
      NODE_ENV: 'development',
      PORT: 3000
    },
    error_file: 'logs/err.log',
    out_file: 'logs/out.log',
    log_file: 'logs/combined.log',
    time: true,
    // Configuración de restart
    exp_backoff_restart_delay: 100,
    max_restarts: 10,
    min_uptime: '10s',
    // Kill timeout
    kill_timeout: 5000,
    // Listen timeout para el bot
    listen_timeout: 10000,
    // Auto restart si usa mucha memoria
    max_memory_restart: '800M',
    // Scripts de lifecycle
    pre_start: 'echo "Iniciando VPN Bot..."',
    post_start: 'echo "VPN Bot iniciado correctamente"',
    pre_restart: 'echo "Reiniciando VPN Bot..."',
    post_restart: 'echo "VPN Bot reiniciado correctamente"',
    pre_stop: 'echo "Deteniendo VPN Bot..."',
    // Variables específicas
    node_args: '--max-old-space-size=1024'
  }]
};
