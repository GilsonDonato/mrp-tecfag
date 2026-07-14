const fs = require('fs');

function parseCSV(content) {
    const lines = content.split(/\r?\n/);
    const headers = lines[0].split(';');
    const result = [];
    
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        // Parse CSV fields supporting quotes
        let fields = [];
        let inQuotes = false;
        let currentField = '';
        
        for (let j = 0; j < line.length; j++) {
            const char = line[j];
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ';' && !inQuotes) {
                fields.push(currentField);
                currentField = '';
            } else {
                currentField += char;
            }
        }
        fields.push(currentField);
        
        if (fields.length < 5) continue;
        
        // Trim double quotes from values
        fields = fields.map(f => {
            let val = f.trim();
            if (val.startsWith('"') && val.endsWith('"')) {
                val = val.substring(1, val.length - 1);
            }
            return val.replace(/""/g, '"');
        });
        
        result.push({
            segmento: fields[0],
            subtipo: fields[1],
            campo: fields[2],
            tipo: fields[3],
            opcoes: fields[4],
            origem: fields[5],
            justificativa: fields[6] || ''
        });
    }
    return result;
}

const csv = fs.readFileSync('Requisitos_Engenharia_por_Segmento.csv', 'utf8');
const parsed = parseCSV(csv);

// Write to JSON
fs.writeFileSync('data/requisitos.json', JSON.stringify(parsed, null, 2), 'utf8');
console.log(`Sucesso: ${parsed.length} campos compilados em 'data/requisitos.json'`);
