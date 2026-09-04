const fs = require('fs');

const filePath = 'c:\\Users\\gilso\\.gemini\\antigravity\\scratch\\mrp-controle-automacao\\server.js';
let content = fs.readFileSync(filePath, 'utf8');

// Normalize line endings
const hasCrlf = content.includes('\r\n');
if (hasCrlf) {
    content = content.replace(/\r\n/g, '\n');
}

// 1. Add runAutoPipelineHygiene call to database connection success block
const targetDbConnect = "        initializeDatabase();\n        runDailyBackup();";
const replacementDbConnect = "        initializeDatabase();\n        runAutoPipelineHygiene();\n        runDailyBackup();";
content = content.replace(targetDbConnect, replacementDbConnect);

// 2. Define runAutoPipelineHygiene and inject before app.get('/api/projects')
const targetGetProjects = "// GET /api/projects - Lista todos os projetos\napp.get('/api/projects', authenticateToken, async (req, res) => {";

const runAutoPipelineHygieneFunction = `// Rotina de Auto-Higiene do Funil (Mover cards atrasados da Fase 1 para a Fase 6 após 20 dias)
async function runAutoPipelineHygiene() {
    try {
        const now = new Date();
        const projects = await dbAll("SELECT code, faseEntryDate, prazos, client FROM projects WHERE fase = 1");
        
        for (const p of projects) {
            let prazos = {};
            try {
                prazos = p.prazos ? JSON.parse(p.prazos) : {};
            } catch(e) {}
            
            const limitDays = (prazos && prazos.fase1 !== undefined) ? parseInt(prazos.fase1) : 7;
            const entryDate = new Date(p.faseEntryDate);
            const deadlineDate = new Date(entryDate.getTime() + limitDays * 24 * 60 * 60 * 1000);
            
            // Auto cancelamento ocorre após 20 dias de atraso pós-prazo
            const gracePeriodMs = 20 * 24 * 60 * 60 * 1000;
            const cancelDateThreshold = new Date(deadlineDate.getTime() + gracePeriodMs);
            
            if (now >= cancelDateThreshold) {
                console.log(\`[AUTO-HIGIENE] Cancelando projeto \${p.code} por inatividade superior a 20 dias de atraso na Fase 1.\`);
                
                const motivo = "Cancelamento Automático por Inatividade (> 20 dias de atraso na Fase 1)";
                const updateQuery = \`
                    UPDATE projects SET 
                        fase = 6, 
                        motivoPerda = ?, 
                        lastUpdate = ?, 
                        validation_status = 'HOMOLOGADA'
                    WHERE code = ?
                \`;
                await dbRun(updateQuery, [motivo, now.toISOString(), p.code]);
                
                // Gravar histórico de fase
                await dbRun(
                    'INSERT INTO project_phase_history (projectCode, fase, entryDate) VALUES (?, ?, ?)',
                    [p.code, 6, now.toISOString()]
                );
                
                // Gravar log de auditoria
                const logText = \`<strong>[AUTO-HIGIENE]</strong> Projeto <code>\${p.code}</code> de <strong>\${p.client}</strong> foi cancelado automaticamente por inatividade superior a 20 dias de atraso na Fase 1.\`;
                await dbRun(
                    'INSERT INTO logs (timestamp, user, text, projectCode) VALUES (?, ?, ?, ?)',
                    [now.toISOString(), 'Sistema (Auto-Higiene)', logText, p.code]
                );
            }
        }
    } catch (err) {
        console.error("[AUTO-HIGIENE ERROR] Falha ao rodar rotina de auto-higiene:", err.message);
    }
}

// GET /api/projects - Lista todos os projetos
app.get('/api/projects', authenticateToken, async (req, res) => {
    try {
        await runAutoPipelineHygiene();`;

content = content.replace(targetGetProjects, runAutoPipelineHygieneFunction);

// Restore line endings
if (hasCrlf) {
    content = content.replace(/\n/g, '\r\n');
}

fs.writeFileSync(filePath, content, 'utf8');
console.log('Success: server.js updated with runAutoPipelineHygiene routine and endpoints integration!');
