const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const pdfParse = require('pdf-parse');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Garantir que as pastas de uploads e banco de dados existam
const UPLOADS_DIR = process.env.UPLOADS_PATH || path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR);
}

// Configuração do SQLite
const DB_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR);
}
const dbPath = process.env.DATABASE_PATH || path.join(DB_DIR, 'tecfag_mrp.db');
const BACKUPS_DIR = path.join(DB_DIR, 'backups');

function getDirectorySize(dirPath) {
    let size = 0;
    try {
        if (!fs.existsSync(dirPath)) return 0;
        const files = fs.readdirSync(dirPath);
        for (let i = 0; i < files.length; i++) {
            const filePath = path.join(dirPath, files[i]);
            const stats = fs.statSync(filePath);
            if (stats.isDirectory()) {
                size += getDirectorySize(filePath);
            } else {
                size += stats.size;
            }
        }
    } catch (e) {
        console.error('Erro ao calcular tamanho do diretório:', e.message);
    }
    return size;
}

function runDailyBackup() {
    try {
        if (!fs.existsSync(BACKUPS_DIR)) {
            fs.mkdirSync(BACKUPS_DIR);
        }

        const dateStr = new Date().toISOString().split('T')[0];
        const backupPath = path.join(BACKUPS_DIR, `tecfag_mrp_backup_${dateStr}.db`);

        if (fs.existsSync(dbPath)) {
            fs.copyFileSync(dbPath, backupPath);
            console.log(`[BACKUP] Cópia de segurança gerada com sucesso em: ${backupPath}`);
        }

        const files = fs.readdirSync(BACKUPS_DIR);
        const backupFiles = files
            .filter(f => f.startsWith('tecfag_mrp_backup_') && f.endsWith('.db'))
            .map(f => ({ name: f, path: path.join(BACKUPS_DIR, f), time: fs.statSync(path.join(BACKUPS_DIR, f)).mtime }));

        backupFiles.sort((a, b) => a.time - b.time);

        if (backupFiles.length > 7) {
            const filesToDelete = backupFiles.slice(0, backupFiles.length - 7);
            filesToDelete.forEach(f => {
                fs.unlinkSync(f.path);
                console.log(`[BACKUP] Backup rotacionado e removido: ${f.name}`);
            });
        }
    } catch (err) {
        console.error('[BACKUP] Erro na rotina de backup:', err.message);
    }
}

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Erro ao conectar ao banco SQLite:', err.message);
    } else {
        console.log('Conectado com sucesso ao banco SQLite em:', dbPath);
        initializeDatabase();
        runDailyBackup();
        setInterval(runDailyBackup, 24 * 60 * 60 * 1000);
    }
});

// Inicialização das Tabelas do Banco de Dados
function initializeDatabase() {
    db.serialize(() => {
        // Tabela de Projetos
        db.run(`CREATE TABLE IF NOT EXISTS projects (
            code TEXT PRIMARY KEY,
            client TEXT NOT NULL,
            contact TEXT,
            pm TEXT NOT NULL,
            diagnostico TEXT,
            sku TEXT NOT NULL,
            tech TEXT,
            serial TEXT DEFAULT '-',
            route TEXT DEFAULT '-',
            fase INTEGER DEFAULT 1,
            checklist TEXT, -- Salvo como String JSON
            prazos TEXT,    -- Salvo como String JSON
            faseEntryDate TEXT,
            lastUpdate TEXT,
            motivoPerda TEXT,
            machines TEXT   -- Salvo como String JSON
        )`);

        // Executar migração de colunas para bancos existentes
        db.run("ALTER TABLE projects ADD COLUMN machines TEXT", (err) => {});
        db.run("ALTER TABLE projects ADD COLUMN cnpj TEXT", (err) => {});
        db.run("ALTER TABLE projects ADD COLUMN contact_phone TEXT", (err) => {});
        db.run("ALTER TABLE projects ADD COLUMN contact_email TEXT", (err) => {});
        db.run("ALTER TABLE projects ADD COLUMN cnae_codigo TEXT", (err) => {});
        db.run("ALTER TABLE projects ADD COLUMN cnae_descricao TEXT", (err) => {});
        db.run("ALTER TABLE projects ADD COLUMN receita_data TEXT", (err) => {});

        // Tabela de Logs de Auditoria
        db.run(`CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            color TEXT NOT NULL,
            text TEXT NOT NULL
        )`);

        // Tabela de Anexos
        db.run(`CREATE TABLE IF NOT EXISTS attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            projectCode TEXT NOT NULL,
            phase TEXT NOT NULL,
            fileName TEXT NOT NULL,
            fileType TEXT NOT NULL,
            filePath TEXT NOT NULL,
            dateAdded TEXT NOT NULL,
            FOREIGN KEY(projectCode) REFERENCES projects(code) ON DELETE CASCADE
        )`);

        // Tabela de Usuários
        db.run(`CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            role TEXT NOT NULL
        )`);

        // Tabela de Sessões
        db.run(`CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY(username) REFERENCES users(username) ON DELETE CASCADE
        )`);

        // Tabela de Recursos de Fornecedores (Catálogos e Cotações)
        db.run(`CREATE TABLE IF NOT EXISTS supplier_resources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            supplier_name TEXT NOT NULL,
            machine_category TEXT NOT NULL,
            title TEXT NOT NULL,
            url TEXT NOT NULL,
            notes TEXT,
            extracted_text TEXT,
            created_by TEXT,
            created_at TEXT NOT NULL
        )`);

        // Migração para adicionar extração de texto em instalações existentes
        db.run("ALTER TABLE supplier_resources ADD COLUMN extracted_text TEXT", (err) => {
            if (err && !err.message.includes("duplicate column name")) {
                console.log("[MIGRATE] Coluna extracted_text já existente ou erro:", err.message);
            } else if (!err) {
                console.log("[MIGRATE] Coluna extracted_text adicionada com sucesso.");
            }
        });

        // Seed de usuários padrão
        seedDefaultUsers();
    });
}

// Utilitários de Promessa para SQLite
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});

const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
        err ? reject(err) : resolve(this);
    });
});

// ==========================================
// UTILITÁRIOS E MIDDLEWARES DE AUTENTICAÇÃO
// ==========================================

function hashPassword(password, salt) {
    if (!salt) {
        salt = crypto.randomBytes(16).toString('hex');
    }
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return { salt, hash };
}

function seedDefaultUsers() {
    const defaultUsers = [
        { username: 'admin', password: 'adm@tecfag99', role: 'ALL' },
        { username: 'vendas', password: 'vend@tecfag01', role: 'VENDAS' },
        { username: 'engenharia', password: 'eng#tecfag22', role: 'ENGENHARIA' },
        { username: 'compras', password: 'comp@tecfag33', role: 'COMPRAS' },
        { username: 'estoque', password: 'estq@tecfag44', role: 'ESTOQUE' },
        { username: 'tecnico', password: 'tec#tecfag88', role: 'TECNICO' },
        { username: 'gerente', password: 'pm#tecfag55', role: 'GERENTE' },
        { username: 'gerente_comercial', password: 'comercial#77', role: 'GERENTE_COMERCIAL' },
        { username: 'joao.lanza', password: 'diretor@10', role: 'DIRETOR' },
        { username: 'vendas1', password: 'vend@tecfag02', role: 'VENDAS' },
        { username: 'vendas2', password: 'vend@tecfag03', role: 'VENDAS' },
        { username: 'vendas3', password: 'vend@tecfag04', role: 'VENDAS' },
        { username: 'vendas4', password: 'vend@tecfag05', role: 'VENDAS' }
    ];

    defaultUsers.forEach((u) => {
        db.get('SELECT username FROM users WHERE username = ?', [u.username], (err, row) => {
            if (!err) {
                const { salt, hash } = hashPassword(u.password);
                if (!row) {
                    db.run('INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)', [
                        u.username,
                        hash,
                        salt,
                        u.role
                    ]);
                } else {
                    db.run('UPDATE users SET password_hash = ?, salt = ?, role = ? WHERE username = ?', [
                        hash,
                        salt,
                        u.role,
                        u.username
                    ]);
                }
            }
        });
    });
}

async function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Acesso negado: Token de sessão não fornecido.' });
    }

    try {
        const session = await dbGet('SELECT * FROM sessions WHERE token = ?', [token]);
        if (!session) {
            return res.status(403).json({ error: 'Sessão inválida ou expirada.' });
        }

        if (new Date(session.expires_at) < new Date()) {
            await dbRun('DELETE FROM sessions WHERE token = ?', [token]);
            return res.status(403).json({ error: 'Sessão expirada. Faça login novamente.' });
        }

        const user = await dbGet('SELECT username, role FROM users WHERE username = ?', [session.username]);
        if (!user) {
            return res.status(403).json({ error: 'Usuário não existe.' });
        }

        req.user = user;
        next();
    } catch (err) {
        res.status(500).json({ error: 'Erro interno de autenticação: ' + err.message });
    }
}

// Configuração do Multer para upload de arquivos
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// ROTAS DE AUTENTICAÇÃO
// ==========================================

// POST /api/auth/login - Autentica usuário e cria sessão
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
    }

    try {
        const user = await dbGet('SELECT * FROM users WHERE username = ?', [username.toLowerCase().trim()]);
        if (!user) {
            return res.status(400).json({ error: 'Usuário ou senha incorretos.' });
        }

        const { hash } = hashPassword(password, user.salt);
        if (hash !== user.password_hash) {
            return res.status(400).json({ error: 'Usuário ou senha incorretos.' });
        }

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);

        await dbRun('INSERT INTO sessions (token, username, expires_at) VALUES (?, ?, ?)', [
            token,
            user.username,
            expiresAt.toISOString()
        ]);

        res.json({
            success: true,
            token,
            user: {
                username: user.username,
                role: user.role
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao fazer login: ' + err.message });
    }
});

// POST /api/auth/logout - Deleta sessão ativa
app.post('/api/auth/logout', async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
        try {
            await dbRun('DELETE FROM sessions WHERE token = ?', [token]);
        } catch (e) {}
    }
    res.json({ success: true, message: 'Desconectado com sucesso.' });
});

// GET /api/auth/me - Dados do usuário logado
app.get('/api/auth/me', authenticateToken, (req, res) => {
    res.json({
        success: true,
        user: req.user
    });
});

// POST /api/auth/change-password - Altera a senha do usuário autenticado
app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Senha atual e nova senha são obrigatórias.' });
    }

    try {
        const user = await dbGet('SELECT * FROM users WHERE username = ?', [req.user.username]);
        if (!user) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        const { hash } = hashPassword(currentPassword, user.salt);
        if (hash !== user.password_hash) {
            return res.status(400).json({ error: 'Senha atual incorreta.' });
        }

        const { salt: newSalt, hash: newHash } = hashPassword(newPassword);
        await dbRun('UPDATE users SET password_hash = ?, salt = ? WHERE username = ?', [
            newHash,
            newSalt,
            req.user.username
        ]);

        res.json({ success: true, message: 'Senha alterada com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao alterar senha: ' + err.message });
    }
});

// Proteger endpoints de projetos, logs e anexos
app.use('/api/projects', authenticateToken);
app.use('/api/logs', authenticateToken);
app.use('/api/attachments', authenticateToken);

// Rota estática para downloads físicos
app.use('/uploads', express.static(UPLOADS_DIR));

// Servir o Frontend index.html na raiz
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Configuração e envio de e-mails via Nodemailer (SMTP)
async function sendPhaseChangeEmail(project, oldFase, newFase) {
    // Se não há dados do SMTP no .env, ignorar silenciosamente
    if (!process.env.SMTP_HOST || process.env.SMTP_HOST === 'smtp.exemplo.com') {
        console.log(`[E-mail Notificação] SMTP não configurado. Transição de fase no projeto ${project.code} não enviada.`);
        return;
    }

    const faseNomes = {
        1: 'Fase 1: Vendas & Escopo',
        2: 'Fase 2: Compras Acompanhamento Produção/Embarque',
        3: 'Fase 3: Transp. Maritimo/Nacionalização',
        4: 'Fase 4: Instalação & SAT',
        5: 'Fase 5: Concluído ("Joinha" SAT assinado)',
        6: 'Fase 6: Cancelado/Perdido'
    };

    const destMap = {
        1: process.env.EMAIL_VENDAS || 'vendas14@tecfag.com.br, vendas20@tecfag.com.br, vendas21@tecfag.com.br, vendas4@tecfag.com.br, vendas17@tecfag.com.br, vendas19@tecfag.com.br',
        2: process.env.EMAIL_COMPRAS || 'gilson@tecfag.com.br',
        3: process.env.EMAIL_ESTOQUE || 'almoxarifado2@tecfag.com.br',
        4: process.env.EMAIL_TECNICO || 'assistencia@tecfag.com.br',
        5: process.env.EMAIL_GERENTE || 'projetos@grupo.tecfag.com.br',
        6: process.env.EMAIL_GERENTE || 'projetos@grupo.tecfag.com.br'
    };

    const destEmail = destMap[newFase] || process.env.EMAIL_GERENTE || 'projetos@grupo.tecfag.com.br';
    const pmEmail = process.env.EMAIL_GERENTE || 'projetos@grupo.tecfag.com.br';

    if (!destEmail) {
        console.log(`[E-mail Notificação] Destinatário para Fase ${newFase} não cadastrado nas variáveis de ambiente.`);
        return;
    }

    try {
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

        const subject = `📢 MRP II Alerta: Transição de Fase - Projeto ${project.code} (${project.client})`;
        
        const htmlBody = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; padding: 25px; background-color: #f4f6f9; color: #333; line-height: 1.6;">
                <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; border: 1px solid #e1e8ed; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
                    <div style="background: linear-gradient(135deg, #0ea5e9, #a855f7); padding: 20px; text-align: center; color: white;">
                        <h2 style="margin: 0; font-size: 1.4rem;">Notificação de Avanço de Etapa</h2>
                        <p style="margin: 5px 0 0 0; font-size: 0.85rem; opacity: 0.9;">Tecfag MRP II & Controle de Rastreabilidade</p>
                    </div>
                    
                    <div style="padding: 25px;">
                        <p style="font-size: 1rem; margin-top: 0;">Olá Equipe,</p>
                        <p>O projeto <strong>${project.code}</strong> para o cliente <strong>${project.client}</strong> foi atualizado e mudou de estágio operacional no fluxo corporativo:</p>
                        
                        <div style="background-color: #f8fafc; border-left: 4px solid #a855f7; padding: 15px; margin: 20px 0; border-radius: 4px;">
                            <span style="display: block; font-size: 0.8rem; text-transform: uppercase; color: #64748b; font-weight: 700;">Etapa Anterior</span>
                            <span style="display: block; font-size: 0.95rem; text-decoration: line-through; color: #94a3b8; margin-bottom: 10px;">${faseNomes[oldFase] || 'Não Iniciado'}</span>
                            
                            <span style="display: block; font-size: 0.8rem; text-transform: uppercase; color: #0ea5e9; font-weight: 700;">Nova Etapa Operacional</span>
                            <span style="display: block; font-size: 1.1rem; color: #0f172a; font-weight: bold;">${faseNomes[newFase]}</span>
                        </div>
                        
                        <h3 style="font-size: 1rem; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin-top: 25px; color: #1e293b;">Resumo do Equipamento:</h3>
                        <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem; margin-top: 10px;">
                            <tr>
                                <td style="padding: 6px 0; color: #64748b; font-weight: 600; width: 140px;">SKU Customizado:</td>
                                <td style="padding: 6px 0; color: #334155; font-family: monospace;">${project.sku}-PRJ-${project.code.replace(/-/g, '')}</td>
                            </tr>
                            <tr>
                                <td style="padding: 6px 0; color: #64748b; font-weight: 600;">Nº Série Físico:</td>
                                <td style="padding: 6px 0; color: #334155;">${project.serial || '-'}</td>
                            </tr>
                            <tr>
                                <td style="padding: 6px 0; color: #64748b; font-weight: 600;">Gerente (PM):</td>
                                <td style="padding: 6px 0; color: #334155;">${project.pm}</td>
                            </tr>
                            <tr>
                                <td style="padding: 6px 0; color: #64748b; font-weight: 600;">Técnico Alocado:</td>
                                <td style="padding: 6px 0; color: #334155;">${project.tech || 'Não Alocado'}</td>
                            </tr>
                        </table>

                        <div style="margin-top: 30px; text-align: center;">
                            <a href="${process.env.BASE_URL || 'https://tecfag-mrp.onrender.com/'}" style="background-color: #0ea5e9; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 0.9rem; display: inline-block; box-shadow: 0 4px 6px rgba(14, 165, 233, 0.2);">Acessar Dashboard MRP</a>
                        </div>
                    </div>
                    
                    <div style="background-color: #f1f5f9; padding: 15px; text-align: center; font-size: 0.75rem; color: #94a3b8; border-top: 1px solid #e2e8f0;">
                        Este e-mail é gerado de forma automática. Por favor, não responda diretamente.
                    </div>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: process.env.EMAIL_FROM || '"MRP Tecfag" <mrp@tecfag.com.br>',
            to: destEmail,
            cc: pmEmail !== destEmail ? pmEmail : undefined,
            subject: subject,
            html: htmlBody
        });

        console.log(`[E-mail Notificação] Notificação enviada para ${destEmail} com sucesso.`);
    } catch (err) {
        console.error('[E-mail Notificação] Falha ao enviar notificação de e-mail:', err.message);
    }
}

// ==========================================
// ENDPOINTS DA API DE PROJETOS
// ==========================================

// GET /api/projects - Lista todos os projetos
app.get('/api/projects', async (req, res) => {
    try {
        const rows = await dbAll('SELECT * FROM projects');
        const formatted = rows.map(p => {
            let machinesParsed = [];
            try {
                machinesParsed = p.machines ? JSON.parse(p.machines) : [];
            } catch (e) {}
            if (!machinesParsed || !Array.isArray(machinesParsed) || machinesParsed.length === 0) {
                machinesParsed = [{ sku: p.sku, serial: p.serial, route: p.route }];
            }
            return {
                ...p,
                checklist: p.checklist ? JSON.parse(p.checklist) : {},
                prazos: p.prazos ? JSON.parse(p.prazos) : {},
                machines: machinesParsed
            };
        });
        res.json(formatted);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao listar projetos: ' + err.message });
    }
});

// GET /api/projects/:code - Retorna um projeto específico
app.get('/api/projects/:code', async (req, res) => {
    try {
        const project = await dbGet('SELECT * FROM projects WHERE code = ?', [req.params.code]);
        if (!project) {
            return res.status(404).json({ error: 'Projeto não encontrado.' });
        }
        let machinesParsed = [];
        try {
            machinesParsed = project.machines ? JSON.parse(project.machines) : [];
        } catch (e) {}
        if (!machinesParsed || !Array.isArray(machinesParsed) || machinesParsed.length === 0) {
            machinesParsed = [{ sku: project.sku, serial: project.serial, route: project.route }];
        }
        project.checklist = project.checklist ? JSON.parse(project.checklist) : {};
        project.prazos = project.prazos ? JSON.parse(project.prazos) : {};
        project.machines = machinesParsed;
        res.json(project);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao buscar projeto: ' + err.message });
    }
});

// Função auxiliar para enviar notificações por Webhook
async function sendWebhookNotification(event, details) {
    const webhookUrl = process.env.WEBHOOK_URL;
    if (!webhookUrl) return;

    try {
        let message = "";
        const timestamp = new Date().toLocaleTimeString() + ' ' + new Date().toLocaleDateString();

        if (event === 'CREATE') {
            message = `🆕 **[NOVO PROJETO CADASTRADO]**\n**Código**: \`${details.code}\`\n**Cliente**: \`${details.client}\`\n**PM/Responsável**: \`${details.pm}\`\n**SKU Original**: \`${details.sku}\`\n**Data**: \`${timestamp}\``;
        } else if (event === 'PHASE_CHANGE') {
            const phaseLabels = {
                1: 'Fase 1: Vendas / Escopo',
                2: 'Fase 2: Importação / Compras',
                3: 'Fase 3: Recebimento / Almoxarifado',
                4: 'Fase 4: Instalação / Técnico',
                5: 'Concluído (SAT)',
                6: 'Cancelado / Perdido'
            };
            const oldPhaseLabel = phaseLabels[details.oldFase] || `Fase ${details.oldFase}`;
            const newPhaseLabel = phaseLabels[details.newFase] || `Fase ${details.newFase}`;
            
            message = `🔔 **[MOVIMENTAÇÃO DE FASE]**\n**Projeto**: \`${details.code}\` (Cliente: *${details.client}*)\n➡️ **De**: *${oldPhaseLabel}*\n➡️ **Para**: *${newPhaseLabel}*\n👤 **Operador**: \`${details.user}\`\n**Data**: \`${timestamp}\``;
        } else if (event === 'DELETE') {
            message = `🗑️ **[PROJETO EXCLUÍDO]**\n**Projeto**: \`${details.code}\` foi deletado permanentemente da base.\n**Data**: \`${timestamp}\``;
        }

        if (!message) return;

        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: message,
                content: message
            })
        });
        console.log(`[WEBHOOK] Notificação enviada com sucesso para: ${webhookUrl}`);
    } catch (err) {
        console.error('[WEBHOOK] Erro ao enviar notificação:', err.message);
    }
}

