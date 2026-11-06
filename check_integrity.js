/**
 * Script de Verificação Contínua de Integridade do MRP Tecfag
 * Valida de ponta a ponta as 4 etapas de estabilização antes de deploys ou commits.
 * 
 * Uso: node check_integrity.js ou npm test
 */

const assert = require('assert');
const fs = require('fs');
const { execSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

console.log('====================================================');
console.log('🔍 INICIANDO AUDITORIA DE INTEGRIDADE CONTÍNUA - MRP TECFAG');
console.log('====================================================\n');

let passedTests = 0;
let totalTests = 0;

function reportTest(name, fn) {
    totalTests++;
    try {
        fn();
        console.log(`  ✅ [PASS] ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
        throw err;
    }
}

async function reportTestAsync(name, fn) {
    totalTests++;
    try {
        await fn();
        console.log(`  ✅ [PASS] ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
        throw err;
    }
}

async function main() {
    // ----------------------------------------------------
    // 1. VERIFICAÇÃO DE SINTAXE E ARQUIVOS FUNDAMENTAIS
    // ----------------------------------------------------
    console.log('📦 1. Verificando Sintaxe e Integridade dos Arquivos-Fonte...');
    
    reportTest('Sintaxe estrita do server.js via V8 (node -c)', () => {
        execSync('node -c server.js', { stdio: 'pipe' });
    });

    const serverCode = fs.readFileSync('server.js', 'utf8');
    const indexCode = fs.readFileSync('index.html', 'utf8');

    reportTest('Integridade do HTML e existência do modal principal', () => {
        assert(indexCode.includes('id="project-detail-modal"'), 'Modal project-detail-modal deve existir');
        assert(indexCode.includes('id="btn-save-project-modal"'), 'Botão de salvar alterações deve existir');
        assert(indexCode.includes('function saveProjectModal'), 'saveProjectModal deve estar declarada');
        assert(indexCode.includes('function calculateProjectPhase'), 'calculateProjectPhase deve estar declarada');
        assert(indexCode.includes('function collectProjectImportItems'), 'collectProjectImportItems deve estar declarada');
    });

    // ----------------------------------------------------
    // 2. TESTE DO QUERY BUILDER DINÂMICO (ETAPA 1)
    // ----------------------------------------------------
    console.log('\n🛡️ 2. Testando Query Builder Dinâmico (Etapa 1)...');

    const bduMatch = serverCode.match(/function buildDynamicUpdate\(tableName, fields, whereClause, whereParams = \[\]\) \{([\s\S]*?)\n\}/);
    assert(bduMatch, 'buildDynamicUpdate deve estar definida em server.js');
    const buildDynamicUpdate = new Function('tableName', 'fields', 'whereClause', 'whereParams = []', bduMatch[1]);

    reportTest('Mapeamento 1-para-1 de parâmetros sem deslocamento SQL', () => {
        const fields = {
            serial: 'SN-100',
            fase: 3,
            delivery_invoice: 'NF-999',
            delivery_date: '2026-11-01'
        };
        const { sql, params } = buildDynamicUpdate('projects', fields, 'code = ?', ['PRJ001']);
        assert.strictEqual(sql, 'UPDATE `projects` SET `serial` = ?, `fase` = ?, `delivery_invoice` = ?, `delivery_date` = ? WHERE code = ?');
        assert.deepStrictEqual(params, ['SN-100', 3, 'NF-999', '2026-11-01', 'PRJ001']);
        assert.strictEqual(params[params.length - 1], 'PRJ001', 'O último parâmetro deve ser estritamente a chave do WHERE');
    });

    reportTest('Tratamento de erro quando fields está vazio', () => {
        assert.throws(() => {
            buildDynamicUpdate('projects', {}, 'code = ?', ['PRJ001']);
        }, /Nenhum campo fornecido/);
    });

    // ----------------------------------------------------
    // 3. TESTE DA MÁQUINA CANÔNICA DE ESTADOS (ETAPA 2)
    // ----------------------------------------------------
    console.log('\n⚙️ 3. Testando Máquina de Estados Canônica da Fase (Etapa 2)...');

    const phaseMatch = serverCode.match(/function computeCanonicalProjectPhase\(project\) \{([\s\S]*?)\n\}/);
    assert(phaseMatch, 'computeCanonicalProjectPhase deve estar definida em server.js');
    const computeCanonicalProjectPhase = new Function('project', phaseMatch[1]);

    reportTest('Projeto novo inicia na Fase 1 (Engenharia)', () => {
        assert.strictEqual(computeCanonicalProjectPhase(null), 1);
        assert.strictEqual(computeCanonicalProjectPhase({}), 1);
    });

    reportTest('Fase 1 completa avança para Fase 2 (Comercial)', () => {
        const p = {
            checklist: { diagnostico: true, customizacao: true, cotacao: true, fluxograma: true, planta_baixa: true }
        };
        assert.strictEqual(computeCanonicalProjectPhase(p), 2);
    });

    reportTest('Contrato assinado avança para Fase 3 (Proforma & Comex)', () => {
        const p = {
            checklist: {
                diagnostico: true, customizacao: true, cotacao: true, fluxograma: true, planta_baixa: true,
                aprovacao: true, contrato: true
            }
        };
        assert.strictEqual(computeCanonicalProjectPhase(p), 3);
    });

    reportTest('Contrato assinado em Pronta Entrega pula Comex e vai para Fase 6 (Oficina/SAT)', () => {
        const p = {
            equipment_origin: 'Pronta Entrega (Estoque Local)',
            checklist: { aprovacao: true, contrato: true }
        };
        assert.strictEqual(computeCanonicalProjectPhase(p), 6);
    });

    reportTest('Doca Tecfag posiciona o projeto na Fase 6', () => {
        const p = {
            import_stage: 'DOCA_TECFAG',
            checklist: { aprovacao: true, contrato: true }
        };
        assert.strictEqual(computeCanonicalProjectPhase(p), 6);
    });

    reportTest('SAT aprovado posiciona o projeto na Fase 7', () => {
        const p = { checklist: { sat: true } };
        assert.strictEqual(computeCanonicalProjectPhase(p), 7);
    });

    reportTest('Motivo de perda ou Fase 8 explícita fixa na Fase 8', () => {
        const p = { motivoPerda: 'Desistência do cliente' };
        assert.strictEqual(computeCanonicalProjectPhase(p), 8);
    });

    reportTest('Trava de Integridade: sem contrato assinado nem ordem formal, NUNCA ultrapassa Fase 2', () => {
        const p = {
            fase: 5,
            checklist: { diagnostico: true }
        };
        assert.strictEqual(computeCanonicalProjectPhase(p), 1);
    });

    // ----------------------------------------------------
    // 4. TESTE DE SINCRONIZAÇÃO ATÔMICA COMEX (ETAPA 3)
    // ----------------------------------------------------
    console.log('\n📦 4. Testando Sincronização Atômica Comex & Estoque (Etapa 3)...');

    const db = new sqlite3.Database(':memory:');
    const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function(err) { err ? reject(err) : resolve(this); });
    });
    const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
    const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });

    await reportTestAsync('Persistência e atualização atômica em stock_order_items', async () => {
        await dbRun(`CREATE TABLE stock_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            po_number TEXT,
            project_code TEXT,
            supplier_name TEXT,
            invoice_number TEXT,
            currency TEXT,
            total_fob_value REAL
        )`);

        await dbRun(`CREATE TABLE stock_order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            sku TEXT,
            description TEXT,
            ncm TEXT,
            qty_ordered REAL,
            qty_shipped REAL,
            unit_price_fob REAL,
            total_price_fob REAL,
            status TEXT,
            created_at TEXT
        )`);

        await dbRun(`CREATE TABLE stock_eadi_clearance_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_item_id INTEGER
        )`);

        const res = await dbRun(`INSERT INTO stock_orders (
            po_number, project_code, supplier_name, invoice_number, currency, total_fob_value
        ) VALUES ('PO-TEST-001', 'PRJ001', 'Fornecedor A', 'INV-100', 'USD', 5000)`);
        const orderId = res.lastID;

        const syncFuncMatch = serverCode.match(/async function syncStockOrderItems\(orderId, items, project\) \{([\s\S]*?)\n\}/);
        assert(syncFuncMatch, 'syncStockOrderItems deve estar definida em server.js');

        const syncStockOrderItems = new Function('dbGet', 'dbAll', 'dbRun', `
            return async function(orderId, items, project) {
                ${syncFuncMatch[1]}
            }
        `)(dbGet, dbAll, dbRun);

        const items = [
            { sku: 'SKU-01', description: 'Envasadora', ncm: '8422.30.10', qty_ordered: 2, unit_price_fob: 1500, total_price_fob: 3000 },
            { sku: 'SKU-02', description: 'Rotuladora', ncm: '8422.30.29', qty_ordered: 1, unit_price_fob: 2000, total_price_fob: 2000 }
        ];

        await syncStockOrderItems(orderId, items, { code: 'PRJ001', sku: 'SKU-01' });

        const inserted = await dbAll('SELECT * FROM stock_order_items WHERE order_id = ?', [orderId]);
        assert.strictEqual(inserted.length, 2, 'Devem existir 2 itens vinculados');
        assert.strictEqual(inserted[0].sku, 'SKU-01');
        assert.strictEqual(inserted[1].sku, 'SKU-02');
    });

    // ----------------------------------------------------
    // 5. TESTE DE DESATIVAÇÃO DO LEGADO COMERCIAL (ETAPA 4)
    // ----------------------------------------------------
    console.log('\n🧹 5. Testando Desativação de Código Morto e Legado Comercial (Etapa 4)...');

    reportTest('Rotinas de auto-cancelamento do funil estão permanentemente desativadas', () => {
        assert(!serverCode.includes('await runAutoPipelineHygiene()'), 'runAutoPipelineHygiene não deve ser executada nas rotas');
        assert(!serverCode.includes('setInterval(sendAutoHygieneWarningEmails'), 'sendAutoHygieneWarningEmails não deve ser agendada');
    });

    // ----------------------------------------------------
    // 6. TESTE DE EXCLUSÃO DE PROFORMA/COMMERCIAL INVOICE
    // ----------------------------------------------------
    console.log('\n🗑️ 6. Testando Exclusão e Desvinculação de Proforma/Commercial Invoice...');

    reportTest('Endpoint DELETE /api/projects/:code/invoice e UI de exclusão estão presentes', () => {
        assert(serverCode.includes("app.delete('/api/projects/:code/invoice'"), 'Endpoint DELETE /api/projects/:code/invoice deve existir em server.js');
        assert(indexCode.includes('function deleteProjectInvoice('), 'deleteProjectInvoice deve existir em index.html');
        assert(indexCode.includes('modal-project-btn-clear-invoice'), 'Botão modal-project-btn-clear-invoice deve existir em index.html');
        assert(indexCode.includes('btn-delete-attached-invoice'), 'Botão btn-delete-attached-invoice deve existir em index.html');
    });

    await reportTestAsync('Ciclo atômico de exclusão de invoice e recálculo de fase', async () => {
        await dbRun(`CREATE TABLE projects (
            code TEXT PRIMARY KEY,
            fase INTEGER,
            client TEXT,
            import_supplier TEXT,
            import_invoice_number TEXT,
            import_invoice_date TEXT,
            import_currency TEXT,
            import_total_fob_value REAL,
            import_items TEXT,
            import_stage TEXT,
            checklist TEXT,
            lastUpdate TEXT
        )`);

        await dbRun(`CREATE TABLE attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            projectCode TEXT,
            phase TEXT,
            fileName TEXT,
            fileType TEXT,
            filePath TEXT,
            dateAdded TEXT
        )`);

        const initChk = JSON.stringify({
            diagnostico: true, customizacao: true, cotacao: true, fluxograma: true, planta_baixa: true,
            aprovacao: true, contrato: false, proforma: true, proforma_user: 'Usuario Teste'
        });

        await dbRun(`INSERT INTO projects (
            code, fase, client, import_supplier, import_invoice_number, import_total_fob_value, import_currency, import_items, checklist
        ) VALUES (
            'PRJ-TEST-INV', 3, 'Cliente Teste', 'Fornecedor XYZ', 'PI-999', 15000, 'USD', '[{"sku":"MAQ-01"}]', ?
        )`, [initChk]);

        await dbRun(`INSERT INTO attachments (projectCode, phase, fileName, filePath) VALUES 
            ('PRJ-TEST-INV', 'proforma', 'Proforma_PI999.pdf', 'uploads/test.pdf')`);

        const orderRes = await dbRun(`INSERT INTO stock_orders (
            po_number, project_code, supplier_name, invoice_number, currency, total_fob_value
        ) VALUES ('PO-PRJ-TEST-INV', 'PRJ-TEST-INV', 'Fornecedor XYZ', 'PI-999', 'USD', 15000)`);
        const delOrderId = orderRes.lastID;

        await dbRun(`INSERT INTO stock_order_items (order_id, sku, qty_ordered) VALUES (?, 'MAQ-01', 1)`, [delOrderId]);

        // Simulação do endpoint de exclusão
        const project = await dbGet('SELECT * FROM projects WHERE code = ?', ['PRJ-TEST-INV']);
        assert(project, 'Projeto deve existir antes da exclusão');

        // 1. Remover attachments
        await dbRun(`DELETE FROM attachments WHERE projectCode = ? AND (phase = 'proforma' OR phase = 'invoice')`, ['PRJ-TEST-INV']);

        // 2. Resetar checklist
        let chk = JSON.parse(project.checklist);
        chk.proforma = false;
        delete chk.proforma_user;
        delete chk.proforma_date;
        chk.import_order_deleted = true;

        // 3. Resetar campos e recalcular fase
        const updatedFields = {
            import_supplier: null,
            import_invoice_number: null,
            import_invoice_date: null,
            import_total_fob_value: 0,
            import_currency: 'USD',
            import_items: '[]',
            checklist: JSON.stringify(chk)
        };

        const canonicalFase = computeCanonicalProjectPhase({
            ...project,
            ...updatedFields,
            checklist: chk,
            has_import_order: 0,
            import_order_id: null,
            import_po_number: null,
            import_stage: null
        });

        assert.strictEqual(canonicalFase, 2, 'Sem contrato concluído e sem proforma, o projeto deve retornar para Fase 2');

        const { sql, params } = buildDynamicUpdate('projects', { ...updatedFields, fase: canonicalFase }, 'code = ?', ['PRJ-TEST-INV']);
        await dbRun(sql, params);

        // 4. Limpar stock_orders sem desembaraço
        await dbRun('DELETE FROM stock_order_items WHERE order_id IN (SELECT id FROM stock_orders WHERE project_code = ?)', ['PRJ-TEST-INV']);
        await dbRun('DELETE FROM stock_orders WHERE project_code = ?', ['PRJ-TEST-INV']);

        // Validações pós-exclusão
        const pPost = await dbGet('SELECT * FROM projects WHERE code = ?', ['PRJ-TEST-INV']);
        assert.strictEqual(pPost.fase, 2, 'Fase deve ser 2');
        assert.strictEqual(pPost.import_invoice_number, null, 'Invoice number deve ser nulo');
        assert.strictEqual(pPost.import_supplier, null, 'Supplier deve ser nulo');

        const chkPost = JSON.parse(pPost.checklist);
        assert.strictEqual(chkPost.proforma, false, 'Checklist proforma deve ser falso');

        const attPost = await dbAll('SELECT * FROM attachments WHERE projectCode = ?', ['PRJ-TEST-INV']);
        assert.strictEqual(attPost.length, 0, 'Anexos de proforma devem ter sido removidos');

        const ordPost = await dbAll('SELECT * FROM stock_orders WHERE project_code = ?', ['PRJ-TEST-INV']);
        assert.strictEqual(ordPost.length, 0, 'Ordens de estoque devem ter sido removidas');
    });

    // ----------------------------------------------------
    // 7. TESTE DA CENTRAL DE PROPOSTA COMERCIAL & DANFE (FASE 2)
    // ----------------------------------------------------
    console.log('\n📄 7. Testando Leitura e Cruzamento de Proposta Comercial & DANFE...');

    reportTest('Validação dos endpoints e colunas de Proposta e DANFE no server.js', () => {
        assert(serverCode.includes('/api/projects/:code/extract-commercial-proposal'), 'Endpoint extract-commercial-proposal deve existir');
        assert(serverCode.includes('/api/projects/:code/extract-danfe'), 'Endpoint extract-danfe deve existir');
        assert(serverCode.includes('/api/projects/:code/align-commercial-fiscal'), 'Endpoint align-commercial-fiscal deve existir');
        assert(serverCode.includes('/api/projects/:code/commercial-document/:docType'), 'Endpoint commercial-document deve existir');
        assert(serverCode.includes('danfe_number'), 'Coluna danfe_number deve ser tratada no server');
        assert(serverCode.includes('commercial_proposal_data'), 'Coluna commercial_proposal_data deve ser tratada no server');
        assert(serverCode.includes('commercial_alignment_summary'), 'Coluna commercial_alignment_summary deve ser tratada no server');
    });

    reportTest('Validação da interface e funções de Proposta e DANFE no index.html', () => {
        assert(indexCode.includes('id="modal-project-proposal-dropzone"'), 'Dropzone de proposta deve existir');
        assert(indexCode.includes('id="modal-project-danfe-dropzone"'), 'Dropzone de DANFE deve existir');
        assert(indexCode.includes('id="btn-align-commercial-fiscal"'), 'Botão de cruzamento IA deve existir');
        assert(indexCode.includes('id="modal-commercial-alignment-panel"'), 'Painel de auditoria do cruzamento deve existir');
        assert(indexCode.includes('function extractProjectProposalWithAI'), 'extractProjectProposalWithAI deve estar declarada');
        assert(indexCode.includes('function extractProjectDanfeWithAI'), 'extractProjectDanfeWithAI deve estar declarada');
        assert(indexCode.includes('function runCommercialFiscalAlignment'), 'runCommercialFiscalAlignment deve estar declarada');
        assert(indexCode.includes('function applyAlignmentToEngineeringSpecs'), 'applyAlignmentToEngineeringSpecs deve estar declarada');
        assert(indexCode.includes('function deleteProjectCommercialDocument'), 'deleteProjectCommercialDocument deve estar declarada');
        assert(indexCode.includes('function checkProjectCommercialDocuments'), 'checkProjectCommercialDocuments deve estar declarada');
    });

    await reportTestAsync('Persistência e exclusão segura de Proposta Comercial e DANFE no banco', async () => {
        // Criar colunas na tabela em memória
        await dbRun(`ALTER TABLE projects ADD COLUMN danfe_number TEXT`).catch(() => {});
        await dbRun(`ALTER TABLE projects ADD COLUMN danfe_date TEXT`).catch(() => {});
        await dbRun(`ALTER TABLE projects ADD COLUMN danfe_value REAL`).catch(() => {});
        await dbRun(`ALTER TABLE projects ADD COLUMN danfe_access_key TEXT`).catch(() => {});
        await dbRun(`ALTER TABLE projects ADD COLUMN danfe_items TEXT`).catch(() => {});
        await dbRun(`ALTER TABLE projects ADD COLUMN commercial_proposal_data TEXT`).catch(() => {});
        await dbRun(`ALTER TABLE projects ADD COLUMN commercial_alignment_summary TEXT`).catch(() => {});

        // Inserir projeto de teste
        await dbRun(`
            INSERT OR REPLACE INTO projects (code, client, fase, checklist)
            VALUES (?, ?, ?, ?)
        `, ['PRJ-DOC-TEST', 'CLIENTE DOC TEST', 2, JSON.stringify({ customizacao: true, cotacao: true })]);

        // Simular salvamento de proposta e DANFE
        const propData = { machines: ['Rotuladora Sleeve Auto'], total_value: 120000, technical_requirements: { tensao: '220V Tri', frequencia: '60Hz' } };
        const danfeData = { number: '12345', date: '2026-11-05', total_value: 120000, access_key: '35261100000000000000000000000000000000000000', items: [{ item: 'Rotuladora Sleeve Auto', qty: 1 }] };
        const alignmentData = { status: '100% ALINHADO', summary: 'Proposta e DANFE conferem.', items_comparison: [{ machine: 'Rotuladora', match: true }] };

        const updateFields = {
            commercial_proposal_data: JSON.stringify(propData),
            danfe_number: danfeData.number,
            danfe_date: danfeData.date,
            danfe_value: danfeData.total_value,
            danfe_access_key: danfeData.access_key,
            danfe_items: JSON.stringify(danfeData.items),
            commercial_alignment_summary: JSON.stringify(alignmentData)
        };

        const { sql, params } = buildDynamicUpdate('projects', updateFields, 'code = ?', ['PRJ-DOC-TEST']);
        await dbRun(sql, params);

        const saved = await dbGet('SELECT * FROM projects WHERE code = ?', ['PRJ-DOC-TEST']);
        assert.strictEqual(saved.danfe_number, '12345', 'danfe_number deve ser 12345');
        assert.strictEqual(saved.danfe_value, 120000, 'danfe_value deve ser 120000');
        assert(saved.commercial_proposal_data.includes('Rotuladora Sleeve Auto'), 'commercial_proposal_data deve conter o item');
        assert(saved.commercial_alignment_summary.includes('100% ALINHADO'), 'commercial_alignment_summary deve conter status');

        // Simular exclusão de DANFE
        const clearDanfe = {
            danfe_number: null,
            danfe_date: null,
            danfe_value: null,
            danfe_access_key: null,
            danfe_items: null,
            commercial_alignment_summary: null
        };
        const { sql: sqlDel, params: paramsDel } = buildDynamicUpdate('projects', clearDanfe, 'code = ?', ['PRJ-DOC-TEST']);
        await dbRun(sqlDel, paramsDel);

        const cleared = await dbGet('SELECT * FROM projects WHERE code = ?', ['PRJ-DOC-TEST']);
        assert.strictEqual(cleared.danfe_number, null, 'danfe_number deve ser nulo após exclusão');
        assert.strictEqual(cleared.danfe_value, null, 'danfe_value deve ser nulo após exclusão');
        assert.strictEqual(cleared.commercial_alignment_summary, null, 'commercial_alignment_summary deve ser nulo após exclusão');
        assert(cleared.commercial_proposal_data.includes('Rotuladora Sleeve Auto'), 'commercial_proposal_data deve continuar intacto');
    });

    console.log('\n====================================================');
    console.log(`🎉 AUDITORIA CONCLUÍDA: ${passedTests}/${totalTests} TESTES APROVADOS (100%)`);
    console.log('✨ SISTEMA MRP TECFAG ESTABILIZADO E PRONTO PARA OPERAÇÃO!');
    console.log('====================================================\n');
}

main().catch(err => {
    console.error('\n🚨 FALHA CRÍTICA NA AUDITORIA DE INTEGRIDADE:', err);
    process.exit(1);
});
