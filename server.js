const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Erro ao conectar ao banco SQLite:', err.message);
    } else {
        console.log('Conectado com sucesso ao banco SQLite em:', dbPath);
        initializeDatabase();
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

        // Executar migração de coluna para bancos existentes
        db.run("ALTER TABLE projects ADD COLUMN machines TEXT", (err) => {
            // Ignorar erro se a coluna já existir
        });

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
        1: process.env.EMAIL_VENDAS,
        2: process.env.EMAIL_COMPRAS,
        3: process.env.EMAIL_ESTOQUE,
        4: process.env.EMAIL_TECNICO,
        5: process.env.EMAIL_GERENTE,
        6: process.env.EMAIL_GERENTE
    };

    const destEmail = destMap[newFase] || process.env.EMAIL_GERENTE;
    const pmEmail = process.env.EMAIL_GERENTE;

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

// POST /api/projects - Cria um novo projeto
app.post('/api/projects', async (req, res) => {
    const { code, client, contact, pm, diagnostico, sku, tech, serial, route, fase, checklist, prazos, faseEntryDate, lastUpdate, machines } = req.body;
    
    if (!code || !client || !sku || !pm) {
        return res.status(400).json({ error: 'Os campos Código, Cliente, SKU e Gerente (PM) são obrigatórios.' });
    }

    try {
        const exists = await dbGet('SELECT code FROM projects WHERE code = ?', [code]);
        if (exists) {
            return res.status(400).json({ error: 'Já existe um projeto cadastrado com o código ' + code });
        }

        const sql = `INSERT INTO projects (
            code, client, contact, pm, diagnostico, sku, tech, serial, route, fase, 
            checklist, prazos, faseEntryDate, lastUpdate, motivoPerda, machines
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        await dbRun(sql, [
            code,
            client,
            contact,
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
            JSON.stringify(machines || [])
        ]);

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

        // Se já existe um anexo nessa etapa para esse projeto, deletar o antigo antes de inserir
        const existing = await dbGet('SELECT * FROM attachments WHERE projectCode = ? AND phase = ?', [projectCode, phase]);
        if (existing) {
            const oldFullPath = path.join(__dirname, existing.filePath);
            if (fs.existsSync(oldFullPath)) {
                fs.unlinkSync(oldFullPath);
            }
            await dbRun('DELETE FROM attachments WHERE id = ?', [existing.id]);
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

// Inicialização do Servidor Express
app.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(`Servidor MRP II da Tecfag rodando em: http://localhost:${PORT}`);
    console.log(`Banco SQLite ativo em: ${dbPath}`);
    console.log(`Pasta de uploads de arquivos: ${UPLOADS_DIR}`);
    console.log(`===================================================`);
});