// GET /api/metrics - Retorna métricas gerenciais sobre os projetos (exclusivo gerência/diretoria)
app.get('/api/metrics', authenticateToken, async (req, res) => {
    if (req.user.role !== 'ALL' && req.user.role !== 'GERENTE' && req.user.role !== 'DIRETOR') {
        return res.status(403).json({ error: 'Acesso negado: Apenas a gerência ou diretoria podem visualizar métricas.' });
    }

    try {
        const projects = await dbAll('SELECT code, client, pm, sku, serial, route, fase, checklist, prazos, faseEntryDate, lastUpdate FROM projects');
        
        let totalActive = 0;
        let totalFinished = 0;
        let totalLost = 0;
        let delayedCount = 0;
        
        const faseDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
        const delayedProjects = [];

        projects.forEach(p => {
            const fase = parseInt(p.fase) || 1;
            faseDistribution[fase] = (faseDistribution[fase] || 0) + 1;

            if (fase === 5) {
                totalFinished++;
            } else if (fase === 6) {
                totalLost++;
            } else {
                totalActive++;

                let prazosObj = {};
                try {
                    prazosObj = p.prazos ? JSON.parse(p.prazos) : {};
                } catch(e) {}

                const defaults = { 1: 7, 2: 51, 3: 59, 4: 15 };
                const deadlineDays = prazosObj[`fase${fase}`] !== undefined ? parseInt(prazosObj[`fase${fase}`]) : defaults[fase];
                
                const entryDateStr = p.faseEntryDate || p.lastUpdate || new Date().toISOString();
                const daysInPhase = Math.floor((new Date() - new Date(entryDateStr)) / (24 * 60 * 60 * 1000));

                if (daysInPhase > deadlineDays) {
                    delayedCount++;
                    
                    const phaseResponsible = {
                        1: 'Vendas / Engenharia',
                        2: 'Compras',
                        3: 'Estoque',
                        4: 'Técnico'
                    };

                    delayedProjects.push({
                        code: p.code,
                        client: p.client,
                        pm: p.pm,
                        fase: fase,
                        daysInPhase: daysInPhase,
                        deadline: deadlineDays,
                        delayDays: daysInPhase - deadlineDays,
                        responsible: phaseResponsible[fase] || 'Desconhecido'
                    });
                }
            }
        });

        res.json({
            totalActive,
            totalFinished,
            totalLost,
            delayedCount,
            faseDistribution,
            delayedProjects
        });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao compilar métricas: ' + err.message });
    }
});

// Função auxiliar para consulta de CNPJ com 3 APIs redundantes de fallback
// Função auxiliar para consulta de CNPJ com 3 APIs redundantes de fallback e extração de dossiê completo
async function fetchCNPJWithFallback(cnpj) {
    // API 1: BrasilAPI
    try {
        console.log(`[CNPJ API] Tentando BrasilAPI para CNPJ: ${cnpj}`);
        const response = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
        if (response.status === 200) {
            const data = await response.json();
            
            // Porte
            const porteMap = { 1: 'Microempresa (ME)', 3: 'Empresa de Pequeno Porte (EPP)', 5: 'Demais (Média/Grande)' };
            const porteText = porteMap[data.codigo_porte] || data.porte || 'Não informado';

            // Simples Nacional
            const simplesText = data.opcao_pelo_simples === true ? 'Sim (Optante)' : 'Não (Lucro Presumido/Real)';

            // QSA
            const qsaParsed = (data.qsa || []).map(s => ({
                nome: s.nome_socio || '',
                cargo: s.qualificacao_socio || ''
            }));

            // CNAEs secundários
            const cnaesSecParsed = (data.cnaes_secundarios || []).map(c => ({
                codigo: c.codigo || '',
                descricao: c.descricao || ''
            }));

            // Endereço
            const endParts = [
                data.descricao_tipo_de_logradouro,
                data.logradouro,
                data.numero ? `, ${data.numero}` : '',
                data.complemento ? ` (${data.complemento})` : '',
                data.bairro ? ` - ${data.bairro}` : '',
                data.municipio ? ` - ${data.municipio}/${data.uf || ''}` : '',
                data.cep ? ` - CEP: ${data.cep}` : ''
            ].filter(Boolean).join('');

            return {
                valid: true,
                razao_social: data.razao_social,
                nome_fantasia: data.nome_fantasia || data.razao_social,
                situacao: (data.descricao_situacao_cadastral || '').toUpperCase(),
                cnae_codigo: data.cnae_fiscal || '',
                cnae_descricao: data.cnae_fiscal_descricao || '',
                receita_data: {
                    capital_social: data.capital_social ? data.capital_social.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'Não informado',
                    porte: porteText,
                    data_abertura: data.data_inicio_atividade ? data.data_inicio_atividade.split('-').reverse().join('/') : 'Não informada',
                    endereco: endParts || 'Não informado',
                    contato: data.ddd_telefone_1 ? `(${data.ddd_telefone_1.substring(0, 2)}) ${data.ddd_telefone_1.substring(2)}` : 'Não informado',
                    simples: simplesText,
                    natureza_juridica: data.natureza_juridica || 'Não informado',
                    qsa: qsaParsed,
                    cnaes_secundarios: cnaesSecParsed
                }
            };
        } else if (response.status === 404) {
            return { error: 'CNPJ inexistente na base da Receita Federal.' };
        }
        console.warn(`[CNPJ API] BrasilAPI retornou status ${response.status}. Tentando fallback...`);
    } catch (e) {
        console.error(`[CNPJ API] Falha na BrasilAPI: ${e.message}. Tentando fallback...`);
    }

    // API 2: ReceitaWS
    try {
        console.log(`[CNPJ API] Tentando ReceitaWS para CNPJ: ${cnpj}`);
        const response = await fetch(`https://receitaws.com.br/v1/cnpj/${cnpj}`);
        if (response.status === 200) {
            const data = await response.json();
            if (data.status === 'ERROR') {
                return { error: data.message || 'CNPJ inexistente.' };
            }
            const cnaeObj = data.atividade_principal && data.atividade_principal[0] ? data.atividade_principal[0] : {};
            
            // Simples
            const simplesText = data.simples && data.simples.optante === true ? 'Sim (Optante)' : 'Não (Lucro Presumido/Real)';

            // QSA
            const qsaParsed = (data.qsa || []).map(s => ({
                nome: s.nome || '',
                cargo: s.qual || ''
            }));

            // CNAEs secundários
            const cnaesSecParsed = (data.atividades_secundarias || []).map(c => ({
                codigo: c.code ? c.code.replace(/\D/g, '') : '',
                descricao: c.text || ''
            }));

            // Endereço
            const endParts = [
                data.logradouro,
                data.numero ? `, ${data.numero}` : '',
                data.complemento ? ` (${data.complemento})` : '',
                data.bairro ? ` - ${data.bairro}` : '',
                data.municipio ? ` - ${data.municipio}/${data.uf || ''}` : '',
                data.cep ? ` - CEP: ${data.cep}` : ''
            ].filter(Boolean).join('');

            const capVal = parseFloat(data.capital_social);
            const capStr = !isNaN(capVal) ? capVal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : (data.capital_social || 'Não informado');

            return {
                valid: true,
                razao_social: data.nome,
                nome_fantasia: data.fantasia || data.nome,
                situacao: (data.situacao || '').toUpperCase(),
                cnae_codigo: cnaeObj.code ? cnaeObj.code.replace(/\D/g, '') : '',
                cnae_descricao: cnaeObj.text || '',
                receita_data: {
                    capital_social: capStr,
                    porte: data.porte || 'Não informado',
                    data_abertura: data.abertura || 'Não informada',
                    endereco: endParts || 'Não informado',
                    contato: data.telefone || 'Não informado',
                    simples: simplesText,
                    natureza_juridica: data.natureza_juridica || 'Não informado',
                    qsa: qsaParsed,
                    cnaes_secundarios: cnaesSecParsed
                }
            };
        } else if (response.status === 429) {
            console.warn(`[CNPJ API] ReceitaWS retornou 429 (Limite atingido). Tentando próximo fallback...`);
        }
    } catch (e) {
        console.error(`[CNPJ API] Falha na ReceitaWS: ${e.message}. Tentando próximo fallback...`);
    }

    // API 3: CNPJ.ws
    try {
        console.log(`[CNPJ API] Tentando CNPJ.ws para CNPJ: ${cnpj}`);
        const response = await fetch(`https://publica.cnpj.ws/cnpj/${cnpj}`);
        if (response.status === 200) {
            const data = await response.json();
            const cnaeObj = data.estabelecimento && data.estabelecimento.atividade_principal ? data.estabelecimento.atividade_principal : {};
            const estab = data.estabelecimento || {};

            // Simples
            const simplesText = data.simples && data.simples.optante === 'sim' ? 'Sim (Optante)' : 'Não (Lucro Presumido/Real)';

            // QSA
            const qsaParsed = (data.socios || []).map(s => ({
                nome: s.nome || '',
                cargo: s.qualificacao_socio ? s.qualificacao_socio.descricao : 'Sócio'
            }));

            // CNAEs secundários
            const cnaeSecRaw = estab.atividades_secundarias || [];
            const cnaesSecParsed = cnaeSecRaw.map(c => ({
                codigo: c.subclasse ? c.subclasse.replace(/\D/g, '') : '',
                descricao: c.descricao || ''
            }));
            
            // Endereço
            const endParts = [
                estab.tipo_logradouro,
                estab.logradouro,
                estab.numero ? `, ${estab.numero}` : '',
                estab.complemento ? ` (${estab.complemento})` : '',
                estab.bairro ? ` - ${estab.bairro}` : '',
                estab.cidade ? ` - ${estab.cidade.nome}/${estab.estado ? estab.estado.sigla : ''}` : '',
                estab.cep ? ` - CEP: ${estab.cep}` : ''
            ].filter(Boolean).join('');

            const capSocial = data.capital_social || estab.capital_social;
            const capVal = parseFloat(capSocial);
            const capStr = !isNaN(capVal) ? capVal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'Não informado';

            return {
                valid: true,
                razao_social: data.estabelecimento.razao_social || data.razao_social,
                nome_fantasia: data.estabelecimento.nome_fantasia || data.estabelecimento.razao_social || data.razao_social,
                situacao: (data.estabelecimento.situacao_cadastral || '').toUpperCase(),
                cnae_codigo: cnaeObj.subclasse ? cnaeObj.subclasse.replace(/\D/g, '') : '',
                cnae_descricao: cnaeObj.descricao || '',
                receita_data: {
                    capital_social: capStr,
                    porte: data.porte ? data.porte.descricao : 'Não informado',
                    data_abertura: estab.data_inicio_atividade ? estab.data_inicio_atividade.split('-').reverse().join('/') : 'Não informada',
                    endereco: endParts || 'Não informado',
                    contato: estab.telefone1 ? `(${estab.ddd1}) ${estab.telefone1}` : 'Não informado',
                    simples: simplesText,
                    natureza_juridica: data.natureza_juridica ? data.natureza_juridica.descricao : 'Não informado',
                    qsa: qsaParsed,
                    cnaes_secundarios: cnaesSecParsed
                }
            };
        } else if (response.status === 404) {
            return { error: 'CNPJ inexistente.' };
        }
    } catch (e) {
        console.error(`[CNPJ API] Falha na CNPJ.ws: ${e.message}`);
    }

    return { error: 'Não foi possível validar o CNPJ. Todos os servidores da Receita Federal falharam.' };
}

// GET /api/cnpj/:cnpj - Valida e consulta CNPJ com triplo fallback
app.get('/api/cnpj/:cnpj', authenticateToken, async (req, res) => {
    let { cnpj } = req.params;
    cnpj = cnpj.replace(/\D/g, ''); // Limpa formatação

    if (cnpj.length !== 14) {
        return res.status(400).json({ error: 'O CNPJ deve conter exatamente 14 dígitos.' });
    }

    try {
        const result = await fetchCNPJWithFallback(cnpj);
        
        if (result.error) {
            return res.status(400).json({ error: result.error });
        }

        // Verificar se está ativo
        if (result.situacao !== 'ATIVA' && result.situacao !== 'ATIVO') {
            return res.status(400).json({ 
                error: `Atenção: Este CNPJ está com situação cadastral ${result.situacao || 'INATIVA'} e não pode ser cadastrado.`,
                razao_social: result.razao_social
            });
        }

        res.json({
            valid: true,
            razao_social: result.razao_social,
            nome_fantasia: result.nome_fantasia || result.razao_social,
            cnpj: cnpj,
            situacao: result.situacao,
            cnae_codigo: result.cnae_codigo,
            cnae_descricao: result.cnae_descricao,
            receita_data: result.receita_data
        });
    } catch (err) {
        console.error('[CNPJ API] Erro no endpoint:', err.message);
        res.status(500).json({ error: 'Erro interno ao processar a validação do CNPJ.' });
    }
});

// GET /api/cambio - Proxy para consulta de cotações cambiais (AwesomeAPI)
app.get('/api/cambio', async (req, res) => {
    try {
        console.log('[CAMBIO API] Consultando AwesomeAPI...');
        const response = await fetch('https://economia.awesomeapi.com.br/last/USD-BRL,EUR-BRL,CNY-BRL');
        if (response.status === 200) {
            const data = await response.json();
            return res.json(data);
        } else {
            console.error(`[CAMBIO API] Erro ao consultar AwesomeAPI: status ${response.status}`);
            return res.status(response.status).json({ error: 'Erro ao consultar cotações externas.' });
        }
    } catch (err) {
        console.error('[CAMBIO API] Erro interno:', err.message);
        res.status(500).json({ error: 'Erro interno ao consultar cotação de câmbio.' });
    }
});

// GET /api/ncm/:codigo - Proxy para consulta de NCM (BrasilAPI)
app.get('/api/ncm/:codigo', authenticateToken, async (req, res) => {
    let { codigo } = req.params;
    codigo = codigo.replace(/\D/g, ''); // Limpa formatação

    if (codigo.length !== 8) {
        return res.status(400).json({ error: 'O código NCM deve conter exatamente 8 dígitos.' });
    }

    try {
        console.log(`[NCM API] Consultando BrasilAPI para NCM: ${codigo}`);
        const response = await fetch(`https://brasilapi.com.br/api/ncm/v1/${codigo}`);
        if (response.status === 200) {
            const data = await response.json();
            return res.json(data);
        } else if (response.status === 404) {
            return res.status(404).json({ error: 'Código NCM inexistente na base de dados.' });
        } else {
            console.error(`[NCM API] Erro ao consultar BrasilAPI: status ${response.status}`);
            return res.status(response.status).json({ error: 'Erro ao consultar NCM no servidor externo.' });
        }
    } catch (err) {
        console.error('[NCM API] Erro no endpoint:', err.message);
        res.status(500).json({ error: 'Erro interno ao processar a validação do NCM.' });
    }
});

// GET /api/ncm - Busca NCMs por termo/descrição ou código parcial (BrasilAPI)
app.get('/api/ncm', authenticateToken, async (req, res) => {
    const { search } = req.query;

    if (!search) {
        return res.status(400).json({ error: 'Parâmetro de busca não informado.' });
    }

    try {
        console.log(`[NCM API] Buscando NCMs por descrição/termo: ${search}`);
        const response = await fetch(`https://brasilapi.com.br/api/ncm/v1?search=${encodeURIComponent(search)}`);
        if (response.status === 200) {
            const data = await response.json();
            return res.json(data);
        } else {
            console.error(`[NCM API] Erro ao buscar NCMs no BrasilAPI: status ${response.status}`);
            return res.status(response.status).json({ error: 'Erro ao buscar NCM no servidor externo.' });
        }
    } catch (err) {
        console.error('[NCM API] Erro no endpoint de busca:', err.message);
        res.status(500).json({ error: 'Erro interno ao processar a busca do NCM.' });
    }
});

// GET /api/system-storage - Retorna o espaço de armazenamento utilizado e restante no disco persistente de 1 GB
app.get('/api/system-storage', authenticateToken, async (req, res) => {
    try {
        // Obter caminhos
        const dbDir = process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : path.join(__dirname, 'data');
        const uploadsDir = UPLOADS_DIR;

        // Calcular tamanho do diretório base persistent
        let totalUsedBytes = 0;
        if (process.env.DATABASE_PATH) {
            // Em produção (Render com disco persistente /data)
            totalUsedBytes = getDirectorySize('/data');
        } else {
            // Em ambiente local
            const dbSize = fs.existsSync(dbDir) ? getDirectorySize(dbDir) : 0;
            const uploadsSize = fs.existsSync(uploadsDir) ? getDirectorySize(uploadsDir) : 0;
            totalUsedBytes = dbSize + uploadsSize;
        }

        // Definir o limite máximo do Render (1 GB)
        const limitBytes = 1 * 1024 * 1024 * 1024; // 1 GB
        const usagePercentage = ((totalUsedBytes / limitBytes) * 100).toFixed(2);

        res.json({
            usedBytes: totalUsedBytes,
            usedFormatted: (totalUsedBytes / (1024 * 1024)).toFixed(2) + ' MB',
            limitBytes: limitBytes,
            limitFormatted: '1.00 GB',
            usagePercentage: parseFloat(usagePercentage),
            warning: parseFloat(usagePercentage) > 80 // Alerta acima de 80%
        });
    } catch (err) {
        console.error('[STORAGE API] Erro ao calcular espaço:', err.message);
        res.status(500).json({ error: 'Erro ao calcular espaço de armazenamento.' });
    }
});

// Middleware auxiliar para restringir rotas à Engenharia e Administradores
function restrictToEngineeringAndAdmin(req, res, next) {
    const role = req.user.role;
    if (role === 'ALL' || role === 'GERENTE' || role === 'ENGENHARIA') {
        next();
    } else {
        return res.status(403).json({ error: 'Acesso negado. Esta área é restrita para Engenharia e Administradores.' });
    }
}

// GET /api/supplier-resources - Retorna todos os recursos cadastrados (restrito a Admin/Engenharia)
app.get('/api/supplier-resources', authenticateToken, restrictToEngineeringAndAdmin, async (req, res) => {
    try {
        const rows = await dbAll('SELECT * FROM supplier_resources ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) {
        console.error('[SUPPLIER API] Erro ao listar recursos:', err.message);
        res.status(500).json({ error: 'Erro ao listar recursos da biblioteca técnica.' });
    }
});

// Helper para converter link de compartilhamento do Google Drive em link de download direto
function convertDriveUrl(url) {
    try {
        if (url.includes('drive.google.com')) {
            let fileId = '';
            // Formato: /file/d/FILE_ID/view...
            if (url.includes('/file/d/')) {
                fileId = url.split('/file/d/')[1].split('/')[0];
            } 
            // Formato: ?id=FILE_ID
            else if (url.includes('?id=')) {
                fileId = url.split('?id=')[1].split('&')[0];
            }
            
            if (fileId) {
                return `https://drive.google.com/uc?export=download&id=${fileId}`;
            }
        }
    } catch (e) {
        console.error('[DRIVE CONVERTER] Erro ao converter URL:', e.message);
    }
    return url;
}

// Helper para fazer download de arquivos em memória (Buffer) de forma assíncrona
function downloadFile(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        
        // Configura user-agent para evitar bloqueios de alguns servidores
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        };

        client.get(url, options, (res) => {
            // Lida com redirecionamentos (muito comum em encurtadores e downloads do Drive)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadFile(res.headers.location).then(resolve).catch(reject);
            }

            if (res.statusCode !== 200) {
                return reject(new Error(`Falha ao baixar arquivo. Código HTTP: ${res.statusCode}`));
            }

            // SEGURANÇA: Limita tamanho do download para evitar estouro de memória no Render
            const contentLength = res.headers['content-length'];
            if (contentLength && parseInt(contentLength) > 15 * 1024 * 1024) {
                return reject(new Error(`Arquivo muito grande para limite de memória (${(parseInt(contentLength)/1024/1024).toFixed(1)}MB, máx 15MB)`));
            }

            const data = [];
            let totalBytes = 0;
            res.on('data', (chunk) => {
                totalBytes += chunk.length;
                if (totalBytes > 15 * 1024 * 1024) {
                    res.destroy(); // Interrompe a conexão
                    return reject(new Error('Tamanho máximo do arquivo excedido durante o download (máx 15MB)'));
                }
                data.push(chunk);
            });
            res.on('end', () => resolve(Buffer.concat(data)));
        }).on('error', (err) => reject(err));
    });
}

