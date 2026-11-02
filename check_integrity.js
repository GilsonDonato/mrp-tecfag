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

    console.log('\n====================================================');
    console.log(`🎉 AUDITORIA CONCLUÍDA: ${passedTests}/${totalTests} TESTES APROVADOS (100%)`);
    console.log('✨ SISTEMA MRP TECFAG ESTABILIZADO E PRONTO PARA OPERAÇÃO!');
    console.log('====================================================\n');
}

main().catch(err => {
    console.error('\n🚨 FALHA CRÍTICA NA AUDITORIA DE INTEGRIDADE:', err);
    process.exit(1);
});
