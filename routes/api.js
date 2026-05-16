const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { userService, paymentService } = require('../supabase');

// Configurar multer para subir archivos
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = 'uploads/';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: parseInt(process.env.MAX_FILE_SIZE || 5242880) // 5MB
    },
    fileFilter: function (req, file, cb) {
        const allowedTypes = (process.env.ALLOWED_FILE_TYPES || 'image/jpeg,image/png,image/gif,application/pdf').split(',');
        
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Tipo de archivo no permitido. Solo se permiten imágenes JPG, PNG, GIF o PDF.'));
        }
    }
});

// Ruta para aceptar términos
router.post('/accept-terms', async (req, res) => {
    try {
        const { telegramId, username, firstName } = req.body;

        if (!telegramId) {
            return res.status(400).json({ error: 'ID de Telegram requerido' });
        }

        const userData = {
            telegram_id: telegramId,
            username: username,
            first_name: firstName,
            accepted_terms: true,
            terms_date: new Date().toISOString(),
            created_at: new Date().toISOString()
        };

        const user = await userService.upsertUser(telegramId, userData);
        
        res.json({ 
            success: true, 
            message: 'Términos aceptados correctamente',
            user: user
        });
    } catch (error) {
        console.error('Error al aceptar términos:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Ruta para verificar si el usuario aceptó los términos
router.get('/check-terms/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const hasAccepted = await userService.hasAcceptedTerms(telegramId);
        
        res.json({ accepted: hasAccepted });
    } catch (error) {
        console.error('Error al verificar términos:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Ruta para procesar pago
router.post('/payment', upload.single('screenshot'), async (req, res) => {
    try {
        const { telegramId, plan, price, notes } = req.body;

        if (!telegramId || !plan || !price) {
            return res.status(400).json({ error: 'Faltan campos requeridos' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'Captura de pantalla requerida' });
        }

        // Verificar que el usuario haya aceptado los términos
        const hasAccepted = await userService.hasAcceptedTerms(telegramId);
        if (!hasAccepted) {
            return res.status(403).json({ error: 'Debes aceptar los términos primero' });
        }

        // Crear el registro de pago
        const paymentData = {
            telegram_id: telegramId,
            plan: plan,
            price: parseFloat(price),
            screenshot_url: `/uploads/${req.file.filename}`,
            notes: notes || '',
            status: 'pending',
            created_at: new Date().toISOString()
        };

        const payment = await paymentService.createPayment(paymentData);

        // Aquí podrías notificar al grupo de administradores
        // await notifyAdminsAboutNewPayment(payment);

        res.json({ 
            success: true, 
            message: 'Pago registrado correctamente. Será verificado en breve.',
            paymentId: payment.id
        });
    } catch (error) {
        console.error('Error al procesar pago:', error);
        
        // Eliminar archivo si hubo error
        if (req.file && req.file.path) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('Error al eliminar archivo:', err);
            });
        }

        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'El archivo es demasiado grande. Máximo 5MB.' });
        } else if (error.message.includes('Tipo de archivo no permitido')) {
            return res.status(400).json({ error: error.message });
        }

        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Ruta para obtener información del usuario
router.get('/user/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const user = await userService.getUserByTelegramId(telegramId);
        
        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        // No enviar información sensible
        const userInfo = {
            telegram_id: user.telegram_id,
            username: user.username,
            first_name: user.first_name,
            vip: user.vip,
            vip_since: user.vip_since,
            plan: user.plan
        };

        res.json(userInfo);
    } catch (error) {
        console.error('Error al obtener usuario:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Ruta de verificación de servidor
router.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        service: 'VPN Cuba API'
    });
});

module.exports = router;
