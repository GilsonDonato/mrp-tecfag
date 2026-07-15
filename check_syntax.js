const fs = require('fs');
const vm = require('vm');

try {
    const html = fs.readFileSync('index.html', 'utf8');
    // Extract script blocks
    const scriptRegex = /<script>([\s\S]*?)<\/script>/gi;
    let match;
    let blockCount = 0;
    while ((match = scriptRegex.exec(html)) !== null) {
        blockCount++;
        const code = match[1];
        console.log(`Checking script block ${blockCount} (${code.length} bytes)...`);
        try {
            new vm.Script(code);
            console.log(`Script block ${blockCount} is syntactically valid.`);
        } catch (e) {
            console.error(`Syntax error in block ${blockCount}:`, e.message);
            // Print surrounding lines of the error
            const lines = code.split('\n');
            const errorLine = e.stack.split('\n')[0].match(/:(\d+)/);
            if (errorLine) {
                const lineNum = parseInt(errorLine[1]) - 1;
                console.error(`Error around line ${lineNum + 1}:`);
                for (let i = Math.max(0, lineNum - 5); i <= Math.min(lines.length - 1, lineNum + 5); i++) {
                    console.error(`${i + 1}: ${lines[i]}`);
                }
            } else {
                console.error(e.stack);
            }
            process.exit(1);
        }
    }
    console.log("All script blocks are syntactically valid.");
} catch (err) {
    console.error("Failed to read index.html:", err);
    process.exit(1);
}
