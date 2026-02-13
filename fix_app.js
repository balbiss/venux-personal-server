
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'dashboard', 'src', 'App.jsx');
let content = fs.readFileSync(filePath, 'utf8');

// The bad block pattern we saw
// We look for </main > with a space, which is very unique
const badPattern = /<\/main >[\s\S]*?<\/div >[\s\S]*?\);[\s\S]*?}/;

if (badPattern.test(content)) {
    console.log("Found bad pattern. Fixing...");

    // We want to replace the mess at the end of the App component
    // The mess usually starts after </Modal>
    // Let's find </Modal> and the end of the App component (before NavItem)

    const parts = content.split('function NavItem');
    if (parts.length < 2) {
        console.error("Could not find NavItem split.");
        process.exit(1);
    }

    let appPart = parts[0];
    const rest = parts.slice(1).join('function NavItem');

    // Replace the end of appPart
    // We look for the last </Modal>
    const lastModalIdx = appPart.lastIndexOf('</Modal>');
    if (lastModalIdx === -1) {
        console.error("Could not find </Modal>.");
        process.exit(1);
    }

    // Keep everything up to </Modal> + length
    // Then append the correct closing
    const goodPart = appPart.substring(0, lastModalIdx + 8); // 8 is length of </Modal>

    const fix = `
          </div>
        )}
      </main>
    </div>
  );
}

`;

    const newContent = goodPart + fix + 'function NavItem' + rest;
    fs.writeFileSync(filePath, newContent, 'utf8');
    console.log("Fixed App.jsx");

} else {
    console.log("Bad pattern not found via regex.");
    // Manual fallback search string
    if (content.indexOf("</main >") !== -1) {
        console.log("Found </main > string. Attempting replace.");
        content = content.replace("</main >", "</main>");
        content = content.replace("</div >", "</div>");
        // This is a naive fix, might not fix the structure

        // Let's try to match the specific block
        const specificBad = `    </div>
  )
}
      </main >
    </div >
  );
}`;
        // Try to find it ignoring whitespace?
        // No, let's just stick to the specific fix which is robust.
        // If regex failed, maybe I should print why.
    }
}