async function seedSupplierResources() {
    const seedData = [
    {
        "supplier_name": "ANKE-YIMU",
        "machine_category": "GERAL",
        "title": "Linha de Contagem e Envase (ANKE-YIMU)",
        "url": "https://drive.google.com/file/d/1_QV7QBG5LKu9-xqb9kymxw9MmD0bSAvM/view?usp=sharing",
        "notes": "Catálogo de linhas de contagem, fracionamento e envase de cápsulas e comprimidos Yimu."
    },
    {
        "supplier_name": "HEADLY",
        "machine_category": "GERAL",
        "title": "Máquinas de Embalagem e Dosagem (HEADLY)",
        "url": "https://drive.google.com/file/d/14Hy3KyJRFimtMutRFnjxbkPF6AeKLMKm/view?usp=sharing",
        "notes": "Catálogo técnico de ensacadoras, empacotadoras e dosadores automáticos."
    },
    {
        "supplier_name": "VGOPACK",
        "machine_category": "GERAL",
        "title": "Máquinas de Embalar Cápsulas (VGOPACK)",
        "url": "https://drive.google.com/file/d/1GqmPfY3_f07AO9lAAs5B_dWWiNW37flk/view?usp=sharing",
        "notes": "Catálogo de máquinas de contagem de cápsulas, blisters e envase farmacêutico."
    },
    {
        "supplier_name": "Gurki",
        "machine_category": "GERAL",
        "title": "Robôs e Linhas de Embalagem (Gurki)",
        "url": "https://drive.google.com/file/d/1AD_-yc-D6e6a21bEvzaCGu49HpiIIFkI/view?usp=drive_link",
        "notes": "Linhas robóticas de final de linha, fechadoras de caixas e paletizadores Gurki."
    },
    {
        "supplier_name": "Yongsun",
        "machine_category": "GERAL",
        "title": "Máquinas de Arquear e Fitas (Yongsun)",
        "url": "https://drive.google.com/file/d/14CNyZDuA3rPmyaOUQ7JFO8mWMPsnOnbm/view?usp=drive_link",
        "notes": "Catálogo de fitas e arquear, arqueadoras semiautomáticas e automáticas Yongsun."
    },
    {
        "supplier_name": "AOLGE",
        "machine_category": "GERAL",
        "title": "Aolge Catalog.pdf",
        "url": "https://drive.google.com/file/d/15vbNawoOE4uMv_KEzpYvolhlSeofZ22J/view?usp=drive_link",
        "notes": "Catálogo do fornecedor AOLGE importado no lote em lote."
    },
    {
        "supplier_name": "YOUNA",
        "machine_category": "GERAL",
        "title": "YOUNA Catalogue.pdf",
        "url": "https://drive.google.com/file/d/1ufhNf4q9VzKyhr9F4NtBENjczunqpZ7O/view?usp=drive_link",
        "notes": "Catálogo do fornecedor YOUNA importado no lote em lote."
    },
    {
        "supplier_name": "ZHONGYLONG",
        "machine_category": "GERAL",
        "title": "Zhongylong numer 1.pdf",
        "url": "https://drive.google.com/file/d/1SzhAPrChlnWEMNqe_JjOwVjERlnbSnB4/view?usp=drive_link",
        "notes": "Catálogo do fornecedor ZHONGYLONG importado no lote em lote."
    },
    {
        "supplier_name": "ZHONGYLONG",
        "machine_category": "GERAL",
        "title": "Zhongylong number 2.pdf",
        "url": "https://drive.google.com/file/d/17j5lbh2tJn0yiuAbNkrVWFn99wgtKItj/view?usp=drive_link",
        "notes": "Catálogo do fornecedor ZHONGYLONG importado no lote em lote."
    },
    {
        "supplier_name": "XIAMEN",
        "machine_category": "GERAL",
        "title": "XIAMEN.pdf",
        "url": "https://drive.google.com/file/d/1ZY7mF4hgUcHGNfIMcso0ifqHU8jd4V6x/view?usp=drive_link",
        "notes": "Catálogo do fornecedor XIAMEN importado no lote em lote."
    },
    {
        "supplier_name": "HANGZHOU",
        "machine_category": "GERAL",
        "title": "HanGzhou multihead weigher and packing machine Series E-catalog20200618.pdf",
        "url": "https://drive.google.com/file/d/1KCNfYtztoEXkaOZm2J9FfHQCWOuWXt9-/view?usp=drive_link",
        "notes": "Catálogo do fornecedor HANGZHOU importado no lote em lote."
    },
    {
        "supplier_name": "RUIPACKING",
        "machine_category": "GERAL",
        "title": "RuiPacking.pdf",
        "url": "https://drive.google.com/file/d/19plWMUWl0wE7Cpw-d1oE0X1vMZ9gvCsx/view?usp=drive_link",
        "notes": "Catálogo do fornecedor RUIPACKING importado no lote em lote."
    },
    {
        "supplier_name": "NEOSPACK",
        "machine_category": "GERAL",
        "title": "NEOSPACK CATALOG(日英文版) 20230331 (日本).pdf",
        "url": "https://drive.google.com/file/d/1xiQ6K01m670pIghRKknq0UZjfATzDgaZ/view?usp=drive_link",
        "notes": "Catálogo do fornecedor NEOSPACK importado no lote em lote."
    },
    {
        "supplier_name": "DARIN",
        "machine_category": "GERAL",
        "title": "Darin pet 2026-01.pdf",
        "url": "https://drive.google.com/file/d/12QVJCFRg8OcyJ97RoHSpoRJFkJDv9B4X/view?usp=drive_link",
        "notes": "Catálogo do fornecedor DARIN importado no lote em lote."
    },
    {
        "supplier_name": "HONGCHAO",
        "machine_category": "GERAL",
        "title": "Product Brochure of Hongchao.pdf",
        "url": "https://drive.google.com/file/d/1kM1kl0JdxlzZPkLvUB6AEW_Ky1EF6G7U/view?usp=drive_link",
        "notes": "Catálogo do fornecedor HONGCHAO importado no lote em lote."
    },
    {
        "supplier_name": "Y & G",
        "machine_category": "GERAL",
        "title": "Y & G PACKING MACHINERY.pdf",
        "url": "https://drive.google.com/file/d/1drZU7Iy1MfqoLnFB_HiF72JIAKwuBJbM/view?usp=drive_link",
        "notes": "Catálogo do fornecedor Y & G importado no lote em lote."
    },
    {
        "supplier_name": "GZHMD",
        "machine_category": "GERAL",
        "title": "GZHMD machinery.pdf",
        "url": "https://drive.google.com/file/d/1aL2SyJJGYZnGJHCpyqjOzfT8DNEcGZvD/view?usp=drive_link",
        "notes": "Catálogo do fornecedor GZHMD importado no lote em lote."
    },
    {
        "supplier_name": "GZHMD",
        "machine_category": "GERAL",
        "title": "GZHMDCML.pdf",
        "url": "https://drive.google.com/file/d/1XApwT4-Qgj0G0W9W9XBtzMHQivkTg9IJ/view?usp=drive_link",
        "notes": "Catálogo do fornecedor GZHMD importado no lote em lote."
    },
    {
        "supplier_name": "HUALIAN",
        "machine_category": "GERAL",
        "title": "Hualian New Products.pdf",
        "url": "https://drive.google.com/file/d/1mYgv9LOnjdjzz4Ei9GwT0hXCgIUXb9FI/view?usp=drive_link",
        "notes": "Catálogo do fornecedor HUALIAN importado no lote em lote."
    },
    {
        "supplier_name": "HAOMINGDA",
        "machine_category": "GERAL",
        "title": "Haomingda catalogue.pdf",
        "url": "https://drive.google.com/file/d/1PB-Ilzyf_Tb9Qz33vvPNJ_vdTVKrzFdT/view?usp=drive_link",
        "notes": "Catálogo do fornecedor HAOMINGDA importado no lote em lote."
    },
    {
        "supplier_name": "HAITE",
        "machine_category": "GERAL",
        "title": "Haite.pdf",
        "url": "https://drive.google.com/file/d/1bPT-Ola__Cw5H6kL9Vg98mK2zGld7cQd/view?usp=drive_link",
        "notes": "Catálogo do fornecedor HAITE importado no lote em lote."
    },
    {
        "supplier_name": "ISG",
        "machine_category": "GERAL",
        "title": "ISG Link catalogues-cataloghi.docx",
        "url": "https://drive.google.com/file/d/1LiNv06mx4KEWLSkvoHHerUCqiUIW2nrJ/view?usp=drive_link",
        "notes": "Catálogo do fornecedor ISG importado no lote em lote."
    },
    {
        "supplier_name": "ISG",
        "machine_category": "GERAL",
        "title": "ISG POF microperforated price list ISG Pack 2018.pdf",
        "url": "https://drive.google.com/file/d/1pyPBIYPBWkqeM68U2Q7IFM5tmRaDN4nU/view?usp=drive_link",
        "notes": "Catálogo do fornecedor ISG importado no lote em lote."
    },
    {
        "supplier_name": "ISG",
        "machine_category": "GERAL",
        "title": "Pof price list ISG Pack 2018.pdf",
        "url": "https://drive.google.com/file/d/1z7qyjUs1y8yUgtyoMnAaNGxAFQM8UOzJ/view?usp=drive_link",
        "notes": "Catálogo do fornecedor ISG importado no lote em lote."
    },
    {
        "supplier_name": "ISG",
        "machine_category": "GERAL",
        "title": "ISG Stretch wrapping machines price list ISG Pack 2018 (1).pdf",
        "url": "https://drive.google.com/file/d/1qHMI2oZbAxup5gPh3ginAJs3EM31DPWi/view?usp=drive_link",
        "notes": "Catálogo do fornecedor ISG importado no lote em lote."
    },
    {
        "supplier_name": "ISG",
        "machine_category": "GERAL",
        "title": "ISG Strapping tools price list ISG Pack 2018.pdf",
        "url": "https://drive.google.com/file/d/1t-6RLlGyimltaMvBEF7jLfgFC0QpKybU/view?usp=drive_link",
        "notes": "Catálogo do fornecedor ISG importado no lote em lote."
    },
    {
        "supplier_name": "ISG",
        "machine_category": "GERAL",
        "title": "ISG Shrink machines price list ISG Pack 2018.pdf",
        "url": "https://drive.google.com/file/d/1c-7WUB9yqoo6b8h2LOjLCmt8SX7fZ_ry/view?usp=drive_link",
        "notes": "Catálogo do fornecedor ISG importado no lote em lote."
    },
    {
        "supplier_name": "ISG",
        "machine_category": "GERAL",
        "title": "Horizontal flowpack price list ISG Pack 2018.pdf",
        "url": "https://drive.google.com/file/d/1-1SQ7n0eGgc5BqtoYzmp8QGX7CYyrUEe/view?usp=drive_link",
        "notes": "Catálogo do fornecedor ISG importado no lote em lote."
    },
    {
        "supplier_name": "ISG",
        "machine_category": "GERAL",
        "title": "ISG Banding machines price list Pack 2018.pdf",
        "url": "https://drive.google.com/file/d/1AAp-s3p-i1Ps_Ad2vjWCInAM673_z-UX/view?usp=drive_link",
        "notes": "Catálogo do fornecedor ISG importado no lote em lote."
    },
    {
        "supplier_name": "ISG",
        "machine_category": "GERAL",
        "title": "ISG Stretch wrapping machines price list ISG Pack 2018.pdf",
        "url": "https://drive.google.com/file/d/17FUJJEI73GNpiwIvGuLMrQfaRORigwG6/view?usp=drive_link",
        "notes": "Catálogo do fornecedor ISG importado no lote em lote."
    },
    {
        "supplier_name": "ISG",
        "machine_category": "GERAL",
        "title": "ISGCarton sealers price list ISG Pack 2018.pdf",
        "url": "https://drive.google.com/file/d/1k1lC9d9mRctic5_aB0C0NILgiHKpawXE/view?usp=drive_link",
        "notes": "Catálogo do fornecedor ISG importado no lote em lote."
    },
    {
        "supplier_name": "ISG",
        "machine_category": "GERAL",
        "title": "ISG Case erectors price list ISG Pack 2018.pdf",
        "url": "https://drive.google.com/file/d/1Qh46t0v6BxNo4wFdV74LotDtkih-Ghhy/view?usp=sharing",
        "notes": "Catálogo do fornecedor ISG importado no lote em lote."
    },
    {
        "supplier_name": "ISG",
        "machine_category": "GERAL",
        "title": "ISG Pack 2018.pdf",
        "url": "https://drive.google.com/file/d/1XAa1zGVeLXfyH2Berraq2SMLWe_mCzhZ/view?usp=drive_link",
        "notes": "Catálogo do fornecedor ISG importado no lote em lote."
    },
    {
        "supplier_name": "HOFEN",
        "machine_category": "GERAL",
        "title": "HOFEN.pdf",
        "url": "https://drive.google.com/file/d/1iZWDvGF6Mtr60qGqsCKrx7_421Itr-dZ/view?usp=drive_link",
        "notes": "Catálogo do fornecedor HOFEN importado no lote em lote."
    },
    {
        "supplier_name": "UBPACK",
        "machine_category": "GERAL",
        "title": "Quotation_ubpack_20230707.xls",
        "url": "https://drive.google.com/file/d/1UlbM2wM1BCjKx0E7xSZaHNXHDrBTXHRu/view?usp=drive_link",
        "notes": "Catálogo do fornecedor UBPACK importado no lote em lote."
    },
    {
        "supplier_name": "MEENJET",
        "machine_category": "GERAL",
        "title": "Meenjet Laser Marking-Catalog.pdf",
        "url": "https://drive.google.com/file/d/1mabCpfG6dKdC3Mp7cavWolMLJWdUql3X/view?usp=drive_link",
        "notes": "Catálogo do fornecedor MEENJET importado no lote em lote."
    },
    {
        "supplier_name": "MEENJET",
        "machine_category": "GERAL",
        "title": "Meenjet TIJ-CATALOG.pdf",
        "url": "https://drive.google.com/file/d/1FrWqjSWM8s637P24iVVoaCRR3I-cNDYZ/view?usp=drive_link",
        "notes": "Catálogo do fornecedor MEENJET importado no lote em lote."
    },
    {
        "supplier_name": "MEENJET",
        "machine_category": "GERAL",
        "title": "Meenjet Laser-Agent-Price-P.pdf",
        "url": "https://drive.google.com/file/d/1Iw5rJtHoKnNwK5W-uCvf6WjL3RniAIvJ/view?usp=drive_link",
        "notes": "Catálogo do fornecedor MEENJET importado no lote em lote."
    },
    {
        "supplier_name": "SHISHA",
        "machine_category": "GERAL",
        "title": "SHISHAcatalog.pdf",
        "url": "https://drive.google.com/file/d/1YB0E3whEetTpJRTeb62AZ-D80YYDMLnF/view?usp=drive_link",
        "notes": "Catálogo do fornecedor SHISHA importado no lote em lote."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Catalogue-Sheet Feeding Paper bag making Machine.pptx",
        "url": "https://drive.google.com/file/d/1Vzozef8F9EJmh3vXxpC38rdy3Kd8Hlye/view?usp=drive_link",
        "notes": "Catálogo do fornecedor GERAL importado no lote em lote."
    },
    {
        "supplier_name": "URBAN",
        "machine_category": "GERAL",
        "title": "URBAN2.pdf",
        "url": "https://drive.google.com/file/d/1XZ8IAohKYHO6neJYXCQK_q9rlfTp4Uwv/view?usp=drive_link",
        "notes": "Catálogo do fornecedor URBAN importado no lote em lote."
    },
    {
        "supplier_name": "LISON",
        "machine_category": "GERAL",
        "title": "Lison .pdf",
        "url": "https://drive.google.com/file/d/1QBqOw4ShpQb4-WOcenPGzz7iQS6AarYa/view?usp=drive_link",
        "notes": "Catálogo do fornecedor LISON importado no lote em lote."
    },
    {
        "supplier_name": "ANBO",
        "machine_category": "GERAL",
        "title": "Anbo Machinery.pdf",
        "url": "https://drive.google.com/file/d/1WHUDegv3MHidahbMjfrOOiEyWEj7Suhf/view?usp=drive_link",
        "notes": "Catálogo do fornecedor ANBO importado no lote em lote."
    },
    {
        "supplier_name": "JOIE",
        "machine_category": "GERAL",
        "title": "JOIE.pdf",
        "url": "https://drive.google.com/file/d/1ql_PNN-Gx2cJDjTT7vYzj8mDQ9KhZ09c/view?usp=drive_link",
        "notes": "Catálogo do fornecedor JOIE importado no lote em lote."
    },
    {
        "supplier_name": "KITECH",
        "machine_category": "GERAL",
        "title": "Kitech2.pdf",
        "url": "https://drive.google.com/file/d/13KqsEG6gyre37_XZBQnKl5cxhNwumQMG/view?usp=drive_link",
        "notes": "Catálogo do fornecedor KITECH importado no lote em lote."
    },
    {
        "supplier_name": "KITECH",
        "machine_category": "GERAL",
        "title": "Kitech.pdf",
        "url": "https://drive.google.com/file/d/13_kCwgBCCNjcMslaUA8BCuGpvpSrN1jp/view?usp=drive_link",
        "notes": "Catálogo do fornecedor KITECH importado no lote em lote."
    },
    {
        "supplier_name": "KENWEI",
        "machine_category": "GERAL",
        "title": "KENWEI.pdf",
        "url": "https://drive.google.com/file/d/1N8_H3IPY_TEKztOFBLktkkW7grci61ys/view?usp=drive_link",
        "notes": "Catálogo do fornecedor KENWEI importado no lote em lote."
    },
    {
        "supplier_name": "KENWEI",
        "machine_category": "GERAL",
        "title": "Kenwei .pdf",
        "url": "https://drive.google.com/file/d/1rRAk-Jv18YNyWw-6lgwNaP-Dcvwv5DVC/view?usp=drive_link",
        "notes": "Catálogo do fornecedor KENWEI importado no lote em lote."
    },
    {
        "supplier_name": "TENGZHUO",
        "machine_category": "GERAL",
        "title": "TengZhuo.pdf",
        "url": "https://drive.google.com/file/d/1Szg0JEUS0v6GFgQlk_800Q5Q547MxeQO/view?usp=drive_link",
        "notes": "Catálogo do fornecedor TENGZHUO importado no lote em lote."
    },
    {
        "supplier_name": "INK JET",
        "machine_category": "GERAL",
        "title": "INK JETs.pdf",
        "url": "https://drive.google.com/file/d/1P1WhQMO_iniXPJbyT542ZjLuunoQGKAS/view?usp=sharing",
        "notes": "Catálogo do fornecedor INK JET importado no lote em lote."
    },
    {
        "supplier_name": "URBAN",
        "machine_category": "GERAL",
        "title": "URBAN-2023.pdf",
        "url": "https://drive.google.com/file/d/1fhMczI4YZJlh9frRZ7Rw9zc6i_oSEvaj/view?usp=drive_link",
        "notes": "Catálogo do fornecedor URBAN importado no lote em lote."
    },
    {
        "supplier_name": "JWIN",
        "machine_category": "GERAL",
        "title": "JWIN.pdf",
        "url": "https://drive.google.com/file/d/17Y-rZKhUHQk8WLapW976wtvKd9B3cmzu/view?usp=drive_link",
        "notes": "Catálogo do fornecedor JWIN importado no lote em lote."
    },
    {
        "supplier_name": "SUNRISEPACK",
        "machine_category": "GERAL",
        "title": "Sunrisepack.pdf",
        "url": "https://drive.google.com/file/d/1lCLLLjqeAgwyShrUITs8MtH3sKD0LSwl/view?usp=drive_link",
        "notes": "Catálogo do fornecedor SUNRISEPACK importado no lote em lote."
    },
    {
        "supplier_name": "GURKI",
        "machine_category": "GERAL",
        "title": "GURKI CATALOGUE.pdf",
        "url": "https://drive.google.com/file/d/1AKeRGGcwPELUROR3SMMe2lJSrchzC-Av/view?usp=drive_link",
        "notes": "Catálogo do fornecedor GURKI importado no lote em lote."
    },
    {
        "supplier_name": "HAIZHOU",
        "machine_category": "GERAL",
        "title": "Haizhou Catalogo 2024.pdf",
        "url": "https://drive.google.com/file/d/1Ga3-k3mSqspF2DkdV4IH_scpViylEA9F/view?usp=drive_link",
        "notes": "Catálogo do fornecedor HAIZHOU importado no lote em lote."
    },
    {
        "supplier_name": "AOLGE",
        "machine_category": "GERAL",
        "title": "Aolge Catalogue.pdf",
        "url": "https://drive.google.com/file/d/1ZaPRmrYWTlL-B8SemSMdw4oCCZiZ3X_D/view?usp=sharing",
        "notes": "Catálogo do fornecedor AOLGE."
    },
    {
        "supplier_name": "VISCOUNT",
        "machine_category": "GERAL",
        "title": "VisCount Technology.pdf",
        "url": "https://drive.google.com/file/d/18lq-B6vjE7pWGTTJ8ZCF-nMbbsLznp3-/view?usp=drive_link",
        "notes": "Catálogo do fornecedor VISCOUNT."
    },
    {
        "supplier_name": "COSO",
        "machine_category": "GERAL",
        "title": "COSO ELETRONIC TECH.pdf",
        "url": "https://drive.google.com/file/d/1MDq7CzeA6iziOpPWLtAvwlYSpADVdHcH/view?usp=drive_link",
        "notes": "Catálogo do fornecedor COSO."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Comprehensive Promotion Plan for New Products.pdf",
        "url": "https://drive.google.com/file/d/1HY_T_rm8PcL-KPIOqHgl6XWzwtdBHVBZ/view?usp=drive_link",
        "notes": "Catálogo de novos produtos gerais."
    },
    {
        "supplier_name": "FUBO",
        "machine_category": "GERAL",
        "title": "FUBO Machinery catalog.pdf",
        "url": "https://drive.google.com/file/d/1-B8rzFP7Q7YChlV_dFalW7zWhkclhhe9/view?usp=drive_link",
        "notes": "Catálogo do fornecedor FUBO."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "General_Catalog(English)_8page.pdf",
        "url": "https://drive.google.com/file/d/10_obTj_DlggGRlYHzB34WWY4zkHIQ3lr/view?usp=drive_link",
        "notes": "Catálogo Geral de Catálogo."
    },
    {
        "supplier_name": "RAMAC",
        "machine_category": "GERAL",
        "title": "RAMAC_LM-Series_ita-eng_2022_WEB.pdf",
        "url": "https://drive.google.com/file/d/1E0M_rP3NUGJ1Jf10Yh2m49L1SsVmrpjp/view?usp=drive_link",
        "notes": "Catálogo de ensacadoras/contadoras Ramac."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "catalog .pdf",
        "url": "https://drive.google.com/file/d/1E0J1KhztyHeXorE4n3dOb48_HOGdD3mt/view?usp=drive_link",
        "notes": "Catálogo Geral."
    },
    {
        "supplier_name": "DONGFENG",
        "machine_category": "GERAL",
        "title": "DONGFENG.pdf",
        "url": "https://drive.google.com/file/d/1Rzen9v3t_-fd-99gHqYLL6Ra_4zBqUSG/view?usp=drive_link",
        "notes": "Catálogo do fornecedor DONGFENG."
    },
    {
        "supplier_name": "HUIYU",
        "machine_category": "GERAL",
        "title": "BOMBAS PERISTALTICAScatalog of Huiyu fluid.pdf",
        "url": "https://drive.google.com/file/d/1dj4f0yfOUR8Y1ttUqUx6J1Aikj627JjH/view?usp=drive_link",
        "notes": "Catálogo de bombas peristálticas Huiyu Fluid."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Pre├ºo.docx",
        "url": "https://drive.google.com/file/d/1_Eu6P5Z0xAADm4m0POgnjdCaff0iBjfo/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "preço.docx",
        "url": "https://drive.google.com/file/d/1P8plVYZ6MMaau_QFI4qJ1z-ZCmXEff5f/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "PI-OY20260529.pdf",
        "url": "https://drive.google.com/file/d/1SpPvFuLki__F1G2WoqbocgKHgqDX_ZuF/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "þô»ÞÂè-ÚçìÚçÅÚÇëÕê½µ£║CW30kÞï▒µûç.pdf",
        "url": "https://drive.google.com/file/d/15RQvgkL2PEl8IeMxwyTIeajvkuTHbDaF/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "CW400 260528 (1).pdf",
        "url": "https://drive.google.com/file/d/1CVdOAeAQTiITwknhXqIChLS8LfdYGGlK/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation of NG-709 Conveyor Belt Checkweigher Machine.pdf",
        "url": "https://drive.google.com/file/d/1CwYzon_pbE-XiQBSsyuHWxos19BCKsYt/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ZL-4019 Check Weigher(400mm).pdf",
        "url": "https://drive.google.com/file/d/1MPAMlzWXkK6yUODDUXSTIaVVoBqyzIev/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation  of Cereal  Bar Making Machine Processing_Machine.pdf",
        "url": "https://drive.google.com/file/d/1WRRzOmbhRJ43Rb5nGgkjC4TBncTX5AR6/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "HONGCHAO",
        "machine_category": "GERAL",
        "title": "Quotation on 2026.05.13´╝êvibratory bowl feeder for plastic spoons) Hongchao Automation.pdf",
        "url": "https://drive.google.com/file/d/1o-Vxe1JjOFNzoK7HZOSMGjsuUzrd1d8x/view?usp=sharing",
        "notes": "Cotação comercial do fornecedor HONGCHAO."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "TCJ0815.B.4  Autoclave Industrial Retort.docx",
        "url": "https://drive.google.com/file/d/1mwGjHPv50n-HaF9ME3qAMjQ8lgamapvH/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "TC12-3.6 Autoclave Industrial Retort .docx",
        "url": "https://drive.google.com/file/d/1ZmFb2F0DCt3cWfnJ-qmV5PEzeBsjbanl/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "PLJ0815.B.4 retort quotation - 0415.pdf",
        "url": "https://drive.google.com/file/d/1svdQ8jtSrGYffCEabQbwLXarYZuK0pCK/view?usp=sharing",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "PL12-3.6 retort quotation - 0415.pdf",
        "url": "https://drive.google.com/file/d/1Uh_3EuU6aT-T0kXeK5bbFkITJco2ijLI/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "EW300-4000g.docx",
        "url": "https://drive.google.com/file/d/1ZjTcvCQ1vexWjZzArnkgJrxO8iStDrLm/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation-Weight checker.doc",
        "url": "https://drive.google.com/file/d/1yAzc-OSc88BWBfW48AiAPUzwTe_dpI5i/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "QHB",
        "machine_category": "GERAL",
        "title": "Offer-QHB-600 Fully Automatic Hard Soft Biscuit Prodcution line with Gas tunnel oven+3+2Sandwich Machine+Chocolate Enrober+Metal Detector.pdf",
        "url": "https://drive.google.com/file/d/13Lzzw4D85jK-BJG5EZu4BPpQy1Kuh8sf/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor QHB."
    },
    {
        "supplier_name": "HANYUAN",
        "machine_category": "GERAL",
        "title": "HY-Quotation of the Energy Bar Production Line-HANYUAN MACHINERY(20230703).pdf",
        "url": "https://drive.google.com/file/d/1LXqverZkOzH-0tpIcDMtf2Uoq3S0ZxCl/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor HANYUAN."
    },
    {
        "supplier_name": "HANYUAN",
        "machine_category": "GERAL",
        "title": "Quotation of HY-Automatic Protein Bar with Chocolate Coating Production LineÒÇÉHanyuan MachineryÒÇæ.pdf",
        "url": "https://drive.google.com/file/d/1mQ1D0hT6S1zwrMMwpQxbCs9KJDPo4GxQ/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor HANYUAN."
    },
    {
        "supplier_name": "ZPTF",
        "machine_category": "GERAL",
        "title": "(U02B250528)Quotation of ZPTF550 -76MM-200g.pdf",
        "url": "https://drive.google.com/file/d/1-wdC3FFQErQpuw6ugyO2RFNIy2if3iKw/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor ZPTF."
    },
    {
        "supplier_name": "HANYUAN",
        "machine_category": "GERAL",
        "title": "How to choose different cereal bar production protein bar line(Hanyuan Machinery).pdf",
        "url": "https://drive.google.com/file/d/1mUSIkbKU3RvSaaP5Wgc7j4JGKstcfb8D/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor HANYUAN."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation Of Temp Humidity Chamber(408L). date250507.pdf",
        "url": "https://drive.google.com/file/d/13oZHNwW5cw8EbdbHuzIqAT0MWr6kKYB5/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "0626-Quotation for Automatic nutrition bar.xls",
        "url": "https://drive.google.com/file/d/1tX3jz4lVCLJrHJkoJW5nVI991jGp47nz/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Amassador.docx",
        "url": "https://drive.google.com/file/d/1aRSeinoAAwctc9hdC283KWCZOwRb6mgi/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Sistema de embalagem automatico.docx",
        "url": "https://drive.google.com/file/d/1FGnGTKYezbTSN3Z5q90XUrPK6Xxubgel/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Cópia de (U02B25)Quotation of 6-head extrusion molding and cutting.xlsx",
        "url": "https://drive.google.com/file/d/1CzVhXjvbJQd4oUaIGZ1MrIZux2QSUA-e/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Cotação.xlsx",
        "url": "https://drive.google.com/file/d/1tXJyle1gSDBI0UiMItuouKr59rtyDSi3/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "UBM",
        "machine_category": "GERAL",
        "title": "UBM550.xlsx",
        "url": "https://drive.google.com/file/d/1Gviq3DhpQ0GvMlpXVtqXKqVyX2wQgk6E/view",
        "notes": "Catálogo técnico do fornecedor UBM."
    },
    {
        "supplier_name": "UBM",
        "machine_category": "GERAL",
        "title": "2023Nov-Quotation of UBM420-31D.docx",
        "url": "https://drive.google.com/file/d/1_QJSjPBf6UjDJ5dmrGj4DbmYAs3GHvUy/view",
        "notes": "Cotação comercial do fornecedor UBM."
    },
    {
        "supplier_name": "UBM",
        "machine_category": "GERAL",
        "title": "2023Nov-Quotation of UBM550-39D.docx",
        "url": "https://drive.google.com/file/d/1NW5ULPLbjxMw81G-_IipMfUyJFfZdnTJ/view",
        "notes": "Cotação comercial do fornecedor UBM."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ZP9-Tablet Press Machine Quotation ZP-9B.pdf",
        "url": "https://drive.google.com/file/d/1_ZHmjSijN7jMe0y5OgVslMLtkPBgCiaY/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "2023Apr-Quotation of cookie machine.pdf",
        "url": "https://drive.google.com/file/d/1aeYBOHHKkWRUML0B7wykVk8b9KKVwZVY/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "cookie machine.pdf",
        "url": "https://drive.google.com/file/d/16sZxnouZEqFVSNjMnaRu_wH89EF-Z8xZ/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ZP420-27 Model effervescent tablet press machine catalogue.pdf",
        "url": "https://drive.google.com/file/d/12FuiqPJ5j4QVnS6G1_RhJ1KOquzE1aLP/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Informações e preço.docx",
        "url": "https://drive.google.com/file/d/1UYolESmeNpkv3WinPjTEV2n0P9rUwdRs/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ZP-25 Rotary effervescent tablet press machine catalouge.pdf",
        "url": "https://drive.google.com/file/d/12Cwn3tYnSexhVd5FzpefqUIA9DHC2kAb/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "´╝║´╝░´╝¬´╝ì´╝ö Intelligent Four-function Tablet Tester catalogue.pdf",
        "url": "https://drive.google.com/file/d/1bw5o_rM7RVq19EqFP1J4gVmtu6XtAWcg/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Pre├ºos.docx",
        "url": "https://drive.google.com/file/d/1ytSGvMoiFM-gguab3jve2RqGStLn_Oy4/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "DP-12(50) single punch tablet press machine.doc",
        "url": "https://drive.google.com/file/d/15LzMTPBBMMGWxE9kpfR1g9n_mj5LDSNH/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "tablet deduster(downhill and uphill type).pdf",
        "url": "https://drive.google.com/file/d/16zWLMOxkUN8gwk7In9I6SS3-hOUYBIvz/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "2_GZPK-26(Vacuum´╝îUphill/Downhill,Metal Detector´╝ë.pdf",
        "url": "https://drive.google.com/file/d/1lY8kvC_sNEzkX7ScAQZDhneJJhqs30yN/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Cotação do e-mail.pdf",
        "url": "https://drive.google.com/file/d/1jLsyuKcLVqPN9MngXyDiwiTOAhVnDGhG/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "GZPK370-26 Model Automatic high-speed tablet press machine catalogue.pdf",
        "url": "https://drive.google.com/file/d/1uTwejZVPaNgLdBR-na4xN9Ob4qPM4WKz/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "0809-Cereal bar line quotation.pdf",
        "url": "https://drive.google.com/file/d/1Zc7o9xQkE9atYiBvYgfHNKfyx6PIb96L/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Informações Gerais e preço.docx",
        "url": "https://drive.google.com/file/d/1Plqx6_mlh7wAeTCIIHvwpOdkRGBcOU95/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "DGR",
        "machine_category": "GERAL",
        "title": "DGR-F2 Rotary type coffee capsule filling and sealing machine catalouge.pdf",
        "url": "https://drive.google.com/file/d/105GGlv6ek8ovOkewTiCRMYV_n2D710Jw/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor DGR."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Pre├ºo em 25-03-2021.docx",
        "url": "https://drive.google.com/file/d/1pdL9Ee4Zd3kGdmAJDTWGf-AhCvp2F7bw/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "WQ",
        "machine_category": "GERAL",
        "title": "WQ-500 NON WOVEN APRON MAKING MACHINE Catalogue.pdf",
        "url": "https://drive.google.com/file/d/1OefNFnqaXMoqAgy9JdkcolgJ_XgBg8G3/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor WQ."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ZPW-17 special.pdf",
        "url": "https://drive.google.com/file/d/1qNAk2zSmT01D-XDhIAjzusuPinKz4BnF/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "GZPW23D machine details.pdf",
        "url": "https://drive.google.com/file/d/1KAf-a1iF-_aQMzTBEnI11Um1p7HEjRto/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ZPT420 27D Effercent tablet press machine catalogue.doc",
        "url": "https://drive.google.com/file/d/1ZYEFpJ00_xTR3Pv6o4X7Rhuh2pMc7i3M/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Cotação.docx",
        "url": "https://drive.google.com/file/d/1DfoyB21I7S65fZm20fIY2yNLbYG79jXK/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "YD-188 Drip Coffee and Tea Bag Packing Machine.pdf",
        "url": "https://drive.google.com/file/d/1910yrinllYNrgyE8lyw8HkXFvyMNQ5J2/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ZPT420-31D Rotary tablet press machine catalogue.pdf",
        "url": "https://drive.google.com/file/d/1V3Mwf-s1dpGgxriA7QLHM8sLBPNIiIMo/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Assistant device for automatic capsule filling machine.pdf",
        "url": "https://drive.google.com/file/d/1V33kksr_pN4DdKZ6xdM605RSrUFCASHH/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ZP5 7 9 11 Rotary tablet press machine.pdf",
        "url": "https://drive.google.com/file/d/119A8Ho2x7ckn88TIGfRS6SK6EsvSf5r0/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ZPT-15D(╬ª226).pdf",
        "url": "https://drive.google.com/file/d/1ONAJzIL2EzfeOVPnDjPl8V5FQ6gy25UJ/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ZPT15D and ZPT29D ROTARY TABLET PRESS.doc",
        "url": "https://drive.google.com/file/d/1c8PoIuEaq6buEPy8kBOyd15VV6fZl654/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ZPT39D Rotary tablet press machine catalogue.pdf",
        "url": "https://drive.google.com/file/d/1Dad6gz-5gTUwbvhvyeSWTMtEB56ZaLFb/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ZP420-(23D)(25D) EFFERVESCENT TABLET ROTARY.DOC",
        "url": "https://drive.google.com/file/d/1AvjZUsCh5hSLERfQBHWmT28fV1hV3F8B/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "TDP",
        "machine_category": "GERAL",
        "title": "TDP series single punch tablet press machine with CE certificate.pdf",
        "url": "https://drive.google.com/file/d/14N7RyuygvtA3X5ZndnC2n_vU85cQTrYz/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor TDP."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "20260626-C8-202 Quotation for an Integrated System Single-Station Bag-Feeding Machine Paired with an Oversized 2-Bucket Linear Weigher (1).doc",
        "url": "https://drive.google.com/file/d/1ghK7TXACR8CBUSMLVMTqtJS_FYOSo8IZ/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "2026-0626 Quotation 1 Bowl Counting And Desiccant Bag Feeding Packing Machine.pdf",
        "url": "https://drive.google.com/file/d/14qZI_v2qgBN3UI6h0hrg7rdagIJcvoBb/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "AFPP300Y2 - EMPACOTADORA .pdf",
        "url": "https://drive.google.com/file/d/1cl2xLq2kKqSIZ11flhuI3ZT957Hgf5sx/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "4 vias stick Quotation20260417-11.pdf",
        "url": "https://drive.google.com/file/d/1K3GQvCOhCfS5QAPeOczBCzb8Um4RPSd3/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "AFPP-280BK-4 - 4 vias stick Quotation20260417-1.pdf",
        "url": "https://drive.google.com/file/d/1Qsic3NLDb5uoUAsb2HXiLP3F3BxrqMk1/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation of DS-1020AZ pellet packing machine from Dession Rita(2026.05.26).pdf",
        "url": "https://drive.google.com/file/d/1MTt-9bzkPF6OnvATOzitJVlHed09kl0b/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "D-160 envasadora de liquidos automatica para sacos pre formados.pdf",
        "url": "https://drive.google.com/file/d/14X-pzACGmL03nALSzzaqmTp2vPREuQEo/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "2026-0521 Quotation of 2 Bowls Tablets Counting Packing Machine (1).pdf",
        "url": "https://drive.google.com/file/d/1xUGFNAGPkr3UNISHBz2YE0p6bRgmXJ8T/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "15-20KG Wood Pallets Packing Solution- Inclined conveyor+1200 VFFS +2 heads linear weigher.pdf",
        "url": "https://drive.google.com/file/d/1o7D_ict8L70pV27VosSZ08Z_DZnIkIeP/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "AFPP620G - .pdf",
        "url": "https://drive.google.com/file/d/1xuCeIcKRFEFF70DZqYVAkE0HnsVYdf02/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "KL-300I Double feeder Lollipop Automatic Sachet Packing Machine. quotation list. 260507.pdf",
        "url": "https://drive.google.com/file/d/1IvTBNZ3ca-zxw_e1apK84eLNMGFZO9Ho/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "AFPP720DH-6 EMPACOTADORA .pdf",
        "url": "https://drive.google.com/file/d/1K9faeaPeae4NMGKNk97bGtKlJRpuKeiU/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Pre├ºo filme- sacos express packing.docx",
        "url": "https://drive.google.com/file/d/11QdhqfO_NN95G3uI86_9ImpCVxt4KjUe/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "LOGIPACK - express packing machine.pdf",
        "url": "https://drive.google.com/file/d/1eEQ28icBDPKHOSrj2zdCPLnQKf_u5pm8/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "LOGIPACK -Quotation-Express Packing Machine.doc",
        "url": "https://drive.google.com/file/d/1JHDHIJxOioKR0rD-y2BJYqcCpUh9XiaC/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "KENWEI",
        "machine_category": "GERAL",
        "title": "Quotation List - KENWEI.pdf",
        "url": "https://drive.google.com/file/d/1NmnvPL8WiopaA0vNlqOmhUyOePp2J4Aw/view?usp=sharing",
        "notes": "Cotação comercial do fornecedor KENWEI."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "1_The quotation of GH240BF powder packing machine - .doc",
        "url": "https://drive.google.com/file/d/1PZ3GLsr47CMBfyJvL410NOBhJYpPuSQx/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Powder Back-sealing bag packing machine - Auger feeder (1).pdf",
        "url": "https://drive.google.com/file/d/1vCajFiqZsaZos237BN5GkRfNWbqMIzWE/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation20260301-2 Update.pdf",
        "url": "https://drive.google.com/file/d/1lvHgE1aYxSnOR1y-gsAPBN64T5YnNpjZ/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation20260301-3 Update.pdf",
        "url": "https://drive.google.com/file/d/18jazElD_I76XgoGXpAi2_QmrzQJEcYXG/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "AFPP-960DH-8.pdf",
        "url": "https://drive.google.com/file/d/1FxE_jzOJ0u1aYHEk5k7za_rx5j5K8Q0K/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "SED-T16SP Gummy Counting Machine.pdf",
        "url": "https://drive.google.com/file/d/15pZAoiUQuiTEakOBz-_qjQ4_5UI7WCvV/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation-SR-FSF900D 4 line 4 side sealing machine 2026.01.14.pdf",
        "url": "https://drive.google.com/file/d/1_hzXJAQkwVizkGUZO4_Ed894_8tzTkV_/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation-SR-FSF900T 6 line stick pack machine 2026.01.14.pdf",
        "url": "https://drive.google.com/file/d/1u3semptWvbaW941mPVvhl31-fPxGOGcR/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation-SR-FSF900T 4 line stick pack machine 2026.01.14.pdf",
        "url": "https://drive.google.com/file/d/1U3VH8PaQAlhRwpp3XszibZupHSnITWOM/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation 2 lines -SR-FSF300T-2026.01.29.pdf",
        "url": "https://drive.google.com/file/d/14B8V4spkDZhmF0aZmffxJUt9J7vA02Wj/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Info.docx",
        "url": "https://drive.google.com/file/d/1fqniRKOL4bTeJdaAsGtUjxeXnb7dIR9M/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quote-Tecfag-260203 (1).pdf",
        "url": "https://drive.google.com/file/d/16OUZR6NX0SMG798xC_bdp_XyrwXPDWYi/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "2026T020201.pdf",
        "url": "https://drive.google.com/file/d/1FEfkRkx6b8qauMU6Eeil7orFQzXvFOQS/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "paper printing cost.docx",
        "url": "https://drive.google.com/file/d/116pDHGD_Kof9tHNxa0GJsrxkQlxP1GZV/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Cotação.pdf",
        "url": "https://drive.google.com/file/d/1nmhpQLjuLsFO6ycAcM5q7MBKF90OGf2p/view?usp=sharing",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "UBM",
        "machine_category": "GERAL",
        "title": "standard UBM-16D speed capacity.docx",
        "url": "https://drive.google.com/file/d/1CBPdYes06LbEAcGLX8EJ2f1TzWfOY3m_/view",
        "notes": "Catálogo técnico do fornecedor UBM."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "GENIUS 8-16 PLUS Quotation for special gummy counting machine.docx",
        "url": "https://drive.google.com/file/d/1fpQkfjh76UulpX-xGgf5wlIl_blmyFcT/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "BG-400E Quotation Coating machine).pdf",
        "url": "https://drive.google.com/file/d/1LOZGGBLwS72Xr3bP0NQiafG_jWS9B_p3/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quote for Lawnmower.pdf",
        "url": "https://drive.google.com/file/d/1S91dhX4HRACo_sA75iPVn9oXsiFR07Qy/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "UBM",
        "machine_category": "GERAL",
        "title": "0123-UBM-180S fully servo model.pdf",
        "url": "https://drive.google.com/file/d/1XjFxq6DctKwK5A9GFmI8JBOIosBNTjN3/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor UBM."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "SW-6L Full Automatic 6 Lines Powder Stick Packing Machine.pdf",
        "url": "https://drive.google.com/file/d/1PWgJdcVPunGGctB0lh76YBXWNooNdeVr/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Cotação.docx",
        "url": "https://drive.google.com/file/d/11CIQZz-NonIysmSVx7DXHOSY6R2Uexyv/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "PROJETO LINHA DE ENVASE SERVO MOTOR.docx",
        "url": "https://drive.google.com/file/d/1eDe_IW1vBLGUEDYkAbKOVq_2D6lcqi-b/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Multihead weighing bottle packing production line. quotation list. 220719.pdf",
        "url": "https://drive.google.com/file/d/1lKjkpjHn-S0T_5L3c-tAMwx4XY4VQlUe/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation list for film coating machine.pdf",
        "url": "https://drive.google.com/file/d/1d-AyaQQXRYkEEBMUEaih05dTF8m7mz4v/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Pre├ºo.docx",
        "url": "https://drive.google.com/file/d/1_A349ajJ2SM3U2N3yHQHW9U0NIbUpUv2/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Cotaçãodeduster.docx",
        "url": "https://drive.google.com/file/d/1TFYEOtnqRt6UpYNvWwgMWr3pfBXAsHLX/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Price list of BG Series automatic tablet coating machine.docx",
        "url": "https://drive.google.com/file/d/1-YcqMeAfozaDOnveapSc3xRNedadwZVy/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "UB-12 counting production line.pdf",
        "url": "https://drive.google.com/file/d/1ACSqPeC9De53iJe9sqHERPhZLQ8-CNOw/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "SW-320C 4 Heads Weigher Gummy Packing Machine.pptx",
        "url": "https://drive.google.com/file/d/1BjKDuhSGT6Kd3oCAnLHdYu2Ib12ongUz/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "High Efficiency Film Coating Machine.pdf",
        "url": "https://drive.google.com/file/d/1gdPYJSc52qT3NUu4C6SUbNOoPZdYVpN5/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "SJB-06 triangle bag inner bag and outer bag integrated machine.pdf",
        "url": "https://drive.google.com/file/d/12WzmrF-xqs5fSS47M9V_JHTD39-lztIq/view?usp=sharing",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "GD8-200B Rotary zipper bag packing machine for herb tea.pdf",
        "url": "https://drive.google.com/file/d/1aCnsOXyOpLSr54mOg7K0_wgJwsICNIbS/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "KL-420 Automatic Peanuts VFFS Packing Machine catalougues.pdf",
        "url": "https://drive.google.com/file/d/1T8a06Hg5F1RV_oEdhPgUg6W2U5TzeVCm/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "soft candy bottle packaging production line.pdf",
        "url": "https://drive.google.com/file/d/1R9HYaHdz-ggL-qEPZzsNCYweUKZ5j41s/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Automatic High speed tube bottle counting machine for effervescent tablet.pdf",
        "url": "https://drive.google.com/file/d/1Vq2_xKzM9wjGBd_gPm61cz8xyuVuNvhi/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ZPP-40A effervescent tablet tube packing machine .pdf",
        "url": "https://drive.google.com/file/d/1i8LXoYH7NjXzDg7lY3JkP7LAGD7Za-m6/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Pre├ºozp60.docx",
        "url": "https://drive.google.com/file/d/1RPUTiCPaNqd_gbKF3erpnCCh0HErAXkc/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ZPP60 Effervescent Tablets Tube Packing Machine.pdf",
        "url": "https://drive.google.com/file/d/11StXYu_U3u_FaiaHLLMkZPEcymVywWCJ/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ZJS-A Electronic Capsule Counter.pdf",
        "url": "https://drive.google.com/file/d/1PsOQTK5fa3sqBSxair1wDWuV-pilq_Oq/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "YL series counting machine details.pdf",
        "url": "https://drive.google.com/file/d/17aW6bWYrVCALz0ZWShnA4UEfUuXbijoS/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Cotação LFP-150 High speed vertical capsule polishing machine.pdf",
        "url": "https://drive.google.com/file/d/1fXtTqs4tbcfRDHHA44PRoaoeJrZtUitx/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "JFP-110A Capsule polishing sorter machine.pdf",
        "url": "https://drive.google.com/file/d/1OFTRUWV2jKc6GVSLGmptUDX1dcjKKsux/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation for DXDC-21DX Pyramid tea bag packing machine with outer envelop 20190725.pdf",
        "url": "https://drive.google.com/file/d/143xQQju9O0WLk7nf-v4CpreGWdCxJzTX/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "YL Series electronic tablet capsule counting and filling machine.pdf",
        "url": "https://drive.google.com/file/d/1DRL7Eb1A5ct-TfULYOCFsy6G2vTlPMdD/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "YL-2(4) electronic tablet capsule counting and filling_machine opration manual.doc",
        "url": "https://drive.google.com/file/d/1ua4bw64zNxELeW1Sn5iIuzJwO7E0wNPF/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Grepack Quotation for HC-180SPX Doypack Form Fill Seal Pouch Packing Machine 202606 (1).pdf",
        "url": "https://drive.google.com/file/d/1Tv5MYLopxf_2a67dC2juWNGWFTmRLjM-/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "cotation.pdf",
        "url": "https://drive.google.com/file/d/1Ab_7xaEkP9pqfR7tt9gKnwFnfR-lkprO/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Preliminary Quote.pdf",
        "url": "https://drive.google.com/file/d/1NoPlH6tueNidRlWda6I_AgemqmbGTicV/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "INFO Packaging Machine-RL-DZ..docx",
        "url": "https://drive.google.com/file/d/1Uo1PjszNZiG7bbgd62iXfYbBRix3wMch/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Secondary Packaging Machine-RL-DZ.docx",
        "url": "https://drive.google.com/file/d/1c-Z73qrrWXEFZ2HtzJybRq71f2gmHDpq/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Pre├ºo BG2.docx",
        "url": "https://drive.google.com/file/d/1-igHvw61xSUBzYUGj6nYhD-shkU9hQz8/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "BG2 6 automatic cup filling sealing machine catalouges.pdf",
        "url": "https://drive.google.com/file/d/159Z2PJ5sifvRsixRWgWUM9PUIcuFqmaj/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation of HTC-2 Rotary Cup Filling Sealing Machine.pdf",
        "url": "https://drive.google.com/file/d/1zNWQ8qj47j2AvBMaFkaH-xML1y6vKhtl/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation of HTC-1 Rotary Cup Filling Sealing Machine.pdf",
        "url": "https://drive.google.com/file/d/1I7_MlQquESkyDd6XuRFshZAatZzS7YCO/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "1.0-8 heads gravity filling machine.pdf",
        "url": "https://drive.google.com/file/d/1G1pkprGFHTslnkbb0l1y6pg5SYMckSFj/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Oil Filling Machine Quotation Sheet.pdf",
        "url": "https://drive.google.com/file/d/1iiXK2GfXT0e8uLUZ9IQndqWyb9WVypeZ/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation for Semi-automatic bib box bag filling machine260512 (2).pdf",
        "url": "https://drive.google.com/file/d/1Bdu1LSGwwa9JGrasUQeenx7fXI5I2UUv/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "filling machine quotation (3).pdf",
        "url": "https://drive.google.com/file/d/1dOANkSM6Ta2OynvwAzolqA3DCS4M2oPk/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "APL-Automatic Bag Loading And Cartoning Machine (1).doc",
        "url": "https://drive.google.com/file/d/1lAkX3bGMyuxxK2H6pg5uHOrERIEgftiC/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation-Syrup Filling Line & Cartoning machines-V0402.doc",
        "url": "https://drive.google.com/file/d/11NWUC_kyJpg1j25SxFWWfHW814WOrgvS/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation-Automatic Shrink Wrapping Machine .doc",
        "url": "https://drive.google.com/file/d/1xXkVcAZPJ2Ig40zLPR1mBelVBvrpz9As/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "MIC-LL60 Auto Dropper Bottle Filling Capping Labeling and Cartoning Machine 26-03-20 (1).pdf",
        "url": "https://drive.google.com/file/d/1vWG_bTCJaCv-8vz7wvyaqr3dI5Snd8_F/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Rotation table for Syrup filling capping labeling machine.pdf",
        "url": "https://drive.google.com/file/d/1F8NHOvvNJX_3uA665mrJvtbIVxwsQey1/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "QUOTATION-BZH-50 Automatic cartoning machine.doc",
        "url": "https://drive.google.com/file/d/11--N7_isvxXgcyhQMI5Z1j6cqciCgm2_/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "QUOTATION-BZH-120 Automatic cartoning machine.doc",
        "url": "https://drive.google.com/file/d/1y39cAmqLpPIyZwhMq8XRxwkhQhi0W1qL/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "4000CPH@350ml Canned Protein-Enriched Carbonated Beverage Filling Machine.pdf",
        "url": "https://drive.google.com/file/d/1zeafFhhJqVp-9Jazbqz1GPNjwGKfzrNC/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation_Gilson Donato (1).pdf",
        "url": "https://drive.google.com/file/d/1AV257W4a0KSYGyHg1ssEnvB_QVqqS-O8/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "IVEN Essential oil filling line Quotationl-Sarah-WeChat3.pdf",
        "url": "https://drive.google.com/file/d/1gUJ1KvFYlTkgmN3czCCmNKhdNMhmRHjj/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "AUTOMATIC PET BOTTLE MINERAL WATER FIILING MACHINE.pdf",
        "url": "https://drive.google.com/file/d/10kvzjLcNPxhH-qnMXz4NLEUGB_JUth4V/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Automatic round bottle sticker Labeling machine.pdf",
        "url": "https://drive.google.com/file/d/1ziWOo58ZGC2B9l6Jetd4oh6Xvs6FqH-X/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation of 4 head-liquid filling capping details.docx",
        "url": "https://drive.google.com/file/d/1MBLYxpJASdQ82yq1pUklXLJqVb3v6ZsN/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation of Essential oil bottle filling packing line.pdf",
        "url": "https://drive.google.com/file/d/1vEgCbomEmqClw8tHmwizhVFEm4FGr_Lg/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "YETO -2)-Quotation of Perfume making and packing machines-25.11.9(1).docx",
        "url": "https://drive.google.com/file/d/1i4v5wTLyXfndqXsOQ1HP-wyzp0PsOjLv/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "16000BPH500ML PET Bottle mineral water filling machine line.pdf",
        "url": "https://drive.google.com/file/d/1ymjNOESEIdIQCNsyIt0IDE9sTgcx28bb/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "NJP4000D Quotation Sheet.doc",
        "url": "https://drive.google.com/file/d/1km2XL-q7TjEZAm4Pm33sWWLWpqY3Bqp5/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Union Liquid-Quotation of JTJ-A Hard capsule liquid filling.pdf",
        "url": "https://drive.google.com/file/d/1dMQhpgcHEFZIEs-7baK0xPtqu_wDuddM/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "2023Dec-Quotation of 12 servo pump filling line.pdf",
        "url": "https://drive.google.com/file/d/1oA_qkQJ-vdNOPgymApryu-ZOHLvHRIRJ/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Nov28-Quotation of 4 peristaltic pump filling double head capping.docx",
        "url": "https://drive.google.com/file/d/1DV-FgciqyY5nJkB1RmsBncUqXiMCrOWh/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "priceGGS118.docx",
        "url": "https://drive.google.com/file/d/1snfnps65-bvsB5BUpoy1bYU_HzhdR6D-/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Glass Ampoule Filling And Sealing Machine.pdf",
        "url": "https://drive.google.com/file/d/1dIYqAdXIjt4JfiuczC498swJva-xOoBh/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Filling line--HZPK--2022.3.19.xls",
        "url": "https://drive.google.com/file/d/1nhqpJWmN4Bpq6psa9ZhzoAq28Jncss-5/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "QGQ750 Automatic Aerosol Filling production line quotation list-210323.doc",
        "url": "https://drive.google.com/file/d/1dz-CxfWx6KeBZeG2Qq-z4gKaFRxzhhTg/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Pre├ºo SG-1D.docx",
        "url": "https://drive.google.com/file/d/1TT4yOJ2di_Mx6O7pOr5_FDeurtovJJjm/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "SG-1D Liquid bottle filling and sealing machine.pdf",
        "url": "https://drive.google.com/file/d/1Ubp8SsDsnrA44PR-lZi5spPttMdtCe4R/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "NJP-2500C(new).pdf",
        "url": "https://drive.google.com/file/d/14kxeQNGPRESMD8y1xh2BURARmQER-kix/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "LZH-120D and ZH120D automatic sachet cartoning machine catalogue.pdf",
        "url": "https://drive.google.com/file/d/1SP70x0SsbR58xLNi06jxYAsRLXWE2ohx/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Pre├ºo.docx",
        "url": "https://drive.google.com/file/d/1yK1-yGTaG5jJZQIIcuJ4b5ariY4iLzWs/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "WZH-130 Automatic cartonning machine and pillow bag packing machine catalogue.pdf",
        "url": "https://drive.google.com/file/d/14tWlxolBNbrLQQqOB5Q6f-wfNi9Q4bQF/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "DZH-120 mask box packing machine.pdf",
        "url": "https://drive.google.com/file/d/19KQ67Kb0VsUaGvQ8d6G6zbXe4X91uoD8/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "JTJ-A Pro model.doc",
        "url": "https://drive.google.com/file/d/1cVttqTVXs5LEykEFudIzkA2rAyS5ZCv3/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "NJYF300C liquid capsule filling and sealing production line_catalogue.pdf",
        "url": "https://drive.google.com/file/d/1zR1UUlM6MBU8fKUfaptsx4LBqngPzRwo/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ZH-50 multifunctional semi auto vertical cartoning_machine.pdf",
        "url": "https://drive.google.com/file/d/1FzuxgjdNCApwfMPyYITn8JjjRtW1SN_x/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ZH120P Automatic cartoning machine for bottles.pdf",
        "url": "https://drive.google.com/file/d/1H9uwgB2aT_gF-RdywB3wLJFSR9AGt-uS/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Price list for NJP series automatic capsule filling machine.19814.pdf",
        "url": "https://drive.google.com/file/d/1OxaD7SPj0gv_RBj_IFd-HWqfU-OJCNY2/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "LZH120P Automatic vertical type cartoning machine for bottles.pdf",
        "url": "https://drive.google.com/file/d/1Pyd-mLxE1lsMu191IaO9kJGlcwQhn2LZ/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ZH120 Automatic cartoning machine for blisters board.pdf",
        "url": "https://drive.google.com/file/d/1DS-g47dq-NvScr2qPkXLtK9-SPVhuzFV/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "GGS118´╝ê240´╝ëPlastic ampoule liquid packing machine. complete version.pdf",
        "url": "https://drive.google.com/file/d/1OjFyxLL8J5s3RptgAFh6H2iesYKzKHXV/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "AOLGE",
        "machine_category": "GERAL",
        "title": "Aolge AG-600X heat shrink packing machine.pptx",
        "url": "https://drive.google.com/file/d/1B_jqT1Fw8YOXh2kpXH5hnEYaIE9CFpE2/view",
        "notes": "Catálogo técnico do fornecedor AOLGE."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "600X heating shrink packing machine.png",
        "url": "https://drive.google.com/file/d/1PJ_h8jWr4dphkMI_fhIl9GSYiHw44sP9/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Box motion top-feed film pillow packing machine.png",
        "url": "https://drive.google.com/file/d/151gsbyQexSDLgR_Y5K6-BUeHDTwMsUVT/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "rotary cutter flow shrink wrapper.docx",
        "url": "https://drive.google.com/file/d/1kVgUpqOz8cN_m7O3O454tMOLGOnFxF_I/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "AOLGE",
        "machine_category": "GERAL",
        "title": "Aolge Quotation of 600X Pillow heat shrink packing machine.docx",
        "url": "https://drive.google.com/file/d/1saz5vKtxR9ePHd_LXcuDGkMG4o281q-h/view",
        "notes": "Cotação comercial do fornecedor AOLGE."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "LSU350 Auto sorting counting & flow pack machine.pdf",
        "url": "https://drive.google.com/file/d/1kmA0aI_-1CpyirgAYC9l__MuIlGeOobV/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "TEFUDE quotation´╝ê20260622´╝ë.pdf",
        "url": "https://drive.google.com/file/d/1X5KgqL8iONxLyLzEXOxE8QQIWnRH5ZRZ/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "100kg Pet Treat Cold Extrusion Machine with Single Head Cutting.pdf",
        "url": "https://drive.google.com/file/d/1DKmbQYX01Tx31Dx4A0iOqqj5Lc34qU7x/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation for Customize ZX300 Counting +Flow packing line.pdf",
        "url": "https://drive.google.com/file/d/1LLtle1T29GYSkRY56knvzPUaj8TYT3kg/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "quotation of snus production line.pdf",
        "url": "https://drive.google.com/file/d/1tvrdmWEZ55LJtBfIJJ0wMxt74SJHvyjK/view?usp=sharing",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "AFPP300Y-2.pdf",
        "url": "https://drive.google.com/file/d/1zMTPDEq6Htg0a6XEC225aJrCYrX6dxQG/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation+of+Fully+Automatic+Rigid+Tube+Filli.docx",
        "url": "https://drive.google.com/file/d/1ktfZiN53iQZJ1wEwj6cNhMvAgFpv32gQ/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ZJW300 Full Automatic Cartridge Filling Line ---20260605.pdf",
        "url": "https://drive.google.com/file/d/1nUpKe4t-L0f85hAqRlWYpg2Jwg3ON11Z/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation Pharma of CLM300 Vitamin pectin gummy production line.pdf",
        "url": "https://drive.google.com/file/d/1if3yXO2jHfV40oE9N7YuQMYqgMYO_bvH/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "16 lane vision counting bottling line to Jose 20260522.pdf",
        "url": "https://drive.google.com/file/d/14E3DPmBQmTy2Z3nStAI0q4MsTsSadU4H/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Modified PI For SCL-600 Fast loading metal mold gummy production line. RYPM260428.doc",
        "url": "https://drive.google.com/file/d/17SIIzM6VNbkDCgMJZNQCNljdMXsEqTTX/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "PI For SCL-300Model Fast loading metal mold gummy production line. RYPM260428.doc",
        "url": "https://drive.google.com/file/d/1GyfW-pBf_WuoWUDENWg_jCMwj_l4TUpG/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "100Aþöƒõ║ºþ║┐Õ╣│ÚØóÕ©âÕ▒ÇÕø¥.pdf",
        "url": "https://drive.google.com/file/d/1r5ookS-PksE4ASA1m6tGs2iU5-TBl_4O/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "UBM",
        "machine_category": "GERAL",
        "title": "Apr1st-UBM150 Gum candy making machine.pdf",
        "url": "https://drive.google.com/file/d/1nagLw1fqOWLdPV7c54reTLfIGCwOWRLV/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor UBM."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Rich packing&#39;s quotation of 16 lane vision counting bottling line to Jose 20260522.pdf",
        "url": "https://drive.google.com/file/d/1Es-cuD7PzAY2o66zwWWDmMa5xAgqp_vn/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Tecfag Plastic Bag 6003VDB Q726051803.pdf",
        "url": "https://drive.google.com/file/d/1_ik_Zhvpa3I1-9Wpp3vmEvovPiin-giB/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Proforma invoice (Õ¢óÕ╝ÅÕÅæþÑ¿´╝ë (2).pdf",
        "url": "https://drive.google.com/file/d/13N3nBrvukmk9VM2OI2IOrOCAQsr_nZT_/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "tablet capsule paking line20260317.pdf",
        "url": "https://drive.google.com/file/d/17D8yNlZEEs-xCkV9m7qC21kYRWILQHLB/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Þ¢»þ│ûþ¢ÉÞúàµò┤õ¢ôÞºúÕå│µû╣µíê20260309 40-50 bottlemin.pdf",
        "url": "https://drive.google.com/file/d/1ORpDg-LKbGNAwXpzmOTXw2WM2boh3jKN/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "SED-T16SP Gummy Counting Machine.pdf",
        "url": "https://drive.google.com/file/d/1uaz7MN1-hywRMp9AdLjHJinqN0B4cNUF/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "SED-10DTC-H 10 Heads Weigher and bottle filling Line.pdf",
        "url": "https://drive.google.com/file/d/1HB-nmn8u5ZplnI4vGMOE-kkaHEvgibkz/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation for packaging line.pdf",
        "url": "https://drive.google.com/file/d/1IbJ_wToK4HzeIAP-peQGGIMIQ0MbP8kt/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "EGHF-01 Single nozzle hot filling machine  from Eugeng.pdf",
        "url": "https://drive.google.com/file/d/1QWdMNJgDvRxBNiaCvfxtsCHc0G8n6-os/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Þ¢»þ│ûþ¢ÉÞúàµò┤õ¢ôÞºúÕå│µû╣µíê20260227 88 Õ»╣ÕñûµèÑõ╗À-Þï▒µûç(1).pdf",
        "url": "https://drive.google.com/file/d/1p-bxixmp3AwfZa8aj7rL1fFw0iNTXdVN/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Õê®Õ║Àµ£║µó░þôÂÞúàþ║┐_1_18_translate_20260228135745.pdf",
        "url": "https://drive.google.com/file/d/1xIry0mLYltZwsycv7-lVd__xfyi8EsOM/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "1_Õê®Õ║Àµ£║µó░þôÂÞúàþ║┐_1_18_translate_20260228135745.pdf",
        "url": "https://drive.google.com/file/d/1Yaq0EQO4K4e9qpKOMvsA7-aA6N6yX1qh/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Gummy bottle line Quote.pdf",
        "url": "https://drive.google.com/file/d/1XTFMUZG4LuZK4-9DhWq5PXSWwuGY2no0/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Þ¢»þ│ûþ¢ÉÞúàµò┤õ¢ôÞºúÕå│µû╣µíê20260227 Õ»╣ÕñûµèÑõ╗À-Þï▒µûç.pdf",
        "url": "https://drive.google.com/file/d/1JxNUoGYvoHkoiEjL6CBSfEl9rjy3ZnUh/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "The Specifications of Fully Automatic Powder Cans Filling Seaming Packing Line (PSH-L)  300g 1000g.pdf",
        "url": "https://drive.google.com/file/d/1DOWyHN1gORD2pyawtYxJaRGtIRVelTbe/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Automatic Gummy Weighing Bottles Packing Line equipments list and quotation. 260227. tecfag.pdf",
        "url": "https://drive.google.com/file/d/1NqYCM_LvpJoAjETkAxHBKco1-KVHM2xd/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "YIFEI Cans Filling Capping Machine Quotation Doris µùïÞ¢¼Õ╝ÅµÄÑµûÖ25-35þôÂ.pdf",
        "url": "https://drive.google.com/file/d/1HYJoWyOZAit3ypKh-W_Dh9iAG2_Xc2AD/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "EGMF-01A Automatic nail polish filling machine from Shanghai Eugeng.pdf",
        "url": "https://drive.google.com/file/d/1ePXWFPnb1IFwlsQyXcyVI9U9B7d8wWUz/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation-Tecfag.pdf",
        "url": "https://drive.google.com/file/d/1q1g8Xtr-SxnY06pAlY2RZXfY-HinOLH9/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation - Disposable tableware packaging machine From Alice Yang 0226.pdf",
        "url": "https://drive.google.com/file/d/17zWojtn5xKzz5VAUdxeDYVaH93jvFG8y/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "CANDY",
        "machine_category": "GERAL",
        "title": "CLM300A Gummy candy production line.pdf",
        "url": "https://drive.google.com/file/d/1IOGqy0xdLnkmXXe03ytj7whoBGh4DG6L/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor CANDY."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Modified PI For SCL-300 600 Fast loading metal mold gummy.pdf",
        "url": "https://drive.google.com/file/d/1CptIJIrzNA14k_s5sgHLbjvHcexL3_Qt/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "PI For SCL-600 Fast loading metal mold gummy production line. RYPM260128.pdf",
        "url": "https://drive.google.com/file/d/1y0_xR8ekHXR4VH6W_1o9WbJyZQ2bo_sd/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "5g Gummy making production line project. quotation list. Date25.12.19.pdf",
        "url": "https://drive.google.com/file/d/1o_sSkls4xtwOiLXgiFiQltRqfeICchY9/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "HLGZJ-50  Fully Automatic Cream Filling, Pressing and Capping Machine-BRTC.docx",
        "url": "https://drive.google.com/file/d/1q8OmJutDT1oS3plOzl9WzEKxSCkYfEkr/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Granule Filling Machine (Four Scales)-BRTC.doc",
        "url": "https://drive.google.com/file/d/1sfocrNGeCiyUMyA-QdeJNdbHK1pS7vcX/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "´╝║´╝░´╝¬´╝ì´╝ö Intelligent Four-function Tablet Tester catalogue.pdf",
        "url": "https://drive.google.com/file/d/1gka9WkEgaSx9pU2hHf91xQjbU2tvFzx1/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "YD-35 Intelligent tablet hardness tester cataluge.pdf",
        "url": "https://drive.google.com/file/d/1IXgFLVppJyQIjmE7lafsB1JSsSfyvKS-/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "CANDY",
        "machine_category": "GERAL",
        "title": "Small lab type pectin and gelatin candy making machine catalouge and quotation list.pdf",
        "url": "https://drive.google.com/file/d/13m54bGUsonC15Hs1t36dixFjmdVolljq/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor CANDY."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "SCL-300 Automatic sugar making production line . new quotation list.231103 (1).docx",
        "url": "https://drive.google.com/file/d/1dlKJQTKxEUPUBc1L1HrunS2IshteDMIu/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "CANDY",
        "machine_category": "GERAL",
        "title": "SCL-300 Model Automatic jelly candy depositing production line.Quotation list.231017.doc",
        "url": "https://drive.google.com/file/d/1rPrpAOnX93EV8NLoEJaEIh1NJhQd2dLl/view",
        "notes": "Cotação comercial do fornecedor CANDY."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Powder filling line--HZPK--2022.12.9.xls",
        "url": "https://drive.google.com/file/d/111B1IOsSyhEzDbG65j9wuFqQ_5g-CaDc/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "(C)þ▓ëµ£½þöƒõ║ºþ║┐þñ║µäÅÕø¥2022.11.30.pdf",
        "url": "https://drive.google.com/file/d/1G0bxE01tWGiN506_vUNkZpc5wHgoCeRX/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "1130-Powder filling capping production line.docx",
        "url": "https://drive.google.com/file/d/1It4LSxKakYcMKOppPkjeYUdjrqAt2XTl/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "2022Nov-Powder filling capping production line1.docx",
        "url": "https://drive.google.com/file/d/1LvaSyO0o0Z0L0SpcbtvkMijVv_zkURvP/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "2022Sep-powder production line.docx",
        "url": "https://drive.google.com/file/d/1GS9WDRMxWbU_WKReBWTt0hpq9eh7rIXS/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Filling line--HZPK--2021.11.1.xls",
        "url": "https://drive.google.com/file/d/18W2Je6XnBAI4W4SOnpHf_jnF0CHW5t3Q/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "CANDY",
        "machine_category": "GERAL",
        "title": "SGDQ80 Automatic jelly candy making production line catalouge.new.pdf",
        "url": "https://drive.google.com/file/d/1-GGEqejFhwjTQi2EZPwCTY5UJZLQ-FwG/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor CANDY."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Filling line--HZPK--2020.9.26.xls",
        "url": "https://drive.google.com/file/d/1KtxBT3eILLYXvqc380Qa5-2fC3-obRtE/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "NF-80_120_Automatic tube filling and sealing machine with CE certificate.pdf",
        "url": "https://drive.google.com/file/d/1Eybg_mgz0k3AnNlTUEYVSZo-rfPjWkkR/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "SGDQ150 model gum line. Update quotation. 20922.doc",
        "url": "https://drive.google.com/file/d/1eYM0NsxRmEGHxFcu_c5Ws8dj_2tHtSX2/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "CANDY",
        "machine_category": "GERAL",
        "title": "SGDQ150´╝êone row) jelly candy depositing line (SERVO MOTOR DRIVE).doc",
        "url": "https://drive.google.com/file/d/1G7gv-Ygiqq094P-5v4BaYEoAe9cN4Y0R/view",
        "notes": "Catálogo técnico do fornecedor CANDY."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "NF60 model automatic tube filling and sealing machine.pdf",
        "url": "https://drive.google.com/file/d/1DkJS7qNEWgZJrtEQg8TYpI8LlUpiDFfD/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Ú½ÿÕÄï0.5-1-2-60Þ»┤µÿÄõ╣ª(1)(2).doc",
        "url": "https://drive.google.com/file/d/1gQ7ZVWE9nO6EiH5gp79DgSA0gERa6WoM/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Robot Information-Tecfag.docx",
        "url": "https://drive.google.com/file/d/1ICJJvYORzxpI_2Dg9-r-5BqzMNBtmH41/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Oil Spray machine - Jane Zhang -2026.05.21´╝êÞøïþ│òÕûÀµ▓╣µ£║´╝ëÚô¥µØí.pdf",
        "url": "https://drive.google.com/file/d/1DQcx00XyZmkp6Ai1oSvGL51C1vJkqj6q/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Cópia de Equipment quotation list for plastic bag stacking^J bundling and palletizing project - 20260620.xls",
        "url": "https://drive.google.com/file/d/171T-Lkt21BaOCdYz9D6d2FUZXosmDo0q/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "quotation for irregular lollipop from YY.pdf",
        "url": "https://drive.google.com/file/d/1YgRx5ARJqr3qlI5P3_nghHxQnTqsVeMY/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Offer-RE26052905U-250L Chocolate Melting Tank, Lobe Pump from Rayen.pdf",
        "url": "https://drive.google.com/file/d/1Njk91HKacFf2MbMmL8-6S29KC076xdKh/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Mixer + bomba de transferencia.docx",
        "url": "https://drive.google.com/file/d/1dvk5MQxJmhyR808pTsGV8wc4I8CSmHSB/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quote for SS304 250L Heated Tank and Pump and Filter.pdf",
        "url": "https://drive.google.com/file/d/13aQBFt4JudwKIMwSRFsA04i5lIXN3FBY/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "1.Henger Quotation Of Foam Cleaning station.pdf",
        "url": "https://drive.google.com/file/d/1hFIWsufuPq7shlFnBQohuHZiWl9MQtpB/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "VPD250 INOVANCE 20260527.pdf",
        "url": "https://drive.google.com/file/d/1sik7TSj4NnU2l700za7YPmo1GwRWr7-R/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "YINDA YDLH-500 Ribbon Mixer Quotation Sheet 20260506.pdf",
        "url": "https://drive.google.com/file/d/1mWuHPaQGJ99ObaIgnKgbWm7RcEADetzf/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "JH1810 Pizza line quotation-360.docx",
        "url": "https://drive.google.com/file/d/1nGnCPNEsun5-Rx9b8Oq8EmfpMp6QFt1e/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation Offer 1000liter Milk Homogenizer Tank-from Bidragon Machinery-Molly20260319.pdf",
        "url": "https://drive.google.com/file/d/1k1I7qAKYpQOBuyoWl2UbMKH4ETgP4rLu/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "500L Double Ribbon Blender.pdf",
        "url": "https://drive.google.com/file/d/13BPwVbnPtIuezXYy1FzVzR9AQcsMdpaA/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "300L Double Ribbon Blender Drawing.pdf",
        "url": "https://drive.google.com/file/d/1vadBWe-EaeC11EAoPX8hfoaeZnmQz3F5/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation of  Screw Conveyor and Single Shaft Paddle Blender1.pdf",
        "url": "https://drive.google.com/file/d/1hfb0DM0lG8zbAsrT-tnPmTriTS9l42Oe/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Single Shaft Paddle Blender (2).pdf",
        "url": "https://drive.google.com/file/d/1OJUajxtkB9UXbiS6pp6KXJP6VsW8naut/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "4. 40L Lab Mixer-update.pdf",
        "url": "https://drive.google.com/file/d/18OU0tZr3joP5Gek6yWH_61_VHzzv9lFF/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "2. Quotation of 40L Lab Ribbon Blender and 100L Standard Ribbon Blender.pdf",
        "url": "https://drive.google.com/file/d/1qRIq7MemFPqku6YQv_LjCOJ9P5ENqAUG/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Single Shaft Paddle Blender (1).pdf",
        "url": "https://drive.google.com/file/d/1ZFatWEF9eNsMSTS89BoL98LF639SviUQ/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "(Yupack)YPK-4025 fully automatic high speed carton erector.pdf",
        "url": "https://drive.google.com/file/d/1uexQJwyG_0BzxSo1zHTM-9QXt_Kxiatr/view?usp=sharing",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "the oil heating jacket and heater + detalhamento.docx",
        "url": "https://drive.google.com/file/d/1uOCU3c7dNDAzWX0dQsqeHL0DSI7in5mW/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "260207 MOSUN MSZDGS500 EXW QUOTATION-Gilson Jose Donato.pdf",
        "url": "https://drive.google.com/file/d/1pLoFFKxyJbcM08NToEJfP_-sDZ_8wqbt/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "MSZDGS500 Automatic Shoe Carton Box Making Machine.pdf",
        "url": "https://drive.google.com/file/d/1Cgs5sRzFvZhPvwf8Qp0aRLeuuUeDfIlG/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Cotation Chocolate sauce mixer.pdf",
        "url": "https://drive.google.com/file/d/1XNoqV0DCDFApfSWJQAoZNwE8lxIv6fBx/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "3000L Double Ribbon Blender.pdf",
        "url": "https://drive.google.com/file/d/1lXg8KDd-fn1JuP-760Qf_1fqKj-Oj4nP/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Tecfag Brazil 3000L Ribbon bender Proposal Quotation 20260115(2).pdf",
        "url": "https://drive.google.com/file/d/1rtW6uOjp9Jcea4Co3aGwtmrj3HdOx7Uo/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "YDLH3000 Ribbon blender Layout Drawing 20260115.pdf",
        "url": "https://drive.google.com/file/d/1CitcDe1huEkP7YF-mbB5QWdse-ye4ou1/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "1500L Ribbon bender Proposal Quotation 20260125.pdf",
        "url": "https://drive.google.com/file/d/1qlLL_acTgdNlXG9EtqV-uv6VNbW38dvB/view?usp=sharing",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Chinese stardard 1500L Ribbon bender Proposal Quotation 20260127.pdf",
        "url": "https://drive.google.com/file/d/1s9a3snjMPJ4LhTyo5GBEacoKXI_xjUXy/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Guangzhou Sipuxin Product Catalogue.pdf",
        "url": "https://drive.google.com/file/d/1NbOsK10eXAoLcnppN4GDcCKYogVZ9i7h/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Catalog-Sokos&Newpeak µû░Úø¬Õ│░þö╗Õåî.pdf",
        "url": "https://drive.google.com/file/d/11c0lhYOm5bTqWWFDA6a4mTubvJsKqgG7/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation-20260202-OPP labeling machine-SOKOS.pdf",
        "url": "https://drive.google.com/file/d/1AJLuAUBH8zAW3kkgoWuGE_qVuS0c3kAS/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Osmose Reversa TECFAG03T.docx",
        "url": "https://drive.google.com/file/d/1C9C7iihjm7mK4t2f8FfflhqiJ2nROExi/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "0.25Ten-GB.docx",
        "url": "https://drive.google.com/file/d/1Es_ZjDmo0neQttRjtb7RhwZrXLMTK4Sr/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Automatic cups packing machine line with custom services for BRTC.docx",
        "url": "https://drive.google.com/file/d/1SFXU-N7QKEhgFAfvTa7vJM1RUiyZdDOp/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "U02B2508-Quotation of ribbon mixers.docx",
        "url": "https://drive.google.com/file/d/1KtS8rUw58YkKxOToZcUpNzUujmHCGE_y/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation of HTFD900L-75..docx",
        "url": "https://drive.google.com/file/d/1__YHp1kJKUkZad_oAkLhwhh_mHsC5qzU/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "2024Õ╣┤µû░þëê(ÕÄ╗).pdf",
        "url": "https://drive.google.com/file/d/1jYnHO-dA2QjeQyo9O2ikGr2KqffdWDa-/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Pre├ºo.docx",
        "url": "https://drive.google.com/file/d/1r7pgSJEiQCfoy-0BAPe6tbSO5FbDEWWi/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "V mixer quotation.pdf",
        "url": "https://drive.google.com/file/d/1-jlzT-AJMcSq3iAcxOfx2hyoQoeWDpHl/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Mar20th-Quotation sheet.docx",
        "url": "https://drive.google.com/file/d/13HJEvs0Ecgal69jnRPksZTLPHD4K9mJs/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Pre├ºo Oral dissolving.docx",
        "url": "https://drive.google.com/file/d/1jC60Na4uj1S6d4GqokVxPzadXhFMeywt/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Oral Dissolving Film prodction line catalogue.pdf",
        "url": "https://drive.google.com/file/d/1-7PFwkFXyJX3eglHlo2uzNBqa5MSYUjq/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Pre├ºo YK.docx",
        "url": "https://drive.google.com/file/d/15WtEyp63wWkW5pv8vZv0fivXR4Dh9hKK/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Cotação.docx",
        "url": "https://drive.google.com/file/d/1wlrVPK-g3r_34vTX45ngJ5FvyXrWiwk_/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Small type sugar making machine catalogue.pdf",
        "url": "https://drive.google.com/file/d/1xssufeuCFtTmH-24hQqSrW8u7gth3hh7/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "WCSJ-10(20)(20B) Universal coarse crusher.pdf",
        "url": "https://drive.google.com/file/d/1D-qoBa6itYnXzLWI3_zHzZlAZGYvmCG9/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "YPT Non woven bed sheet cover machine catalouge.pdf",
        "url": "https://drive.google.com/file/d/1UpslxU7OVomhSFMwv8lAGpsFFwkhzRWT/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "V Series high efficiency mixer.pdf",
        "url": "https://drive.google.com/file/d/1_fiTB1j9yZKNmzpwMP_EN8PELfVVlIC3/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "YK Series oscillating Granulator.pdf",
        "url": "https://drive.google.com/file/d/1-VDu9BTt4WmpB2zZQ2fEXbQuVn3hxEju/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "GHL-10 High speed mixing granulator.pdf",
        "url": "https://drive.google.com/file/d/1SSsOdID6A_BYgxtsoVuQYGnwDzyXeAQ1/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "FLG300 closed type granuatlion line for tablet capsule machine.pdf",
        "url": "https://drive.google.com/file/d/191Ed2hWo8ji56OVSiaWcXJwTg3VpYnz2/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "SBH Series 3D Motion mixer.pdf",
        "url": "https://drive.google.com/file/d/1bjcMhO3pR3wXmsYxwAmAQhptXiTtAsgJ/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "ESCOPO DO PROJETO - SELADORA EM L COM ALIMENTA├ç├âO AUTOAMTICA 2X3.docx",
        "url": "https://drive.google.com/file/d/112RVFRawiBI_s_vJs3M-rZ7SKm0W0lez/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Informacao detalhada.docx",
        "url": "https://drive.google.com/file/d/1qj78005WLk9qLxRL59IbAX0xxHmIzzTp/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quote LY115060501 PRO-625.pdf",
        "url": "https://drive.google.com/file/d/19k-8XEPvN-qbYzn-4x5LWoU0M38pgp8w/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quote for  JL-250III servo softgel production line with smart dryer-260526.pdf",
        "url": "https://drive.google.com/file/d/1yVNhIh1OkYxik76put2BGre2lddqToUB/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "JL250III softgel production line layout-260526 dehumidifer tumbler dryer Model (1).pdf",
        "url": "https://drive.google.com/file/d/1MsJmvpJvRwGHqAUeZAARx2WaUJJSlWPe/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quote for  JL-250III servo softgel production line with smart dryer-251030.pdf",
        "url": "https://drive.google.com/file/d/1HYNNiiPsIAR79mO0wVmWaJLm-XIKrURM/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Lab Suppository Production Line ZL-1L(B)- 2026.05.20.pdf",
        "url": "https://drive.google.com/file/d/1qtt4RoAzHnyy9Pr6iFwE1b8TjlIMFvzq/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Automatc Round Jar Labeling Machine .doc",
        "url": "https://drive.google.com/file/d/1NjQNlx-afXHChggv-G9PdmiapWp2x2Re/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quotation-Syrup Filling Line & Cartoning machines-V0402.doc",
        "url": "https://drive.google.com/file/d/1REa9Um6px_S_54NRerLYa59cq7uj57kp/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Separador de disco.pdf",
        "url": "https://drive.google.com/file/d/1Qfhn8QjKDwKc065kpv1bsWMaUfr092O4/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Rotary type pre-made bag packaging machine µùïÞ¢¼Õ╝Åþ╗ÖÞóïµ£║.pdf",
        "url": "https://drive.google.com/file/d/1BLlBcNgX6zDNvhZwWx8I3UzcNp3axiqz/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Envasadora de agua 12000bottle per hour  USA.doc",
        "url": "https://drive.google.com/file/d/1BhLn2FFw6ebTL5Wy76Lbl6escb5_R_RO/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Tray for HVT.docx",
        "url": "https://drive.google.com/file/d/1ClyOkD9LfzLX2FgI_i4eSMvYZLe9nICK/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "SHIN",
        "machine_category": "GERAL",
        "title": "20250916-J1-304 Quotation of HVT-650A Automatic Tray Gas-flushing pack Machine Double Station-BRTC.docx",
        "url": "https://drive.google.com/file/d/1DLQx-NWF1xnLDqAKWGoEHhIDxGjRrpwq/view",
        "notes": "Cotação comercial do fornecedor SHIN."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Qutation list for suppository-25.08.05(1).docx",
        "url": "https://drive.google.com/file/d/1rzn5E7N4OFi3L7kEuIEUzYMHGk8-hOn4/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "0203-SJ3LS Automatic Suppository Line.docx",
        "url": "https://drive.google.com/file/d/1O7hgcuBpQPhvs_KBECZAuie7MIToWkPY/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Rotuladora de ampolas Y-500 Labeling machine proposal.doc",
        "url": "https://drive.google.com/file/d/1eyy3imrsegV6sqzJSIpDzIm3LJFyIROW/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Modelos de comprimidos.pdf",
        "url": "https://drive.google.com/file/d/1bNbl1wtFyhOgdC9Ihs4MDmbjSmnk0ZmO/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "HVT-450R Rotary type quotation and trays bandeja.docx",
        "url": "https://drive.google.com/file/d/1c1IjIq74OhguVbscRHj7POly7ucC2c3H/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "bandejas retas PE.doc",
        "url": "https://drive.google.com/file/d/1SFLTvzEmgeBdHwwaoPA8-YexyhFx2CfT/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "HVC-760FS Skin packaging vacuum sealer-e BANDEJAS.doc",
        "url": "https://drive.google.com/file/d/1jFL994ioOQZK1riNoATqxlnMFMkOXkG2/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "DPH-260H automatic high-speed blister packaging machine catalogue.pdf",
        "url": "https://drive.google.com/file/d/1z-uYao5bZu0CzGdy_KlXD6HmoiF_0ENY/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Softech 250III - Servo Motor.pdf",
        "url": "https://drive.google.com/file/d/1LqpG96XU8k8XnFZhC7ZH8wpefmOYmTSU/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quote for double deck intelligent tumble dryer 24 dryers-240506.pdf",
        "url": "https://drive.google.com/file/d/1DtG_6UgEpOVjeN2vA84AzxAPd5F0hLy_/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "JL150III softgel production line layout with dehumidifer tumbler dryer-240915 Model (1).pdf",
        "url": "https://drive.google.com/file/d/1TkcKgJWxidBLKGGFOvP_0J_Ad_qOvjY_/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quote for  JL-250III servo softgel production line-240404 Version 2 (003).pdf",
        "url": "https://drive.google.com/file/d/1OVgQvUJE3B0XAh_FwZrXk3Mojo0J9SAP/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quote for  JL-250III servo softgel production line-240628.pdf",
        "url": "https://drive.google.com/file/d/1FRv56DIaa19KrnAau5WM5mnQVJY1koOn/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "melting tank mixer electrical panel 2024.8.5 .pdf",
        "url": "https://drive.google.com/file/d/1Nya-RH6YNdyd2bB_So5d4Xa3ddaD2NOq/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "JL-150III  Softgel Production Line Quote  with smart tumbler dryer 24-2.doc",
        "url": "https://drive.google.com/file/d/1tB5Fa2gI-5TiMf0jlsrbY-n0vZl3V1KV/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quote for  JL-300III servo softgel production line-240625 Version 1.pdf",
        "url": "https://drive.google.com/file/d/1uJmq8EcyZ2gBxGSrBeNFzXdmtM1O0y56/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quote for  JL-300III servo softgel production line-2400903 Version 1(1).pdf",
        "url": "https://drive.google.com/file/d/1umUcYhJF7Y2fOL2gphRc4BcdUeR8UECj/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Softech - 250 Plus com Servo Motor + Sistema de Secagem Linear Duplo -_db0dc985-3ded-4db5-a3e7-9d9bc70c76f1.pdf",
        "url": "https://drive.google.com/file/d/1N8ZqF7yUC_oT0fS6EeTHYmuIfbmnPuwf/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "JL250III softgel production line layout-2400912 double deck dryer Model (1).pdf",
        "url": "https://drive.google.com/file/d/1R5-_GZ2f8awjQe5JA4v4R-orHd2lwjVE/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quote for  JL-250III servo softgel production line with online dryer-240912.pdf",
        "url": "https://drive.google.com/file/d/1x_OEJkv6l5UPOjRrfpYbUr1odHyimW76/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "JL150III softgel production line layout with double deck tumbler dryer-2409151 Model (1).pdf",
        "url": "https://drive.google.com/file/d/12vna5fiVaqcxeIFeVaD_a-d7QqkCLOF0/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "JL100II softgel production line layout with double deck tumbler dryer-240915 Model (1).pdf",
        "url": "https://drive.google.com/file/d/1RSKo1fuXMTpYy9kpj8p5WCLmXzyLy8aE/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "JLGZ-70 Intelligent Dehumidification Tumble Dryer .pdf",
        "url": "https://drive.google.com/file/d/1HZ4OLTApC86u3p_2TfO5aq8OSV3OM-ku/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "auxiliary equipment holder-240712.pdf",
        "url": "https://drive.google.com/file/d/16PnlSjxvrPsdtZDwEuanGw6hqZgxNTGm/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "schematic of 1000L gel melting system 1 (1).pdf",
        "url": "https://drive.google.com/file/d/1LZe2Cbw2C337lS-frKCHio3I2vvGh9s1/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quote┬áfor┬átable┬átop┬áRD┬ámachine-250312.doc",
        "url": "https://drive.google.com/file/d/1wnzuinUJb4Dvo7U3t4Ple5DzDtfcQ2Lv/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quote for  JL-250III servo softgel production line with smart dryer-250219.doc",
        "url": "https://drive.google.com/file/d/1P4C68RvW4zptnH2TcaiGF4gNdKzZPCfQ/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Quote for  JL-250III servo softgel production line drying trays-250219.doc",
        "url": "https://drive.google.com/file/d/19pwBhvGp7V4odQPdZV5lJjKEd4ozgftm/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "SW-320  Protein Powder Doypack Pouch Packing Machine.pdf",
        "url": "https://drive.google.com/file/d/1p9YSqRj_xuy0uPayLDcSCzrfHREra5SF/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Pre├ºo SOFTECH250.xlsx",
        "url": "https://drive.google.com/file/d/1jCGadjyRhWQT2xeyb9iimVKNab-qJoOO/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "0608-Quotation of Sleeve labeling machine.pdf",
        "url": "https://drive.google.com/file/d/10qL29STplXeb0_WoDCrC54UaXVRcLSy8/view?usp=sharing",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Confirmed quotation list of RG2-250C softgel encapsulation line. 230306.docx",
        "url": "https://drive.google.com/file/d/1R-Khiuvvdm1KQ3AdKsyEl0cVwnQCg-ge/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "F500-1 model Soap making production Line(capacity 300- 500KG per hour) catalogue.pdf",
        "url": "https://drive.google.com/file/d/1SusfQgeN84b188dgQgTjXVCwGunDmsVP/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Cotação em Reais100-300kg.doc",
        "url": "https://drive.google.com/file/d/1nmctqLe_U52m3KWYyr0Z8mmnLcXmiYU-/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "2023Jan-cotation(100-300kg of standard).doc",
        "url": "https://drive.google.com/file/d/1bQA74pLbUBIeijnmMMtKJ1oLsl0HNgeM/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Cotação em Reais500KG-600KG .doc",
        "url": "https://drive.google.com/file/d/1gTA03IwneIYVw2_MQlSeWFuvVxltzkiN/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "2023Jan-cotation(500-600kg of standard).doc",
        "url": "https://drive.google.com/file/d/1x6xIwBzP3q3T4ATiXkwmwkPEv9wBeHPf/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "SW-200 Whey Protein Powder Zipper Doypack Pouch Automatic Packing Machine.pdf",
        "url": "https://drive.google.com/file/d/1HMvDJ3PRfjt7vr_BF9Yq_k_GhHFJQuQm/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Pre├ºo 10-2022.docx",
        "url": "https://drive.google.com/file/d/1RKa-PD_jRFST9DJt9h_M0XVsl2zsVpTL/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Pre├ºo RG2-200C.docx",
        "url": "https://drive.google.com/file/d/1pGqtdJjCjd7Nt2j_SuvMuTcbjMqPFSLk/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "RG2-250C Soft Gelatin Encapsulation Production Line catalogue.pdf",
        "url": "https://drive.google.com/file/d/135mMi_g08koWaB-e3Qvl-yy-IkAAG9Lg/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "RG2-200C Soft Gelatin Encapsulation Production Line catalogue (1).pdf",
        "url": "https://drive.google.com/file/d/1NwfXByOisMLC4zKo0NWSjHOoG78IbBB7/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "2022May-Quotation of Powder packaging machine unit.docx",
        "url": "https://drive.google.com/file/d/1wP7WxHUkiOf8C40HEd0Lf_eBuJdOVywW/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "SP8-250B Rotary Packing Machine - Tecfag.pdf",
        "url": "https://drive.google.com/file/d/1qpLrCPLm387e0UJZntG4NrtYjmO7HjRE/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "SP8-250B Rotary Packing Machine - Tecfag.doc",
        "url": "https://drive.google.com/file/d/1ykc42tXD9s1SOKwAmkOfuYiZ1X3W4Bqs/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "GD8-250B Rotary Packing Machine.doc",
        "url": "https://drive.google.com/file/d/1Tiv4DQu5J_F70WLCUGOZ2AOeshmG2xwA/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "price RG2-250C.docx",
        "url": "https://drive.google.com/file/d/1BoA1fe0Src4Fe9uxuKpg6HxOGqUCA7sY/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "RG250 softgel encapsulation line. quotation list. 220225.docx",
        "url": "https://drive.google.com/file/d/1cAyIveLMKRE1xT1mn7Ytv6tDU0HO5CJr/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "RG0.8-110 COTA├ç├éO complete sofgel encapsulation line.docx",
        "url": "https://drive.google.com/file/d/1-it-2zUSkRDiD_vDj2gDBIltqxWBWdCo/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "SHL.1582ÕìºÕ╝ÅÞ┤┤µáçµ£║.PDF.pdf",
        "url": "https://drive.google.com/file/d/1nCdQs8QMHlhvM2iHzpbS7qv16-dcAyda/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Bottle packaging production line catalouge.pdf",
        "url": "https://drive.google.com/file/d/1QsxoB7h3ourZILikVKsx5dPeN1vm5xbB/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "DPP260H2 Automatic tablet capsule softgel blister packing machine.pdf",
        "url": "https://drive.google.com/file/d/1lzevToUJSC_p0KSpXan22vvbf5tucwGk/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "DPH260 blister machine and ZH-260 High Speed Automatic Continously Cartoning Machine catalogue.pdf",
        "url": "https://drive.google.com/file/d/1_25D-6Wpw8vDu4dE6MA1RwZK4ITAj1eF/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "RG0.8-110 COTA├ç├éO complete sofgel encapsulation line.pdf",
        "url": "https://drive.google.com/file/d/1Ad9Pk6lcZrhIIFjnk6kKMQKu3QQN1xBk/view?usp=sharing",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "RG0.8-110 completo processo de produ├º├úo.pdf",
        "url": "https://drive.google.com/file/d/1pfIVg2J0hqcVE89985ttxVIYMINdEsyx/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "RG0 8-110c Normal production type soft encapsulation.pdf",
        "url": "https://drive.google.com/file/d/1iw7CPlr23d7xyRaFMGjp2FPyyWObRexa/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "RG0 8-110C R&D type Soft gel encapsulation line.pdf",
        "url": "https://drive.google.com/file/d/16J377-SiNY91RH-Ir9WvFVy0OY0O6Wx-/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "DLZ-596 Model automatic.pdf",
        "url": "https://drive.google.com/file/d/1HUiD1yFkyEMgedfrz97MWMEkqiWL6Dhf/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "DLZ-596 Automatic stretch film food vacuum packing machine for peanuts.doc",
        "url": "https://drive.google.com/file/d/1zhwoULjSxjW6s_uFwvHJNSRabrZHe1hJ/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "DZL596 com sistema 2 balan├ºa cabe├ºas .mp4",
        "url": "https://drive.google.com/file/d/11CxreINbpan7-dl6CcjWE8ZB8IVoy4xp/view?usp=sharing",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Automatic disposable shoe cover making machine catalogue Tecfag.pdf",
        "url": "https://drive.google.com/file/d/1uqvTNThFnzM6SE6WtoLbr88lnkQBtzZi/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "Disposable head cover automatic cap making_machinecatalogue Tecfag.pdf",
        "url": "https://drive.google.com/file/d/1nRm9EmI4AKXwU5Mgwo0rjT3cmgicgIES/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "SHL-3520 Carton corner labeling machine catalogue n.doc",
        "url": "https://drive.google.com/file/d/1fmykyUYrE1SsH_wAeCzXEBreu3tZfdLg/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "CD-1680  and DZP600 paper card packing machine(1).pdf",
        "url": "https://drive.google.com/file/d/1iie2X_vhAK4LRcJ7sImk3fmA26267yam/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "DPP-120HÔûæ┬│├ÄÔûæÔòù┬ÀGMPÔòÜ┬ñ├ì├▒├ÄÔò®Ôö┤┬ñ.doc",
        "url": "https://drive.google.com/file/d/15Cf_LnEu7Zp_4tlWDXVXJUZoIM8MXYNR/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "QUOTATION- DPB-260H Flat-plate Automatic Blister Packing Machine 20190815.pdf",
        "url": "https://drive.google.com/file/d/1SRZCVkkF-KIblkext9i00Uq95Q043OFS/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "DPP80_140__250_ model blister packing machine.pdf",
        "url": "https://drive.google.com/file/d/1j-rRSz9Nel5C3azHRV0OOItpxU2BYnsp/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "DPP80L Automatic Blister Packing Machine for honey jam chocolate.pdf",
        "url": "https://drive.google.com/file/d/1S7a1uYyUXAIv1UdGegcvKADzTu74rSRq/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "quotation for DPM-SLM-B Automatic top side_labeling machine.pdf",
        "url": "https://drive.google.com/file/d/1-Mic5wJkzEPO0TJbCYu6pmg9ajxbbrZP/view?usp=drive_link",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "quotation of labelling machine20190111.xlsx",
        "url": "https://drive.google.com/file/d/1plabP8Xi3nysrXFrKcdDq7hpo-fOynsr/view",
        "notes": "Cotação comercial do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "DPT80 blister packing machine.pdf",
        "url": "https://drive.google.com/file/d/18nqJSZDCJxIXF3OuKsQeF4V-w-EIo9FM/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "DPB180 Automatic Blister Packing Machine. newÔÇØþÜäÕë»µ£¼.pdf",
        "url": "https://drive.google.com/file/d/1Mho4ByQD6k9NDpHNj1ADI_vMH5xurqyu/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "DPB-80 DQ,IQ,OQ,PQ1 (1).doc",
        "url": "https://drive.google.com/file/d/1QqVjA7VhHY3xQX1CWEOVmARgm95risYm/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "DPB140 Multifunctional Automatic Blister Packing Machine.pdf",
        "url": "https://drive.google.com/file/d/1vuZwi0IooxxdbllzFKE0SC2heJwjY_kc/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "DPB80 Small type blister packing machine.new.pdf",
        "url": "https://drive.google.com/file/d/1sKBBijICj0-sV-krwhUsmXjX4vQerURZ/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "DPB-420V 520V Fully Automatic Soft _Hard_ Plastic Vacuum Blister Packing....pdf",
        "url": "https://drive.google.com/file/d/1eXOPgngANrTq-j5yedDH4E8_mpfLFw50/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "DPB-420V 520V Fully Automatic Soft _Hard_ Plastic Vacuum Blister Packing Machine.pdf",
        "url": "https://drive.google.com/file/d/1uCXYIlAKK75fDx-vuMmtYi6WmQ3ahKTm/view?usp=drive_link",
        "notes": "Catálogo técnico do fornecedor GERAL."
    },
    {
        "supplier_name": "GERAL",
        "machine_category": "GERAL",
        "title": "DPB-420 Soft plastic Automatic Blister Packing Machine.doc",
        "url": "https://drive.google.com/file/d/1CS6J_vQ5gL-_HRpPteu-gKom2V8szuIe/view",
        "notes": "Catálogo técnico do fornecedor GERAL."
    }
];

    // 1. Primeiro passo: Cadastra rapidamente TODOS os metadados no banco se não existirem
    // Isso garante que apareçam no front-end na hora e evita timeouts de boot
    for (const item of seedData) {
        try {
            const existing = await dbGet('SELECT id FROM supplier_resources WHERE url = ?', [item.url]);
            if (!existing) {
                const sql = `INSERT INTO supplier_resources (
                    supplier_name, machine_category, title, url, notes, extracted_text, created_by, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
                await dbRun(sql, [
                    item.supplier_name,
                    item.machine_category,
                    item.title,
                    item.url,
                    item.notes,
                    'PENDING', // Sinaliza que precisa extrair o texto em segundo plano
                    'sistema',
                    new Date().toISOString()
                ]);
            }
        } catch (dbErr) {
            console.error(`[SEED] Erro ao salvar metadados de ${item.title}:`, dbErr.message);
        }
    }

    console.log('[SEED] Todos os metadados dos catálogos foram verificados/cadastrados.');

    // 2. Segundo passo: Processa a extração de texto em segundo plano, um por um, com delay
    // para evitar estouro de memória (Out Of Memory) no Render
    setTimeout(async () => {
        try {
            const pendingResources = await dbAll("SELECT id, title, url FROM supplier_resources WHERE extracted_text = 'PENDING'");
            if (pendingResources.length === 0) {
                console.log('[SEED] Nenhum catálogo com extração de texto pendente.');
                return;
            }

            console.log(`[SEED] Encontrados ${pendingResources.length} catálogos pendentes de extração de texto. Iniciando processamento sequencial...`);

            for (const resInfo of pendingResources) {
                console.log(`[SEED] Aguardando 15s antes de processar: ${resInfo.title}...`);
                await new Promise(resolve => setTimeout(resolve, 15000)); // Delay de 15 segundos para GC liberar memória

                // Marca como processando para evitar reprocessamento em caso de reinício rápido
                await dbRun("UPDATE supplier_resources SET extracted_text = 'PROCESSING' WHERE id = ?", [resInfo.id]);

                try {
                    console.log(`[SEED] Baixando e extraindo texto de: ${resInfo.title}...`);
                    const directUrl = convertDriveUrl(resInfo.url);
                    const fileBuffer = await downloadFile(directUrl);
                    
                    const pdfData = await pdfParse(fileBuffer);
                    const text = pdfData.text || '';
                    
                    await dbRun("UPDATE supplier_resources SET extracted_text = ? WHERE id = ?", [text, resInfo.id]);
                    console.log(`[SEED] Sucesso! Texto extraído (${text.length} carac.) para: ${resInfo.title}`);
                } catch (extractErr) {
                    console.warn(`[SEED] Falha ao extrair texto de ${resInfo.title}:`, extractErr.message);
                    // Salva status de falha para não tentar extrair novamente em loop
                    const errorMsg = `FAILED: ${extractErr.message}`;
                    await dbRun("UPDATE supplier_resources SET extracted_text = ? WHERE id = ?", [errorMsg, resInfo.id]);
                }
            }
            console.log('[SEED] Processamento de extração de texto de catálogos concluído.');
        } catch (err) {
            console.error('[SEED] Erro no loop de extração de texto:', err.message);
        }
    }, 10000); // Inicia 10 segundos após o boot do servidor
}

// POST /api/supplier-resources - Cadastra novo recurso com extração automática de texto (restrito a Admin/Engenharia)
app.post('/api/supplier-resources', authenticateToken, restrictToEngineeringAndAdmin, async (req, res) => {
    const { supplier_name, machine_category, title, url, notes } = req.body;
    if (!supplier_name || !machine_category || !title || !url) {
        return res.status(400).json({ error: 'Os campos Fornecedor, Categoria de Máquina, Título e Link do Drive são obrigatórios.' });
    }

    try {
        let extracted_text = '';
        
        // Tenta converter e fazer o download do PDF para extrair o texto
        const directDownloadUrl = convertDriveUrl(url);
        console.log(`[SUPPLIER API] Tentando extrair texto do link de download: ${directDownloadUrl}`);

        try {
            const fileBuffer = await downloadFile(directDownloadUrl);
            const pdfData = await pdfParse(fileBuffer);
            extracted_text = pdfData.text || '';
            console.log(`[SUPPLIER API] Sucesso! Texto extraído (${extracted_text.length} caracteres) do catálogo.`);
        } catch (parseErr) {
            console.warn(`[SUPPLIER API] Não foi possível extrair texto do PDF (o cadastro será feito apenas com metadados):`, parseErr.message);
            // Continua a execução para salvar pelo menos o link e as anotações
        }

        const sql = `INSERT INTO supplier_resources (
            supplier_name, machine_category, title, url, notes, extracted_text, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        
        const created_at = new Date().toISOString();
        const created_by = req.user.username;

        await dbRun(sql, [supplier_name, machine_category, title, url, notes, extracted_text, created_by, created_at]);
        res.status(201).json({ message: 'Recurso cadastrado com sucesso e texto indexado!' });
    } catch (err) {
        console.error('[SUPPLIER API] Erro ao cadastrar recurso:', err.message);
        res.status(500).json({ error: 'Erro ao cadastrar recurso na biblioteca técnica.' });
    }
});

// DELETE /api/supplier-resources/:id - Remove um recurso (restrito a Admin/Engenharia)
app.delete('/api/supplier-resources/:id', authenticateToken, restrictToEngineeringAndAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        await dbRun('DELETE FROM supplier_resources WHERE id = ?', [id]);
        res.json({ message: 'Recurso removido com sucesso!' });
    } catch (err) {
        console.error('[SUPPLIER API] Erro ao remover recurso:', err.message);
        res.status(500).json({ error: 'Erro ao remover recurso da biblioteca técnica.' });
    }
});

