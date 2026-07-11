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
                            <a href="http://localhost:${PORT}" style="background-color: #0ea5e9; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 0.9rem; display: inline-block; box-shadow: 0 4px 6px rgba(14, 165, 233, 0.2);">Acessar Dashboard MRP</a>
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

            const data = [];
            res.on('data', (chunk) => data.push(chunk));
            res.on('end', () => resolve(Buffer.concat(data)));
        }).on('error', (err) => reject(err));
    });
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

        // Prepara o contexto dos recursos para enviar ao Gemini
        // Trunca o texto extraído para não estourar o limite de tokens da API do Gemini em chamadas simples
        const resourcesContext = resources.map((r, index) => {
            const snippet = (r.extracted_text || r.notes || '').substring(0, 4000); // 4k caracteres por catálogo
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
                responseMimeType: "application/json"
            }
        };

        // Realiza requisição direta para a API do Gemini 2.5 Flash
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
        
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
                    const result = JSON.parse(rawText.trim());
                    
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
                    res.status(500).json({ error: 'Falha ao processar a resposta analítica da inteligência artificial.' });
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
});
