const fs = require('fs');
const path = require('path');

// Caminho do CSV e do arquivo de destino
const csvPath = 'Requisitos_Engenharia_por_Segmento.csv';
const mdPath = path.join('C:\\Users\\gilso\\.gemini\\antigravity\\brain\\4ec1d7cd-76c8-49ac-9f13-b011eab42d81', 'segment_requirements_analysis.md');

try {
    // Ler o CSV tratando BOM (\uFEFF)
    let content = fs.readFileSync(csvPath, 'utf8');
    if (content.startsWith('\uFEFF')) {
        content = content.substring(1);
    }

    const lines = content.split('\n');
    const headers = lines[0].split(';');

    const fields = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Tratar aspas e quebras no split do CSV
        // Como o CSV usa ponto e vírgula, fazemos um parser simples
        let cells = [];
        let inQuotes = false;
        let currentCell = '';

        for (let charIndex = 0; charIndex < line.length; charIndex++) {
            const char = line[charIndex];
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ';' && !inQuotes) {
                cells.push(currentCell.trim());
                currentCell = '';
            } else {
                currentCell += char;
            }
        }
        cells.push(currentCell.trim());

        if (cells.length < 3) continue;

        fields.push({
            segmento: cells[0] || 'Geral',
            subtipo: cells[1] || '-',
            campo: cells[2] || '-',
            tipo: cells[3] || '-',
            opcoes: cells[4] || '-',
            origem: cells[5] || '-',
            justificativa: cells[6] || '-'
        });
    }

    // Agrupar por segmento
    const grouped = {};
    fields.forEach(f => {
        if (!grouped[f.segmento]) {
            grouped[f.segmento] = [];
        }
        grouped[f.segmento].push(f);
    });

    let md = `# Dossiê Técnico Oficial: 104 Requisitos de Engenharia por Segmento\n\n`;
    md += `Este documento foi gerado automaticamente a partir da planilha oficial de engenharia integrada ao MRP (**Requisitos_Engenharia_por_Segmento.csv**). Ele serve como referência oficial dos campos técnicos coletados no formulário dinâmico.\n\n`;
    md += `---\n\n`;

    for (const [segmento, items] of Object.entries(grouped)) {
        md += `## 📂 ${segmento}\n\n`;
        md += `| Sub-Tipo / Categoria | Campo Técnico | Tipo | Opções Sugeridas | Origem | Justificativa de Engenharia |\n`;
        md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;

        items.forEach(item => {
            // Escapar pipes (|) para não quebrar a tabela Markdown
            const subtipo = item.subtipo.replace(/\|/g, '\\|');
            const campo = item.campo.replace(/\|/g, '\\|');
            const tipo = item.tipo.replace(/\|/g, '\\|');
            const opcoes = item.opcoes.replace(/\|/g, '\\|');
            const origem = item.origem.replace(/\|/g, '\\|');
            const justificativa = item.justificativa.replace(/\|/g, '\\|');

            md += `| **${subtipo}** | ${campo} | *${tipo}* | ${opcoes !== '-' ? `\`${opcoes}\`` : '-'} | ${origem} | ${justificativa} |\n`;
        });

        md += `\n\n`;
    }

    fs.writeFileSync(mdPath, md, 'utf8');
    console.log(`Sucesso: Arquivo markdown gerado com sucesso em ${mdPath}`);
} catch (err) {
    console.error('Erro ao processar CSV:', err);
    process.exit(1);
}