// GET /api/gemini-test - Rota de diagnóstico para listar os modelos disponíveis para a chave do Gemini
app.get('/api/gemini-test', async (req, res) => {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
        return res.status(500).json({ error: 'A chave GEMINI_API_KEY não está configurada.' });
    }

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`;
        https.get(url, (apiRes) => {
            let data = '';
            apiRes.on('data', (chunk) => data += chunk);
            apiRes.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    res.json(parsed);
                } catch (e) {
                    res.status(500).json({ error: 'Erro ao parsear resposta: ' + e.message, raw: data });
                }
            });
        }).on('error', (err) => {
            res.status(500).json({ error: 'Erro na requisição: ' + err.message });
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/supplier-resources/ai-search - Realiza busca semântica inteligente de catálogos com a API do Gemini
app.post('/api/supplier-resources/ai-search', authenticateToken, restrictToEngineeringAndAdmin, async (req, res) => {
    const { query } = req.body;
    if (!query || query.trim() === '') {
        return res.status(400).json({ error: 'Termo de busca não informado.' });
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
        return res.status(500).json({ error: 'A chave da API do Gemini não está configurada no servidor.' });
    }

    try {
        // Busca todos os catálogos que possuem texto extraído ou notas
        const resources = await dbAll('SELECT id, supplier_name, machine_category, title, url, notes, extracted_text FROM supplier_resources');
        
        if (resources.length === 0) {
            return res.json({ 
                answer: 'A biblioteca técnica está vazia no momento. Cadastre alguns catálogos ou cotações de fornecedores antes de realizar a pesquisa por IA.',
                references: [] 
            });
        }

        // --- PRÉ-FILTRO DE RELEVÂNCIA (RAG Ranker) ---
        // Tokeniza a busca do usuário em palavras-chave relevantes
        const searchWords = query.toLowerCase()
            .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Remove acentos
            .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "") // Remove pontuação
            .split(/\s+/)
            .filter(w => w.length > 2 && !['para', 'com', 'sem', 'uma', 'uns', 'dos', 'das', 'nas', 'nos', 'por', 'que', 'como', 'onde', 'qual', 'quais'].includes(w));

        // Pontua cada recurso de acordo com a proximidade e ocorrência das palavras-chave
        const scoredResources = resources.map(r => {
            let score = 0;
            const titleLower = (r.title || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            const supplierLower = (r.supplier_name || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            const notesLower = (r.notes || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            const textLower = (r.extracted_text || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

            for (const word of searchWords) {
                if (supplierLower.includes(word)) score += 20;
                if (titleLower.includes(word)) score += 15;
                if (notesLower.includes(word)) score += 8;
                
                // Conta ocorrências no texto extraído do catálogo (máximo 15 ocorrências para não inflar muito)
                let idx = textLower.indexOf(word);
                let occurrences = 0;
                while (idx !== -1 && occurrences < 15) {
                    occurrences++;
                    score += 3;
                    idx = textLower.indexOf(word, idx + word.length);
                }
            }

            return { resource: r, score };
        });

        // Filtra apenas recursos que tiveram alguma relevância e ordena pelo score descendente
        let filteredResources = scoredResources
            .filter(sr => sr.score > 0)
            .sort((a, b) => b.score - a.score)
            .map(sr => sr.resource);

        if (filteredResources.length === 0) {
            // Fallback: se nada pontuou (ex: busca muito genérica), pega os 15 mais recentes cadastrados
            filteredResources = resources.slice(-15);
        } else {
            // Limita aos top 15 recursos mais relevantes para caber no limite de tokens do Gemini Free Tier
            filteredResources = filteredResources.slice(0, 15);
        }

        // Prepara o contexto dos recursos filtrados para enviar ao Gemini
        const resourcesContext = filteredResources.map((r) => {
            let textContent = r.extracted_text || '';
            // Ignora status internos de processamento/erro para não poluir o contexto do Gemini
            if (['PENDING', 'PROCESSING'].includes(textContent) || textContent.startsWith('FAILED:')) {
                textContent = '';
            }
            const snippet = (textContent || r.notes || '').substring(0, 4000); // 4k caracteres por catálogo
            return `[ID: ${r.id}] Fornecedor: ${r.supplier_name} | Título: ${r.title} | Categoria: ${r.machine_category} | Notas: ${r.notes || 'Sem observações'} | Conteúdo do Catálogo:\n${snippet}\n---`;
        }).join('\n\n');

        // Prompt de instrução estruturado para o Gemini
        const systemInstruction = `Você é o Assistente Técnico Inteligente da Tecfag Engenharia. Sua tarefa é ajudar os engenheiros a encontrar fornecedores e catálogos adequados para atender demandas de projetos específicos dos clientes.
Abaixo você receberá uma lista de documentos cadastrados na nossa biblioteca e a pergunta/necessidade do engenheiro.

Analise as especificações técnicas descritas em cada catálogo e decida quais fornecedores/catálogos podem atender à demanda.

Responda em formato JSON válido contendo exatamente dois campos:
1. "answer" (string): Uma resposta clara e profissional em português, justificando tecnicamente sua escolha e citando qual fornecedor e máquina atende, e por quê.
2. "references" (array de números): Lista com os IDs inteiros dos catálogos sugeridos que realmente servem para a demanda.

Responda APENAS com o objeto JSON puramente, sem formatação markdown de código (como \`\`\`json ... \`\`\`).`;

        const requestBody = {
            contents: [
                {
                    parts: [
                        { text: `${systemInstruction}\n\nLISTA DE DOCUMENTOS DISPONÍVEIS NA BIBLIOTECA:\n${resourcesContext}\n\nPERGUNTA/NECESSIDADE DO ENGENHEIRO:\n"${query}"` }
                    ]
                }
            ],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        answer: {
                            type: "STRING",
                            description: "Uma resposta clara e profissional em português, justificando tecnicamente sua escolha e citando qual fornecedor e máquina atende, e por quê."
                        },
                        references: {
                            type: "ARRAY",
                            items: {
                                type: "INTEGER"
                            },
                            description: "Lista com os IDs inteiros dos catálogos sugeridos que realmente servem para a demanda."
                        }
                    },
                    required: ["answer", "references"]
                }
            }
        };

        // Realiza requisição direta para a API do Gemini Flash Latest (resolve automaticamente para a versão estável ativa)
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${geminiKey}`;
        
        const reqOpts = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const apiRequest = https.request(url, reqOpts, (apiRes) => {
            let data = '';
            apiRes.on('data', (chunk) => data += chunk);
            apiRes.on('end', () => {
                try {
                    const parsedResponse = JSON.parse(data);
                    if (parsedResponse.error) {
                        console.error('[GEMINI API ERROR]', parsedResponse.error);
                        return res.status(500).json({ error: `Erro na API do Gemini: ${parsedResponse.error.message}` });
                    }

                    const rawText = parsedResponse.candidates[0].content.parts[0].text;
                    
                    // Helper para limpar formatações de markdown que a IA possa ter retornado no JSON
                    let cleanText = rawText.trim();
                    if (cleanText.startsWith('```')) {
                        const lines = cleanText.split('\n');
                        if (lines[0].startsWith('```')) lines.shift();
                        if (lines[lines.length - 1].trim() === '```') lines.pop();
                        cleanText = lines.join('\n').trim();
                    }

                    const result = JSON.parse(cleanText);
                    
                    // Cruza as referências de ID retornadas com os recursos reais do banco para enviar detalhes completos ao frontend
                    const matchedRefs = resources.filter(r => (result.references || []).includes(r.id));
                    
                    res.json({
                        answer: result.answer,
                        references: matchedRefs.map(r => ({
                            id: r.id,
                            supplier_name: r.supplier_name,
                            title: r.title,
                            url: r.url,
                            machine_category: r.machine_category
                        }))
                    });
                } catch (parseErr) {
                    console.error('[GEMINI PARSE ERROR] Resposta bruta da API:', data);
                    res.status(500).json({ error: 'Falha ao processar a resposta analítica da inteligência artificial: ' + parseErr.message });
                }
            });
        });

        apiRequest.on('error', (apiErr) => {
            console.error('[GEMINI HTTP ERROR]', apiErr.message);
            res.status(500).json({ error: 'Erro de conexão com o servidor do Gemini.' });
        });

        apiRequest.write(JSON.stringify(requestBody));
        apiRequest.end();

    } catch (err) {
        console.error('[AI SEARCH API] Erro ao processar busca por IA:', err.message);
        res.status(500).json({ error: 'Erro interno ao processar busca com inteligência artificial.' });
    }
});

