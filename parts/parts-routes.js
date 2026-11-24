const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const nodemailer = require('nodemailer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
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
                FOREIGN KEY(request_id) REFERENCES parts_requests(id) ON DELETE CASCADE
            )`);
            partsDb.run(`CREATE INDEX IF NOT EXISTS idx_parts_items_req ON parts_request_items(request_id)`);
            partsDb.run(`CREATE INDEX IF NOT EXISTS idx_parts_items_erpreg ON parts_request_items(erp_registered)`);

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
        });

        // Garantir cadastro seguro de Guilherme Bertola (vendas18 / vendas18@tecfag.com.br) na tabela users do MRP sem sobrescrever senhas existentes
        if (mrpDb && typeof hashPassword === 'function') {
            const bertolaAccounts = [
                { username: 'vendas18@tecfag.com.br', email: 'vendas18@tecfag.com.br', role: 'VENDAS' },
                { username: 'vendas18', email: 'vendas18@tecfag.com.br', role: 'VENDAS' }
            ];
            bertolaAccounts.forEach((acc) => {
                mrpDb.get('SELECT username FROM users WHERE LOWER(username) = LOWER(?)', [acc.username], (err, row) => {
                    if (!err && !row) {
                        const { salt, hash } = hashPassword('vend@tecfag18');
                        mrpDb.run(
                            'INSERT INTO users (username, password_hash, salt, role, email, must_change_password) VALUES (?, ?, ?, ?, ?, 0)',
                            [acc.username, hash, salt, acc.role, acc.email],
                            () => console.log(`[PEÇAS AUTH] Usuário "${acc.username}" (Guilherme Bertola) habilitado com sucesso.`)
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

    // 1. Dados do Usuário Logado + Câmbio Atual
    router.get('/me', authenticateToken, asyncSafe(async (req, res) => {
        const rates = await getLiveExchangeRates(false);
        res.json({
            user: {
                username: req.user.username,
                role: req.user.role,
                display_name: getFriendlyUserName(req.user.username),
                is_jhenifer: isJheniferUser(req.user),
                is_guilherme: isGuilhermeUser(req.user)
            },
            exchange: rates
        });
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

        let myBadge = counts.total_active;
        const role = String(req.user.role || '').toUpperCase();
        if (isJheniferUser(req.user)) {
            myBadge = counts.cadastro_erp + counts.cotacao;
        } else if (isGuilhermeUser(req.user) || role === 'VENDAS') {
            myBadge = counts.proposta + counts.doca;
        } else if (role === 'ENGENHARIA' || role === 'TECNICO') {
            myBadge = counts.triagem;
        } else if (role === 'COMPRAS') {
            myBadge = counts.cotacao + counts.cadastro_erp;
        } else if (role === 'ESTOQUE') {
            myBadge = counts.doca;
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

    // 8. Dashboard Completo (Kanban + Fila Jhenifer ERP + KPIs + Catálogo BOM)
    router.get('/dashboard', authenticateToken, asyncSafe(async (req, res) => {
        const rates = await getLiveExchangeRates(false);
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
            const items = itemsByReq[r.id] || [];
            const pendingErpCount = items.filter(i => !i.erp_registered && !i.erp_sku).length;
            const erpMachine = getErpSkuDetails(r.machine_sku);
            return {
                ...r,
                machine_vendor_model: r.machine_vendor_model || (erpMachine ? erpMachine.vendorCode : ''),
                machine_supplier_name: r.machine_supplier_name || (erpMachine ? erpMachine.manufacturer : ''),
                items,
                items_count: items.length,
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
                            machine_sku: r.machine_sku,
                            machine_name: r.machine_name,
                            machine_vendor_model: r.machine_vendor_model,
                            client_approved_at: r.client_approved_at || r.stage_entry_at
                        });
                    }
                });
            }
        });

        const catalog = await pAll(`SELECT * FROM parts_catalog ORDER BY times_requested DESC, id DESC`);

        res.json({
            exchange: rates,
            requests: enrichedRequests,
            erp_queue: erpQueue,
            catalog
        });
    }));

    // 9. Detalhe Completo de uma Solicitação + Timeline + Auto-Enriquecimento Cód. Antigo do ERP
    router.get('/requests/:id', authenticateToken, asyncSafe(async (req, res) => {
        const reqRow = await pGet('SELECT * FROM parts_requests WHERE id = ?', [req.params.id]);
        if (!reqRow) return res.status(404).json({ error: 'Solicitação não encontrada.' });
        const items = await pAll('SELECT * FROM parts_request_items WHERE request_id = ? ORDER BY id ASC', [reqRow.id]);
        const timeline = await pAll('SELECT * FROM parts_timeline WHERE request_id = ? ORDER BY id DESC', [reqRow.id]);

        // Enriquecer automaticamente com Cód. Antigo (vendorCode) e Nome Fabricante da planilha skus.csv caso esteja em branco
        const erpMachine = getErpSkuDetails(reqRow.machine_sku);
        if (erpMachine) {
            if (!reqRow.machine_vendor_model && erpMachine.vendorCode) {
                reqRow.machine_vendor_model = erpMachine.vendorCode;
            }
            if (!reqRow.machine_supplier_name && erpMachine.manufacturer) {
                reqRow.machine_supplier_name = erpMachine.manufacturer;
            }
        }
        items.forEach((it) => {
            if (it.erp_sku) {
                const erpPart = getErpSkuDetails(it.erp_sku);
                if (erpPart) {
                    if (!it.vendor_part_number && erpPart.vendorCode) it.vendor_part_number = erpPart.vendorCode;
                    if (!it.part_name_en && erpPart.nameEn) it.part_name_en = erpPart.nameEn;
                }
            }
        });

        const suggestedSupplierEmail = await resolveSupplierSavedEmail(
            (items[0] && items[0].intl_supplier_name) || reqRow.machine_supplier_name || ''
        );

        res.json({
            request: reqRow,
            items,
            timeline,
            suggested_supplier_email: suggestedSupplierEmail,
            smtp_configured: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_HOST !== 'smtp.exemplo.com')
        });
    }));

    // 10. Criar Nova Solicitação de Peças (Guilherme Bertola / Pós-Venda / Vendas / Assistência)
    router.post('/requests', authenticateToken, asyncSafe(async (req, res) => {
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

        // Se todas as peças já têm rota definida (ex: Guilherme ou Engenharia já definiu Nacional ou Importação), pode ir direto para 2_COTACAO_FORNECEDOR!
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

            const existingErpSku = rawIt.erp_sku ? String(rawIt.erp_sku).trim().toUpperCase() : '';
            const erpPart = getErpSkuDetails(existingErpSku);
            const resolvedPartVendorCode = String(rawIt.vendor_part_number || '').trim() || (erpPart ? erpPart.vendorCode : '');
            const resolvedPartNameEn = String(rawIt.part_name_en || '').trim() || (erpPart ? erpPart.nameEn : '');
            const category = rawIt.category || 'MECANICA';
            const suggestedNcm = rawIt.suggested_ncm || suggestNcmForCategory(category, existingErpSku);
            const route = rawIt.sourcing_route || 'DEFINIR';
            const fiscalOrigin = route === 'NACIONAL' ? '0' : '1';

            // Verifica se já existe na Árvore de Peças (parts_catalog) por catalog_part_id, erp_sku ou nome+máquina
            let catRow = null;
            if (rawIt.catalog_part_id) {
                catRow = await pGet('SELECT * FROM parts_catalog WHERE id = ?', [rawIt.catalog_part_id]);
            }
            if (!catRow && existingErpSku) {
                catRow = await pGet('SELECT * FROM parts_catalog WHERE erp_sku = ?', [existingErpSku]);
            }
            if (!catRow && machine_sku) {
                catRow = await pGet(
                    'SELECT * FROM parts_catalog WHERE parent_machine_sku = ? AND LOWER(name_pt) = LOWER(?)',
                    [machine_sku, partNamePt]
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
                        machine_sku || '',
                        resolvedMachineName,
                        resolvedMachineVendorModel,
                        route,
                        rawIt.national_equiv_spec || '',
                        resolvedMachineSupplier,
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
                    suggested_ncm, fiscal_origin, weight_kg, photo_path, item_notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2.0, 2.0, ?, ?, ?, 2.0, ?, ?, ?, ?, ?, ?)`,
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
                    resolvedMachineSupplier || (catRow ? catRow.intl_supplier_name : ''),
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
                    rawIt.item_notes || ''
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

    // 11. Atualizar Solicitação Completa + Itens + Cálculos de Cotação (FOB x Dólar x 2 x 2 / Nacional)
    router.put('/requests/:id', authenticateToken, asyncSafe(async (req, res) => {
        const reqId = parseInt(req.params.id);
        const existing = await pGet('SELECT * FROM parts_requests WHERE id = ?', [reqId]);
        if (!existing) return res.status(404).json({ error: 'Solicitação não encontrada.' });

        const now = new Date().toISOString();
        const b = req.body || {};

        const newStage = b.stage || existing.stage;
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

                    // Seleção inteligente do preço sugerido conforme fonte escolhida (com possibilidade de ajuste fino manual)
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
                            item_notes = COALESCE(?, item_notes)
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
                            it.id, reqId
                        ]
                    );

                    // Sincronizar memória técnica e últimos custos na Árvore da Máquina (parts_catalog)
                    if (it.catalog_part_id) {
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
                                b.machine_sku || existing.machine_sku || '',
                                b.machine_name || existing.machine_name || '',
                                b.machine_vendor_model || existing.machine_vendor_model || '',
                                it.sourcing_route || 'DEFINIR', it.sourcing_route || 'DEFINIR',
                                it.national_equiv_spec || '',
                                it.nat_supplier_name || '',
                                natCost, natCost,
                                it.intl_supplier_name || '',
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
                    // Novo item adicionado durante edição
                    const tempSku = await generateNextTempSku();
                    const cat = it.category || 'MECANICA';
                    const ncm = it.suggested_ncm || suggestNcmForCategory(cat, it.erp_sku);
                    const insCat = await pRun(
                        `INSERT INTO parts_catalog (
                            temp_sku, erp_sku, name_pt, name_en, category,
                            parent_machine_sku, parent_machine_name, parent_vendor_model,
                            sourcing_policy, suggested_ncm, unit, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            tempSku, it.erp_sku || null, String(it.part_name_pt).trim(), it.part_name_en || '', cat,
                            b.machine_sku || existing.machine_sku || '',
                            b.machine_name || existing.machine_name || '',
                            b.machine_vendor_model || existing.machine_vendor_model || '',
                            it.sourcing_route || 'DEFINIR', ncm, it.unit || 'UN', now, now
                        ]
                    );
                    await pRun(
                        `INSERT INTO parts_request_items (
                            request_id, catalog_part_id, temp_sku, erp_sku, erp_registered,
                            part_name_pt, part_name_en, category, vendor_part_number,
                            qty, unit, sourcing_route, suggested_ncm, intl_usd_rate
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            reqId, insCat.lastID, tempSku, it.erp_sku || null, it.erp_sku ? 1 : 0,
                            String(it.part_name_pt).trim(), it.part_name_en || '', cat, it.vendor_part_number || '',
                            parseFloat(it.qty) || 1, it.unit || 'UN', it.sourcing_route || 'DEFINIR', ncm, usdSnap
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
        const updatedItems = await pAll('SELECT * FROM parts_request_items WHERE request_id = ? ORDER BY id ASC', [reqId]);
        res.json({ success: true, request: updated, items: updatedItems, total_quoted_brl: totalQuoted });
    }));

    // 12. Transições Inteligentes de Negócio (Proposta Enviada / Cliente Aprovou / Declinou / Chegou na Doca / Entregue)
    router.post('/requests/:id/action', authenticateToken, asyncSafe(async (req, res) => {
        const reqId = parseInt(req.params.id);
        const { action, reason, erp_order_number, out_nfe_number, shelf_location } = req.body;
        const r = await pGet('SELECT * FROM parts_requests WHERE id = ?', [reqId]);
        if (!r) return res.status(404).json({ error: 'Solicitação não encontrada.' });

        const items = await pAll('SELECT * FROM parts_request_items WHERE request_id = ?', [reqId]);
        const now = new Date().toISOString();

        if (action === 'SEND_TO_QUOTATION') {
            await pRun(`UPDATE parts_requests SET stage = '2_COTACAO_FORNECEDOR', stage_entry_at = ?, updated_at = ? WHERE id = ?`, [now, now, reqId]);
            await addTimelineEntry(reqId, req.user, 'STAGE_CHANGE', 'Triagem técnica concluída. Liberado para Cotação com Fornecedor (sem aguardar cadastro ERP).');
        } else if (action === 'RELEASE_PROPOSAL_TO_SALES') {
            await pRun(`UPDATE parts_requests SET stage = '3_PROPOSTA_CLIENTE', proposal_sent_at = COALESCE(proposal_sent_at, ?), stage_entry_at = ?, updated_at = ? WHERE id = ?`, [now, now, now, reqId]);
            await addTimelineEntry(reqId, req.user, 'PROPOSAL_READY', `Cotação concluída (Total R$ ${(r.total_quoted_brl || 0).toFixed(2)}) e encaminhada para proposta comercial ao cliente.`);
        } else if (action === 'CLIENT_APPROVED') {
            // Verifica se algum item ainda está apenas com Pré-SKU (TMP-PEC-...) precisando da Jhenifer no ERP!
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

        // Grava definitivamente na Árvore da Máquina (parts_catalog) para NUNCA mais precisar cadastrar essa peça de novo!
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

        // Atualiza também supplier_sku_mappings no mrpDb caso haja Part Number do fornecedor
        if (item.vendor_part_number && String(item.vendor_part_number).trim()) {
            await mrpRun(
                `INSERT OR REPLACE INTO supplier_sku_mappings (
                    supplier_name, supplier_sku, tecfag_sku, description, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    item.intl_supplier_name || (parentReq ? parentReq.machine_supplier_name : '') || 'Fornecedor Peças',
                    String(item.vendor_part_number).trim(),
                    cleanSku,
                    item.part_name_pt,
                    now,
                    now
                ]
            ).catch(() => {});
        }

        // Adiciona ao catálogo products.json se ainda não constar, mantendo o ecossistema inteiro sincronizado
        try {
            const prods = loadProductsCatalog();
            if (!prods.some(p => String(p.sku || '').toUpperCase() === cleanSku)) {
                prods.push({
                    sku: cleanSku,
                    name: item.part_name_pt.toUpperCase(),
                    group: parentReq && parentReq.machine_name ? `PEÇA REPOSIÇÃO - ${parentReq.machine_name.toUpperCase().slice(0, 35)}` : 'PEÇAS DE REPOSIÇÃO',
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

        // Verifica se TODOS os itens desta solicitação já possuem SKU ERP cadastrado -> Avança sozinho para 5_COMPRA_TRANSITO!
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
                    `[PEÇA REPOSIÇÃO ${r.req_code}] ${it.part_name_pt}${r.machine_sku ? ' (Máq: ' + r.machine_sku + ')' : ''}`,
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

    // 15. Comentário Rápido na Timeline da Solicitação
    router.post('/requests/:id/comment', authenticateToken, asyncSafe(async (req, res) => {
        const reqId = parseInt(req.params.id);
        const msg = String(req.body.message || '').trim();
        if (!msg) return res.status(400).json({ error: 'Digite uma mensagem.' });
        await addTimelineEntry(reqId, req.user, 'COMMENT', msg);
        const timeline = await pAll('SELECT * FROM parts_timeline WHERE request_id = ? ORDER BY id DESC', [reqId]);
        res.json({ success: true, timeline });
    }));

    // 16. Excluir Solicitação (Admin / Diretoria / Solicitante em rascunho)
    router.delete('/requests/:id', authenticateToken, asyncSafe(async (req, res) => {
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

    // 18. Disparo Oficial de E-mail ao Fornecedor COM Fotos Embutidas no Corpo (CID) + Anexadas e Código Original do Fornecedor (Cód. Antigo)
    router.post('/requests/:id/send-supplier-email', authenticateToken, partsUpload.array('extra_files', 10), asyncSafe(async (req, res) => {
        const reqId = parseInt(req.params.id);
        const r = await pGet('SELECT * FROM parts_requests WHERE id = ?', [reqId]);
        if (!r) return res.status(404).json({ error: 'Solicitação não encontrada.' });

        const {
            to = '',
            cc = '',
            subject = '',
            body = '',
            lang = 'EN',
            supplier_name = '',
            vendor_machine_code = ''
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

        const items = await pAll('SELECT * FROM parts_request_items WHERE request_id = ? ORDER BY id ASC', [reqId]);
        const now = new Date().toISOString();

        // Resolver Código Original no Fornecedor (Aba Cód. Antigo do ERP) — NUNCA enviar SKU interno Tecfag ao fornecedor externo
        const erpMachine = getErpSkuDetails(r.machine_sku);
        const effectiveVendorMachineCode = String(vendor_machine_code || '').trim() ||
            r.machine_vendor_model ||
            (erpMachine ? erpMachine.vendorCode : '');

        if (effectiveVendorMachineCode && effectiveVendorMachineCode !== r.machine_vendor_model) {
            await pRun('UPDATE parts_requests SET machine_vendor_model = ?, updated_at = ? WHERE id = ?', [
                effectiveVendorMachineCode, now, reqId
            ]);
        }

        // Memorizar o e-mail deste fornecedor automaticamente para as próximas cotações
        const cleanSupplierName = String(supplier_name || r.machine_supplier_name || (erpMachine ? erpMachine.manufacturer : '') || '').trim();
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

        // Montar anexos de fotos das peças (Inline CID + Anexo de Arquivo)
        const mailAttachments = [];
        const inlinePhotoCardsHtml = [];
        let photoCounter = 0;

        function resolvePartPhotoDiskPath(photoUrlPath) {
            if (!photoUrlPath) return null;
            const fname = path.basename(String(photoUrlPath));
            const candidate = path.join(PARTS_UPLOADS_DIR, fname);
            if (fs.existsSync(candidate)) return candidate;
            return null;
        }

        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const diskPath = resolvePartPhotoDiskPath(it.photo_path);
            if (diskPath) {
                photoCounter++;
                const ext = path.extname(diskPath) || '.jpg';
                const isImage = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext.toLowerCase());
                const erpPart = getErpSkuDetails(it.erp_sku);
                const partVendorCode = it.vendor_part_number || (erpPart ? erpPart.vendorCode : '') || `Item_${i + 1}`;
                const safeCodeSlug = String(partVendorCode).replace(/[^a-zA-Z0-9\-_]/g, '_').slice(0, 30);
                const attachFilename = `Part_${i + 1}_${safeCodeSlug}${ext}`;
                const cidKey = `tecfag_part_photo_${i + 1}_${Date.now()}`;

                if (isImage) {
                    // Anexa de forma que apareça EMBUTIDA no corpo do e-mail E também disponível para download!
                    mailAttachments.push({
                        filename: attachFilename,
                        path: diskPath,
                        cid: cidKey,
                        contentDisposition: 'inline'
                    });
                    const displayPartTitle = lang === 'EN'
                        ? (it.part_name_en || it.part_name_pt)
                        : it.part_name_pt;
                    inlinePhotoCardsHtml.push(`
                        <div style="border:1px solid #cbd5e1; border-radius:10px; padding:14px; margin-bottom:16px; background:#f8fafc; max-width:560px;">
                            <div style="font-weight:bold; font-size:14px; color:#0f172a; margin-bottom:6px;">
                                #${i + 1} — ${displayPartTitle} (Qty: ${it.qty} ${it.unit || 'PCS'})
                                ${it.vendor_part_number ? ` | Code: <span style="color:#0284c7;">${it.vendor_part_number}</span>` : ''}
                            </div>
                            <img src="cid:${cidKey}" alt="${attachFilename}" style="max-width:100%; max-height:420px; height:auto; border-radius:8px; border:1px solid #94a3b8; display:block;" />
                        </div>
                    `);
                } else {
                    mailAttachments.push({
                        filename: attachFilename,
                        path: diskPath
                    });
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

                // Se o 1º item da solicitação ainda estava sem foto e o usuário subiu uma imagem aqui, já vincula na peça também!
                if (isImage && items[0] && !items[0].photo_path) {
                    const relUrl = `/uploads_pecas/${f.filename}`;
                    items[0].photo_path = relUrl;
                    await pRun('UPDATE parts_request_items SET photo_path = ? WHERE id = ?', [relUrl, items[0].id]).catch(() => {});
                }

                if (isImage) {
                    mailAttachments.push({
                        filename: f.originalname || `Photo_${k + 1}${ext}`,
                        path: f.path,
                        cid: cidExtra,
                        contentDisposition: 'inline'
                    });
                    inlinePhotoCardsHtml.push(`
                        <div style="border:1px solid #cbd5e1; border-radius:10px; padding:14px; margin-bottom:16px; background:#f8fafc; max-width:560px;">
                            <div style="font-weight:bold; font-size:13px; color:#0f172a; margin-bottom:6px;">📎 ${f.originalname || `Reference Photo #${k + 1}`}</div>
                            <img src="cid:${cidExtra}" alt="${f.originalname}" style="max-width:100%; max-height:420px; height:auto; border-radius:8px; border:1px solid #94a3b8; display:block;" />
                        </div>
                    `);
                } else {
                    mailAttachments.push({
                        filename: f.originalname || f.filename,
                        path: f.path
                    });
                }
            }
        }

        // Assinatura Oficial Grupo Tecfag
        const hasSignatureImg = fs.existsSync(SIGNATURE_IMG_PATH);
        if (hasSignatureImg) {
            mailAttachments.push({
                filename: 'assinatura_tecfag.png',
                path: SIGNATURE_IMG_PATH,
                cid: 'tecfag_signature_banner'
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
        const safeBodyHtml = String(body || '').trim()
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        const photosHeaderTitle = lang === 'EN'
            ? '📷 Attached Part Photo(s) / Reference Image(s):'
            : '📷 Foto(s) / Imagem(ns) de Referência da(s) Peça(s):';

        const htmlEmail = `
            <div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.6; color: #1e293b; background-color: #ffffff; padding: 12px 4px;">
                ${effectiveVendorMachineCode ? `
                    <div style="background:#f1f5f9; border-left:4px solid #0284c7; padding:10px 14px; border-radius:6px; margin-bottom:16px; font-size:13px;">
                        <strong>${lang === 'EN' ? 'Machine Original Model' : 'Modelo de Referência'}:</strong> <span style="color:#0284c7; font-weight:bold; font-size:15px;">${effectiveVendorMachineCode}</span>
                        ${r.machine_serial ? ` &nbsp;|&nbsp; <strong>Serial No.:</strong> ${r.machine_serial}` : ''}
                        &nbsp;|&nbsp; <strong>Ref:</strong> ${r.req_code}
                    </div>
                ` : ''}

                <div style="font-size: 14px; color: #1e293b; margin-bottom: 22px; white-space: pre-wrap; line-height: 1.65;">${safeBodyHtml}</div>

                ${inlinePhotoCardsHtml.length > 0 ? `
                    <div style="margin-top: 20px; margin-bottom: 24px; padding-top: 14px; border-top: 2px solid #e2e8f0;">
                        <div style="font-size: 14px; font-weight: bold; color: #0f172a; margin-bottom: 12px;">${photosHeaderTitle}</div>
                        ${inlinePhotoCardsHtml.join('\n')}
                    </div>
                ` : ''}

                <div style="margin-top: 25px; padding-top: 15px; border-top: 1px solid #e2e8f0;">
                    ${hasSignatureImg ? `
                        <div style="margin-bottom: 12px;">
                            <img src="cid:tecfag_signature_banner" alt="Grupo Tecfag" style="max-width: 640px; width: 100%; height: auto; display: block; border: 0;" />
                        </div>
                    ` : `
                        <div style="font-size: 13px; color: #334155;">
                            <strong style="color:#b91c1c;">GRUPO TECFAG — AUTOMAÇÃO & EQUIPAMENTOS INDUSTRIAIS</strong><br>
                            Tel: +55 (14) 3161-5000 | www.tecfag.com.br
                        </div>
                    `}
                    <div style="font-size: 11px; color: #64748b; margin-top: 8px;">
                        Ref: <strong>${r.req_code}</strong> | Sent by ${senderDisplay}
                    </div>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: process.env.EMAIL_FROM || `"Tecfag Spare Parts / Compras" <${process.env.SMTP_USER}>`,
            to: String(to).trim(),
            cc: cc && String(cc).trim() ? String(cc).trim() : undefined,
            subject: String(subject).trim(),
            text: String(body || '').trim(),
            html: htmlEmail,
            attachments: mailAttachments
        });

        await addTimelineEntry(
            reqId,
            req.user,
            'EMAIL_SENT',
            `📧 E-mail de cotação disparado para "${to}"${effectiveVendorMachineCode ? ` [Modelo Fornecedor: ${effectiveVendorMachineCode}]` : ''} com ${photoCounter} foto(s)/anexo(s) junto no e-mail!`
        );

        res.json({
            success: true,
            photos_sent: photoCounter,
            message: `E-mail enviado com sucesso para ${to} (${photoCounter} foto(s) incluída(s))!`
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
