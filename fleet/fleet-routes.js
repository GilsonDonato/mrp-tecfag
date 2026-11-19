const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const os = require('os');
const qrGenerator = require('./qrcode');

function detectLocalLanIp() {
    try {
        const nets = os.networkInterfaces();
        let fallbackIp = null;
        for (const name of Object.keys(nets)) {
            for (const net of (nets[name] || [])) {
                if ((net.family === 'IPv4' || net.family === 4) && !net.internal) {
                    if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(net.address)) {
                        return net.address;
                    }
                    if (!fallbackIp) fallbackIp = net.address;
                }
            }
        }
        return fallbackIp;
    } catch (e) {
        return null;
    }
}

/**
 * Módulo Isolado de Gestão de Frota Tecfag (Opção A -> Pronto para Opção B)
 * - Banco SQLite próprio: tecfag_frota.db (Modo WAL, sem tocar em projects/stock_orders do MRP)
 * - Pasta de fotos própria: uploads_frota (com disjuntor de 200 MB livres p/ proteger o MRP)
 * - Retenção inteligente de fotos normais (padrão 45 dias; fotos com avaria/travadas nunca apagam)
 * - Telemetria GPS pronta para rastreadores 4G (J16 / Suntech / Teltonika via Flespi ou Traccar)
 */
