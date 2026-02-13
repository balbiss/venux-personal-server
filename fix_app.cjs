
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'dashboard', 'src', 'App.jsx');

console.log(`Reading file from: ${filePath}`);

try {
    let content = fs.readFileSync(filePath, 'utf8');
    console.log(`File read successfully. Length: ${content.length}`);

    // Check for the bad pattern: </main > ... </div >
    // We'll search for the specific bad block string
    const badBlockStart = "    </div>\n  )\n}\n      </main >";

    if (content.includes(badBlockStart)) {
        console.log("Found bad block start.");

        // Find where it is
        const idx = content.indexOf(badBlockStart);

        // Find the next 'function NavItem'
        const navItemIdx = content.indexOf("function NavItem", idx);

        if (navItemIdx === -1) {
            console.error("Could not find function NavItem after bad block.");
            process.exit(1);
        }

        // Construct new content
        const before = content.substring(0, idx);
        const after = content.substring(navItemIdx);

        const fix = `
          </div>
        )}
      </main>
    </div>
  );
}

`;
        // We need to be careful. The bad block might extend further than badBlockStart.
        // The bad block ends before 'function NavItem'.

        const newContent = before + fix + after;

        fs.writeFileSync(filePath, newContent, 'utf8');
        console.log("Fixed App.jsx successfully!");

    } else {
        console.log("Bad patterns not found via exact string match.");
        // Debug: print what is there around line 886
        // Approximate location
        const lines = content.split('\n');
        if (lines.length > 890) {
            console.log("Lines 880-900:");
            console.log(lines.slice(880, 900).join('\n'));
        }
    }

} catch (e) {
    console.error("Error:", e);
    process.exit(1);
}
