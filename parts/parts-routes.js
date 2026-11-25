const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const nodemailer = require('nodemailer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const https = require('https');

/**
 * Módulo Isolado de Gestão de Peças Sob Encomenda & Reposição de Máquinas Tecfag
 * Rotas: /pecas e /api/parts/*
 * - Banco SQLite próprio: tecfag_pecas.db (Modo WAL, isolado sem risco ao MRP de Máquinas)
 * - Pasta de anexos própria: uploads_pecas (com disjuntor de 200 MB livres p/ proteger o disco de 1GB do Render)
 * - Integração direta com skus.csv (Aba Cód. Antigo = Código Original no Fornecedor + Nome Fabricante)
 * - Disparo de E-mail Oficial SMTP com Fotos Embutidas (Inline CID) + Anexadas
 * - Regra Oficial de Preço Importação Tecfag: Preço FOB ($) x Dólar x 2 x 2
 * - Fila Expressa dedicada de Cadastro ERP (Jhenifer) acionada somente na venda aprovada / estoque autorizado
 */
module.exports = function registerPartsModule({
    app,
    mrpDb,
    authenticateToken,
    hashPassword,
    DB_DIR,
    getDirectorySize,
    skuNcmMap = {}
}) {
    const PARTS_DB_PATH = process.env.PARTS_DATABASE_PATH || path.join(DB_DIR, 'tecfag_pecas.db');
    const PARTS_UPLOADS_DIR = process.env.PARTS_UPLOADS_PATH || path.join(DB_DIR, 'uploads_pecas');
    const PARTS_BACKUPS_DIR = path.join(DB_DIR, 'backups');
    const PRODUCTS_JSON_PATH = path.join(__dirname, '..', 'data', 'products.json');
    const SKUS_CSV_PATH = path.join(__dirname, '..', 'skus.csv');
    const SIGNATURE_IMG_PATH = path.join(__dirname, '..', 'media', 'email_signature_tecfag.png');
    const HEADER_LOGO_IMG_PATH = path.join(__dirname, '..', 'media', 'tecfag_logo_white.png');

    const TOTAL_DISK_LIMIT_BYTES = (parseFloat(process.env.PARTS_DISK_TOTAL_GB) || 1) * 1024 * 1024 * 1024;
    const MRP_RESERVED_FREE_BYTES = 200 * 1024 * 1024; // 200 MB intocáveis para o MRP principal

    [DB_DIR, PARTS_UPLOADS_DIR, PARTS_BACKUPS_DIR].forEach((dir) => {
        if (!fs.existsSync(dir)) {
            try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
        }
    });

    const partsDb = new sqlite3.Database(PARTS_DB_PATH, (err) => {
        if (err) {
            console.error('[PEÇAS DB] Erro ao abrir tecfag_pecas.db:', err.message);
        } else {
            console.log('[PEÇAS DB] Conectado com sucesso ao banco isolado de peças:', PARTS_DB_PATH);
            initPartsDatabase();
        }
    });

    const pGet = (sql, params = []) => new Promise((resolve, reject) => {
        partsDb.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
    const pAll = (sql, params = []) => new Promise((resolve, reject) => {
        partsDb.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
    });
    const pRun = (sql, params = []) => new Promise((resolve, reject) => {
        partsDb.run(sql, params, function (err) {
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
    const mrpRun = (sql, params = []) => new Promise((resolve, reject) => {
        if (!mrpDb) return resolve({ lastID: null, changes: 0 });
        mrpDb.run(sql, params, function (err) {
            err ? reject(err) : resolve(this);
        });
    });

    const USER_DISPLAY_NAMES = {
        'admin': 'Administrador',
        'gilson': 'Gilson (Diretoria)',
        'gilson@tecfag.com.br': 'Gilson (Diretoria)',
        'vendas18': 'Guilherme Bertola (Peças / Pós-Venda)',
        'vendas18@tecfag.com.br': 'Guilherme Bertola (Peças / Pós-Venda)',
        'guilherme': 'Guilherme Bertola (Peças / Pós-Venda)',
        'assistencia@tecfag.com.br': 'Raiane Aguiar (Assistência / Peças)',
        'assistencia': 'Raiane Aguiar (Assistência / Peças)',
        'raiane': 'Raiane Aguiar (Assistência / Peças)',
        'raiane.aguiar': 'Raiane Aguiar (Assistência / Peças)',
        'assistencia4@tecfag.com.br': 'Maria Vitória (Assistência / Peças)',
        'assistencia4': 'Maria Vitória (Assistência / Peças)',
        'mariavitoria': 'Maria Vitória (Assistência / Peças)',
        'maria.vitoria': 'Maria Vitória (Assistência / Peças)',
        'vitoria': 'Maria Vitória (Assistência / Peças)',
        'vendas21@tecfag.com.br': 'Keicy Cardoso (Vendas / Peças)',
        'vendas21': 'Keicy Cardoso (Vendas / Peças)',
        'keicy': 'Keicy Cardoso (Vendas / Peças)',
        'keicy.cardoso': 'Keicy Cardoso (Vendas / Peças)',
        'assistencia7@tecfag.com.br': 'Matheus Henrique (Assistência / Peças)',
        'assistencia7': 'Matheus Henrique (Assistência / Peças)',
        'matheus': 'Matheus Henrique (Assistência / Peças)',
        'matheus.henrique': 'Matheus Henrique (Assistência / Peças)',
        'jhenifer': 'Jhenifer (Cadastro ERP & Compras)',
        'adm@tecfag.com.br': 'Jhenifer (Cadastro ERP & Compras)',
        'fernando': 'Fernando (Engenharia)',
        'fernando@tecfag.com.br': 'Fernando (Engenharia)',
        'engenharia': 'Equipe Engenharia',
        'heilio': 'Heilio (Assistência Técnica)',
        'assistencia6@tecfag.com.br': 'Heilio (Assistência Técnica)',
        'suporte2': 'Tarcísio (Suporte Técnico)',
        'suporte2@tecfag.com.br': 'Tarcísio (Suporte Técnico)',
        'compras': 'Setor de Compras / Comex',
        'estoque': 'Almoxarifado / Expedição',
        'tecnico': 'Equipe Técnica',
        'vendas': 'Diana (Vendas)',
        'vendas1': 'Alex (Vendas)',
        'vendas2': 'Jhordan (Vendas)',
        'vendas3': 'Nardeli (Vendas)',
        'vendas4': 'Lucas (Vendas)',
        'vendas6': 'Patrícia (Vendas / Frota)',
        'vendas6@tecfag.com.br': 'Patrícia (Vendas / Frota)',
        'joao.lanza': 'João Lanza (Diretor)',
        'gerente': 'Gerente de Projetos',
        'gerente_comercial': 'Gerente Comercial',
        'comercial': 'Comercial'
    };

    function getFriendlyUserName(username) {
        if (!username) return 'Sistema';
        const clean = String(username).toLowerCase().trim();
        return USER_DISPLAY_NAMES[clean] || username;
    }

    function isJheniferUser(user) {
        if (!user) return false;
        const u = String(user.username || '').toLowerCase().trim();
        return u === 'jhenifer' || u === 'adm@tecfag.com.br';
    }

    function isGuilhermeUser(user) {
        if (!user) return false;
        const u = String(user.username || '').toLowerCase().trim();
        return u === 'vendas18' || u === 'vendas18@tecfag.com.br' || u === 'guilherme';
    }

    // Equipe de Abertura & Proposta de Peças (mesmos poderes de Guilherme Bertola)
    function isPartsRequesterTeamUser(userOrUsername) {
        const raw = typeof userOrUsername === 'string' ? userOrUsername : (userOrUsername && userOrUsername.username);
        if (!raw) return false;
        const u = String(raw).toLowerCase().trim();
        return [
            'vendas18', 'vendas18@tecfag.com.br', 'guilherme', 'bertola',
            'assistencia@tecfag.com.br', 'assistencia', 'raiane', 'raiane.aguiar',
            'assistencia4@tecfag.com.br', 'assistencia4', 'mariavitoria', 'maria.vitoria', 'vitoria',
            'vendas21@tecfag.com.br', 'vendas21', 'keicy', 'keicy.cardoso',
            'assistencia7@tecfag.com.br', 'assistencia7', 'matheus', 'matheus.henrique'
        ].includes(u);
    }

    // Chave-Mestra (Acesso Total de Edição e Governança): Gilson, Admin e Fernando
    function isMasterAdminUser(user) {
        if (!user) return false;
        const u = String(user.username || '').toLowerCase().trim();
        return ['admin', 'gilson', 'gilson@tecfag.com.br', 'fernando', 'fernando@tecfag.com.br'].includes(u);
    }

    function expandUserIdentitySet(rawIdentifier) {
        const clean = String(rawIdentifier || '').toLowerCase().trim();
        const set = new Set();
        if (!clean) return set;
        set.add(clean);
        if (['jhenifer', 'adm@tecfag.com.br'].includes(clean)) {
            set.add('jhenifer');
            set.add('adm@tecfag.com.br');
        }
        if (['guilherme', 'bertola', 'vendas18', 'vendas18@tecfag.com.br'].includes(clean)) {
            set.add('guilherme');
            set.add('vendas18');
            set.add('vendas18@tecfag.com.br');
        }
        if (['raiane', 'raiane.aguiar', 'assistencia', 'assistencia@tecfag.com.br'].includes(clean)) {
            set.add('raiane');
            set.add('raiane.aguiar');
            set.add('assistencia');
            set.add('assistencia@tecfag.com.br');
        }
        if (['mariavitoria', 'maria.vitoria', 'vitoria', 'assistencia4', 'assistencia4@tecfag.com.br'].includes(clean)) {
            set.add('mariavitoria');
            set.add('maria.vitoria');
            set.add('vitoria');
            set.add('assistencia4');
            set.add('assistencia4@tecfag.com.br');
        }
        if (['keicy', 'keicy.cardoso', 'vendas21', 'vendas21@tecfag.com.br'].includes(clean)) {
            set.add('keicy');
            set.add('keicy.cardoso');
            set.add('vendas21');
            set.add('vendas21@tecfag.com.br');
        }
        if (['matheus', 'matheus.henrique', 'assistencia7', 'assistencia7@tecfag.com.br'].includes(clean)) {
            set.add('matheus');
            set.add('matheus.henrique');
            set.add('assistencia7');
            set.add('assistencia7@tecfag.com.br');
        }
        if (['gilson', 'gilson@tecfag.com.br'].includes(clean)) {
            set.add('gilson');
            set.add('gilson@tecfag.com.br');
        }
        if (['fernando', 'fernando@tecfag.com.br'].includes(clean)) {
            set.add('fernando');
            set.add('fernando@tecfag.com.br');
        }
        if (['heilio', 'assistencia6@tecfag.com.br'].includes(clean)) {
            set.add('heilio');
            set.add('assistencia6@tecfag.com.br');
        }
        if (['suporte2', 'suporte2@tecfag.com.br'].includes(clean)) {
            set.add('suporte2');
            set.add('suporte2@tecfag.com.br');
        }
        if (['vendas6', 'patricia', 'vendas6@tecfag.com.br'].includes(clean)) {
            set.add('vendas6');
            set.add('patricia');
            set.add('vendas6@tecfag.com.br');
        }
        return set;
    }

    const PARTS_REQUESTERS_DEFAULT_EMAILS = [
        'vendas18@tecfag.com.br',
        'assistencia@tecfag.com.br',
        'assistencia4@tecfag.com.br',
        'vendas21@tecfag.com.br',
        'assistencia7@tecfag.com.br'
    ];
    const PARTS_REQUESTERS_DEFAULT_DISPLAY = 'Guilherme Bertola • Raiane Aguiar • Maria Vitória • Keicy Cardoso • Matheus Henrique';

    const DEFAULT_STAGE_GOVERNANCE = [
        {
            stage_key: 'CREATE_REQUEST',
            stage_label: '➕ Abertura da Solicitação de Peças',
            allowed_users: [...PARTS_REQUESTERS_DEFAULT_EMAILS],
            owner_display: PARTS_REQUESTERS_DEFAULT_DISPLAY
        },
        {
            stage_key: '1_TRIAGEM_TECNICA',
            stage_label: '1️⃣ Etapa 1 — Triagem Técnica (Brasil vs. Importação)',
            allowed_users: ['jhenifer'],
            owner_display: 'Jhenifer (adm@tecfag.com.br)'
        },
        {
            stage_key: '2_COTACAO_FORNECEDOR',
            stage_label: '2️⃣ Etapa 2 — Cotação c/ Fornecedor & Formação de Preço',
            allowed_users: ['jhenifer'],
            owner_display: 'Jhenifer (adm@tecfag.com.br)'
        },
        {
            stage_key: '3_PROPOSTA_CLIENTE',
            stage_label: '3️⃣ Etapa 3 — Proposta ao Cliente & Aprovação/Declínio',
            allowed_users: [...PARTS_REQUESTERS_DEFAULT_EMAILS],
            owner_display: PARTS_REQUESTERS_DEFAULT_DISPLAY
        },
        {
            stage_key: '4_CADASTRO_ERP',
            stage_label: '4️⃣ Etapa 4 — Fila Expressa Cadastro ERP',
            allowed_users: ['jhenifer'],
            owner_display: 'Jhenifer (adm@tecfag.com.br)'
        },
        {
            stage_key: '5_COMPRA_TRANSITO',
            stage_label: '5️⃣ Etapa 5 — Compra Efetivada & Trânsito',
            allowed_users: ['jhenifer'],
            owner_display: 'Jhenifer (adm@tecfag.com.br)'
        },
        {
            stage_key: '6_DOCA_EXPEDICAO',
            stage_label: '6️⃣ Etapa 6 — Recebimento na Doca, Reserva & NF Saída',
            allowed_users: ['jhenifer'],
            owner_display: 'Jhenifer (adm@tecfag.com.br)'
        }
    ];

    function formatOwnersDisplay(usersArr) {
        if (!Array.isArray(usersArr) || usersArr.length === 0) {
            return 'Somente Administradores (Gilson / Fernando)';
        }
        return usersArr.map(u => getFriendlyUserName(u)).join(' • ');
    }

    async function getStageGovernanceMap(user = null) {
        const rows = await pAll('SELECT * FROM parts_stage_permissions').catch(() => []);
        const rowByKey = {};
        rows.forEach(r => { rowByKey[r.stage_key] = r; });

        const isMaster = isMasterAdminUser(user);
        const userKeys = user ? expandUserIdentitySet(user.username) : new Set();
        const result = {};

        for (const def of DEFAULT_STAGE_GOVERNANCE) {
            const dbRow = rowByKey[def.stage_key];
            let allowedUsers = def.allowed_users;
            let ownerDisplay = def.owner_display;
            if (dbRow) {
                try {
                    const parsed = JSON.parse(dbRow.allowed_users_json || '[]');
                    if (Array.isArray(parsed)) allowedUsers = parsed;
                } catch (e) {}
                ownerDisplay = dbRow.owner_display || formatOwnersDisplay(allowedUsers);
            }

            const expandedAllowed = new Set();
            allowedUsers.forEach(u => {
                expandUserIdentitySet(u).forEach(alias => expandedAllowed.add(alias));
            });

            let canEdit = isMaster;
            if (!canEdit && userKeys.size > 0) {
                for (const k of userKeys) {
                    if (expandedAllowed.has(k)) {
                        canEdit = true;
                        break;
                    }
                }
            }

            result[def.stage_key] = {
                stage_key: def.stage_key,
                stage_label: def.stage_label,
                allowed_users: allowedUsers,
                owner_display: ownerDisplay,
                can_edit: canEdit
            };
        }
        return result;
    }

    async function canUserActOnStage(user, stageKey) {
        const isMaster = isMasterAdminUser(user);
        if (isMaster) {
            return { allowed: true, isMaster: true, ownerDisplay: 'Admin / Engenharia Master (Gilson / Fernando)' };
        }
        if (stageKey === '7_CONCLUIDO' || stageKey === '8_DECLINADO_CANCELADO') {
            return {
                allowed: false,
                isMaster: false,
                ownerDisplay: 'Solicitação Encerrada (Somente Admin Gilson / Fernando pode reabrir ou alterar)'
            };
        }
        const govMap = await getStageGovernanceMap(user);
        const entry = govMap[stageKey];
        if (!entry) {
            return { allowed: false, isMaster: false, ownerDisplay: 'Administrador (Gilson / Fernando)' };
        }
        return {
            allowed: !!entry.can_edit,
            isMaster: false,
            ownerDisplay: entry.owner_display
        };
    }

    function resolveOfficialUserEmail(username) {
        if (!username) return 'vendas18@tecfag.com.br';
        const u = String(username).toLowerCase().trim();
        if (u.includes('@')) return u;
        const map = {
            'vendas18': 'vendas18@tecfag.com.br',
            'guilherme': 'vendas18@tecfag.com.br',
            'bertola': 'vendas18@tecfag.com.br',
            'raiane': 'assistencia@tecfag.com.br',
            'raiane.aguiar': 'assistencia@tecfag.com.br',
            'assistencia': 'assistencia@tecfag.com.br',
            'mariavitoria': 'assistencia4@tecfag.com.br',
            'maria.vitoria': 'assistencia4@tecfag.com.br',
            'vitoria': 'assistencia4@tecfag.com.br',
            'assistencia4': 'assistencia4@tecfag.com.br',
            'keicy': 'vendas21@tecfag.com.br',
            'keicy.cardoso': 'vendas21@tecfag.com.br',
            'vendas21': 'vendas21@tecfag.com.br',
            'matheus': 'assistencia7@tecfag.com.br',
            'matheus.henrique': 'assistencia7@tecfag.com.br',
            'assistencia7': 'assistencia7@tecfag.com.br',
            'gilson': 'gilson@tecfag.com.br',
            'admin': 'gilson@tecfag.com.br',
            'jhenifer': 'adm@tecfag.com.br',
            'fernando': 'projetos@grupo.tecfag.com.br',
            'engenharia': 'projetos@grupo.tecfag.com.br',
            'vendas': 'vendas14@tecfag.com.br',
            'vendas1': 'vendas21@tecfag.com.br',
            'vendas2': 'vendas4@tecfag.com.br',
            'vendas3': 'vendas17@tecfag.com.br',
            'vendas4': 'vendas19@tecfag.com.br',
            'vendas6': 'vendas6@tecfag.com.br',
            'patricia': 'vendas6@tecfag.com.br',
            'heilio': 'assistencia6@tecfag.com.br',
            'suporte2': 'suporte2@tecfag.com.br'
        };
        return map[u] || 'vendas18@tecfag.com.br';
    }

    function getProposalConsultantDisplay(emailOrUsername) {
        const clean = String(emailOrUsername || '').toLowerCase().trim();
        const email = resolveOfficialUserEmail(clean);
        if (email === 'vendas18@tecfag.com.br') return 'Guilherme Bertola — Pós-Venda & Peças Tecfag';
        if (email === 'assistencia@tecfag.com.br') return 'Raiane Aguiar — Assistência & Peças Tecfag';
        if (email === 'assistencia4@tecfag.com.br') return 'Maria Vitória — Assistência & Peças Tecfag';
        if (email === 'vendas21@tecfag.com.br') return 'Keicy Cardoso — Pós-Venda & Peças Tecfag';
        if (email === 'assistencia7@tecfag.com.br') return 'Matheus Henrique — Assistência & Peças Tecfag';
        return `${getFriendlyUserName(clean)} — Grupo Tecfag`;
    }

    const SMTP_ENC_KEY = crypto.createHash('sha256').update(process.env.SESSION_SECRET || 'tecfag_parts_smtp_secret_2026').digest();
    function encryptSecret(plain) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', SMTP_ENC_KEY, iv);
        const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
    }
    function decryptSecret(payload) {
        if (!payload) return '';
        const [ivHex, tagHex, encHex] = String(payload).split(':');
        const decipher = crypto.createDecipheriv('aes-256-gcm', SMTP_ENC_KEY, Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
        return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
    }

    // Cache de Câmbio USD/BRL em memória (15 min)
    let cachedRates = {
        usd: 5.80,
        eur: 6.25,
        cny: 0.81,
        updated_at: null,
        source: 'FALLBACK'
    };
    let lastRateFetchMs = 0;

    function fetchJsonHttps(url, timeoutMs = 4500) {
        return new Promise((resolve, reject) => {
            const req = https.get(url, { timeout: timeoutMs }, (res) => {
                let raw = '';
                res.on('data', (chunk) => { raw += chunk; });
                res.on('end', () => {
                    try {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(JSON.parse(raw));
                        } else {
                            reject(new Error('HTTP ' + res.statusCode));
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Timeout'));
            });
        });
    }

    async function getLiveExchangeRates(force = false) {
        const now = Date.now();
        if (!force && cachedRates.updated_at && (now - lastRateFetchMs) < 15 * 60 * 1000) {
            return cachedRates;
        }
        try {
            const data = await fetchJsonHttps('https://economia.awesomeapi.com.br/last/USD-BRL,EUR-BRL,CNY-BRL');
            if (data && data.USDBRL && data.USDBRL.bid) {
                cachedRates = {
                    usd: parseFloat(parseFloat(data.USDBRL.bid).toFixed(4)) || 5.80,
                    eur: data.EURBRL ? (parseFloat(parseFloat(data.EURBRL.bid).toFixed(4)) || 6.25) : 6.25,
                    cny: data.CNYBRL ? (parseFloat(parseFloat(data.CNYBRL.bid).toFixed(4)) || 0.81) : 0.81,
                    updated_at: new Date().toISOString(),
                    source: 'AWESOME_API'
                };
                lastRateFetchMs = now;
            }
        } catch (err) {
            if (!cachedRates.updated_at) {
                cachedRates.updated_at = new Date().toISOString();
            }
        }
        return cachedRates;
    }

    // Cálculo oficial Tecfag: Preço FOB ($) x Dólar x 2 x 2
    function computeIntlSalePriceBrl({ fobUsd = 0, freightUsd = 0, usdRate = 5.80, factor1 = 2.0, factor2 = 2.0 }) {
        const baseUsd = (parseFloat(fobUsd) || 0) + (parseFloat(freightUsd) || 0);
        const rate = parseFloat(usdRate) || 5.80;
        const f1 = parseFloat(factor1) || 2.0;
        const f2 = parseFloat(factor2) || 2.0;
        const landedBrl = baseUsd * rate * f1;
        const saleBrl = landedBrl * f2;
        return {
            fobBrl: +(baseUsd * rate).toFixed(2),
            landedBrl: +landedBrl.toFixed(2),
            saleBrl: +saleBrl.toFixed(2)
        };
    }

    function computeNatSalePriceBrl({ costBrl = 0, markupFactor = 2.0 }) {
        const cost = parseFloat(costBrl) || 0;
        const mk = parseFloat(markupFactor) || 2.0;
        return +(cost * mk).toFixed(2);
    }

    // Backup compactado diário do banco de peças (mantém no máximo os 2 últimos)
    function runPartsBackup() {
        try {
            if (!fs.existsSync(PARTS_BACKUPS_DIR)) {
                fs.mkdirSync(PARTS_BACKUPS_DIR, { recursive: true });
            }
            if (fs.existsSync(PARTS_DB_PATH)) {
                const dateStr = new Date().toISOString().split('T')[0];
                const gzPath = path.join(PARTS_BACKUPS_DIR, `tecfag_pecas_backup_${dateStr}.db.gz`);
                const buf = fs.readFileSync(PARTS_DB_PATH);
                fs.writeFileSync(gzPath, zlib.gzipSync(buf));
            }
            const files = fs.readdirSync(PARTS_BACKUPS_DIR)
                .filter(f => f.startsWith('tecfag_pecas_backup_'))
                .map(f => ({ name: f, full: path.join(PARTS_BACKUPS_DIR, f), mtime: fs.statSync(path.join(PARTS_BACKUPS_DIR, f)).mtime }))
                .sort((a, b) => a.mtime - b.mtime);
            if (files.length > 2) {
                files.slice(0, files.length - 2).forEach(f => {
                    try { fs.unlinkSync(f.full); } catch (e) {}
                });
            }
        } catch (e) {
            console.warn('[PEÇAS BACKUP] Aviso:', e.message);
        }
    }

    function initPartsDatabase() {
        partsDb.serialize(() => {
            partsDb.run('PRAGMA journal_mode = WAL');
            partsDb.run('PRAGMA foreign_keys = ON');

            // 1. Árvore Viva de Peças por Máquina (Catálogo Técnico & Equivalências Nacionais)
            partsDb.run(`CREATE TABLE IF NOT EXISTS parts_catalog (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                temp_sku TEXT UNIQUE NOT NULL,
                erp_sku TEXT,
                erp_registered_by TEXT,
                erp_registered_at TEXT,
                name_pt TEXT NOT NULL,
                name_en TEXT,
                category TEXT DEFAULT 'MECANICA',
                parent_machine_sku TEXT,
                parent_machine_name TEXT,
                parent_vendor_model TEXT,
                sourcing_policy TEXT DEFAULT 'DEFINIR',
                national_equivalent_spec TEXT,
                national_supplier_name TEXT,
                national_last_cost_brl REAL DEFAULT 0,
                intl_supplier_id INTEGER,
                intl_supplier_name TEXT,
                intl_part_number TEXT,
                intl_last_fob_usd REAL DEFAULT 0,
                suggested_ncm TEXT,
                fiscal_origin TEXT DEFAULT '1',
                unit TEXT DEFAULT 'UN',
                weight_kg REAL DEFAULT 0,
                photo_path TEXT,
                times_requested INTEGER DEFAULT 1,
                notes TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )`);
            partsDb.run(`CREATE INDEX IF NOT EXISTS idx_parts_cat_machine ON parts_catalog(parent_machine_sku)`);
            partsDb.run(`CREATE INDEX IF NOT EXISTS idx_parts_cat_erpsku ON parts_catalog(erp_sku)`);

            // 2. Solicitações de Peças de Clientes / Estoque (Cards do Kanban)
            partsDb.run(`CREATE TABLE IF NOT EXISTS parts_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                req_code TEXT UNIQUE NOT NULL,
                stage TEXT NOT NULL DEFAULT '1_TRIAGEM_TECNICA',
                urgency TEXT NOT NULL DEFAULT 'NORMAL',
                request_type TEXT NOT NULL DEFAULT 'CLIENTE',
                client_name TEXT NOT NULL,
                client_cnpj TEXT,
                client_contact TEXT,
                client_phone TEXT,
                client_email TEXT,
                client_city_uf TEXT,
                requester_username TEXT,
                requester_name TEXT,
                machine_sku TEXT,
                machine_name TEXT,
                machine_serial TEXT,
                machine_vendor_model TEXT,
                machine_supplier_name TEXT,
                usd_rate_snapshot REAL DEFAULT 5.80,
                total_quoted_brl REAL DEFAULT 0.0,
                proposal_validity_days INTEGER DEFAULT 7,
                payment_terms_client TEXT DEFAULT 'À vista / 28 DDL mediante aprovação',
                proposal_sent_at TEXT,
                client_approved_at TEXT,
                erp_order_number TEXT,
                lost_reason TEXT,
                purchase_modality TEXT DEFAULT 'DEFINIR',
                po_reference TEXT,
                supplier_invoice TEXT,
                tracking_code TEXT,
                linked_stock_order_id INTEGER,
                linked_po_number TEXT,
                eta_date TEXT,
                arrived_at TEXT,
                shelf_location TEXT,
                out_nfe_number TEXT,
                delivered_at TEXT,
                stage_entry_at TEXT NOT NULL,
                notes TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )`);
            partsDb.run(`CREATE INDEX IF NOT EXISTS idx_parts_req_stage ON parts_requests(stage)`);
            partsDb.run(`CREATE INDEX IF NOT EXISTS idx_parts_req_machine ON parts_requests(machine_sku)`);

            // 3. Itens / Peças dentro de cada Solicitação
            partsDb.run(`CREATE TABLE IF NOT EXISTS parts_request_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                request_id INTEGER NOT NULL,
                catalog_part_id INTEGER,
                temp_sku TEXT NOT NULL,
                erp_sku TEXT,
                erp_registered INTEGER DEFAULT 0,
                erp_registered_by TEXT,
                erp_registered_at TEXT,
                part_name_pt TEXT NOT NULL,
                part_name_en TEXT,
                category TEXT DEFAULT 'MECANICA',
                vendor_part_number TEXT,
                qty REAL NOT NULL DEFAULT 1,
                unit TEXT DEFAULT 'UN',
                sourcing_route TEXT DEFAULT 'DEFINIR',
                national_equiv_spec TEXT,
                intl_supplier_name TEXT,
                intl_unit_fob REAL DEFAULT 0,
                intl_freight_usd REAL DEFAULT 0,
                intl_lead_time_days INTEGER DEFAULT 18,
                intl_modality TEXT DEFAULT 'COURIER_AEREO',
                intl_usd_rate REAL DEFAULT 5.80,
                intl_factor_1 REAL DEFAULT 2.0,
                intl_factor_2 REAL DEFAULT 2.0,
                intl_unit_sale_brl REAL DEFAULT 0,
                nat_supplier_name TEXT,
                nat_unit_cost_brl REAL DEFAULT 0,
                nat_lead_time_days INTEGER DEFAULT 5,
                nat_markup_factor REAL DEFAULT 2.0,
                nat_unit_sale_brl REAL DEFAULT 0,
                selected_source TEXT DEFAULT 'PENDENTE',
                final_unit_price_brl REAL DEFAULT 0,
                final_total_price_brl REAL DEFAULT 0,
                promised_lead_days INTEGER DEFAULT 15,
                suggested_ncm TEXT,
                fiscal_origin TEXT DEFAULT '1',
                weight_kg REAL DEFAULT 0,
                photo_path TEXT,
                item_notes TEXT,
                item_machine_sku TEXT,
                item_machine_name TEXT,
                item_machine_vendor_model TEXT,
                item_machine_serial TEXT,
                item_machine_supplier TEXT,
                FOREIGN KEY(request_id) REFERENCES parts_requests(id) ON DELETE CASCADE
            )`);
            partsDb.run(`CREATE INDEX IF NOT EXISTS idx_parts_items_req ON parts_request_items(request_id)`);
            partsDb.run(`CREATE INDEX IF NOT EXISTS idx_parts_items_erpreg ON parts_request_items(erp_registered)`);

            // Migrações seguras para bancos já existentes (suporte a múltiplas máquinas na mesma solicitação!)
            partsDb.run(`ALTER TABLE parts_request_items ADD COLUMN item_machine_sku TEXT`, () => {});
            partsDb.run(`ALTER TABLE parts_request_items ADD COLUMN item_machine_name TEXT`, () => {});
            partsDb.run(`ALTER TABLE parts_request_items ADD COLUMN item_machine_vendor_model TEXT`, () => {});
            partsDb.run(`ALTER TABLE parts_request_items ADD COLUMN item_machine_serial TEXT`, () => {});
            partsDb.run(`ALTER TABLE parts_request_items ADD COLUMN item_machine_supplier TEXT`, () => {});

            // 4. Fornecedores Nacionais Homologados (Brasil)
            partsDb.run(`CREATE TABLE IF NOT EXISTS parts_national_suppliers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                specialty TEXT NOT NULL,
                city_uf TEXT,
                contact_person TEXT,
                phone_whatsapp TEXT,
                email TEXT,
                avg_lead_days INTEGER DEFAULT 5,
                notes TEXT,
                created_at TEXT NOT NULL
            )`, () => {
                seedNationalSuppliers();
            });

            // 5. Timeline / Auditoria e Comentários da Solicitação
            partsDb.run(`CREATE TABLE IF NOT EXISTS parts_timeline (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                request_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                user_display TEXT NOT NULL,
                event_type TEXT NOT NULL DEFAULT 'LOG',
                message TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(request_id) REFERENCES parts_requests(id) ON DELETE CASCADE
            )`);
            partsDb.run(`CREATE INDEX IF NOT EXISTS idx_parts_tl_req ON parts_timeline(request_id)`);

            // 6. Memória de E-mails de Fornecedores (Nacionais e Internacionais)
            partsDb.run(`CREATE TABLE IF NOT EXISTS parts_supplier_emails (
                supplier_name TEXT PRIMARY KEY,
                contact_email TEXT NOT NULL,
                contact_person TEXT,
                updated_at TEXT NOT NULL
            )`);

            // 7. Credenciais de E-mail Individual Opcional (p/ envio direto autenticado pela própria conta do vendedor, ex: vendas18@tecfag.com.br)
            partsDb.run(`CREATE TABLE IF NOT EXISTS parts_user_smtp (
                username TEXT PRIMARY KEY,
                email_address TEXT NOT NULL,
                smtp_host TEXT,
                smtp_port INTEGER DEFAULT 587,
                smtp_secure INTEGER DEFAULT 0,
                smtp_pass_enc TEXT NOT NULL,
                sender_display_name TEXT,
                updated_at TEXT NOT NULL
            )`);

            // 8. Matriz de Governança & Responsabilidade por Etapa (Etapa 1 a 6 + Abertura)
            partsDb.run(`CREATE TABLE IF NOT EXISTS parts_app_meta (
                meta_key TEXT PRIMARY KEY,
                meta_val TEXT,
                updated_at TEXT NOT NULL
            )`);

            partsDb.run(`CREATE TABLE IF NOT EXISTS parts_stage_permissions (
                stage_key TEXT PRIMARY KEY,
                stage_label TEXT NOT NULL,
                allowed_users_json TEXT NOT NULL,
                owner_display TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )`, () => {
                const nowIso = new Date().toISOString();
                DEFAULT_STAGE_GOVERNANCE.forEach((def) => {
                    partsDb.run(
                        `INSERT OR IGNORE INTO parts_stage_permissions (stage_key, stage_label, allowed_users_json, owner_display, updated_at)
                         VALUES (?, ?, ?, ?, ?)`,
                        [def.stage_key, def.stage_label, JSON.stringify(def.allowed_users), def.owner_display, nowIso]
                    );
                });

                // Migração idempotente única: garante Guilherme, Raiane, Maria Vitória, Keicy e Matheus Henrique nos mesmos poderes (Abertura & Etapa 3) em bancos já existentes
                partsDb.get(`SELECT meta_val FROM parts_app_meta WHERE meta_key = 'gov_v3_matheus_henrique'`, (mErr, mRow) => {
                    if (!mErr && !mRow) {
                        ['CREATE_REQUEST', '3_PROPOSTA_CLIENTE'].forEach((stageKey) => {
                            partsDb.get(`SELECT allowed_users_json FROM parts_stage_permissions WHERE stage_key = ?`, [stageKey], (sErr, sRow) => {
                                if (sErr || !sRow) return;
                                let list = [];
                                try { list = JSON.parse(sRow.allowed_users_json || '[]'); } catch (e) { list = []; }
                                if (!Array.isArray(list)) list = [];
                                const lowerExisting = new Set(list.map(x => String(x || '').toLowerCase().trim()));
                                PARTS_REQUESTERS_DEFAULT_EMAILS.forEach((em) => {
                                    if (!lowerExisting.has(em)) {
                                        list.push(em);
                                        lowerExisting.add(em);
                                    }
                                });
                                const ownerDisplay = formatOwnersDisplay(list);
                                partsDb.run(
                                    `UPDATE parts_stage_permissions SET allowed_users_json = ?, owner_display = ?, updated_at = ? WHERE stage_key = ?`,
                                    [JSON.stringify(list), ownerDisplay, nowIso, stageKey]
                                );
                            });
                        });
                        partsDb.run(
                            `INSERT OR REPLACE INTO parts_app_meta (meta_key, meta_val, updated_at) VALUES ('gov_v3_matheus_henrique', '1', ?)`,
                            [nowIso]
                        );
                    }
                });
            });
        });

        // Garantir cadastro seguro de Guilherme, Raiane, Maria Vitória, Keicy e Matheus Henrique na tabela users do MRP sem sobrescrever senhas existentes
        if (mrpDb && typeof hashPassword === 'function') {
            const partsTeamAccounts = [
                { username: 'vendas18@tecfag.com.br', email: 'vendas18@tecfag.com.br', role: 'VENDAS', defaultPass: 'vend@tecfag18', label: 'Guilherme Bertola' },
                { username: 'vendas18', email: 'vendas18@tecfag.com.br', role: 'VENDAS', defaultPass: 'vend@tecfag18', label: 'Guilherme Bertola' },
                { username: 'assistencia@tecfag.com.br', email: 'assistencia@tecfag.com.br', role: 'VENDAS', defaultPass: 'raiane#tecfag26', label: 'Raiane Aguiar' },
                { username: 'raiane', email: 'assistencia@tecfag.com.br', role: 'VENDAS', defaultPass: 'raiane#tecfag26', label: 'Raiane Aguiar' },
                { username: 'assistencia4@tecfag.com.br', email: 'assistencia4@tecfag.com.br', role: 'VENDAS', defaultPass: 'vitoria#tecfag26', label: 'Maria Vitória' },
                { username: 'mariavitoria', email: 'assistencia4@tecfag.com.br', role: 'VENDAS', defaultPass: 'vitoria#tecfag26', label: 'Maria Vitória' },
                { username: 'vendas21@tecfag.com.br', email: 'vendas21@tecfag.com.br', role: 'VENDAS', defaultPass: 'vend@tecfag21', label: 'Keicy Cardoso' },
                { username: 'keicy', email: 'vendas21@tecfag.com.br', role: 'VENDAS', defaultPass: 'vend@tecfag21', label: 'Keicy Cardoso' },
                { username: 'assistencia7@tecfag.com.br', email: 'assistencia7@tecfag.com.br', role: 'VENDAS', defaultPass: 'matheus#tecfag26', label: 'Matheus Henrique' },
                { username: 'matheus', email: 'assistencia7@tecfag.com.br', role: 'VENDAS', defaultPass: 'matheus#tecfag26', label: 'Matheus Henrique' }
            ];
            partsTeamAccounts.forEach((acc) => {
                mrpDb.get('SELECT username FROM users WHERE LOWER(username) = LOWER(?)', [acc.username], (err, row) => {
                    if (!err && !row) {
                        const { salt, hash } = hashPassword(acc.defaultPass);
                        mrpDb.run(
                            'INSERT INTO users (username, password_hash, salt, role, email, must_change_password) VALUES (?, ?, ?, ?, ?, 0)',
                            [acc.username, hash, salt, acc.role, acc.email],
                            () => console.log(`[PEÇAS AUTH] Usuário "${acc.username}" (${acc.label}) habilitado com sucesso.`)
                        );
                    }
                });
            });
        }

        runPartsBackup();
        setInterval(runPartsBackup, 24 * 60 * 60 * 1000);
        getLiveExchangeRates(true).catch(() => {});
    }

    async function seedNationalSuppliers() {
        try {
            const countRow = await pGet('SELECT COUNT(*) as cnt FROM parts_national_suppliers');
            if (countRow && countRow.cnt > 0) return;
            const now = new Date().toISOString();
            const defaults = [
                {
                    name: 'Resistências Industriais Brasil (Sob Medida)',
                    specialty: 'RESISTENCIA_TERMICA',
                    city_uf: 'São Paulo - SP',
                    contact_person: 'Depto. Técnico Comercial',
                    phone_whatsapp: '',
                    avg_lead_days: 4,
                    notes: 'Fabricação expressa de resistências tubulares, cartucho e coleira sob desenho/amostra.'
                },
                {
                    name: 'Automação & Sensores Express (Autonics / Omron / Metaltex)',
                    specialty: 'ELETRICA_AUTOMACAO',
                    city_uf: 'Campinas / SP',
                    contact_person: 'Balcão Industrial',
                    phone_whatsapp: '',
                    avg_lead_days: 2,
                    notes: 'Sensores indutivos, fotocélulas, relés SSR, fontes chaveadas, inversores e CLPs.'
                },
                {
                    name: 'Usinagem & Ferramentaria Parceira Local',
                    specialty: 'MECANICA',
                    city_uf: 'Região Local - SP',
                    contact_person: 'Engenharia / Tornearia',
                    phone_whatsapp: '',
                    avg_lead_days: 5,
                    notes: 'Eixos, buchas, engrenagens, suportes em inox 304 e peças usinadas mediante amostra.'
                },
                {
                    name: 'Casa das Correias, Rolamentos & Vedação Industrial',
                    specialty: 'VEDACAO_CORREIA',
                    city_uf: 'São Paulo - SP',
                    contact_person: 'Vendas Técnicas',
                    phone_whatsapp: '',
                    avg_lead_days: 2,
                    notes: 'Correias sincronizadoras HTD/AT, fitas Teflon, anéis O-ring silicone alimentício e rolamentos NSK/SKF.'
                },
                {
                    name: 'Facas & Lâminas Industriais sob Desenho',
                    specialty: 'FACA_CORTE',
                    city_uf: 'São Paulo - SP',
                    contact_person: 'Comercial Facas',
                    phone_whatsapp: '',
                    avg_lead_days: 7,
                    notes: 'Facas dentadas zig-zag e retas em aço ferramenta / inox temperado para empacotadoras e seladoras.'
                }
            ];
            for (const s of defaults) {
                await pRun(
                    `INSERT OR IGNORE INTO parts_national_suppliers (
                        name, specialty, city_uf, contact_person, phone_whatsapp, email, avg_lead_days, notes, created_at
                    ) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)`,
                    [s.name, s.specialty, s.city_uf, s.contact_person, s.phone_whatsapp, s.avg_lead_days, s.notes, now]
                );
            }
        } catch (e) {
            console.warn('[PEÇAS SEED] Aviso ao popular fornecedores nacionais:', e.message);
        }
    }

    // Disjuntor de Disco para proteger os 200 MB sagrados do MRP no Render (1 GB)
    function checkDiskSpaceSafe() {
        try {
            if (typeof getDirectorySize !== 'function') return true;
            const usedBytes = getDirectorySize(DB_DIR);
            const freeBytes = TOTAL_DISK_LIMIT_BYTES - usedBytes;
            return freeBytes >= MRP_RESERVED_FREE_BYTES;
        } catch (e) {
            return true;
        }
    }

    const partsStorage = multer.diskStorage({
        destination: (req, file, cb) => {
            if (!checkDiskSpaceSafe()) {
                return cb(new Error('Espaço em disco protegido (reserva de segurança de 200 MB do MRP atingida).'));
            }
            cb(null, PARTS_UPLOADS_DIR);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname || '.jpg').toLowerCase() || '.jpg';
            const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'].includes(ext) ? ext : '.bin';
            cb(null, `peca_${Date.now()}_${Math.round(Math.random() * 1e6)}${safeExt}`);
        }
    });

    const partsUpload = multer({
        storage: partsStorage,
        limits: { fileSize: 8 * 1024 * 1024 } // 8 MB máx (imagens já vêm comprimidas ~150KB do navegador)
    });

    // Helpers de Geração Sequencial de Códigos
    async function generateNextTempSku() {
        const row = await pGet('SELECT id FROM parts_catalog ORDER BY id DESC LIMIT 1');
        const nextNum = (row ? row.id : 0) + 1;
        return `TMP-PEC-${String(nextNum).padStart(4, '0')}`;
    }

    async function generateNextRequestCode() {
        const year = new Date().getFullYear();
        const row = await pGet('SELECT id FROM parts_requests ORDER BY id DESC LIMIT 1');
        const nextNum = (row ? row.id : 0) + 1;
        return `SOL-PEC-${year}-${String(nextNum).padStart(4, '0')}`;
    }

    // Índice em memória do ERP oficial (skus.csv: Código, Descrição, Cód. Antigo do Fornecedor, Nome Fabricante, NCM, Descrição Inglês)
    const erpSkusBaseMap = {};
    function initErpSkusSpreadsheetIndex() {
        try {
            if (fs.existsSync(SKUS_CSV_PATH)) {
                const wb = xlsx.readFile(SKUS_CSV_PATH);
                const sheet = wb.Sheets[wb.SheetNames[0]];
                const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
                for (let i = 1; i < rows.length; i++) {
                    const r = rows[i];
                    if (!r) continue;
                    const sku = String(r[2] || '').trim();
                    if (!sku) continue;
                    erpSkusBaseMap[sku.toUpperCase()] = {
                        sku,
                        name: String(r[3] || '').trim(),
                        vendorCode: String(r[4] || '').trim(),     // Aba "Cód. Antigo" = Código Original no Fornecedor (ex: ARLM-160B)
                        manufacturer: String(r[5] || '').trim(),   // "Nome Fabricante" (ex: ZHEJIANG HAIZHOU PACKING MACHINERY CO.,LTD)
                        ncm: String(r[6] || '').trim(),
                        unit: String(r[7] || 'UN').trim() || 'UN',
                        nameEn: String(r[10] || '').trim(),        // "Descrição Inglês"
                        group: String(r[15] || '').trim()
                    };
                }
                console.log(`[PEÇAS ERP INDEX] Indexados ${Object.keys(erpSkusBaseMap).length} itens do skus.csv (com Cód. Antigo & Fabricante).`);
            }
        } catch (err) {
            console.warn('[PEÇAS ERP INDEX] Aviso ao ler skus.csv:', err.message);
        }
    }
    initErpSkusSpreadsheetIndex();

    function getErpSkuDetails(sku) {
        if (!sku) return null;
        return erpSkusBaseMap[String(sku).trim().toUpperCase()] || null;
    }

    function loadProductsCatalog() {
        const mergedMap = new Map();
        Object.values(erpSkusBaseMap).forEach((item) => {
            mergedMap.set(item.sku.toUpperCase(), { ...item });
        });
        try {
            if (fs.existsSync(PRODUCTS_JSON_PATH)) {
                const raw = fs.readFileSync(PRODUCTS_JSON_PATH, 'utf8');
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) {
                    arr.forEach((p) => {
                        if (!p || !p.sku) return;
                        const key = String(p.sku).trim().toUpperCase();
                        const base = mergedMap.get(key) || {};
                        mergedMap.set(key, {
                            sku: p.sku,
                            name: p.name || base.name || '',
                            vendorCode: base.vendorCode || p.vendorCode || '',
                            manufacturer: base.manufacturer || '',
                            ncm: base.ncm || skuNcmMap[p.sku] || '',
                            unit: base.unit || 'UN',
                            nameEn: base.nameEn || '',
                            group: p.group || base.group || ''
                        });
                    });
                }
            }
        } catch (e) {}
        return Array.from(mergedMap.values());
    }

    function suggestNcmForCategory(category, existingSku) {
        const erpInfo = getErpSkuDetails(existingSku);
        if (erpInfo && erpInfo.ncm) return erpInfo.ncm;
        if (existingSku && skuNcmMap && skuNcmMap[existingSku]) {
            return skuNcmMap[existingSku];
        }
        const catMap = {
            'MECANICA': '8422.90.90',          // Partes de máquinas de empacotar/envasar
            'FACA_CORTE': '8208.90.00',        // Facas e lâminas cortantes para máquinas
            'RESISTENCIA_TERMICA': '8516.80.90', // Resistências elétricas de aquecimento
            'ELETRICA_AUTOMACAO': '8536.50.90', // Sensores / relés / aparelhos elétricos
            'PNEUMATICA': '8412.31.10',        // Cilindros e atuadores pneumáticos
            'VEDACAO_CORREIA': '4010.35.00',   // Correias de transmissão / vedação
            'ESTRUTURAL_INOX': '8422.90.90',
            'OUTRO': '8422.90.90'
        };
        return catMap[category] || '8422.90.90';
    }

    async function addTimelineEntry(requestId, user, eventType, message) {
        const uname = user && user.username ? user.username : (typeof user === 'string' ? user : 'Sistema');
        await pRun(
            `INSERT INTO parts_timeline (request_id, username, user_display, event_type, message, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [requestId, uname, getFriendlyUserName(uname), eventType, message, new Date().toISOString()]
        );
    }

    async function recalculateRequestTotals(requestId) {
        const items = await pAll('SELECT * FROM parts_request_items WHERE request_id = ?', [requestId]);
        let totalBrl = 0;
        for (const it of items) {
            totalBrl += parseFloat(it.final_total_price_brl) || 0;
        }
        await pRun('UPDATE parts_requests SET total_quoted_brl = ?, updated_at = ? WHERE id = ?', [
            +totalBrl.toFixed(2),
            new Date().toISOString(),
            requestId
        ]);
        return +totalBrl.toFixed(2);
    }

    // Servir arquivos estáticos de fotos de peças e a SPA /pecas
    app.use('/uploads_pecas', express.static(PARTS_UPLOADS_DIR));

    app.get('/pecas', (req, res) => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        res.sendFile(path.join(__dirname, 'pecas.html'));
    });

    app.get('/manual-pecas', (req, res) => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.sendFile(path.join(__dirname, 'manual-pecas.html'));
    });

    app.get('/manual-pecas.pdf', (req, res) => {
        const pdfPath = path.join(__dirname, 'Manual_Gestao_Pecas_Tecfag.pdf');
        if (fs.existsSync(pdfPath)) {
            return res.download(pdfPath, 'Manual_Gestao_Pecas_Tecfag.pdf');
        }
        res.redirect('/manual-pecas');
    });

    const router = express.Router();
    const asyncSafe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

    // 1. Dados do Usuário Logado + Câmbio Atual + E-mail Corporativo + Matriz de Governança por Etapa
    router.get('/me', authenticateToken, asyncSafe(async (req, res) => {
        const rates = await getLiveExchangeRates(false);
        const officialEmail = resolveOfficialUserEmail(req.user.username);
        const personalSmtp = await pGet(
            'SELECT email_address, smtp_host, smtp_port, sender_display_name FROM parts_user_smtp WHERE LOWER(username) = LOWER(?) OR LOWER(email_address) = LOWER(?)',
            [req.user.username, officialEmail]
        ).catch(() => null);
        const governanceMap = await getStageGovernanceMap(req.user);

        res.json({
            user: {
                username: req.user.username,
                role: req.user.role,
                display_name: getFriendlyUserName(req.user.username),
                official_email: personalSmtp ? personalSmtp.email_address : officialEmail,
                personal_smtp_configured: !!personalSmtp,
                is_jhenifer: isJheniferUser(req.user),
                is_guilherme: isGuilhermeUser(req.user),
                is_parts_requester: isPartsRequesterTeamUser(req.user),
                is_master_admin: isMasterAdminUser(req.user)
            },
            permissions: governanceMap,
            exchange: rates
        });
    }));

    // 1.B Painel de Governança & Responsáveis por Etapa (Configurável por Admin: Gilson / Fernando / Admin)
    router.get('/governance', authenticateToken, asyncSafe(async (req, res) => {
        const govMap = await getStageGovernanceMap(req.user);
        const mrpUsers = await mrpAll('SELECT username, role, email FROM users ORDER BY username ASC');
        const uniqueUsersMap = new Map();

        const registerCandidate = (uname, roleLabel) => {
            const clean = String(uname || '').toLowerCase().trim();
            if (!clean) return;
            // Agrupa aliases duplicados na lista de seleção p/ ficar limpo
            let canonicalKey = clean;
            if (['jhenifer', 'adm@tecfag.com.br'].includes(clean)) canonicalKey = 'jhenifer';
            else if (['guilherme', 'bertola', 'vendas18', 'vendas18@tecfag.com.br'].includes(clean)) canonicalKey = 'vendas18@tecfag.com.br';
            else if (['raiane', 'raiane.aguiar', 'assistencia', 'assistencia@tecfag.com.br'].includes(clean)) canonicalKey = 'assistencia@tecfag.com.br';
            else if (['mariavitoria', 'maria.vitoria', 'vitoria', 'assistencia4', 'assistencia4@tecfag.com.br'].includes(clean)) canonicalKey = 'assistencia4@tecfag.com.br';
            else if (['keicy', 'keicy.cardoso', 'vendas21', 'vendas21@tecfag.com.br'].includes(clean)) canonicalKey = 'vendas21@tecfag.com.br';
            else if (['matheus', 'matheus.henrique', 'assistencia7', 'assistencia7@tecfag.com.br'].includes(clean)) canonicalKey = 'assistencia7@tecfag.com.br';
            else if (['gilson', 'gilson@tecfag.com.br'].includes(clean)) canonicalKey = 'gilson';
            else if (['fernando', 'fernando@tecfag.com.br'].includes(clean)) canonicalKey = 'fernando';
            else if (['heilio', 'assistencia6@tecfag.com.br'].includes(clean)) canonicalKey = 'heilio';
            else if (['suporte2', 'suporte2@tecfag.com.br'].includes(clean)) canonicalKey = 'suporte2';
            else if (['vendas6', 'vendas6@tecfag.com.br'].includes(clean)) canonicalKey = 'vendas6';

            if (!uniqueUsersMap.has(canonicalKey)) {
                uniqueUsersMap.set(canonicalKey, {
                    username: canonicalKey,
                    display_name: getFriendlyUserName(canonicalKey),
                    role: roleLabel || ''
                });
            }
        };

        registerCandidate('vendas18@tecfag.com.br', 'VENDAS / PEÇAS');
        registerCandidate('assistencia@tecfag.com.br', 'ASSISTÊNCIA / PEÇAS');
        registerCandidate('assistencia4@tecfag.com.br', 'ASSISTÊNCIA / PEÇAS');
        registerCandidate('vendas21@tecfag.com.br', 'VENDAS / PEÇAS');
        registerCandidate('assistencia7@tecfag.com.br', 'ASSISTÊNCIA / PEÇAS');
        registerCandidate('jhenifer', 'COMPRAS / ERP');
        mrpUsers.forEach(u => registerCandidate(u.username, u.role));

        res.json({
            is_master_admin: isMasterAdminUser(req.user),
            master_admins_note: 'Gilson (gilson / admin) e Fernando (fernando) possuem chave-mestra em todas as etapas.',
            stages: Object.values(govMap),
            available_users: Array.from(uniqueUsersMap.values())
        });
    }));

    router.put('/governance', authenticateToken, asyncSafe(async (req, res) => {
        if (!isMasterAdminUser(req.user)) {
            return res.status(403).json({ error: 'Apenas Administradores Master (Gilson / Fernando) podem alterar a matriz de responsabilidade por etapa.' });
        }
        const { stages } = req.body || {};
        if (!Array.isArray(stages)) {
            return res.status(400).json({ error: 'Formato inválido.' });
        }
        const now = new Date().toISOString();
        for (const st of stages) {
            const def = DEFAULT_STAGE_GOVERNANCE.find(d => d.stage_key === st.stage_key);
            if (!def) continue;
            const cleanUsers = Array.isArray(st.allowed_users)
                ? st.allowed_users.map(u => String(u || '').trim().toLowerCase()).filter(Boolean)
                : [];
            const ownerDisplay = formatOwnersDisplay(cleanUsers);
            await pRun(
                `INSERT OR REPLACE INTO parts_stage_permissions (stage_key, stage_label, allowed_users_json, owner_display, updated_at)
                 VALUES (?, ?, ?, ?, ?)`,
                [def.stage_key, def.stage_label, JSON.stringify(cleanUsers), ownerDisplay, now]
            );
        }
        const updatedMap = await getStageGovernanceMap(req.user);
        res.json({ success: true, permissions: updatedMap });
    }));

    // 2. Contador Leve para o Botão na Tela Principal do MRP (index.html)
    router.get('/badge-summary', authenticateToken, asyncSafe(async (req, res) => {
        const rows = await pAll(`SELECT stage, urgency FROM parts_requests WHERE stage NOT IN ('7_CONCLUIDO', '8_DECLINADO_CANCELADO')`);
        const pendingErpItems = await pGet(`
            SELECT COUNT(*) as cnt
            FROM parts_request_items i
            JOIN parts_requests r ON r.id = i.request_id
            WHERE r.stage = '4_CADASTRO_ERP' AND i.erp_registered = 0
        `);

        const counts = {
            triagem: 0,
            cotacao: 0,
            proposta: 0,
            cadastro_erp: 0,
            transito: 0,
            doca: 0,
            maquina_parada: 0,
            total_active: rows.length,
            erp_items_waiting: pendingErpItems ? pendingErpItems.cnt : 0
        };

        rows.forEach((r) => {
            if (r.urgency === 'MAQUINA_PARADA') counts.maquina_parada++;
            if (r.stage === '1_TRIAGEM_TECNICA') counts.triagem++;
            else if (r.stage === '2_COTACAO_FORNECEDOR') counts.cotacao++;
            else if (r.stage === '3_PROPOSTA_CLIENTE') counts.proposta++;
            else if (r.stage === '4_CADASTRO_ERP') counts.cadastro_erp++;
            else if (r.stage === '5_COMPRA_TRANSITO') counts.transito++;
            else if (r.stage === '6_DOCA_EXPEDICAO') counts.doca++;
        });

        let myBadge = 0;
        if (isMasterAdminUser(req.user)) {
            myBadge = counts.total_active;
        } else {
            const gov = await getStageGovernanceMap(req.user);
            if (gov['1_TRIAGEM_TECNICA'] && gov['1_TRIAGEM_TECNICA'].can_edit) myBadge += counts.triagem;
            if (gov['2_COTACAO_FORNECEDOR'] && gov['2_COTACAO_FORNECEDOR'].can_edit) myBadge += counts.cotacao;
            if (gov['3_PROPOSTA_CLIENTE'] && gov['3_PROPOSTA_CLIENTE'].can_edit) myBadge += counts.proposta;
            if (gov['4_CADASTRO_ERP'] && gov['4_CADASTRO_ERP'].can_edit) myBadge += counts.cadastro_erp;
            if (gov['5_COMPRA_TRANSITO'] && gov['5_COMPRA_TRANSITO'].can_edit) myBadge += counts.transito;
            if (gov['6_DOCA_EXPEDICAO'] && gov['6_DOCA_EXPEDICAO'].can_edit) myBadge += counts.doca;
        }

        res.json({ success: true, my_badge: myBadge, counts });
    }));

    // 3. Câmbio USD ao Vivo
    router.get('/exchange-rate', authenticateToken, asyncSafe(async (req, res) => {
        const force = req.query.refresh === '1';
        const rates = await getLiveExchangeRates(force);
        res.json(rates);
    }));

    // 4. Autocomplete de Clientes do ERP (mrpDb.erp_clients + projects)
    router.get('/lookup/clients', authenticateToken, asyncSafe(async (req, res) => {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) return res.json([]);
        const like = `%${q}%`;
        const erpRows = await mrpAll(
            `SELECT codigo, razao, fantasia, cnpj, cidade, uf, telefone, email
             FROM erp_clients
             WHERE razao LIKE ? OR fantasia LIKE ? OR cnpj LIKE ? OR codigo LIKE ?
             LIMIT 20`,
            [like, like, like, like]
        );
        const results = erpRows.map(r => ({
            name: r.razao || r.fantasia,
            fantasy: r.fantasia || '',
            cnpj: r.cnpj || '',
            city_uf: [r.cidade, r.uf].filter(Boolean).join(' - '),
            phone: r.telefone || '',
            email: r.email || ''
        }));
        res.json(results);
    }));

    async function resolveSupplierSavedEmail(supplierName) {
        if (!supplierName) return '';
        const clean = String(supplierName).trim();
        const mem = await pGet('SELECT contact_email FROM parts_supplier_emails WHERE LOWER(supplier_name) = LOWER(?)', [clean]).catch(() => null);
        if (mem && mem.contact_email) return mem.contact_email;
        const intl = await mrpGet('SELECT contact_email FROM stock_suppliers WHERE LOWER(name) = LOWER(?) OR LOWER(name) LIKE LOWER(?) LIMIT 1', [clean, `%${clean.split(' ')[0]}%`]);
        if (intl && intl.contact_email) return intl.contact_email;
        const nat = await pGet('SELECT email FROM parts_national_suppliers WHERE LOWER(name) = LOWER(?) LIMIT 1', [clean]).catch(() => null);
        if (nat && nat.email) return nat.email;
        return '';
    }

    // 5. Autocomplete de Máquinas & SKUs do ERP (com Cód. Antigo e Nome Fabricante do skus.csv!)
    router.get('/lookup/machines', authenticateToken, asyncSafe(async (req, res) => {
        const q = String(req.query.q || '').trim().toLowerCase();
        const allProducts = loadProductsCatalog();
        let filtered = allProducts;
        if (q) {
            filtered = allProducts.filter(p =>
                String(p.sku || '').toLowerCase().includes(q) ||
                String(p.name || '').toLowerCase().includes(q) ||
                String(p.vendorCode || '').toLowerCase().includes(q) ||
                String(p.manufacturer || '').toLowerCase().includes(q) ||
                String(p.group || '').toLowerCase().includes(q)
            );
        }
        const top = filtered.slice(0, 35).map(p => ({
            sku: p.sku,
            name: p.name,
            group: p.group || '',
            vendorCode: p.vendorCode || '',          // Aba "Cód. Antigo" = Código no Fornecedor (ex: ARLM-160B)
            manufacturer: p.manufacturer || '',      // "Nome Fabricante" (ex: ZHEJIANG HAIZHOU...)
            nameEn: p.nameEn || '',
            unit: p.unit || 'UN',
            ncm: p.ncm || skuNcmMap[p.sku] || ''
        }));

        // Se consultou um SKU exato de máquina/item, retorna Cód. Antigo, Fabricante do skus.csv, e-mail salvo e peças conhecidas
        let knownParts = [];
        let suggestedSupplier = '';
        let suggestedVendorCode = '';
        let suggestedSupplierEmail = '';
        if (req.query.exact_sku) {
            const exactSku = String(req.query.exact_sku).trim();
            const erpDetails = getErpSkuDetails(exactSku);
            if (erpDetails) {
                suggestedVendorCode = erpDetails.vendorCode || '';
                suggestedSupplier = erpDetails.manufacturer || '';
            }
            knownParts = await pAll(
                `SELECT * FROM parts_catalog WHERE parent_machine_sku = ? ORDER BY times_requested DESC, updated_at DESC`,
                [exactSku]
            );
            if (!suggestedSupplier) {
                const orderHit = await mrpGet(
                    `SELECT o.supplier_name
                     FROM stock_order_items oi
                     JOIN stock_orders o ON o.id = oi.order_id
                     WHERE oi.sku = ? OR oi.tecfag_sku = ?
                     ORDER BY o.id DESC LIMIT 1`,
                    [exactSku, exactSku]
                );
                if (orderHit && orderHit.supplier_name) {
                    suggestedSupplier = orderHit.supplier_name;
                } else {
                    const prjHit = await mrpGet(
                        `SELECT COALESCE(import_supplier, '') as sup FROM projects WHERE sku LIKE ? AND import_supplier IS NOT NULL AND import_supplier != '' ORDER BY lastUpdate DESC LIMIT 1`,
                        [`%${exactSku}%`]
                    );
                    if (prjHit && prjHit.sup) suggestedSupplier = prjHit.sup;
                }
            }
            if (suggestedSupplier) {
                suggestedSupplierEmail = await resolveSupplierSavedEmail(suggestedSupplier);
            }
        }

        res.json({
            machines: top,
            known_parts: knownParts,
            suggested_supplier: suggestedSupplier,
            suggested_vendor_code: suggestedVendorCode,
            suggested_supplier_email: suggestedSupplierEmail
        });
    }));

    // 6. Radar de Fornecedores Internacionais + E-mails Memorizados + Containers em Aberto no Comex
    router.get('/lookup/suppliers-and-containers', authenticateToken, asyncSafe(async (req, res) => {
        const intlSuppliers = await mrpAll(`SELECT * FROM stock_suppliers ORDER BY name ASC`);
        const natSuppliers = await pAll(`SELECT * FROM parts_national_suppliers ORDER BY name ASC`);
        const savedEmails = await pAll(`SELECT * FROM parts_supplier_emails ORDER BY supplier_name ASC`).catch(() => []);
        const openContainers = await mrpAll(
            `SELECT id, po_number, supplier_id, supplier_name, stage, currency, transport_mode, etd_date, eta_warehouse_date
             FROM stock_orders
             WHERE stage IN ('PO_EMITIDA', 'EM_FABRICACAO')
             ORDER BY id DESC`
        );
        res.json({
            intl_suppliers: intlSuppliers,
            nat_suppliers: natSuppliers,
            saved_supplier_emails: savedEmails,
            open_containers: openContainers
        });
    }));

    // 7. Upload de Foto da Peça / Desenho / Plaqueta
    router.post('/upload-photo', authenticateToken, partsUpload.single('photo'), asyncSafe(async (req, res) => {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
        }
        res.json({
            success: true,
            photo_path: `/uploads_pecas/${req.file.filename}`,
            filename: req.file.filename
        });
    }));

    function enrichItemMachineFields(it, parentReq) {
        const effSku = String(it.item_machine_sku || parentReq.machine_sku || '').trim();
        const erpMach = getErpSkuDetails(effSku);
        const hasOwnMachine = !!(it.item_machine_sku || it.item_machine_vendor_model || it.item_machine_name);
        const effName = hasOwnMachine
            ? (it.item_machine_name || (erpMach ? erpMach.name : ''))
            : (parentReq.machine_name || (erpMach ? erpMach.name : ''));
        const effVendorModel = hasOwnMachine
            ? (it.item_machine_vendor_model || (erpMach ? erpMach.vendorCode : ''))
            : (parentReq.machine_vendor_model || (erpMach ? erpMach.vendorCode : ''));
        const effSupplier = hasOwnMachine
            ? (it.item_machine_supplier || it.intl_supplier_name || (erpMach ? erpMach.manufacturer : ''))
            : (it.intl_supplier_name || parentReq.machine_supplier_name || (erpMach ? erpMach.manufacturer : ''));
        const effSerial = hasOwnMachine
            ? (it.item_machine_serial || '')
            : (parentReq.machine_serial || '');

        return {
            ...it,
            effective_machine_sku: effSku,
            effective_machine_name: effName,
            effective_machine_vendor_model: effVendorModel,
            effective_machine_supplier: effSupplier,
            effective_machine_serial: effSerial
        };
    }

    // 8. Dashboard Completo (Kanban + Fila Jhenifer ERP + KPIs + Catálogo BOM)
    router.get('/dashboard', authenticateToken, asyncSafe(async (req, res) => {
        const rates = await getLiveExchangeRates(false);
        const governanceMap = await getStageGovernanceMap(req.user);
        const requests = await pAll(`SELECT * FROM parts_requests ORDER BY
            CASE urgency WHEN 'MAQUINA_PARADA' THEN 0 WHEN 'ALTA' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END ASC,
            id DESC`);
        const allItems = await pAll(`SELECT * FROM parts_request_items ORDER BY id ASC`);

        const itemsByReq = {};
        allItems.forEach((it) => {
            if (!itemsByReq[it.request_id]) itemsByReq[it.request_id] = [];
            itemsByReq[it.request_id].push(it);
        });

        const enrichedRequests = requests.map((r) => {
            const erpMachine = getErpSkuDetails(r.machine_sku);
            const reqWithMach = {
                ...r,
                machine_vendor_model: r.machine_vendor_model || (erpMachine ? erpMachine.vendorCode : ''),
                machine_supplier_name: r.machine_supplier_name || (erpMachine ? erpMachine.manufacturer : '')
            };
            const items = (itemsByReq[r.id] || []).map(it => enrichItemMachineFields(it, reqWithMach));
            const pendingErpCount = items.filter(i => !i.erp_registered && !i.erp_sku).length;
            const machineKeys = new Set();
            items.forEach(i => {
                const mk = i.effective_machine_vendor_model || i.effective_machine_sku || i.effective_machine_name;
                if (mk) machineKeys.add(mk.toUpperCase());
            });
            return {
                ...reqWithMach,
                items,
                items_count: items.length,
                distinct_machines_count: Math.max(1, machineKeys.size),
                pending_erp_count: pendingErpCount
            };
        });

        // Fila Expressa de Cadastro ERP dedicada à Jhenifer (apenas solicitações na etapa 4_CADASTRO_ERP ou itens aprovados sem SKU ERP)
        const erpQueue = [];
        enrichedRequests.forEach((r) => {
            if (r.stage === '4_CADASTRO_ERP') {
                r.items.forEach((it) => {
                    if (!it.erp_registered || !it.erp_sku) {
                        erpQueue.push({
                            ...it,
                            req_code: r.req_code,
                            urgency: r.urgency,
                            client_name: r.client_name,
                            requester_name: r.requester_name,
                            machine_sku: it.effective_machine_sku || r.machine_sku,
                            machine_name: it.effective_machine_name || r.machine_name,
                            machine_vendor_model: it.effective_machine_vendor_model || r.machine_vendor_model,
                            client_approved_at: r.client_approved_at || r.stage_entry_at
                        });
                    }
                });
            }
        });

        const catalog = await pAll(`SELECT * FROM parts_catalog ORDER BY times_requested DESC, id DESC`);

        res.json({
            exchange: rates,
            permissions: governanceMap,
            requests: enrichedRequests,
            erp_queue: erpQueue,
            catalog
        });
    }));

    // 9. Detalhe Completo de uma Solicitação + Timeline + Auto-Enriquecimento Multi-Máquina + Permissão da Etapa
    router.get('/requests/:id', authenticateToken, asyncSafe(async (req, res) => {
        const reqRow = await pGet('SELECT * FROM parts_requests WHERE id = ?', [req.params.id]);
        if (!reqRow) return res.status(404).json({ error: 'Solicitação não encontrada.' });
        const rawItems = await pAll('SELECT * FROM parts_request_items WHERE request_id = ? ORDER BY id ASC', [reqRow.id]);
        const timeline = await pAll('SELECT * FROM parts_timeline WHERE request_id = ? ORDER BY id DESC', [reqRow.id]);

        const erpMachine = getErpSkuDetails(reqRow.machine_sku);
        if (erpMachine) {
            if (!reqRow.machine_vendor_model && erpMachine.vendorCode) {
                reqRow.machine_vendor_model = erpMachine.vendorCode;
            }
            if (!reqRow.machine_supplier_name && erpMachine.manufacturer) {
                reqRow.machine_supplier_name = erpMachine.manufacturer;
            }
        }

        const items = rawItems.map((it) => {
            if (it.erp_sku) {
                const erpPart = getErpSkuDetails(it.erp_sku);
                if (erpPart) {
                    if (!it.vendor_part_number && erpPart.vendorCode) it.vendor_part_number = erpPart.vendorCode;
                    if (!it.part_name_en && erpPart.nameEn) it.part_name_en = erpPart.nameEn;
                }
            }
            return enrichItemMachineFields(it, reqRow);
        });

        // Resolver mapa de e-mails salvos por fornecedor (para multi-máquina / multi-fornecedor!)
        const supplierEmailsMap = {};
        const distinctSuppliers = new Set();
        if (reqRow.machine_supplier_name) distinctSuppliers.add(reqRow.machine_supplier_name);
        items.forEach(it => {
            if (it.effective_machine_supplier) distinctSuppliers.add(it.effective_machine_supplier);
            if (it.intl_supplier_name) distinctSuppliers.add(it.intl_supplier_name);
            if (it.nat_supplier_name) distinctSuppliers.add(it.nat_supplier_name);
        });
        for (const sup of distinctSuppliers) {
            const em = await resolveSupplierSavedEmail(sup);
            if (em) supplierEmailsMap[sup] = em;
        }

        const primarySup = (items[0] && items[0].effective_machine_supplier) || reqRow.machine_supplier_name || '';
        const suggestedSupplierEmail = supplierEmailsMap[primarySup] || await resolveSupplierSavedEmail(primarySup);
        const stageAccess = await canUserActOnStage(req.user, reqRow.stage);
        reqRow.requester_official_email = reqRow.requester_username && isPartsRequesterTeamUser(reqRow.requester_username)
            ? resolveOfficialUserEmail(reqRow.requester_username)
            : 'vendas18@tecfag.com.br';

        res.json({
            request: reqRow,
            items,
            timeline,
            access: {
                can_edit: stageAccess.allowed,
                is_master: stageAccess.isMaster,
                owner_display: stageAccess.ownerDisplay
            },
            supplier_emails_map: supplierEmailsMap,
            suggested_supplier_email: suggestedSupplierEmail,
            smtp_configured: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_HOST !== 'smtp.exemplo.com')
        });
    }));

    // 10. Criar Nova Solicitação de Peças (Restrito ao Responsável de Abertura: Guilherme Bertola + Master Admins)
    router.post('/requests', authenticateToken, asyncSafe(async (req, res) => {
        const createPerm = await canUserActOnStage(req.user, 'CREATE_REQUEST');
        if (!createPerm.allowed) {
            return res.status(403).json({
                error: `Acesso restrito: A abertura de novas solicitações é de responsabilidade exclusiva de ${createPerm.ownerDisplay}.`
            });
        }

        const {
            urgency = 'NORMAL',
            request_type = 'CLIENTE',
            client_name,
            client_cnpj = '',
            client_contact = '',
            client_phone = '',
            client_email = '',
            client_city_uf = '',
            machine_sku = '',
            machine_name = '',
            machine_serial = '',
            machine_vendor_model = '',
            machine_supplier_name = '',
            notes = '',
            skip_triage = false,
            items = []
        } = req.body;

        if (!client_name || !String(client_name).trim()) {
            return res.status(400).json({ error: 'Informe o nome do Cliente (ou "Estoque Tecfag" para reposição interna).' });
        }
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'Adicione ao menos 1 peça na solicitação.' });
        }

        // Auto-resolver Cód. Antigo (código no fornecedor) e Nome Fabricante a partir do skus.csv se machine_sku existir
        const erpMachine = getErpSkuDetails(machine_sku);
        const resolvedMachineVendorModel = String(machine_vendor_model || '').trim() || (erpMachine ? erpMachine.vendorCode : '');
        const resolvedMachineSupplier = String(machine_supplier_name || '').trim() || (erpMachine ? erpMachine.manufacturer : '');
        const resolvedMachineName = String(machine_name || '').trim() || (erpMachine ? erpMachine.name : '');

        const rates = await getLiveExchangeRates(false);
        const now = new Date().toISOString();
        const reqCode = await generateNextRequestCode();

        const allRoutesDefined = items.every(it => it.sourcing_route && it.sourcing_route !== 'DEFINIR');
        const initialStage = (skip_triage || allRoutesDefined) ? '2_COTACAO_FORNECEDOR' : '1_TRIAGEM_TECNICA';

        const insReq = await pRun(
            `INSERT INTO parts_requests (
                req_code, stage, urgency, request_type,
                client_name, client_cnpj, client_contact, client_phone, client_email, client_city_uf,
                requester_username, requester_name,
                machine_sku, machine_name, machine_serial, machine_vendor_model, machine_supplier_name,
                usd_rate_snapshot, stage_entry_at, notes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                reqCode, initialStage, urgency, request_type,
                String(client_name).trim(), client_cnpj, client_contact, client_phone, client_email, client_city_uf,
                req.user.username, getFriendlyUserName(req.user.username),
                machine_sku, resolvedMachineName, machine_serial, resolvedMachineVendorModel, resolvedMachineSupplier,
                rates.usd, now, notes, now, now
            ]
        );
        const requestId = insReq.lastID;

        for (const rawIt of items) {
            const partNamePt = String(rawIt.part_name_pt || '').trim();
            if (!partNamePt) continue;

            // Suporte Multi-Máquina por Item: se o item informou outra máquina específica, resolve o Cód. Antigo e Fabricante dela!
            const rawItemMSku = String(rawIt.item_machine_sku || '').trim();
            const rawItemMVendor = String(rawIt.item_machine_vendor_model || '').trim();
            const rawItemMName = String(rawIt.item_machine_name || '').trim();
            const rawItemMSerial = String(rawIt.item_machine_serial || '').trim();
            const rawItemMSup = String(rawIt.item_machine_supplier || '').trim();
            const hasCustomItemMachine = !!(rawItemMSku || rawItemMVendor || rawItemMName);

            const erpItemMach = hasCustomItemMachine ? getErpSkuDetails(rawItemMSku) : erpMachine;
            const effItemMSku = hasCustomItemMachine ? rawItemMSku : (machine_sku || '');
            const effItemMName = hasCustomItemMachine ? (rawItemMName || (erpItemMach ? erpItemMach.name : '')) : resolvedMachineName;
            const effItemMVendor = hasCustomItemMachine ? (rawItemMVendor || (erpItemMach ? erpItemMach.vendorCode : '')) : resolvedMachineVendorModel;
            const effItemMSupplier = hasCustomItemMachine ? (rawItemMSup || (erpItemMach ? erpItemMach.manufacturer : '')) : resolvedMachineSupplier;
            const effItemMSerial = hasCustomItemMachine ? rawItemMSerial : (machine_serial || '');

            const existingErpSku = rawIt.erp_sku ? String(rawIt.erp_sku).trim().toUpperCase() : '';
            const erpPart = getErpSkuDetails(existingErpSku);
            const resolvedPartVendorCode = String(rawIt.vendor_part_number || '').trim() || (erpPart ? erpPart.vendorCode : '');
            const resolvedPartNameEn = String(rawIt.part_name_en || '').trim() || (erpPart ? erpPart.nameEn : '');
            const category = rawIt.category || 'MECANICA';
            const suggestedNcm = rawIt.suggested_ncm || suggestNcmForCategory(category, existingErpSku);
            const route = rawIt.sourcing_route || 'DEFINIR';
            const fiscalOrigin = route === 'NACIONAL' ? '0' : '1';

            let catRow = null;
            if (rawIt.catalog_part_id) {
                catRow = await pGet('SELECT * FROM parts_catalog WHERE id = ?', [rawIt.catalog_part_id]);
            }
            if (!catRow && existingErpSku) {
                catRow = await pGet('SELECT * FROM parts_catalog WHERE erp_sku = ?', [existingErpSku]);
            }
            if (!catRow && effItemMSku) {
                catRow = await pGet(
                    'SELECT * FROM parts_catalog WHERE parent_machine_sku = ? AND LOWER(name_pt) = LOWER(?)',
                    [effItemMSku, partNamePt]
                );
            }

            let tempSku = '';
            let finalErpSku = existingErpSku || (catRow && catRow.erp_sku ? catRow.erp_sku : null);
            let catalogPartId = null;

            if (catRow) {
                tempSku = catRow.temp_sku;
                catalogPartId = catRow.id;
                await pRun(
                    `UPDATE parts_catalog
                     SET times_requested = COALESCE(times_requested, 1) + 1,
                         photo_path = COALESCE(?, photo_path),
                         updated_at = ?
                     WHERE id = ?`,
                    [rawIt.photo_path || null, now, catRow.id]
                );
            } else {
                tempSku = await generateNextTempSku();
                const insCat = await pRun(
                    `INSERT INTO parts_catalog (
                        temp_sku, erp_sku, erp_registered_by, erp_registered_at,
                        name_pt, name_en, category,
                        parent_machine_sku, parent_machine_name, parent_vendor_model,
                        sourcing_policy, national_equivalent_spec,
                        intl_supplier_name, intl_part_number,
                        suggested_ncm, fiscal_origin, unit, weight_kg, photo_path,
                        times_requested, notes, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
                    [
                        tempSku,
                        finalErpSku || null,
                        finalErpSku ? 'PRE_EXISTENTE_ERP' : null,
                        finalErpSku ? now : null,
                        partNamePt,
                        resolvedPartNameEn,
                        category,
                        effItemMSku,
                        effItemMName,
                        effItemMVendor,
                        route,
                        rawIt.national_equiv_spec || '',
                        effItemMSupplier,
                        resolvedPartVendorCode,
                        suggestedNcm,
                        fiscalOrigin,
                        rawIt.unit || 'UN',
                        parseFloat(rawIt.weight_kg) || 0,
                        rawIt.photo_path || null,
                        rawIt.item_notes || '',
                        now,
                        now
                    ]
                );
                catalogPartId = insCat.lastID;
            }

            const isAlreadyErp = finalErpSku ? 1 : 0;
            const lastFob = catRow && catRow.intl_last_fob_usd ? catRow.intl_last_fob_usd : 0;
            const lastNat = catRow && catRow.national_last_cost_brl ? catRow.national_last_cost_brl : 0;
            const intlCalc = computeIntlSalePriceBrl({ fobUsd: lastFob, usdRate: rates.usd, factor1: 2, factor2: 2 });
            const natSale = computeNatSalePriceBrl({ costBrl: lastNat, markupFactor: 2 });

            await pRun(
                `INSERT INTO parts_request_items (
                    request_id, catalog_part_id, temp_sku, erp_sku, erp_registered,
                    part_name_pt, part_name_en, category, vendor_part_number,
                    qty, unit, sourcing_route, national_equiv_spec,
                    intl_supplier_name, intl_unit_fob, intl_usd_rate, intl_factor_1, intl_factor_2, intl_unit_sale_brl,
                    nat_supplier_name, nat_unit_cost_brl, nat_markup_factor, nat_unit_sale_brl,
                    suggested_ncm, fiscal_origin, weight_kg, photo_path, item_notes,
                    item_machine_sku, item_machine_name, item_machine_vendor_model, item_machine_serial, item_machine_supplier
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2.0, 2.0, ?, ?, ?, 2.0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    requestId,
                    catalogPartId,
                    tempSku,
                    finalErpSku || null,
                    isAlreadyErp,
                    partNamePt,
                    resolvedPartNameEn || (catRow ? catRow.name_en : ''),
                    category,
                    resolvedPartVendorCode || (catRow ? catRow.intl_part_number : ''),
                    parseFloat(rawIt.qty) || 1,
                    rawIt.unit || 'UN',
                    route,
                    rawIt.national_equiv_spec || (catRow ? catRow.national_equivalent_spec : ''),
                    effItemMSupplier || (catRow ? catRow.intl_supplier_name : ''),
                    lastFob,
                    rates.usd,
                    intlCalc.saleBrl,
                    catRow ? (catRow.national_supplier_name || '') : '',
                    lastNat,
                    natSale,
                    suggestedNcm,
                    fiscalOrigin,
                    parseFloat(rawIt.weight_kg) || (catRow ? catRow.weight_kg : 0),
                    rawIt.photo_path || (catRow ? catRow.photo_path : null),
                    rawIt.item_notes || '',
                    effItemMSku || null,
                    effItemMName || null,
                    effItemMVendor || null,
                    effItemMSerial || null,
                    effItemMSupplier || null
                ]
            );
        }

        await addTimelineEntry(
            requestId,
            req.user,
            'CREATED',
            `Solicitação ${reqCode} aberta para "${client_name}" (${items.length} item/itens). Etapa inicial: ${initialStage === '2_COTACAO_FORNECEDOR' ? 'Cotação com Fornecedor (Pré-SKU gerado sem aguardar ERP)' : 'Triagem Técnica'}.`
        );

        const created = await pGet('SELECT * FROM parts_requests WHERE id = ?', [requestId]);
        res.json({ success: true, request: created });
    }));

    // 11. Atualizar Solicitação Completa + Itens + Cálculos de Cotação (Trava de Responsabilidade por Etapa!)
    router.put('/requests/:id', authenticateToken, asyncSafe(async (req, res) => {
        const reqId = parseInt(req.params.id);
        const existing = await pGet('SELECT * FROM parts_requests WHERE id = ?', [reqId]);
        if (!existing) return res.status(404).json({ error: 'Solicitação não encontrada.' });

        const stagePerm = await canUserActOnStage(req.user, existing.stage);
        if (!stagePerm.allowed) {
            return res.status(403).json({
                error: `🔒 Modo Somente Consulta: Esta solicitação está na etapa "${existing.stage}", sob responsabilidade exclusiva de ${stagePerm.ownerDisplay}.`
            });
        }

        const now = new Date().toISOString();
        const b = req.body || {};

        // Somente Master Admins podem alterar a etapa manualmente via seletor livre; responsáveis avançam pelos botões oficiais de ação
        const newStage = (stagePerm.isMaster && b.stage) ? b.stage : existing.stage;
        const stageChanged = newStage !== existing.stage;

        await pRun(
            `UPDATE parts_requests SET
                stage = ?,
                urgency = COALESCE(?, urgency),
                request_type = COALESCE(?, request_type),
                client_name = COALESCE(?, client_name),
                client_cnpj = COALESCE(?, client_cnpj),
                client_contact = COALESCE(?, client_contact),
                client_phone = COALESCE(?, client_phone),
                client_email = COALESCE(?, client_email),
                client_city_uf = COALESCE(?, client_city_uf),
                machine_sku = COALESCE(?, machine_sku),
                machine_name = COALESCE(?, machine_name),
                machine_serial = COALESCE(?, machine_serial),
                machine_vendor_model = COALESCE(?, machine_vendor_model),
                machine_supplier_name = COALESCE(?, machine_supplier_name),
                usd_rate_snapshot = COALESCE(?, usd_rate_snapshot),
                proposal_validity_days = COALESCE(?, proposal_validity_days),
                payment_terms_client = COALESCE(?, payment_terms_client),
                erp_order_number = COALESCE(?, erp_order_number),
                purchase_modality = COALESCE(?, purchase_modality),
                po_reference = COALESCE(?, po_reference),
                supplier_invoice = COALESCE(?, supplier_invoice),
                tracking_code = COALESCE(?, tracking_code),
                eta_date = COALESCE(?, eta_date),
                shelf_location = COALESCE(?, shelf_location),
                out_nfe_number = COALESCE(?, out_nfe_number),
                notes = COALESCE(?, notes),
                stage_entry_at = ?,
                updated_at = ?
             WHERE id = ?`,
            [
                newStage,
                b.urgency, b.request_type,
                b.client_name, b.client_cnpj, b.client_contact, b.client_phone, b.client_email, b.client_city_uf,
                b.machine_sku, b.machine_name, b.machine_serial, b.machine_vendor_model, b.machine_supplier_name,
                b.usd_rate_snapshot !== undefined ? parseFloat(b.usd_rate_snapshot) : null,
                b.proposal_validity_days !== undefined ? parseInt(b.proposal_validity_days) : null,
                b.payment_terms_client,
                b.erp_order_number,
                b.purchase_modality,
                b.po_reference,
                b.supplier_invoice,
                b.tracking_code,
                b.eta_date,
                b.shelf_location,
                b.out_nfe_number,
                b.notes,
                stageChanged ? now : existing.stage_entry_at,
                now,
                reqId
            ]
        );

        // Atualizar itens se enviados no payload
        if (Array.isArray(b.items)) {
            const usdSnap = parseFloat(b.usd_rate_snapshot) || existing.usd_rate_snapshot || 5.80;

            for (const it of b.items) {
                if (it.id) {
                    const fob = parseFloat(it.intl_unit_fob) || 0;
                    const freightUsd = parseFloat(it.intl_freight_usd) || 0;
                    const itemUsdRate = parseFloat(it.intl_usd_rate) || usdSnap;
                    const f1 = parseFloat(it.intl_factor_1) || 2.0;
                    const f2 = parseFloat(it.intl_factor_2) || 2.0;
                    const intlCalc = computeIntlSalePriceBrl({ fobUsd: fob, freightUsd, usdRate: itemUsdRate, factor1: f1, factor2: f2 });

                    const natCost = parseFloat(it.nat_unit_cost_brl) || 0;
                    const natMk = parseFloat(it.nat_markup_factor) || 2.0;
                    const natSale = computeNatSalePriceBrl({ costBrl: natCost, markupFactor: natMk });

                    const qty = parseFloat(it.qty) || 1;
                    let selectedSource = it.selected_source || 'PENDENTE';
                    let finalUnitBrl = parseFloat(it.final_unit_price_brl);

                    if (it.auto_price !== false) {
                        if (selectedSource === 'IMPORTACAO' && intlCalc.saleBrl > 0) {
                            finalUnitBrl = isNaN(finalUnitBrl) || finalUnitBrl <= 0 || it.recalc === true ? intlCalc.saleBrl : finalUnitBrl;
                        } else if (selectedSource === 'NACIONAL' && natSale > 0) {
                            finalUnitBrl = isNaN(finalUnitBrl) || finalUnitBrl <= 0 || it.recalc === true ? natSale : finalUnitBrl;
                        }
                    }
                    if (isNaN(finalUnitBrl)) finalUnitBrl = 0;
                    const finalTotalBrl = +(finalUnitBrl * qty).toFixed(2);

                    const promisedDays = parseInt(it.promised_lead_days) ||
                        (selectedSource === 'NACIONAL' ? (parseInt(it.nat_lead_time_days) || 5) : (parseInt(it.intl_lead_time_days) || 18));

                    const fiscalOrigin = (selectedSource === 'NACIONAL' || it.sourcing_route === 'NACIONAL') ? '0' : '1';

                    const itMachSku = it.item_machine_sku !== undefined ? String(it.item_machine_sku || '').trim() : undefined;
                    const erpItMach = itMachSku ? getErpSkuDetails(itMachSku) : null;
                    const itMachVendor = it.item_machine_vendor_model !== undefined
                        ? (String(it.item_machine_vendor_model || '').trim() || (erpItMach ? erpItMach.vendorCode : ''))
                        : undefined;
                    const itMachName = it.item_machine_name !== undefined
                        ? (String(it.item_machine_name || '').trim() || (erpItMach ? erpItMach.name : ''))
                        : undefined;
                    const itMachSup = it.item_machine_supplier !== undefined
                        ? (String(it.item_machine_supplier || '').trim() || (erpItMach ? erpItMach.manufacturer : ''))
                        : undefined;
                    const itMachSerial = it.item_machine_serial !== undefined ? String(it.item_machine_serial || '').trim() : undefined;

                    await pRun(
                        `UPDATE parts_request_items SET
                            part_name_pt = COALESCE(?, part_name_pt),
                            part_name_en = COALESCE(?, part_name_en),
                            category = COALESCE(?, category),
                            vendor_part_number = COALESCE(?, vendor_part_number),
                            qty = ?,
                            unit = COALESCE(?, unit),
                            sourcing_route = COALESCE(?, sourcing_route),
                            national_equiv_spec = COALESCE(?, national_equiv_spec),
                            intl_supplier_name = COALESCE(?, intl_supplier_name),
                            intl_unit_fob = ?,
                            intl_freight_usd = ?,
                            intl_lead_time_days = ?,
                            intl_modality = COALESCE(?, intl_modality),
                            intl_usd_rate = ?,
                            intl_factor_1 = ?,
                            intl_factor_2 = ?,
                            intl_unit_sale_brl = ?,
                            nat_supplier_name = COALESCE(?, nat_supplier_name),
                            nat_unit_cost_brl = ?,
                            nat_lead_time_days = ?,
                            nat_markup_factor = ?,
                            nat_unit_sale_brl = ?,
                            selected_source = ?,
                            final_unit_price_brl = ?,
                            final_total_price_brl = ?,
                            promised_lead_days = ?,
                            suggested_ncm = COALESCE(?, suggested_ncm),
                            fiscal_origin = ?,
                            weight_kg = COALESCE(?, weight_kg),
                            photo_path = COALESCE(?, photo_path),
                            item_notes = COALESCE(?, item_notes),
                            item_machine_sku = COALESCE(?, item_machine_sku),
                            item_machine_name = COALESCE(?, item_machine_name),
                            item_machine_vendor_model = COALESCE(?, item_machine_vendor_model),
                            item_machine_serial = COALESCE(?, item_machine_serial),
                            item_machine_supplier = COALESCE(?, item_machine_supplier)
                         WHERE id = ? AND request_id = ?`,
                        [
                            it.part_name_pt, it.part_name_en, it.category, it.vendor_part_number,
                            qty, it.unit, it.sourcing_route, it.national_equiv_spec,
                            it.intl_supplier_name, fob, freightUsd, parseInt(it.intl_lead_time_days) || 18, it.intl_modality,
                            itemUsdRate, f1, f2, intlCalc.saleBrl,
                            it.nat_supplier_name, natCost, parseInt(it.nat_lead_time_days) || 5, natMk, natSale,
                            selectedSource, finalUnitBrl, finalTotalBrl, promisedDays,
                            it.suggested_ncm, fiscalOrigin,
                            it.weight_kg !== undefined ? parseFloat(it.weight_kg) : null,
                            it.photo_path || null,
                            it.item_notes,
                            itMachSku !== undefined ? itMachSku : null,
                            itMachName !== undefined ? itMachName : null,
                            itMachVendor !== undefined ? itMachVendor : null,
                            itMachSerial !== undefined ? itMachSerial : null,
                            itMachSup !== undefined ? itMachSup : null,
                            it.id, reqId
                        ]
                    );

                    if (it.catalog_part_id) {
                        const catMSku = itMachSku || b.machine_sku || existing.machine_sku || '';
                        const catMName = itMachName || b.machine_name || existing.machine_name || '';
                        const catMVendor = itMachVendor || b.machine_vendor_model || existing.machine_vendor_model || '';
                        await pRun(
                            `UPDATE parts_catalog SET
                                name_pt = COALESCE(?, name_pt),
                                name_en = COALESCE(NULLIF(?, ''), name_en),
                                category = COALESCE(?, category),
                                parent_machine_sku = COALESCE(NULLIF(?, ''), parent_machine_sku),
                                parent_machine_name = COALESCE(NULLIF(?, ''), parent_machine_name),
                                parent_vendor_model = COALESCE(NULLIF(?, ''), parent_vendor_model),
                                sourcing_policy = CASE WHEN ? != 'DEFINIR' THEN ? ELSE sourcing_policy END,
                                national_equivalent_spec = COALESCE(NULLIF(?, ''), national_equivalent_spec),
                                national_supplier_name = COALESCE(NULLIF(?, ''), national_supplier_name),
                                national_last_cost_brl = CASE WHEN ? > 0 THEN ? ELSE national_last_cost_brl END,
                                intl_supplier_name = COALESCE(NULLIF(?, ''), intl_supplier_name),
                                intl_part_number = COALESCE(NULLIF(?, ''), intl_part_number),
                                intl_last_fob_usd = CASE WHEN ? > 0 THEN ? ELSE intl_last_fob_usd END,
                                suggested_ncm = COALESCE(NULLIF(?, ''), suggested_ncm),
                                weight_kg = CASE WHEN ? > 0 THEN ? ELSE weight_kg END,
                                photo_path = COALESCE(?, photo_path),
                                updated_at = ?
                             WHERE id = ?`,
                            [
                                it.part_name_pt, it.part_name_en || '', it.category,
                                catMSku, catMName, catMVendor,
                                it.sourcing_route || 'DEFINIR', it.sourcing_route || 'DEFINIR',
                                it.national_equiv_spec || '',
                                it.nat_supplier_name || '',
                                natCost, natCost,
                                it.intl_supplier_name || itMachSup || '',
                                it.vendor_part_number || '',
                                fob, fob,
                                it.suggested_ncm || '',
                                parseFloat(it.weight_kg) || 0, parseFloat(it.weight_kg) || 0,
                                it.photo_path || null,
                                now,
                                it.catalog_part_id
                            ]
                        );
                    }
                } else if (it.part_name_pt && String(it.part_name_pt).trim()) {
                    const tempSku = await generateNextTempSku();
                    const cat = it.category || 'MECANICA';
                    const ncm = it.suggested_ncm || suggestNcmForCategory(cat, it.erp_sku);
                    const newMSku = String(it.item_machine_sku || b.machine_sku || existing.machine_sku || '').trim();
                    const erpNewM = getErpSkuDetails(newMSku);
                    const newMName = String(it.item_machine_name || b.machine_name || existing.machine_name || (erpNewM ? erpNewM.name : '')).trim();
                    const newMVendor = String(it.item_machine_vendor_model || b.machine_vendor_model || existing.machine_vendor_model || (erpNewM ? erpNewM.vendorCode : '')).trim();
                    const newMSup = String(it.item_machine_supplier || b.machine_supplier_name || existing.machine_supplier_name || (erpNewM ? erpNewM.manufacturer : '')).trim();

                    const insCat = await pRun(
                        `INSERT INTO parts_catalog (
                            temp_sku, erp_sku, name_pt, name_en, category,
                            parent_machine_sku, parent_machine_name, parent_vendor_model,
                            intl_supplier_name, sourcing_policy, suggested_ncm, unit, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            tempSku, it.erp_sku || null, String(it.part_name_pt).trim(), it.part_name_en || '', cat,
                            newMSku, newMName, newMVendor, newMSup,
                            it.sourcing_route || 'DEFINIR', ncm, it.unit || 'UN', now, now
                        ]
                    );
                    await pRun(
                        `INSERT INTO parts_request_items (
                            request_id, catalog_part_id, temp_sku, erp_sku, erp_registered,
                            part_name_pt, part_name_en, category, vendor_part_number,
                            qty, unit, sourcing_route, suggested_ncm, intl_usd_rate, intl_supplier_name,
                            item_machine_sku, item_machine_name, item_machine_vendor_model, item_machine_serial, item_machine_supplier
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            reqId, insCat.lastID, tempSku, it.erp_sku || null, it.erp_sku ? 1 : 0,
                            String(it.part_name_pt).trim(), it.part_name_en || '', cat, it.vendor_part_number || '',
                            parseFloat(it.qty) || 1, it.unit || 'UN', it.sourcing_route || 'DEFINIR', ncm, usdSnap, newMSup,
                            newMSku || null, newMName || null, newMVendor || null, it.item_machine_serial || null, newMSup || null
                        ]
                    );
                }
            }
        }

        const totalQuoted = await recalculateRequestTotals(reqId);

        if (stageChanged) {
            await addTimelineEntry(reqId, req.user, 'STAGE_CHANGE', `Etapa movida de "${existing.stage}" para "${newStage}".`);
        } else if (b.log_message) {
            await addTimelineEntry(reqId, req.user, 'UPDATE', b.log_message);
        }

        const updated = await pGet('SELECT * FROM parts_requests WHERE id = ?', [reqId]);
        const updatedRawItems = await pAll('SELECT * FROM parts_request_items WHERE request_id = ? ORDER BY id ASC', [reqId]);
        const updatedItems = updatedRawItems.map(it => enrichItemMachineFields(it, updated));
        res.json({ success: true, request: updated, items: updatedItems, total_quoted_brl: totalQuoted });
    }));

    // 12. Transições Inteligentes de Negócio (Bloqueado por Responsabilidade da Etapa!)
    router.post('/requests/:id/action', authenticateToken, asyncSafe(async (req, res) => {
        const reqId = parseInt(req.params.id);
        const { action, reason, erp_order_number, out_nfe_number, shelf_location } = req.body;
        const r = await pGet('SELECT * FROM parts_requests WHERE id = ?', [reqId]);
        if (!r) return res.status(404).json({ error: 'Solicitação não encontrada.' });

        const stagePerm = await canUserActOnStage(req.user, r.stage);
        if (!stagePerm.allowed) {
            return res.status(403).json({
                error: `🔒 Ação bloqueada: A etapa atual ("${r.stage}") é de responsabilidade exclusiva de ${stagePerm.ownerDisplay}.`
            });
        }

        const items = await pAll('SELECT * FROM parts_request_items WHERE request_id = ?', [reqId]);
        const now = new Date().toISOString();

        if (action === 'SEND_TO_QUOTATION') {
            await pRun(`UPDATE parts_requests SET stage = '2_COTACAO_FORNECEDOR', stage_entry_at = ?, updated_at = ? WHERE id = ?`, [now, now, reqId]);
            await addTimelineEntry(reqId, req.user, 'STAGE_CHANGE', 'Triagem técnica concluída. Liberado para Cotação com Fornecedor (sem aguardar cadastro ERP).');
        } else if (action === 'RELEASE_PROPOSAL_TO_SALES') {
            await pRun(`UPDATE parts_requests SET stage = '3_PROPOSTA_CLIENTE', proposal_sent_at = COALESCE(proposal_sent_at, ?), stage_entry_at = ?, updated_at = ? WHERE id = ?`, [now, now, now, reqId]);
            await addTimelineEntry(reqId, req.user, 'PROPOSAL_READY', `Cotação concluída (Total R$ ${(r.total_quoted_brl || 0).toFixed(2)}) e encaminhada para proposta comercial ao cliente.`);
        } else if (action === 'CLIENT_APPROVED') {
            const needsErpRegistration = items.some(it => !it.erp_registered || !it.erp_sku);
            const nextStage = needsErpRegistration ? '4_CADASTRO_ERP' : '5_COMPRA_TRANSITO';

            await pRun(
                `UPDATE parts_requests SET
                    stage = ?,
                    client_approved_at = ?,
                    erp_order_number = COALESCE(?, erp_order_number),
                    stage_entry_at = ?,
                    updated_at = ?
                 WHERE id = ?`,
                [nextStage, now, erp_order_number || null, now, now, reqId]
            );

            if (needsErpRegistration) {
                await addTimelineEntry(
                    reqId,
                    req.user,
                    'CLIENT_APPROVED',
                    `🎉 Cliente APROVOU a proposta! Enviado para a Fila Expressa de Cadastro ERP (Jhenifer) com ficha técnica pronta.`
                );
            } else {
                await addTimelineEntry(
                    reqId,
                    req.user,
                    'CLIENT_APPROVED',
                    `🎉 Cliente APROVOU a proposta! Como todas as peças já possuem SKU Oficial no ERP, pulou o cadastro e avançou direto para Compra & Trânsito!`
                );
            }
        } else if (action === 'CLIENT_DECLINED') {
            await pRun(
                `UPDATE parts_requests SET stage = '8_DECLINADO_CANCELADO', lost_reason = ?, stage_entry_at = ?, updated_at = ? WHERE id = ?`,
                [reason || 'Cliente declinou o orçamento', now, now, reqId]
            );
            await addTimelineEntry(
                reqId,
                req.user,
                'DECLINED',
                `Orçamento declinado/encerrado (${reason || 'Sem motivo informado'}). Nenhum cadastro inútil foi criado no ERP, e os preços ficaram salvos na Árvore da Máquina.`
            );
        } else if (action === 'ARRIVED_AT_DOCK') {
            await pRun(
                `UPDATE parts_requests SET stage = '6_DOCA_EXPEDICAO', arrived_at = ?, shelf_location = COALESCE(?, shelf_location), stage_entry_at = ?, updated_at = ? WHERE id = ?`,
                [now, shelf_location || null, now, now, reqId]
            );
            await addTimelineEntry(
                reqId,
                req.user,
                'ARRIVED',
                `📦 Peça(s) recebida(s) na Doca Tecfag! RESERVADA / CARIMBADA para o cliente "${r.client_name}" (Solicitante: ${r.requester_name}).`
            );
        } else if (action === 'MARK_DELIVERED') {
            await pRun(
                `UPDATE parts_requests SET stage = '7_CONCLUIDO', out_nfe_number = COALESCE(?, out_nfe_number), delivered_at = ?, stage_entry_at = ?, updated_at = ? WHERE id = ?`,
                [out_nfe_number || null, now, now, now, reqId]
            );
            await addTimelineEntry(
                reqId,
                req.user,
                'DELIVERED',
                `✅ Atendimento concluído e faturado/entregue ao cliente${out_nfe_number ? ' (NF Saída: ' + out_nfe_number + ')' : ''}!`
            );
        } else {
            return res.status(400).json({ error: 'Ação desconhecida.' });
        }

        const updated = await pGet('SELECT * FROM parts_requests WHERE id = ?', [reqId]);
        res.json({ success: true, request: updated });
    }));

    // 13. Fila Expressa da Jhenifer: Confirmar SKU Oficial criado no ERP (De-Para TMP-PEC -> SKU ERP)
    router.post('/items/:itemId/register-erp-sku', authenticateToken, asyncSafe(async (req, res) => {
        const erpPerm = await canUserActOnStage(req.user, '4_CADASTRO_ERP');
        if (!erpPerm.allowed) {
            return res.status(403).json({
                error: `🔒 Apenas o responsável pelo Cadastro ERP (${erpPerm.ownerDisplay}) pode registrar o SKU Oficial.`
            });
        }

        const itemId = parseInt(req.params.itemId);
        const { erp_sku, suggested_ncm, unit } = req.body;
        const cleanSku = String(erp_sku || '').trim().toUpperCase();
        if (!cleanSku) {
            return res.status(400).json({ error: 'Digite o Código/SKU Oficial gerado no ERP.' });
        }

        const item = await pGet('SELECT * FROM parts_request_items WHERE id = ?', [itemId]);
        if (!item) return res.status(404).json({ error: 'Item da solicitação não encontrado.' });

        const parentReq = await pGet('SELECT * FROM parts_requests WHERE id = ?', [item.request_id]);
        const now = new Date().toISOString();

        await pRun(
            `UPDATE parts_request_items SET
                erp_sku = ?,
                erp_registered = 1,
                erp_registered_by = ?,
                erp_registered_at = ?,
                suggested_ncm = COALESCE(NULLIF(?, ''), suggested_ncm),
                unit = COALESCE(NULLIF(?, ''), unit)
             WHERE id = ?`,
            [cleanSku, req.user.username, now, suggested_ncm || '', unit || '', itemId]
        );

        if (item.catalog_part_id) {
            await pRun(
                `UPDATE parts_catalog SET
                    erp_sku = ?,
                    erp_registered_by = ?,
                    erp_registered_at = ?,
                    suggested_ncm = COALESCE(NULLIF(?, ''), suggested_ncm),
                    unit = COALESCE(NULLIF(?, ''), unit),
                    updated_at = ?
                 WHERE id = ?`,
                [cleanSku, req.user.username, now, suggested_ncm || '', unit || '', now, item.catalog_part_id]
            );
        }

        if (item.vendor_part_number && String(item.vendor_part_number).trim()) {
            await mrpRun(
                `INSERT OR REPLACE INTO supplier_sku_mappings (
                    supplier_name, supplier_sku, tecfag_sku, description, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    item.intl_supplier_name || item.item_machine_supplier || (parentReq ? parentReq.machine_supplier_name : '') || 'Fornecedor Peças',
                    String(item.vendor_part_number).trim(),
                    cleanSku,
                    item.part_name_pt,
                    now,
                    now
                ]
            ).catch(() => {});
        }

        try {
            const prods = loadProductsCatalog();
            const targetMachineName = item.item_machine_name || (parentReq ? parentReq.machine_name : '') || '';
            if (!prods.some(p => String(p.sku || '').toUpperCase() === cleanSku)) {
                prods.push({
                    sku: cleanSku,
                    name: item.part_name_pt.toUpperCase(),
                    group: targetMachineName ? `PEÇA REPOSIÇÃO - ${targetMachineName.toUpperCase().slice(0, 35)}` : 'PEÇAS DE REPOSIÇÃO',
                    vendorCode: item.vendor_part_number || ''
                });
                fs.writeFileSync(PRODUCTS_JSON_PATH, JSON.stringify(prods, null, 2), 'utf8');
            }
        } catch (e) {}

        await addTimelineEntry(
            item.request_id,
            req.user,
            'ERP_SKU_REGISTERED',
            `✅ SKU Oficial ERP "${cleanSku}" vinculado à peça "${item.part_name_pt}" (substituindo ${item.temp_sku}).`
        );

        const remaining = await pGet(
            'SELECT COUNT(*) as cnt FROM parts_request_items WHERE request_id = ? AND (erp_registered = 0 OR erp_sku IS NULL OR erp_sku = "")',
            [item.request_id]
        );
        let autoAdvanced = false;
        if ((!remaining || remaining.cnt === 0) && parentReq && parentReq.stage === '4_CADASTRO_ERP') {
            await pRun(
                `UPDATE parts_requests SET stage = '5_COMPRA_TRANSITO', stage_entry_at = ?, updated_at = ? WHERE id = ?`,
                [now, now, item.request_id]
            );
            await addTimelineEntry(
                item.request_id,
                req.user,
                'AUTO_ADVANCE',
                `🚀 Todos os SKUs do ERP foram concluídos! Solicitação liberada automaticamente para Compra & Trânsito.`
            );
            autoAdvanced = true;
        }

        res.json({ success: true, erp_sku: cleanSku, auto_advanced: autoAdvanced });
    }));

    // 14. Injetar Peça Importada Direto em um Container Aberto do Módulo Comex (stock_orders)
    router.post('/requests/:id/inject-container', authenticateToken, asyncSafe(async (req, res) => {
        const reqId = parseInt(req.params.id);
        const { stock_order_id } = req.body;
        if (!stock_order_id) return res.status(400).json({ error: 'Selecione um Container / PO em aberto.' });

        const r = await pGet('SELECT * FROM parts_requests WHERE id = ?', [reqId]);
        if (!r) return res.status(404).json({ error: 'Solicitação não encontrada.' });

        const stagePerm = await canUserActOnStage(req.user, r.stage);
        if (!stagePerm.allowed) {
            return res.status(403).json({
                error: `🔒 Ação restrita ao responsável da etapa atual (${stagePerm.ownerDisplay}).`
            });
        }

        const order = await mrpGet('SELECT * FROM stock_orders WHERE id = ?', [stock_order_id]);
        if (!order) return res.status(404).json({ error: 'Ordem/Container não encontrado no módulo de Importações.' });

        const items = await pAll('SELECT * FROM parts_request_items WHERE request_id = ?', [reqId]);
        const importedItems = items.filter(it => it.selected_source === 'IMPORTACAO' || it.sourcing_route === 'IMPORTACAO_OBRIGATORIA' || it.sourcing_route === 'COTAR_AMBOS');
        if (importedItems.length === 0) {
            return res.status(400).json({ error: 'Nenhum item marcado para importação nesta solicitação.' });
        }

        const now = new Date().toISOString();
        for (const it of importedItems) {
            const skuToUse = it.erp_sku || it.temp_sku;
            const unitFob = parseFloat(it.intl_unit_fob) || 0;
            const qty = parseFloat(it.qty) || 1;
            const itemMachSku = it.item_machine_sku || r.machine_sku || '';
            await mrpRun(
                `INSERT INTO stock_order_items (
                    order_id, sku, tecfag_sku, description, ncm,
                    qty_ordered, qty_shipped, unit_price_fob, total_price_fob,
                    status, is_project_item, client_name, notes, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'ORDERED', 0, ?, ?, ?)`,
                [
                    order.id,
                    it.vendor_part_number || skuToUse,
                    it.erp_sku || null,
                    `[PEÇA REPOSIÇÃO ${r.req_code}] ${it.part_name_pt}${itemMachSku ? ' (Máq: ' + itemMachSku + ')' : ''}`,
                    it.suggested_ncm || '',
                    qty,
                    unitFob,
                    +(unitFob * qty).toFixed(2),
                    `PEÇA CLIENTE: ${r.client_name}`,
                    `Solicitação ${r.req_code} • Solicitante: ${r.requester_name}`,
                    now
                ]
            );
        }

        await pRun(
            `UPDATE parts_requests SET
                linked_stock_order_id = ?,
                linked_po_number = ?,
                purchase_modality = 'CONTAINER_MARITIMO',
                po_reference = ?,
                eta_date = COALESCE(?, eta_date),
                updated_at = ?
             WHERE id = ?`,
            [order.id, order.po_number, order.po_number, order.eta_warehouse_date || null, now, reqId]
        );

        await addTimelineEntry(
            reqId,
            req.user,
            'CONTAINER_LINKED',
            `🚢 Peça(s) incluída(s) de carona no Container/PO "${order.po_number}" (${order.supplier_name}) no módulo Importações & Estoque!`
        );

        res.json({ success: true, po_number: order.po_number });
    }));

    // 15. Comentário Rápido na Timeline da Solicitação (Liberado para TODOS consultarem e interagirem!)
    router.post('/requests/:id/comment', authenticateToken, asyncSafe(async (req, res) => {
        const reqId = parseInt(req.params.id);
        const msg = String(req.body.message || '').trim();
        if (!msg) return res.status(400).json({ error: 'Digite uma mensagem.' });
        await addTimelineEntry(reqId, req.user, 'COMMENT', msg);
        const timeline = await pAll('SELECT * FROM parts_timeline WHERE request_id = ? ORDER BY id DESC', [reqId]);
        res.json({ success: true, timeline });
    }));

    // 16. Excluir Solicitação (Exclusivo Administradores Master: Gilson / Fernando / Admin)
    router.delete('/requests/:id', authenticateToken, asyncSafe(async (req, res) => {
        if (!isMasterAdminUser(req.user)) {
            return res.status(403).json({ error: '🔒 Apenas Administradores Master (Gilson / Fernando) podem excluir solicitações.' });
        }
        const reqId = parseInt(req.params.id);
        const r = await pGet('SELECT * FROM parts_requests WHERE id = ?', [reqId]);
        if (!r) return res.status(404).json({ error: 'Solicitação não encontrada.' });
        await pRun('DELETE FROM parts_requests WHERE id = ?', [reqId]);
        res.json({ success: true });
    }));

    // 17. CRUD de Fornecedores Nacionais (Brasil)
    router.post('/national-suppliers', authenticateToken, asyncSafe(async (req, res) => {
        const { name, specialty = 'MECANICA', city_uf = '', contact_person = '', phone_whatsapp = '', email = '', avg_lead_days = 5, notes = '' } = req.body;
        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: 'Informe o nome do fornecedor nacional.' });
        }
        const now = new Date().toISOString();
        await pRun(
            `INSERT INTO parts_national_suppliers (name, specialty, city_uf, contact_person, phone_whatsapp, email, avg_lead_days, notes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [String(name).trim(), specialty, city_uf, contact_person, phone_whatsapp, email, parseInt(avg_lead_days) || 5, notes, now]
        );
        const list = await pAll('SELECT * FROM parts_national_suppliers ORDER BY name ASC');
        res.json({ success: true, suppliers: list });
    }));

    router.delete('/national-suppliers/:id', authenticateToken, asyncSafe(async (req, res) => {
        await pRun('DELETE FROM parts_national_suppliers WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    }));

    // 18. Disparo Oficial de E-mail ao Fornecedor COM Agrupamento Multi-Máquina + Fotos Embutidas no Corpo (CID) + Cód. Antigo
    router.post('/requests/:id/send-supplier-email', authenticateToken, partsUpload.array('extra_files', 10), asyncSafe(async (req, res) => {
        const reqId = parseInt(req.params.id);
        const r = await pGet('SELECT * FROM parts_requests WHERE id = ?', [reqId]);
        if (!r) return res.status(404).json({ error: 'Solicitação não encontrada.' });

        const stagePerm = await canUserActOnStage(req.user, r.stage);
        if (!stagePerm.allowed) {
            return res.status(403).json({
                error: `🔒 Apenas o responsável da etapa atual (${stagePerm.ownerDisplay}) pode disparar e-mails de cotação ao fornecedor.`
            });
        }

        const {
            to = '',
            cc = '',
            subject = '',
            body = '',
            lang = 'EN',
            supplier_name = '',
            vendor_machine_code = '',
            selected_item_ids = '',
            item_overrides = ''
        } = req.body || {};

        if (!to || !String(to).trim()) {
            return res.status(400).json({ error: 'Informe o e-mail do fornecedor no campo "Para (To)".' });
        }
        if (!subject || !String(subject).trim()) {
            return res.status(400).json({ error: 'Informe o assunto do e-mail.' });
        }
        if (!process.env.SMTP_HOST || !process.env.SMTP_USER || process.env.SMTP_HOST === 'smtp.exemplo.com') {
            return res.status(500).json({ error: 'Servidor de e-mail SMTP não configurado nas variáveis de ambiente (SMTP_HOST / SMTP_USER).' });
        }

        const now = new Date().toISOString();

        // Persistir edições rápidas de descrição em Inglês / código da peça feitas direto no modal de e-mail
        if (item_overrides && String(item_overrides).trim()) {
            try {
                const parsedOverrides = JSON.parse(item_overrides);
                if (Array.isArray(parsedOverrides)) {
                    for (const ov of parsedOverrides) {
                        if (!ov || !ov.id) continue;
                        await pRun(
                            `UPDATE parts_request_items
                             SET part_name_en = COALESCE(NULLIF(?, ''), part_name_en),
                                 part_name_pt = COALESCE(NULLIF(?, ''), part_name_pt),
                                 vendor_part_number = ?
                             WHERE id = ? AND request_id = ?`,
                            [
                                String(ov.part_name_en || '').trim(),
                                String(ov.part_name_pt || '').trim(),
                                String(ov.vendor_part_number || '').trim(),
                                parseInt(ov.id),
                                reqId
                            ]
                        ).catch(() => {});
                    }
                }
            } catch (e) {}
        }

        const allRawItems = await pAll('SELECT * FROM parts_request_items WHERE request_id = ? ORDER BY id ASC', [reqId]);

        // Resolver Código Original no Fornecedor (Aba Cód. Antigo do ERP) — NUNCA enviar SKU interno Tecfag ao fornecedor externo
        const erpMachine = getErpSkuDetails(r.machine_sku);
        const effectiveVendorMachineCode = String(vendor_machine_code || '').trim() ||
            r.machine_vendor_model ||
            (erpMachine ? erpMachine.vendorCode : '');

        if (effectiveVendorMachineCode && !r.machine_vendor_model) {
            await pRun('UPDATE parts_requests SET machine_vendor_model = ?, updated_at = ? WHERE id = ?', [
                effectiveVendorMachineCode, now, reqId
            ]);
            r.machine_vendor_model = effectiveVendorMachineCode;
        }

        // Filtrar apenas os itens selecionados para este fornecedor (caso haja peças de fornecedores diferentes no mesmo pedido!)
        let selectedIdsSet = null;
        if (selected_item_ids && String(selected_item_ids).trim()) {
            try {
                const parsed = JSON.parse(selected_item_ids);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    selectedIdsSet = new Set(parsed.map(x => parseInt(x)).filter(Boolean));
                }
            } catch (e) {
                const splitIds = String(selected_item_ids).split(',').map(x => parseInt(x.trim())).filter(Boolean);
                if (splitIds.length > 0) selectedIdsSet = new Set(splitIds);
            }
        }

        const enrichedAll = allRawItems.map(it => enrichItemMachineFields(it, r));
        const items = selectedIdsSet
            ? enrichedAll.filter(it => selectedIdsSet.has(it.id))
            : enrichedAll;

        // Memorizar o e-mail deste fornecedor automaticamente para as próximas cotações
        const cleanSupplierName = String(supplier_name || (items[0] && items[0].effective_machine_supplier) || r.machine_supplier_name || (erpMachine ? erpMachine.manufacturer : '') || '').trim();
        const primaryToEmail = String(to).split(/[,;]+/)[0].trim();
        if (cleanSupplierName && primaryToEmail.includes('@')) {
            await pRun(
                `INSERT OR REPLACE INTO parts_supplier_emails (supplier_name, contact_email, updated_at) VALUES (?, ?, ?)`,
                [cleanSupplierName, primaryToEmail, now]
            ).catch(() => {});
            await mrpRun(
                `UPDATE stock_suppliers SET contact_email = COALESCE(NULLIF(contact_email, ''), ?) WHERE LOWER(name) = LOWER(?)`,
                [primaryToEmail, cleanSupplierName]
            ).catch(() => {});
            await pRun(
                `UPDATE parts_national_suppliers SET email = COALESCE(NULLIF(email, ''), ?) WHERE LOWER(name) = LOWER(?)`,
                [primaryToEmail, cleanSupplierName]
            ).catch(() => {});
        }

        function escHtml(val) {
            return String(val || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        function stripInternalTecfagSku(text) {
            if (!text) return '';
            return String(text)
                .trim()
                .replace(/^(?:PA[A-Z]{2,7}\d{2,6}|TMP-PEC-\d+)\s*[-–—:|]?\s*/i, '')
                .trim();
        }

        function formatSupplierUnit(unit, targetLang) {
            const raw = String(unit || '').trim().toUpperCase();
            if (targetLang === 'EN') {
                if (!raw || ['UN', 'UND', 'UNID', 'PC', 'PÇ', 'PÇA', 'PECA', 'PEÇA'].includes(raw)) return 'PCS';
                if (['CJ', 'CONJ', 'KIT'].includes(raw)) return 'SET';
                if (raw === 'PAR') return 'PAIR';
                if (raw === 'MT') return 'M';
                return raw;
            }
            return raw || 'UN';
        }

        function getCleanSupplierPartTitle(it, targetLang) {
            const erpPart = it.erp_sku ? getErpSkuDetails(it.erp_sku) : null;
            if (targetLang === 'EN') {
                const enCandidate = stripInternalTecfagSku(it.part_name_en || (erpPart && erpPart.nameEn) || '');
                if (enCandidate) return enCandidate;
                return stripInternalTecfagSku(it.part_name_pt || '');
            }
            return stripInternalTecfagSku(it.part_name_pt || '');
        }

        function resolvePartPhotoDiskPath(photoUrlPath) {
            if (!photoUrlPath) return null;
            const fname = path.basename(String(photoUrlPath));
            const candidate = path.join(PARTS_UPLOADS_DIR, fname);
            if (fs.existsSync(candidate)) return candidate;
            return null;
        }

        // Detecta dimensões reais (PNG / JPEG) para definir width explícito no <img> (compatibilidade 100% Outlook Desktop / Foxmail!)
        function computeEmailImageWidth(diskPath) {
            try {
                const buf = fs.readFileSync(diskPath);
                let w = 0;
                let h = 0;
                // PNG signature
                if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
                    w = buf.readUInt32BE(16);
                    h = buf.readUInt32BE(20);
                } else if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
                    // JPEG SOF scan
                    let offset = 2;
                    while (offset + 9 < buf.length) {
                        if (buf[offset] !== 0xFF) { offset++; continue; }
                        const marker = buf[offset + 1];
                        if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
                            h = buf.readUInt16BE(offset + 5);
                            w = buf.readUInt16BE(offset + 7);
                            break;
                        }
                        const segLen = buf.readUInt16BE(offset + 2);
                        if (segLen < 2) break;
                        offset += 2 + segLen;
                    }
                }
                if (w > 0 && h > 0) {
                    if (h > w * 1.12) {
                        // Imagem vertical/retrato (ex: foto de celular em pé) -> largura compacta elegante
                        return Math.min(w, 280);
                    }
                    return Math.min(w, 440);
                }
            } catch (e) {}
            return 360;
        }

        // Agrupar os itens selecionados por Máquina (Cód. Antigo do Fornecedor) para organização cristalina de descrições e fotos!
        const machineGroupsMap = new Map();
        items.forEach((it) => {
            const mModel = String(it.effective_machine_vendor_model || effectiveVendorMachineCode || '').trim();
            const mSerial = String(it.effective_machine_serial || '').trim();
            const key = (mModel || 'GENERAL_MACHINE').toUpperCase();
            if (!machineGroupsMap.has(key)) {
                machineGroupsMap.set(key, {
                    vendorModel: mModel,
                    serial: mSerial,
                    items: []
                });
            }
            machineGroupsMap.get(key).items.push(it);
        });
        const machineGroups = Array.from(machineGroupsMap.values());
        const isMultiMachine = machineGroups.length > 1;

        const mailAttachments = [];
        const hasHeaderLogo = fs.existsSync(HEADER_LOGO_IMG_PATH);
        if (hasHeaderLogo) {
            mailAttachments.push({
                filename: 'logo_tecfag.png',
                path: HEADER_LOGO_IMG_PATH,
                cid: 'tecfag_header_logo',
                contentDisposition: 'inline'
            });
        }

        const groupedPhotosSectionsHtml = [];
        const partsTableRowsHtml = [];
        const plainTextItemsLines = [];
        let photoCounter = 0;

        for (let gIdx = 0; gIdx < machineGroups.length; gIdx++) {
            const grp = machineGroups[gIdx];
            const grpPhotoCards = [];
            const safeMachineSlug = String(grp.vendorModel || `M${gIdx + 1}`).replace(/[^a-zA-Z0-9\-_]/g, '_').slice(0, 22);

            if (isMultiMachine) {
                partsTableRowsHtml.push(`
                    <tr bgcolor="#e0f2fe" style="background-color:#e0f2fe;">
                        <td colspan="5" style="padding:8px 12px; border-bottom:1px solid #bae6fd; font-size:12px; font-weight:bold; color:#0369a1;">
                            🏭 ${lang === 'EN' ? `MACHINE ${gIdx + 1} — Original Model:` : `MÁQUINA ${gIdx + 1} — Modelo Ref.:`} ${escHtml(grp.vendorModel || 'N/A')}
                            ${grp.serial ? ` &nbsp;|&nbsp; Serial: ${escHtml(grp.serial)}` : ''}
                        </td>
                    </tr>
                `);
                plainTextItemsLines.push(`\n[${lang === 'EN' ? 'MACHINE' : 'MÁQUINA'} ${gIdx + 1}] ${grp.vendorModel || 'N/A'}`);
            }

            for (let i = 0; i < grp.items.length; i++) {
                const it = grp.items[i];
                const itemLabelNum = isMultiMachine ? `${gIdx + 1}.${i + 1}` : `${i + 1}`;
                const erpPart = it.erp_sku ? getErpSkuDetails(it.erp_sku) : null;
                const cleanPartCode = String(it.vendor_part_number || (erpPart ? erpPart.vendorCode : '') || '').trim();
                const displayPartTitle = getCleanSupplierPartTitle(it, lang);
                const unitStr = formatSupplierUnit(it.unit, lang);
                const diskPath = resolvePartPhotoDiskPath(it.photo_path);
                const ext = diskPath ? (path.extname(diskPath) || '.jpg') : '';
                const hasInlinePhoto = !!(diskPath && ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext.toLowerCase()));

                const rowBg = (i % 2 === 1) ? '#f8fafc' : '#ffffff';
                const specSubLine = (lang !== 'EN' && it.national_equiv_spec)
                    ? `<div style="font-size:11px; color:#475569; margin-top:3px;">Espec.: ${escHtml(it.national_equiv_spec)}</div>`
                    : '';
                const codeSubBadge = cleanPartCode
                    ? `<div style="font-size:11px; color:#0284c7; font-family:Consolas,monospace; margin-top:3px;">${lang === 'EN' ? 'Part Code' : 'Cód. Ref.'}: <strong>${escHtml(cleanPartCode)}</strong></div>`
                    : '';

                partsTableRowsHtml.push(`
                    <tr bgcolor="${rowBg}" style="background-color:${rowBg};">
                        <td width="52" align="center" valign="middle" style="padding:10px 8px; border-bottom:1px solid #e2e8f0; font-weight:bold; color:#0284c7; font-size:13px;">#${itemLabelNum}</td>
                        <td width="115" valign="middle" style="padding:10px 10px; border-bottom:1px solid #e2e8f0; font-family:Consolas,Arial,sans-serif; font-weight:bold; color:#0f172a; font-size:13px;">${escHtml(grp.vendorModel || '-')}</td>
                        <td valign="middle" style="padding:10px 12px; border-bottom:1px solid #e2e8f0; font-weight:bold; color:#0f172a; font-size:13px; line-height:1.4;">
                            ${escHtml(displayPartTitle)}
                            ${codeSubBadge}
                            ${specSubLine}
                        </td>
                        <td width="86" align="center" valign="middle" style="padding:10px 8px; border-bottom:1px solid #e2e8f0; font-weight:bold; color:#0f172a; font-size:13px; white-space:nowrap;">${it.qty} ${escHtml(unitStr)}</td>
                        <td width="98" align="center" valign="middle" style="padding:10px 8px; border-bottom:1px solid #e2e8f0; font-size:12px; color:${hasInlinePhoto ? '#059669' : '#94a3b8'}; font-weight:bold; white-space:nowrap;">
                            ${hasInlinePhoto ? `📷 ${lang === 'EN' ? 'Photo' : 'Foto'} #${itemLabelNum}` : '—'}
                        </td>
                    </tr>
                `);

                plainTextItemsLines.push(`${itemLabelNum}) ${cleanPartCode ? '[' + cleanPartCode + '] ' : ''}${displayPartTitle} — Qty: ${it.qty} ${unitStr}${grp.vendorModel ? ' (Model: ' + grp.vendorModel + ')' : ''}`);

                if (!diskPath) continue;

                photoCounter++;
                const safeCodeSlug = String(cleanPartCode || `Item_${itemLabelNum.replace('.', '_')}`).replace(/[^a-zA-Z0-9\-_]/g, '_').slice(0, 26);
                const attachFilename = isMultiMachine
                    ? `M${gIdx + 1}_${safeMachineSlug}_Item_${itemLabelNum}_${safeCodeSlug}${ext}`
                    : `Part_${itemLabelNum}_${safeCodeSlug}${ext}`;
                const cidKey = `tecfag_part_photo_${gIdx + 1}_${i + 1}_${Date.now()}`;

                if (hasInlinePhoto) {
                    const imgWidth = computeEmailImageWidth(diskPath);
                    mailAttachments.push({
                        filename: attachFilename,
                        path: diskPath,
                        cid: cidKey,
                        contentDisposition: 'inline'
                    });
                    grpPhotoCards.push(`
                        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse; border:1px solid #cbd5e1; margin-bottom:14px; background-color:#ffffff;">
                            <tr bgcolor="#f1f5f9" style="background-color:#f1f5f9;">
                                <td style="padding:9px 14px; border-bottom:1px solid #cbd5e1; font-family:Arial,Helvetica,sans-serif; font-size:13px; color:#0f172a;">
                                    <strong>📷 ${lang === 'EN' ? 'Photo' : 'Foto'} #${itemLabelNum} — ${escHtml(displayPartTitle)}</strong>
                                    &nbsp;|&nbsp; <strong>${lang === 'EN' ? 'Qty' : 'Qtd'}:</strong> ${it.qty} ${escHtml(unitStr)}
                                    ${cleanPartCode ? ` &nbsp;|&nbsp; <strong>Code:</strong> <span style="color:#0284c7;">${escHtml(cleanPartCode)}</span>` : ''}
                                    ${grp.vendorModel ? ` &nbsp;|&nbsp; <span style="color:#475569;">${lang === 'EN' ? 'Machine' : 'Máq.'}: <strong>${escHtml(grp.vendorModel)}</strong></span>` : ''}
                                </td>
                            </tr>
                            <tr>
                                <td align="center" bgcolor="#f8fafc" style="background-color:#f8fafc; padding:14px;">
                                    <img src="cid:${cidKey}" alt="${escHtml(attachFilename)}" width="${imgWidth}" style="display:block; width:${imgWidth}px; max-width:100%; height:auto; border:1px solid #cbd5e1; border-radius:6px;" />
                                </td>
                            </tr>
                        </table>
                    `);
                } else {
                    mailAttachments.push({
                        filename: attachFilename,
                        path: diskPath
                    });
                }
            }

            if (grpPhotoCards.length > 0) {
                if (isMultiMachine) {
                    groupedPhotosSectionsHtml.push(`
                        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse; border:2px solid #bae6fd; margin-bottom:18px; background-color:#ffffff;">
                            <tr bgcolor="#0284c7" style="background-color:#0284c7;">
                                <td style="padding:9px 14px; color:#ffffff; font-family:Arial,Helvetica,sans-serif; font-weight:bold; font-size:13px;">
                                    🏭 ${lang === 'EN' ? `MACHINE ${gIdx + 1} — Original Model:` : `MÁQUINA ${gIdx + 1} — Modelo Ref.:`} ${escHtml(grp.vendorModel || 'N/A')}
                                    ${grp.serial ? ` &nbsp;|&nbsp; Serial: ${escHtml(grp.serial)}` : ''}
                                </td>
                            </tr>
                            <tr>
                                <td style="padding:12px 12px 2px 12px;">
                                    ${grpPhotoCards.join('\n')}
                                </td>
                            </tr>
                        </table>
                    `);
                } else {
                    groupedPhotosSectionsHtml.push(grpPhotoCards.join('\n'));
                }
            }
        }

        // Arquivos/Fotos extras enviados diretamente no modal de e-mail
        if (Array.isArray(req.files) && req.files.length > 0) {
            for (let k = 0; k < req.files.length; k++) {
                const f = req.files[k];
                photoCounter++;
                const ext = path.extname(f.originalname || f.filename || '.jpg').toLowerCase();
                const isImage = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext);
                const cidExtra = `tecfag_extra_photo_${k + 1}_${Date.now()}`;

                if (isImage && items[0] && !items[0].photo_path) {
                    const relUrl = `/uploads_pecas/${f.filename}`;
                    items[0].photo_path = relUrl;
                    await pRun('UPDATE parts_request_items SET photo_path = ? WHERE id = ?', [relUrl, items[0].id]).catch(() => {});
                }

                if (isImage) {
                    const extraWidth = computeEmailImageWidth(f.path);
                    mailAttachments.push({
                        filename: f.originalname || `Photo_${k + 1}${ext}`,
                        path: f.path,
                        cid: cidExtra,
                        contentDisposition: 'inline'
                    });
                    groupedPhotosSectionsHtml.push(`
                        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse; border:1px solid #cbd5e1; margin-bottom:14px; background-color:#ffffff;">
                            <tr bgcolor="#f1f5f9" style="background-color:#f1f5f9;">
                                <td style="padding:9px 14px; border-bottom:1px solid #cbd5e1; font-family:Arial,Helvetica,sans-serif; font-size:13px; font-weight:bold; color:#0f172a;">
                                    📎 ${escHtml(f.originalname || `Reference Photo #${k + 1}`)}
                                </td>
                            </tr>
                            <tr>
                                <td align="center" bgcolor="#f8fafc" style="background-color:#f8fafc; padding:14px;">
                                    <img src="cid:${cidExtra}" alt="${escHtml(f.originalname || 'Photo')}" width="${extraWidth}" style="display:block; width:${extraWidth}px; max-width:100%; height:auto; border:1px solid #cbd5e1; border-radius:6px;" />
                                </td>
                            </tr>
                        </table>
                    `);
                } else {
                    mailAttachments.push({
                        filename: f.originalname || f.filename,
                        path: f.path
                    });
                }
            }
        }

        const hasSignatureImg = fs.existsSync(SIGNATURE_IMG_PATH);
        if (hasSignatureImg) {
            mailAttachments.push({
                filename: 'assinatura_tecfag.png',
                path: SIGNATURE_IMG_PATH,
                cid: 'tecfag_signature_banner',
                contentDisposition: 'inline'
            });
        }

        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT) || 587,
            secure: process.env.SMTP_SECURE === 'true',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            },
            tls: {
                rejectUnauthorized: false
            }
        });

        const senderDisplay = getFriendlyUserName(req.user.username);

        // Converte quebras de linha reais em <br> (100% compatível com Outlook Desktop e Foxmail!) e remove linhas tracejadas antigas caso coladas
        const cleanedBodyLines = String(body || '')
            .split(/\r?\n/)
            .filter(line => !/^[-=_]{6,}$/.test(line.trim()));
        const safeBodyHtml = cleanedBodyLines
            .map(line => escHtml(line))
            .join('<br>\n');

        const photosHeaderTitle = lang === 'EN'
            ? (isMultiMachine ? '📷 Reference Photo(s) Organized by Machine:' : '📷 Reference Photo(s) of Requested Part(s):')
            : (isMultiMachine ? '📷 Foto(s) das Peças Organizadas por Máquina:' : '📷 Foto(s) de Referência da(s) Peça(s):');

        const distinctModelList = machineGroups.map(g => g.vendorModel).filter(Boolean);
        const headerDeptLabel = lang === 'EN'
            ? 'GRUPO TECFAG • INTERNATIONAL PURCHASING &amp; SPARE PARTS'
            : 'GRUPO TECFAG • COMPRAS &amp; PEÇAS DE REPOSIÇÃO';
        const headerDocTitle = lang === 'EN'
            ? `Request for Quotation (RFQ) — Ref. ${escHtml(r.req_code)}`
            : `Solicitação de Cotação de Peças — Protocolo ${escHtml(r.req_code)}`;

        const headerContentHtml = hasHeaderLogo ? `
            <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;">
                <tr>
                    <td width="178" valign="middle" style="padding-right:16px; border-right:1px solid #334155;">
                        <img src="cid:tecfag_header_logo" alt="Grupo Tecfag" width="166" height="40" style="display:block; width:166px; height:40px; border:0; outline:none; text-decoration:none;" />
                    </td>
                    <td valign="middle" style="padding-left:16px; font-family:Arial,Helvetica,sans-serif;">
                        <div style="font-size:11px; font-weight:bold; color:#38bdf8; letter-spacing:0.8px; text-transform:uppercase;">${headerDeptLabel}</div>
                        <div style="margin-top:4px; font-size:18px; font-weight:bold; color:#ffffff; line-height:1.25;">${headerDocTitle}</div>
                    </td>
                </tr>
            </table>
        ` : `
            <div style="font-family:Arial,Helvetica,sans-serif;">
                <div style="font-size:11px; font-weight:bold; color:#38bdf8; letter-spacing:0.8px; text-transform:uppercase;">${headerDeptLabel}</div>
                <div style="margin-top:4px; font-size:18px; font-weight:bold; color:#ffffff;">${headerDocTitle}</div>
            </div>
        `;

        const topModelBannerHtml = distinctModelList.length > 0 ? `
            <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse; margin-bottom:18px;">
                <tr>
                    <td bgcolor="#f1f5f9" style="background-color:#f1f5f9; border-left:4px solid #0284c7; padding:11px 15px; font-family:Arial,Helvetica,sans-serif; font-size:13px; color:#0f172a; line-height:1.5;">
                        <strong>🏭 ${lang === 'EN' ? (distinctModelList.length > 1 ? 'Machine Models' : 'Machine Original Model') : (distinctModelList.length > 1 ? 'Modelos de Referência' : 'Modelo de Referência')}:</strong>
                        <span style="color:#0284c7; font-weight:bold; font-size:15px;">${distinctModelList.map(m => escHtml(m)).join(' &nbsp;•&nbsp; ')}</span>
                        ${(!isMultiMachine && machineGroups[0] && machineGroups[0].serial) ? ` &nbsp;|&nbsp; <strong>Serial No.:</strong> ${escHtml(machineGroups[0].serial)}` : ''}
                        &nbsp;|&nbsp; <strong>Ref.:</strong> ${escHtml(r.req_code)}
                    </td>
                </tr>
            </table>
        ` : '';

        const replyChecklistHtml = lang === 'EN' ? `
            <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse; margin-top:16px; margin-bottom:18px;">
                <tr>
                    <td bgcolor="#fffbeb" style="background-color:#fffbeb; border:1px solid #fde68a; border-left:4px solid #f59e0b; padding:11px 15px; font-family:Arial,Helvetica,sans-serif; font-size:13px; color:#78350f; line-height:1.5;">
                        <strong>✅ Please include in your quotation reply:</strong><br>
                        1) <strong>Unit FOB Price (USD)</strong> &nbsp;•&nbsp; 2) <strong>Stock / Production Lead Time</strong> &nbsp;•&nbsp; 3) <strong>Packing Gross Weight &amp; Dimensions</strong> (for DHL/FedEx courier)
                    </td>
                </tr>
            </table>
        ` : `
            <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse; margin-top:16px; margin-bottom:18px;">
                <tr>
                    <td bgcolor="#fffbeb" style="background-color:#fffbeb; border:1px solid #fde68a; border-left:4px solid #f59e0b; padding:11px 15px; font-family:Arial,Helvetica,sans-serif; font-size:13px; color:#78350f; line-height:1.5;">
                        <strong>✅ Favor informar no retorno desta cotação:</strong><br>
                        1) <strong>Valor Unitário (R$) e Impostos</strong> &nbsp;•&nbsp; 2) <strong>Prazo de Entrega / Fabricação</strong> &nbsp;•&nbsp; 3) <strong>Condição de Pagamento / Frete</strong>
                    </td>
                </tr>
            </table>
        `;

        const htmlEmail = `
            <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" bgcolor="#f1f5f9" style="background-color:#f1f5f9; border-collapse:collapse; width:100%;">
                <tr>
                    <td align="center" style="padding:20px 12px;">
                        <table width="680" cellpadding="0" cellspacing="0" border="0" role="presentation" bgcolor="#ffffff" style="width:680px; max-width:680px; background-color:#ffffff; border-collapse:collapse; border:1px solid #cbd5e1;">
                            <!-- CABEÇALHO ESCURO GRUPO TECFAG -->
                            <tr>
                                <td bgcolor="#0b0f19" style="background-color:#0b0f19; padding:18px 24px; border-bottom:4px solid #0284c7;">
                                    ${headerContentHtml}
                                </td>
                            </tr>

                            <!-- CORPO PRINCIPAL -->
                            <tr>
                                <td style="padding:22px 24px; font-family:Arial,Helvetica,sans-serif; font-size:14px; line-height:1.6; color:#1e293b;">
                                    ${safeBodyHtml ? `<div style="margin-bottom:18px; font-size:14px; line-height:1.65; color:#1e293b;">${safeBodyHtml}</div>` : ''}

                                    ${topModelBannerHtml}

                                    <!-- TABELA ESTRUTURADA DE PEÇAS -->
                                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; border:1px solid #cbd5e1; font-family:Arial,Helvetica,sans-serif; margin-bottom:16px;">
                                        <thead>
                                            <tr bgcolor="#0f172a" style="background-color:#0f172a; color:#ffffff;">
                                                <th width="52" align="center" style="padding:9px 8px; font-size:12px; color:#ffffff; text-transform:uppercase;">${lang === 'EN' ? 'Item' : 'Item'}</th>
                                                <th width="115" align="left" style="padding:9px 10px; font-size:12px; color:#ffffff; text-transform:uppercase;">${lang === 'EN' ? 'Machine' : 'Máquina'}</th>
                                                <th align="left" style="padding:9px 12px; font-size:12px; color:#ffffff; text-transform:uppercase;">${lang === 'EN' ? 'Part Description' : 'Descrição da Peça'}</th>
                                                <th width="86" align="center" style="padding:9px 8px; font-size:12px; color:#ffffff; text-transform:uppercase;">${lang === 'EN' ? 'Qty' : 'Qtd'}</th>
                                                <th width="98" align="center" style="padding:9px 8px; font-size:12px; color:#ffffff; text-transform:uppercase;">${lang === 'EN' ? 'Photo' : 'Foto'}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            ${partsTableRowsHtml.join('\n')}
                                        </tbody>
                                    </table>

                                    ${replyChecklistHtml}

                                    ${groupedPhotosSectionsHtml.length > 0 ? `
                                        <div style="margin-top:18px; padding-top:14px; border-top:2px solid #e2e8f0;">
                                            <div style="font-size:14px; font-weight:bold; color:#0f172a; margin-bottom:12px;">${photosHeaderTitle}</div>
                                            ${groupedPhotosSectionsHtml.join('\n')}
                                        </div>
                                    ` : ''}

                                    <!-- ASSINATURA / RODAPÉ -->
                                    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse; margin-top:20px; border-top:1px solid #e2e8f0;">
                                        <tr>
                                            <td style="padding-top:16px;">
                                                ${hasSignatureImg ? `
                                                    <img src="cid:tecfag_signature_banner" alt="Grupo Tecfag" width="620" style="display:block; width:620px; max-width:100%; height:auto; border:0;" />
                                                ` : `
                                                    <div style="font-size:13px; color:#334155;">
                                                        <strong style="color:#b91c1c;">GRUPO TECFAG — AUTOMAÇÃO &amp; EQUIPAMENTOS INDUSTRIAIS</strong><br>
                                                        Tel: +55 (14) 3161-5000 | www.tecfag.com.br
                                                    </div>
                                                `}
                                                <div style="font-size:11px; color:#64748b; margin-top:8px;">
                                                    Ref.: <strong>${escHtml(r.req_code)}</strong> &nbsp;|&nbsp; ${lang === 'EN' ? 'Sent by' : 'Enviado por'} ${escHtml(senderDisplay)}
                                                </div>
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        `;

        const plainTextFallback = [
            String(body || '').trim(),
            '',
            `${lang === 'EN' ? 'Reference' : 'Referência'}: ${r.req_code}`,
            ...plainTextItemsLines
        ].join('\n');

        await transporter.sendMail({
            from: process.env.EMAIL_FROM || `"Tecfag Spare Parts / Compras" <${process.env.SMTP_USER}>`,
            to: String(to).trim(),
            cc: cc && String(cc).trim() ? String(cc).trim() : undefined,
            subject: String(subject).trim(),
            text: plainTextFallback,
            html: htmlEmail,
            attachments: mailAttachments
        });

        await addTimelineEntry(
            reqId,
            req.user,
            'EMAIL_SENT',
            `📧 E-mail de cotação disparado para "${to}" (${items.length} item/itens | Modelo(s): ${distinctModelList.join(', ') || 'N/A'}) com ${photoCounter} foto(s)/anexo(s) agrupados por máquina!`
        );

        res.json({
            success: true,
            photos_sent: photoCounter,
            message: `E-mail enviado com sucesso para ${to} (${items.length} peça(s), ${photoCounter} foto(s) incluída(s))!`
        });
    }));

    // 19. Configuração Opcional de Conta de E-mail Própria do Vendedor (ex: vendas18@tecfag.com.br)
    router.get('/my-smtp', authenticateToken, asyncSafe(async (req, res) => {
        const officialEmail = resolveOfficialUserEmail(req.user.username);
        const row = await pGet(
            'SELECT email_address, smtp_host, smtp_port, smtp_secure, sender_display_name, updated_at FROM parts_user_smtp WHERE LOWER(username) = LOWER(?) OR LOWER(email_address) = LOWER(?)',
            [req.user.username, officialEmail]
        );
        res.json({
            configured: !!row,
            default_email: officialEmail,
            default_host: (process.env.SMTP_HOST && process.env.SMTP_HOST !== 'smtp.exemplo.com') ? process.env.SMTP_HOST : '',
            default_port: parseInt(process.env.SMTP_PORT) || 587,
            config: row || null
        });
    }));

    router.post('/my-smtp', authenticateToken, asyncSafe(async (req, res) => {
        const { email_address, smtp_pass, smtp_host, smtp_port = 587, smtp_secure = false, sender_display_name = '' } = req.body || {};
        const cleanEmail = String(email_address || '').trim().toLowerCase();
        if (!cleanEmail || !cleanEmail.includes('@')) {
            return res.status(400).json({ error: 'Informe um endereço de e-mail válido (ex: vendas18@tecfag.com.br).' });
        }
        if (!smtp_pass || !String(smtp_pass).trim()) {
            return res.status(400).json({ error: 'Informe a senha do seu e-mail corporativo.' });
        }
        const hostToUse = String(smtp_host || process.env.SMTP_HOST || '').trim();
        if (!hostToUse || hostToUse === 'smtp.exemplo.com') {
            return res.status(400).json({ error: 'Informe o servidor SMTP (ex: smtp.tecfag.com.br / email-ssl.com.br / smtp.gmail.com).' });
        }
        const portNum = parseInt(smtp_port) || 587;
        const isSecure = smtp_secure === true || smtp_secure === 'true' || portNum === 465;

        // Testa conexão SMTP na hora para garantir que a senha do e-mail está correta!
        const testTransport = nodemailer.createTransport({
            host: hostToUse,
            port: portNum,
            secure: isSecure,
            auth: { user: cleanEmail, pass: String(smtp_pass) },
            tls: { rejectUnauthorized: false }
        });
        await testTransport.verify();

        const encPass = encryptSecret(String(smtp_pass));
        const now = new Date().toISOString();
        await pRun(
            `INSERT OR REPLACE INTO parts_user_smtp (
                username, email_address, smtp_host, smtp_port, smtp_secure, smtp_pass_enc, sender_display_name, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                req.user.username.toLowerCase(),
                cleanEmail,
                hostToUse,
                portNum,
                isSecure ? 1 : 0,
                encPass,
                sender_display_name || getFriendlyUserName(req.user.username),
                now
            ]
        );
        res.json({ success: true, message: `Conta ${cleanEmail} conectada e verificada com sucesso! Seus orçamentos sairão diretamente pelo seu próprio e-mail.` });
    }));

    router.delete('/my-smtp', authenticateToken, asyncSafe(async (req, res) => {
        const officialEmail = resolveOfficialUserEmail(req.user.username);
        await pRun('DELETE FROM parts_user_smtp WHERE LOWER(username) = LOWER(?) OR LOWER(email_address) = LOWER(?)', [
            req.user.username, officialEmail
        ]);
        res.json({ success: true });
    }));

    // 20. Envio Direto da Proposta Comercial ao Cliente (com Resposta Direcionada + Cópia Automática para Guilherme Bertola!)
    router.post('/requests/:id/send-client-proposal', authenticateToken, asyncSafe(async (req, res) => {
        const reqId = parseInt(req.params.id);
        const r = await pGet('SELECT * FROM parts_requests WHERE id = ?', [reqId]);
        if (!r) return res.status(404).json({ error: 'Solicitação não encontrada.' });

        const stagePerm = await canUserActOnStage(req.user, r.stage);
        if (!stagePerm.allowed) {
            return res.status(403).json({
                error: `🔒 Apenas o responsável da etapa atual (${stagePerm.ownerDisplay}) pode enviar a proposta comercial ao cliente.`
            });
        }

        const rawItems = await pAll('SELECT * FROM parts_request_items WHERE request_id = ? ORDER BY id ASC', [reqId]);
        const items = rawItems.map(it => enrichItemMachineFields(it, r));
        if (items.length === 0) {
            return res.status(400).json({ error: 'Nenhuma peça vinculada a esta solicitação.' });
        }

        const {
            to = '',
            cc = '',
            subject = '',
            custom_message = '',
            include_photos = true
        } = req.body || {};

        const targetClientEmail = String(to || r.client_email || '').trim();
        if (!targetClientEmail || !targetClientEmail.includes('@')) {
            return res.status(400).json({ error: 'Informe o e-mail do cliente para enviar a proposta comercial.' });
        }

        const now = new Date().toISOString();
        const guilhermeEmail = 'vendas18@tecfag.com.br';
        const loggedUserEmail = resolveOfficialUserEmail(req.user.username);
        const requesterOfficialEmail = (r.requester_username && isPartsRequesterTeamUser(r.requester_username))
            ? resolveOfficialUserEmail(r.requester_username)
            : guilhermeEmail;

        // Se quem dispara é da equipe de Peças/Vendas (Guilherme, Raiane, Maria Vitória, Keicy), a resposta vai p/ o próprio e-mail dela/dele;
        // Se quem dispara é Compras/Admin (ex: botão rápido da Etapa 2), vai p/ o e-mail de quem abriu a solicitação!
        const primaryOwnerEmail = (isPartsRequesterTeamUser(req.user) || req.user.role === 'VENDAS')
            ? loggedUserEmail
            : requesterOfficialEmail;
        const primaryOwnerDisplay = getProposalConsultantDisplay(primaryOwnerEmail);

        const ccSet = new Set();
        ccSet.add(primaryOwnerEmail.toLowerCase());
        if (requesterOfficialEmail && requesterOfficialEmail.includes('@')) {
            ccSet.add(requesterOfficialEmail.toLowerCase());
        }
        if (loggedUserEmail && loggedUserEmail.includes('@')) {
            ccSet.add(loggedUserEmail.toLowerCase());
        }
        if (cc && String(cc).trim()) {
            String(cc).split(/[,;]+/).map(s => s.trim().toLowerCase()).filter(s => s.includes('@')).forEach(s => ccSet.add(s));
        }
        ccSet.delete(targetClientEmail.toLowerCase());
        const finalCcString = Array.from(ccSet).join(', ');

        const personalSmtp = await pGet(
            'SELECT * FROM parts_user_smtp WHERE LOWER(username) = LOWER(?) OR LOWER(email_address) = LOWER(?)',
            [req.user.username, primaryOwnerEmail]
        ).catch(() => null);

        let transporter = null;
        let fromHeader = '';
        let sentViaPersonalMailbox = false;

        if (personalSmtp && personalSmtp.smtp_pass_enc) {
            try {
                const decPass = decryptSecret(personalSmtp.smtp_pass_enc);
                transporter = nodemailer.createTransport({
                    host: personalSmtp.smtp_host,
                    port: parseInt(personalSmtp.smtp_port) || 587,
                    secure: personalSmtp.smtp_secure === 1,
                    auth: { user: personalSmtp.email_address, pass: decPass },
                    tls: { rejectUnauthorized: false }
                });
                fromHeader = `"${personalSmtp.sender_display_name || primaryOwnerDisplay}" <${personalSmtp.email_address}>`;
                sentViaPersonalMailbox = true;
            } catch (e) {
                transporter = null;
            }
        }

        if (!transporter) {
            if (!process.env.SMTP_HOST || !process.env.SMTP_USER || process.env.SMTP_HOST === 'smtp.exemplo.com') {
                return res.status(500).json({
                    error: 'Servidor SMTP geral não configurado neste ambiente, ou clique em "🔑 Conectar Meu E-mail" para cadastrar a senha do seu próprio e-mail @tecfag.com.br.'
                });
            }
            transporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST,
                port: parseInt(process.env.SMTP_PORT) || 587,
                secure: process.env.SMTP_SECURE === 'true',
                auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
                tls: { rejectUnauthorized: false }
            });
            fromHeader = `"${primaryOwnerDisplay}" <${process.env.SMTP_USER}>`;
        }

        const mailAttachments = [];
        const inlinePhotosHtml = [];
        if (include_photos !== false && include_photos !== 'false') {
            for (let i = 0; i < items.length; i++) {
                const it = items[i];
                if (!it.photo_path) continue;
                const fname = path.basename(String(it.photo_path));
                const diskPath = path.join(PARTS_UPLOADS_DIR, fname);
                if (fs.existsSync(diskPath)) {
                    const ext = path.extname(diskPath).toLowerCase() || '.jpg';
                    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
                        const cid = `client_prop_part_${i + 1}_${Date.now()}`;
                        mailAttachments.push({
                            filename: `Peca_${i + 1}_${it.erp_sku || it.temp_sku}${ext}`,
                            path: diskPath,
                            cid,
                            contentDisposition: 'inline'
                        });
                        const mTag = it.effective_machine_sku || it.effective_machine_name
                            ? `<div style="font-size:11px; color:#64748b; margin-bottom:4px;">🏭 ${it.effective_machine_sku || ''} ${it.effective_machine_name || ''}</div>`
                            : '';
                        inlinePhotosHtml.push(`
                            <div style="display:inline-block; vertical-align:top; width:240px; margin:0 12px 12px 0; border:1px solid #cbd5e1; border-radius:8px; padding:10px; background:#f8fafc;">
                                <div style="font-size:12px; font-weight:bold; color:#0f172a; margin-bottom:2px;">Item #${i + 1}: ${it.part_name_pt}</div>
                                ${mTag}
                                <img src="cid:${cid}" alt="Peça ${i + 1}" style="width:100%; height:150px; object-fit:cover; border-radius:6px; border:1px solid #e2e8f0;" />
                            </div>
                        `);
                    }
                }
            }
        }

        const hasHeaderLogo = fs.existsSync(HEADER_LOGO_IMG_PATH);
        if (hasHeaderLogo) {
            mailAttachments.push({
                filename: 'logo_tecfag.png',
                path: HEADER_LOGO_IMG_PATH,
                cid: 'tecfag_header_logo',
                contentDisposition: 'inline'
            });
        }

        const hasSignatureImg = fs.existsSync(SIGNATURE_IMG_PATH);
        if (hasSignatureImg) {
            mailAttachments.push({
                filename: 'assinatura_tecfag.png',
                path: SIGNATURE_IMG_PATH,
                cid: 'tecfag_signature_banner',
                contentDisposition: 'inline'
            });
        }

        let grandTotal = 0;
        const rowsHtml = items.map((it) => {
            const unitBrl = parseFloat(it.final_unit_price_brl) || 0;
            const qty = parseFloat(it.qty) || 1;
            const subBrl = +(unitBrl * qty).toFixed(2);
            grandTotal += subBrl;
            const itemMachDiff = (it.effective_machine_sku && it.effective_machine_sku !== r.machine_sku) ||
                (it.effective_machine_name && it.effective_machine_name !== r.machine_name);
            const itemMachSub = itemMachDiff
                ? `<div style="font-size:11px; font-weight:normal; color:#475569; margin-top:2px;">🏭 Equipamento: ${it.effective_machine_sku || ''} ${it.effective_machine_name || ''}</div>`
                : '';
            return `
                <tr>
                    <td style="padding:10px 12px; border-bottom:1px solid #e2e8f0; font-family:monospace; font-weight:bold; color:#0369a1;">${it.erp_sku || it.temp_sku}</td>
                    <td style="padding:10px 12px; border-bottom:1px solid #e2e8f0; font-weight:bold; color:#0f172a;">${it.part_name_pt}${itemMachSub}</td>
                    <td style="padding:10px 12px; border-bottom:1px solid #e2e8f0; text-align:center;">${qty} ${it.unit || 'UN'}</td>
                    <td style="padding:10px 12px; border-bottom:1px solid #e2e8f0; text-align:center;">${it.promised_lead_days || 15} dias úteis</td>
                    <td style="padding:10px 12px; border-bottom:1px solid #e2e8f0; text-align:right;">R$ ${unitBrl.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td style="padding:10px 12px; border-bottom:1px solid #e2e8f0; text-align:right; font-weight:bold; color:#0f172a;">R$ ${subBrl.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                </tr>
            `;
        }).join('');

        const finalSubject = String(subject || '').trim() ||
            `Proposta Comercial de Peças Tecfag — ${r.req_code} (${r.client_name})`;

        const introText = String(custom_message || '').trim() ||
            `Olá${r.client_contact ? ' ' + r.client_contact : ''}! Conforme solicitado, apresentamos abaixo nossa proposta comercial para fornecimento de peça(s) de reposição originais/homologadas Grupo Tecfag:`;

        const headerContentHtml = hasHeaderLogo ? `
            <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse: collapse;">
                <tr>
                    <td width="182" valign="middle" style="padding-right: 18px; border-right: 1px solid #334155;">
                        <img src="cid:tecfag_header_logo" alt="Grupo Tecfag" width="172" height="41" style="display: block; width: 172px; height: 41px; border: 0; outline: none; text-decoration: none;" />
                    </td>
                    <td valign="middle" style="padding-left: 18px;">
                        <div style="font-size: 11px; font-weight: bold; color: #38bdf8; letter-spacing: 1px; text-transform: uppercase;">GRUPO TECFAG • PÓS-VENDA &amp; PEÇAS DE REPOSIÇÃO</div>
                        <h2 style="margin: 4px 0 0; font-size: 19px; color: #ffffff; line-height: 1.25;">Proposta Comercial — Protocolo ${r.req_code}</h2>
                    </td>
                </tr>
            </table>
        ` : `
            <div style="font-size: 11px; font-weight: bold; color: #38bdf8; letter-spacing: 1px; text-transform: uppercase;">GRUPO TECFAG • PÓS-VENDA &amp; PEÇAS DE REPOSIÇÃO</div>
            <h2 style="margin: 4px 0 0; font-size: 19px; color: #ffffff;">Proposta Comercial — Protocolo ${r.req_code}</h2>
        `;

        const htmlProposal = `
            <div style="font-family: Arial, Helvetica, sans-serif; color: #1e293b; background-color: #f8fafc; padding: 20px;">
                <div style="max-width: 720px; margin: 0 auto; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 12px; overflow: hidden;">
                    <div style="background-color: #0b0f19; background: linear-gradient(135deg, #0b0f19, #1e293b); color: #ffffff; padding: 20px 26px; border-bottom: 4px solid #0ea5e9;">
                        ${headerContentHtml}
                    </div>

                    <div style="padding: 24px 26px;">
                        <p style="font-size: 14px; line-height: 1.6; margin-bottom: 16px; white-space: pre-wrap;">${introText}</p>

                        <div style="background: #f1f5f9; border-radius: 8px; padding: 12px 16px; margin-bottom: 18px; font-size: 13px; line-height: 1.5;">
                            <strong>🏢 Cliente:</strong> ${r.client_name} ${r.client_cnpj ? `(${r.client_cnpj})` : ''}<br>
                            ${(r.machine_sku || r.machine_name) ? `<strong>🏭 Equipamento Vinculado:</strong> ${r.machine_sku || ''} ${r.machine_name || ''}${r.machine_serial ? ` (Série: ${r.machine_serial})` : ''}<br>` : ''}
                            <strong>👤 Consultor Responsável:</strong> ${primaryOwnerDisplay} (<a href="mailto:${primaryOwnerEmail}" style="color:#0284c7; text-decoration:none; font-weight:bold;">${primaryOwnerEmail}</a>)
                        </div>

                        <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 18px;">
                            <thead>
                                <tr style="background: #0f172a; color: #ffffff; text-align: left;">
                                    <th style="padding: 9px 12px;">Código</th>
                                    <th style="padding: 9px 12px;">Descrição da Peça</th>
                                    <th style="padding: 9px 12px; text-align:center;">Qtd</th>
                                    <th style="padding: 9px 12px; text-align:center;">Prazo Est.</th>
                                    <th style="padding: 9px 12px; text-align:right;">Vlr. Unit.</th>
                                    <th style="padding: 9px 12px; text-align:right;">Subtotal</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${rowsHtml}
                            </tbody>
                            <tfoot>
                                <tr style="background: #ecfdf5;">
                                    <td colspan="5" style="padding: 12px; text-align: right; font-weight: bold; font-size: 14px; color: #065f46;">VALOR TOTAL DO ORÇAMENTO:</td>
                                    <td style="padding: 12px; text-align: right; font-weight: bold; font-size: 16px; color: #059669;">R$ ${grandTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                </tr>
                            </tfoot>
                        </table>

                        <div style="font-size: 13px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 12px 16px; margin-bottom: 18px; color: #78350f;">
                            <strong>📅 Validade da Proposta:</strong> ${r.proposal_validity_days || 7} dias corridos<br>
                            <strong>💳 Condição de Pagamento:</strong> ${r.payment_terms_client || 'À vista / 28 DDL mediante aprovação cadastral'}
                        </div>

                        ${inlinePhotosHtml.length > 0 ? `
                            <div style="margin-top: 16px; margin-bottom: 18px;">
                                <div style="font-size: 13px; font-weight: bold; color: #334155; margin-bottom: 8px;">📷 Foto(s) de Referência Técnica da(s) Peça(s):</div>
                                ${inlinePhotosHtml.join('')}
                            </div>
                        ` : ''}

                        <div style="background: #e0f2fe; border-left: 4px solid #0284c7; padding: 12px 16px; border-radius: 6px; font-size: 13px; color: #0c4a6e; margin-bottom: 20px;">
                            ✅ <strong>Como aprovar este orçamento:</strong> Basta responder diretamente a este e-mail confirmando a aprovação (sua resposta irá direto para <strong>${primaryOwnerEmail}</strong>).
                        </div>

                        <div style="padding-top: 14px; border-top: 1px solid #e2e8f0;">
                            ${hasSignatureImg ? `<img src="cid:tecfag_signature_banner" alt="Grupo Tecfag" style="max-width: 620px; width: 100%; height: auto; display: block;" />` : ''}
                        </div>
                    </div>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: fromHeader,
            replyTo: `"${primaryOwnerDisplay}" <${primaryOwnerEmail}>`,
            to: targetClientEmail,
            cc: finalCcString || undefined,
            subject: finalSubject,
            text: `${introText}\n\nValor Total: R$ ${grandTotal.toFixed(2)}\nResponda a este e-mail (${primaryOwnerEmail}) para aprovar o pedido.`,
            html: htmlProposal,
            attachments: mailAttachments
        });

        // Atualizar e-mail do cliente no card + marcar proposta enviada + garantir etapa 3_PROPOSTA_CLIENTE se estava na 2
        const nextStage = r.stage === '2_COTACAO_FORNECEDOR' ? '3_PROPOSTA_CLIENTE' : r.stage;
        await pRun(
            `UPDATE parts_requests SET
                client_email = ?,
                proposal_sent_at = ?,
                stage = ?,
                updated_at = ?
             WHERE id = ?`,
            [targetClientEmail, now, nextStage, now, reqId]
        );

        await addTimelineEntry(
            reqId,
            req.user,
            'CLIENT_PROPOSAL_SENT',
            `📧 Proposta Comercial (R$ ${grandTotal.toFixed(2)}) enviada direto para o cliente (${targetClientEmail}) | Resposta direcionada p/ ${primaryOwnerEmail}${finalCcString ? ` | Cópia: ${finalCcString}` : ''}${sentViaPersonalMailbox ? ' [Via caixa própria]' : ''}!`
        );

        res.json({
            success: true,
            sent_to: targetClientEmail,
            reply_to: primaryOwnerEmail,
            cc: finalCcString,
            via_personal_smtp: sentViaPersonalMailbox,
            message: `Proposta enviada com sucesso para ${targetClientEmail} (com cópia e resposta direcionadas para ${primaryOwnerEmail})!`
        });
    }));

    app.use('/api/parts', router);

    app.use('/api/parts', (err, req, res, next) => {
        if (err instanceof multer.MulterError) {
            return res.status(413).json({ error: 'Arquivo muito grande (máx 8 MB).' });
        }
        if (err) {
            console.error('[PEÇAS ROUTER ERROR]:', err);
            return res.status(500).json({ error: err.message || 'Erro interno no módulo de peças.' });
        }
        next();
    });
};