// POST /api/projects - Cria um novo projeto com receita_data
app.post('/api/projects', async (req, res) => {
    const { code, client, contact, pm, diagnostico, sku, tech, serial, route, fase, checklist, prazos, faseEntryDate, lastUpdate, machines, cnpj, contact_phone, contact_email, cnae_codigo, cnae_descricao, receita_data } = req.body;
    
    if (!code || !client || !sku || !pm || !cnpj) {
        return res.status(400).json({ error: 'Os campos Código, Cliente, CNPJ, SKU e Gerente (PM) são obrigatórios.' });
    }

    try {
        const exists = await dbGet('SELECT code FROM projects WHERE code = ?', [code]);
        if (exists) {
            return res.status(400).json({ error: 'Já existe um projeto cadastrado com o código ' + code });
        }

        const sql = `INSERT INTO projects (
            code, client, contact, pm, diagnostico, sku, tech, serial, route, fase, 
            checklist, prazos, faseEntryDate, lastUpdate, motivoPerda, machines,
            cnpj, contact_phone, contact_email, cnae_codigo, cnae_descricao, receita_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        await dbRun(sql, [
            code,
            client,
            contact || '',
            pm,
            diagnostico,
            sku,
            tech,
            serial || '-',
            route || '-',
            fase || 1,
            JSON.stringify(checklist || {}),
            JSON.stringify(prazos || {}),
            faseEntryDate || new Date().toISOString(),
            lastUpdate || new Date().toISOString(),
            null,
            JSON.stringify(machines || []),
            cnpj,
            contact_phone || '',
            contact_email || '',
            cnae_codigo || '',
            cnae_descricao || '',
            receita_data ? (typeof receita_data === 'string' ? receita_data : JSON.stringify(receita_data)) : '{}'
        ]);

        sendWebhookNotification('CREATE', { code, client, pm, sku });
        res.status(201).json({ success: true, message: 'Projeto inserido com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao cadastrar projeto: ' + err.message });
    }
});

// PUT /api/projects/:code - Atualiza dados do projeto
app.put('/api/projects/:code', async (req, res) => {
    const { serial, route, fase, checklist, prazos, lastUpdate, motivoPerda, tech, machines } = req.body;
    const { code } = req.params;

    try {
        const oldProject = await dbGet('SELECT * FROM projects WHERE code = ?', [code]);
        if (!oldProject) {
            return res.status(404).json({ error: 'Projeto não encontrado.' });
        }

        const oldFase = oldProject.fase;
        
        let sql = `UPDATE projects SET 
            serial = ?, 
            route = ?, 
            fase = ?, 
            checklist = ?, 
            prazos = ?, 
            lastUpdate = ?, 
            motivoPerda = ?,
            machines = ?`;
            
        const params = [
            serial !== undefined ? serial : oldProject.serial,
            route !== undefined ? route : oldProject.route,
            fase !== undefined ? fase : oldProject.fase,
            checklist ? JSON.stringify(checklist) : oldProject.checklist,
            prazos ? JSON.stringify(prazos) : oldProject.prazos,
            lastUpdate || new Date().toISOString(),
            motivoPerda !== undefined ? motivoPerda : oldProject.motivoPerda,
            machines ? JSON.stringify(machines) : oldProject.machines
        ];

        // Se o técnico foi enviado para atualização
        if (tech !== undefined) {
            sql += `, tech = ?`;
            params.push(tech);
        }

        sql += ` WHERE code = ?`;
        params.push(code);

        await dbRun(sql, params);

        // Obter projeto atualizado para mandar por e-mail se a fase mudou
        const updatedProject = await dbGet('SELECT * FROM projects WHERE code = ?', [code]);
        if (fase !== undefined && parseInt(fase) !== parseInt(oldFase)) {
            // Disparar e-mail de notificação de forma assíncrona (sem travar a resposta HTTP)
            sendPhaseChangeEmail(updatedProject, oldFase, fase);

            // Disparar webhook
            sendWebhookNotification('PHASE_CHANGE', {
                code,
                client: updatedProject.client,
                oldFase,
                newFase: fase,
                user: req.user ? req.user.username : 'Desconhecido'
            });
        }

        res.json({ success: true, message: 'Projeto atualizado com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao atualizar projeto: ' + err.message });
    }
});

// DELETE /api/projects/:code - Deleta permanentemente um projeto
app.delete('/api/projects/:code', async (req, res) => {
    const { code } = req.params;

    try {
        // Remover arquivos físicos dos anexos vinculados a este projeto
        const attachments = await dbAll('SELECT filePath FROM attachments WHERE projectCode = ?', [code]);
        attachments.forEach(att => {
            const fullPath = path.join(__dirname, att.filePath);
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
            }
        });

        // Deletar do banco (CASCATA remove os registros da tabela attachments também)
        await dbRun('DELETE FROM projects WHERE code = ?', [code]);
        await dbRun('DELETE FROM attachments WHERE projectCode = ?', [code]);
        sendWebhookNotification('DELETE', { code });
        res.json({ success: true, message: 'Projeto e anexos excluídos com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao excluir projeto: ' + err.message });
    }
});

// ==========================================
// ENDPOINTS DA API DE LOGS DE AUDITORIA
// ==========================================

// GET /api/logs - Retorna todos os logs ordenados pelo mais recente
app.get('/api/logs', async (req, res) => {
    try {
        const rows = await dbAll('SELECT * FROM logs ORDER BY id DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao listar logs: ' + err.message });
    }
});

// POST /api/logs - Adiciona um novo log de auditoria
app.post('/api/logs', async (req, res) => {
    const { timestamp, color, text } = req.body;
    if (!timestamp || !color || !text) {
        return res.status(400).json({ error: 'Os campos timestamp, color e text são obrigatórios.' });
    }

    try {
        await dbRun('INSERT INTO logs (timestamp, color, text) VALUES (?, ?, ?)', [
            timestamp, color, text
        ]);
        res.status(201).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao registrar log: ' + err.message });
    }
});

// DELETE /api/logs - Limpa todos os logs de auditoria
app.delete('/api/logs', async (req, res) => {
    try {
        await dbRun('DELETE FROM logs');
        res.json({ success: true, message: 'Histórico de logs limpo com sucesso.' });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao limpar logs: ' + err.message });
    }
});

// ==========================================
// ENDPOINTS DA API DE ANEXOS (FILE UPLOAD)
// ==========================================

// POST /api/attachments - Faz o upload de um arquivo vinculado a um projeto e etapa
app.post('/api/attachments', upload.single('file'), async (req, res) => {
    const { projectCode, phase } = req.body;
    const file = req.file;

    if (!projectCode || !phase || !file) {
        // Remover arquivo se os campos obrigatórios estiverem ausentes
        if (file) {
            fs.unlinkSync(file.path);
        }
        return res.status(400).json({ error: 'Os campos projectCode, phase e o arquivo são obrigatórios.' });
    }

    // Impedir upload para cotacao para quem não for admin/gerente
    if (phase === 'cotacao' && req.user.role !== 'ALL' && req.user.role !== 'GERENTE') {
        if (file) {
            fs.unlinkSync(file.path);
        }
        return res.status(403).json({ error: 'Acesso negado: Apenas o Administrador ou o Gerente de Projetos podem anexar arquivos nesta etapa.' });
    }

    try {
        // Obter caminho relativo para servir via HTTP
        const relativePath = 'uploads/' + file.filename;

        // Se já existe um anexo nessa etapa para esse projeto, deletar o antigo antes de inserir (exceto no diagnóstico que permite múltiplos)
        if (phase !== 'diagnostico') {
            const existing = await dbGet('SELECT * FROM attachments WHERE projectCode = ? AND phase = ?', [projectCode, phase]);
            if (existing) {
                const oldFullPath = path.join(__dirname, existing.filePath);
                if (fs.existsSync(oldFullPath)) {
                    fs.unlinkSync(oldFullPath);
                }
                await dbRun('DELETE FROM attachments WHERE id = ?', [existing.id]);
            }
        }

        await dbRun(`INSERT INTO attachments (
            projectCode, phase, fileName, fileType, filePath, dateAdded
        ) VALUES (?, ?, ?, ?, ?, ?)`, [
            projectCode,
            phase,
            file.originalname,
            file.mimetype,
            relativePath,
            new Date().toISOString()
        ]);

        const newRecord = await dbGet('SELECT * FROM attachments WHERE projectCode = ? AND phase = ?', [projectCode, phase]);
        
        // Formatar filePath como URL absoluta para download
        res.status(201).json({
            ...newRecord,
            fileData: '/' + newRecord.filePath // Mapeia para download direto via express
        });
    } catch (err) {
        if (file && fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
        }
        res.status(500).json({ error: 'Erro ao salvar anexo: ' + err.message });
    }
});

// GET /api/attachments/:projectCode - Retorna todos os anexos de um projeto
app.get('/api/attachments/:projectCode', async (req, res) => {
    try {
        let rows = await dbAll('SELECT * FROM attachments WHERE projectCode = ?', [req.params.projectCode]);
        
        // Filtrar arquivo 4 da fase 1 (Cotação) para quem não for admin/gerente/diretor
        if (req.user.role !== 'ALL' && req.user.role !== 'GERENTE' && req.user.role !== 'DIRETOR') {
            rows = rows.filter(r => r.phase !== 'cotacao');
        }

        const formatted = rows.map(r => ({
            ...r,
            fileData: '/' + r.filePath // URL do arquivo para link HTML ou visualização
        }));
        res.json(formatted);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao listar anexos: ' + err.message });
    }
});

// DELETE /api/attachments/:id - Exclui um anexo pelo ID
app.delete('/api/attachments/:id', async (req, res) => {
    try {
        const attachment = await dbGet('SELECT * FROM attachments WHERE id = ?', [req.params.id]);
        if (!attachment) {
            return res.status(404).json({ error: 'Anexo não encontrado.' });
        }

        // Impedir exclusão de cotação para quem não for admin/gerente
        if (attachment.phase === 'cotacao' && req.user.role !== 'ALL' && req.user.role !== 'GERENTE') {
            return res.status(403).json({ error: 'Acesso negado: Apenas o Administrador ou o Gerente de Projetos podem remover este anexo.' });
        }

        // Excluir arquivo físico
        const fullPath = path.join(__dirname, attachment.filePath);
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
        }

        // Excluir registro do banco de dados
        await dbRun('DELETE FROM attachments WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Anexo excluído com sucesso.' });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao excluir anexo: ' + err.message });
    }
});

// ===================================================
// SISTEMA DE SEGURANÇA E BACKUPS REDUNDANTES
// ===================================================

// Função para enviar o arquivo de banco de dados por e-mail (Backup Redundante)
async function sendDatabaseBackupEmail() {
    try {
        if (!fs.existsSync(dbPath)) {
            console.log('[BACKUP EMAIL] Arquivo de banco de dados não encontrado.');
            return false;
        }

        if (!process.env.SMTP_USER || !process.env.SMTP_HOST) {
            console.log('[BACKUP EMAIL] SMTP não configurado. Backup por e-mail ignorado.');
            return false;
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

        const dateStr = new Date().toLocaleDateString('pt-BR');
        const mailOptions = {
            from: `"Tecfag MRP Backup" <${process.env.SMTP_USER}>`,
            to: 'gilson@tecfag.com.br',
            subject: `💾 [BACKUP AUTOMÁTICO] Banco de Dados MRP II Tecfag - ${dateStr}`,
            text: `Olá Gilson,\n\nSegue em anexo a cópia de segurança (backup físico) do banco de dados do sistema Tecfag MRP II referente ao dia ${dateStr}.\n\nPara restaurar o sistema em caso de sinistro, basta substituir o arquivo "tecfag_mrp.db" no diretório persistente do servidor por esta versão.\n\nAtenciosamente,\nSistema Tecfag MRP II`,
            attachments: [
                {
                    filename: `tecfag_mrp_backup_${new Date().toISOString().split('T')[0]}.db`,
                    path: dbPath
                }
            ]
        };

        await transporter.sendMail(mailOptions);
        console.log(`[BACKUP EMAIL] Cópia de segurança enviada com sucesso para gilson@tecfag.com.br`);
        return true;
    } catch (err) {
        console.error('[BACKUP EMAIL] Erro ao enviar cópia de segurança por e-mail:', err.message);
        return false;
    }
}

// Agendamento diário de backup por e-mail (a cada 24 horas)
setInterval(() => {
    console.log('[AGENDADOR] Executando rotina de backup diário por e-mail...');
    sendDatabaseBackupEmail();
}, 24 * 60 * 60 * 1000);

// Executa um backup 15 segundos após a inicialização do servidor para validar o canal de backup
setTimeout(() => {
    console.log('[AGENDADOR] Executando backup inicial de inicialização...');
    sendDatabaseBackupEmail();
}, 15000);

// GET /api/admin/backup/download - Permite baixar o arquivo físico .db do banco de dados (Apenas ALL e DIRETOR)
app.get('/api/admin/backup/download', authenticateToken, (req, res) => {
    if (req.user.role !== 'ALL' && req.user.role !== 'DIRETOR') {
        return res.status(403).json({ error: 'Acesso negado. Apenas administradores podem baixar o banco de dados.' });
    }

    if (!fs.existsSync(dbPath)) {
        return res.status(404).json({ error: 'Arquivo do banco de dados não encontrado no servidor.' });
    }

    res.download(dbPath, 'tecfag_mrp.db', (err) => {
        if (err) {
            console.error('[BACKUP DOWNLOAD] Erro ao transferir arquivo:', err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Erro ao baixar o arquivo de banco de dados.' });
            }
        }
    });
});

// POST /api/admin/backup/send-email - Dispara manualmente o envio do backup por e-mail (Apenas ALL e DIRETOR)
app.post('/api/admin/backup/send-email', authenticateToken, async (req, res) => {
    if (req.user.role !== 'ALL' && req.user.role !== 'DIRETOR') {
        return res.status(403).json({ error: 'Acesso negado. Apenas administradores podem acionar backups.' });
    }

    const success = await sendDatabaseBackupEmail();
    if (success) {
        res.json({ success: true, message: 'Backup enviado com sucesso para o e-mail gilson@tecfag.com.br!' });
    } else {
        res.status(500).json({ error: 'Falha ao enviar backup. Verifique os logs do servidor ou as configurações de SMTP.' });
    }
});

// Inicialização do Servidor Express
app.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(`Servidor MRP II da Tecfag rodando em: http://localhost:${PORT}`);
    console.log(`Banco SQLite ativo em: ${dbPath}`);
    console.log(`Pasta de uploads de arquivos: ${UPLOADS_DIR}`);
    console.log(`===================================================`);

    // Inicia a importação e extração de texto dos catálogos em segundo plano
    seedSupplierResources().catch(err => {
        console.error('[SEED ERROR] Falha ao rodar importação de catálogos padrão:', err.message);
    });
});