module.exports = function registerFleetModule({
    app,
    mrpDb,
    authenticateToken,
    hashPassword,
    DB_DIR,
    getDirectorySize
}) {
    const FLEET_DB_PATH = process.env.FLEET_DATABASE_PATH || path.join(DB_DIR, 'tecfag_frota.db');
    const FLEET_UPLOADS_DIR = process.env.FLEET_UPLOADS_PATH || path.join(DB_DIR, 'uploads_frota');
    const FLEET_BACKUPS_DIR = path.join(DB_DIR, 'backups');

    // Limite total do disco persistente no Render (padrão 1 GB conforme render.yaml) e reserva sagrada de 200 MB p/ o MRP
    const TOTAL_DISK_LIMIT_BYTES = (parseFloat(process.env.FLEET_DISK_TOTAL_GB) || 1) * 1024 * 1024 * 1024;
    const MRP_RESERVED_FREE_BYTES = 200 * 1024 * 1024; // 200 MB intocáveis para o MRP

    [DB_DIR, FLEET_UPLOADS_DIR, FLEET_BACKUPS_DIR].forEach((dir) => {
        if (!fs.existsSync(dir)) {
            try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
        }
    });

    const fleetDb = new sqlite3.Database(FLEET_DB_PATH, (err) => {
        if (err) {
            console.error('[FROTA DB] Erro ao abrir tecfag_frota.db:', err.message);
        } else {
            console.log('[FROTA DB] Conectado com sucesso ao banco isolado de frota:', FLEET_DB_PATH);
            initFleetDatabase();
        }
    });

    const fGet = (sql, params = []) => new Promise((resolve, reject) => {
        fleetDb.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
    const fAll = (sql, params = []) => new Promise((resolve, reject) => {
        fleetDb.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
    });
    const fRun = (sql, params = []) => new Promise((resolve, reject) => {
        fleetDb.run(sql, params, function (err) {
            err ? reject(err) : resolve(this);
        });
    });

    const mrpAll = (sql, params = []) => new Promise((resolve) => {
        if (!mrpDb) return resolve([]);
        mrpDb.all(sql, params, (err, rows) => resolve(err ? [] : (rows || [])));
    });
    const mrpGet = (sql, params = []) => new Promise((resolve) => {
        if (!mrpDb) return resolve(null);
        mrpDb.get(sql, params, (err, row) => resolve(err ? null : row));
    });

    // Mapa amigável dos usuários reais do MRP Tecfag
    const USER_DISPLAY_NAMES = {
        'admin': 'Administrador',
        'gilson': 'Gilson (Diretoria)',
        'gilson@tecfag.com.br': 'Gilson (Diretoria)',
        'fernando': 'Fernando (Engenharia)',
        'fernando@tecfag.com.br': 'Fernando (Engenharia)',
        'engenharia': 'Equipe Engenharia',
        'vendas': 'Diana (Vendas)',
        'vendas1': 'Alex (Vendas)',
        'vendas2': 'Jhordan (Vendas)',
        'vendas3': 'Nardeli (Vendas)',
        'vendas4': 'Lucas (Vendas)',
        'vendas6': 'Patrícia (Gestão de Frota)',
        'vendas6@tecfag.com.br': 'Patrícia (Gestão de Frota)',
        'patricia': 'Patrícia (Gestão de Frota)',
        'heilio': 'Heilio (Assistência)',
        'assistencia6@tecfag.com.br': 'Heilio (Assistência)',
        'suporte2': 'Tarcísio (Suporte)',
        'suporte2@tecfag.com.br': 'Tarcísio (Suporte)',
        'jhenifer': 'Jhenifer (Compras/Adm)',
        'adm@tecfag.com.br': 'Jhenifer (Compras/Adm)',
        'jerlayne': 'Jerlayne (RH • CNH & Multas)',
        'joao.lanza': 'João Lanza (Diretor)',
        'gerente': 'Gerente de Projetos',
        'gerente_comercial': 'Gerente Comercial',
        'comercial': 'Comercial',
        'compras': 'Setor de Compras',
        'estoque': 'Almoxarifado / Estoque',
        'tecnico': 'Equipe Técnica',
        'rh': 'Jerlayne / RH Tecfag'
    };

    const GENERIC_SHARED_LOGINS = new Set([
        'admin', 'engenharia', 'compras', 'estoque', 'tecnico', 'gerente', 'gerente_comercial', 'comercial', 'rh'
    ]);

    function getFriendlyUserName(username) {
        if (!username) return 'Usuário';
        const clean = String(username).toLowerCase().trim();
        return USER_DISPLAY_NAMES[clean] || username;
    }

    function isRhFleetUser(user) {
        if (!user) return false;
        const role = String(user.role || '').toUpperCase();
        const uname = String(user.username || '').toLowerCase().trim();
        return role === 'RH' || uname === 'jerlayne' || uname === 'lerlayne' || uname === 'rh' || uname === 'rh@tecfag.com.br';
    }

    function canManageVehiclesAndReservations(user) {
        if (!user) return false;
        const role = String(user.role || '').toUpperCase();
        const uname = String(user.username || '').toLowerCase().trim();
        return (
            role === 'ALL' ||
            role === 'DIRETOR' ||
            role === 'GERENTE' ||
            uname === 'gilson' ||
            uname === 'gilson@tecfag.com.br' ||
            uname === 'patricia' ||
            uname === 'vendas6' ||
            uname === 'vendas6@tecfag.com.br' ||
            uname === 'adm@tecfag.com.br' ||
            uname === 'jhenifer' ||
            uname === 'admin'
        );
    }

    function isFleetManagerUser(user) {
        return canManageVehiclesAndReservations(user) || isRhFleetUser(user);
    }

    function requireFleetManager(req, res, next) {
        if (isFleetManagerUser(req.user)) return next();
        return res.status(403).json({
            error: 'Acesso restrito à Diretoria / Gestão de Frota / RH. Para retirar ou devolver veículos, use o painel /motorista.'
        });
    }

    function requireVehicleReservationManager(req, res, next) {
        if (canManageVehiclesAndReservations(req.user)) return next();
        return res.status(403).json({
            error: 'Aprovação de reservas e gestão direta dos veículos é responsabilidade de Patrícia / Diretoria.'
        });
    }

    function hashFleetPin(pin) {
        return crypto.createHash('sha256').update('tecfag_fleet_pin:' + String(pin).trim()).digest('hex');
    }

    function computeCnhStatus(expiryDateStr) {
        if (!expiryDateStr) return { status: 'UNKNOWN', daysLeft: null };
        const todayStr = new Date().toISOString().slice(0, 10);
        const expMs = new Date(expiryDateStr + 'T23:59:59').getTime();
        const nowMs = new Date(todayStr + 'T12:00:00').getTime();
        const daysLeft = Math.ceil((expMs - nowMs) / (24 * 60 * 60 * 1000));
        if (expiryDateStr < todayStr) return { status: 'EXPIRED', daysLeft };
        if (daysLeft <= 45) return { status: 'EXPIRING_SOON', daysLeft };
        return { status: 'VALID', daysLeft };
    }

    function extractCookieToken(req) {
        const raw = req.headers && req.headers.cookie;
        if (!raw) return null;
        const m = raw.match(/(?:^|;\s*)tecfag_fleet_device=([a-f0-9]{32,128})/i);
        return m ? m[1] : null;
    }

    function setDeviceCookie(res, token) {
        res.setHeader(
            'Set-Cookie',
            `tecfag_fleet_device=${token}; Max-Age=31536000; Path=/; SameSite=Lax`
        );
    }

    // Autenticação híbrida: aceita Crachá Digital Permanente do aparelho (Cookie/Token 365d) OU sessão do MRP
    async function authenticateFleet(req, res, next) {
        const authHeader = req.headers['authorization'];
        let token = authHeader && authHeader.split(' ')[1];
        if (!token) token = req.headers['x-access-token'] || req.query.token || extractCookieToken(req);

        if (token) {
            try {
                const drvSession = await fGet(
                    `SELECT s.token, s.expires_at, d.*
                     FROM fleet_driver_sessions s
                     JOIN fleet_drivers d ON s.driver_id = d.id
                     WHERE s.token = ?`,
                    [token]
                );
                if (drvSession) {
                    const now = new Date();
                    const exp = new Date(drvSession.expires_at);
                    if (exp < now) {
                        await fRun('DELETE FROM fleet_driver_sessions WHERE token = ?', [token]);
                        return res.status(401).json({ error: 'Sessão expirada. Identifique seu aparelho novamente.' });
                    }
                    if (drvSession.active === 0) {
                        return res.status(403).json({ error: 'Condutor desativado pela gestão de frota.' });
                    }
                    // Renovação automática contínua de 365 dias a cada uso!
                    if ((exp.getTime() - now.getTime()) < 330 * 24 * 60 * 60 * 1000) {
                        const nextYear = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
                        await fRun('UPDATE fleet_driver_sessions SET expires_at = ? WHERE token = ?', [nextYear, token]).catch(() => {});
                        setDeviceCookie(res, token);
                    }
                    req.fleetDriver = drvSession;
                    req.fleetToken = token;
                    req.user = {
                        username: drvSession.mrp_username || drvSession.login_key,
                        role: drvSession.login_key === 'gilson' ? 'ALL' : 'MOTORISTA_FROTA'
                    };
                    return next();
                }
            } catch (e) {}
        }

        return authenticateToken(req, res, async () => {
            try {
                if (req.user && req.user.username) {
                    const u = String(req.user.username).toLowerCase().trim();
                    const linkedDriver = await fGet(
                        `SELECT * FROM fleet_drivers
                         WHERE LOWER(mrp_username) = ? OR LOWER(login_key) = ? LIMIT 1`,
                        [u, u]
                    );
                    if (linkedDriver) req.fleetDriver = linkedDriver;
                }
            } catch (e) {}
            next();
        });
    }

    function asyncSafe(handler) {
        return async (req, res, next) => {
            try {
                await handler(req, res, next);
            } catch (err) {
                console.error('[FROTA API ERROR]:', err);
                if (!res.headersSent) {
                    res.status(500).json({ error: err.message || 'Erro interno no módulo de frota.' });
                }
            }
        };
    }

    // Cálculo de distância em metros (Haversine) para cerca virtual do pátio e auditoria de pernoite
    function haversineMeters(lat1, lon1, lat2, lon2) {
        if ([lat1, lon1, lat2, lon2].some(v => v === null || v === undefined || isNaN(parseFloat(v)))) return null;
        const R = 6371000;
        const toRad = (deg) => (deg * Math.PI) / 180;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function checkDiskSafetyBreaker() {
        let totalUsed = 0;
        let fleetUploadsBytes = 0;
        let fleetDbBytes = 0;
        try {
            totalUsed = typeof getDirectorySize === 'function' ? getDirectorySize(DB_DIR) : 0;
            fleetUploadsBytes = typeof getDirectorySize === 'function' ? getDirectorySize(FLEET_UPLOADS_DIR) : 0;
            if (fs.existsSync(FLEET_DB_PATH)) {
                fleetDbBytes = fs.statSync(FLEET_DB_PATH).size;
            }
        } catch (e) {}
        const freeBytes = Math.max(0, TOTAL_DISK_LIMIT_BYTES - totalUsed);
        const breakerTripped = freeBytes < MRP_RESERVED_FREE_BYTES;
        return {
            totalLimitBytes: TOTAL_DISK_LIMIT_BYTES,
            totalUsedBytes: totalUsed,
            fleetUploadsBytes,
            fleetDbBytes,
            freeBytes,
            reservedMrpBytes: MRP_RESERVED_FREE_BYTES,
            usedPercent: Math.min(100, Math.round((totalUsed / TOTAL_DISK_LIMIT_BYTES) * 1000) / 10),
            breakerTripped
        };
    }

    function initFleetDatabase() {
        fleetDb.serialize(() => {
            fleetDb.run('PRAGMA journal_mode = WAL;');
            fleetDb.run('PRAGMA busy_timeout = 5000;');
            fleetDb.run('PRAGMA foreign_keys = ON;');

            fleetDb.run(`CREATE TABLE IF NOT EXISTS fleet_vehicles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                brand_model TEXT NOT NULL,
                plate TEXT NOT NULL UNIQUE,
                category TEXT DEFAULT 'PASSEIO',
                color TEXT DEFAULT '',
                year TEXT DEFAULT '',
                fuel_type TEXT DEFAULT 'FLEX',
                current_km INTEGER DEFAULT 0,
                current_fuel_level INTEGER DEFAULT 100,
                status TEXT DEFAULT 'NO_PATIO',
                current_trip_id INTEGER,
                current_driver_username TEXT,
                current_driver_name TEXT,
                next_oil_km INTEGER,
                next_revision_km INTEGER,
                speed_limit_kmh INTEGER DEFAULT 110,
                tracker_imei TEXT,
                tracker_model TEXT DEFAULT 'J16 4G',
                tracker_sim_phone TEXT,
                last_lat REAL,
                last_lng REAL,
                last_speed_kmh REAL DEFAULT 0,
                last_ignition INTEGER DEFAULT 0,
                last_telemetry_at TEXT,
                known_damages_notes TEXT DEFAULT '',
                active INTEGER DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )`);

            fleetDb.run(`CREATE TABLE IF NOT EXISTS fleet_trips (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                vehicle_id INTEGER NOT NULL,
                plate TEXT NOT NULL,
                vehicle_name TEXT NOT NULL,
                driver_username TEXT NOT NULL,
                driver_name TEXT NOT NULL,
                driver_role TEXT,
                purpose_type TEXT NOT NULL,
                destination TEXT NOT NULL,
                project_code TEXT,
                status TEXT DEFAULT 'OPEN',
                checkout_at TEXT NOT NULL,
                start_km INTEGER NOT NULL,
                start_fuel_level INTEGER DEFAULT 100,
                start_cleanliness TEXT DEFAULT 'LIMPO',
                start_checklist_json TEXT,
                start_damage_reported INTEGER DEFAULT 0,
                start_damage_notes TEXT,
                start_photos_json TEXT,
                start_lat REAL,
                start_lng REAL,
                overnight_at TEXT,
                overnight_km INTEGER,
                overnight_fuel_level INTEGER,
                overnight_notes TEXT,
                overnight_photo_url TEXT,
                overnight_lat REAL,
                overnight_lng REAL,
                checkin_at TEXT,
                end_km INTEGER,
                distance_km INTEGER,
                overnight_to_yard_km INTEGER,
                end_fuel_level INTEGER,
                end_cleanliness TEXT,
                end_damage_reported INTEGER DEFAULT 0,
                end_damage_notes TEXT,
                end_photos_json TEXT,
                end_lat REAL,
                end_lng REAL,
                max_speed_kmh REAL DEFAULT 0,
                speed_alerts_count INTEGER DEFAULT 0,
                has_damage INTEGER DEFAULT 0,
                keep_forever INTEGER DEFAULT 0,
                photos_purged INTEGER DEFAULT 0,
                manager_notes TEXT,
                closed_by_manager TEXT,
                FOREIGN KEY(vehicle_id) REFERENCES fleet_vehicles(id)
            )`);

            fleetDb.run(`CREATE INDEX IF NOT EXISTS idx_fleet_trips_vehicle ON fleet_trips(vehicle_id, checkout_at DESC)`);
            fleetDb.run(`CREATE INDEX IF NOT EXISTS idx_fleet_trips_plate_time ON fleet_trips(plate, checkout_at, checkin_at)`);
            fleetDb.run(`CREATE INDEX IF NOT EXISTS idx_fleet_trips_status ON fleet_trips(status)`);

            fleetDb.run(`CREATE TABLE IF NOT EXISTS fleet_fuel_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                vehicle_id INTEGER NOT NULL,
                trip_id INTEGER,
                plate TEXT NOT NULL,
                driver_username TEXT NOT NULL,
                driver_name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                km_at_fuel INTEGER NOT NULL,
                liters REAL NOT NULL,
                total_cost_brl REAL NOT NULL,
                price_per_liter REAL,
                fuel_kind TEXT DEFAULT 'GASOLINA',
                full_tank INTEGER DEFAULT 1,
                receipt_photo_url TEXT,
                calculated_km_per_liter REAL,
                notes TEXT,
                FOREIGN KEY(vehicle_id) REFERENCES fleet_vehicles(id)
            )`);

            fleetDb.run(`CREATE TABLE IF NOT EXISTS fleet_telemetry_points (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                vehicle_id INTEGER NOT NULL,
                trip_id INTEGER,
                recorded_at TEXT NOT NULL,
                lat REAL NOT NULL,
                lng REAL NOT NULL,
                speed_kmh REAL DEFAULT 0,
                heading REAL DEFAULT 0,
                ignition INTEGER DEFAULT 1,
                source TEXT DEFAULT 'TRACKER',
                event_type TEXT DEFAULT 'POSITION',
                FOREIGN KEY(vehicle_id) REFERENCES fleet_vehicles(id)
            )`);
            fleetDb.run(`CREATE INDEX IF NOT EXISTS idx_fleet_tel_veh_time ON fleet_telemetry_points(vehicle_id, recorded_at)`);
            fleetDb.run(`CREATE INDEX IF NOT EXISTS idx_fleet_tel_trip ON fleet_telemetry_points(trip_id, recorded_at)`);

            fleetDb.run(`CREATE TABLE IF NOT EXISTS fleet_alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                vehicle_id INTEGER,
                trip_id INTEGER,
                plate TEXT,
                alert_type TEXT NOT NULL,
                severity TEXT DEFAULT 'WARNING',
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                driver_name TEXT,
                created_at TEXT NOT NULL,
                resolved INTEGER DEFAULT 0,
                resolved_by TEXT,
                resolved_at TEXT
            )`);
            fleetDb.run(`CREATE INDEX IF NOT EXISTS idx_fleet_alerts_resolved ON fleet_alerts(resolved, created_at DESC)`);

            fleetDb.run(`CREATE TABLE IF NOT EXISTS fleet_fines_occurrences (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                vehicle_id INTEGER NOT NULL,
                plate TEXT NOT NULL,
                record_type TEXT DEFAULT 'MULTA',
                occurred_at TEXT NOT NULL,
                matched_trip_id INTEGER,
                responsible_driver TEXT,
                title TEXT NOT NULL,
                location TEXT,
                amount_brl REAL DEFAULT 0,
                points_cnh INTEGER DEFAULT 0,
                km_at_service INTEGER,
                status TEXT DEFAULT 'PENDENTE',
                notes TEXT,
                created_by TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(vehicle_id) REFERENCES fleet_vehicles(id)
            )`);

            fleetDb.run(`CREATE TABLE IF NOT EXISTS fleet_drivers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                login_key TEXT NOT NULL UNIQUE,
                full_name TEXT NOT NULL,
                cpf TEXT NOT NULL UNIQUE,
                rg TEXT,
                cnh_number TEXT NOT NULL,
                cnh_category TEXT NOT NULL,
                cnh_issue_date TEXT,
                cnh_expiry_date TEXT NOT NULL,
                first_license_date TEXT,
                birth_date TEXT,
                uf_city TEXT,
                company TEXT DEFAULT 'TECFAG',
                department TEXT DEFAULT 'Operacional',
                phone TEXT,
                mrp_username TEXT,
                pin_hash TEXT NOT NULL,
                active INTEGER DEFAULT 1,
                notes TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )`);

            fleetDb.run(`CREATE TABLE IF NOT EXISTS fleet_driver_sessions (
                token TEXT PRIMARY KEY,
                driver_id INTEGER NOT NULL,
                expires_at TEXT NOT NULL,
                FOREIGN KEY(driver_id) REFERENCES fleet_drivers(id) ON DELETE CASCADE
            )`);

            fleetDb.run("ALTER TABLE fleet_trips ADD COLUMN driver_cpf TEXT", () => {});
            fleetDb.run("ALTER TABLE fleet_trips ADD COLUMN driver_cnh TEXT", () => {});

            fleetDb.run(`CREATE TABLE IF NOT EXISTS fleet_reservations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                vehicle_id INTEGER NOT NULL,
                plate TEXT NOT NULL,
                vehicle_name TEXT NOT NULL,
                driver_id INTEGER,
                driver_username TEXT NOT NULL,
                driver_name TEXT NOT NULL,
                purpose_type TEXT NOT NULL,
                destination TEXT NOT NULL,
                project_code TEXT,
                start_at TEXT NOT NULL,
                end_at TEXT NOT NULL,
                notes TEXT,
                status TEXT DEFAULT 'PENDING',
                reviewed_by TEXT,
                reviewed_at TEXT,
                manager_notes TEXT,
                fulfilled_trip_id INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(vehicle_id) REFERENCES fleet_vehicles(id)
            )`);
            fleetDb.run(`CREATE INDEX IF NOT EXISTS idx_fleet_res_veh_time ON fleet_reservations(vehicle_id, status, start_at, end_at)`);
            fleetDb.run(`CREATE INDEX IF NOT EXISTS idx_fleet_res_status ON fleet_reservations(status, start_at)`);

            fleetDb.run(`CREATE TABLE IF NOT EXISTS fleet_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )`, () => {
                seedFleetDefaults();
                runFleetMaintenance();
                setInterval(runFleetMaintenance, 24 * 60 * 60 * 1000);
            });
        });

        // Garantir login dedicado para o RH caso ainda não exista na tabela users do MRP (sem alterar usuários existentes)
        if (mrpDb && typeof hashPassword === 'function') {
            mrpDb.get("SELECT username FROM users WHERE username = 'rh'", [], (err, row) => {
                if (!err && !row) {
                    const { salt, hash } = hashPassword('rh@tecfag22');
                    mrpDb.run(
                        "INSERT INTO users (username, password_hash, salt, role) VALUES ('rh', ?, ?, 'RH')",
                        [hash, salt],
                        () => console.log('[FROTA AUTH] Usuário dedicado "rh" habilitado para check-in de frota.')
                    );
                }
            });
        }
    }

    async function seedFleetDefaults() {
        try {
            const now = new Date().toISOString();
            const initialVehicles = [
                {
                    code: 'VEIC-01',
                    name: 'Renault Kwid (UPC3J60)',
                    brand_model: 'Renault Kwid',
                    plate: 'UPC3J60',
                    category: 'PASSEIO',
                    fuel_type: 'FLEX',
                    speed_limit_kmh: 110
                },
                {
                    code: 'VEIC-02',
                    name: 'Renault Kwid (UPT3A27)',
                    brand_model: 'Renault Kwid',
                    plate: 'UPT3A27',
                    category: 'PASSEIO',
                    fuel_type: 'FLEX',
                    speed_limit_kmh: 110
                },
                {
                    code: 'VEIC-03',
                    name: 'VW Saveiro',
                    brand_model: 'Volkswagen Saveiro',
                    plate: 'TKQ9C96',
                    category: 'PICAPE',
                    fuel_type: 'FLEX',
                    speed_limit_kmh: 110
                },
                {
                    code: 'VEIC-04',
                    name: 'Peugeot 406',
                    brand_model: 'Peugeot 406',
                    plate: 'AWN9J36',
                    category: 'PASSEIO',
                    fuel_type: 'GASOLINA',
                    speed_limit_kmh: 110
                },
                {
                    code: 'VEIC-05',
                    name: 'Ducato Van',
                    brand_model: 'Fiat Ducato Van',
                    plate: 'QPW3F45',
                    category: 'FURGAO',
                    fuel_type: 'DIESEL',
                    speed_limit_kmh: 100
                },
                {
                    code: 'VEIC-06',
                    name: 'Chevrolet Montana',
                    brand_model: 'Chevrolet Montana',
                    plate: 'STC0C51',
                    category: 'PICAPE',
                    fuel_type: 'FLEX',
                    speed_limit_kmh: 110
                }
            ];

            for (const v of initialVehicles) {
                await fRun(
                    `INSERT OR IGNORE INTO fleet_vehicles (
                        code, name, brand_model, plate, category, fuel_type, speed_limit_kmh, status, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'NO_PATIO', ?, ?)`,
                    [v.code, v.name, v.brand_model, v.plate, v.category, v.fuel_type, v.speed_limit_kmh, now, now]
                );
            }

            // Condutores oficiais cadastrados via CNH Digital SENATRAN (Senha inicial no app = 6 primeiros dígitos do CPF)
            const initialDrivers = [
                {
                    login_key: 'gilson',
                    full_name: 'GILSON JOSE DONATO',
                    cpf: '14136438842',
                    rg: '21172200 SSP SP',
                    cnh_number: '01699846308',
                    cnh_category: 'AE',
                    cnh_issue_date: '2025-12-04',
                    cnh_expiry_date: '2030-12-04',
                    first_license_date: '1988-01-29',
                    birth_date: '1969-03-17',
                    uf_city: 'SAO PAULO, SP',
                    company: 'TECFAG',
                    department: 'Diretoria',
                    mrp_username: 'gilson'
                },
                {
                    login_key: 'rosenvaldo',
                    full_name: 'ROSENVALDO LUCAS',
                    cpf: '01522002820',
                    rg: '10347710X SSP SP',
                    cnh_number: '02298170069',
                    cnh_category: 'AB',
                    cnh_issue_date: '2022-06-15',
                    cnh_expiry_date: '2027-06-07',
                    first_license_date: '1979-08-23',
                    birth_date: '1961-04-21',
                    uf_city: 'BAURU, SP',
                    company: 'TECFAG',
                    department: 'Operacional',
                    mrp_username: null
                },
                {
                    login_key: 'adriano',
                    full_name: 'ADRIANO DE CARVALHO ORDONHO',
                    cpf: '35028233837',
                    rg: '40438626 SSP SP',
                    cnh_number: '03232759616',
                    cnh_category: 'AB',
                    cnh_issue_date: '2024-12-18',
                    cnh_expiry_date: '2034-12-18',
                    first_license_date: '2004-03-23',
                    birth_date: '1986-01-13',
                    uf_city: 'PEDERNEIRAS, SP',
                    company: 'TECFAG',
                    department: 'Operacional',
                    mrp_username: null
                },
                {
                    login_key: 'fernando',
                    full_name: 'FERNANDO MENDES AGUIAR',
                    cpf: '37530990829',
                    rg: '47108174 SSP SP',
                    cnh_number: '04690387241',
                    cnh_category: 'AB',
                    cnh_issue_date: '2024-03-20',
                    cnh_expiry_date: '2034-03-20',
                    first_license_date: '2009-07-03',
                    birth_date: '1990-12-20',
                    uf_city: 'BAURU, SP',
                    company: 'TECFAG',
                    department: 'Engenharia / Projetos',
                    mrp_username: 'fernando'
                },
                {
                    login_key: 'rafael',
                    full_name: 'RAFAEL BOMFIM DE OLIVEIRA',
                    cpf: '36085276800',
                    rg: '40838151 SSP SP',
                    cnh_number: '04041994888',
                    cnh_category: 'AB',
                    cnh_issue_date: '2026-09-05',
                    cnh_expiry_date: '2036-09-04',
                    first_license_date: '2007-02-21',
                    birth_date: '1988-05-30',
                    uf_city: 'SAO PAULO, SP',
                    company: 'TECFAG',
                    department: 'Operacional',
                    mrp_username: null
                },
                {
                    login_key: 'guilherme',
                    full_name: 'GUILHERME RIBEIRO CARMINATO',
                    cpf: '48426575889',
                    rg: '52548668 SSP SP',
                    cnh_number: '07222798421',
                    cnh_category: 'AB',
                    cnh_issue_date: '2023-08-11',
                    cnh_expiry_date: '2033-08-03',
                    first_license_date: '2019-03-07',
                    birth_date: '1998-11-06',
                    uf_city: 'SAO PAULO, SP',
                    company: 'TECFAG',
                    department: 'Operacional',
                    mrp_username: null
                },
                {
                    login_key: 'bruno',
                    full_name: 'BRUNO CATALANO MONTEIRO',
                    cpf: '37598936862',
                    rg: '44018859 SSP SP',
                    cnh_number: '03789728731',
                    cnh_category: 'AB',
                    cnh_issue_date: '2021-12-30',
                    cnh_expiry_date: '2031-12-30',
                    first_license_date: '2006-02-21',
                    birth_date: '1987-10-20',
                    uf_city: 'BAURU, SP',
                    company: 'TECFAG',
                    department: 'Operacional',
                    mrp_username: null
                },
                {
                    login_key: 'tiago',
                    full_name: 'TIAGO HENRIQUE SANTOS GARCIA',
                    cpf: '34229433824',
                    rg: '34384529 SSP/SP',
                    cnh_number: '03612206580',
                    cnh_category: 'AB',
                    cnh_issue_date: '2025-06-09',
                    cnh_expiry_date: '2030-05-06',
                    first_license_date: '2005-06-14',
                    birth_date: '1987-03-16',
                    uf_city: 'SAO PAULO, SP',
                    company: 'TECFAG',
                    department: 'Operacional',
                    mrp_username: null
                },
                {
                    login_key: 'alex',
                    full_name: 'RENATO ALEX LABADESSA JUNIOR',
                    cpf: '49567884870',
                    rg: '49989986 SSP SP',
                    cnh_number: '07472975508',
                    cnh_category: 'AB',
                    cnh_issue_date: '2024-07-15',
                    cnh_expiry_date: '2034-07-15',
                    first_license_date: '2020-10-06',
                    birth_date: '2000-11-14',
                    uf_city: 'BAURU, SP',
                    company: 'TECFAG',
                    department: 'Vendas / Comercial',
                    mrp_username: 'vendas1'
                },
                {
                    login_key: 'jhenifer',
                    full_name: 'JHENIFER DIAS SOUZA ZORZI',
                    cpf: '43546273885',
                    rg: '41943114 SSP SP',
                    cnh_number: '05909833080',
                    cnh_category: 'B',
                    cnh_issue_date: '2024-02-21',
                    cnh_expiry_date: '2034-02-21',
                    first_license_date: '2013-10-18',
                    birth_date: '1995-02-16',
                    uf_city: 'BAURU, SP',
                    company: 'TECFAG',
                    department: 'Compras / Administrativo',
                    mrp_username: 'jhenifer'
                },
                {
                    login_key: 'patricia',
                    full_name: 'PATRICIA MARIA PILEGGI',
                    cpf: '31773300857',
                    rg: '43096188 SSP SP',
                    cnh_number: '03952885500',
                    cnh_category: 'B',
                    cnh_issue_date: '2021-07-09',
                    cnh_expiry_date: '2031-07-06',
                    first_license_date: '2006-10-17',
                    birth_date: '1986-02-19',
                    uf_city: 'BAURU, SP',
                    company: 'TECFAG',
                    department: 'Vendas / Comercial',
                    mrp_username: 'vendas6'
                },
                {
                    login_key: 'helison',
                    full_name: 'HELISON HENRIQUE SILVA',
                    cpf: '36875256860',
                    rg: '43666202 SSP SP',
                    cnh_number: '04518752940',
                    cnh_category: 'AB',
                    cnh_issue_date: '2025-03-27',
                    cnh_expiry_date: '2033-07-12',
                    first_license_date: '2008-12-05',
                    birth_date: '1987-12-08',
                    uf_city: 'SAO PAULO, SP',
                    company: 'TECFAG',
                    department: 'Operacional',
                    mrp_username: null
                },
                {
                    login_key: 'heilio',
                    full_name: 'HEILIO RENAN FUZIOKA',
                    cpf: '44876594856',
                    rg: '520763397 SSP SP',
                    cnh_number: '08727458536',
                    cnh_category: 'AB',
                    cnh_issue_date: '2025-09-02',
                    cnh_expiry_date: '2034-02-16',
                    first_license_date: '2024-08-26',
                    birth_date: '2005-11-21',
                    uf_city: 'SAO PAULO, SP',
                    company: 'TECFAG',
                    department: 'Assistência Técnica',
                    mrp_username: 'heilio'
                },
                {
                    login_key: 'giovane',
                    full_name: 'GIOVANE AMARANTE DE SOUSA SILVA',
                    cpf: '43464710807',
                    rg: '520760967 SSP SP',
                    cnh_number: '07913902265',
                    cnh_category: 'B',
                    cnh_issue_date: '2023-09-02',
                    cnh_expiry_date: '2032-01-03',
                    first_license_date: '2022-08-18',
                    birth_date: '2003-11-27',
                    uf_city: 'BAURU, SP',
                    company: 'TECFAG',
                    department: 'Operacional',
                    mrp_username: null
                },
                {
                    login_key: 'marcio',
                    full_name: 'MARCIO JOSE FLORIANO',
                    cpf: '33140175884',
                    rg: '33476019 SSP SP',
                    cnh_number: '03191121031',
                    cnh_category: 'AB',
                    cnh_issue_date: '2026-08-27',
                    cnh_expiry_date: '2035-04-16',
                    first_license_date: '2004-02-10',
                    birth_date: '1985-08-18',
                    uf_city: 'LENCOIS PAULISTA, SP',
                    company: 'TECFAG',
                    department: 'Operacional',
                    mrp_username: null
                },
                {
                    login_key: 'diego',
                    full_name: 'DIEGO FERNANDO LEME VIEIRA MANSINHO',
                    cpf: '36559002870',
                    rg: '42689375X SSP SP',
                    cnh_number: '08671828310',
                    cnh_category: 'B',
                    cnh_issue_date: '2025-06-23',
                    cnh_expiry_date: '2034-01-08',
                    first_license_date: '2024-06-21',
                    birth_date: '1986-09-19',
                    uf_city: 'SAO PAULO, SP',
                    company: 'TECFAG',
                    department: 'Operacional',
                    mrp_username: null
                },
                {
                    login_key: 'vanessa',
                    full_name: 'VANESSA MEDRADO JANUARIO',
                    cpf: '37401258889',
                    rg: '41590976 SSP SP',
                    cnh_number: '07496566977',
                    cnh_category: 'AB',
                    cnh_issue_date: '2025-07-05',
                    cnh_expiry_date: '2035-05-26',
                    first_license_date: '2020-11-23',
                    birth_date: '1987-05-28',
                    uf_city: 'SAO PAULO, SP',
                    company: 'TECFAG',
                    department: 'Operacional',
                    mrp_username: null
                },
                {
                    login_key: 'fernanda',
                    full_name: 'FERNANDA DA CONCEICAO OLIVEIRA',
                    cpf: '29961118855',
                    rg: '30954387 SSP SP',
                    cnh_number: '04750711125',
                    cnh_category: 'B',
                    cnh_issue_date: '2024-06-21',
                    cnh_expiry_date: '2034-06-21',
                    first_license_date: '2009-09-10',
                    birth_date: '1980-04-21',
                    uf_city: 'BAURU, SP',
                    company: 'TECFAG',
                    department: 'Operacional',
                    mrp_username: null
                },
                {
                    login_key: 'willian',
                    full_name: 'WILLIAN BATISTA DOS SANTOS',
                    cpf: '39618881830',
                    rg: '40760857 SSP SP',
                    cnh_number: '05521708592',
                    cnh_category: 'AB',
                    cnh_issue_date: '2022-03-23',
                    cnh_expiry_date: '2032-03-16',
                    first_license_date: '2012-06-22',
                    birth_date: '1993-07-28',
                    uf_city: 'BAURU, SP',
                    company: 'TECFAG',
                    department: 'Operacional',
                    mrp_username: null
                },
                {
                    login_key: 'gustavo',
                    full_name: 'GUSTAVO AUGUSTO SESSILIO DA SILVA',
                    cpf: '47317622869',
                    rg: '558663369 SSP SP',
                    cnh_number: '08307567955',
                    cnh_category: 'B',
                    cnh_issue_date: '2024-09-27',
                    cnh_expiry_date: '2033-01-24',
                    first_license_date: '2023-09-26',
                    birth_date: '2004-12-11',
                    uf_city: 'BAURU, SP',
                    company: 'TECFAG',
                    department: 'Operacional',
                    mrp_username: null
                },
                {
                    login_key: 'walifer',
                    full_name: 'WALIFER EDUARDO FERREIRA SILVA',
                    cpf: '42389451829',
                    rg: '40455230 SSP SP',
                    cnh_number: '06326004869',
                    cnh_category: 'B',
                    cnh_issue_date: '2024-06-03',
                    cnh_expiry_date: '2034-05-29',
                    first_license_date: '2015-03-19',
                    birth_date: '1995-01-08',
                    uf_city: 'BAURU, SP',
                    company: 'TECFAG',
                    department: 'Operacional',
                    mrp_username: null
                },
                {
                    login_key: 'lucas',
                    full_name: 'LUCAS AUGUSTO EVARISTO SPIRI',
                    cpf: '34987832895',
                    rg: '531945868 SSP SP',
                    cnh_number: '08254900439',
                    cnh_category: 'B',
                    cnh_issue_date: '2026-04-05',
                    cnh_expiry_date: '2033-02-23',
                    first_license_date: '2023-08-03',
                    birth_date: '1998-04-27',
                    uf_city: 'BAURU, SP',
                    company: 'TECFAG',
                    department: 'Vendas / Comercial',
                    mrp_username: 'vendas4'
                },
                {
                    login_key: 'henrique',
                    full_name: 'HENRIQUE TAVARES DA SILVA',
                    cpf: '47910140819',
                    rg: '54587947 SSP SP',
                    cnh_number: '07171567858',
                    cnh_category: 'AB',
                    cnh_issue_date: '2025-02-05',
                    cnh_expiry_date: '2033-08-14',
                    first_license_date: '2018-11-29',
                    birth_date: '1999-01-07',
                    uf_city: 'SAO PAULO, SP',
                    company: 'TECFAG',
                    department: 'Operacional',
                    mrp_username: null
                },
                {
                    login_key: 'humberto',
                    full_name: 'HUMBERTO DOS SANTOS LOPES',
                    cpf: '22811361839',
                    rg: '50900801X SSP SP',
                    cnh_number: '07758885006',
                    cnh_category: 'B',
                    cnh_issue_date: '2023-02-23',
                    cnh_expiry_date: '2031-08-11',
                    first_license_date: '2022-02-18',
                    birth_date: '1999-12-18',
                    uf_city: 'SAO PAULO, SP',
                    company: 'TECFAG',
                    department: 'Operacional',
                    mrp_username: null
                }
            ];

            for (const d of initialDrivers) {
                const defaultPin = d.cpf.slice(0, 6);
                await fRun(
                    `INSERT OR IGNORE INTO fleet_drivers (
                        login_key, full_name, cpf, rg, cnh_number, cnh_category,
                        cnh_issue_date, cnh_expiry_date, first_license_date, birth_date, uf_city,
                        company, department, mrp_username, pin_hash, active, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
                    [
                        d.login_key, d.full_name, d.cpf, d.rg, d.cnh_number, d.cnh_category,
                        d.cnh_issue_date, d.cnh_expiry_date, d.first_license_date, d.birth_date, d.uf_city,
                        d.company, d.department, d.mrp_username, hashFleetPin(defaultPin), now, now
                    ]
                );
            }

            const defaultSettings = {
                yard_name: 'Pátio Matriz Tecfag',
                yard_lat: '',
                yard_lng: '',
                yard_radius_meters: '200',
                default_speed_limit_kmh: '110',
                photo_retention_days: '45',
                webhook_secret: crypto.randomBytes(12).toString('hex')
            };

            for (const [k, val] of Object.entries(defaultSettings)) {
                await fRun(`INSERT OR IGNORE INTO fleet_settings (key, value) VALUES (?, ?)`, [k, val]);
            }
        } catch (err) {
            console.error('[FROTA SEED ERROR]:', err.message);
        }
    }

    async function getSettingsMap() {
        const rows = await fAll('SELECT key, value FROM fleet_settings');
        const map = {};
        rows.forEach(r => { map[r.key] = r.value; });
        return map;
    }

    function safeDeletePhotoFile(photoUrl) {
        if (!photoUrl || !photoUrl.includes('uploads_frota/')) return;
        const filename = path.basename(photoUrl);
        const fullPath = path.join(FLEET_UPLOADS_DIR, filename);
        if (fs.existsSync(fullPath)) {
            try { fs.unlinkSync(fullPath); } catch (e) {}
        }
    }

    async function runFleetMaintenance() {
        try {
            // 1. Backup compactado diário (mantém apenas o 1 backup mais recente da frota para economizar disco)
            if (fs.existsSync(FLEET_DB_PATH)) {
                const dateStr = new Date().toISOString().split('T')[0];
                const gzPath = path.join(FLEET_BACKUPS_DIR, `tecfag_frota_backup_${dateStr}.db.gz`);
                const buf = fs.readFileSync(FLEET_DB_PATH);
                fs.writeFileSync(gzPath, zlib.gzipSync(buf));

                const oldBackups = fs.readdirSync(FLEET_BACKUPS_DIR)
                    .filter(f => f.startsWith('tecfag_frota_backup_') && f !== path.basename(gzPath));
                oldBackups.forEach(f => {
                    try { fs.unlinkSync(path.join(FLEET_BACKUPS_DIR, f)); } catch (e) {}
                });
            }

            // 2. Faxina inteligente de fotos normais antigas (preserva 100% dos textos, KMs e rotas para sempre!)
            const settings = await getSettingsMap();
            const retentionDays = Math.max(15, parseInt(settings.photo_retention_days) || 45);
            const cutoffIso = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

            const expiredNormalTrips = await fAll(
                `SELECT id, start_photos_json, overnight_photo_url, end_photos_json
                 FROM fleet_trips
                 WHERE status = 'CLOSED'
                   AND has_damage = 0
                   AND keep_forever = 0
                   AND photos_purged = 0
                   AND checkin_at IS NOT NULL
                   AND checkin_at < ?`,
                [cutoffIso]
            );

            for (const t of expiredNormalTrips) {
                try {
                    const startArr = JSON.parse(t.start_photos_json || '[]');
                    const endArr = JSON.parse(t.end_photos_json || '[]');
                    startArr.forEach(p => safeDeletePhotoFile(p.url));
                    endArr.forEach(p => safeDeletePhotoFile(p.url));
                    if (t.overnight_photo_url) safeDeletePhotoFile(t.overnight_photo_url);
                    await fRun('UPDATE fleet_trips SET photos_purged = 1 WHERE id = ?', [t.id]);
                } catch (e) {}
            }
            if (expiredNormalTrips.length > 0) {
                console.log(`[FROTA CLEANUP] Fotos antigas (> ${retentionDays}d sem avaria) limpas de ${expiredNormalTrips.length} viagens.`);
            }
        } catch (err) {
            console.error('[FROTA MAINTENANCE ERROR]:', err.message);
        }
    }

    // Upload isolado com trava rígida de tamanho (máx 800 KB por foto já comprimida no celular)
    const fleetStorage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, FLEET_UPLOADS_DIR),
        filename: (req, file, cb) => {
            const ext = (path.extname(file.originalname || '.jpg') || '.jpg').toLowerCase();
            const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
            cb(null, `frota-${Date.now()}-${Math.round(Math.random() * 1e6)}${safeExt}`);
        }
    });

    const fleetUpload = multer({
        storage: fleetStorage,
        limits: {
            fileSize: 800 * 1024, // Máximo 800 KB por imagem
            files: 6
        }
    });

    function cleanupUploadedFiles(files) {
        if (!files) return;
        const list = Array.isArray(files) ? files : Object.values(files).flat();
        list.forEach(f => {
            if (f && f.path && fs.existsSync(f.path)) {
                try { fs.unlinkSync(f.path); } catch (e) {}
            }
        });
    }

    // ==========================================
    // ROTAS DE PÁGINAS WEB E ARQUIVOS (/frota, /motorista, /uploads_frota)
    // ==========================================

    // Suporte nativo para migração instantânea Opção A -> Opção B sem trocar adesivos QR Code dos carros!
    app.get('/frota', (req, res) => {
        if (process.env.FLEET_EXTERNAL_URL) {
            const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
            return res.redirect(302, `${process.env.FLEET_EXTERNAL_URL.replace(/\/$/, '')}/frota${qs}`);
        }
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.sendFile(path.join(__dirname, 'frota.html'));
    });

    app.get('/motorista', (req, res) => {
        if (process.env.FLEET_EXTERNAL_URL) {
            const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
            return res.redirect(302, `${process.env.FLEET_EXTERNAL_URL.replace(/\/$/, '')}/motorista${qs}`);
        }
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.sendFile(path.join(__dirname, 'motorista.html'));
    });

    app.get('/fleet-assets/qrcode.js', (req, res) => {
        res.sendFile(path.join(__dirname, 'qrcode.js'));
    });

    app.use('/uploads_frota', express.static(FLEET_UPLOADS_DIR));
    app.get('/uploads_frota/:filename', (req, res) => {
        res.status(404).send(`
            <!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Foto Arquivada - Frota Tecfag</title></head>
            <body style="font-family:sans-serif;background:#0b0f19;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:20px;">
                <div style="background:#171d2c;border:1px solid #2e3b52;border-radius:12px;padding:28px;max-width:460px;text-align:center;">
                    <div style="font-size:2.5rem;margin-bottom:8px;">🗂️</div>
                    <h3 style="margin:0 0 10px 0;color:#38bdf8;">Foto removida pela limpeza automática</h3>
                    <p style="color:#94a3b8;font-size:0.88rem;line-height:1.5;">Viagens normais sem avaria têm suas imagens limpas após o prazo de retenção para proteger o disco do servidor, mantendo 100% dos dados da viagem permanentes.</p>
                </div>
            </body></html>
        `);
    });

    // ==========================================
    // ROTAS DA API DE FROTA (/api/fleet/*)
    // ==========================================
    const router = express.Router();

    // Gerador nativo de QR Code em SVG de alta nitidez (funciona 100% offline/local e na nuvem)
    router.get('/qr.svg', (req, res) => {
        try {
            const text = String(req.query.text || '').trim() || 'https://tecfag-mrp.onrender.com/motorista';
            const qr = qrGenerator(0, 'M');
            qr.addData(text);
            qr.make();
            const svg = qr.createSvgTag(6, 4);
            res.set('Content-Type', 'image/svg+xml');
            res.set('Cache-Control', 'no-cache');
            res.send(svg);
        } catch (err) {
            res.status(500).send('QR error');
        }
    });

    // Lista enxuta de nomes dos condutores habilitados (somente Nome e Setor, sem expor CPF/CNH)
    router.get('/public-drivers', asyncSafe(async (req, res) => {
        const rows = await fAll(
            'SELECT id, full_name, company, department FROM fleet_drivers WHERE active = 1 ORDER BY full_name ASC'
        );
        res.json({ success: true, drivers: rows });
    }));

    // Vínculo rápido de 1º acesso do celular: Tocou no próprio nome + 4 últimos dígitos do CPF -> Crachá Digital de 365 dias!
    const bindRateLimiter = new Map();
    router.post('/auth/bind-device', asyncSafe(async (req, res) => {
        const ip = req.ip || 'local';
        const rl = bindRateLimiter.get(ip) || { fails: 0, resetAt: Date.now() + 5 * 60 * 1000 };
        if (Date.now() > rl.resetAt) {
            rl.fails = 0;
            rl.resetAt = Date.now() + 5 * 60 * 1000;
        }
        if (rl.fails >= 6) {
            return res.status(429).json({ error: 'Muitas tentativas incorretas. Aguarde 5 minutos.' });
        }

        const { driver_id, cpf_last4 } = req.body;
        const clean4 = String(cpf_last4 || '').replace(/\D/g, '');
        if (!driver_id || clean4.length !== 4) {
            return res.status(400).json({ error: 'Selecione seu nome e digite os 4 últimos números do seu CPF.' });
        }

        const drv = await fGet('SELECT * FROM fleet_drivers WHERE id = ?', [parseInt(driver_id)]);
        if (!drv || drv.active === 0) {
            return res.status(403).json({ error: 'Condutor não encontrado ou bloqueado pela gestão.' });
        }
        if (drv.cpf.slice(-4) !== clean4) {
            rl.fails += 1;
            bindRateLimiter.set(ip, rl);
            return res.status(401).json({ error: 'Os 4 últimos dígitos do CPF não conferem com este condutor.' });
        }

        rl.fails = 0;
        bindRateLimiter.set(ip, rl);

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
        await fRun(
            'INSERT INTO fleet_driver_sessions (token, driver_id, expires_at) VALUES (?, ?, ?)',
            [token, drv.id, expiresAt]
        );
        setDeviceCookie(res, token);

        res.json({
            success: true,
            token,
            user: {
                username: drv.mrp_username || drv.login_key,
                role: drv.login_key === 'gilson' ? 'ALL' : 'MOTORISTA_FROTA'
            }
        });
    }));

    router.post('/auth/unbind-device', asyncSafe(async (req, res) => {
        const token = extractCookieToken(req) || (req.headers['authorization'] || '').split(' ')[1];
        if (token) {
            await fRun('DELETE FROM fleet_driver_sessions WHERE token = ?', [token]).catch(() => {});
        }
        res.setHeader('Set-Cookie', 'tecfag_fleet_device=; Max-Age=0; Path=/; SameSite=Lax');
        res.json({ success: true });
    }));

    // Login individual alternativo por usuário/CPF + senha
    router.post('/auth/login', asyncSafe(async (req, res) => {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Informe usuário/CPF e senha.' });
        }
        const rawInput = String(username).trim().toLowerCase();
        const digitsOnly = rawInput.replace(/\D/g, '');

        const drv = await fGet(
            `SELECT * FROM fleet_drivers
             WHERE LOWER(login_key) = ?
                OR LOWER(COALESCE(mrp_username, '')) = ?
                OR (? != '' AND cpf = ?)
             LIMIT 1`,
            [rawInput, rawInput, digitsOnly, digitsOnly]
        );

        if (!drv) {
            return res.status(401).json({ error: 'DRIVER_NOT_MATCHED' });
        }
        if (drv.active === 0) {
            return res.status(403).json({ error: 'Seu cadastro de condutor está temporariamente bloqueado. Procure a gestão.' });
        }
        if (hashFleetPin(password) !== drv.pin_hash) {
            return res.status(401).json({ error: 'DRIVER_PIN_MISMATCH' });
        }

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
        await fRun(
            'INSERT INTO fleet_driver_sessions (token, driver_id, expires_at) VALUES (?, ?, ?)',
            [token, drv.id, expiresAt]
        );
        setDeviceCookie(res, token);

        res.json({
            success: true,
            token,
            user: {
                username: drv.mrp_username || drv.login_key,
                role: drv.login_key === 'gilson' ? 'ALL' : 'MOTORISTA_FROTA'
            }
        });
    }));

    // 1. Contexto do usuário autenticado + ficha de CNH + lista leve de projetos ativos do MRP
    router.get('/me', authenticateFleet, asyncSafe(async (req, res) => {
        const uname = String(req.user.username || '').toLowerCase().trim();
        const drv = req.fleetDriver || null;
        const isGeneric = !drv && GENERIC_SHARED_LOGINS.has(uname);
        const activeProjects = await mrpAll(
            `SELECT code, client, project_name, sku
             FROM projects
             WHERE (fase IS NULL OR fase < 8) AND (is_archived IS NULL OR is_archived = 0)
             ORDER BY code DESC LIMIT 120`
        );
        const disk = checkDiskSafetyBreaker();
        const cnhEval = drv ? computeCnhStatus(drv.cnh_expiry_date) : null;

        res.json({
            success: true,
            user: {
                username: req.user.username,
                role: req.user.role,
                friendlyName: drv ? drv.full_name : getFriendlyUserName(req.user.username),
                requiresDriverRealName: isGeneric,
                isManager: isFleetManagerUser(req.user),
                driverProfile: drv ? {
                    id: drv.id,
                    full_name: drv.full_name,
                    cpf: drv.cpf,
                    cnh_number: drv.cnh_number,
                    cnh_category: drv.cnh_category,
                    cnh_expiry_date: drv.cnh_expiry_date,
                    cnh_status: cnhEval.status,
                    cnh_days_left: cnhEval.daysLeft,
                    company: drv.company,
                    department: drv.department
                } : null
            },
            activeProjects,
            diskStatus: {
                breakerTripped: disk.breakerTripped,
                usedPercent: disk.usedPercent
            }
        });
    }));

    function normalizeIsoTimestamp(val) {
        if (!val) return null;
        const s = String(val).trim();
        if (!s) return null;
        let d;
        if (/Z$|[+-]\d{2}:\d{2}$/.test(s)) {
            d = new Date(s);
        } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) {
            d = new Date(s + ':00-03:00');
        } else {
            d = new Date(s);
        }
        return isNaN(d.getTime()) ? null : d.toISOString();
    }

    function formatIsoBr(iso) {
        if (!iso) return '-';
        try {
            return new Date(iso).toLocaleString('pt-BR', {
                timeZone: 'America/Sao_Paulo',
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
            });
        } catch (e) {
            return iso;
        }
    }

    async function attachReservationsToVehicles(vehicles) {
        const nowIso = new Date().toISOString();
        const in36hIso = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
        const upcoming = await fAll(
            `SELECT * FROM fleet_reservations
             WHERE status IN ('APPROVED', 'PENDING')
               AND end_at >= ?
             ORDER BY CASE status WHEN 'APPROVED' THEN 0 ELSE 1 END, start_at ASC`,
            [nowIso]
        );
        const byVeh = new Map();
        for (const r of upcoming) {
            if (!byVeh.has(r.vehicle_id)) byVeh.set(r.vehicle_id, []);
            byVeh.get(r.vehicle_id).push(r);
        }
        for (const v of vehicles) {
            const list = byVeh.get(v.id) || [];
            v.upcoming_reservations = list.slice(0, 6);
            v.next_approved_reservation = list.find(r => r.status === 'APPROVED') || null;
            v.imminent_reservation =
                list.find(r => r.status === 'APPROVED' && r.start_at <= in36hIso) ||
                list.find(r => r.status === 'PENDING' && r.start_at <= in36hIso) ||
                null;
        }
        return vehicles;
    }

    // 2. Listar os 6 veículos com detalhes da viagem ativa + reservas próximas (para celular /motorista e painel /frota)
    router.get('/vehicles', authenticateFleet, asyncSafe(async (req, res) => {
        const vehicles = await fAll(
            `SELECT v.*,
                    t.checkout_at AS active_checkout_at,
                    t.purpose_type AS active_purpose_type,
                    t.destination AS active_destination,
                    t.project_code AS active_project_code,
                    t.start_km AS active_start_km,
                    t.overnight_at AS active_overnight_at,
                    t.overnight_km AS active_overnight_km,
                    t.overnight_notes AS active_overnight_notes
             FROM fleet_vehicles v
             LEFT JOIN fleet_trips t ON v.current_trip_id = t.id
             WHERE v.active = 1
             ORDER BY v.code ASC`
        );
        await attachReservationsToVehicles(vehicles);
        res.json({ success: true, vehicles });
    }));

    // 3. Atualizar ou cadastrar veículo (Somente Gestor)
    router.put('/vehicles/:id', authenticateFleet, requireFleetManager, asyncSafe(async (req, res) => {
        const veh = await fGet('SELECT * FROM fleet_vehicles WHERE id = ?', [req.params.id]);
        if (!veh) return res.status(404).json({ error: 'Veículo não encontrado.' });

        const {
            name, brand_model, plate, category, color, year, fuel_type,
            current_km, current_fuel_level, next_oil_km, next_revision_km,
            speed_limit_kmh, tracker_imei, tracker_model, tracker_sim_phone,
            known_damages_notes, status
        } = req.body;

        // Não permitir mudar manualmente para NO_PATIO se houver viagem aberta (usar encerramento forçado)
        let nextStatus = veh.status;
        if (status && ['NO_PATIO', 'MANUTENCAO'].includes(status) && !veh.current_trip_id) {
            nextStatus = status;
        }

        const cleanPlate = plate ? String(plate).toUpperCase().replace(/[^A-Z0-9]/g, '') : veh.plate;
        const cleanImei = tracker_imei !== undefined ? (String(tracker_imei).trim() || null) : veh.tracker_imei;

        await fRun(
            `UPDATE fleet_vehicles SET
                name = ?, brand_model = ?, plate = ?, category = ?, color = ?, year = ?, fuel_type = ?,
                current_km = ?, current_fuel_level = ?, next_oil_km = ?, next_revision_km = ?,
                speed_limit_kmh = ?, tracker_imei = ?, tracker_model = ?, tracker_sim_phone = ?,
                known_damages_notes = ?, status = ?, updated_at = ?
             WHERE id = ?`,
            [
                name || veh.name,
                brand_model || veh.brand_model,
                cleanPlate,
                category || veh.category,
                color !== undefined ? color : veh.color,
                year !== undefined ? year : veh.year,
                fuel_type || veh.fuel_type,
                current_km !== undefined && current_km !== '' ? parseInt(current_km) : veh.current_km,
                current_fuel_level !== undefined && current_fuel_level !== '' ? parseInt(current_fuel_level) : veh.current_fuel_level,
                next_oil_km !== undefined ? (next_oil_km === '' || next_oil_km === null ? null : parseInt(next_oil_km)) : veh.next_oil_km,
                next_revision_km !== undefined ? (next_revision_km === '' || next_revision_km === null ? null : parseInt(next_revision_km)) : veh.next_revision_km,
                speed_limit_kmh ? parseInt(speed_limit_kmh) : veh.speed_limit_kmh,
                cleanImei,
                tracker_model !== undefined ? tracker_model : veh.tracker_model,
                tracker_sim_phone !== undefined ? tracker_sim_phone : veh.tracker_sim_phone,
                known_damages_notes !== undefined ? known_damages_notes : veh.known_damages_notes,
                nextStatus,
                new Date().toISOString(),
                veh.id
            ]
        );

        const updated = await fGet('SELECT * FROM fleet_vehicles WHERE id = ?', [veh.id]);
        res.json({ success: true, vehicle: updated });
    }));

    router.post('/vehicles', authenticateFleet, requireFleetManager, asyncSafe(async (req, res) => {
        const { name, brand_model, plate, category, fuel_type, current_km, speed_limit_kmh, tracker_imei } = req.body;
        if (!plate || !brand_model) {
            return res.status(400).json({ error: 'Modelo e placa são obrigatórios.' });
        }
        const cleanPlate = String(plate).toUpperCase().replace(/[^A-Z0-9]/g, '');
        const countRow = await fGet('SELECT COUNT(*) as c FROM fleet_vehicles');
        const nextCode = `VEIC-${String((countRow ? countRow.c : 0) + 1).padStart(2, '0')}`;
        const now = new Date().toISOString();

        const r = await fRun(
            `INSERT INTO fleet_vehicles (
                code, name, brand_model, plate, category, fuel_type, current_km, speed_limit_kmh, tracker_imei, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'NO_PATIO', ?, ?)`,
            [
                nextCode,
                name || `${brand_model} (${cleanPlate})`,
                brand_model,
                cleanPlate,
                category || 'PASSEIO',
                fuel_type || 'FLEX',
                parseInt(current_km) || 0,
                parseInt(speed_limit_kmh) || 110,
                tracker_imei ? String(tracker_imei).trim() : null,
                now,
                now
            ]
        );
        const created = await fGet('SELECT * FROM fleet_vehicles WHERE id = ?', [r.lastID]);
        res.json({ success: true, vehicle: created });
    }));

    // 4. CHECK-IN DE RETIRADA DO VEÍCULO (Motorista saindo com o carro)
    const checkoutFields = fleetUpload.fields([
        { name: 'photo_panel', maxCount: 1 },
        { name: 'photo_front', maxCount: 1 },
        { name: 'photo_rear', maxCount: 1 },
        { name: 'photo_interior', maxCount: 1 }
    ]);

    router.post('/trips/checkout', authenticateFleet, checkoutFields, asyncSafe(async (req, res) => {
        const disk = checkDiskSafetyBreaker();
        if (disk.breakerTripped) {
            cleanupUploadedFiles(req.files);
            return res.status(507).json({
                error: 'Disjuntor de proteção ativo: O disco do servidor atingiu a margem de segurança do MRP (< 200 MB livres). Avise a diretoria para liberar espaço.'
            });
        }

        const {
            vehicle_id, driver_real_name, purpose_type, destination, project_code,
            start_km, start_fuel_level, start_cleanliness, start_checklist_json,
            start_damage_reported, start_damage_notes, lat, lng
        } = req.body;

        const veh = await fGet('SELECT * FROM fleet_vehicles WHERE id = ? AND active = 1', [vehicle_id]);
        if (!veh) {
            cleanupUploadedFiles(req.files);
            return res.status(404).json({ error: 'Veículo não encontrado.' });
        }
        if (veh.status === 'MANUTENCAO') {
            cleanupUploadedFiles(req.files);
            return res.status(400).json({ error: `Este veículo (${veh.plate}) está bloqueado em Manutenção.` });
        }
        if (veh.current_trip_id || veh.status === 'EM_USO' || veh.status === 'PERNOITE_CASA') {
            cleanupUploadedFiles(req.files);
            return res.status(409).json({
                error: `Este veículo já consta em posse de ${veh.current_driver_name || veh.current_driver_username}. É necessário encerrar a viagem anterior primeiro.`
            });
        }

        const kmNum = parseInt(start_km);
        if (isNaN(kmNum) || kmNum < 0) {
            cleanupUploadedFiles(req.files);
            return res.status(400).json({ error: 'Informe o KM atual válido do painel.' });
        }
        if (veh.current_km > 0 && kmNum < veh.current_km) {
            cleanupUploadedFiles(req.files);
            return res.status(400).json({
                error: `O KM informado (${kmNum.toLocaleString('pt-BR')} km) é menor que o último KM registrado deste veículo (${veh.current_km.toLocaleString('pt-BR')} km). Confira o painel.`
            });
        }
        if (!destination || !String(destination).trim()) {
            cleanupUploadedFiles(req.files);
            return res.status(400).json({ error: 'Informe o destino ou cliente da viagem.' });
        }

        const uname = String(req.user.username || '').toLowerCase().trim();
        const drv = req.fleetDriver || null;

        if (drv) {
            if (drv.active === 0) {
                cleanupUploadedFiles(req.files);
                return res.status(403).json({ error: '⛔ Condutor bloqueado para retirada de veículos. Procure a gestão.' });
            }
            const cnhEval = computeCnhStatus(drv.cnh_expiry_date);
            if (cnhEval.status === 'EXPIRED') {
                cleanupUploadedFiles(req.files);
                const fmtExp = drv.cnh_expiry_date.split('-').reverse().join('/');
                await fRun(
                    `INSERT INTO fleet_alerts (vehicle_id, plate, alert_type, severity, title, description, driver_name, created_at)
                     VALUES (?, ?, 'CNH_EXPIRED', 'CRITICAL', ?, ?, ?, ?)`,
                    [
                        veh.id, veh.plate,
                        `Tentativa de retirada com CNH VENCIDA (${drv.full_name})`,
                        `${drv.full_name} tentou retirar ${veh.name} (${veh.plate}), mas sua CNH nº ${drv.cnh_number} venceu em ${fmtExp}. Retirada bloqueada!`,
                        drv.full_name, new Date().toISOString()
                    ]
                );
                return res.status(403).json({
                    error: `⛔ Retirada bloqueada: Sua CNH (${drv.cnh_number}) está vencida desde ${fmtExp}. Envie a CNH renovada para o RH/Diretoria.`
                });
            }
        }

        let finalDriverName = drv ? drv.full_name : (driver_real_name || '').trim();
        if (!finalDriverName) {
            if (GENERIC_SHARED_LOGINS.has(uname)) {
                cleanupUploadedFiles(req.files);
                return res.status(400).json({ error: 'Como este login é compartilhado pelo setor, digite seu nome completo para identificar o motorista.' });
            }
            finalDriverName = getFriendlyUserName(req.user.username);
        } else if (!drv && GENERIC_SHARED_LOGINS.has(uname)) {
            finalDriverName = `${finalDriverName} (${uname})`;
        }

        const now = new Date().toISOString();
        const slotLabels = {
            photo_panel: 'Painel / KM e Combustível',
            photo_front: 'Frente + Lateral Esquerda',
            photo_rear: 'Traseira + Lateral Direita',
            photo_interior: 'Interior / Detalhe'
        };
        const photos = [];
        if (req.files) {
            for (const [slot, label] of Object.entries(slotLabels)) {
                if (req.files[slot] && req.files[slot][0]) {
                    photos.push({
                        slot,
                        label,
                        url: `/uploads_frota/${req.files[slot][0].filename}`,
                        timestamp: now
                    });
                }
            }
        }

        if (photos.length < 2) {
            cleanupUploadedFiles(req.files);
            return res.status(400).json({ error: 'Tire pelo menos a foto do Painel (KM) e externas do veículo para registrar a retirada.' });
        }

        const hasDamage = (start_damage_reported === '1' || start_damage_reported === 'true' || start_damage_reported === true) ? 1 : 0;
        const parsedLat = lat && !isNaN(parseFloat(lat)) ? parseFloat(lat) : null;
        const parsedLng = lng && !isNaN(parseFloat(lng)) ? parseFloat(lng) : null;
        const fuelLvl = start_fuel_level !== undefined ? parseInt(start_fuel_level) : veh.current_fuel_level;

        const insertRes = await fRun(
            `INSERT INTO fleet_trips (
                vehicle_id, plate, vehicle_name, driver_username, driver_name, driver_role,
                driver_cpf, driver_cnh,
                purpose_type, destination, project_code, status,
                checkout_at, start_km, start_fuel_level, start_cleanliness, start_checklist_json,
                start_damage_reported, start_damage_notes, start_photos_json, start_lat, start_lng,
                has_damage
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                veh.id, veh.plate, veh.name, req.user.username, finalDriverName, req.user.role,
                drv ? drv.cpf : null, drv ? drv.cnh_number : null,
                purpose_type || 'VISITA_COMERCIAL', String(destination).trim(), project_code ? String(project_code).trim() : null,
                now, kmNum, isNaN(fuelLvl) ? 100 : fuelLvl, start_cleanliness || 'LIMPO', start_checklist_json || '{}',
                hasDamage, start_damage_notes ? String(start_damage_notes).trim() : null, JSON.stringify(photos), parsedLat, parsedLng,
                hasDamage
            ]
        );

        const tripId = insertRes.lastID;

        await fRun(
            `UPDATE fleet_vehicles SET
                status = 'EM_USO',
                current_trip_id = ?,
                current_driver_username = ?,
                current_driver_name = ?,
                current_km = ?,
                current_fuel_level = ?,
                last_lat = COALESCE(?, last_lat),
                last_lng = COALESCE(?, last_lng),
                updated_at = ?
             WHERE id = ?`,
            [tripId, req.user.username, finalDriverName, kmNum, isNaN(fuelLvl) ? 100 : fuelLvl, parsedLat, parsedLng, now, veh.id]
        );

        if (parsedLat !== null && parsedLng !== null) {
            await fRun(
                `INSERT INTO fleet_telemetry_points (vehicle_id, trip_id, recorded_at, lat, lng, speed_kmh, ignition, source, event_type)
                 VALUES (?, ?, ?, ?, ?, 0, 1, 'CHECKIN_MOBILE', 'RETIRADA_PATIO')`,
                [veh.id, tripId, now, parsedLat, parsedLng]
            );
        }

        if (hasDamage) {
            await fRun(
                `INSERT INTO fleet_alerts (vehicle_id, trip_id, plate, alert_type, severity, title, description, driver_name, created_at)
                 VALUES (?, ?, ?, 'NEW_DAMAGE', 'WARNING', ?, ?, ?, ?)`,
                [
                    veh.id, tripId, veh.plate,
                    `Avaria prévia apontada na retirada (${veh.plate})`,
                    `${finalDriverName} apontou avaria ao retirar ${veh.name}: "${start_damage_notes || 'Ver fotos de retirada'}". Fotos protegidas permanentemente.`,
                    finalDriverName, now
                ]
            );
        }

        // Integração com Reservas: Baixar reserva aprovada do próprio motorista ou avisar gestão se outro condutor pegou p/ corrida rápida
        const in8hIso = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
        const activeOrNearRes = await fAll(
            `SELECT * FROM fleet_reservations
             WHERE vehicle_id = ? AND status = 'APPROVED' AND start_at <= ? AND end_at >= ?
             ORDER BY start_at ASC`,
            [veh.id, in8hIso, now]
        );
        const ownRes = activeOrNearRes.find(r =>
            (drv && r.driver_id === drv.id) ||
            String(r.driver_username || '').toLowerCase() === uname ||
            String(r.driver_name || '').toUpperCase() === finalDriverName.toUpperCase()
        );
        if (ownRes) {
            await fRun(
                `UPDATE fleet_reservations SET status = 'FULFILLED', fulfilled_trip_id = ?, updated_at = ? WHERE id = ?`,
                [tripId, now, ownRes.id]
            );
        } else if (activeOrNearRes.length > 0) {
            const otherRes = activeOrNearRes[0];
            await fRun(
                `INSERT INTO fleet_alerts (vehicle_id, trip_id, plate, alert_type, severity, title, description, driver_name, created_at)
                 VALUES (?, ?, ?, 'RESERVA_CORRIDA_RAPIDA', 'WARNING', ?, ?, ?, ?)`,
                [
                    veh.id, tripId, veh.plate,
                    `Veículo reservado retirado p/ corrida rápida (${veh.plate})`,
                    `${finalDriverName} retirou ${veh.name} (${veh.plate}) p/ "${String(destination).trim()}" ciente da reserva aprovada de ${otherRes.driver_name} (${formatIsoBr(otherRes.start_at)} até ${formatIsoBr(otherRes.end_at)}).`,
                    finalDriverName, now
                ]
            );
        }

        res.json({ success: true, trip_id: tripId, message: `Boa viagem! ${veh.name} (${veh.plate}) vinculado a ${finalDriverName}.` });
    }));

    // 5. PERNOITE EM CASA (Chegada tarde da noite: foto do painel aceso + KM noturno + pino GPS)
    router.post('/trips/:id/overnight', authenticateFleet, fleetUpload.single('photo_overnight_panel'), asyncSafe(async (req, res) => {
        const disk = checkDiskSafetyBreaker();
        if (disk.breakerTripped) {
            cleanupUploadedFiles(req.file ? [req.file] : []);
            return res.status(507).json({ error: 'Disjuntor de disco ativo (< 200 MB livres).' });
        }

        const trip = await fGet('SELECT * FROM fleet_trips WHERE id = ?', [req.params.id]);
        if (!trip || trip.status !== 'OPEN') {
            cleanupUploadedFiles(req.file ? [req.file] : []);
            return res.status(400).json({ error: 'Viagem não encontrada ou não está aberta para pernoite.' });
        }
        if (trip.driver_username !== req.user.username && !isFleetManagerUser(req.user)) {
            cleanupUploadedFiles(req.file ? [req.file] : []);
            return res.status(403).json({ error: 'Apenas o motorista responsável pela retirada ou um gestor pode registrar o pernoite.' });
        }

        const { overnight_km, overnight_fuel_level, overnight_notes, lat, lng } = req.body;
        const kmNum = parseInt(overnight_km);
        if (isNaN(kmNum) || kmNum < trip.start_km) {
            cleanupUploadedFiles(req.file ? [req.file] : []);
            return res.status(400).json({
                error: `O KM de parada em pernoite (${overnight_km}) não pode ser menor que o KM de saída (${trip.start_km.toLocaleString('pt-BR')} km).`
            });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'Tire uma foto do painel aceso mostrando o KM atual ao estacionar em casa.' });
        }

        const now = new Date().toISOString();
        const photoUrl = `/uploads_frota/${req.file.filename}`;
        const parsedLat = lat && !isNaN(parseFloat(lat)) ? parseFloat(lat) : null;
        const parsedLng = lng && !isNaN(parseFloat(lng)) ? parseFloat(lng) : null;
        const fuelLvl = overnight_fuel_level !== undefined ? parseInt(overnight_fuel_level) : trip.start_fuel_level;

        await fRun(
            `UPDATE fleet_trips SET
                status = 'OVERNIGHT_HOME',
                overnight_at = ?,
                overnight_km = ?,
                overnight_fuel_level = ?,
                overnight_notes = ?,
                overnight_photo_url = ?,
                overnight_lat = ?,
                overnight_lng = ?
             WHERE id = ?`,
            [now, kmNum, isNaN(fuelLvl) ? trip.start_fuel_level : fuelLvl, overnight_notes || 'Chegada tarde - pernoite na residência', photoUrl, parsedLat, parsedLng, trip.id]
        );

        await fRun(
            `UPDATE fleet_vehicles SET
                status = 'PERNOITE_CASA',
                current_km = ?,
                current_fuel_level = ?,
                last_lat = COALESCE(?, last_lat),
                last_lng = COALESCE(?, last_lng),
                updated_at = ?
             WHERE id = ?`,
            [kmNum, isNaN(fuelLvl) ? trip.start_fuel_level : fuelLvl, parsedLat, parsedLng, now, trip.vehicle_id]
        );

        if (parsedLat !== null && parsedLng !== null) {
            await fRun(
                `INSERT INTO fleet_telemetry_points (vehicle_id, trip_id, recorded_at, lat, lng, speed_kmh, ignition, source, event_type)
                 VALUES (?, ?, ?, ?, ?, 0, 0, 'OVERNIGHT_MOBILE', 'PERNOITE_CASA')`,
                [trip.vehicle_id, trip.id, now, parsedLat, parsedLng]
            );
        }

        res.json({
            success: true,
            message: `Pernoite registrado com sucesso (${kmNum.toLocaleString('pt-BR')} km). Amanhã ao chegar no pátio da Tecfag, conclua a devolução com as fotos externas no claro.`
        });
    }));

    // 6. CHECK-OUT DE DEVOLUÇÃO NO PÁTIO TECFAG (Motorista entregando o carro)
    const checkinFields = fleetUpload.fields([
        { name: 'photo_panel', maxCount: 1 },
        { name: 'photo_front', maxCount: 1 },
        { name: 'photo_rear', maxCount: 1 },
        { name: 'photo_interior', maxCount: 1 }
    ]);

    router.post('/trips/:id/checkin', authenticateFleet, checkinFields, asyncSafe(async (req, res) => {
        const disk = checkDiskSafetyBreaker();
        if (disk.breakerTripped) {
            cleanupUploadedFiles(req.files);
            return res.status(507).json({
                error: 'Disjuntor de proteção ativo (< 200 MB livres no servidor). Avise a diretoria.'
            });
        }

        const trip = await fGet('SELECT * FROM fleet_trips WHERE id = ?', [req.params.id]);
        if (!trip || trip.status === 'CLOSED') {
            cleanupUploadedFiles(req.files);
            return res.status(400).json({ error: 'Esta viagem já foi encerrada ou não existe.' });
        }
        if (trip.driver_username !== req.user.username && !isFleetManagerUser(req.user)) {
            cleanupUploadedFiles(req.files);
            return res.status(403).json({ error: `Apenas ${trip.driver_name} (ou a gestão) pode encerrar esta devolução.` });
        }

        const {
            end_km, end_fuel_level, end_cleanliness,
            end_damage_reported, end_damage_notes, lat, lng
        } = req.body;

        const kmNum = parseInt(end_km);
        const minAllowedKm = trip.overnight_km ? Math.max(trip.start_km, trip.overnight_km) : trip.start_km;
        if (isNaN(kmNum) || kmNum < minAllowedKm) {
            cleanupUploadedFiles(req.files);
            return res.status(400).json({
                error: `O KM de entrega (${end_km}) não pode ser menor que o KM anterior registrado (${minAllowedKm.toLocaleString('pt-BR')} km).`
            });
        }

        const now = new Date().toISOString();
        const slotLabels = {
            photo_panel: 'Painel na Entrega / KM Final',
            photo_front: 'Frente + Lateral Esq. (Entrega)',
            photo_rear: 'Traseira + Lateral Dir. (Entrega)',
            photo_interior: 'Interior / Caçamba (Entrega)'
        };
        const photos = [];
        if (req.files) {
            for (const [slot, label] of Object.entries(slotLabels)) {
                if (req.files[slot] && req.files[slot][0]) {
                    photos.push({
                        slot,
                        label,
                        url: `/uploads_frota/${req.files[slot][0].filename}`,
                        timestamp: now
                    });
                }
            }
        }

        if (photos.length < 2) {
            cleanupUploadedFiles(req.files);
            return res.status(400).json({ error: 'Tire pelo menos a foto do Painel (KM final) e externas na devolução.' });
        }

        const endDamage = (end_damage_reported === '1' || end_damage_reported === 'true' || end_damage_reported === true) ? 1 : 0;
        const totalHasDamage = (trip.has_damage === 1 || endDamage === 1) ? 1 : 0;
        const distanceKm = kmNum - trip.start_km;
        const overnightToYardKm = trip.overnight_km ? (kmNum - trip.overnight_km) : null;
        const parsedLat = lat && !isNaN(parseFloat(lat)) ? parseFloat(lat) : null;
        const parsedLng = lng && !isNaN(parseFloat(lng)) ? parseFloat(lng) : null;
        const fuelLvl = end_fuel_level !== undefined ? parseInt(end_fuel_level) : 50;

        await fRun(
            `UPDATE fleet_trips SET
                status = 'CLOSED',
                checkin_at = ?,
                end_km = ?,
                distance_km = ?,
                overnight_to_yard_km = ?,
                end_fuel_level = ?,
                end_cleanliness = ?,
                end_damage_reported = ?,
                end_damage_notes = ?,
                end_photos_json = ?,
                end_lat = ?,
                end_lng = ?,
                has_damage = ?
             WHERE id = ?`,
            [
                now, kmNum, distanceKm, overnightToYardKm,
                isNaN(fuelLvl) ? 50 : fuelLvl, end_cleanliness || 'LIMPO',
                endDamage, end_damage_notes ? String(end_damage_notes).trim() : null,
                JSON.stringify(photos), parsedLat, parsedLng, totalHasDamage, trip.id
            ]
        );

        await fRun(
            `UPDATE fleet_vehicles SET
                status = 'NO_PATIO',
                current_trip_id = NULL,
                current_driver_username = NULL,
                current_driver_name = NULL,
                current_km = ?,
                current_fuel_level = ?,
                last_lat = COALESCE(?, last_lat),
                last_lng = COALESCE(?, last_lng),
                last_speed_kmh = 0,
                last_ignition = 0,
                updated_at = ?
             WHERE id = ?`,
            [kmNum, isNaN(fuelLvl) ? 50 : fuelLvl, parsedLat, parsedLng, now, trip.vehicle_id]
        );

        if (parsedLat !== null && parsedLng !== null) {
            await fRun(
                `INSERT INTO fleet_telemetry_points (vehicle_id, trip_id, recorded_at, lat, lng, speed_kmh, ignition, source, event_type)
                 VALUES (?, ?, ?, ?, ?, 0, 0, 'CHECKOUT_MOBILE', 'DEVOLUCAO_PATIO')`,
                [trip.vehicle_id, trip.id, now, parsedLat, parsedLng]
            );
        }

        // Auditoria 1: Nova avaria reportada na entrega
        if (endDamage) {
            await fRun(
                `INSERT INTO fleet_alerts (vehicle_id, trip_id, plate, alert_type, severity, title, description, driver_name, created_at)
                 VALUES (?, ?, ?, 'NEW_DAMAGE', 'CRITICAL', ?, ?, ?, ?)`,
                [
                    trip.vehicle_id, trip.id, trip.plate,
                    `Avaria / Ocorrência na devolução (${trip.plate})`,
                    `${trip.driver_name} devolveu ${trip.vehicle_name} apontando ocorrência: "${end_damage_notes || 'Ver fotos Antes x Depois'}". Fotos travadas permanentemente.`,
                    trip.driver_name, now
                ]
            );
        }

        // Auditoria 2: Rodagem elevada entre o pernoite em casa à noite e a chegada ao pátio de manhã (> 35 km)
        if (overnightToYardKm !== null && overnightToYardKm > 35) {
            await fRun(
                `INSERT INTO fleet_alerts (vehicle_id, trip_id, plate, alert_type, severity, title, description, driver_name, created_at)
                 VALUES (?, ?, ?, 'OVERNIGHT_EXCESS_KM', 'WARNING', ?, ?, ?, ?)`,
                [
                    trip.vehicle_id, trip.id, trip.plate,
                    `Deslocamento alto pós-pernoite (${overnightToYardKm} km) - ${trip.plate}`,
                    `${trip.driver_name} estacionou em pernoite com ${trip.overnight_km.toLocaleString('pt-BR')} km e entregou no pátio com ${kmNum.toLocaleString('pt-BR')} km (+${overnightToYardKm} km).`,
                    trip.driver_name, now
                ]
            );
        }

        // Auditoria 3: Alerta automático de troca de óleo / revisão próxima (faltando <= 500 km ou vencida)
        const vehAfter = await fGet('SELECT * FROM fleet_vehicles WHERE id = ?', [trip.vehicle_id]);
        if (vehAfter) {
            if (vehAfter.next_oil_km && kmNum >= (vehAfter.next_oil_km - 500)) {
                const existingAlert = await fGet(
                    "SELECT id FROM fleet_alerts WHERE vehicle_id = ? AND alert_type = 'MAINTENANCE_DUE' AND resolved = 0",
                    [vehAfter.id]
                );
                if (!existingAlert) {
                    const diff = vehAfter.next_oil_km - kmNum;
                    await fRun(
                        `INSERT INTO fleet_alerts (vehicle_id, trip_id, plate, alert_type, severity, title, description, driver_name, created_at)
                         VALUES (?, ?, ?, 'MAINTENANCE_DUE', ?, ?, ?, ?, ?)`,
                        [
                            vehAfter.id, trip.id, vehAfter.plate,
                            diff <= 0 ? 'CRITICAL' : 'WARNING',
                            diff <= 0 ? `Troca de Óleo VENCIDA (${vehAfter.plate})` : `Troca de Óleo próxima (${vehAfter.plate})`,
                            `Veículo atingiu ${kmNum.toLocaleString('pt-BR')} km (meta de óleo: ${vehAfter.next_oil_km.toLocaleString('pt-BR')} km).`,
                            trip.driver_name, now
                        ]
                    );
                }
            }
        }

        res.json({
            success: true,
            distance_km: distanceKm,
            message: `Veículo devolvido com sucesso! Distância percorrida: ${distanceKm.toLocaleString('pt-BR')} km.`
        });
    }));

    // 7. Encerramento administrativo forçado pela gestão (caso motorista esqueça de dar baixa)
    router.post('/trips/:id/force-checkin', authenticateFleet, requireFleetManager, asyncSafe(async (req, res) => {
        const trip = await fGet('SELECT * FROM fleet_trips WHERE id = ?', [req.params.id]);
        if (!trip || trip.status === 'CLOSED') {
            return res.status(400).json({ error: 'Viagem não encontrada ou já encerrada.' });
        }
        const veh = await fGet('SELECT * FROM fleet_vehicles WHERE id = ?', [trip.vehicle_id]);
        const endKm = parseInt(req.body.end_km) || (veh ? veh.current_km : trip.start_km);
        const now = new Date().toISOString();
        const note = `[Baixa administrativa por ${req.user.username}]: ${req.body.notes || 'Encerrado pelo painel de gestão'}`;

        await fRun(
            `UPDATE fleet_trips SET
                status = 'CLOSED',
                checkin_at = ?,
                end_km = ?,
                distance_km = ?,
                end_fuel_level = COALESCE(?, start_fuel_level),
                manager_notes = COALESCE(manager_notes || ' | ', '') || ?,
                closed_by_manager = ?
             WHERE id = ?`,
            [now, Math.max(endKm, trip.start_km), Math.max(0, endKm - trip.start_km), veh ? veh.current_fuel_level : 50, note, req.user.username, trip.id]
        );

        await fRun(
            `UPDATE fleet_vehicles SET
                status = 'NO_PATIO',
                current_trip_id = NULL,
                current_driver_username = NULL,
                current_driver_name = NULL,
                current_km = ?,
                last_speed_kmh = 0,
                last_ignition = 0,
                updated_at = ?
             WHERE id = ?`,
            [Math.max(endKm, trip.start_km), now, trip.vehicle_id]
        );

        res.json({ success: true, message: 'Posse encerrada e veículo liberado no pátio.' });
    }));

    // 8. Travar/destravar fotos permanentemente + observação do gestor na viagem
    router.put('/trips/:id/lock-photos', authenticateFleet, requireFleetManager, asyncSafe(async (req, res) => {
        const { keep_forever, manager_notes } = req.body;
        await fRun(
            `UPDATE fleet_trips SET
                keep_forever = COALESCE(?, keep_forever),
                manager_notes = COALESCE(?, manager_notes)
             WHERE id = ?`,
            [
                keep_forever !== undefined ? (keep_forever ? 1 : 0) : null,
                manager_notes !== undefined ? manager_notes : null,
                req.params.id
            ]
        );
        res.json({ success: true });
    }));

    // 9. Registrar Abastecimento + cálculo automático de média km/L
    router.post('/fuel', authenticateFleet, fleetUpload.single('receipt_photo'), asyncSafe(async (req, res) => {
        const disk = checkDiskSafetyBreaker();
        if (disk.breakerTripped && req.file) {
            cleanupUploadedFiles([req.file]);
            req.file = null; // Salva o abastecimento em texto mesmo se o disjuntor de foto disparar!
        }

        const { vehicle_id, driver_real_name, km_at_fuel, liters, total_cost_brl, fuel_kind, full_tank, notes } = req.body;
        const veh = await fGet('SELECT * FROM fleet_vehicles WHERE id = ?', [vehicle_id]);
        if (!veh) {
            if (req.file) cleanupUploadedFiles([req.file]);
            return res.status(404).json({ error: 'Veículo não encontrado.' });
        }

        const kmNum = parseInt(km_at_fuel);
        const litNum = parseFloat(String(liters).replace(',', '.'));
        const costNum = parseFloat(String(total_cost_brl).replace(',', '.'));
        if (isNaN(kmNum) || isNaN(litNum) || litNum <= 0 || isNaN(costNum) || costNum <= 0) {
            if (req.file) cleanupUploadedFiles([req.file]);
            return res.status(400).json({ error: 'Informe KM, litros e valor total válidos.' });
        }

        const isFull = (full_tank === '1' || full_tank === 'true' || full_tank === true || full_tank === 1) ? 1 : 0;
        let kmPerLiter = null;
        if (isFull) {
            const prevFull = await fGet(
                `SELECT km_at_fuel FROM fleet_fuel_logs
                 WHERE vehicle_id = ? AND full_tank = 1 AND km_at_fuel < ?
                 ORDER BY km_at_fuel DESC LIMIT 1`,
                [veh.id, kmNum]
            );
            if (prevFull && (kmNum - prevFull.km_at_fuel) > 5 && (kmNum - prevFull.km_at_fuel) < 2000) {
                kmPerLiter = Math.round(((kmNum - prevFull.km_at_fuel) / litNum) * 100) / 100;
            }
        }

        const driverName = (driver_real_name || '').trim() || veh.current_driver_name || getFriendlyUserName(req.user.username);
        const now = new Date().toISOString();
        const photoUrl = req.file ? `/uploads_frota/${req.file.filename}` : null;
        const pricePerLiter = Math.round((costNum / litNum) * 1000) / 1000;

        await fRun(
            `INSERT INTO fleet_fuel_logs (
                vehicle_id, trip_id, plate, driver_username, driver_name, created_at,
                km_at_fuel, liters, total_cost_brl, price_per_liter, fuel_kind, full_tank,
                receipt_photo_url, calculated_km_per_liter, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                veh.id, veh.current_trip_id || null, veh.plate, req.user.username, driverName, now,
                kmNum, litNum, costNum, pricePerLiter, fuel_kind || veh.fuel_type, isFull,
                photoUrl, kmPerLiter, notes || null
            ]
        );

        await fRun(
            `UPDATE fleet_vehicles SET
                current_km = MAX(current_km, ?),
                current_fuel_level = CASE WHEN ? = 1 THEN 100 ELSE current_fuel_level END,
                updated_at = ?
             WHERE id = ?`,
            [kmNum, isFull, now, veh.id]
        );

        res.json({
            success: true,
            calculated_km_per_liter: kmPerLiter,
            message: kmPerLiter
                ? `Abastecimento salvo! Consumo calculado: ${kmPerLiter} km/L.`
                : 'Abastecimento registrado com sucesso!'
        });
    }));

    // 10. Dashboard consolidado para /frota (Gestor)
    router.get('/dashboard', authenticateFleet, requireFleetManager, asyncSafe(async (req, res) => {
        const vehicles = await fAll(
            `SELECT v.*,
                    t.checkout_at AS active_checkout_at,
                    t.purpose_type AS active_purpose_type,
                    t.destination AS active_destination,
                    t.project_code AS active_project_code,
                    t.start_km AS active_start_km,
                    t.start_photos_json AS active_start_photos_json,
                    t.overnight_at AS active_overnight_at,
                    t.overnight_km AS active_overnight_km,
                    t.overnight_photo_url AS active_overnight_photo_url
             FROM fleet_vehicles v
             LEFT JOIN fleet_trips t ON v.current_trip_id = t.id
             WHERE v.active = 1
             ORDER BY v.code ASC`
        );

        const openAlerts = await fAll(
            `SELECT * FROM fleet_alerts WHERE resolved = 0 ORDER BY
             CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'WARNING' THEN 2 ELSE 3 END,
             created_at DESC LIMIT 50`
        );

        const recentTrips = await fAll(
            `SELECT * FROM fleet_trips ORDER BY checkout_at DESC LIMIT 30`
        );

        const monthPrefix = new Date().toISOString().slice(0, 7); // YYYY-MM
        const monthFuel = await fGet(
            `SELECT COALESCE(SUM(total_cost_brl), 0) AS cost_month,
                    COALESCE(SUM(liters), 0) AS liters_month,
                    ROUND(AVG(calculated_km_per_liter), 2) AS avg_km_l
             FROM fleet_fuel_logs WHERE created_at LIKE ?`,
            [`${monthPrefix}%`]
        );

        const monthKm = await fGet(
            `SELECT COALESCE(SUM(distance_km), 0) AS km_month,
                    COUNT(*) AS trips_month
             FROM fleet_trips WHERE checkout_at LIKE ?`,
            [`${monthPrefix}%`]
        );

        const rawDrivers = await fAll('SELECT * FROM fleet_drivers ORDER BY active DESC, full_name ASC');
        const drivers = rawDrivers.map(d => {
            const cnh = computeCnhStatus(d.cnh_expiry_date);
            const { pin_hash, ...safe } = d;
            return Object.assign(safe, {
                cnh_status: cnh.status,
                cnh_days_left: cnh.daysLeft,
                default_pin_hint: d.cpf ? d.cpf.slice(0, 6) : ''
            });
        });

        await attachReservationsToVehicles(vehicles);

        const cutoffHistoryIso = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
        const reservations = await fAll(
            `SELECT * FROM fleet_reservations
             WHERE status IN ('PENDING', 'APPROVED') OR start_at >= ?
             ORDER BY
               CASE status WHEN 'PENDING' THEN 0 WHEN 'APPROVED' THEN 1 ELSE 2 END,
               start_at ASC
             LIMIT 120`,
            [cutoffHistoryIso]
        );
        const nowIso = new Date().toISOString();
        const pendingReservationsCount = reservations.filter(r => r.status === 'PENDING').length;
        const upcomingApprovedCount = reservations.filter(r => r.status === 'APPROVED' && r.end_at >= nowIso).length;

        const settings = await getSettingsMap();
        const disk = checkDiskSafetyBreaker();
        const localLanIp = detectLocalLanIp();
        const publicCloudUrl = (process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || '').replace(/\/$/, '');

        res.json({
            success: true,
            managerProfile: {
                username: req.user.username,
                friendlyName: getFriendlyUserName(req.user.username),
                isRhOnly: isRhFleetUser(req.user) && !canManageVehiclesAndReservations(req.user),
                canApproveReservations: canManageVehiclesAndReservations(req.user)
            },
            vehicles,
            drivers,
            reservations,
            openAlerts,
            recentTrips,
            metrics: {
                inYard: vehicles.filter(v => v.status === 'NO_PATIO').length,
                onRoad: vehicles.filter(v => v.status === 'EM_USO').length,
                overnight: vehicles.filter(v => v.status === 'PERNOITE_CASA').length,
                maintenance: vehicles.filter(v => v.status === 'MANUTENCAO').length,
                openAlertsCount: openAlerts.length,
                pendingReservationsCount,
                upcomingApprovedCount,
                driversCount: drivers.filter(d => d.active === 1).length,
                cnhAttentionCount: drivers.filter(d => d.active === 1 && d.cnh_status !== 'VALID').length,
                monthKm: monthKm ? monthKm.km_month : 0,
                monthTrips: monthKm ? monthKm.trips_month : 0,
                monthFuelCostBrl: monthFuel ? monthFuel.cost_month : 0,
                monthAvgKmL: monthFuel ? monthFuel.avg_km_l : null
            },
            disk,
            settings,
            localLanIp,
            publicCloudUrl
        });
    }));

    // 10A. AGENDA & RESERVA ANTECIPADA DE VEÍCULOS (Solicitação pelo Motorista -> Aprovação pela Gestão)
    router.get('/reservations', authenticateFleet, asyncSafe(async (req, res) => {
        const cutoffIso = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
        const rows = await fAll(
            `SELECT * FROM fleet_reservations
             WHERE status IN ('PENDING', 'APPROVED') OR start_at >= ?
             ORDER BY
               CASE status WHEN 'PENDING' THEN 0 WHEN 'APPROVED' THEN 1 ELSE 2 END,
               start_at ASC
             LIMIT 120`,
            [cutoffIso]
        );
        res.json({ success: true, reservations: rows });
    }));

    router.post('/reservations', authenticateFleet, asyncSafe(async (req, res) => {
        const {
            vehicle_id, driver_id, driver_real_name, purpose_type, destination,
            project_code, start_at, end_at, notes
        } = req.body;

        const veh = await fGet('SELECT * FROM fleet_vehicles WHERE id = ? AND active = 1', [vehicle_id]);
        if (!veh) return res.status(404).json({ error: 'Selecione um veículo válido.' });

        const startIso = normalizeIsoTimestamp(start_at);
        const endIso = normalizeIsoTimestamp(end_at);
        const nowIso = new Date().toISOString();

        if (!startIso || !endIso) {
            return res.status(400).json({ error: 'Informe a data/hora inicial e a previsão de retorno da reserva.' });
        }
        if (endIso <= startIso) {
            return res.status(400).json({ error: 'A data/hora de retorno deve ser posterior à data/hora de saída.' });
        }
        if (endIso <= nowIso) {
            return res.status(400).json({ error: 'O período informado já passou. Escolha uma data/hora futura.' });
        }
        if (!destination || !String(destination).trim()) {
            return res.status(400).json({ error: 'Informe o cliente ou destino da visita agendada.' });
        }

        const isResMgr = canManageVehiclesAndReservations(req.user);
        let targetDrv = req.fleetDriver || null;
        if (isResMgr && driver_id) {
            const found = await fGet('SELECT * FROM fleet_drivers WHERE id = ?', [parseInt(driver_id)]);
            if (found) targetDrv = found;
        }

        if (targetDrv) {
            if (targetDrv.active === 0) {
                return res.status(403).json({ error: 'Condutor desativado pela gestão.' });
            }
            const startDayStr = startIso.slice(0, 10);
            if (targetDrv.cnh_expiry_date && targetDrv.cnh_expiry_date < startDayStr) {
                const expBr = targetDrv.cnh_expiry_date.split('-').reverse().join('/');
                return res.status(403).json({
                    error: `⛔ A CNH de ${targetDrv.full_name} vence em ${expBr} (antes da data da viagem agendada). Regularize a CNH primeiro.`
                });
            }
        }

        // Impedir choque direto com outra reserva JÁ APROVADA no mesmo veículo e horário
        const conflictApproved = await fGet(
            `SELECT * FROM fleet_reservations
             WHERE vehicle_id = ?
               AND status = 'APPROVED'
               AND NOT (end_at <= ? OR start_at >= ?)
             ORDER BY start_at ASC LIMIT 1`,
            [veh.id, startIso, endIso]
        );
        if (conflictApproved) {
            return res.status(409).json({
                error: `⚠️ Este veículo (${veh.name} - ${veh.plate}) já possui reserva APROVADA para ${conflictApproved.driver_name} de ${formatIsoBr(conflictApproved.start_at)} até ${formatIsoBr(conflictApproved.end_at)} (${conflictApproved.destination}). Escolha outro veículo ou outro horário.`
            });
        }

        const finalDriverName = targetDrv
            ? targetDrv.full_name
            : (String(driver_real_name || '').trim() || getFriendlyUserName(req.user.username));
        const finalDriverUsername = targetDrv
            ? (targetDrv.mrp_username || targetDrv.login_key)
            : req.user.username;

        // Se o Gestor de Frota (Patrícia / Gilson / Diretoria) cadastrar, já nasce APROVADA; se o motorista solicitar, nasce PENDENTE!
        const initialStatus = isResMgr ? 'APPROVED' : 'PENDING';
        const r = await fRun(
            `INSERT INTO fleet_reservations (
                vehicle_id, plate, vehicle_name, driver_id, driver_username, driver_name,
                purpose_type, destination, project_code, start_at, end_at, notes,
                status, reviewed_by, reviewed_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                veh.id, veh.plate, veh.name,
                targetDrv ? targetDrv.id : null,
                finalDriverUsername, finalDriverName,
                purpose_type || 'VISITA_COMERCIAL',
                String(destination).trim(),
                project_code ? String(project_code).trim() : null,
                startIso, endIso,
                notes ? String(notes).trim() : null,
                initialStatus,
                isResMgr ? req.user.username : null,
                isResMgr ? nowIso : null,
                nowIso, nowIso
            ]
        );

        const created = await fGet('SELECT * FROM fleet_reservations WHERE id = ?', [r.lastID]);
        res.json({
            success: true,
            reservation: created,
            message: isResMgr
                ? `✅ Reserva criada e já APROVADA para ${finalDriverName} (${veh.plate})!`
                : `📨 Solicitação enviada! Sua reserva do ${veh.name} (${veh.plate}) está PENDENTE aguardando aprovação da Gestão.`
        });
    }));

    router.put('/reservations/:id/status', authenticateFleet, requireVehicleReservationManager, asyncSafe(async (req, res) => {
        const resRow = await fGet('SELECT * FROM fleet_reservations WHERE id = ?', [req.params.id]);
        if (!resRow) return res.status(404).json({ error: 'Reserva não encontrada.' });

        const { action, vehicle_id, manager_notes } = req.body;
        const nowIso = new Date().toISOString();

        let targetVeh = await fGet('SELECT * FROM fleet_vehicles WHERE id = ?', [vehicle_id || resRow.vehicle_id]);
        if (!targetVeh) return res.status(404).json({ error: 'Veículo selecionado não encontrado.' });

        let nextStatus = resRow.status;
        if (action === 'APPROVE') {
            const conflict = await fGet(
                `SELECT * FROM fleet_reservations
                 WHERE id != ?
                   AND vehicle_id = ?
                   AND status = 'APPROVED'
                   AND NOT (end_at <= ? OR start_at >= ?)
                 LIMIT 1`,
                [resRow.id, targetVeh.id, resRow.start_at, resRow.end_at]
            );
            if (conflict) {
                return res.status(409).json({
                    error: `Conflito: ${targetVeh.name} (${targetVeh.plate}) já está APROVADO para ${conflict.driver_name} (${formatIsoBr(conflict.start_at)} até ${formatIsoBr(conflict.end_at)}). Troque o veículo ou cancele a outra reserva primeiro.`
                });
            }
            nextStatus = 'APPROVED';
        } else if (action === 'REJECT') {
            nextStatus = 'REJECTED';
        } else if (action === 'CANCEL') {
            nextStatus = 'CANCELLED';
        } else {
            return res.status(400).json({ error: 'Ação inválida.' });
        }

        await fRun(
            `UPDATE fleet_reservations SET
                vehicle_id = ?,
                plate = ?,
                vehicle_name = ?,
                status = ?,
                reviewed_by = ?,
                reviewed_at = ?,
                manager_notes = COALESCE(?, manager_notes),
                updated_at = ?
             WHERE id = ?`,
            [
                targetVeh.id, targetVeh.plate, targetVeh.name,
                nextStatus, req.user.username, nowIso,
                manager_notes !== undefined ? String(manager_notes).trim() : null,
                nowIso, resRow.id
            ]
        );

        const updated = await fGet('SELECT * FROM fleet_reservations WHERE id = ?', [resRow.id]);
        res.json({ success: true, reservation: updated });
    }));

    router.post('/reservations/:id/cancel', authenticateFleet, asyncSafe(async (req, res) => {
        const resRow = await fGet('SELECT * FROM fleet_reservations WHERE id = ?', [req.params.id]);
        if (!resRow) return res.status(404).json({ error: 'Reserva não encontrada.' });

        const isMgr = isFleetManagerUser(req.user);
        const uname = String(req.user.username || '').toLowerCase().trim();
        const drv = req.fleetDriver || null;
        const isOwner =
            (drv && resRow.driver_id === drv.id) ||
            String(resRow.driver_username || '').toLowerCase() === uname;

        if (!isMgr && !isOwner) {
            return res.status(403).json({ error: 'Somente o solicitante ou a Gestão podem cancelar esta reserva.' });
        }

        const nowIso = new Date().toISOString();
        await fRun(
            `UPDATE fleet_reservations SET status = 'CANCELLED', updated_at = ? WHERE id = ?`,
            [nowIso, resRow.id]
        );
        res.json({ success: true, message: 'Reserva cancelada.' });
    }));

    // 10B. Gestão de Condutores Habilitados & CNH (Tecfag e Valem)
    router.get('/drivers', authenticateFleet, requireFleetManager, asyncSafe(async (req, res) => {
        const rawDrivers = await fAll('SELECT * FROM fleet_drivers ORDER BY active DESC, full_name ASC');
        const drivers = rawDrivers.map(d => {
            const cnh = computeCnhStatus(d.cnh_expiry_date);
            const { pin_hash, ...safe } = d;
            return Object.assign(safe, { cnh_status: cnh.status, cnh_days_left: cnh.daysLeft });
        });
        res.json({ success: true, drivers });
    }));

    router.post('/drivers', authenticateFleet, requireFleetManager, asyncSafe(async (req, res) => {
        const {
            full_name, cpf, rg, cnh_number, cnh_category, cnh_issue_date, cnh_expiry_date,
            first_license_date, birth_date, uf_city, company, department, phone, mrp_username, login_key, custom_pin
        } = req.body;

        const cleanCpf = String(cpf || '').replace(/\D/g, '');
        if (!full_name || cleanCpf.length !== 11 || !cnh_number || !cnh_expiry_date) {
            return res.status(400).json({ error: 'Nome completo, CPF (11 dígitos), Nº Registro CNH e Data de Validade da CNH são obrigatórios.' });
        }

        let finalLoginKey = String(login_key || '').toLowerCase().trim().replace(/[^a-z0-9._-]/g, '');
        if (!finalLoginKey) {
            finalLoginKey = String(full_name).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/\s+/)[0].replace(/[^a-z0-9]/g, '');
        }
        const conflict = await fGet('SELECT id FROM fleet_drivers WHERE LOWER(login_key) = ?', [finalLoginKey]);
        if (conflict) {
            finalLoginKey = `${finalLoginKey}.${cleanCpf.slice(0, 3)}`;
        }

        const pinPlain = (custom_pin && String(custom_pin).trim()) ? String(custom_pin).trim() : cleanCpf.slice(0, 6);
        const now = new Date().toISOString();

        const r = await fRun(
            `INSERT INTO fleet_drivers (
                login_key, full_name, cpf, rg, cnh_number, cnh_category,
                cnh_issue_date, cnh_expiry_date, first_license_date, birth_date, uf_city,
                company, department, phone, mrp_username, pin_hash, active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            [
                finalLoginKey, String(full_name).toUpperCase().trim(), cleanCpf, rg || null,
                String(cnh_number).replace(/\D/g, ''), String(cnh_category || 'B').toUpperCase().trim(),
                cnh_issue_date || null, cnh_expiry_date, first_license_date || null, birth_date || null, uf_city || null,
                company || 'TECFAG', department || 'Operacional', phone || null, mrp_username ? String(mrp_username).trim() : null,
                hashFleetPin(pinPlain), now, now
            ]
        );

        res.json({ success: true, id: r.lastID, login_key: finalLoginKey, initial_pin: pinPlain });
    }));

    router.put('/drivers/:id', authenticateFleet, requireFleetManager, asyncSafe(async (req, res) => {
        const drv = await fGet('SELECT * FROM fleet_drivers WHERE id = ?', [req.params.id]);
        if (!drv) return res.status(404).json({ error: 'Condutor não encontrado.' });

        const {
            full_name, cpf, rg, cnh_number, cnh_category, cnh_expiry_date,
            company, department, phone, mrp_username, login_key, active, new_pin
        } = req.body;

        const cleanCpf = cpf ? String(cpf).replace(/\D/g, '') : drv.cpf;
        const nextPinHash = (new_pin && String(new_pin).trim()) ? hashFleetPin(new_pin) : drv.pin_hash;

        await fRun(
            `UPDATE fleet_drivers SET
                login_key = ?, full_name = ?, cpf = ?, rg = ?, cnh_number = ?, cnh_category = ?, cnh_expiry_date = ?,
                company = ?, department = ?, phone = ?, mrp_username = ?, pin_hash = ?, active = ?, updated_at = ?
             WHERE id = ?`,
            [
                login_key ? String(login_key).toLowerCase().trim() : drv.login_key,
                full_name ? String(full_name).toUpperCase().trim() : drv.full_name,
                cleanCpf,
                rg !== undefined ? rg : drv.rg,
                cnh_number ? String(cnh_number).replace(/\D/g, '') : drv.cnh_number,
                cnh_category ? String(cnh_category).toUpperCase().trim() : drv.cnh_category,
                cnh_expiry_date || drv.cnh_expiry_date,
                company || drv.company,
                department !== undefined ? department : drv.department,
                phone !== undefined ? phone : drv.phone,
                mrp_username !== undefined ? (mrp_username ? String(mrp_username).trim() : null) : drv.mrp_username,
                nextPinHash,
                active !== undefined ? (active ? 1 : 0) : drv.active,
                new Date().toISOString(),
                drv.id
            ]
        );
        res.json({ success: true });
    }));

    router.delete('/drivers/:id', authenticateFleet, requireFleetManager, asyncSafe(async (req, res) => {
        await fRun('DELETE FROM fleet_drivers WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    }));

    // 11. Listagem filtrável de viagens & detalhe completo Antes x Depois
    router.get('/trips', authenticateFleet, requireFleetManager, asyncSafe(async (req, res) => {
        const { vehicle_id, driver, status, only_damage, project_code, date_from, date_to } = req.query;
        const clauses = ['1=1'];
        const params = [];

        if (vehicle_id && vehicle_id !== 'ALL') {
            clauses.push('vehicle_id = ?');
            params.push(parseInt(vehicle_id));
        }
        if (status && status !== 'ALL') {
            clauses.push('status = ?');
            params.push(status);
        }
        if (only_damage === '1') {
            clauses.push('(has_damage = 1 OR keep_forever = 1)');
        }
        if (driver && driver.trim()) {
            clauses.push('(LOWER(driver_name) LIKE ? OR LOWER(driver_username) LIKE ? OR LOWER(destination) LIKE ?)');
            const term = `%${driver.trim().toLowerCase()}%`;
            params.push(term, term, term);
        }
        if (project_code && project_code.trim()) {
            clauses.push('LOWER(project_code) LIKE ?');
            params.push(`%${project_code.trim().toLowerCase()}%`);
        }
        if (date_from) {
            clauses.push('checkout_at >= ?');
            params.push(`${date_from}T00:00:00`);
        }
        if (date_to) {
            clauses.push('checkout_at <= ?');
            params.push(`${date_to}T23:59:59`);
        }

        const trips = await fAll(
            `SELECT * FROM fleet_trips WHERE ${clauses.join(' AND ')} ORDER BY checkout_at DESC LIMIT 200`,
            params
        );
        res.json({ success: true, trips });
    }));

    router.get('/trips/:id', authenticateFleet, asyncSafe(async (req, res) => {
        const trip = await fGet('SELECT * FROM fleet_trips WHERE id = ?', [req.params.id]);
        if (!trip) return res.status(404).json({ error: 'Viagem não encontrada.' });
        const fuelLogs = await fAll('SELECT * FROM fleet_fuel_logs WHERE trip_id = ? ORDER BY created_at ASC', [trip.id]);
        const points = await fAll('SELECT * FROM fleet_telemetry_points WHERE trip_id = ? ORDER BY recorded_at ASC', [trip.id]);
        res.json({ success: true, trip, fuelLogs, points });
    }));

    // 12. BUSCADOR INSTANTÂNEO DE MULTA POR DATA E HORA ("Quem estava com o carro neste minuto?")
    router.get('/fine-lookup', authenticateFleet, requireFleetManager, asyncSafe(async (req, res) => {
        const { vehicle_id, datetime } = req.query;
        if (!vehicle_id || !datetime) {
            return res.status(400).json({ error: 'Selecione o veículo e a data/hora da infração.' });
        }

        const targetDate = new Date(datetime);
        if (isNaN(targetDate.getTime())) {
            return res.status(400).json({ error: 'Data/hora inválida.' });
        }
        const targetIso = targetDate.toISOString();

        // Viagem exata que cobria aquele instante
        const exactTrip = await fGet(
            `SELECT * FROM fleet_trips
             WHERE vehicle_id = ?
               AND checkout_at <= ?
               AND (checkin_at IS NULL OR checkin_at >= ?)
             ORDER BY checkout_at DESC LIMIT 1`,
            [parseInt(vehicle_id), targetIso, targetIso]
        );

        // Viagens imediatamente anterior e posterior (caso relógio do radar tenha diferença de poucos minutos)
        const prevTrip = await fGet(
            `SELECT * FROM fleet_trips WHERE vehicle_id = ? AND checkin_at < ? ORDER BY checkin_at DESC LIMIT 1`,
            [parseInt(vehicle_id), targetIso]
        );
        const nextTrip = await fGet(
            `SELECT * FROM fleet_trips WHERE vehicle_id = ? AND checkout_at > ? ORDER BY checkout_at ASC LIMIT 1`,
            [parseInt(vehicle_id), targetIso]
        );

        // Ponto de telemetria GPS mais próximo daquele minuto
        const nearestTelemetry = await fGet(
            `SELECT *, ABS(strftime('%s', recorded_at) - strftime('%s', ?)) AS diff_sec
             FROM fleet_telemetry_points
             WHERE vehicle_id = ?
             ORDER BY diff_sec ASC LIMIT 1`,
            [targetIso, parseInt(vehicle_id)]
        );

        res.json({
            success: true,
            queriedIso: targetIso,
            exactTrip: exactTrip || null,
            nearbyTrips: [prevTrip, nextTrip].filter(Boolean),
            nearestTelemetry: (nearestTelemetry && nearestTelemetry.diff_sec <= 3600) ? nearestTelemetry : null
        });
    }));

    // 13. Multas, Manutenções & Abastecimentos (Listagem e Cadastro)
    router.get('/fines', authenticateFleet, requireFleetManager, asyncSafe(async (req, res) => {
        const records = await fAll(
            `SELECT f.*, v.name AS vehicle_name
             FROM fleet_fines_occurrences f
             LEFT JOIN fleet_vehicles v ON f.vehicle_id = v.id
             ORDER BY f.occurred_at DESC LIMIT 200`
        );
        const fuelLogs = await fAll(
            `SELECT fl.*, v.name AS vehicle_name
             FROM fleet_fuel_logs fl
             LEFT JOIN fleet_vehicles v ON fl.vehicle_id = v.id
             ORDER BY fl.created_at DESC LIMIT 150`
        );
        res.json({ success: true, records, fuelLogs });
    }));

    router.post('/fines', authenticateFleet, requireFleetManager, asyncSafe(async (req, res) => {
        const {
            vehicle_id, record_type, occurred_at, matched_trip_id, responsible_driver,
            title, location, amount_brl, points_cnh, km_at_service, next_oil_km, status, notes
        } = req.body;

        const veh = await fGet('SELECT * FROM fleet_vehicles WHERE id = ?', [vehicle_id]);
        if (!veh) return res.status(404).json({ error: 'Veículo não encontrado.' });
        if (!title || !occurred_at) return res.status(400).json({ error: 'Descrição e data/hora são obrigatórios.' });

        const isoOccurred = new Date(occurred_at).toISOString();
        const now = new Date().toISOString();

        const r = await fRun(
            `INSERT INTO fleet_fines_occurrences (
                vehicle_id, plate, record_type, occurred_at, matched_trip_id, responsible_driver,
                title, location, amount_brl, points_cnh, km_at_service, status, notes, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                veh.id, veh.plate, record_type || 'MULTA', isoOccurred,
                matched_trip_id || null, responsible_driver || null,
                title, location || null, parseFloat(amount_brl) || 0, parseInt(points_cnh) || 0,
                km_at_service ? parseInt(km_at_service) : null, status || 'PENDENTE', notes || null,
                req.user.username, now
            ]
        );

        // Se for manutenção com nova meta de troca de óleo informada, já atualiza o veículo!
        if (record_type === 'MANUTENCAO' && next_oil_km) {
            await fRun('UPDATE fleet_vehicles SET next_oil_km = ?, updated_at = ? WHERE id = ?', [
                parseInt(next_oil_km), now, veh.id
            ]);
        }

        res.json({ success: true, id: r.lastID });
    }));

    router.put('/fines/:id', authenticateFleet, requireFleetManager, asyncSafe(async (req, res) => {
        const { status, responsible_driver, notes } = req.body;
        await fRun(
            `UPDATE fleet_fines_occurrences SET
                status = COALESCE(?, status),
                responsible_driver = COALESCE(?, responsible_driver),
                notes = COALESCE(?, notes)
             WHERE id = ?`,
            [status || null, responsible_driver || null, notes !== undefined ? notes : null, req.params.id]
        );
        res.json({ success: true });
    }));

    router.delete('/fines/:id', authenticateFleet, requireFleetManager, asyncSafe(async (req, res) => {
        await fRun('DELETE FROM fleet_fines_occurrences WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    }));

    // 14. Alertas e Configurações
    router.put('/alerts/:id/resolve', authenticateFleet, requireFleetManager, asyncSafe(async (req, res) => {
        await fRun(
            `UPDATE fleet_alerts SET resolved = 1, resolved_by = ?, resolved_at = ? WHERE id = ?`,
            [req.user.username, new Date().toISOString(), req.params.id]
        );
        res.json({ success: true });
    }));

    router.put('/settings', authenticateFleet, requireFleetManager, asyncSafe(async (req, res) => {
        const allowedKeys = ['yard_name', 'yard_lat', 'yard_lng', 'yard_radius_meters', 'default_speed_limit_kmh', 'photo_retention_days'];
        for (const k of allowedKeys) {
            if (req.body[k] !== undefined) {
                await fRun('INSERT OR REPLACE INTO fleet_settings (key, value) VALUES (?, ?)', [k, String(req.body[k]).trim()]);
            }
        }
        if (req.body.regenerate_secret) {
            const newSec = crypto.randomBytes(12).toString('hex');
            await fRun("INSERT OR REPLACE INTO fleet_settings (key, value) VALUES ('webhook_secret', ?)", [newSec]);
        }
        const settings = await getSettingsMap();
        res.json({ success: true, settings });
    }));

    // 15. Consulta de Rota / Trecho Percorrido no Mapa (por veículo + data ou por viagem específica)
    router.get('/telemetry/route', authenticateFleet, requireFleetManager, asyncSafe(async (req, res) => {
        const { vehicle_id, date, trip_id } = req.query;
        let points = [];
        let matchingTrips = [];

        if (trip_id) {
            const trip = await fGet('SELECT * FROM fleet_trips WHERE id = ?', [parseInt(trip_id)]);
            if (trip) {
                matchingTrips = [trip];
                points = await fAll(
                    `SELECT * FROM fleet_telemetry_points
                     WHERE trip_id = ? OR (vehicle_id = ? AND recorded_at >= ? AND recorded_at <= ?)
                     ORDER BY recorded_at ASC`,
                    [trip.id, trip.vehicle_id, trip.checkout_at, trip.checkin_at || new Date().toISOString()]
                );
            }
        } else if (vehicle_id && date) {
            const startDay = `${date}T00:00:00`;
            const endDay = `${date}T23:59:59.999Z`;
            points = await fAll(
                `SELECT * FROM fleet_telemetry_points
                 WHERE vehicle_id = ? AND recorded_at >= ? AND recorded_at <= ?
                 ORDER BY recorded_at ASC`,
                [parseInt(vehicle_id), startDay, endDay]
            );
            matchingTrips = await fAll(
                `SELECT id, driver_name, purpose_type, destination, checkout_at, checkin_at, start_km, end_km, distance_km, max_speed_kmh
                 FROM fleet_trips
                 WHERE vehicle_id = ? AND checkout_at <= ? AND (checkin_at IS NULL OR checkin_at >= ?)
                 ORDER BY checkout_at ASC`,
                [parseInt(vehicle_id), endDay, startDay]
            );
        }

        let maxSpeed = 0;
        points.forEach(p => {
            if ((p.speed_kmh || 0) > maxSpeed) maxSpeed = p.speed_kmh;
        });

        res.json({
            success: true,
            points,
            matchingTrips,
            summary: {
                pointsCount: points.length,
                maxSpeedKmh: Math.round(maxSpeed * 10) / 10,
                firstAt: points.length > 0 ? points[0].recorded_at : null,
                lastAt: points.length > 0 ? points[points.length - 1].recorded_at : null
            }
        });
    }));

    // 16. Processador unificado de telemetria 4G (Flespi HTTP Stream / Traccar Webhook / JSON)
    async function ingestTelemetryPacket(pkt, settings) {
        // Extrair IMEI ou Placa de diferentes formatos (Flespi, Traccar, Genérico)
        const imei = String(
            pkt.ident ||
            pkt.imei ||
            (pkt.device && pkt.device.uniqueId) ||
            ''
        ).trim();
        const plateRaw = String(pkt.plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

        let veh = null;
        if (imei) {
            veh = await fGet('SELECT * FROM fleet_vehicles WHERE tracker_imei = ? AND active = 1', [imei]);
        }
        if (!veh && plateRaw) {
            veh = await fGet('SELECT * FROM fleet_vehicles WHERE plate = ? AND active = 1', [plateRaw]);
        }
        if (!veh) return { skipped: true, reason: 'vehicle_not_matched' };

        const pos = pkt.position || pkt;
        const lat = parseFloat(pos['position.latitude'] ?? pos.latitude ?? pos.lat);
        const lng = parseFloat(pos['position.longitude'] ?? pos.longitude ?? pos.lng);
        if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) {
            return { skipped: true, reason: 'invalid_coords' };
        }

        // No Traccar position.speed vem em nós (knots); no Flespi/J16 vem em km/h
        let speedKmh = 0;
        if (pkt.device && pkt.position && pkt.position.speed !== undefined && pkt.speed_kmh === undefined) {
            speedKmh = parseFloat(pkt.position.speed) * 1.852;
        } else {
            speedKmh = parseFloat(pos['position.speed'] ?? pos.speed_kmh ?? pos.speed ?? 0);
        }
        if (isNaN(speedKmh) || speedKmh < 0) speedKmh = 0;
        speedKmh = Math.round(speedKmh * 10) / 10;

        const heading = parseFloat(pos['position.direction'] ?? pos.course ?? pos.heading ?? 0) || 0;
        const ignRaw = pkt['engine.ignition.status'] ?? (pos.attributes && pos.attributes.ignition) ?? pkt.ignition;
        const ignition = ignRaw === undefined ? (speedKmh > 2 ? 1 : veh.last_ignition) : (ignRaw ? 1 : 0);

        let recordedAt = new Date().toISOString();
        if (pkt.timestamp && typeof pkt.timestamp === 'number') {
            recordedAt = new Date(pkt.timestamp > 1e12 ? pkt.timestamp : pkt.timestamp * 1000).toISOString();
        } else if (pos.fixTime || pkt.recorded_at) {
            const d = new Date(pos.fixTime || pkt.recorded_at);
            if (!isNaN(d.getTime())) recordedAt = d.toISOString();
        }

        const source = pkt._source || (pkt.ident ? 'TRACKER_FLESPI' : (pkt.device ? 'TRACKER_TRACCAR' : 'TRACKER_4G'));

        // Filtro anti-inchaço: se o carro está parado com ignição desligada no mesmo ponto (< 20m) em menos de 30 min, só atualiza o heartbeat!
        let shouldInsertPoint = true;
        if (speedKmh < 2 && ignition === 0 && veh.last_ignition === 0 && veh.last_lat && veh.last_lng && veh.last_telemetry_at) {
            const dist = haversineMeters(veh.last_lat, veh.last_lng, lat, lng);
            const ageMs = Date.now() - new Date(veh.last_telemetry_at).getTime();
            if (dist !== null && dist < 20 && ageMs < 30 * 60 * 1000) {
                shouldInsertPoint = false;
            }
        }

        await fRun(
            `UPDATE fleet_vehicles SET
                last_lat = ?, last_lng = ?, last_speed_kmh = ?, last_ignition = ?, last_telemetry_at = ?, updated_at = ?
             WHERE id = ?`,
            [lat, lng, speedKmh, ignition, recordedAt, new Date().toISOString(), veh.id]
        );

        if (shouldInsertPoint) {
            await fRun(
                `INSERT INTO fleet_telemetry_points (vehicle_id, trip_id, recorded_at, lat, lng, speed_kmh, heading, ignition, source, event_type)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    veh.id,
                    veh.current_trip_id || null,
                    recordedAt,
                    lat,
                    lng,
                    speedKmh,
                    heading,
                    ignition,
                    source,
                    speedKmh > (veh.speed_limit_kmh || 110) ? 'SPEEDING' : 'POSITION'
                ]
            );
        }

        // Atualizar velocidade máxima da viagem ativa e gerar alerta de excesso de velocidade
        const limitKmh = veh.speed_limit_kmh || parseInt(settings.default_speed_limit_kmh) || 110;
        if (veh.current_trip_id && speedKmh > 0) {
            await fRun(
                `UPDATE fleet_trips SET max_speed_kmh = MAX(COALESCE(max_speed_kmh, 0), ?) WHERE id = ?`,
                [speedKmh, veh.current_trip_id]
            );
        }

        if (speedKmh > limitKmh) {
            const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
            const recentSpeedAlert = await fGet(
                `SELECT id FROM fleet_alerts
                 WHERE vehicle_id = ? AND alert_type = 'SPEEDING' AND created_at > ?`,
                [veh.id, tenMinAgo]
            );
            if (!recentSpeedAlert) {
                if (veh.current_trip_id) {
                    await fRun('UPDATE fleet_trips SET speed_alerts_count = COALESCE(speed_alerts_count, 0) + 1 WHERE id = ?', [veh.current_trip_id]);
                }
                await fRun(
                    `INSERT INTO fleet_alerts (vehicle_id, trip_id, plate, alert_type, severity, title, description, driver_name, created_at)
                     VALUES (?, ?, ?, 'SPEEDING', 'CRITICAL', ?, ?, ?, ?)`,
                    [
                        veh.id,
                        veh.current_trip_id || null,
                        veh.plate,
                        `Excesso de velocidade: ${Math.round(speedKmh)} km/h (${veh.plate})`,
                        `${veh.name} atingiu ${Math.round(speedKmh)} km/h (limite configurado: ${limitKmh} km/h). Condutor registrado: ${veh.current_driver_name || 'Sem Check-in!'}.`,
                        veh.current_driver_name || 'Não identificado',
                        recordedAt
                    ]
                );
            }
        }

        // Regra de Ouro: Ignição ligada e veículo saiu da Cerca Virtual do Pátio Tecfag SEM Check-in de motorista!
        if (!veh.current_trip_id && veh.status === 'NO_PATIO' && speedKmh > 12 && settings.yard_lat && settings.yard_lng) {
            const distFromYard = haversineMeters(parseFloat(settings.yard_lat), parseFloat(settings.yard_lng), lat, lng);
            const radius = parseFloat(settings.yard_radius_meters) || 200;
            if (distFromYard !== null && distFromYard > radius) {
                const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
                const recentNoCheckin = await fGet(
                    `SELECT id FROM fleet_alerts
                     WHERE vehicle_id = ? AND alert_type = 'NO_CHECKIN_DEPARTURE' AND created_at > ?`,
                    [veh.id, thirtyMinAgo]
                );
                if (!recentNoCheckin) {
                    await fRun(
                        `INSERT INTO fleet_alerts (vehicle_id, plate, alert_type, severity, title, description, created_at)
                         VALUES (?, ?, 'NO_CHECKIN_DEPARTURE', 'CRITICAL', ?, ?, ?)`,
                        [
                            veh.id,
                            veh.plate,
                            `🚨 Saída do pátio SEM Check-in (${veh.plate})`,
                            `O rastreador detectou ${veh.name} em movimento (${Math.round(speedKmh)} km/h) a ${Math.round(distFromYard)}m do pátio sem que nenhum motorista tenha lido o QR Code!`,
                            recordedAt
                        ]
                    );
                }
            }
        }

        return { ok: true, vehicle_id: veh.id, plate: veh.plate };
    }

    router.post('/webhook/telemetry/:secret', asyncSafe(async (req, res) => {
        const settings = await getSettingsMap();
        if (!settings.webhook_secret || req.params.secret !== settings.webhook_secret) {
            return res.status(401).json({ error: 'Token de webhook inválido.' });
        }

        const payload = Array.isArray(req.body) ? req.body : (Array.isArray(req.body.result) ? req.body.result : [req.body]);
        let processed = 0;
        for (const item of payload) {
            if (item && typeof item === 'object') {
                const r = await ingestTelemetryPacket(item, settings);
                if (r.ok) processed++;
            }
        }
        res.json({ success: true, processed });
    }));

    // 17. Simulador de Trecho/Velocidade no Mapa (para testar o mapa hoje antes dos rastreadores chegarem, com limpeza em 1 clique)
    router.post('/telemetry/simulate', authenticateFleet, requireFleetManager, asyncSafe(async (req, res) => {
        const { action, vehicle_id } = req.body;
        if (action === 'CLEAR') {
            await fRun("DELETE FROM fleet_telemetry_points WHERE source = 'SIMULACAO_TESTE'");
            await fRun("DELETE FROM fleet_alerts WHERE description LIKE '%[SIMULAÇÃO]%'");
            return res.json({ success: true, message: 'Dados de simulação removidos com sucesso.' });
        }

        const veh = await fGet('SELECT * FROM fleet_vehicles WHERE id = ?', [vehicle_id]);
        if (!veh) return res.status(404).json({ error: 'Selecione um veículo para simular.' });

        const settings = await getSettingsMap();
        const baseLat = parseFloat(settings.yard_lat) || -22.3145; // Região Bauru/Interior SP como base padrão
        const baseLng = parseFloat(settings.yard_lng) || -49.0587;
        const todayDate = new Date().toISOString().split('T')[0];

        await fRun("DELETE FROM fleet_telemetry_points WHERE vehicle_id = ? AND source = 'SIMULACAO_TESTE'", [veh.id]);

        const sampleSteps = [
            { min: 0, dLat: 0.0000, dLng: 0.0000, spd: 0, ign: 1 },
            { min: 4, dLat: 0.0042, dLng: 0.0065, spd: 48, ign: 1 },
            { min: 9, dLat: 0.0115, dLng: 0.0150, spd: 76, ign: 1 },
            { min: 15, dLat: 0.0210, dLng: 0.0285, spd: 104, ign: 1 },
            { min: 21, dLat: 0.0325, dLng: 0.0440, spd: 124, ign: 1 }, // Pico acima de 110 km/h para mostrar ponto vermelho no mapa!
            { min: 27, dLat: 0.0410, dLng: 0.0560, spd: 88, ign: 1 },
            { min: 34, dLat: 0.0465, dLng: 0.0620, spd: 42, ign: 1 },
            { min: 38, dLat: 0.0480, dLng: 0.0635, spd: 0, ign: 0 }
        ];

        const baseTime = new Date(`${todayDate}T09:00:00`).getTime();
        let lastPt = null;
        for (const s of sampleSteps) {
            const iso = new Date(baseTime + s.min * 60 * 1000).toISOString();
            const lat = +(baseLat + s.dLat).toFixed(6);
            const lng = +(baseLng + s.dLng).toFixed(6);
            lastPt = { lat, lng, spd: s.spd, ign: s.ign, iso };
            await fRun(
                `INSERT INTO fleet_telemetry_points (vehicle_id, trip_id, recorded_at, lat, lng, speed_kmh, heading, ignition, source, event_type)
                 VALUES (?, ?, ?, ?, ?, ?, 45, ?, 'SIMULACAO_TESTE', ?)`,
                [veh.id, veh.current_trip_id || null, iso, lat, lng, s.spd, s.ign, s.spd > veh.speed_limit_kmh ? 'SPEEDING' : 'POSITION']
            );
        }

        if (lastPt) {
            await fRun(
                `UPDATE fleet_vehicles SET last_lat = ?, last_lng = ?, last_speed_kmh = ?, last_ignition = ?, last_telemetry_at = ? WHERE id = ?`,
                [lastPt.lat, lastPt.lng, lastPt.spd, lastPt.ign, lastPt.iso, veh.id]
            );
        }

        res.json({
            success: true,
            date: todayDate,
            message: `Trajeto de demonstração gerado para ${veh.name} (${veh.plate}) com pico de 124 km/h! Você pode limpar com 1 clique quando quiser.`
        });
    }));

    app.use('/api/fleet', router);

    // Tratador de erros específico do Multer na Frota (para devolver JSON claro se foto exceder 800 KB)
    app.use('/api/fleet', (err, req, res, next) => {
        if (err instanceof multer.MulterError) {
            return res.status(413).json({
                error: err.code === 'LIMIT_FILE_SIZE'
                    ? 'A foto excedeu 800 KB. Use o seletor da página que já comprime a imagem automaticamente.'
                    : `Erro no envio das fotos: ${err.message}`
            });
        }
        if (err) {
            console.error('[FROTA ROUTER ERROR]:', err);
            return res.status(500).json({ error: err.message || 'Erro no módulo de frota.' });
        }
        next();
    });
};
