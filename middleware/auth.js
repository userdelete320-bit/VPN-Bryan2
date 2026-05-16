const jwt = require('jsonwebtoken');
require('dotenv').config();

// Middleware para verificar token JWT
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Token de autenticación requerido' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Token inválido o expirado' });
        }
        req.user = user;
        next();
    });
};

// Middleware para verificar si es administrador
const isAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Acceso denegado: se requieren privilegios de administrador' });
    }
    next();
};

// Middleware para verificar secret key de admin
const verifyAdminSecret = (req, res, next) => {
    const { secretKey } = req.body;

    if (!secretKey || secretKey !== process.env.ADMIN_SECRET_KEY) {
        return res.status(401).json({ error: 'Clave secreta de administrador incorrecta' });
    }
    next();
};

// Generar token JWT
const generateToken = (user) => {
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            role: user.role || 'admin'
        },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
    );
};

module.exports = {
    authenticateToken,
    isAdmin,
    verifyAdminSecret,
    generateToken
};
