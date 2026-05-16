const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { authenticateToken, isAdmin, verifyAdminSecret, generateToken } = require('../middleware/auth');
const { 
    userService, 
    paymentService, 
    configFileService, 
    adminService, 
    statsService 
} = require('../supabase');
require('dotenv').config();

// Login de administrador
router.post('/login', verifyAdminSecret, async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
        }

        // Verificar credenciales
        const isValid = await adminService.verifyAdmin(username, password);
        
        if (!isValid) {
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }

        // Generar token JWT
        const token = generateToken({
            id: 'admin-' + username,
            username: username,
            role: 'admin'
        });

        res.json({ 
            success: true, 
            token: token,
            user: { username, role: 'admin' }
        });
    } catch (error) {
        console.error('Error en login de admin:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Verificar token
router.get('/verify', authenticateToken, isAdmin, (req, res) => {
    res.json({ 
        valid: true, 
        user: req.user 
    });
});

// Obtener pagos pendientes
router.get('/payments/pending', authenticateToken, isAdmin, async (req, res) => {
    try {
        const payments = await paymentService.getPendingPayments();
        res.json(payments);
    } catch (error) {
        console.error('Error al obtener pagos pendientes:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Aprobar pago
router.post('/payments/:id/approve', authenticateToken, isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { adminNotes = '' } = req.body;

        const payment = await paymentService.approvePayment(id, adminNotes);
        
        // Actualizar usuario a VIP
        if (payment) {
            await userService.setUserVIP(payment.telegram_id, payment.plan, payment.price);
        }

        res.json({ 
            success: true, 
            message: 'Pago aprobado correctamente',
            payment: payment
        });
    } catch (error) {
        console.error('Error al aprobar pago:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Rechazar pago
router.post('/payments/:id/reject', authenticateToken, isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        if (!reason) {
            return res.status(400).json({ error: 'Motivo del rechazo requerido' });
        }

        const payment = await paymentService.rejectPayment(id, reason);
        
        res.json({ 
            success: true, 
            message: 'Pago rechazado correctamente',
            payment: payment
        });
    } catch (error) {
        console.error('Error al rechazar pago:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Buscar usuario
router.get('/users/search', authenticateToken, isAdmin, async (req, res) => {
    try {
        const { q } = req.query;

        if (!q) {
            return res.json(null);
        }

        const users = await userService.searchUser(q);
        res.json(users[0] || null);
    } catch (error) {
        console.error('Error al buscar usuario:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Enviar archivo de configuración
router.post('/send-config', authenticateToken, isAdmin, async (req, res) => {
    try {
        const { telegramId, fileId, fileName, notes } = req.body;

        if (!telegramId || !fileId || !fileName) {
            return res.status(400).json({ error: 'Faltan campos requeridos' });
        }

        const fileData = {
            telegram_id: telegramId,
            file_id: fileId,
            file_name: fileName,
            sent_by: req.user.username || 'admin',
            notes: notes || ''
        };

        const configFile = await configFileService.saveConfigFile(fileData);
        
        res.json({ 
            success: true, 
            message: 'Archivo de configuración registrado',
            configFile: configFile
        });
    } catch (error) {
        console.error('Error al enviar configuración:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Obtener estadísticas
router.get('/stats', authenticateToken, isAdmin, async (req, res) => {
    try {
        const stats = await statsService.getStats();
        res.json(stats);
    } catch (error) {
        console.error('Error al obtener estadísticas:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Obtener usuarios VIP
router.get('/vip-users', authenticateToken, isAdmin, async (req, res) => {
    try {
        const users = await userService.getVIPUsers();
        res.json(users);
    } catch (error) {
        console.error('Error al obtener usuarios VIP:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Buscar pagos
router.get('/payments/search', authenticateToken, isAdmin, async (req, res) => {
    try {
        const { q } = req.query;
        const payments = await paymentService.searchPayments(q || '');
        res.json(payments);
    } catch (error) {
        console.error('Error al buscar pagos:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Remover usuario VIP
router.post('/users/:telegramId/remove-vip', authenticateToken, isAdmin, async (req, res) => {
    try {
        const { telegramId } = req.params;

        const user = await userService.getUserByTelegramId(telegramId);
        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        const updatedUser = await userService.upsertUser(telegramId, {
            vip: false,
            vip_since: null,
            plan: null,
            plan_price: null
        });

        res.json({ 
            success: true, 
            message: 'Usuario removido de VIP',
            user: updatedUser
        });
    } catch (error) {
        console.error('Error al remover VIP:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Crear administrador (solo para configuración inicial)
router.post('/create-admin', verifyAdminSecret, async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
        }

        // En producción, usar bcrypt para hashear la contraseña
        const adminData = {
            username: username,
            password_hash: password // En producción, usar bcrypt.hashSync(password, 10)
        };

        const admin = await adminService.createAdmin(adminData);
        
        res.json({ 
            success: true, 
            message: 'Administrador creado correctamente',
            admin: { username: admin.username }
        });
    } catch (error) {
        console.error('Error al crear administrador:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
