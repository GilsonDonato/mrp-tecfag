const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const xlsPath = path.resolve(__dirname, '..', 'clientes.xls');
const csvPath = path.resolve(__dirname, '..', 'data', 'erp_clients.csv');

console.log('Lendo XLS:', xlsPath);
const workbook = XLSX.readFile(xlsPath);
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];
const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

console.log(`${rows.length} linhas lidas.`);

const headers = rows[0];
const colIndices = {
    codigo: headers.indexOf('Código'),
    razao: headers.indexOf('Razão'),
    cnpj: headers.indexOf('CNPJ'),
    telefone: headers.indexOf('Telefone'),
    email: headers.indexOf('E-mail'),
    segmento: headers.indexOf('Segmento'),
    data_cadastro: headers.indexOf('Dt. Cadastro'),
    dt_bloqueio: headers.indexOf('Dt. Bloqueio'),
    tipo_bloqueio: headers.indexOf('Tipo Bloqueio')
};

const outputRows = [];
// Cabeçalho simplificado
outputRows.push(['codigo', 'razao', 'cnpj', 'telefone', 'email', 'segmento', 'data_cadastro', 'dt_bloqueio', 'tipo_bloqueio'].join(';'));

for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const cnpj = (row[colIndices.cnpj] || '').toString().trim().replace(/[\r\n]+/g, '');
    if (!cnpj) continue;

    const codigo = (row[colIndices.codigo] || '').toString().trim().replace(/;/g, ' ').replace(/[\r\n]+/g, '');
    const razao = (row[colIndices.razao] || '').toString().trim().replace(/^\t+/, '').replace(/;/g, ' ').replace(/[\r\n]+/g, '');
    const telefone = (row[colIndices.telefone] || '').toString().trim().replace(/;/g, ' ').replace(/[\r\n]+/g, '');
    const email = (row[colIndices.email] || '').toString().trim().replace(/;/g, ' ').replace(/[\r\n]+/g, '');
    const segmento = (row[colIndices.segmento] || '').toString().trim().replace(/;/g, ' ').replace(/[\r\n]+/g, '');
    const data_cadastro = (row[colIndices.data_cadastro] || '').toString().trim().replace(/;/g, ' ').replace(/[\r\n]+/g, '');
    const dt_bloqueio = (row[colIndices.dt_bloqueio] || '').toString().trim().replace(/;/g, ' ').replace(/[\r\n]+/g, '');
    const tipo_bloqueio = (row[colIndices.tipo_bloqueio] || '').toString().trim().replace(/;/g, ' ').replace(/[\r\n]+/g, '');

    outputRows.push([
        codigo,
        razao,
        cnpj,
        telefone,
        email,
        segmento,
        data_cadastro,
        dt_bloqueio,
        tipo_bloqueio
    ].join(';'));
}

fs.writeFileSync(csvPath, outputRows.join('\n'), 'utf8');
console.log(`CSV salvo em ${csvPath}. Linhas exportadas: ${outputRows.length - 1}`);
