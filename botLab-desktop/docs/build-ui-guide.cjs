// Regenerate UI_Guide_ru.pdf from ui-guide.html via Electron's printToPDF.
// Run from the app root: ./node_modules/.bin/electron docs/build-ui-guide.cjs
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 1200 });
  await win.loadFile(path.join(__dirname, "ui-guide.html"));
  await new Promise((r) => setTimeout(r, 1500)); // let images + fonts settle
  const pdf = await win.webContents.printToPDF({
    pageSize: "A4",
    printBackground: true,
    margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
  });
  const out = path.join(__dirname, "UI_Guide_ru.pdf");
  fs.writeFileSync(out, pdf);
  console.log("PDF written:", out, pdf.length, "bytes");
  app.quit();
});
app.on("window-all-closed", () => app.quit());
